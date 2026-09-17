// 独立事件研究：从“主升末端确认”转向“结构形成后的右侧确认”。只读 PostgreSQL，不接入生产规则。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import type pg from "pg";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";

const START = "2020-11-05";
const END = "2026-08-31";
const QUERY_START = "2020-01-01";
const COST_BPS = 10;
const BOARDS = ["881105.TI", "881107.TI", "881108.TI", "881112.TI", "881115.TI", "881137.TI",
  "881148.TI", "881168.TI", "881169.TI", "881170.TI", "881180.TI", "881264.TI", "881267.TI"];
const shortPoolMode = process.argv.includes("--short-pool");
const outDir = path.resolve("支撑/tmp/右侧结构信号研究");
fs.mkdirSync(outDir, { recursive: true });

type SignalName = "原六条件" | "横盘突破回踩" | "下跌突破回踩" | "止跌三日组合";
interface EventRow {
  signal: SignalName; code: string; board: string; signal_date: string; rn: number;
  signal_close: number; entry_open: number | null; entry_date: string | null;
  close5: number | null; close10: number | null; close20: number | null; close40: number | null;
  high20: number | null; low20: number | null; setup_return20: number | null; setup_return60: number | null;
  structure_level: number | null;
}
interface Summary {
  count: number; avg_return5: number | null; avg_return10: number | null; avg_return20: number | null;
  median_return20: number | null; win_rate20: number | null; avg_return40: number | null;
  avg_mfe20: number | null; avg_mae20: number | null;
}

const mean = (values: number[]): number | null => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
const round = (value: number | null, digits = 4): number | null => value === null ? null : Number(value.toFixed(digits));
const pct = (value: number | null): string => value === null ? "-" : `${(value * 100).toFixed(2)}%`;

async function loadLowTurnover(pool: pg.Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ code: string }>(
    `WITH px AS (
       SELECT i.code,percentile_cont(0.5) WITHIN GROUP(ORDER BY b.close*b.volume) AS turnover
       FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id
       WHERE i.kind='stock' AND b.freq='day' AND b.bar_date BETWEEN '2021-01-01' AND '2022-12-31'
         AND b.close>0 AND b.volume>0 GROUP BY i.code
     ), ranked AS (SELECT code,percent_rank() OVER(ORDER BY turnover) AS pct FROM px WHERE turnover IS NOT NULL)
     SELECT code FROM ranked WHERE pct<0.3`);
  return new Set(rows.map(row => row.code));
}

async function loadShortPoolCodes(pool: pg.Pool): Promise<string[]> {
  if (!shortPoolMode) return [];
  const { rows } = await pool.query<{ code: string }>(
    `SELECT instrument.code
       FROM pool_membership membership
       JOIN market_instrument instrument ON instrument.id=membership.instrument_id
      WHERE membership.pool='short' AND membership.effective_to IS NULL AND instrument.kind='stock'
      ORDER BY instrument.code`,
  );
  return rows.map(row => row.code);
}

