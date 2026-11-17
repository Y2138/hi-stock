import {afterAll,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({auction:vi.fn(),snapshot:vi.fn()}));
vi.mock('../../server/datasource/hithink-datasets.js',async original=>({...await original<typeof import('../../server/datasource/hithink-datasets.js')>(),fetchHithinkDataset:mocks.auction}));
vi.mock('../../server/datasource/hithink.js',async original=>({...await original<typeof import('../../server/datasource/hithink.js')>(),fetchSnapshot:mocks.snapshot}));
import {prepareTestDb} from './helpers.js';
import {observationKind,observationStatus,sampleResearchObservations,readResearchObservations} from '../../server/modules/market/research-observation.js';

describe('研究观察采样窗口与来源校验',()=>{
 it('09:25只取终态竞价，盘中快照不能冒充竞价',()=>{
 expect(observationKind(new Date('2026-03-02T09:25:20+08:00'))).toBe('auction_final');
 expect(observationKind(new Date('2026-03-02T09:26:00+08:00'))).toBeNull();
 expect(observationKind(new Date('2026-03-02T13:10:00+08:00'))).toBe('intraday');
 expect(observationStatus('auction_final',new Date('2026-03-02T09:25:30+08:00'),new Date('2026-03-02T09:24:59+08:00'),10)).toBe('stale');
 expect(observationStatus('auction_final',new Date('2026-03-02T09:25:30+08:00'),null,10)).toBe('missing');
 });
});
const prepared=await prepareTestDb();
describe.skipIf(!prepared)('仅观察订阅独立库隔离验证',()=>{
 afterAll(async()=>{await prepared?.pool.end();});
 it('八只竞价采集无池候选通知副作用，未订阅不出数据',async()=>{
 const pool=prepared!.pool;
 const codes=['600362.SH','000878.SZ','601899.SH','600547.SH','600489.SH','600938.SH','601857.SH','601808.SH'];
 for(const code of codes){await pool.query("INSERT INTO market_instrument(code,name,kind) VALUES($1,'观察测试','stock') ON CONFLICT(code) DO NOTHING",[code]);await pool.query('INSERT INTO research_observation_subscription(code) VALUES($1) ON CONFLICT DO NOTHING',[code]);}
 await pool.query("INSERT INTO market_trading_day(trade_date,is_open,source) VALUES('2026-03-02',true,'test'),('2026-02-27',true,'test') ON CONFLICT(trade_date) DO NOTHING");
 const now=new Date('2026-03-02T09:25:20+08:00');
 mocks.auction.mockResolvedValue({sourceTimestampMs:Date.parse('2026-03-02T09:25:00+08:00'),payload:{item:codes.map(thscode=>({thscode,auction_price:10}))}});
 const snapshot=async()=>{const out:Record<string,unknown>={};for(const t of ['pool_membership','pool_attention_entry','ultra_short_watchlist','notification_delivery','email_delivery'])out[t]=(await pool.query(`SELECT * FROM ${t} ORDER BY 1`)).rows;return out;};
 const before=await snapshot();
 await sampleResearchObservations(pool,now);
 await sampleResearchObservations(pool,now);
 expect((await pool.query("SELECT count(*)::int n FROM research_observation_sample WHERE trade_date='2026-03-02'")).rows[0].n).toBe(8);
 expect(await snapshot()).toEqual(before);
 expect(mocks.snapshot).not.toHaveBeenCalled();
 const read=await readResearchObservations(pool,[...codes.slice(0,7),'990999.SZ'],'2026-03-02');
 expect(read.items).toHaveLength(7);
 expect(read.items.every(x=>x.auction_final.data_status==='ready')).toBe(true);
 expect(read.data_source).toBe('stored');
 });
 it('未采到或上游失败明确缺失，不借用普通快照',async()=>{
 const pool=prepared!.pool;
 await pool.query("INSERT INTO market_trading_day(trade_date,is_open,source) VALUES('2026-03-03',true,'test') ON CONFLICT DO NOTHING");
 mocks.auction.mockRejectedValue(Error('上游失败'));
 await sampleResearchObservations(pool,new Date('2026-03-03T09:25:20+08:00'));
 const read=await readResearchObservations(pool,['600362.SH'],'2026-03-03');
 expect(read.items[0]!.auction_final.data_status).toBe('missing');
 expect(mocks.snapshot).not.toHaveBeenCalled();
 });
});
