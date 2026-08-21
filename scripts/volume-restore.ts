// CLI：恢复数据卷快照（npm run volume:restore -- <dump路径> [-- --target <连接串>] [-- --data-only]）
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §九
// 默认要求目标库为空库（不存在则自动创建）；恢复后强制校验 manifest vs 库内计数，
// 不一致列出差异并非零退出，不静默通过。
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../server/config.js";
import { restoreVolume } from "../server/volume/restore.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let dumpPath: string | undefined;
  let target: string | undefined;
  let dataOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--target" && argv[i + 1]) {
      target = argv[++i];
    } else if (arg === "--data-only") {
      dataOnly = true;
    } else if (!arg.startsWith("--") && dumpPath === undefined) {
      dumpPath = arg;
    } else {
      console.error(`无法识别的参数：${arg}`);
      process.exit(2);
    }
  }
  if (!dumpPath) {
    console.error("用法：npm run volume:restore -- <dump路径> [-- --target <连接串>] [-- --data-only]");
    process.exit(2);
  }
  const { databaseUrl } = loadConfig();
  try {
    const result = await restoreVolume({
      dumpPath: path.resolve(dumpPath),
      targetUrl: target ?? databaseUrl,
      dataOnly,
    });
    console.log(
      `恢复完成并校验通过（${result.tool.mode} 模式，${result.tool.version}）：${result.dumpPath}`,
    );
  } catch (err) {
    console.error("恢复失败：", (err as Error).message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