async function loadEvents(pool: pg.Pool, shortPoolCodes: string[]): Promise<EventRow[]> {
  const client = await pool.connect();
  try {
    const universeFilter = shortPoolMode
      ? "mi.code=ANY($3::text[])"
      : "bi.code=ANY($3::text[])";
    const universe = shortPoolMode ? shortPoolCodes : BOARDS;
    console.time("结构特征临时表");
    await client.query(
      `CREATE TEMP TABLE structure_features AS
       WITH membership AS (
         SELECT mi.id AS stock_id,mi.code,bi.code AS board
         FROM market_board_membership m
         JOIN market_instrument bi ON bi.id=m.board_instrument_id
         JOIN market_instrument mi ON mi.id=m.member_instrument_id
         WHERE m.effective_to IS NULL AND ${universeFilter} AND mi.kind='stock'
           AND mi.code ~ '^[0-9]{6}[.](SH|SZ)$'
       ), base AS (
         SELECT m.stock_id,m.code,m.board,b.bar_date,b.open::float8,b.high::float8,b.low::float8,b.close::float8,b.volume::float8,
                v.ma5::float8,v.ma10::float8,v.ma20::float8,v.ma60::float8,v.dif::float8,v.macd_hist::float8,v.status,
                row_number() OVER(PARTITION BY m.stock_id ORDER BY b.bar_date)::int AS rn
         FROM membership m JOIN market_bar b ON b.instrument_id=m.stock_id AND b.freq='day' AND b.bar_date BETWEEN $1 AND $2
         JOIN market_indicator_value v ON v.instrument_id=b.instrument_id AND v.freq=b.freq AND v.bar_date=b.bar_date AND v.bar_time=b.bar_time
       ), features AS (
         SELECT *,lag(close,1) OVER w::float8 AS previous_close,lag(ma20,1) OVER w::float8 AS previous_ma20,
                lag(macd_hist,1) OVER w::float8 AS previous_macd_hist,
                lag(close,20) OVER w::float8 AS past_close20,lag(close,60) OVER w::float8 AS past_close60,
                max(high) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)::float8 AS prior_high20,
                min(low) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)::float8 AS prior_low20,
                max(high) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 10 PRECEDING AND 1 PRECEDING)::float8 AS prior_high10,
                avg(volume) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)::float8 AS volume20,
                avg(volume) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING)::float8 AS volume5
         FROM base WINDOW w AS(PARTITION BY stock_id ORDER BY rn)
       )
       SELECT *,lead(open,1) OVER w::float8 AS entry_open,(lead(bar_date,1) OVER w)::text AS entry_date,
              lead(close,5) OVER w::float8 AS close5,lead(close,10) OVER w::float8 AS close10,
              lead(close,20) OVER w::float8 AS future_close20,lead(close,40) OVER w::float8 AS close40,
              max(high) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 1 FOLLOWING AND 20 FOLLOWING)::float8 AS future_high20,
              min(low) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 1 FOLLOWING AND 20 FOLLOWING)::float8 AS future_low20
       FROM features WINDOW w AS(PARTITION BY stock_id ORDER BY rn)`, [QUERY_START, END, universe]);
    await client.query("CREATE INDEX ON structure_features(stock_id,rn)");
    await client.query("CREATE INDEX ON structure_features(bar_date)");
    await client.query("ANALYZE structure_features");
    console.timeEnd("结构特征临时表");
    const select = (signal: string, alias: string, structureLevel = "NULL::float8") =>
      `SELECT '${signal}'::text AS signal,${alias}.code,${alias}.board,${alias}.bar_date::text AS signal_date,${alias}.rn,
              ${alias}.close AS signal_close,${alias}.entry_open,${alias}.entry_date,${alias}.close5,${alias}.close10,
              ${alias}.future_close20 AS close20,${alias}.close40,${alias}.future_high20 AS high20,${alias}.future_low20 AS low20,
              ${alias}.close/NULLIF(${alias}.past_close20,0)-1 AS setup_return20,
              ${alias}.close/NULLIF(${alias}.past_close60,0)-1 AS setup_return60,${structureLevel} AS structure_level`;
    console.time("结构信号查询");
    const original = await client.query<EventRow>(
      `${select("原六条件", "f")} FROM structure_features f
       WHERE f.bar_date BETWEEN $1 AND $2 AND f.status='ready' AND f.previous_close>0 AND f.previous_ma20 IS NOT NULL
         AND f.previous_macd_hist IS NOT NULL AND f.dif>0 AND f.ma20>f.previous_ma20
         AND f.macd_hist>0 AND (f.macd_hist-f.previous_macd_hist)/f.close>0.001
         AND f.close>f.ma5 AND f.ma5>f.ma10 AND f.close/f.open-1>=0.01 AND f.volume>f.volume5*1.2`, [START, END]);
    const box = await client.query<EventRow>(
      `WITH breakouts AS (
         SELECT * FROM structure_features WHERE bar_date BETWEEN $1 AND $2 AND status='ready' AND prior_low20>0 AND previous_close>0 AND volume20>0
           AND prior_high20/prior_low20-1<=0.20 AND close/past_close20-1 BETWEEN -0.08 AND 0.15
           AND close>prior_high20 AND volume>volume20*1.2
       ), chosen AS (
         SELECT b.stock_id,b.rn AS breakout_rn,b.prior_high20 AS level,c.rn AS confirm_rn,
                row_number() OVER(PARTITION BY b.stock_id,b.rn ORDER BY c.rn)::int AS choice
         FROM breakouts b JOIN structure_features c ON c.stock_id=b.stock_id AND c.rn BETWEEN b.rn+2 AND b.rn+8
         WHERE c.low<=b.prior_high20*1.03 AND c.close>=b.prior_high20*0.99 AND c.close>c.open AND c.close>c.previous_close
           AND c.volume<b.volume AND NOT EXISTS(
             SELECT 1 FROM structure_features x WHERE x.stock_id=b.stock_id AND x.rn BETWEEN b.rn+1 AND c.rn AND x.close<b.prior_high20*0.97)
       )
       ${select("横盘突破回踩", "f", "c.level")} FROM chosen c JOIN structure_features f ON f.stock_id=c.stock_id AND f.rn=c.confirm_rn WHERE c.choice=1`, [START, END]);
    const down = await client.query<EventRow>(
      `WITH breakouts AS (
         SELECT * FROM structure_features WHERE bar_date BETWEEN $1 AND $2 AND status='ready' AND previous_close>0 AND previous_ma20 IS NOT NULL AND past_close60>0 AND volume20>0
           AND close/past_close60-1<=-0.15 AND previous_close<=previous_ma20 AND close>ma20 AND close>prior_high10 AND volume>volume20*1.2
       ), chosen AS (
         SELECT b.stock_id,b.rn AS breakout_rn,c.rn AS confirm_rn,
                row_number() OVER(PARTITION BY b.stock_id,b.rn ORDER BY c.rn)::int AS choice
         FROM breakouts b JOIN structure_features c ON c.stock_id=b.stock_id AND c.rn BETWEEN b.rn+2 AND b.rn+8
         WHERE c.ma20 IS NOT NULL AND c.low<=c.ma20*1.03 AND c.close>=c.ma20 AND c.close>c.open AND c.close>c.previous_close
           AND c.volume<=b.volume*1.1 AND NOT EXISTS(
             SELECT 1 FROM structure_features x WHERE x.stock_id=b.stock_id AND x.rn BETWEEN b.rn+1 AND c.rn AND x.close<b.low*0.98)
       )
       ${select("下跌突破回踩", "f")} FROM chosen c JOIN structure_features f ON f.stock_id=c.stock_id AND f.rn=c.confirm_rn WHERE c.choice=1`, [START, END]);
    const stop = await client.query<EventRow>(
      `${select("止跌三日组合", "f")} FROM structure_features s0
       JOIN structure_features s1 ON s1.stock_id=s0.stock_id AND s1.rn=s0.rn+1
       JOIN structure_features f ON f.stock_id=s0.stock_id AND f.rn=s0.rn+2
       WHERE f.bar_date BETWEEN $1 AND $2 AND s0.status='ready' AND s0.past_close20>0 AND s0.prior_low20>0
         AND s0.close/s0.past_close20-1<=-0.12 AND s0.low<=s0.prior_low20
         AND s0.high>s0.low AND LEAST(s0.open,s0.close)-s0.low>=(s0.high-s0.low)*0.40
         AND s0.close>=s0.low+(s0.high-s0.low)*0.60
         AND s1.low>=s0.low*0.98 AND s1.close>=s0.close*0.98
         AND f.close>GREATEST(s0.high,s1.high) AND f.close>f.open AND f.volume>=f.volume5`, [START, END]);
    console.timeEnd("结构信号查询");
    const rows = [...original.rows, ...box.rows, ...down.rows, ...stop.rows];
    return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      ["signal", "code", "board", "signal_date", "entry_date"].includes(key) || value === null ? value : Number(value)])) as unknown as EventRow);
  } finally {
    client.release();
  }
}

