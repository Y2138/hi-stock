// CLI：手动补拉行情（调用 server/datasource/service.ts，不经 HTTP API）
// 用法：
//   npm run market:fetch -- --code 000636.SZ --freq day --start 2026-01-01 --end 2026-08-16 [--name 风华高科]
//   npm run market:fetch -- --code CU0 --freq futures_day --start 2026-01-01 --end 2026-08-16
//   npm run market:fetch -- --code 000636.SZ --freq 30m --start 2026-08-01 --end 2026-08-16
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §五
import { loadConfig } from "../server/config.js";
import { closePool, getPool } from "../server/db/client.js";
import { fetchAndStore } from "../server/datasource/service.js";
import type { MarketFreq } from "../server/datasource/types.js";

interface ParsedArgs {
  flags: Map<string, string[]>;
}

/** 极简参数解析：--key value 或 --key=value，可重复（与 scripts/record-task-run.ts 同款） */
function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      const key = arg.slice(2, eq);
      flags.set(key, [...(flags.get(key) ?? []), arg.slice(eq + 1)]);
    } else {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, [...(flags.get(key) ?? []), next]);
        i++;
      } else {
        flags.set(key, [...(flags.get(key) ?? []), "true"]);
      }
    }
  }
  return { flags };
}

function needOne(flags: Map<string, string[]>, key: string): string {
  const v = flags.get(key)?.[0];
  if (!v) {
    console.error(`缺少参数 --${key}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const codes = needOne(flags, "code")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const freq = needOne(flags, "freq") as MarketFreq;
  if (!["day", "30m", "futures_day"].includes(freq)) {
    console.error(`--freq 必须是 day | 30m | futures_day，收到: ${freq}`);
    process.exit(2);
  }
  const start = needOne(flags, "start");
  const end = needOne(flags, "end");
  const name = flags.get("name")?.[0];

  const { databaseUrl } = loadConfig();
  const pool = getPool(databaseUrl);
  let failed = 0;
  try {
    for (const code of codes) {
      try {
        const outcome = await fetchAndStore(pool, { code, freq, start, end }, {
          instrumentName: name,
        });
        const degraded = outcome.degradedFrom
          ? `，降级自 ${outcome.degradedFrom}`
          : "";
        console.log(
          `${code} ${freq}: 通道 ${outcome.channel}${degraded}，写入 ${outcome.rowsWritten} 行` +
            `（${outcome.firstDate} ~ ${outcome.lastDate}），market_fetch_run #${outcome.fetchRunId}`,
        );
      } catch (err) {
        failed += 1;
        console.error(`${code} ${freq} 失败: ${(err as Error).message}`);
      }
    }
  } finally {
    await closePool();
  }
  if (failed > 0) process.exitCode = 1;
}

await main();
