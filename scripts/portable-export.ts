import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../server/config.js";
import { closePool, getPool } from "../server/db/client.js";
import { exportPortableInitialization } from "../server/volume/portable.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let outDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out-dir" && argv[index + 1]) outDir = path.resolve(argv[++index]!);
    else {
      console.error(`无法识别的参数：${argv[index]}`);
      process.exit(2);
    }
  }
  const { databaseUrl } = loadConfig();
  const pool = getPool(databaseUrl);
  try {
    const result = await exportPortableInitialization(pool, { outDir });
    console.log(`可移植固定资产包已导出：\n- ${result.payloadPath}\n- ${result.manifestPath}`);
    console.log(
      `迁移上限 ${result.manifest.migration_max}；策略版本 ${result.manifest.strategy_hashes.length}；` +
      `定时任务 ${result.manifest.tables.job_definition ?? 0}；提示词版本 ${result.manifest.prompt_hashes.length}。`,
    );
    console.log("已强制排除密钥、个人数据和运行历史。正式提交前仍应审阅策略与提示词正文。");
  } catch (error) {
    console.error("固定资产包导出失败：", (error as Error).message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void main();
