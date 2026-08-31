// datasource 服务：通道编排（扶摇 → akshare 通道优先级见 数据获取规范.md）、
// market_bar 幂等落库、MA5/10/20/60 补算、market_fetch_run 留痕、每日更新链路。
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §5.1、§5.4
import type pg from "pg";
import {
  HithinkChannel,
  fetchLatestFundamental,
  fetchSnapshot,
  fetchValuationSnapshots,
  snapshotDate,
  type HithinkDeps,
  type SnapshotKind,
  type SnapshotQuote,
} from "./hithink.js";
import { SinaChannel, type AkshareDeps } from "./akshare.js";
import type { Bar, Channel, FetchRequest, FetchResult, MarketFreq } from "./types.js";

/** 可查询对象：连接池或事务内客户端（与一期 repo 约定一致） */
export type Db = Pick<pg.Pool, "query">;

export interface ServiceDeps {
  /** 通道列表（按优先级排序）；缺省 [hithink, sina]，测试可注入假通道 */
  channels?: Channel[];
  hithinkDeps?: HithinkDeps;
  akshareDeps?: AkshareDeps;
  /** 调度作业关联；M3 Runner 传入后，所有 market_fetch_run 都归到同一 job_run。 */
  jobRunId?: string;
}

function hithinkDeps(db: Db, deps: Pick<ServiceDeps, "hithinkDeps">): HithinkDeps {
  return { ...deps.hithinkDeps, db: deps.hithinkDeps?.db ?? db };
}

function defaultChannels(db: Db, deps: ServiceDeps): Channel[] {
  return [new HithinkChannel(hithinkDeps(db, deps)), new SinaChannel(deps.akshareDeps ?? {})];
}

function scopeOf(req: FetchRequest): Record<string, unknown> {
  return { instruments: [req.code], freq: req.freq, range: { start: req.start, end: req.end } };
}

function barTimeOf(bar: Bar, freq: MarketFreq): string {
  // T6：day/futures_day 存 bar_date 当日 00:00:00Z；30m 存实际时刻
  if (freq === "30m") {
    if (!bar.time) throw new Error(`30m K线缺少时刻: ${bar.date}`);
    return bar.time;
  }
  return `${bar.date}T00:00:00Z`;
}

