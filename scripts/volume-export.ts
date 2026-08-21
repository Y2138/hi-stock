// CLI：导出数据卷快照（npm run volume:export [-- --out-dir <目录>] [-- --keep 14]）
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §九
// pg_dump 工具：优先本机（主版本须与库一致），缺失时降级 docker compose postgres 容器内工具。
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../server/config.js";
import { closePool, getPool } from "../server/db/client.js";
import { exportVolume } from "../server/volume/export.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let outDir: string | undefined;
  let keep: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--out-dir" && argv[i + 1]) {
      outDir = path.resolve(argv[++i]!);
    } else if (arg === "--keep" && argv[i + 1]) {
      keep = Number(argv[++i]);
      if (!Number.isInteger(keep) || keep <= 0) {
        console.error(`--keep 非法：${keep}`);
        process.exit(2);
      }
    } else {
      console.error(`无法识别的参数：${arg}`);
      process.exit(2);
    }
  }
  const { databaseUrl } = loadConfig();
  const pool = getPool(databaseUrl);
  try {
    const result = await exportVolume(pool, databaseUrl, { outDir, keep });
    const t = result.manifest;
    console.log(
      `数据卷已导出（${result.tool.mode} 模式，${result.tool.version}）：\n- ${result.dumpPath}\n- ${result.manifestPath}`,
    );
    console.log(
      `manifest：market_bar 共 ${t.tables["market_bar"] ?? 0} 行，` +
        Object.entries(t.market_bar_coverage)
          .map(([f, c]) => `${f} ${c.count} 行 ${c.min ?? "-"}~${c.max ?? "-"}`)
          .join("；"),
    );
    if (result.pruned > 0) console.log(`滚动清理：删除最旧 ${result.pruned} 份快照`);
  } catch (err) {
    console.error("导出失败：", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
