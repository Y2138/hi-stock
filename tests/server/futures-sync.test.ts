import { afterAll,afterEach,describe,expect,it,vi } from 'vitest';
const probe=vi.hoisted(()=>({mode:'normal',calls:[] as Array<Record<string,unknown>>,attempts:new Map<string,number>()}));
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
 if(endpoint.endsWith('/prices/daily')){
 probe.calls.push(params);
 if(probe.mode==='missing_once'){
 const code=String(params.thscode);const count=probe.attempts.get(code)??0;probe.attempts.set(code,count+1);if(count===0)return {item:[]};
 }
 if(probe.mode==='permanent')throw new actual.HithinkEnvelopeError(3001,'敏感鉴权或上游正文');
 if(probe.mode==='exhausted')throw new actual.HithinkEnvelopeError(5003,'敏感上游正文');
 if(probe.mode==='transient'){
 const code=String(params.thscode);const count=probe.attempts.get(code)??0;probe.attempts.set(code,count+1);
 if(count===0)throw new actual.HithinkEnvelopeError(5003,'敏感上游正文不得存库');
 }
 if(probe.mode==='invalid'&&String(params.thscode)==='CU2605.SHF')return {item:[{timestamp:Date.parse('2026-03-02T00:00:00+08:00'),open_price:10,high_price:9,low_price:8,close_price:11}]};
 // 单日窗口假空；前后相邻条目不可污染目标日，也不可因邻日非法OHLC使目标日失败。
 if(Number(params.start)>=Date.parse('2026-03-02T00:00:00+08:00'))return {item:[]};
 return {item:[{timestamp:Date.parse('2026-03-01T00:00:00+08:00'),open_price:null},{timestamp:Date.parse('2026-03-02T00:00:00+08:00'),open_price:10,high_price:12,low_price:9,close_price:11,volume:0,open_interest:0,turnover:0},{timestamp:Date.parse('2026-03-04T00:00:00+08:00'),open_price:null}]};
 }
 if(endpoint.includes('warehouse-receipts'))return {item:[{date:'2026-03-02',amount:0,amount_change:0,equivalent_lots:0}]};
 throw Error('未预期端点 '+endpoint+' '+String(params));
 }};
});
const prepared=await prepareTestDb();
describe.skipIf(!prepared)('期货同步独立库集成',()=>{
 afterAll(async()=>{await prepared?.pool.end();});
 afterEach(()=>{vi.useRealTimers();probe.mode='normal';probe.attempts.clear();probe.calls.length=0;});
 it('十三品种写入并重跑幂等，未提供的结算与库存显式列缺口',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-03-02T18:00:00+08:00'));
 const pool=prepared!.pool;
 const first=await syncFuturesDaily(pool,'2026-03-02');
 expect(first.status).toBe('success');
 expect(first.products).toHaveLength(13);
 expect(probe.calls.every(p=>Number(p.start)===Date.parse('2026-02-23T00:00:00+08:00'))).toBe(true);
 expect((await pool.query("SELECT DISTINCT bar_date::text d FROM market_bar WHERE channel='hithink_futures'")).rows).toEqual([{d:'2026-03-02'}]);
 const counts=async()=> (await pool.query(`SELECT (SELECT count(*)::int FROM market_bar WHERE channel='hithink_futures') bars,(SELECT count(*)::int FROM futures_receipt_observation) receipts,(SELECT count(*)::int FROM market_futures_roll WHERE source='hithink_futures') rolls`)).rows[0];
 const before=await counts();
 expect(before).toEqual({bars:26,receipts:13,rolls:13});
 await syncFuturesDaily(pool,'2026-03-02');
 expect(await counts()).toEqual(before);
 expect((await pool.query("SELECT count(*)::int n FROM futures_sync_coverage WHERE dataset='settlement' AND status='unsupported'")).rows[0].n).toBe(13);
 expect((await pool.query("SELECT count(*)::int n FROM futures_receipt_observation WHERE unit IS NULL AND amount=0")).rows[0].n).toBe(13);
 });
 it('上游未返回目标日不能静默成功',async()=>{
 const r=await syncFuturesDaily(prepared!.pool,'2026-03-03',{sleep:async()=>{}});
 expect(r.status).toBe('failed');
 expect(r.products.every(p=>p.written===0)).toBe(true);
 expect(r.products.every(p=>p.gaps.some((g:any)=>g.kind==='missing'&&g.stage==='fetch'))).toBe(true);
 expect(JSON.stringify(r)).not.toContain('upstream_failed_or_invalid');
 expect(probe.calls).toHaveLength(78);
 expect(probe.calls.every(p=>Number(p.end)===Date.parse('2026-03-03T23:59:59.999+08:00'))).toBe(true);
 expect((await prepared!.pool.query("SELECT count(*)::int n FROM futures_sync_coverage WHERE target_date='2026-03-03' AND dataset='daily' AND status='missing'")).rows[0].n).toBe(13);
 });
 it('目标日假空后限次补取，不存相邻日期',async()=>{
 probe.mode='missing_once';const sleep=vi.fn(async()=>{});
 const r=await syncFuturesDaily(prepared!.pool,'2026-03-02',{sleep});
 expect(r.status).toBe('success');expect(sleep).toHaveBeenCalledTimes(26);
 expect(probe.calls).toHaveLength(52);
 });
 it('目标日OHLC非法单列parse错误，不泄露上游消息',async()=>{
 probe.mode='invalid';
 const r=await syncFuturesDaily(prepared!.pool,'2026-03-02');
 expect(r.products[0]!.gaps).toContainEqual({code:'CU2605.SHF',kind:'invalid',stage:'parse'});
 });
 it('非重试业务码保留分类，全部核心失败为failed且不泄露正文',async()=>{
 probe.mode='permanent';const sleep=vi.fn(async()=>{});
 const r=await syncFuturesDaily(prepared!.pool,'2026-03-02',{sleep});
 expect(r.status).toBe('failed');expect(sleep).not.toHaveBeenCalled();
 expect(r.products[0]!.gaps).toContainEqual({code:'CU2605.SHF',kind:'upstream_failed',stage:'fetch',business_code:3001});
 expect(JSON.stringify(r)).not.toContain('敏感');
 });
 it('5003耗尽两次退避后退出，不无限重试',async()=>{
 probe.mode='exhausted';const sleep=vi.fn(async()=>{});
 const r=await syncFuturesDaily(prepared!.pool,'2026-03-02',{sleep});
 expect(r.status).toBe('failed');expect(sleep).toHaveBeenCalledTimes(52);
 expect(r.products[0]!.gaps).toContainEqual({code:'CU2605.SHF',kind:'upstream_failed',stage:'fetch',business_code:5003});
 });
 it('5003有界重试后成功，历史补跑不写当前主力为历史映射',async()=>{
 probe.mode='transient';
 const pool=prepared!.pool;
 await pool.query('DELETE FROM market_futures_roll');
 const sleep=vi.fn(async()=>{});
 const r=await syncFuturesDaily(pool,'2026-03-02',{sleep});
 expect(r.status).toBe('success');
 expect(sleep).toHaveBeenCalledTimes(26);
 expect((await pool.query('SELECT count(*)::int n FROM market_futures_roll')).rows[0].n).toBe(0);
 expect(JSON.stringify(r)).not.toContain('敏感');
 });
});