function dedupe(events: EventRow[]): EventRow[] {
  const result: EventRow[] = [];
  const last = new Map<string, number>();
  for (const event of events.sort((a, b) => a.signal.localeCompare(b.signal) || a.code.localeCompare(b.code) || a.rn-b.rn)) {
    const key = `${event.signal}|${event.code}`; const previous = last.get(key);
    if (previous !== undefined && event.rn-previous<15) continue;
    last.set(key,event.rn); result.push(event);
  }
  return result;
}

function summarize(events: EventRow[], costBps = COST_BPS): Summary {
  const valid=events.filter(event=>event.entry_open!==null&&event.entry_date!==null&&event.entry_open!<=event.signal_close*1.03);
  const ret=(event:EventRow,close:number|null)=>close===null?null:close*(1-costBps/10000)/(event.entry_open!*(1+costBps/10000))-1;
  const values=(days:5|10|20|40)=>valid.map(event=>ret(event,event[`close${days}`])).filter((value):value is number=>value!==null);
  const r5=values(5),r10=values(10),r20=values(20),r40=values(40);
  const mfe=valid.filter(event=>event.high20!==null).map(event=>event.high20!/(event.entry_open!*(1+costBps/10000))-1);
  const mae=valid.filter(event=>event.low20!==null).map(event=>event.low20!/(event.entry_open!*(1+costBps/10000))-1);
  return {count:valid.length,avg_return5:round(mean(r5)),avg_return10:round(mean(r10)),avg_return20:round(mean(r20)),median_return20:round(median(r20)),
    win_rate20:round(r20.length?r20.filter(value=>value>0).length/r20.length:null),avg_return40:round(mean(r40)),avg_mfe20:round(mean(mfe)),avg_mae20:round(mean(mae))};
}

