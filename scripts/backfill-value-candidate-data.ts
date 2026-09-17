// 价值候选集当前财务/估值补齐：只通过 datasource service 写 PostgreSQL。
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import { fetchFinancialAndStore } from "../server/datasource/service.js";

const file=process.argv[2]??path.resolve("支撑/tmp/候选集确认/价值候选集确认.json");
const input=JSON.parse(fs.readFileSync(file,"utf8")) as {union:string[]};
const pool=getPool(loadConfig().databaseUrl);
const {rows}=await pool.query<{code:string}>(`SELECT i.code FROM market_instrument i
 WHERE i.code=ANY($1::text[]) AND i.kind='stock'
   AND (NOT EXISTS(SELECT 1 FROM fundamental_snapshot f WHERE f.instrument_id=i.id AND f.source='hithink')
     OR NOT EXISTS(SELECT 1 FROM valuation_snapshot v WHERE v.instrument_id=i.id AND v.source='hithink'))
 ORDER BY i.code`,[input.union]);
console.log(`候选集${input.union.length}只，待补${rows.length}只。`);
let success=0,partial=0,failed=0,written=0;
for(const [index,row] of rows.entries()){
 try{const result=await fetchFinancialAndStore(pool,{code:row.code});written+=result.rowsWritten;if(result.status==="success")success++;else partial++;console.log(`[${index+1}/${rows.length}] ${row.code} ${result.status} rows=${result.rowsWritten}`);}
 catch(error){failed++;console.error(`[${index+1}/${rows.length}] ${row.code} failed: ${(error as Error).message}`);}
}
console.log(`完成 success=${success} partial=${partial} failed=${failed} rows=${written}`);
await closePool();
