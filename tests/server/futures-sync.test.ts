import { afterAll,describe,expect,it,vi } from 'vitest';
import { prepareTestDb } from './helpers.js';
import { FUTURES_PRODUCTS,syncFuturesDaily } from '../../server/datasource/futures-service.js';
vi.mock('../../server/datasource/hithink.js',async importOriginal=>{
 const actual=await importOriginal<typeof import('../../server/datasource/hithink.js')>();
 return {...actual,hithinkGet:async(endpoint:string,params:Record<string,unknown>)=>{
 const catalog=FUTURES_PRODUCTS.map(p=>({thscode:`${p}2605.SHF`,variety_code:p,name:`测试${p}`,exchange_code:'SHFE',list_date:'2026-01-01',last_trade_date:'2026-05-15'}));
 if(endpoint.endsWith('/contracts/list'))return {item:catalog};
 if(endpoint.endsWith('/varieties/list'))return {item:FUTURES_PRODUCTS.map(p=>({variety_code:p,contract_multiplier:1,tick_size:1,price_unit:'测试单位',trade_unit:'测试单位/手'}))};
 if(endpoint.endsWith('/main-list'))return {item:catalog};
 if(endpoint.endsWith('/main-continuous-list'))return {item:catalog.map(x=>({...x,thscode:`${x.variety_code}ZL.SHF`}))};
 if(endpoint.endsWith('/prices/daily'))return {item:[{timestamp:Date.parse('2026-03-02T00:00:00+08:00'),open_price:10,high_price:12,low_price:9,close_price:11,volume:0,open_interest:0,turnover:0}]};
 if(endpoint.includes('warehouse-receipts'))return {item:[{date:'2026-03-02',amount:0,amount_change:0,equivalent_lots:0}]};
 throw Error('未预期端点 '+endpoint+' '+String(params));
 }};
});
const prepared=await prepareTestDb();
describe.skipIf(!prepared)('期货同步独立库集成',()=>{
 afterAll(async()=>{await prepared?.pool.end();});
 it('十三品种写入并重跑幂等，未提供的结算与库存显式列缺口',async()=>{
 const pool=prepared!.pool;
 const first=await syncFuturesDaily(pool,'2026-03-02');
 expect(first.status).toBe('success');
 expect(first.products).toHaveLength(13);
 const counts=async()=> (await pool.query(`SELECT (SELECT count(*)::int FROM market_bar WHERE channel='hithink_futures') bars,(SELECT count(*)::int FROM futures_receipt_observation) receipts,(SELECT count(*)::int FROM market_futures_roll WHERE source='hithink_futures') rolls`)).rows[0];
 const before=await counts();
 expect(before).toEqual({bars:26,receipts:13,rolls:13});
 await syncFuturesDaily(pool,'2026-03-02');
 expect(await counts()).toEqual(before);
 expect((await pool.query("SELECT count(*)::int n FROM futures_sync_coverage WHERE dataset='settlement' AND status='unsupported'")).rows[0].n).toBe(13);
 expect((await pool.query("SELECT count(*)::int n FROM futures_receipt_observation WHERE unit IS NULL AND amount=0")).rows[0].n).toBe(13);
 });
 it('上游未返回目标日不能静默成功',async()=>{
 const r=await syncFuturesDaily(prepared!.pool,'2026-03-03');
 expect(r.status).toBe('partial');
 expect(r.products.every(p=>p.written===0)).toBe(true);
 expect((await prepared!.pool.query("SELECT count(*)::int n FROM futures_sync_coverage WHERE target_date='2026-03-03' AND dataset='daily' AND status='missing'")).rows[0].n).toBe(13);
 });
});