/** 标的档案不存在则登记（kind 由频率推断：期货连续 → futures，其余默认 stock） */
export async function ensureInstrument(
  db: Db,
  code: string,
  name?: string,
  freq: MarketFreq = "day",
): Promise<string> {
  const kind = freq === "futures_day" ? "futures" : "stock";
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO market_instrument (code, name, kind) VALUES ($1, $2, $3)
     ON CONFLICT (code) DO NOTHING RETURNING id`,
    [code, name ?? code, kind],
  );
  if (inserted.rows[0]) return String(inserted.rows[0].id);
  const existing = await db.query<{ id: string }>("SELECT id FROM market_instrument WHERE code = $1", [
    code,
  ]);
  if (!existing.rows[0]) throw new Error(`instrument 登记异常：${code}`);
  return String(existing.rows[0].id);
}

/**
 * 幂等落库 market_bar：主键 (instrument_id, freq, bar_date, bar_time) 冲突时更新。
 * 单条多行 INSERT，原子完成；返回写入行数。
 */
export async function storeBars(
  db: Db,
  instrumentId: string,
  freq: MarketFreq,
  bars: Bar[],
  channel: string,
): Promise<number> {
  if (bars.length === 0) return 0;
  const dates: string[] = [];
  const times: string[] = [];
  const opens: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];
  const volumes: (number | null)[] = [];
  const adjustments: (string | null)[] = [];
  for (const bar of bars) {
    dates.push(bar.date);
    times.push(barTimeOf(bar, freq));
    opens.push(bar.open);
    highs.push(bar.high);
    lows.push(bar.low);
    closes.push(bar.close);
    volumes.push(bar.volume ?? null);
    adjustments.push(bar.adjustment ?? null);
  }
  const r = await db.query<{ rows_written: number }>(
    `WITH written AS (
       INSERT INTO market_bar
       (instrument_id, freq, bar_date, bar_time, open, high, low, close, volume, adjustment, channel)
       SELECT $1, $2, d, t, o, h, l, c, v, adj, $3
       FROM unnest(
         $4::date[], $5::timestamptz[], $6::numeric[], $7::numeric[],
         $8::numeric[], $9::numeric[], $10::numeric[], $11::text[]
       ) AS u(d, t, o, h, l, c, v, adj)
       ON CONFLICT (instrument_id, freq, bar_date, bar_time) DO UPDATE SET
         open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
         volume = EXCLUDED.volume,
         adjustment = COALESCE(EXCLUDED.adjustment, market_bar.adjustment),
         channel = EXCLUDED.channel, fetched_at = now()
       RETURNING bar_date
     ), dirty AS (
       INSERT INTO market_indicator_dirty
         (instrument_id, freq, earliest_date, generation, reason, updated_at)
       SELECT $1, $2, min(bar_date), 1, '行情写入或历史修订', now() FROM written
       ON CONFLICT (instrument_id, freq) DO UPDATE SET
         earliest_date = LEAST(market_indicator_dirty.earliest_date, EXCLUDED.earliest_date),
         generation = market_indicator_dirty.generation + 1,
         reason = EXCLUDED.reason,
         updated_at = now()
       RETURNING 1
     )
     SELECT count(*)::int AS rows_written FROM written`,
    [instrumentId, freq, channel, dates, times, opens, highs, lows, closes, volumes, adjustments],
  );
  return r.rows[0]?.rows_written ?? bars.length;
}

const MA_WINDOWS = [5, 10, 20, 60] as const;

/**
 * 落库后补算 MA5/10/20/60（设计 §5.4 第 2 步）：按 bar_date/bar_time 升序对收盘价滚动均值，
 * 窗口不足留空（NULL）；仅更新值有变化的行。
 */
export async function recomputeMa(db: Db, instrumentId: string, freq: MarketFreq): Promise<number> {
  const r = await db.query<{
    bar_date: string;
    bar_time: string;
    close: string;
    ma5: string | null;
    ma10: string | null;
    ma20: string | null;
    ma60: string | null;
  }>(
    `SELECT to_char(bar_date, 'YYYY-MM-DD') AS bar_date, bar_time, close::float8 AS close,
            ma5::float8 AS ma5, ma10::float8 AS ma10, ma20::float8 AS ma20, ma60::float8 AS ma60
     FROM market_bar WHERE instrument_id = $1 AND freq = $2
     ORDER BY bar_date ASC, bar_time ASC`,
    [instrumentId, freq],
  );
  const closes = r.rows.map((row) => Number(row.close));
  let updated = 0;
  for (let i = 0; i < r.rows.length; i++) {
    const mas: (number | null)[] = MA_WINDOWS.map((w) => {
      if (i + 1 < w) return null;
      let sum = 0;
      for (let j = i + 1 - w; j <= i; j++) sum += closes[j]!;
      return sum / w;
    });
    const row = r.rows[i]!;
    const current = [row.ma5, row.ma10, row.ma20, row.ma60].map((v) =>
      v == null ? null : Number(v),
    );
    const changed = mas.some((v, k) =>
      v == null ? current[k] != null : current[k] == null || Math.abs(current[k]! - v) > 1e-9,
    );
    if (!changed) continue;
    await db.query(
      `UPDATE market_bar SET ma5 = $4, ma10 = $5, ma20 = $6, ma60 = $7
       WHERE instrument_id = $1 AND freq = $2 AND bar_date = $3 AND bar_time = $8`,
      [instrumentId, freq, row.bar_date, mas[0], mas[1], mas[2], mas[3], row.bar_time],
    );
    updated += 1;
  }
  return updated;
}

/** 每次获取写一条 market_fetch_run（设计 §5.1）；返回 run id */
export async function insertFetchRun(
  db: Db,
  input: {
    channel: string;
    scope: Record<string, unknown>;
    rowsWritten: number;
    degradedFrom?: string;
    gaps?: unknown[];
    jobRunId?: string;
  },
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO market_fetch_run (job_run_id, channel, scope, rows_written, degraded_from, gaps, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
    [
      input.jobRunId ?? null,
      input.channel,
      JSON.stringify(input.scope),
      input.rowsWritten,
      input.degradedFrom ?? null,
      JSON.stringify(input.gaps ?? []),
    ],
  );
  return String(r.rows[0]!.id);
}

export interface FetchStoreOutcome {
  code: string;
  freq: MarketFreq;
  channel: string;
  degradedFrom?: string;
  rowsWritten: number;
  fetchRunId: string;
  firstDate: string;
  lastDate: string;
}

export interface FinancialFetchRequest {
  code: string;
}

export interface FinancialStoreOutcome {
  code: string;
  status: "success" | "partial";
  valuationRows: number;
  fundamentalRows: number;
  rowsWritten: number;
  fetchRunId: string;
  gaps: unknown[];
}

/** 最新估值与最近共同报告期财务三表直连扶摇并幂等落库。 */
export async function fetchFinancialAndStore(
  db: Db,
  request: FinancialFetchRequest,
  deps: Pick<ServiceDeps, "hithinkDeps" | "jobRunId"> = {},
): Promise<FinancialStoreOutcome> {
  const instrumentId = await ensureInstrument(db, request.code, undefined, "day");
  const gaps: unknown[] = [];
  let valuationRows = 0;
  let fundamentalRows = 0;
  try {
    const quote = (await fetchValuationSnapshots([request.code], hithinkDeps(db, deps)))[0];
    if (!quote) {
      gaps.push({ code: request.code, domain: "valuation", reason: "扶摇未返回该标的估值快照" });
    } else {
      const result = await db.query(
        `INSERT INTO valuation_snapshot
           (instrument_id, as_of_date, pe_ttm, pb, ps_ttm, source, raw_summary)
         VALUES ($1, $2, $3, $4, $5, 'hithink', $6)
         ON CONFLICT (instrument_id, as_of_date) DO UPDATE SET
           pe_ttm = EXCLUDED.pe_ttm, pb = EXCLUDED.pb, ps_ttm = EXCLUDED.ps_ttm,
           source = EXCLUDED.source, raw_summary = EXCLUDED.raw_summary`,
        [instrumentId, quote.asOfDate, quote.peTtm, quote.pb, quote.psTtm, JSON.stringify(quote.rawSummary)],
      );
      valuationRows = result.rowCount ?? 1;
    }
  } catch (error) {
    gaps.push({ code: request.code, domain: "valuation", reason: (error as Error).message });
  }
  try {
    const quote = await fetchLatestFundamental(request.code, hithinkDeps(db, deps));
    const result = await db.query(
      `INSERT INTO fundamental_snapshot
         (instrument_id, as_of_date, report_period, revenue, net_profit, operating_cashflow,
          roe, gross_margin, debt_ratio, source, raw_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'hithink', $10)
       ON CONFLICT (instrument_id, as_of_date, report_period) DO UPDATE SET
         revenue = EXCLUDED.revenue, net_profit = EXCLUDED.net_profit,
         operating_cashflow = EXCLUDED.operating_cashflow, roe = EXCLUDED.roe,
         gross_margin = EXCLUDED.gross_margin, debt_ratio = EXCLUDED.debt_ratio,
         source = EXCLUDED.source, raw_summary = EXCLUDED.raw_summary`,
      [
        instrumentId, quote.asOfDate, quote.reportPeriod, quote.revenue, quote.netProfit,
        quote.operatingCashflow, quote.roe, quote.grossMargin, quote.debtRatio,
        JSON.stringify(quote.rawSummary),
      ],
    );
    fundamentalRows = result.rowCount ?? 1;
  } catch (error) {
    gaps.push({ code: request.code, domain: "fundamental", reason: (error as Error).message });
  }
  const rowsWritten = valuationRows + fundamentalRows;
  const fetchRunId = await insertFetchRun(db, {
    channel: "hithink",
    scope: { instruments: [request.code], op: "financial_snapshots" },
    rowsWritten,
    gaps,
    jobRunId: deps.jobRunId,
  });
  if (rowsWritten === 0) {
    throw new Error(`财务与估值均未写入（market_fetch_run #${fetchRunId} 已留痕）`);
  }
  return {
    code: request.code,
    status: gaps.length ? "partial" : "success",
    valuationRows,
    fundamentalRows,
    rowsWritten,
    fetchRunId,
    gaps,
  };
}

