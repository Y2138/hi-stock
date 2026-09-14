// 初始化工具：全市场多年日线首次引入（扶摇批量导出 DuckDB → PostgreSQL market_bar）。
//
// 使用场景仅限「初始化部署」：空库或首次接入时把全市场历史日线一次性灌入；
// 日常增量不跑本脚本，由系统既有的日线更新链路负责（定时任务 daily_data_update 覆盖
// 持仓、标的池、核心指数与行业板块；个别标的用 `npm run market:fetch` 补拉）。
// 因此本脚本不是定期同步器，重复执行会整表重写同一锚点下的历史，只在重建口径时使用。
//
// market_bar 同一行并列保存两套价格：
//   - open/high/low/close：前复权等口径，生产信号使用；新标的由本脚本按固定锚点计算写入，
//     已存在的标的默认保留原值（--recompute-forward 可整体重算）。
//   - open_raw/high_raw/low_raw/close_raw：原始成交价，恒为未复权；prev_close：交易所前收盘（涨跌停基准）。
// 复权口径与生产一致的推导见 server/datasource/adjustment.ts。
//
// 用法：
//   npm run market:backfill -- --source duckdb                       # 从扶摇 CLI 本地库导出并回填
//   npm run market:backfill -- --from /tmp/export --anchor 2026-09-11
//   npm run market:backfill -- --from /tmp/export --recompute-forward # 连前复权一起重算
//   npm run market:backfill -- --from /tmp/export --dry-run           # 只报告不写库
//   npm run market:backfill -- --from /tmp/export --force             # 已有回填数据时仍执行
//
// 前置：--source duckdb 时需已安装并登录 hithink-finance CLI，且已执行 `data init` 建立本地库。
// 设计要求：幂等（按主键 upsert）；失败留缺口不造零值；不修改已存在的的前复权值（除非显式要求）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { loadConfig } from "../server/config.js";
import { closePool, getPool } from "../server/db/client.js";
import { computeForwardCloses, computeOfficialPrevCloses, type AdjustmentEvent } from "../server/datasource/adjustment.js";

const BACKFILL_CHANNEL = "hithink_dump";
const BATCH_ROWS = 2000;

interface ParsedArgs {
  flags: Map<string, string[]>;
}

/** 极简参数解析：--key value 或 --key=value，可重复（与 scripts/fetch-market.ts 同款） */
function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
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
        i += 1;
      } else {
        flags.set(key, [...(flags.get(key) ?? []), "true"]);
      }
    }
  }
  return { flags };
}

function flagValue(parsed: ParsedArgs, key: string): string | undefined {
  return parsed.flags.get(key)?.[0];
}

function hasFlag(parsed: ParsedArgs, key: string): boolean {
  const raw = parsed.flags.get(key)?.[0];
  if (raw === undefined) return false;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

/** 运行扶摇 CLI 导出只读 SQL 到 CSV；CLI 缺失或失败时抛错，不静默降级。 */
function runCliExport(cli: string, sql: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      cli,
      ["db", "export", "--sql", sql, "--output", output, "--file-format", "csv", "--format", "json"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", (error) => reject(new Error(`无法执行 ${cli}：${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${cli} 导出失败（退出码 ${code}）：${stderr.trim() || stdout.trim()}`));
      try {
        const envelope = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
        if (envelope.ok !== true) return reject(new Error(`${cli} 导出信封不是 ok=true：${stdout.trim()}`));
      } catch {
        // 信封解析失败不阻断：文件是否可用由后续读取判断
      }
      resolve();
    });
  });
}

interface RawRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  prevClose: number | null;
  volume: number | null;
  amount: number | null;
}

interface CodeGroup {
  code: string;
  rows: RawRow[];
}

/**
 * 流式按 thscode 分组读取导出 CSV（要求 SQL 已 ORDER BY thscode, date）。
 * 逐组回调，避免把全市场多年数据一次性载入内存。
 */
