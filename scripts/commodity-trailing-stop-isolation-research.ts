// 商品核心组合“仅移动止损”消融：止损槽位留现金、全额再分配与1.5倍槽位上限。
// 研究脚本只读PostgreSQL，不进入统一引擎或任务。
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import type pg from "pg";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import { calculateIndicators } from "../server/indicators/formulas.js";
import { copperInventoryTargetExposure, inventoryInversePercentile } from "../server/modules/market/copper-inventory-signal.js";

const INITIAL = 100_000_000, LOT = 100, COMMISSION = 2.5, MIN_FEE = 500, TAX = 10, PARTICIPATION = 0.02;
const args = process.argv.slice(2);
const argOf = (flag: string): string | undefined => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const SLIPPAGE = Math.max(0, Number(argOf("--slippage-bps") ?? 10));
const INVENTORY_DELAY = Math.max(0, Math.min(20, Number(argOf("--inventory-delay-days") ?? 0)));
const COOLDOWN_DAYS = Math.max(1, Math.min(60, Number(argOf("--cooldown-days") ?? 10)));
const OUT_DIR = path.resolve("支撑/tmp/商品移动止损隔离研究"); fs.mkdirSync(OUT_DIR, { recursive: true });

interface Config { key: string; label: string; commodity: string; codes: readonly string[]; series: string; start: string; frontEnd: string; backStart: string; end: string; band: number; priceMode: "forward" | "raw" }
interface RawBar { code: string; date: string; open: number; high: number; low: number; close: number; volume: number }
interface Point extends RawBar { ma20: number | null; atr14: number | null }
interface Profile { code: string; effectiveFrom: string; effectiveTo: string | null; publishedDate: string }
interface Inventory { publishedDate: string; value: number }
interface CommodityState { date: string; exposure: number; changed: boolean }
type Mode = "baseline" | "cash" | "redistribute" | "capped";
interface Scenario { key: string; name: string; mode: Mode }
interface Position { code: string; quantity: number; entry: number; peak: number; stop: number | null; lastClose: number; realized: number }
interface Result { key: string; name: string; start: string; end: string; total_return: number; annual_return: number; max_drawdown: number; annual_volatility: number; sharpe: number|null; calmar: number|null; exposure: number; fees_yuan: number; turnover_yuan: number; order_count: number; stop_count: number; reentry_count: number; average_active_slots: number }