/**
 * 按优先级编排通道完成一次获取并落库（设计 §5.1）：
 * 高优先级通道失败时尝试下一支持通道，降级写 market_fetch_run.degraded_from，不静默切换；
 * 全部通道失败时同样写 market_fetch_run（gaps 记录原因）后抛错。
 */
export async function fetchAndStore(
  db: Db,
  req: FetchRequest,
  deps: ServiceDeps & { instrumentName?: string } = {},
): Promise<FetchStoreOutcome> {
  const candidates = (deps.channels ?? defaultChannels(db, deps)).filter((c) => c.supports(req));
  if (candidates.length === 0) {
    throw new Error(`没有通道支持该请求: ${req.code} ${req.freq}`);
  }
  const instrumentId = await ensureInstrument(db, req.code, deps.instrumentName, req.freq);
  let result: FetchResult | null = null;
  const failures: string[] = [];
  let degradedFrom: string | undefined;
  for (const ch of candidates) {
    try {
      result = { bars: await ch.fetch(req), channel: ch.name };
      if (failures.length > 0) degradedFrom = candidates[0]!.name;
      break;
    } catch (err) {
      failures.push(`${ch.name}: ${(err as Error).message}`);
    }
  }
  if (!result) {
    const runId = await insertFetchRun(db, {
      channel: candidates[0]!.name,
      scope: scopeOf(req),
      rowsWritten: 0,
      degradedFrom: candidates[0]!.name,
      gaps: [{ code: req.code, freq: req.freq, error: failures.join("；") }],
      jobRunId: deps.jobRunId,
    });
    throw new Error(`全部通道失败（market_fetch_run #${runId} 已留痕）：${failures.join("；")}`);
  }
  result.degradedFrom = degradedFrom;
  const rowsWritten = await storeBars(db, instrumentId, req.freq, result.bars, result.channel);
  if (req.freq !== "30m") await recomputeMa(db, instrumentId, req.freq);
  const fetchRunId = await insertFetchRun(db, {
    channel: result.channel,
    scope: scopeOf(req),
    rowsWritten,
    degradedFrom,
    gaps: [],
    jobRunId: deps.jobRunId,
  });
  return {
    code: req.code,
    freq: req.freq,
    channel: result.channel,
    degradedFrom,
    rowsWritten,
    fetchRunId,
    firstDate: result.bars[0]!.date,
    lastDate: result.bars[result.bars.length - 1]!.date,
  };
}

