import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../server/config.js";
import { restorePortableInitialization } from "../server/volume/portable.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let payloadPath: string | undefined;
  let target: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--target" && argv[index + 1]) target = argv[++index];
    else if (!arg.startsWith("--") && !payloadPath) payloadPath = path.resolve(arg);
    else {
      console.error(`无法识别的参数：${arg}`);
      process.exit(2);
    }
  }
  if (!payloadPath) {
    console.error("用法：npm run portable:restore -- <固定资产包.ndjson.gz> [--target <空数据库连接串>]");
    process.exit(2);
  }
  try {
    const result = await restorePortableInitialization({
      payloadPath,
      targetUrl: target ?? loadConfig().databaseUrl,
    });
    console.log(
      `固定资产包恢复完成并对账通过：${result.payloadPath}\n` +
      `迁移上限 ${result.manifest.migration_max}，${Object.keys(result.manifest.tables).length} 张白名单表。`,
    );
  } catch (error) {
    console.error("固定资产包恢复失败：", (error as Error).message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void main();
