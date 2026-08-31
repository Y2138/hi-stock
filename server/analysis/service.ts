import crypto from "node:crypto";
import type pg from "pg";
import { apiErrors } from "../http/router.js";

export const ANALYSIS_SERVICE_VERSION = "analysis-v1";
export const ANALYSIS_TYPES = ["sector_temperature", "key_levels", "long_valuation"] as const;
export type AnalysisType = (typeof ANALYSIS_TYPES)[number];
type Db = Pick<pg.Pool, "query">;

export interface AnalysisRequest {
  analysis_type: AnalysisType;
  codes?: string[];
  as_of?: string;
  lookback?: number;
}

export interface AnalysisRunRow {
  id: string;
  analysis_type: AnalysisType;
  request_json: Record<string, unknown>;
  input_summary: Record<string, unknown>;
  service_version: string;
  status: "queued" | "running" | "success" | "partial" | "failed";
  result_json: unknown;
  data_gaps: unknown[];
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

/** 板块温度与市场状态口径：同花顺正式板块一级行业（881 前缀），与 daily_data_update 日更范围同源；不再使用任何代理指数/ETF 映射。 */

interface Bar {
  code: string;
  bar_date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  bar_time: string;
}

function number(value: string | number | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function temperature(close: number, ma20: number): number {
  return Math.max(0, Math.min(100, 50 + (close / ma20 - 1) * 1000));
}

async function selectBars(db: Db, codes: string[], freq: "day" | "30m", asOf?: string, limit = 120): Promise<Bar[]> {
  if (codes.length === 0) return [];
  const result = await db.query<Bar>(
    `WITH ranked AS (
       SELECT i.code, b.bar_date::text, b.open::text, b.high::text, b.low::text,
              b.close::text, b.volume::text, b.bar_time::text,
              row_number() OVER (PARTITION BY b.instrument_id ORDER BY b.bar_date DESC, b.bar_time DESC) AS rn
         FROM market_bar b JOIN market_instrument i ON i.id = b.instrument_id
        WHERE i.code = ANY($1::text[]) AND b.freq = $2
          AND ($3::date IS NULL OR b.bar_date <= $3::date)
     )
     SELECT code, bar_date, open, high, low, close, volume, bar_time
       FROM ranked WHERE rn <= $4 ORDER BY code, bar_date, bar_time`,
    [codes, freq, asOf ?? null, limit],
  );
  return result.rows;
}

function grouped(bars: Bar[]): Map<string, Bar[]> {
  const map = new Map<string, Bar[]>();
  for (const bar of bars) {
    const values = map.get(bar.code) ?? [];
    values.push(bar);
    map.set(bar.code, values);
  }
  return map;
}

/** 同花顺一级行业板块全集：code → 板块名 */
async function industryBoards(db: Db): Promise<Map<string, string>> {
  const result = await db.query<{ code: string; name: string }>(
    `SELECT i.code, i.name
       FROM market_board board
       JOIN market_instrument i ON i.id = board.instrument_id
      WHERE board.active = true AND board.source = 'hithink' AND board.board_type = 'industry'
        AND i.code LIKE '881%'
      ORDER BY i.code`,
  );
  return new Map(result.rows.map((row) => [row.code, row.name]));
}

async function sectorTemperature(db: Db, request: AnalysisRequest) {
  const boards = await industryBoards(db);
  const codes = request.codes?.length ? request.codes : [...boards.keys()];
  const namesByCode = new Map(boards);
  const unknown = codes.filter((code) => !namesByCode.has(code));
  if (unknown.length > 0) {
    const extra = await db.query<{ code: string; name: string }>(
      `SELECT code, name FROM market_instrument WHERE code = ANY($1::text[])`,
      [unknown],
    );
    for (const row of extra.rows) namesByCode.set(row.code, row.name);
  }
  const bars = grouped(await selectBars(db, codes, "day", request.as_of, Math.max(25, request.lookback ?? 60)));
  const gaps: unknown[] = [];
  const items = codes.map((code) => {
    const rows = bars.get(code) ?? [];
    if (rows.length < 20) {
      gaps.push({ code, reason: `日线不足 20 条（${rows.length}）` });
      return null;
    }
    const closes = rows.map((row) => number(row.close)).filter((value): value is number => value !== null);
    const volumes = rows.map((row) => number(row.volume)).filter((value): value is number => value !== null);
    const close = closes.at(-1)!;
    const ma20 = mean(closes.slice(-20))!;
    const prior = closes.at(-2) ?? close;
    const fiveAgo = closes.at(-6) ?? close;
    const avgVolume5 = mean(volumes.slice(-5));
    return {
      sector: namesByCode.get(code) ?? code,
      code,
      as_of: rows.at(-1)!.bar_date,
      close,
      ma20,
      temperature: temperature(close, ma20),
      day_return_pct: (close / prior - 1) * 100,
      five_day_return_pct: (close / fiveAgo - 1) * 100,
      volume_ratio_5: avgVolume5 && avgVolume5 > 0 ? (volumes.at(-1) ?? 0) / avgVolume5 : null,
    };
  }).filter(Boolean);
  const average = mean(items.map((item) => item!.temperature));
  return {
    result: {
      average_temperature: average,
      state: average === null ? "数据不足" : average < 30 ? "低温" : average < 50 ? "偏冷" : average < 60 ? "中性" : average < 75 ? "偏暖" : "高温",
      sectors: items,
    },
    gaps,
    input: { requested_codes: codes.length, available_codes: items.length, latest_date: items.map((item) => item!.as_of).sort().at(-1) ?? null },
  };
}

function atr14(rows: Bar[]): number | null {
  const ranges: number[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const high = number(rows[index]!.high);
    const low = number(rows[index]!.low);
    const previousClose = number(rows[index - 1]!.close);
    if (high === null || low === null || previousClose === null) continue;
    ranges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }
  return mean(ranges.slice(-14));
}

function anchoredVwap(rows: Bar[]): number | null {
  if (!rows.length) return null;
  let anchor = 0;
  for (let index = 1; index < rows.length; index += 1) {
    if (Number(rows[index]!.low) < Number(rows[anchor]!.low)) anchor = index;
  }
  let value = 0;
  let volume = 0;
  for (const row of rows.slice(anchor)) {
    const rowVolume = number(row.volume) ?? 0;
    const typical = ((number(row.high) ?? 0) + (number(row.low) ?? 0) + (number(row.close) ?? 0)) / 3;
    value += typical * rowVolume;
    volume += rowVolume;
  }
  return volume > 0 ? value / volume : null;
}

function volumeZones(rows: Bar[], atr: number | null): Array<{ price: number; volume: number }> {
  if (!rows.length) return [];
  const prices = rows.map((row) => number(row.close)).filter((value): value is number => value !== null);
  const step = Math.max((atr ?? ((Math.max(...prices) - Math.min(...prices)) / 20)) / 2, 0.001);
  const bins = new Map<number, number>();
  for (const row of rows) {
    const price = number(row.close);
    if (price === null) continue;
    const bin = Math.round(price / step) * step;
    bins.set(bin, (bins.get(bin) ?? 0) + (number(row.volume) ?? 0));
  }
  return [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([price, volume]) => ({ price, volume }));
}

async function keyLevels(db: Db, request: AnalysisRequest) {
  const codes = request.codes ?? [];
  if (!codes.length) throw apiErrors.badRequest("key_levels 必须提供 codes");
  const [daily, minute] = await Promise.all([
    selectBars(db, codes, "day", request.as_of, Math.min(500, request.lookback ?? 120)),
    selectBars(db, codes, "30m", request.as_of, 240),
  ]);
  const dayMap = grouped(daily);
  const minuteMap = grouped(minute);
  const gaps: unknown[] = [];
  const items = codes.map((code) => {
    const days = dayMap.get(code) ?? [];
    if (days.length < 20) {
      gaps.push({ code, reason: `日线不足 20 条（${days.length}）` });
      return null;
    }
    const atr = atr14(days);
    const recent = days.slice(-20);
    const support = Math.min(...recent.map((row) => Number(row.low)));
    const resistance = Math.max(...recent.map((row) => Number(row.high)));
    const intraday = minuteMap.get(code) ?? [];
    if (!intraday.length) gaps.push({ code, reason: "缺少 30 分钟线，量价区域仅用日线" });
    return {
      code,
      as_of: days.at(-1)!.bar_date,
      close: Number(days.at(-1)!.close),
      atr14: atr,
      support_20d: support,
      resistance_20d: resistance,
      anchored_vwap: anchoredVwap(days.slice(-60)),
      volume_zones: volumeZones(intraday.length ? intraday : days.slice(-60), atr),
    };
  }).filter(Boolean);
  return { result: { items }, gaps, input: { requested_codes: codes.length, daily_rows: daily.length, minute30_rows: minute.length } };
}

async function longValuation(db: Db, request: AnalysisRequest) {
  let codes = request.codes ?? [];
  if (!codes.length) {
    const result = await db.query<{ code: string }>(
      `SELECT DISTINCT i.code FROM pool_membership p JOIN market_instrument i ON i.id = p.instrument_id
        WHERE p.pool = 'long' AND p.effective_to IS NULL ORDER BY i.code`,
    );
    codes = result.rows.map((row) => row.code);
  }
  const rows = await db.query<Record<string, unknown>>(
    `SELECT i.code, i.name,
            v.as_of_date::text AS valuation_date, v.pe_ttm::text, v.pb::text, v.ps_ttm::text,
            v.dividend_yield::text, v.market_cap::text,
            f.as_of_date::text AS fundamental_date, f.report_period::text,
            f.revenue::text, f.net_profit::text, f.operating_cashflow::text,
            f.roe::text, f.gross_margin::text, f.debt_ratio::text
       FROM market_instrument i
       LEFT JOIN LATERAL (SELECT * FROM valuation_snapshot x WHERE x.instrument_id = i.id
         AND ($2::date IS NULL OR x.as_of_date <= $2::date) ORDER BY x.as_of_date DESC LIMIT 1) v ON true
       LEFT JOIN LATERAL (SELECT * FROM fundamental_snapshot x WHERE x.instrument_id = i.id
         AND ($2::date IS NULL OR x.as_of_date <= $2::date) ORDER BY x.as_of_date DESC, x.report_period DESC LIMIT 1) f ON true
      WHERE i.code = ANY($1::text[]) ORDER BY i.code`,
    [codes, request.as_of ?? null],
  );
  const byCode = new Map(rows.rows.map((row) => [String(row.code), row]));
  const gaps: unknown[] = [];
  const items = codes.map((code) => {
    const row = byCode.get(code);
    if (!row) {
      gaps.push({ code, reason: "标的不存在" });
      return null;
    }
    if (!row.valuation_date) gaps.push({ code, reason: "缺少估值快照" });
    if (!row.fundamental_date) gaps.push({ code, reason: "缺少基本面快照" });
    return row;
  }).filter(Boolean);
  return { result: { items }, gaps, input: { requested_codes: codes.length, matched_codes: items.length } };
}

function validateRequest(input: AnalysisRequest): AnalysisRequest {
  if (!ANALYSIS_TYPES.includes(input.analysis_type)) throw apiErrors.badRequest(`未知 analysis_type：${input.analysis_type}`);
  if (input.codes && (input.codes.length > 200 || input.codes.some((code) => !/^[A-Za-z0-9._-]{1,32}$/.test(code)))) {
    throw apiErrors.badRequest("codes 非法或超过 200 项");
  }
  if (input.as_of && !/^\d{4}-\d{2}-\d{2}$/.test(input.as_of)) throw apiErrors.badRequest("as_of 必须是 YYYY-MM-DD");
  if (input.lookback !== undefined && (!Number.isInteger(input.lookback) || input.lookback < 20 || input.lookback > 500)) {
    throw apiErrors.badRequest("lookback 必须是 20–500 的整数");
  }
  return { ...input, codes: input.codes ? [...new Set(input.codes)] : undefined };
}

export async function executeAnalysis(db: Db, raw: AnalysisRequest): Promise<AnalysisRunRow> {
  const request = validateRequest(raw);
  const inserted = await db.query<AnalysisRunRow>(
    `INSERT INTO analysis_run (analysis_type, request_json, service_version)
     VALUES ($1, $2, $3) RETURNING *`,
    [request.analysis_type, JSON.stringify(request), ANALYSIS_SERVICE_VERSION],
  );
  const id = inserted.rows[0]!.id;
  await db.query("UPDATE analysis_run SET status = 'running', started_at = now() WHERE id = $1", [id]);
  try {
    const outcome = request.analysis_type === "sector_temperature"
      ? await sectorTemperature(db, request)
      : request.analysis_type === "key_levels"
        ? await keyLevels(db, request)
        : await longValuation(db, request);
    const status = outcome.gaps.length ? "partial" : "success";
    const resultHash = crypto.createHash("sha256").update(JSON.stringify(outcome.result)).digest("hex");
    const updated = await db.query<AnalysisRunRow>(
      `UPDATE analysis_run SET status = $2, input_summary = $3, result_json = $4,
              data_gaps = $5, finished_at = now()
        WHERE id = $1 RETURNING *`,
      [id, status, JSON.stringify({ ...outcome.input, result_sha256: resultHash }), JSON.stringify(outcome.result), JSON.stringify(outcome.gaps)],
    );
    return updated.rows[0]!;
  } catch (error) {
    await db.query(
      "UPDATE analysis_run SET status = 'failed', error_message = $2, finished_at = now() WHERE id = $1",
      [id, (error as Error).message],
    );
    throw error;
  }
}

export async function listAnalysisRuns(db: Db, limit = 100): Promise<AnalysisRunRow[]> {
  return (await db.query<AnalysisRunRow>("SELECT * FROM analysis_run ORDER BY id DESC LIMIT $1", [limit])).rows;
}

export async function findAnalysisRun(db: Db, id: string): Promise<AnalysisRunRow | null> {
  return (await db.query<AnalysisRunRow>("SELECT * FROM analysis_run WHERE id = $1", [id])).rows[0] ?? null;
}