export interface DailyUpdateScope {
  /** 持仓/池内标的，以及需要长期持久化的指数和板块 */
  codes: string[];
  /** 期货主力连续品种（如 CU0），当年起窗口覆盖拉取 */
  futures?: string[];
  /** 需要 30 分钟线的代码（关键位分析范围） */
  minute30?: string[];
  /** 目标交易日 YYYY-MM-DD */
  date: string;
  /** 当日收盘使用快照；历史目标日只使用历史 K 线。 */
  dayMode?: "snapshot" | "historical";
}

export interface DailyUpdateSummary {
  date: string;
  snapshotRows: number;
  refetched: string[];
  futuresRows: number;
  minute30Rows: number;
  gaps: unknown[];
  fetchRunIds: string[];
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y!, m! - 1, d!) + days * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function dayDiff(later: string, earlier: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86400_000);
}

async function missingValidDailyCodes(db: Db, codes: string[], targetDate: string): Promise<string[]> {
  if (codes.length === 0) return [];
  const result = await db.query<{ code: string }>(
    `SELECT requested.code
       FROM unnest($1::text[]) WITH ORDINALITY AS requested(code, sort)
      WHERE NOT EXISTS (
        SELECT 1
          FROM market_instrument i
          JOIN market_bar b ON b.instrument_id = i.id
         WHERE i.code = requested.code
           AND b.freq = 'day'
           AND b.bar_date = $2
           AND b.open > 0
           AND b.high > 0
           AND b.low > 0
           AND b.close > 0
      )
      ORDER BY requested.sort`,
    [codes, targetDate],
  );
  return result.rows.map((row) => row.code);
}

async function backfillDailyCodes(
  db: Db,
  codes: string[],
  targetDate: string,
  deps: ServiceDeps,
): Promise<{ rows: number; refetched: string[]; fetchRunIds: string[]; gaps: unknown[] }> {
  const missing = await missingValidDailyCodes(db, codes, targetDate);
  let rows = 0;
  const refetched: string[] = [];
  const fetchRunIds: string[] = [];
  const gaps: unknown[] = [];
  const failed = new Set<string>();
  for (const code of missing) {
    try {
      const outcome = await fetchAndStore(
        db,
        { code, freq: "day", start: addDays(targetDate, -45), end: targetDate },
        deps,
      );
      rows += outcome.rowsWritten;
      refetched.push(code);
      fetchRunIds.push(outcome.fetchRunId);
    } catch (error) {
      failed.add(code);
      gaps.push({ code, freq: "day", reason: (error as Error).message });
    }
  }
  for (const code of await missingValidDailyCodes(db, missing, targetDate)) {
    if (!failed.has(code)) gaps.push({ code, freq: "day", reason: `历史日线未返回目标日 ${targetDate} 的有效数据` });
  }
  return { rows, refetched, fetchRunIds, gaps };
}

