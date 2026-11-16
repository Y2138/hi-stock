import { afterAll,describe,expect,it } from 'vitest';
import { prepareTestDb,startTestServer,api } from './helpers.js';
const prepared=await prepareTestDb();
describe.skipIf(!prepared)('行情只读API成交量单位透传',()=>{
 afterAll(async()=>{await prepared?.pool.end();});
 it('保留数据库单位与NULL，不根据代码或数值推断',async()=>{
 const pool=prepared!.pool;
 const id=(await pool.query("INSERT INTO market_instrument(code,name,kind) VALUES('990991.SZ','单位合成样本','stock') RETURNING id")).rows[0].id;
 await pool.query(`INSERT INTO market_bar(instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,volume_unit,channel)
 VALUES($1,'day','2026-03-02','2026-03-02T00:00:00Z',10,11,9,10,100,'股','test'),
 ($1,'day','2026-03-03','2026-03-03T00:00:00Z',10,11,9,10,100,NULL,'test')`,[id]);
 const server=await startTestServer(pool);
 try{
 const r=await api(server.baseUrl,'GET','/api/market/bars?code=990991.SZ&start=2026-03-02&end=2026-03-03&stored_only=true');
 expect(r.status).toBe(200);
 expect(r.json).toMatchObject({data_source:'stored',bars:[{volume_unit:'股'},{volume_unit:null}]});
 }finally{await server.close();}
 });
});