const CONFIGS: Config[] = [
  { key: "copper", label: "铜", commodity: "CU", codes: ["000630.SZ","000878.SZ","600362.SH","601168.SH","603993.SH"], series: "shfe.cu.inventory.total", start: "2016-09-12", frontEnd: "2022-12-30", backStart: "2023-01-03", end: "2026-09-11", band: 0.20, priceMode: "forward" },
  { key: "lithium", label: "碳酸锂", commodity: "LITHIUM_CARBONATE", codes: ["002192.SZ","002240.SZ","002460.SZ","002466.SZ","603399.SH"], series: "gfex.lc.warehouse_receipt.total", start: "2024-01-02", frontEnd: "2024-12-31", backStart: "2025-01-02", end: "2026-09-11", band: 0.10, priceMode: "raw" },
];
const SCENARIOS: Scenario[] = [
  { key: "B", name: "B_商品连续仓位", mode: "baseline" },
  { key: "M1", name: "M1_仅移动止损_槽位留现金", mode: "cash" },
  { key: "M2", name: "M2_仅移动止损_全额再分配", mode: "redistribute" },
  { key: "M3", name: "M3_仅移动止损_1.5倍槽位上限", mode: "capped" },
];
const round=(v:number,d=4)=>Number(v.toFixed(d));
function fee(g:number,side:"buy"|"sell"){return Math.max(MIN_FEE,Math.round(g*COMMISSION/10000))+(side==="sell"?Math.round(g*TAX/10000):0)}
function fill(p:number,side:"buy"|"sell"){return Math.round(p*100*(1+(side==="buy"?1:-1)*SLIPPAGE/10000))}
function mean(v:number[]){return v.reduce((a,b)=>a+b,0)/v.length}
function atr(rows:RawBar[],i:number){if(i<14)return null;const values:number[]=[];for(let j=i-13;j<=i;j++){const r=rows[j]!,p=rows[j-1]!;values.push(Math.max(r.high-r.low,Math.abs(r.high-p.close),Math.abs(r.low-p.close)))}return mean(values)}
function nextDate(dates:string[],date:string,delay=0){let l=0,r=dates.length;while(l<r){const m=(l+r)>>1;if(dates[m]!<=date)l=m+1;else r=m}return dates[l+delay]??null}
async function load(pool:pg.Pool,c:Config){
 const profiles=(await pool.query<Profile>(`SELECT i.code,p.effective_from::text "effectiveFrom",p.effective_to::text "effectiveTo",(p.published_at AT TIME ZONE 'Asia/Shanghai')::date::text "publishedDate" FROM company_commodity_profile p JOIN market_instrument i ON i.id=p.instrument_id WHERE p.commodity_code=$1 AND i.code=ANY($2::text[]) ORDER BY i.code`,[c.commodity,c.codes])).rows;
 const codes=[...new Set(profiles.map(p=>p.code))];if(codes.length!==5)throw new Error(`${c.label}核心标的应为5只，当前${codes.length}`);
 const open=c.priceMode==="raw"?"COALESCE(b.open_raw,b.open)":"b.open",high=c.priceMode==="raw"?"COALESCE(b.high_raw,b.high)":"b.high",low=c.priceMode==="raw"?"COALESCE(b.low_raw,b.low)":"b.low",close=c.priceMode==="raw"?"COALESCE(b.close_raw,b.close)":"b.close";
 const bars=(await pool.query<RawBar>(`SELECT i.code,b.bar_date::text date,${open}::float8 open,${high}::float8 high,${low}::float8 low,${close}::float8 close,b.volume::float8 FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id WHERE i.code=ANY($1::text[]) AND b.freq='day' AND b.bar_date BETWEEN ($2::date-interval '120 day') AND $3 AND ${open}>0 AND ${high}>0 AND ${low}>0 AND ${close}>0 AND b.volume>0 ORDER BY i.code,b.bar_date`,[codes,c.start,c.end])).rows;
 const dates=(await pool.query<{date:string}>(`SELECT trade_date::text date FROM market_trading_day WHERE is_open=true AND trade_date BETWEEN $1 AND $2 ORDER BY trade_date`,[c.start,c.end])).rows.map(r=>r.date);
 const inventory=(await pool.query<Inventory>(`SELECT (o.published_at AT TIME ZONE 'Asia/Shanghai')::date::text "publishedDate",o.value::float8 FROM market_factor_observation o JOIN market_factor_series s ON s.id=o.series_id WHERE s.series_code=$1 AND o.published_at<($2::date+interval '1 day') ORDER BY o.published_at,o.period_end`,[c.series,c.end])).rows;
 const raw=new Map<string,RawBar[]>(codes.map(code=>[code,[]]));for(const b of bars)raw.get(b.code)!.push(b);
 const pointByDate=new Map<string,Map<string,Point>>();for(const[code,rows]of raw){const ind=calculateIndicators(rows.map(r=>r.close));rows.forEach((r,i)=>{const p:Point={...r,ma20:ind[i]!.ma20,atr14:atr(rows,i)};if(!pointByDate.has(r.date))pointByDate.set(r.date,new Map());pointByDate.get(r.date)!.set(code,p)})}
 return{profiles,codes,dates,inventory,pointByDate};
}
function active(profiles:Profile[],date:string){return profiles.filter(p=>p.publishedDate<=date&&p.effectiveFrom<=date&&(!p.effectiveTo||p.effectiveTo>date)).map(p=>p.code).sort()}
function states(input:Awaited<ReturnType<typeof load>>,c:Config){const changes:number[]=[],out:CommodityState[]=[];let applied=-1;for(let i=4;i<input.inventory.length;i++){const row=input.inventory[i]!,prior=input.inventory[i-4]!;if(prior.value<=0)continue;const change=row.value/prior.value-1,score=inventoryInversePercentile(change,changes);changes.push(change);if(row.publishedDate<c.start)continue;const date=nextDate(input.dates,row.publishedDate,INVENTORY_DELAY);if(!date)continue;const raw=copperInventoryTargetExposure(score),changed=applied<0||Math.abs(raw-applied)>=c.band;if(changed)applied=raw;out.push({date,exposure:applied,changed})}return out}
class Portfolio{
 cash=INITIAL;positions=new Map<string,Position>();blocked=new Map<string,number>();pendingStops=new Set<string>();targetExposure=.5;initialized=false;allocationKey="";peak=INITIAL;previous=INITIAL;maxDd=0;fees=0;turnover=0;orders=0;stops=0;reentries=0;days=0;exposureSum=0;activeSlotsSum=0;returns:number[]=[];
 constructor(readonly scenario:Scenario){}
 capacity(p:Point){return Math.floor(p.volume*PARTICIPATION/LOT)*LOT}
 sell(code:string,p:Position,point:Point){const q=Math.floor(Math.min(p.quantity,this.capacity(point))/LOT)*LOT;if(q<LOT)return;const price=fill(point.open,"sell"),gross=q*price,cost=fee(gross,"sell");this.cash+=gross-cost;this.fees+=cost;this.turnover+=gross;this.orders++;p.quantity-=q;p.realized+=gross-cost-p.entry*q;if(!p.quantity)this.positions.delete(code)}
 buy(code:string,point:Point,budget:number,isReentry:boolean){const price=fill(point.open,"buy");let q=Math.min(Math.floor(budget/price/LOT)*LOT,this.capacity(point));while(q>=LOT&&q*price+fee(q*price,"buy")>this.cash)q-=LOT;if(q<LOT)return;const gross=q*price,cost=fee(gross,"buy");this.cash-=gross+cost;this.fees+=cost;this.turnover+=gross;this.orders++;if(isReentry)this.reentries++;const existing=this.positions.get(code);if(existing){const old=existing.entry*existing.quantity;existing.quantity+=q;existing.entry=Math.round((old+price*q)/existing.quantity);existing.lastClose=point.close}else this.positions.set(code,{code,quantity:q,entry:price,peak:point.close,stop:null,lastClose:point.close,realized:-cost})}
 open(index:number,date:string,points:Map<string,Point>,profiles:Profile[],state:CommodityState|null,previous:Map<string,Point>){if(state)this.targetExposure=state.exposure;for(const code of [...this.pendingStops]){const p=this.positions.get(code),point=points.get(code);if(p&&point){this.sell(code,p,point);this.blocked.set(code,index+COOLDOWN_DAYS);this.stops++}this.pendingStops.delete(code)}for(const[code,until]of[...this.blocked]){const prev=previous.get(code);if(index>=until&&prev?.ma20!==null&&prev?.ma20!==undefined&&prev.close>prev.ma20)this.blocked.delete(code)}const act=active(profiles,date),available=act.filter(code=>!this.blocked.has(code)),key=available.join(","),universeChanged=key!==this.allocationKey,allocationChanged=!this.initialized||universeChanged||state?.changed===true;this.allocationKey=key;this.initialized=true;let equity=this.cash;for(const[code,p]of this.positions)equity+=p.quantity*Math.round((points.get(code)?.open??p.lastClose)*100);const baseSlot=equity*this.targetExposure/5;let slot=baseSlot;if(this.scenario.mode==="redistribute"&&available.length)slot=equity*this.targetExposure/available.length;if(this.scenario.mode==="capped"&&available.length)slot=Math.min(equity*this.targetExposure/available.length,baseSlot*1.5);if(allocationChanged){for(const[code,p]of[...this.positions]){const point=points.get(code);if(!point)continue;const desired=available.includes(code)?Math.floor(slot/fill(point.open,"sell")/LOT)*LOT:0;if(p.quantity>desired)this.sell(code,p,point)}for(const code of available){const point=points.get(code);if(!point)continue;const p=this.positions.get(code),current=p?p.quantity*point.open*100:0;if(current<slot*.8)this.buy(code,point,slot-current,this.blocked.has(code)===false&&index>0&&!p)}}}
 close(points:Map<string,Point>){let mv=0;for(const[code,p]of this.positions){const point=points.get(code);if(!point){mv+=p.quantity*Math.round(p.lastClose*100);continue}p.lastClose=point.close;p.peak=Math.max(p.peak,point.close);mv+=p.quantity*Math.round(point.close*100);if(this.scenario.mode!=="baseline"&&point.atr14!==null&&p.peak/(p.entry/100)-1>=.10){const trail=p.peak-Math.max(p.peak*.08,point.atr14*3);p.stop=Math.max(p.stop??-Infinity,trail);if(point.close<=p.stop)this.pendingStops.add(code)}}const equity=this.cash+mv;this.peak=Math.max(this.peak,equity);this.maxDd=Math.max(this.maxDd,1-equity/this.peak);this.returns.push(equity/this.previous-1);this.previous=equity;this.exposureSum+=equity?mv/equity:0;this.activeSlotsSum+=this.positions.size;this.days++}
 finish(start:string,end:string):Result{const total=this.previous/INITIAL-1,annual=Math.pow(1+total,252/Math.max(1,this.days))-1,m=mean(this.returns),variance=this.returns.reduce((s,v)=>s+(v-m)**2,0)/Math.max(1,this.returns.length-1),vol=Math.sqrt(variance*252);return{key:this.scenario.key,name:this.scenario.name,start,end,total_return:round(total),annual_return:round(annual),max_drawdown:round(this.maxDd),annual_volatility:round(vol),sharpe:vol?round(annual/vol):null,calmar:this.maxDd?round(annual/this.maxDd):null,exposure:round(this.exposureSum/Math.max(1,this.days)),fees_yuan:round(this.fees/100,2),turnover_yuan:round(this.turnover/100,2),order_count:this.orders,stop_count:this.stops,reentry_count:this.reentries,average_active_slots:round(this.activeSlotsSum/Math.max(1,this.days),2)}}
}
interface Result{key:string;name:string;start:string;end:string;total_return:number;annual_return:number;max_drawdown:number;annual_volatility:number;sharpe:number|null;calmar:number|null;exposure:number;fees_yuan:number;turnover_yuan:number;order_count:number;stop_count:number;reentry_count:number;average_active_slots:number}
function run(input:Awaited<ReturnType<typeof load>>,stateRows:CommodityState[],start:string,end:string){const ps=SCENARIOS.map(s=>new Portfolio(s)),byDate=new Map(stateRows.map(s=>[s.date,s]));let previous=new Map<string,Point>();const dates=input.dates.filter(d=>d>=start&&d<=end);dates.forEach((date,index)=>{const points=input.pointByDate.get(date)??new Map(),state=byDate.get(date)??null;for(const p of ps)p.open(index,date,points,input.profiles,state,previous);for(const p of ps)p.close(points);previous=points});return ps.map(p=>p.finish(start,end))}
const pool=getPool(loadConfig().databaseUrl);try{const output:any={generated_at:new Date().toISOString(),assumptions:{slippage_bps:SLIPPAGE,inventory_delay_days:INVENTORY_DELAY,cooldown_days:COOLDOWN_DAYS,trailing:"峰值盈利10%后，峰值-max(8%,3ATR)",reentry:"冷却期结束且前收盘高于MA20"},commodities:{}};for(const c of CONFIGS){const input=await load(pool,c),stateRows=states(input,c),windows={front:[c.start,c.frontEnd],back:[c.backStart,c.end],full:[c.start,c.end]} as const;const results=Object.fromEntries(Object.entries(windows).map(([k,[start,end]])=>[k,run(input,stateRows,start,end)]));output.commodities[c.key]={config:c,results};console.log(`\n## ${c.label}`);for(const[k,rows]of Object.entries(results))console.log(k,rows)}const suffix=SLIPPAGE!==10||INVENTORY_DELAY?`-压力-${SLIPPAGE}bp-${INVENTORY_DELAY}日延迟`:"";const file=path.join(OUT_DIR,`结果${suffix}-2026-09-16.json`);fs.writeFileSync(file,JSON.stringify(output,null,2));console.log(`\n结果：${file}`)}finally{await closePool()}