async function forEachCodeGroup(
  csvPath: string,
  onGroup: (group: CodeGroup) => Promise<void>,
): Promise<void> {
  const stream = fs.createReadStream(csvPath, { encoding: "utf8" });
  let buffer = "";
  let header: string[] | null = null;
  let current: CodeGroup | null = null;
  let index: Record<string, number> = {};

  const flush = async () => {
    if (current && current.rows.length > 0) await onGroup(current);
    current = null;
  };

  const handleLine = async (line: string) => {
    if (!line) return;
    if (header === null) {
      header = line.split(",");
      index = Object.fromEntries(header.map((name, i) => [name, i]));
      return;
    }
    const cells = line.split(",");
    const code = cells[index.code!]!;
    if (!current || current.code !== code) {
      await flush();
      current = { code, rows: [] };
    }
    const num = (name: string): number | null => {
      const raw = cells[index[name]!];
      const value = raw === undefined || raw === "" || raw === "null" ? null : Number(raw);
      return value !== null && Number.isFinite(value) ? value : null;
    };
    current.rows.push({
      date: cells[index.date!]!,
      open: num("open")!,
      high: num("high")!,
      low: num("low")!,
      close: num("close")!,
      prevClose: num("prev_close"),
      volume: num("volume"),
      amount: num("amount"),
    });
  };

  for await (const chunk of stream) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      await handleLine(line);
      newline = buffer.indexOf("\n");
    }
  }
  await handleLine(buffer.replace(/\r$/, ""));
  await flush();
}

/** 读取复权事件 CSV（code, ex_date, dividend_per_share, per_share_bonus, rights_ratio, rights_price） */
function readEvents(csvPath: string): Map<string, AdjustmentEvent[]> {
  const events = new Map<string, AdjustmentEvent[]>();
  const lines = fs.readFileSync(csvPath, "utf8").split("\n");
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!.replace(/\r$/, "");
    if (!line) continue;
    const [code, ex_date, dividend, bonus, rights, rightsPrice] = line.split(",");
    if (!code || !ex_date) continue;
    const list = events.get(code) ?? [];
    list.push({
      ex_date,
      dividend: Number(dividend) || 0,
      bonus: Number(bonus) || 0,
      rights_ratio: Number(rights) || 0,
      rights_price: Number(rightsPrice) || 0,
    });
    events.set(code, list);
  }
  return events;
}

/** 解析 export 目录或 duckdb 导出，返回两个 CSV 路径 */
async function resolveSources(parsed: ParsedArgs): Promise<{ rawCsv: string; eventsCsv: string; anchor: string }> {
  const from = flagValue(parsed, "from");
  const anchorFlag = flagValue(parsed, "anchor");
  if (from) {
    const rawCsv = path.join(from, "raw.csv");
    const eventsCsv = path.join(from, "events.csv");
    if (!fs.existsSync(rawCsv)) throw new Error(`--from 目录缺少 raw.csv：${rawCsv}`);
    if (!fs.existsSync(eventsCsv)) throw new Error(`--from 目录缺少 events.csv：${eventsCsv}`);
    if (!anchorFlag) throw new Error("使用 --from 时必须显式提供 --anchor YYYY-MM-DD");
    return { rawCsv, eventsCsv, anchor: anchorFlag };
  }

  const cli = flagValue(parsed, "cli") ?? process.env.HITHINK_FINANCE_CLI ?? "hithink-finance";
  const outDir = flagValue(parsed, "out") ?? fs.mkdtempSync(path.join(os.tmpdir(), "market-backfill-"));
  fs.mkdirSync(outDir, { recursive: true });
  const rawCsv = path.join(outDir, "raw.csv");
  const eventsCsv = path.join(outDir, "events.csv");
  console.log(`从扶摇 CLI 本地库导出到 ${outDir} ...`);
  await runCliExport(
    cli,
    "select thscode as code, date, open, high, low, close, prev_close, volume, amount " +
      "from raw_kline_daily order by thscode, date",
    rawCsv,
  );
  await runCliExport(
    cli,
    "select thscode as code, ex_date, dividend_per_share, per_share_bonus, rights_ratio, rights_price " +
      "from stg_adjustment_events order by thscode, ex_date",
    eventsCsv,
  );
  const anchor = anchorFlag
    ?? (await latestRawDate(cli));
  if (!anchor) throw new Error("无法确定锚点日期，请显式提供 --anchor YYYY-MM-DD");
  return { rawCsv, eventsCsv, anchor };
}

async function latestRawDate(cli: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cli, ["db", "query", "--sql", "select max(date)::varchar as d from raw_kline_daily", "--format", "json"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("close", () => {
      try {
        const envelope = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
        resolve(envelope?.data?.[0]?.d ?? null);
      } catch {
        resolve(null);
      }
    });
    child.on("error", () => resolve(null));
  });
}

