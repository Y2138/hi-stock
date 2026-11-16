import type pg from 'pg';
import { apiErrors } from '../../http/router.js';
export const futuresRoutes={
 async list({pool}: {pool:pg.Pool}) {
 const rows=await pool.query(`SELECT c.*,i.code,i.name,
 (SELECT max(bar_date)::text FROM market_bar b WHERE b.instrument_id=i.id AND freq='futures_day') latest_date
 FROM market_futures_contract c JOIN market_instrument i ON i.id=c.instrument_id ORDER BY c.commodity_code,c.contract_kind,i.code`);
 const coverage=await pool.query(`SELECT *,target_date::text AS target_date,latest_date::text AS latest_date FROM futures_sync_coverage WHERE target_date=(SELECT max(target_date) FROM futures_sync_coverage) ORDER BY product_code,dataset`);
 return {data:{contracts:rows.rows,coverage:coverage.rows}};
 },
 async detail({pool,params,query}: {pool:pg.Pool;params:Record<string,string>;query:URLSearchParams}) {
 const code=params.code!;
 const limit=Number(query.get('limit')??'100');
 if(!Number.isInteger(limit)||limit<1||limit>1000)throw apiErrors.badRequest('limit须为1–1000');
 const instrument=(await pool.query('SELECT id::text,code,name FROM market_instrument WHERE code=$1 AND kind=\'futures\'',[code])).rows[0];
 if(!instrument)throw apiErrors.notFound('期货标的不存在');
 const bars=await pool.query(`SELECT b.bar_date::text,b.open,b.high,b.low,b.close,b.volume,b.turnover,b.adjustment,b.channel,b.fetched_at,d.settlement,d.prev_settlement,d.open_interest
 FROM market_bar b LEFT JOIN market_futures_daily_detail d ON d.instrument_id=b.instrument_id AND d.trade_date=b.bar_date
 WHERE b.instrument_id=$1 AND b.freq='futures_day' ORDER BY b.bar_date DESC LIMIT $2`,[instrument.id,limit]);
 const mapping=await pool.query(`SELECT r.*,i.code underlying_code FROM market_futures_roll r JOIN market_instrument i ON i.id=r.underlying_instrument_id WHERE r.continuous_instrument_id=$1 ORDER BY trade_date DESC LIMIT $2`,[instrument.id,limit]);
 const receipts=await pool.query(`SELECT * FROM futures_receipt_observation WHERE external_code=$1 ORDER BY report_date DESC LIMIT $2`,[code,limit]);
 return {data:{instrument,bars:bars.rows,mapping:mapping.rows,receipts:receipts.rows}};
 }
};
