// 初始化/补齐工具：板块日线历史补齐（扶摇指数 K 线接口 → market_bar）。
//
// 使用场景：板块（industry/concept/region/special）日线历史深度不足或近期停更时，
// 一次性补齐。881/884 行业板块由 daily_data_update 日更覆盖，本脚本主要用于
// 概念/区域/特色板块的历史与停更补齐，或初始化后的首次补全。
//
// 供应商行为（实测）：单次 K 线请求的起点早于该板块的供应商最早数据日时，整个区间返回空，
// 不会裁剪。全部同花顺板块指数系列的最早可用日为 2021-09-13，因此头部缺口从该日起步，
// 起点为空时按 30 天步进探测；库存数据日期之后的区间请求必然安全（供应商最早 ≤ 库内最早）。
//
// 补齐策略（缺口感知，不整段重拉）：
//   头部缺口 [2021-09-13, 库内最早日-1]，超 3 年分段；
//   尾部缺口 [库内最新日+1, 今天]；
//   库存序列内部缺口不在此处理（板块来自日更，序列连续；如需重建用 --full）。
//
// 用法：
//   npm run market:board-backfill -- --dry-run            # 只报告缺口，不请求不写库
//   npm run market:board-backfill                         # 全部板块补齐
//   npm run market:board-backfill -- --type industry      # 只补一级行业
//   npm run market:board-backfill -- --to 2026-09-11
import { loadConfig } from "../server/config.js";
import { closePool, getPool } from "../server/db/client.js";
import { fetchAndStore } from "../server/datasource/service.js";

/** 供应商板块指数系列最早可用日（实测 881/884/概念统一自该日起） */
const HEAD_START = "2021-09-13";
/** 单次 K 线请求上限 3 年（validateKlineRequest 口径），留余量 */
const MAX_SPAN_DAYS = 365 * 3 - 5;
const PROBE_STEP_DAYS = 30;
const PROBE_MAX_ATTEMPTS = 15;

interface ParsedArgs {
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      const key = arg.slice(2, eq);
      flags.set(key, [...(flags.get(key) ?? []), arg.slice(eq + 1)]);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, [...(flags.get(key) ?? []), next]);
      i += 1;
    } else {
      flags.set(key, [...(flags.get(key) ?? []), "true"]);
    }
  }
  return { flags };
}

function one(flags: Map<string, string[]>, key: string): string | undefined {
  return flags.get(key)?.[0];
}

interface BoardRow {
  code: string;
  name: string;
  board_type: string;
  first_date: string | null;
  last_date: string | null;
  bars: number;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!) + days * 86400_000).toISOString().slice(0, 10);
}

function splitSpans(from: string, to: string): Array<{ start: string; end: string }> {
  if (from > to) return [];
  const spans: Array<{ start: string; end: string }> = [];
  let cursor = from;
  while (cursor <= to) {
    const end = addDays(cursor, MAX_SPAN_DAYS);
    const spanEnd = end < to ? end : to;
    spans.push({ start: cursor, end: spanEnd });
    cursor = addDays(spanEnd, 1);
  }
  return spans;
}

/** 头部起点探测：起点早于供应商最早数据时整段为空，按 30 天步进推进；返回首个非空请求的实际起点 */
async function probeHeadStart(
  code: string,
  from: string,
  limit: string,
): Promise<string | null> {
  let start = from;
  for (let attempt = 0; attempt < PROBE_MAX_ATTEMPTS && start <= limit; attempt += 1) {
    try {
      const outcome = await fetchAndStore(pool!, {
        code,
        freq: "day",
        start,
        end: addDays(start, PROBE_STEP_DAYS - 1) < limit ? addDays(start, PROBE_STEP_DAYS - 1) : limit,
      });
      if (outcome.rowsWritten > 0) return start;
    } catch {
      // 空响应或无数据：推进起点继续探测
    }
    start = addDays(start, PROBE_STEP_DAYS);
  }
  return null;
}

