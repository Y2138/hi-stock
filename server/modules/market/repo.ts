// 行情与标的档案查询 repo：instrument 检索、market_bar 读库、coverage 对账摘要
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §4.1、§十
import type pg from "pg";

/** 可查询对象：连接池或事务内客户端（结构化类型，二者均满足） */
export type Db = Pick<pg.Pool, "query">;

export const INSTRUMENT_KINDS = ["stock", "etf", "index", "board", "fund", "futures"] as const;
export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number];

export const MARKET_FREQS = ["day", "30m", "futures_day"] as const;
export type MarketFreq = (typeof MARKET_FREQS)[number];

export interface InstrumentRow {
  id: string;
  code: string;
  name: string;
  kind: InstrumentKind;
  sector_code: string | null;
  ticker: string | null;
  exchange: string | null;
  source_asset_type: string | null;
  lifecycle_status: string;
  capabilities: Record<string, boolean>;
  persisted: true;
}

export interface BarRow {
  bar_date: string;
  bar_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  dif: number | null;
  dea: number | null;
  macd_hist: number | null;
  adjustment: string | null;
  channel: string;
}

export interface CoverageRow {
  freq: MarketFreq;
  instrument_count: number;
  stock_count: number;
  board_count: number;
  etf_count: number;
  index_count: number;
  first_date: string | null;
  last_date: string | null;
  row_count: number;
}

/** 标的检索：代码/名称模糊匹配（命令面板用），按 code 排序 */
export async function searchInstruments(
  db: Db,
  opts: { kind?: InstrumentKind; assetType?: string; q?: string; limit?: number },
): Promise<InstrumentRow[]> {
  const conds: string[] = [];
  const args: unknown[] = [];
  if (opts.kind) {
    args.push(opts.kind);
    conds.push(`kind = $${args.length}`);
  }
  if (opts.assetType) {
    args.push(opts.assetType);
    conds.push(`source_asset_type = $${args.length}`);
  }
  if (opts.q) {
    args.push(`%${opts.q}%`);
    conds.push(`(code ILIKE $${args.length} OR ticker ILIKE $${args.length} OR name ILIKE $${args.length}
      OR EXISTS (SELECT 1 FROM market_instrument_alias alias
                  WHERE alias.instrument_id = market_instrument.id AND alias.alias ILIKE $${args.length}))`);
  }
  args.push(opts.limit ?? 50);
  const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
  const r = await db.query<InstrumentRow>(
    `SELECT id::text, code, name, kind, sector_code, ticker, exchange,
            source_asset_type, lifecycle_status, capabilities, true AS persisted
       FROM market_instrument ${where}
      ORDER BY CASE WHEN code = $${args.length + 1} THEN 0 WHEN ticker = $${args.length + 1} THEN 1 ELSE 2 END,
               lifecycle_status = 'active' DESC, code
      LIMIT $${args.length}`,
    [...args, opts.q ?? ""],
  );
  return r.rows;
}

/** 按代码查标的（不存在返回 null） */
export async function findInstrumentByCode(db: Db, code: string): Promise<InstrumentRow | null> {
  const r = await db.query<InstrumentRow>(
    `SELECT id::text, code, name, kind, sector_code, ticker, exchange,
            source_asset_type, lifecycle_status, capabilities, true AS persisted
       FROM market_instrument WHERE code = $1`,
    [code],
  );
  return r.rows[0] ?? null;
}

/** 读取 K 线（bar_date 以文本返回，避免时区换算）；按日期/时刻升序 */
export async function listBars(
  db: Db,
  opts: { instrumentId: string; freq: MarketFreq; start?: string; end?: string; useIndicatorV2?: boolean },
): Promise<BarRow[]> {
  const conds = ["bar.instrument_id = $1", "bar.freq = $2"];
  const args: unknown[] = [opts.instrumentId, opts.freq, opts.useIndicatorV2 === true];
  if (opts.start) {
    args.push(opts.start);
    conds.push(`bar.bar_date >= $${args.length}`);
  }
  if (opts.end) {
    args.push(opts.end);
    conds.push(`bar.bar_date <= $${args.length}`);
  }
  const r = await db.query<BarRow>(
    `SELECT bar.bar_date::text, bar.bar_time, bar.open::float, bar.high::float,
            bar.low::float, bar.close::float, bar.volume::float,
            CASE WHEN $3 THEN indicator.ma5::float ELSE bar.ma5::float END AS ma5,
            CASE WHEN $3 THEN indicator.ma10::float ELSE bar.ma10::float END AS ma10,
            CASE WHEN $3 THEN indicator.ma20::float ELSE bar.ma20::float END AS ma20,
            CASE WHEN $3 THEN indicator.ma60::float ELSE bar.ma60::float END AS ma60,
            CASE WHEN $3 THEN indicator.dif::float ELSE NULL END AS dif,
            CASE WHEN $3 THEN indicator.dea::float ELSE NULL END AS dea,
            CASE WHEN $3 THEN indicator.macd_hist::float ELSE NULL END AS macd_hist,
            bar.adjustment, bar.channel
       FROM market_bar bar
       LEFT JOIN market_indicator_value indicator
         ON indicator.instrument_id = bar.instrument_id AND indicator.freq = bar.freq
        AND indicator.bar_date = bar.bar_date AND indicator.bar_time = bar.bar_time
      WHERE ${conds.join(" AND ")}
      ORDER BY bar.bar_date, bar.bar_time`,
    args,
  );
  return r.rows;
}