async function ensureInstrumentId(pool: pg.Pool, code: string): Promise<string> {
  const existing = await pool.query<{ id: string }>("SELECT id::text FROM market_instrument WHERE code = $1", [code]);
  if (existing.rows[0]) return existing.rows[0].id;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO market_instrument (code, name, kind, ticker, exchange, source_asset_type, lifecycle_status)
     VALUES ($1, $1, 'stock', split_part($1,'.',1),
             CASE upper(split_part($1,'.',2)) WHEN 'SH' THEN 'SH' WHEN 'SZ' THEN 'SZ' WHEN 'BJ' THEN 'BJ' ELSE NULL END,
             'a-share', 'active')
     ON CONFLICT (code) DO NOTHING RETURNING id::text`,
    [code],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const again = await pool.query<{ id: string }>("SELECT id::text FROM market_instrument WHERE code = $1", [code]);
  if (!again.rows[0]) throw new Error(`instrument 登记异常：${code}`);
  return again.rows[0].id;
}

async function writeGroup(
  pool: pg.Pool,
  group: CodeGroup,
  events: AdjustmentEvent[],
  anchor: string,
  recomputeForward: boolean,
): Promise<void> {
  const instrumentId = await ensureInstrumentId(pool, group.code);
  const valid = group.rows.filter((row) =>
    [row.open, row.high, row.low, row.close].every((v) => Number.isFinite(v) && v > 0));
  if (valid.length === 0) return;
  const forward = computeForwardCloses(
    valid.map((row) => ({ date: row.date, close: row.close })),
    events,
    anchor,
  );
  const prevCloseByDate = computeOfficialPrevCloses(
    valid.map((row) => ({ date: row.date, close: row.close })),
    events,
  );

  for (let offset = 0; offset < valid.length; offset += BATCH_ROWS) {
    const batch = valid.slice(offset, offset + BATCH_ROWS);
    const batchPrev = batch.map((row) => prevCloseByDate.get(row.date) ?? null);
    const dates = batch.map((row) => row.date);
    const times = batch.map((row) => `${row.date}T00:00:00Z`);
    const opens = batch.map((row) => row.open);
    const highs = batch.map((row) => row.high);
    const lows = batch.map((row) => row.low);
    const closes = batch.map((row) => row.close);
    const fCloses = batch.map((row) => forward.get(row.date) ?? row.close);
    const prevCloses = batchPrev;
    const volumes = batch.map((row) => row.volume);
    const amounts = batch.map((row) => row.amount);
    // 前复权按比例缩放到 OHLC（仅收盘价有精确口径，其余按同比例缩放，保证 K 线形态一致）
    const ratios = batch.map((row) => {
      const f = forward.get(row.date);
      return f === undefined || row.close === 0 ? 1 : f / row.close;
    });
    const fOpens = batch.map((row, i) => Math.round(row.open * ratios[i]! * 1e6) / 1e6);
    const fHighs = batch.map((row, i) => Math.round(row.high * ratios[i]! * 1e6) / 1e6);
    const fLows = batch.map((row, i) => Math.round(row.low * ratios[i]! * 1e6) / 1e6);

    await pool.query(
      `INSERT INTO market_bar
         (instrument_id, freq, bar_date, bar_time, open, high, low, close,
          open_raw, high_raw, low_raw, close_raw, prev_close,
          volume, turnover, adjustment, volume_unit, channel)
       SELECT $1, 'day', d, t, o, h, l, c, orw, hrw, lrw, crw, pcrw, v, amt, 'forward', '股', $2
       FROM unnest(
         $3::date[], $4::timestamptz[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[],
         $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[],
         $14::numeric[], $15::numeric[]
       ) AS u(d, t, o, h, l, c, orw, hrw, lrw, crw, pcrw, v, amt)
       ON CONFLICT (instrument_id, freq, bar_date, bar_time) DO UPDATE SET
         open_raw = EXCLUDED.open_raw, high_raw = EXCLUDED.high_raw,
         low_raw = EXCLUDED.low_raw, close_raw = EXCLUDED.close_raw,
         prev_close = EXCLUDED.prev_close,
         open = CASE WHEN $16 THEN EXCLUDED.open ELSE market_bar.open END,
         high = CASE WHEN $16 THEN EXCLUDED.high ELSE market_bar.high END,
         low = CASE WHEN $16 THEN EXCLUDED.low ELSE market_bar.low END,
         close = CASE WHEN $16 THEN EXCLUDED.close ELSE market_bar.close END,
         volume = COALESCE(market_bar.volume, EXCLUDED.volume),
         turnover = COALESCE(market_bar.turnover, EXCLUDED.turnover),
         adjustment = CASE WHEN $16 THEN EXCLUDED.adjustment ELSE COALESCE(market_bar.adjustment, EXCLUDED.adjustment) END,
         volume_unit = CASE
           WHEN COALESCE(btrim(market_bar.volume_unit), '') = '' THEN EXCLUDED.volume_unit
           ELSE market_bar.volume_unit
         END,
         channel = CASE WHEN $16 THEN EXCLUDED.channel ELSE market_bar.channel END,
         fetched_at = now()`,
      [
        instrumentId, BACKFILL_CHANNEL,
        dates, times, fOpens, fHighs, fLows, fCloses,
        opens, highs, lows, closes, prevCloses, volumes, amounts,
        recomputeForward,
      ],
    );
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const dryRun = hasFlag(parsed, "dry-run");
  const recomputeForward = hasFlag(parsed, "recompute-forward");
  const limit = flagValue(parsed, "limit") ? Number(flagValue(parsed, "limit")) : null;
  const { rawCsv, eventsCsv, anchor } = await resolveSources(parsed);
  const events = readEvents(eventsCsv);
  console.log(`锚点 ${anchor}；复权事件 ${events.size} 只标的；前复权${recomputeForward ? "重算" : "保留现有值"}。`);

  if (dryRun) {
    let codes = 0;
    let rows = 0;
    await forEachCodeGroup(rawCsv, async (group) => {
      codes += 1;
      rows += group.rows.length;
    });
    console.log(`[dry-run] 将处理 ${codes} 只标的、${rows} 行；未写库。`);
    return;
  }

  const { databaseUrl } = loadConfig();
  const pool = getPool(databaseUrl);

  // 初始化语义：已有批量回填数据时默认拒绝，避免把初始化工具误用成定期同步器。
  if (!hasFlag(parsed, "force")) {
    const existing = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM market_bar WHERE channel = $1",
      [BACKFILL_CHANNEL],
    );
    const found = existing.rows[0]?.n ?? 0;
    if (found > 0) {
      await closePool();
      console.error(
        `已存在 ${found} 行批量回填数据（channel=${BACKFILL_CHANNEL}）。` +
          "本脚本仅用于初始化部署；日常增量请使用 daily_data_update 定时任务或 npm run market:fetch。" +
          "确需按新锚点重建历史口径时加 --force。",
      );
      process.exitCode = 1;
      return;
    }
  }

  let codes = 0;
  let rows = 0;
  let failed = 0;
  try {
    await forEachCodeGroup(rawCsv, async (group) => {
      if (limit !== null && codes >= limit) return;
      try {
        await writeGroup(pool, group, events.get(group.code) ?? [], anchor, recomputeForward);
        codes += 1;
        rows += group.rows.length;
        if (codes % 200 === 0) console.log(`  已写入 ${codes} 只 / ${rows} 行 ...`);
      } catch (error) {
        failed += 1;
        console.error(`${group.code} 回填失败：${(error as Error).message}`);
      }
    });
    console.log("重算指标脏标记 ...");
    // 仅标记股票日线，交给既有指标服务按批重算；不做全量同步计算。
    const dirty = await pool.query(
      `INSERT INTO market_indicator_dirty (instrument_id, freq, earliest_date, generation, reason, updated_at)
       SELECT bar.instrument_id, 'day', min(bar.bar_date), 1, '全市场日线回填', now()
         FROM market_bar bar JOIN market_instrument instrument ON instrument.id = bar.instrument_id
        WHERE instrument.kind = 'stock' AND bar.freq = 'day'
        GROUP BY bar.instrument_id
       ON CONFLICT (instrument_id, freq) DO UPDATE SET
         earliest_date = LEAST(market_indicator_dirty.earliest_date, EXCLUDED.earliest_date),
         generation = market_indicator_dirty.generation + 1,
         reason = EXCLUDED.reason, updated_at = now()`,
    );
    console.log(`完成：${codes} 只标的、${rows} 行；指标脏标记 ${dirty.rowCount ?? 0} 只；失败 ${failed} 只。`);
  } finally {
    await closePool();
  }
  if (failed > 0) process.exitCode = 1;
}

await main();