interface PortfolioDayRow { code: string; open: number; close: number; volume: number; ma10: number | null; previous_close: number | null; mean_volume20: number | null }
type StructureExitReason = "structure_stop" | "ma10_two_days" | "max_holding";
interface StructurePosition { code: string; board: string; quantity: number; entryPrice: number; costCents: number; realizedCents: number; stop: number; entryDay: number; belowMa10: number; lastClose: number }
interface StructureScenario { name: string; start: string; end: string; order: "hash" | "asc" | "desc" | "quality"; slippageBps: number; excludeSmall: boolean; circuits: boolean }
const STRUCTURE_SCENARIOS:StructureScenario[]=[
  {name:"结构退出_哈希顺序",start:START,end:END,order:"hash",slippageBps:10,excludeSmall:false,circuits:true},
  {name:"结构退出_代码正序",start:START,end:END,order:"asc",slippageBps:10,excludeSmall:false,circuits:true},
  {name:"结构退出_代码倒序",start:START,end:END,order:"desc",slippageBps:10,excludeSmall:false,circuits:true},
  {name:"结构退出_30bp",start:START,end:END,order:"hash",slippageBps:30,excludeSmall:false,circuits:true},
  {name:"结构退出_CH3",start:START,end:END,order:"hash",slippageBps:10,excludeSmall:true,circuits:true},
  {name:"结构退出_前窗",start:START,end:"2022-12-30",order:"hash",slippageBps:10,excludeSmall:false,circuits:true},
  {name:"结构退出_后窗",start:"2023-01-03",end:END,order:"hash",slippageBps:10,excludeSmall:false,circuits:true},
  {name:"结构退出_无熔断",start:START,end:END,order:"hash",slippageBps:10,excludeSmall:false,circuits:false},
  {name:"结构质量排序",start:START,end:END,order:"quality",slippageBps:10,excludeSmall:false,circuits:true},
  {name:"结构质量排序_30bp",start:START,end:END,order:"quality",slippageBps:30,excludeSmall:false,circuits:true},
  {name:"结构质量排序_CH3",start:START,end:END,order:"quality",slippageBps:10,excludeSmall:true,circuits:true},
  {name:"结构质量排序_前窗",start:START,end:"2022-12-30",order:"quality",slippageBps:10,excludeSmall:false,circuits:true},
  {name:"结构质量排序_后窗",start:"2023-01-03",end:END,order:"quality",slippageBps:10,excludeSmall:false,circuits:true},
];
const LOT=100,INITIAL_CASH=100_000_000,MIN_COMMISSION=500;
function portfolioCharges(gross:number,side:"buy"|"sell"):number{return Math.max(MIN_COMMISSION,Math.round(gross*2.5/10000))+(side==="sell"?Math.round(gross*10/10000):0)}
function hashOrder(value:string):string{return createHash("sha256").update(value).digest("hex")}
class PortfolioLoader{
  private cache=new Map<string,Map<string,PortfolioDayRow|null>>();
  constructor(private pool:pg.Pool){}
  async load(date:string,codes:string[]):Promise<Map<string,PortfolioDayRow|null>>{
    let day=this.cache.get(date);if(!day){day=new Map();this.cache.set(date,day)}
    const missing=[...new Set(codes)].filter(code=>!day!.has(code));
    if(missing.length){const {rows}=await this.pool.query<PortfolioDayRow>(
      `SELECT i.code,b.open::float8,b.close::float8,b.volume::float8,v.ma10::float8,
              previous.close::float8 AS previous_close,volume20.mean_volume20::float8
       FROM market_instrument i JOIN market_bar b ON b.instrument_id=i.id AND b.freq='day' AND b.bar_date=$1
       LEFT JOIN market_indicator_value v ON v.instrument_id=b.instrument_id AND v.freq=b.freq AND v.bar_date=b.bar_date AND v.bar_time=b.bar_time
       LEFT JOIN LATERAL(SELECT pb.close FROM market_bar pb WHERE pb.instrument_id=i.id AND pb.freq='day' AND pb.bar_date<$1 ORDER BY pb.bar_date DESC LIMIT 1) previous ON true
       LEFT JOIN LATERAL(SELECT avg(x.volume) mean_volume20 FROM(SELECT pb.volume FROM market_bar pb WHERE pb.instrument_id=i.id AND pb.freq='day' AND pb.bar_date<$1 ORDER BY pb.bar_date DESC LIMIT 20)x) volume20 ON true
       WHERE i.code=ANY($2::text[])`,[date,missing]);
      const found=new Set<string>();for(const row of rows){found.add(row.code);day.set(row.code,Object.fromEntries(Object.entries(row).map(([key,value])=>[key,key==="code"||value===null?value:Number(value)])) as unknown as PortfolioDayRow)}
      for(const code of missing)if(!found.has(code))day.set(code,null);
    }return day;
  }
}
async function loadPortfolioCalendar(pool:pg.Pool):Promise<{dates:string[];recovery:Map<string,boolean>}>{
  const {rows}=await pool.query<{date:string;ret:number|null}>(`WITH r AS(
    SELECT b.bar_date,b.close/NULLIF(lag(b.close)OVER(PARTITION BY b.instrument_id ORDER BY b.bar_date),0)-1 ret
    FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id WHERE i.kind='board' AND i.code LIKE '881%.SY' AND b.freq='day' AND b.bar_date BETWEEN '2020-01-01' AND $1)
    SELECT bar_date::text date,avg(ret)::float8 ret FROM r WHERE ret IS NOT NULL GROUP BY bar_date HAVING count(*)>=60 ORDER BY bar_date`,[END]);
  let level=1000;const levels:number[]=[];const recovery=new Map<string,boolean>();for(let i=0;i<rows.length;i++){level*=1+Number(rows[i]!.ret??0);levels.push(level);recovery.set(rows[i]!.date,i>=20&&level>=levels[i-20]!)}
  return{dates:rows.map(row=>row.date).filter(date=>date>=START&&date<=END),recovery};
}
class StructurePortfolio{
  private cash=INITIAL_CASH;private positions=new Map<string,StructurePosition>();private buys:EventRow[]=[];private sells=new Map<string,StructureExitReason>();private fees=0;private peak=INITIAL_CASH;private previous=INITIAL_CASH;private recent:number[]=[];private maxDrawdown=0;private trades=0;private wins=0;private stopStreak=0;private pausedSince:number|null=null;private exposure=0;private days=0;private pausedDays=0;private perYear:Record<string,number>={};private exits:Record<string,number>={};
  constructor(readonly config:StructureScenario,private lowTurnover:Set<string>){}
  active(date:string){return date>=this.config.start&&date<=this.config.end}
  needed(){return[...new Set([...this.positions.keys(),...this.buys.map(event=>event.code),...this.sells.keys()])]}
  private execution(row:PortfolioDayRow,side:"buy"|"sell"):{price:number;capacity:number}|null{if(row.previous_close===null||row.mean_volume20===null)return null;const upper=Math.round(row.previous_close*1.1*100)/100,lower=Math.round(row.previous_close*.9*100)/100;if(row.open<lower||row.open>upper||(side==="buy"&&row.open>=upper)||(side==="sell"&&row.open<=lower))return null;const price=row.open*(1+(side==="buy"?1:-1)*this.config.slippageBps/10000),capacity=Math.floor(row.mean_volume20*.02/LOT)*LOT;return price>0&&capacity>=LOT?{price,capacity}:null}
  open(rows:Map<string,PortfolioDayRow|null>,dayIndex:number){let newStop=false;for(const[code,reason]of this.sells){const row=rows.get(code),position=this.positions.get(code);if(!row||!position)continue;const fill=this.execution(row,"sell");if(!fill)continue;const quantity=Math.min(position.quantity,fill.capacity);if(quantity<LOT)continue;const gross=Math.round(fill.price*quantity*100),fee=portfolioCharges(gross,"sell"),allocated=Math.round(position.costCents*quantity/position.quantity);this.cash+=gross-fee;this.fees+=fee;position.costCents-=allocated;position.quantity-=quantity;position.realizedCents+=gross-fee-allocated;if(position.quantity===0){this.positions.delete(code);this.sells.delete(code);this.trades++;if(position.realizedCents>0)this.wins++;this.exits[reason]=(this.exits[reason]??0)+1;const stop=reason==="structure_stop";this.stopStreak=stop?this.stopStreak+1:0;if(stop&&this.stopStreak>=3)newStop=true}}
    for(const event of this.buys){if(this.pausedSince!==null||this.positions.has(event.code)||this.positions.size>=5)continue;const row=rows.get(event.code);if(!row||row.open>event.signal_close*1.03||event.structure_level===null)continue;const fill=this.execution(row,"buy");if(!fill)continue;const budget=Math.min(this.cash,Math.floor(this.previous*.2));let quantity=Math.min(Math.floor(budget/(fill.price*100)/LOT)*LOT,fill.capacity);while(quantity>=LOT){const gross=Math.round(fill.price*quantity*100),fee=portfolioCharges(gross,"buy");if(gross+fee<=budget){this.cash-=gross+fee;this.fees+=fee;const stop=Math.min(fill.price*.995,Math.max(fill.price*.90,event.structure_level*.97));this.positions.set(event.code,{code:event.code,board:event.board,quantity,entryPrice:fill.price,costCents:gross+fee,realizedCents:0,stop,entryDay:dayIndex,belowMa10:0,lastClose:row.close});break}quantity-=LOT}}
    this.buys=[];if(this.config.circuits&&newStop&&this.pausedSince===null)this.pausedSince=dayIndex;
  }
  close(date:string,rows:Map<string,PortfolioDayRow|null>,events:EventRow[],dayIndex:number,recovery:boolean){let marketValue=0;for(const position of this.positions.values()){const row=rows.get(position.code);if(row)position.lastClose=row.close;marketValue+=Math.round(position.lastClose*position.quantity*100);if(!row)continue;position.belowMa10=row.ma10!==null&&row.close<row.ma10?position.belowMa10+1:0;const holding=dayIndex-position.entryDay+1;const reason:StructureExitReason|null=row.close<=position.stop?"structure_stop":holding>=5&&position.belowMa10>=2?"ma10_two_days":holding>=40?"max_holding":null;if(reason)this.sells.set(position.code,reason)}
    const total=this.cash+marketValue;this.peak=Math.max(this.peak,total);this.maxDrawdown=Math.max(this.maxDrawdown,(this.peak-total)/this.peak);this.recent.push(total);if(this.recent.length>20)this.recent.shift();const recentPeak=Math.max(...this.recent);if(this.config.circuits&&(recentPeak-total)/recentPeak>.05&&this.pausedSince===null)this.pausedSince=dayIndex;else if(this.pausedSince!==null&&dayIndex>this.pausedSince&&recovery){this.pausedSince=null;this.stopStreak=0}
    if(this.pausedSince===null){const slots=5-this.positions.size+this.sells.size;const filtered=events.filter(event=>!this.config.excludeSmall||!this.lowTurnover.has(event.code)).filter(event=>!this.positions.has(event.code));const ordered=[...filtered].sort((a,b)=>this.config.order==="asc"?a.code.localeCompare(b.code):this.config.order==="desc"?b.code.localeCompare(a.code):this.config.order==="quality"?((a.signal_close/a.structure_level!)-(b.signal_close/b.structure_level!)||(a.setup_return20??0)-(b.setup_return20??0)||a.code.localeCompare(b.code)):hashOrder(`${date}|${a.code}`).localeCompare(hashOrder(`${date}|${b.code}`)));this.buys=ordered.slice(0,Math.min(5,slots))}
    this.days++;this.exposure+=total>0?marketValue/total:0;if(this.pausedSince!==null)this.pausedDays++;const year=date.slice(0,4);this.perYear[year]=(this.perYear[year]??1)*total/this.previous;this.previous=total;
  }
  finish(){const totalReturn=this.previous/INITIAL_CASH-1;for(const year of Object.keys(this.perYear))this.perYear[year]=Number((this.perYear[year]!-1).toFixed(4));return{name:this.config.name,total_return:Number(totalReturn.toFixed(4)),annual_return:Number((Math.pow(1+totalReturn,252/Math.max(1,this.days))-1).toFixed(4)),max_drawdown:Number(this.maxDrawdown.toFixed(4)),trade_count:this.trades,win_rate:this.trades?Number((this.wins/this.trades).toFixed(4)):null,fees_yuan:Number((this.fees/100).toFixed(2)),exposure:Number((this.exposure/Math.max(1,this.days)).toFixed(4)),paused_days:this.pausedDays,exits:this.exits,per_year:this.perYear}}
}
async function runStructurePortfolio(pool:pg.Pool,events:EventRow[],lowTurnover:Set<string>){const box=events.filter(event=>event.signal==="横盘突破回踩"&&event.structure_level!==null);const byDate=new Map<string,EventRow[]>();for(const event of box)byDate.set(event.signal_date,[...(byDate.get(event.signal_date)??[]),event]);const calendar=await loadPortfolioCalendar(pool),loader=new PortfolioLoader(pool),portfolios=STRUCTURE_SCENARIOS.map(config=>new StructurePortfolio(config,lowTurnover));for(let i=0;i<calendar.dates.length;i++){const date=calendar.dates[i]!,active=portfolios.filter(portfolio=>portfolio.active(date)),needed=[...new Set(active.flatMap(portfolio=>portfolio.needed()))],rows=needed.length?await loader.load(date,needed):new Map<string,PortfolioDayRow|null>();for(const portfolio of active){portfolio.open(rows,i);portfolio.close(date,rows,byDate.get(date)??[],i,calendar.recovery.get(date)??false)}}const results=portfolios.map(portfolio=>portfolio.finish());console.log("\n组合\t总收益\t年化\t回撤\t交易\t胜率\t暴露\t暂停日");for(const result of results)console.log(`${result.name}\t${pct(result.total_return)}\t${pct(result.annual_return)}\t${pct(result.max_drawdown)}\t${result.trade_count}\t${pct(result.win_rate)}\t${pct(result.exposure)}\t${result.paused_days}`);return results}

