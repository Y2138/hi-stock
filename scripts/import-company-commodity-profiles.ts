// 公司商品业务角色导入：输入文件是运行数据，导入后可删除，不进入Git固定资产。
import fs from "node:fs/promises";
import path from "node:path";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import { storeCompanyCommodityProfile, type CompanyCommodityProfileInput } from "../server/datasource/commodity-service.js";

const args = process.argv.slice(2);
const index = args.indexOf("--input");
const inputPath = index >= 0 ? args[index + 1] : undefined;
if (!inputPath) {
  console.error("用法：npm run datasource:company-commodity-profiles -- --input <profiles.json>");
  process.exit(2);
}
const resolved = path.resolve(inputPath);
const parsed = JSON.parse(await fs.readFile(resolved, "utf8")) as unknown;
if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 500) throw new Error("输入必须是1-500条公司商品角色数组");

const pool = getPool(loadConfig().databaseUrl);
let success = 0;
let failed = 0;
try {
  for (const [rowIndex, row] of parsed.entries()) {
    try {
      const input = row as CompanyCommodityProfileInput;
      await storeCompanyCommodityProfile(pool, input);
      success += 1;
      console.log(`[${rowIndex + 1}/${parsed.length}] ${input.code} ${input.commodityCode} ${input.role}`);
    } catch (error) {
      failed += 1;
      console.error(`[${rowIndex + 1}/${parsed.length}] 导入失败：${(error as Error).message}`);
    }
  }
  console.log(`完成：success=${success} failed=${failed}，来源文件=${resolved}`);
} finally {
  await closePool();
}
if (failed > 0) process.exitCode = 1;