async function groupSnapshotCodes(db: Db, codes: string[]): Promise<Array<{ kind: SnapshotKind; codes: string[] }>> {
  if (codes.length === 0) return [];
  const result = await db.query<{ code: string; kind: SnapshotKind }>(
    `SELECT code, CASE WHEN kind = 'board' THEN 'index' ELSE kind END AS kind
       FROM market_instrument
      WHERE code = ANY($1::text[]) AND kind IN ('stock', 'index', 'board', 'etf')`,
    [codes],
  );
  const kindByCode = new Map(result.rows.map((row) => [row.code, row.kind]));
  const grouped: Record<SnapshotKind, string[]> = { stock: [], index: [], etf: [] };
  for (const code of codes) grouped[kindByCode.get(code) ?? "stock"].push(code);
  return (Object.entries(grouped) as Array<[SnapshotKind, string[]]>)
    .filter(([, groupCodes]) => groupCodes.length > 0)
    .map(([kind, groupCodes]) => ({ kind, codes: groupCodes }));
}

/**
 * 每日更新链路（设计 §5.4）：
 * 1. 股票/指数/板块/ETF 按类型请求快照并追加最新交易日；缺口 >1 日或除权跳空对该标的 kline 重拉；
 * 2. 落库后补算 MA；3. 期货主力连续；4. 关键位所需 30 分钟线。
 * 数据卷导出（链路末尾）属 volume 模块，不在此函数内。
 */