async function main():Promise<void>{
  const pool=getPool(loadConfig().databaseUrl);const shortPoolCodes=await loadShortPoolCodes(pool);
  if(shortPoolMode&&!shortPoolCodes.length)throw new Error("当前短线池没有股票成员");
  const [raw,lowTurnover]=await Promise.all([loadEvents(pool,shortPoolCodes),loadLowTurnover(pool)]);
  const events=dedupe(raw);const signals:SignalName[]=["原六条件","横盘突破回踩","下跌突破回踩","止跌三日组合"];
  const researchBoards=[...new Set(events.map(event=>event.board))].sort();
  const result:any={}; const boardResults:any={}; const yearlyResults:any={};
  for(const signal of signals){const all=events.filter(event=>event.signal===signal);result[signal]={
    default_full:summarize(all),default_early:summarize(all.filter(event=>event.signal_date<="2022-12-30")),default_late:summarize(all.filter(event=>event.signal_date>="2023-01-03")),
    ch3_full:summarize(all.filter(event=>!lowTurnover.has(event.code))),stress30:summarize(all,30),
  };
    boardResults[signal]=Object.fromEntries(researchBoards.map(board=>{const rows=all.filter(event=>event.board===board);return [board,{
      full:summarize(rows),early:summarize(rows.filter(event=>event.signal_date<="2022-12-30")),late:summarize(rows.filter(event=>event.signal_date>="2023-01-03")),
      ch3:summarize(rows.filter(event=>!lowTurnover.has(event.code))),stress30:summarize(rows,30),
    }]}));
    yearlyResults[signal]=Object.fromEntries(["2020","2021","2022","2023","2024","2025","2026"].map(year=>
      [year,summarize(all.filter(event=>event.signal_date.startsWith(year)))]));
  }
  console.log("\n信号\t样本\t20日均值\t中位\t胜率\t40日均值\tMFE20\tMAE20\t前窗\t后窗\tCH3\t30bp");
  for(const signal of signals){const r=result[signal];console.log(`${signal}\t${r.default_full.count}\t${pct(r.default_full.avg_return20)}\t${pct(r.default_full.median_return20)}\t${pct(r.default_full.win_rate20)}\t${pct(r.default_full.avg_return40)}\t${pct(r.default_full.avg_mfe20)}\t${pct(r.default_full.avg_mae20)}\t${pct(r.default_early.avg_return20)}\t${pct(r.default_late.avg_return20)}\t${pct(r.ch3_full.avg_return20)}\t${pct(r.stress30.avg_return20)}`);}
  const output=path.join(outDir,`右侧结构信号-${new Date().toISOString().slice(0,19).replaceAll(":","-")}.json`);
  fs.writeFileSync(output,JSON.stringify({evidence:"research_only",range:{start:START,end:END},universe:shortPoolMode?"当前短线池":"当前13个周期行业",codes:shortPoolMode?shortPoolCodes:undefined,boards:researchBoards,methodology:{dedupe:"同股同信号15个交易行内只保留首次",entry:"确认日后下一可用开盘，开盘缺口不超过3%，双边10bp；30bp压力另列",scope:shortPoolMode?"当前短线池成员历史回看事件级，不含仓位和组合熔断":"当前13个周期行业全成员回看事件级，不含仓位和组合熔断"},caveats:["当前行业归属回看","短线池为2026年8-9月形成的当前池，回看历史存在严重幸存者和人工选股偏差","下一可用股票交易行近似下一交易日，停牌未按市场日历严格过期","前复权研究价格","全部阈值为预注册首轮值但仍无真正未使用样本外"],raw_events:raw.length,deduped_events:events.length,results:result,yearly_results:yearlyResults,board_results:boardResults},null,2));
  console.log(`结果已写入 ${output}`);
  if(process.argv.includes("--portfolio")){const portfolioResults=await runStructurePortfolio(pool,events,lowTurnover);const portfolioOutput=path.join(outDir,`${shortPoolMode?"短线池-":""}横盘突破回踩组合-${new Date().toISOString().slice(0,19).replaceAll(":","-")}.json`);fs.writeFileSync(portfolioOutput,JSON.stringify({evidence:"research_only",signal:"横盘突破回踩",universe:shortPoolMode?"当前短线池":"当前13个周期行业",codes:shortPoolMode?shortPoolCodes:undefined,range:{start:START,end:END},scenarios:STRUCTURE_SCENARIOS,results:portfolioResults,caveats:["当前行业归属回看","当前短线池历史回看存在严重幸存者和人工选股偏差","前复权研究价格","事件阈值已在首轮数据中观察","候选顺序做哈希/代码正反序敏感性"]},null,2));console.log(`组合结果已写入 ${portfolioOutput}`)}
  await closePool();
}
await main();
