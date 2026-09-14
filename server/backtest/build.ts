import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash } from "./contracts.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** 固定的受信任制品清单；不允许请求选择脚本路径。 */
export async function standardBuildHash(): Promise<string> {
  const files = ["server/backtest/build.ts", "server/backtest/runner.ts", "server/backtest/executor.ts", "server/backtest/runtime-contract.ts", "server/modules/backtests/runtime.ts", "server/backtest/engine.ts", "server/backtest/portfolio-engine.ts", "server/backtest/research-engine.ts", "server/backtest/short-rules.ts", "server/backtest/engine-worker.ts", "server/backtest/contracts.ts", "server/backtest/settlement.ts", "server/indicators/formulas.ts", "server/modules/plans/right-side-rule.ts", "server/modules/plans/swing-signals.ts", "package-lock.json"];
  return contentHash({node:process.versions.node,files:await Promise.all(files.map(async file => ({file, hash: contentHash(await fs.readFile(path.join(root, file), "utf8"))})))});
}
