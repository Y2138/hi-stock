// 上期所真实合约日行情回填：只写PostgreSQL市场域，不输出原始响应。
import "dotenv/config";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import { defaultSleep } from "../server/datasource/ratelimit.js";
import { ShfeNotFoundError } from "../server/datasource/shfe.js";
import { syncShfeFuturesDaily } from "../server/datasource/shfe-service.js";

const args = process.argv.slice(2);
const argOf = (flag: string): string | undefined => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const start = argOf("--start");
const end = argOf("--end");
const product = (argOf("--product") ?? "CU").trim().toUpperCase();
const sleepMs = Math.max(0, Math.min(10_000, Number(argOf("--sleep-ms") ?? 200)));
if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
  console.error("用法：npm run datasource:shfe-futures-backfill -- --start YYYY-MM-DD --end YYYY-MM-DD [--product CU] [--sleep-ms 200]");
  process.exit(2);
}

const pool = getPool(loadConfig().databaseUrl);
let success = 0;
let partial = 0;
let skipped = 0;
let failed = 0;
let contracts = 0;
try {
  const dates = (await pool.query<{ trade_date: string }>(
    `SELECT trade_date::text FROM market_trading_day
      WHERE trade_date BETWEEN $1 AND $2 AND is_open=true ORDER BY trade_date`,
    [start, end],
  )).rows.map(row => row.trade_date);
  if (!dates.length) throw new Error("目标区间没有已登记交易日，请先同步交易日历");
  for (const [index, tradeDate] of dates.entries()) {
    try {
      const result = await syncShfeFuturesDaily(pool, tradeDate, product);
      contracts += result.contractCount;
      if (result.gaps.length) partial += 1; else success += 1;
      console.log(`[${index + 1}/${dates.length}] ${tradeDate}：合约${result.contractCount}，主力${result.mainContractCode ?? "无"}，缺口${result.gaps.length}`);
    } catch (error) {
      if (error instanceof ShfeNotFoundError) {
        skipped += 1;
        console.log(`[${index + 1}/${dates.length}] ${tradeDate}：上期所无文件，跳过`);
      } else {
        failed += 1;
        console.error(`[${index + 1}/${dates.length}] ${tradeDate}：失败，${(error as Error).message}`);
      }
    }
    if (sleepMs > 0 && index + 1 < dates.length) await defaultSleep(sleepMs);
  }
  console.log(`完成：success=${success} partial=${partial} skipped=${skipped} failed=${failed}，合约日记录=${contracts}`);
} finally {
  await closePool();
}
if (failed > 0) process.exitCode = 1;
