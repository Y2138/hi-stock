// 广期所碳酸锂仓单日报回填；写入点时因子表，未上市日期显式跳过。
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import { defaultSleep } from "../server/datasource/ratelimit.js";
import { recordCommodityFetchRun, storeMarketFactorObservation, upsertMarketFactorSeries } from "../server/datasource/commodity-service.js";
import { fetchGfexLithiumWarehouseReceipt } from "../server/datasource/gfex.js";
const args=process.argv.slice(2);const argOf=(flag:string)=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1]};
const start=argOf("--start")??"2023-07-21",end=argOf("--end")??"2026-09-15",sleepMs=Math.max(0,Number(argOf("--sleep-ms")??50));
if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||end<start)throw new Error("日期范围非法");
const pool=getPool(loadConfig().databaseUrl);let written=0,skipped=0,failed=0;const gaps:unknown[]=[];
try{
 await upsertMarketFactorSeries(pool,{seriesCode:"gfex.lc.warehouse_receipt.total",commodityCode:"LITHIUM_CARBONATE",market:"GFEX",metricCode:"warehouse_warrant",frequency:"daily",unit:"张",source:"gfex_official",revisionPolicy:"none"});
 const dates=(await pool.query<{date:string}>(`SELECT trade_date::text date FROM market_trading_day WHERE is_open=true AND trade_date BETWEEN $1 AND $2 ORDER BY trade_date`,[start,end])).rows.map(r=>r.date);
 for(const[index,date]of dates.entries()){
  try{const row=await fetchGfexLithiumWarehouseReceipt(date);if(!row){skipped++;continue}await storeMarketFactorObservation(pool,{seriesCode:"gfex.lc.warehouse_receipt.total",periodStart:date,periodEnd:date,publishedAt:`${date}T23:59:59+08:00`,value:row.quantity,sourceRef:row.sourceUrl,rawSummary:{previous_quantity:row.previousQuantity,change:row.change,point_in_time_status:"official_daily_archive_without_exact_publish_time"}});written++;}
  catch(error){failed++;gaps.push({date,reason:(error as Error).message})}
  if((index+1)%100===0)console.log(`[${index+1}/${dates.length}] 写入${written} 跳过${skipped} 失败${failed}`);
  if(sleepMs&&index+1<dates.length)await defaultSleep(sleepMs);
 }
 const id=await recordCommodityFetchRun(pool,{channel:"gfex_official",scope:{dataset:"lithium_warehouse_receipt",start,end},rowsWritten:written,gaps});
 console.log(`完成：写入${written}，跳过${skipped}，失败${failed}，market_fetch_run #${id}`);
}finally{await closePool()}
if(failed)process.exitCode=1;
