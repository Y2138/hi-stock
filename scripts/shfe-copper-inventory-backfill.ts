// 上期所铜总库存周报回填：按每周最后一个开市日尝试官方周报，只写点时因子表。
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import { defaultSleep } from "../server/datasource/ratelimit.js";
import { ShfeNotFoundError } from "../server/datasource/shfe.js";
import { syncShfeCopperWeeklyInventory } from "../server/datasource/shfe-service.js";

const args = process.argv.slice(2);
const argOf = (flag: string): string | undefined => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const start = argOf("--start");
const end = argOf("--end");
const sleepMs = Math.max(0, Math.min(10_000, Number(argOf("--sleep-ms") ?? 200)));
if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
  console.error("用法：npm run datasource:shfe-copper-inventory-backfill -- --start YYYY-MM-DD --end YYYY-MM-DD [--sleep-ms 200]");
  process.exit(2);
}

const pool = getPool(loadConfig().databaseUrl);
let success = 0;
let skipped = 0;
let failed = 0;
try {
  const dates = (await pool.query<{ report_date: string }>(
    `SELECT max(trade_date)::text AS report_date
       FROM market_trading_day
      WHERE trade_date BETWEEN $1 AND $2 AND is_open=true
      GROUP BY date_trunc('week', trade_date)
      ORDER BY report_date`,
    [start, end],
  )).rows.map(row => row.report_date);
  if (!dates.length) throw new Error("目标区间没有已登记交易日，请先同步交易日历");
  for (const [index, reportDate] of dates.entries()) {
    try {
      const result = await syncShfeCopperWeeklyInventory(pool, reportDate);
      success += 1;
      console.log(`[${index + 1}/${dates.length}] ${reportDate}：库存${result.inventory}吨，上周${result.previousInventory}吨`);
    } catch (error) {
      if (error instanceof ShfeNotFoundError) {
        skipped += 1;
        console.log(`[${index + 1}/${dates.length}] ${reportDate}：上期所无周报，跳过`);
      } else {
        failed += 1;
        console.error(`[${index + 1}/${dates.length}] ${reportDate}：失败，${(error as Error).message}`);
      }
    }
    if (sleepMs > 0 && index + 1 < dates.length) await defaultSleep(sleepMs);
  }
  console.log(`完成：success=${success} skipped=${skipped} failed=${failed}`);
} finally {
  await closePool();
}
if (failed > 0) process.exitCode = 1;
