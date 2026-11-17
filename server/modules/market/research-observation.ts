import type pg from 'pg';
import { fetchSnapshot } from '../../datasource/hithink.js';
import { fetchHithinkDataset } from '../../datasource/hithink-datasets.js';
import { isScheduledTradingDay,shanghaiDate } from '../../scheduler/time.js';
import { apiErrors } from '../../http/router.js';
type Db=Pick<pg.Pool,'query'>;
export function observationKind(now:Date):'auction_final'|'intraday'|null {
 const clock=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
 if(clock==='09:25')return 'auction_final';
 return (clock>='09:30'&&clock<'11:30')||(clock>='13:00'&&clock<'15:00')?'intraday':null;
}
export function observationStatus(kind:string,now:Date,source:Date|null,price:number|null) {
 if(!source||price===null||!Number.isFinite(price)||price<=0)return 'missing';
 const diff=now.getTime()-source.getTime();
 const clock=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(source);
 return shanghaiDate(now)!==shanghaiDate(source)||diff>90000||diff< -30000||(kind==='auction_final'&&clock!=='09:25')?'stale':'ready';
}
export async function sampleResearchObservations(pool:pg.Pool,now:Date) {
 const kind=observationKind(now);if(!kind||!await isScheduledTradingDay(pool,shanghaiDate(now)))return;
 const codes=(await pool.query<{code:string}>('SELECT code FROM research_observation_subscription WHERE enabled ORDER BY code')).rows.map(r=>r.code);
 if(!codes.length)return;
 const prices=new Map<string,{price:number|null;source:Date|null}>();
 try {
 if(kind==='auction_final'){
 const r=await fetchHithinkDataset({capability:'auction_snapshot',codes,stage:'final'},{db:pool});
 const source=r.sourceTimestampMs===null?null:new Date(r.sourceTimestampMs);
 const rows=r.payload.item;
 if(Array.isArray(rows))for(const row of rows){const x=row as Record<string,unknown>;prices.set(String(x.thscode),{price:typeof x.auction_price==='number'?x.auction_price:null,source});}
 }else{
 for(const q of await fetchSnapshot(codes,{db:pool,priority:'scheduled-low'},'stock'))prices.set(q.code,{price:q.close,source:Number.isFinite(q.timestampMs)?new Date(q.timestampMs):null});
 }
 }catch{/* 缺数逐订阅落记录，错误正文不入库或日志。 */}
 for(const code of codes){const q=prices.get(code)??{price:null,source:null};
 await pool.query(`INSERT INTO research_observation_sample(trade_date,code,kind,sample_at,source_at,price,data_status,data_source)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[shanghaiDate(now),code,kind,now,q.source,q.price,observationStatus(kind,now,q.source,q.price),kind==='auction_final'?'hithink:auction_snapshot:final':'hithink:stock_snapshot']);}
}
export async function readResearchObservations(db:Db,codes:string[],date:string){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw apiErrors.badRequest('date格式须为YYYY-MM-DD');
 if(!codes.length||codes.length>8||codes.some(c=>!/^\d{6}\.(SH|SZ|BJ)$/.test(c)))throw apiErrors.badRequest('codes须为1–8个完整股票代码');
 const subscribed=(await db.query<{code:string}>('SELECT code FROM research_observation_subscription WHERE enabled AND code=ANY($1::text[])',[codes])).rows;
 const data=[];
 for(const {code} of subscribed){
 const previous=(await db.query(`SELECT b.bar_date::text,b.close::float8,b.adjustment FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id WHERE i.code=$1 AND b.freq='day' AND b.bar_date=(SELECT max(trade_date) FROM market_trading_day WHERE is_open AND trade_date<$2::date) ORDER BY b.bar_time DESC LIMIT 1`,[code,date])).rows[0]??null;
 const samples=(await db.query(`SELECT DISTINCT ON(kind) kind,sample_at,source_at,price::float8,data_status,data_source FROM research_observation_sample WHERE code=$1 AND trade_date=$2 ORDER BY kind,sample_at DESC`,[code,date])).rows;
 data.push({code,previous_close:previous,auction_final:samples.find(r=>r.kind==='auction_final')??{data_status:'missing',reason:'已订阅，目标日尚无竞价终态采样',data_source:'stored',sample_at:null,source_at:null},intraday:samples.find(r=>r.kind==='intraday')??null});
 }
 return {data_source:'stored',trade_date:date,items:data};
}
export const researchObservationRoutes={async list({pool,query}:{pool:pg.Pool;query:URLSearchParams}){return {data:await readResearchObservations(pool,(query.get('codes')??'').split(',').filter(Boolean),query.get('date')??'')};}};
export class ResearchObservationWorker {
 private timer:ReturnType<typeof setInterval>|null=null;private pending:Promise<void>|null=null;
 constructor(private pool:pg.Pool){}
 start(){const tick=()=>{if(this.pending)return;this.pending=sampleResearchObservations(this.pool,new Date()).catch(()=>{}).finally(()=>{this.pending=null;});};this.timer=setInterval(tick,20000);tick();}
 async stop(){if(this.timer)clearInterval(this.timer);await this.pending;}
}
