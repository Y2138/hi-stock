// 上期所有色金属库存周报回填：指定品种写入点时因子表。
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import { defaultSleep } from "../server/datasource/ratelimit.js";
import { ShfeNotFoundError, fetchShfeWeeklyInventory } from "../server/datasource/shfe.js";
import { recordCommodityFetchRun, storeMarketFactorObservation, upsertMarketFactorSeries } from "../server/datasource/commodity-service.js";
const args=process.argv.slice(2);const argOf=(flag:string)=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1]};
const code=(argOf("--code")??"").toUpperCase(),name=argOf("--name")??"",commodity=(argOf("--commodity")??code).toUpperCase();
const start=argOf("--start")??"2015-01-01",end=argOf("--end")??"2026-09-15",sleepMs=Math.max(0,Number(argOf("--sleep-ms")??100));
if(!/^[A-Z]{1,3}$/.test(code)||!name||!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||end<start){
 console.error("用法：npm run datasource:shfe-metal-inventory -- --code AL --name 铝 --commodity AL --start YYYY-MM-DD --end YYYY-MM-DD");process.exit(2);
}
const seriesCode=`shfe.${code.toLowerCase()}.inventory.total`,pool=getPool(loadConfig().databaseUrl);let success=0,skipped=0,failed=0;const gaps:unknown[]=[];
try{
 await upsertMarketFactorSeries(pool,{seriesCode,commodityCode:commodity,market:"SHFE",metricCode:"inventory",frequency:"weekly",unit:"吨",source:"shfe_official",revisionPolicy:"revisable"});
 const dates=(await pool.query<{date:string}>(`SELECT max(trade_date)::text date FROM market_trading_day WHERE is_open=true AND trade_date BETWEEN $1 AND $2 GROUP BY date_trunc('week',trade_date) ORDER BY date`,[start,end])).rows.map(r=>r.date);
 for(const[index,date]of dates.entries()){
  try{const row=await fetchShfeWeeklyInventory(date,code,name);await storeMarketFactorObservation(pool,{seriesCode,periodStart:new Date(Date.parse(`${date}T00:00:00Z`)-6*86400000).toISOString().slice(0,10),periodEnd:date,publishedAt:row.publishedAt,value:row.inventory,sourceRef:row.sourceUrl,rawSummary:{previous_inventory:row.previousInventory,warehouse_warrant:row.warehouseWarrant,previous_warehouse_warrant:row.previousWarehouseWarrant,...row.rawSummary}});success++;}
  catch(error){if(error instanceof ShfeNotFoundError)skipped++;else{failed++;gaps.push({date,reason:(error as Error).message})}}
  if((index+1)%100===0)console.log(`[${index+1}/${dates.length}] success=${success} skipped=${skipped} failed=${failed}`);
  if(sleepMs&&index+1<dates.length)await defaultSleep(sleepMs);
 }
 const run=await recordCommodityFetchRun(pool,{channel:"shfe_official",scope:{dataset:"weekly_inventory",product:code,start,end},rowsWritten:success,gaps});
 console.log(`完成：${seriesCode} success=${success} skipped=${skipped} failed=${failed} market_fetch_run #${run}`);
}finally{await closePool()}
if(failed)process.exitCode=1;