export interface IndicatorStatusRow {
  calculation_version: string;
  status: "success" | "partial" | "failed" | "untrusted" | "stale";
  adjustment: string | null;
  gaps: unknown[];
  input_sha256: string;
  finished_at: string | null;
}

export async function latestIndicatorStatus(
  db: Db,
  instrumentId: string,
  freq: MarketFreq,
): Promise<IndicatorStatusRow | null> {
  const result = await db.query<IndicatorStatusRow>(
    `SELECT calculation_version, status, adjustment, gaps, input_sha256, finished_at::text
       FROM market_indicator_run
      WHERE instrument_id = $1 AND freq = $2
      ORDER BY id DESC LIMIT 1`,
    [instrumentId, freq],
  );
  return result.rows[0] ?? null;
}

export interface LatestDailyBarRow {
  code: string;
  name: string;
  kind: InstrumentKind;
  freq: "day" | "futures_day";
  bar_date: string | null;
  bar_time: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  prev_close: number | null;
  volume: number | null;
  change_pct: number | null;
  channel: string | null;
  fetched_at: string | null;
}

/** 最新日线快照：供 Agent 的兼容 snapshot 工具使用，不读取盘中采样。 */
export async function listLatestDailyBars(db: Db, codes: string[]): Promise<LatestDailyBarRow[]> {
  const result = await db.query<Omit<LatestDailyBarRow, "change_pct">>(
    `SELECT instrument.code, instrument.name, instrument.kind,
            CASE WHEN instrument.kind = 'futures' THEN 'futures_day' ELSE 'day' END AS freq,
            latest.bar_date::text, latest.bar_time::text,
            latest.open::float8, latest.high::float8, latest.low::float8,
            latest.close::float8, latest.prev_close::float8, latest.volume::float8,
            latest.channel, latest.fetched_at::text
       FROM market_instrument instrument
       LEFT JOIN LATERAL (
         SELECT history.*
           FROM (
             SELECT bar.bar_date, bar.bar_time, bar.open, bar.high, bar.low, bar.close,
                    lag(bar.close) OVER (ORDER BY bar.bar_date, bar.bar_time) AS prev_close,
                    bar.volume, bar.channel, bar.fetched_at
               FROM market_bar bar
              WHERE bar.instrument_id = instrument.id
                AND bar.freq = CASE WHEN instrument.kind = 'futures' THEN 'futures_day' ELSE 'day' END
           ) history
          ORDER BY history.bar_date DESC, history.bar_time DESC LIMIT 1
       ) latest ON true
      WHERE instrument.code = ANY($1::text[])
      ORDER BY array_position($1::text[], instrument.code)`,
    [codes],
  );
  return result.rows.map((row) => ({
    ...row,
    change_pct: row.close !== null && row.prev_close !== null && row.prev_close > 0
      ? (row.close / row.prev_close - 1) * 100
      : null,
  }));
}

/** 行情覆盖摘要：按 freq 分组的标的数量、最早/最晚 bar_date、总行数 */
export async function marketCoverage(db: Db): Promise<CoverageRow[]> {
  const r = await db.query<CoverageRow>(
    `SELECT bar.freq, count(DISTINCT bar.instrument_id)::int AS instrument_count,
            count(DISTINCT bar.instrument_id) FILTER (WHERE instrument.kind = 'stock')::int AS stock_count,
            count(DISTINCT bar.instrument_id) FILTER (WHERE instrument.kind = 'board')::int AS board_count,
            count(DISTINCT bar.instrument_id) FILTER (WHERE instrument.kind = 'etf')::int AS etf_count,
            count(DISTINCT bar.instrument_id) FILTER (WHERE instrument.kind = 'index')::int AS index_count,
            min(bar.bar_date)::text AS first_date, max(bar.bar_date)::text AS last_date,
            count(*)::int AS row_count
       FROM market_bar bar
       JOIN market_instrument instrument ON instrument.id = bar.instrument_id
      GROUP BY bar.freq ORDER BY bar.freq`,
  );
  return r.rows;
}
