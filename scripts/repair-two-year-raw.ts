// 两年结构反转策略原始价缺口：默认只读预览，显式 --apply 才补写已有日线的未复权 OHLC。
import { loadConfig } from "../server/config.js";
import { closePool, getPool } from "../server/db/client.js";
import { missingTwoYearRawCodes, repairTwoYearRawDaily } from "../server/datasource/service.js";

const args = process.argv.slice(2);
const date = args[args.indexOf("--date") + 1];
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
  throw new Error("必须指定合法的 --date YYYY-MM-DD");
}
if (args.some((arg) => !["--date", date, "--apply"].includes(arg))) throw new Error("只支持 --date 和 --apply");
const pool = getPool(loadConfig().databaseUrl);
try {
  const codes = await missingTwoYearRawCodes(pool, date);
  console.log(`${date}：两年结构反转合格行业成员需补未复权日线 ${codes.length} 只${args.includes("--apply") ? "" : "（预览，未写入）"}`);
  if (args.includes("--apply") && codes.length) {
    const result = await repairTwoYearRawDaily(pool, date);
    console.log(`补齐 ${result.rows} 行；失败 ${result.gaps.length} 只`);
    for (const gap of result.gaps) console.error(`${gap.code}: ${gap.reason}`);
    if (result.gaps.length) process.exitCode = 1;
  }
} finally {
  await closePool();
}
