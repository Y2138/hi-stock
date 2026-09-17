// 碳酸锂最小尝试：广期所仓单连续仓位覆盖；只读PostgreSQL。
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import type pg from "pg";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import { copperInventoryTargetExposure, inventoryInversePercentile } from "../server/modules/market/copper-inventory-signal.js";

const START="2024-01-02", END="2026-09-11", SPLIT="2025-01-02";
const LITHIUM_RESEARCH_CODES=["002192.SZ","002240.SZ","002460.SZ","002466.SZ","603399.SH"] as const;
const INITIAL=100_000_000,LOT=100,COMMISSION=2.5,MIN_FEE=500,TAX=10,SLIP=10,PARTICIPATION=.02;
const outDir=path.resolve("支撑/tmp/碳酸锂仓单最小回测");fs.mkdirSync(outDir,{recursive:true});
interface Bar{date:string;code:string;open:number;close:number;volume:number;meanVolume20:number|null}
interface Obs{date:string;publishedDate:string;value:number}
interface Profile{code:string;effectiveFrom:string;effectiveTo:string|null;publishedDate:string}
interface Signal{executionDate:string;score:number;change4w:number;codes:string[]}
interface Scenario{key:string;name:string;band:number;exposure(signal:Signal):number}
interface Position{quantity:number;lastClose:number}
const round=(v:number,d=4)=>Number(v.toFixed(d));
function fee(g:number,side:"buy"|"sell"){return Math.max(MIN_FEE,Math.round(g*COMMISSION/10000))+(side==="sell"?Math.round(g*TAX/10000):0)}
function nextDate(dates:string[],date:string){return dates.find(value=>value>date)??null}
async function load(pool:pg.Pool){
 const profiles=(await pool.query<Profile>(`SELECT i.code,p.effective_from::text "effectiveFrom",p.effective_to::text "effectiveTo",(p.published_at AT TIME ZONE 'Asia/Shanghai')::date::text "publishedDate" FROM company_commodity_profile p JOIN market_instrument i ON i.id=p.instrument_id WHERE p.commodity_code='LITHIUM_CARBONATE' AND i.code=ANY($1::text[]) ORDER BY i.code`,[LITHIUM_RESEARCH_CODES])).rows;
 const codes=[...new Set(profiles.map(row=>row.code))];
 const bars=(await pool.query<Bar>(`SELECT i.code,b.bar_date::text date,COALESCE(b.open_raw,b.open)::float8 open,COALESCE(b.close_raw,b.close)::float8 close,b.volume::float8,avg(b.volume::float8) OVER(PARTITION BY b.instrument_id ORDER BY b.bar_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) "meanVolume20" FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id WHERE i.code=ANY($1::text[]) AND b.freq='day' AND b.bar_date BETWEEN ($2::date-interval '60 day') AND $3 AND COALESCE(b.open_raw,b.open)>0 AND COALESCE(b.close_raw,b.close)>0 AND b.volume>0 ORDER BY b.bar_date,i.code`,[codes,START,END])).rows;
 const dates=(await pool.query<{date:string}>(`SELECT trade_date::text date FROM market_trading_day WHERE is_open=true AND trade_date BETWEEN $1 AND $2 ORDER BY trade_date`,[START,END])).rows.map(row=>row.date);
 const observations=(await pool.query<Obs>(`WITH ranked AS (SELECT o.period_end::text date,(o.published_at AT TIME ZONE 'Asia/Shanghai')::date::text "publishedDate",o.value::float8,row_number() OVER(PARTITION BY date_trunc('week',o.period_end) ORDER BY o.period_end DESC,o.published_at DESC) rn FROM market_factor_observation o JOIN market_factor_series s ON s.id=o.series_id WHERE s.series_code='gfex.lc.warehouse_receipt.total' AND o.period_end<=$1) SELECT date,"publishedDate",value FROM ranked WHERE rn=1 ORDER BY "publishedDate",date`,[END])).rows;
 const byDate=new Map<string,Map<string,Bar>>();for(const bar of bars){if(!byDate.has(bar.date))byDate.set(bar.date,new Map());byDate.get(bar.date)!.set(bar.code,bar)}
 return{profiles,codes,dates,observations,byDate};
}
function signals(input:Awaited<ReturnType<typeof load>>){const result:Signal[]=[];const history:number[]=[];for(let i=4;i<input.observations.length;i++){const row=input.observations[i]!,prior=input.observations[i-4]!;if(prior.value<=0)continue;const change=row.value/prior.value-1,score=inventoryInversePercentile(change,history);history.push(change);if(row.publishedDate<START)continue;const executionDate=nextDate(input.dates,row.publishedDate);if(!executionDate)continue;const codes=input.profiles.filter(p=>p.publishedDate<=row.publishedDate&&p.effectiveFrom<=row.publishedDate&&(!p.effectiveTo||p.effectiveTo>row.publishedDate)&&input.byDate.get(executionDate)?.has(p.code)).map(p=>p.code).sort();if(codes.length)result.push({executionDate,score,change4w:change,codes})}return result}
class Portfolio{
 cash=INITIAL;positions=new Map<string,Position>();peak=INITIAL;previous=INITIAL;maxDd=0;fees=0;turnover=0;orders=0;days=0;exp=0;lastCodes="";lastExposure=-1;daily:number[]=[];
 constructor(readonly scenario:Scenario,readonly start:string,readonly end:string){}
 price(b:Bar,side:"buy"|"sell"){return Math.round(b.open*100*(1+(side==="buy"?1:-1)*SLIP/10000))}
 capacity(b:Bar){return Math.floor((b.meanVolume20??0)*PARTICIPATION/LOT)*LOT}
 rebalance(s:Signal,rows:Map<string,Bar>){const exposure=Math.max(0,Math.min(1,this.scenario.exposure(s))),codes=s.codes.filter(c=>rows.has(c)),key=codes.join(",");if(key===this.lastCodes&&(Math.abs(exposure-this.lastExposure)<1e-9||Math.abs(exposure-this.lastExposure)<this.scenario.band))return;this.lastCodes=key;this.lastExposure=exposure;let equity=this.cash;for(const[c,p]of this.positions)equity+=p.quantity*Math.round((rows.get(c)?.open??p.lastClose)*100);const target=codes.length?Math.floor(equity*exposure/codes.length):0,set=new Set(codes);for(const[c,p]of[...this.positions]){const b=rows.get(c);if(!b)continue;const desired=set.has(c)?Math.floor(target/Math.round(b.open*100)/LOT)*LOT:0;const q=Math.min(Math.max(0,p.quantity-desired),this.capacity(b));if(q<LOT)continue;const gross=q*this.price(b,"sell"),cost=fee(gross,"sell");this.cash+=gross-cost;this.fees+=cost;this.turnover+=gross;this.orders++;p.quantity-=q;if(!p.quantity)this.positions.delete(c)}for(const c of codes){const b=rows.get(c)!,current=this.positions.get(c)?.quantity??0,desired=Math.floor(target/Math.round(b.open*100)/LOT)*LOT;let q=Math.min(Math.max(0,desired-current),this.capacity(b));q=Math.floor(q/LOT)*LOT;const price=this.price(b,"buy");while(q>=LOT&&q*price+fee(q*price,"buy")>this.cash)q-=LOT;if(q<LOT)continue;const gross=q*price,cost=fee(gross,"buy");this.cash-=gross+cost;this.fees+=cost;this.turnover+=gross;this.orders++;const p=this.positions.get(c)??{quantity:0,lastClose:b.close};p.quantity+=q;this.positions.set(c,p)}}
 mark(rows:Map<string,Bar>){let mv=0;for(const[c,p]of this.positions){const close=rows.get(c)?.close??p.lastClose;p.lastClose=close;mv+=p.quantity*Math.round(close*100)}const equity=this.cash+mv;this.peak=Math.max(this.peak,equity);this.maxDd=Math.max(this.maxDd,(this.peak-equity)/this.peak);this.daily.push(equity/this.previous-1);this.previous=equity;this.exp+=equity?mv/equity:0;this.days++}
 finish(){const total=this.previous/INITIAL-1,annual=Math.pow(1+total,252/Math.max(1,this.days))-1,mean=this.daily.reduce((a,b)=>a+b,0)/Math.max(1,this.daily.length),variance=this.daily.reduce((a,b)=>a+(b-mean)**2,0)/Math.max(1,this.daily.length-1),vol=Math.sqrt(variance*252);return{key:this.scenario.key,name:this.scenario.name,start:this.start,end:this.end,total_return:round(total),annual_return:round(annual),max_drawdown:round(this.maxDd),annual_volatility:round(vol),sharpe:vol?round(annual/vol):null,calmar:this.maxDd?round(annual/this.maxDd):null,exposure:round(this.exp/Math.max(1,this.days)),fees_yuan:round(this.fees/100,2),turnover_yuan:round(this.turnover/100,2),order_count:this.orders}}
}
const scenarios:Scenario[]=[
 {key:"A",name:"基线A_锂资源核心等权",band:0,exposure:()=>1},
 {key:"H",name:"连续H_50%底仓加库存分位",band:0,exposure:s=>copperInventoryTargetExposure(s.score)},
 {key:"J",name:"连续J_10个百分点缓冲",band:.1,exposure:s=>copperInventoryTargetExposure(s.score)},
 {key:"K",name:"连续K_20个百分点缓冲",band:.2,exposure:s=>copperInventoryTargetExposure(s.score)},
];
function run(input:Awaited<ReturnType<typeof load>>,allSignals:Signal[],start:string,end:string){const ps=scenarios.map(s=>new Portfolio(s,start,end)),events=new Map(allSignals.filter(s=>s.executionDate>=start&&s.executionDate<=end).map(s=>[s.executionDate,s]));for(const date of input.dates.filter(d=>d>=start&&d<=end)){const rows=input.byDate.get(date)??new Map(),signal=events.get(date);if(signal)for(const p of ps)p.rebalance(signal,rows);for(const p of ps)p.mark(rows)}return ps.map(p=>p.finish())}
const pool=getPool(loadConfig().databaseUrl);try{const input=await load(pool),allSignals=signals(input);const windows=[{key:"full",start:START,end:END},{key:"front",start:START,end:"2024-12-31"},{key:"back",start:SPLIT,end:END}];const results=Object.fromEntries(windows.map(w=>[w.key,run(input,allSignals,w.start,w.end)]));const output={generated_at:new Date().toISOString(),data:{series:"gfex.lc.warehouse_receipt.total",start:input.observations[0]?.date,end:input.observations.at(-1)?.date,stock_codes:input.codes,weekly_signals:allSignals.length,point_in_time_status:"official_daily_archive_without_exact_publish_time"},formula:{change:"本周仓单量/四个周度观测前仓单量-1",score:"变化的历史逆百分位",exposure:"50%+50%×逆百分位"},results};const file=path.join(outDir,"结果-2026-09-15.json");fs.writeFileSync(file,JSON.stringify(output,null,2));for(const[key,rows]of Object.entries(results))console.log(`\n${key}`,rows);console.log(`\n结果：${file}`)}finally{await closePool()}
