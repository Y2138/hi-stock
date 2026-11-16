import type pg from 'pg';
import { hithinkGet, type HithinkDeps } from './hithink.js';
import { storeBars } from './service.js';
import { upsertFuturesContract, storeFuturesDailyDetail, storeFuturesRoll } from './commodity-service.js';
import type { Bar } from './types.js';

export const FUTURES_PRODUCTS = ['CU','AL','AU','SC','LH','RB','I','J','MA','TA','UR','PP','LC'] as const;
type Row = Record<string, any>;
const SOURCE = 'hithink_futures';
const items = (data: unknown): Row[] => {
 const value = (data as Row)?.item;
 if (!Array.isArray(value)) throw new Error('期货响应缺少 item 数组');
 return value;
};
const day = (ms: number) => new Date(ms + 8 * 3600000).toISOString().slice(0,10);
export function futuresMonth(row: Row): string | null {
 const match = String(row.thscode).match(/^[A-Z]+(\d{3,4})\./);
 if (!match) return null;
 const token=match[1]!;
 if(token.length===4)return `20${token}`;
 // 郑商所三位年月只依据上市/最后交易日期界定十年，不用系统当前年猜。
 const anchor=String(row.last_trade_date??row.end_date??'');
 if(!/^\d{4}-/.test(anchor))throw new Error('三位月份缺目录日期依据');
 const year=Number(anchor.slice(0,4));
 for(const y of [year-1,year,year+1])if(y%10===Number(token[0]))return `${y}${token.slice(1)}`;
 throw new Error('目录日期与合约月份不一致');
}
export function futuresBars(data: unknown, target: string): Array<Bar & { interest: number | null }> {
 return items(data).map(r=>{
  const date=day(Number(r.timestamp));
  const [open,high,low,close]=[r.open_price,r.high_price,r.low_price,r.close_price].map(Number);
  if([r.open_price,r.high_price,r.low_price,r.close_price].some(x=>x==null)||![open,high,low,close].every(x=>x!==undefined&&Number.isFinite(x)&&x>0)||high!<Math.max(open!,close!,low!)||low!>Math.min(open!,close!))throw new Error('期货OHLC无效');
  return {date,open:open!,high:high!,low:low!,close:close!,volume:r.volume==null?undefined:Number(r.volume),turnover:r.turnover==null?undefined:Number(r.turnover),adjustment:'none' as const,interest:r.open_interest==null?null:Number(r.open_interest)};
 }).filter(r=>r.date<=target);
}