let pool: import("pg").Pool | null = null;

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const dryRun = one(parsed.flags, "dry-run") !== undefined;
  const typeFilter = one(parsed.flags, "type");
  const to = one(parsed.flags, "to") ?? new Date().toISOString().slice(0, 10);

  const { databaseUrl } = loadConfig();
  pool = getPool(databaseUrl);
  try {
    const boards = await pool.query<BoardRow>(
      `SELECT i.code, i.name, mb.board_type,
              min(b.bar_date)::text AS first_date, max(b.bar_date)::text AS last_date, count(b.*)::int AS bars
         FROM market_board mb
         JOIN market_instrument i ON i.id = mb.instrument_id
         LEFT JOIN market_bar b ON b.instrument_id = mb.instrument_id AND b.freq = 'day'
        WHERE mb.active = true AND mb.source = 'hithink'
          AND ($1::text IS NULL OR mb.board_type = $1::text)
        GROUP BY i.code, i.name, mb.board_type
        ORDER BY i.code`,
      [typeFilter ?? null],
    );
    const targets = boards.rows;
    const missing = targets.filter(
      (row) => row.first_date === null || row.first_date > HEAD_START || row.last_date === null || row.last_date < to,
    );
    const headCount = targets.filter((row) => row.first_date !== null && row.first_date > HEAD_START).length;
    const tailCount = targets.filter((row) => row.last_date !== null && row.last_date < to).length;
    console.log(
      `板块 ${targets.length} 个（type=${typeFilter ?? "all"}）；头部缺历史 ${headCount} 个，尾部停更 ${tailCount} 个。`,
    );
    if (dryRun) {
      for (const row of missing.slice(0, 30)) {
        console.log(
          `  ${row.code} ${row.name} [${row.board_type}] 现有 ${row.bars} 行（${row.first_date ?? "无"} ~ ${row.last_date ?? "无"}）`,
        );
      }
      if (missing.length > 30) console.log(`  ... 其余 ${missing.length - 30} 个略`);
      return;
    }

    let done = 0;
    let failed = 0;
    let rows = 0;
    for (const board of targets) {
      let boardRows = 0;
      let boardOk = true;
      // 头部缺口：从供应商最早可用日补到库内最早日之前。
      if (board.first_date !== null && board.first_date > HEAD_START) {
        const headEnd = addDays(board.first_date, -1);
        const started = await probeHeadStart(board.code, HEAD_START, headEnd);
        if (started !== null) {
          for (const span of splitSpans(addDays(started, PROBE_STEP_DAYS), headEnd)) {
            try {
              const outcome = await fetchAndStore(pool, {
                code: board.code, freq: "day", start: span.start, end: span.end,
              });
              boardRows += outcome.rowsWritten;
            } catch (error) {
              boardOk = false;
              console.error(`${board.code} 头部 ${span.start}~${span.end} 失败：${(error as Error).message}`);
            }
          }
        }
      }
      // 尾部缺口：库内最新日之后补到目标日。
      if (board.last_date !== null && board.last_date < to) {
        for (const span of splitSpans(addDays(board.last_date, 1), to)) {
          try {
            const outcome = await fetchAndStore(pool, {
              code: board.code, freq: "day", start: span.start, end: span.end,
            });
            boardRows += outcome.rowsWritten;
          } catch (error) {
            boardOk = false;
            console.error(`${board.code} 尾部 ${span.start}~${span.end} 失败：${(error as Error).message}`);
          }
        }
      }
      rows += boardRows;
      if (boardOk) done += 1; else failed += 1;
      if (done % 50 === 0 && done > 0) console.log(`  已处理 ${done + failed}/${targets.length} ... 累计 ${rows} 行`);
    }
    console.log(`完成：成功 ${done} 只、失败 ${failed} 只、写入 ${rows} 行。`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await closePool();
  }
}

await main();