export async function dailyMarketUpdate(
  db: Db,
  scope: DailyUpdateScope,
  deps: ServiceDeps = {},
): Promise<DailyUpdateSummary> {
  const summary: DailyUpdateSummary = {
    date: scope.date,
    snapshotRows: 0,
    refetched: [],
    futuresRows: 0,
    minute30Rows: 0,
    gaps: [],
    fetchRunIds: [],
  };
  const maDirty = new Set<string>();

  // 第 1 步：股票、指数/板块、ETF 按类型批量快照；坏标的显式记缺口并跳过。
  for (const group of await groupSnapshotCodes(db, scope.codes)) {
    let groupRows = 0;
    const groupGaps: unknown[] = [];
    if (scope.dayMode === "historical") {
      const historical = await backfillDailyCodes(db, group.codes, scope.date, deps);
      summary.snapshotRows += historical.rows;
      summary.refetched.push(...historical.refetched);
      summary.fetchRunIds.push(...historical.fetchRunIds);
      summary.gaps.push(...historical.gaps);
      continue;
    }
    try {
      const failedCodes = new Set<string>();
      // ETF 端点只接受单只请求：一只基金不支持行情只记该标的缺口，不拖垮同组其余 ETF。
      let quotes: SnapshotQuote[];
      if (group.kind === "etf") {
        quotes = [];
        for (const code of group.codes) {
          try {
            quotes.push(...(await fetchSnapshot([code], hithinkDeps(db, deps), "etf")));
          } catch (err) {
            failedCodes.add(code);
            groupGaps.push({ code, freq: "day", reason: `ETF 快照不可用: ${(err as Error).message}` });
          }
        }
      } else {
        quotes = await fetchSnapshot(group.codes, hithinkDeps(db, deps), group.kind);
      }
      const quoteByCode = new Map(quotes.map((quote) => [quote.code, quote]));
      for (const code of group.codes) {
        if (failedCodes.has(code)) continue;
        const quote = quoteByCode.get(code);
        if (!quote) {
          groupGaps.push({ code, freq: "day", reason: "批量快照未返回该标的" });
          continue;
        }
        const barDate = snapshotDate(quote);
        if (barDate !== scope.date) {
          groupGaps.push({ code, freq: "day", reason: `快照交易日 ${barDate} 与目标日 ${scope.date} 不一致` });
          continue;
        }
        if ([quote.open, quote.high, quote.low, quote.close].some((value) => !Number.isFinite(value) || value <= 0)) {
          groupGaps.push({ code, freq: "day", reason: "快照存在非正或非有限 OHLC" });
          continue;
        }
        const instrumentId = await ensureInstrument(db, quote.code, undefined, "day");
        // 缺口/除权跳空检测：上一条日线距快照日 >3 个自然日，或快照前收与库内前收偏差 >11%
        const prev = await db.query<{ bar_date: string; close: string }>(
          `SELECT to_char(bar_date, 'YYYY-MM-DD') AS bar_date, close::float8 AS close
           FROM market_bar WHERE instrument_id = $1 AND freq = 'day' AND bar_date < $2
           ORDER BY bar_date DESC LIMIT 1`,
          [instrumentId, barDate],
        );
        const prevRow = prev.rows[0];
        const needRefetch =
          prevRow == null ||
          (quote.prevClose != null && Math.abs(quote.prevClose - Number(prevRow.close)) / Number(prevRow.close) > 0.11) ||
          dayDiff(barDate, prevRow.bar_date) > 3;
        if (needRefetch) {
          const start = prevRow ? addDays(prevRow.bar_date, 1) : addDays(barDate, -45);
          const outcome = await fetchAndStore(db, { code: quote.code, freq: "day", start, end: barDate }, deps);
          summary.refetched.push(quote.code);
          summary.fetchRunIds.push(outcome.fetchRunId);
          groupRows += outcome.rowsWritten;
          maDirty.add(instrumentId);
          continue;
        }
        groupRows += await storeBars(
          db,
          instrumentId,
          "day",
          [{
            date: barDate,
            open: quote.open,
            high: quote.high,
            low: quote.low,
            close: quote.close,
            volume: quote.volume,
            adjustment: group.kind === "stock" ? "forward" : "none",
          }],
          "hithink",
        );
        maDirty.add(instrumentId);
      }
      summary.fetchRunIds.push(
        await insertFetchRun(db, {
          channel: "hithink",
          scope: { instruments: group.codes, kind: group.kind, freq: "day", date: scope.date, op: "snapshot" },
          rowsWritten: groupRows,
          gaps: groupGaps,
          jobRunId: deps.jobRunId,
        }),
      );
      summary.gaps.push(...groupGaps);
    } catch (err) {
      // 实时日更不把一次批量快照失败放大为全组逐只历史请求。
      const snapshotFailure = { reason: `${group.kind} 批量快照不可用: ${(err as Error).message}` };
      summary.fetchRunIds.push(
        await insertFetchRun(db, {
          channel: "hithink",
          scope: { instruments: group.codes, kind: group.kind, freq: "day", date: scope.date, op: "snapshot" },
          rowsWritten: 0,
          degradedFrom: "hithink:snapshot",
          gaps: [snapshotFailure],
          jobRunId: deps.jobRunId,
        }),
      );
      summary.gaps.push(snapshotFailure);
    }
    summary.snapshotRows += groupRows;
  }

  // 第 2 步：补算 MA（fetchAndStore 内部已对重拉标的算过，这里补快照追加路径）
  for (const instrumentId of maDirty) {
    await recomputeMa(db, instrumentId, "day");
  }

  // 第 3 步：期货主力连续（当年起窗口覆盖拉取）
  for (const code of scope.futures ?? []) {
    try {
      const outcome = await fetchAndStore(
        db,
        { code, freq: "futures_day", start: `${scope.date.slice(0, 4)}-01-01`, end: scope.date },
        deps,
      );
      summary.futuresRows += outcome.rowsWritten;
      summary.fetchRunIds.push(outcome.fetchRunId);
    } catch (err) {
      summary.gaps.push({ code, freq: "futures_day", reason: (err as Error).message });
    }
  }

  // 第 4 步：关键位所需 30 分钟线（近 15 个自然日窗口）
  for (const code of scope.minute30 ?? []) {
    try {
      const outcome = await fetchAndStore(
        db,
        { code, freq: "30m", start: addDays(scope.date, -15), end: scope.date },
        deps,
      );
      summary.minute30Rows += outcome.rowsWritten;
      summary.fetchRunIds.push(outcome.fetchRunId);
    } catch (err) {
      summary.gaps.push({ code, freq: "30m", reason: (err as Error).message });
    }
  }

  return summary;
}