/** 公开数据串行获取，密钥仅由 hithinkGet 从设置表读取。 */
export async function syncFuturesDaily(pool: pg.Pool,target: string,deps: HithinkDeps = {}) {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(target))throw new Error('目标日格式无效');
 const get=async(endpoint:string,params:Record<string,string|number>={})=>hithinkGet(endpoint,
 endpoint==='/api/futures/prices/daily' ? {...params,start:Date.parse(`${target}T00:00:00+08:00`),end:Date.parse(`${target}T23:59:59+08:00`)} : params,
 {...deps,db:pool});
 const catalog:Row[]=[];
 for(let offset=0;offset<20000;offset+=1000){const page=items(await get('/api/futures/contracts/list',{limit:1000,offset}));catalog.push(...page);if(page.length<1000)break;if(offset===19000)throw new Error('合约分页超出安全上限');}
 const varieties=items(await get('/api/futures/varieties/list'));
 const mains=items(await get('/api/futures/contracts/main-list'));
 const continuous=items(await get('/api/futures/contracts/main-continuous-list'));
 const report:Row[]=[];
 const coverage=async(product:string,dataset:string,status:string,expected:number|null,written:number,latest:string|null,gaps:unknown[])=>{
 await pool.query(`INSERT INTO futures_sync_coverage(product_code,target_date,dataset,status,expected_count,written_count,latest_date,source,gaps)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(product_code,target_date,dataset) DO UPDATE SET status=EXCLUDED.status,expected_count=EXCLUDED.expected_count,written_count=EXCLUDED.written_count,latest_date=EXCLUDED.latest_date,gaps=EXCLUDED.gaps,updated_at=now()`,[product,target,dataset,status,expected,written,latest,SOURCE,JSON.stringify(gaps)]);
 };
 for(const product of FUTURES_PRODUCTS){
 const gaps:Row[]=[];
 const variety=varieties.find(r=>String(r.variety_code).toUpperCase()===product);
 const active=catalog.filter(r=>String(r.variety_code).toUpperCase()===product&&/^[A-Z]+\d{3,4}\./.test(r.thscode)&&!/(?:8888|7777|9999|00)\./.test(r.thscode)&&(!r.list_date||r.list_date<=target)&&(!r.end_date||r.end_date>=target)&&(!r.last_trade_date||r.last_trade_date>=target));
 const cont=continuous.find(r=>new RegExp(`^${product}ZL\\.`).test(r.thscode));
 const main=mains.find(r=>new RegExp(`^${product}\\d`).test(r.thscode));
 let written=0,latest:string|null=null,mainLatest:string|null=null;
 const saveContract=async(r:Row,kind:'listed'|'main_continuous',code:string)=>{
 const id=await upsertFuturesContract(pool,{code,name:r.name,exchange:r.exchange_code??variety?.exchange_code??'UNKNOWN',commodityCode:product,contractKind:kind,contractMonth:kind==='listed'?futuresMonth(r):null,multiplier:variety?.contract_multiplier??null,priceUnit:variety?.price_unit??null,lastTradeDate:r.last_trade_date??null,source:SOURCE});
 await pool.query(`UPDATE market_futures_contract SET tick_size=$2,listed_date=$3,end_date=$4,external_code=$5,trade_unit=$6,source_as_of=NULL WHERE instrument_id=$1`,[id,variety?.tick_size??null,r.list_date??null,r.end_date??null,r.thscode,variety?.trade_unit??null]);
 return id;
 };
 for(const r of active){
 try{
 const id=await saveContract(r,'listed',r.thscode);
 const bars=futuresBars(await get('/api/futures/prices/daily',{thscode:r.thscode}),target);
 if(!bars.length)throw new Error('无目标日前日线');
 await storeBars(pool,id,'futures_day',bars,SOURCE,{markIndicator:false});
 for(const bar of bars.slice(-1))await storeFuturesDailyDetail(pool,{code:r.thscode,tradeDate:bar.date,openInterest:bar.interest,source:SOURCE,rawSummary:{settlement_status:'missing',reason:'日K接口不提供结算价'}});
 const last=bars.at(-1)!.date;
 if(last> (latest??''))latest=last;
 if(last===target)written++;else gaps.push({code:r.thscode,kind:'stale',latest:last});
 }catch{gaps.push({code:r.thscode,kind:'upstream_failed_or_invalid'});}
 }
 await coverage(product,'daily',active.length>0&&written===active.length?'ok':written?'partial':'missing',active.length,written,latest,gaps);
 if(!variety)gaps.push({kind:'metadata_missing'});
 await coverage(product,'catalog',active.length&&variety?'ok':'missing',active.length,active.length,null,variety?[]:['品种资料缺失']);
 try{
 if(!cont)throw new Error('主连清单缺失');
 // 使用来源完整代码独立存储，绝不覆盖既有 CU0/LC0 的其他供应商历史。
 const id=await saveContract(cont,'main_continuous',cont.thscode);
 const bars=futuresBars(await get('/api/futures/prices/daily',{thscode:cont.thscode}),target);
 await storeBars(pool,id,'futures_day',bars,SOURCE,{markIndicator:false});
 mainLatest=bars.at(-1)?.date??null;
 if(main&&active.some(r=>r.thscode===main.thscode)&&mainLatest===target)await storeFuturesRoll(pool,{continuousCode:cont.thscode,underlyingCode:main.thscode,tradeDate:target,methodCode:'source_defined_current',source:SOURCE,rollReason:'供应商当前主力清单；算法未披露；不回填历史映射'});
 await coverage(product,'continuous',mainLatest===target?'ok':'stale',1,mainLatest===target?1:0,mainLatest,['供应商换月算法未披露；历史成分映射未覆盖']);
 }catch{gaps.push({kind:'continuous_failed'});await coverage(product,'continuous','upstream_failed',1,0,null,['主连获取或映射失败']);}
 // 仓单原值及单位缺口逐条保存，不把仓单冒充库存，不猜吨/张换算。
 try{
 if(!main)throw new Error('缺主力合约');
 const receipts=items(await get('/api/futures/warehouse-receipts/historical',{thscode:main.thscode,start_date:target,end_date:target}));
 for(const r of receipts){if(r.amount==null||!Number.isFinite(Number(r.amount)))throw new Error('仓单值无效');
 await pool.query(`INSERT INTO futures_receipt_observation(product_code,report_date,external_code,amount,amount_change,equivalent_lots,source) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(product_code,report_date,external_code,source) DO UPDATE SET amount=EXCLUDED.amount,amount_change=EXCLUDED.amount_change,equivalent_lots=EXCLUDED.equivalent_lots,fetched_at=now()`,[product,r.date,main.thscode,r.amount,r.amount_change,r.equivalent_lots,SOURCE]);}
 await coverage(product,'warehouse_warrant',receipts.length?'ok':'missing',null,receipts.length,receipts.at(-1)?.date??null,['原始数量单位未披露，不作换算']);
 }catch{await coverage(product,'warehouse_warrant','upstream_failed',null,0,null,['仓单获取失败']);}
 await coverage(product,'settlement','unsupported',active.length,0,null,['日K接口不提供结算价；未用收盘替代']);
 await coverage(product,'inventory','unsupported',null,0,null,['本接口无总库存；原铜官方周库存由独立任务保留']);
 report.push({product,expected:active.length,written,latest,continuous_latest:mainLatest,gaps});
 }
 return {target,products:report,status:report.every(r=>r.expected>0&&r.expected===r.written&&r.continuous_latest===target)?'success':'partial'};
}
