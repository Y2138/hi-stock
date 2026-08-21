// 指标脏序列全历史重算：单序列锁、generation 防旧结果提交、原子替换当前值。
import crypto from "node:crypto";
import type pg from "pg";
import { calculateIndicators, INDICATOR_CALCULATION_VERSION } from "./formulas.js";

export type IndicatorFreq = "day" | "30m" | "futures_day";

export interface DirtyRow {
  instrument_id: string;
  freq: IndicatorFreq;
  generation: string;
}

interface InputBar {
  bar_date: string;
  bar_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjustment: string | null;
  kind: string;
}

export interface IndicatorRunResult {
  status: "success" | "untrusted" | "stale" | "skipped";
  instrumentId: string;
  freq: IndicatorFreq;
  runId?: string;
  rowCount: number;
  gaps: Array<{ reason: string }>;
}

function inputHash(rows: InputBar[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function validateInput(rows: InputBar[], freq: IndicatorFreq): Array<{ reason: string }> {
  const gaps: Array<{ reason: string }> = [];
  for (const row of rows) {
    if (![row.open, row.high, row.low, row.close].every(Number.isFinite)) {
      gaps.push({ reason: `${row.bar_date} OHLC 包含非有限数值` });
      break;
    }
    if (row.low > Math.min(row.open, row.close) || row.high < Math.max(row.open, row.close) || row.low > row.high) {
      gaps.push({ reason: `${row.bar_date} OHLC 价格关系非法` });
      break;
    }
  }
  if (freq === "day" && rows.length > 0) {
    const expected = rows[0]!.kind === "stock" ? "forward" : ["index", "board", "etf"].includes(rows[0]!.kind) ? "none" : null;
    if (expected && rows.some((row) => row.adjustment !== expected)) {
      gaps.push({ reason: `${rows[0]!.kind} 日线复权口径应为 ${expected}，实际存在缺失或混用` });
    }
  }
  return gaps;
}

async function recordFailedRun(
  pool: pg.Pool,
  dirty: DirtyRow,
  error: unknown,
): Promise<void> {
  await pool.query(
    `INSERT INTO market_indicator_run
       (instrument_id, freq, calculation_version, input_sha256, input_row_count,
        status, gaps, error_message, finished_at)
     VALUES ($1,$2,$3,$4,0,'failed','[]',$5,now())`,
    [dirty.instrument_id, dirty.freq, INDICATOR_CALCULATION_VERSION, "0".repeat(64), (error as Error).message.slice(0, 2000)],
  );
}

export async function nextDirtyIndicator(pool: pg.Pool): Promise<DirtyRow | null> {
  const result = await pool.query<DirtyRow>(
    `SELECT instrument_id::text, freq, generation::text
       FROM market_indicator_dirty ORDER BY updated_at, instrument_id, freq LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

export async function recomputeIndicatorSeries(
  pool: pg.Pool,
  dirty: DirtyRow,
): Promise<IndicatorRunResult> {
  const client = await pool.connect();
  const lockName = `stock.indicator.${dirty.instrument_id}.${dirty.freq}`;
  let locked = false;
  try {
    const acquired = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext($1)) AS acquired",
      [lockName],
    );
    locked = acquired.rows[0]?.acquired === true;
    if (!locked) {
      return { status: "skipped", instrumentId: dirty.instrument_id, freq: dirty.freq, rowCount: 0, gaps: [] };
    }

    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const current = await client.query<DirtyRow>(
      `SELECT instrument_id::text, freq, generation::text
         FROM market_indicator_dirty WHERE instrument_id = $1 AND freq = $2`,
      [dirty.instrument_id, dirty.freq],
    );
    if (!current.rows[0] || current.rows[0].generation !== dirty.generation) {
      await client.query("ROLLBACK");
      return { status: "stale", instrumentId: dirty.instrument_id, freq: dirty.freq, rowCount: 0, gaps: [] };
    }
    const bars = await client.query<InputBar>(
      `SELECT bar.bar_date::text, bar.bar_time::text,
              bar.open::float8, bar.high::float8, bar.low::float8, bar.close::float8,
              bar.adjustment, instrument.kind
         FROM market_bar bar JOIN market_instrument instrument ON instrument.id = bar.instrument_id
        WHERE bar.instrument_id = $1 AND bar.freq = $2
        ORDER BY bar.bar_date, bar.bar_time`,
      [dirty.instrument_id, dirty.freq],
    );
    await client.query("COMMIT");

    const hash = inputHash(bars.rows);
    const gaps = validateInput(bars.rows, dirty.freq);
    const values = calculateIndicators(bars.rows.map((row) => row.close));
    const status = gaps.length > 0 ? "untrusted" : "success";
    const adjustment = [...new Set(bars.rows.map((row) => row.adjustment).filter(Boolean))].join(",") || null;

    await client.query("BEGIN");
    const latest = await client.query<DirtyRow>(
      `SELECT instrument_id::text, freq, generation::text
         FROM market_indicator_dirty WHERE instrument_id = $1 AND freq = $2 FOR UPDATE`,
      [dirty.instrument_id, dirty.freq],
    );
    if (!latest.rows[0] || latest.rows[0].generation !== dirty.generation) {
      const stale = await client.query<{ id: string }>(
        `INSERT INTO market_indicator_run
           (instrument_id, freq, calculation_version, input_sha256, input_row_count,
            input_start_date, input_end_date, adjustment, status, gaps, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'stale',$9,now()) RETURNING id::text`,
        [
          dirty.instrument_id, dirty.freq, INDICATOR_CALCULATION_VERSION, hash, bars.rows.length,
          bars.rows.at(0)?.bar_date ?? null, bars.rows.at(-1)?.bar_date ?? null, adjustment,
          JSON.stringify([{ reason: "计算期间行情 generation 已变化，旧结果未提交" }]),
        ],
      );
      await client.query("COMMIT");
      return { status: "stale", instrumentId: dirty.instrument_id, freq: dirty.freq, runId: stale.rows[0]!.id, rowCount: bars.rows.length, gaps: [] };
    }
    const run = await client.query<{ id: string }>(
      `INSERT INTO market_indicator_run
         (instrument_id, freq, calculation_version, input_sha256, input_row_count,
          input_start_date, input_end_date, adjustment, status, gaps, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) RETURNING id::text`,
      [
        dirty.instrument_id, dirty.freq, INDICATOR_CALCULATION_VERSION, hash, bars.rows.length,
        bars.rows.at(0)?.bar_date ?? null, bars.rows.at(-1)?.bar_date ?? null, adjustment,
        status, JSON.stringify(gaps),
      ],
    );
    await client.query(
      "DELETE FROM market_indicator_value WHERE instrument_id = $1 AND freq = $2",
      [dirty.instrument_id, dirty.freq],
    );
    if (bars.rows.length > 0) {
      const payload = bars.rows.map((bar, index) => ({
        bar_date: bar.bar_date,
        bar_time: bar.bar_time,
        ma5: values[index]!.ma5,
        ma10: values[index]!.ma10,
        ma20: values[index]!.ma20,
        ma60: values[index]!.ma60,
        dif: values[index]!.dif,
        dea: values[index]!.dea,
        macd_hist: values[index]!.macdHist,
      }));
      await client.query(
        `WITH incoming AS (
           SELECT * FROM jsonb_to_recordset($4::jsonb) AS item(
             bar_date date, bar_time timestamptz,
             ma5 float8, ma10 float8, ma20 float8, ma60 float8,
             dif float8, dea float8, macd_hist float8
           )
         )
         INSERT INTO market_indicator_value
           (instrument_id, freq, bar_date, bar_time, run_id,
            ma5, ma10, ma20, ma60, dif, dea, macd_hist, status)
         SELECT $1,$2,bar_date,bar_time,$3,ma5,ma10,ma20,ma60,dif,dea,macd_hist,$5
           FROM incoming`,
        [dirty.instrument_id, dirty.freq, run.rows[0]!.id, JSON.stringify(payload), status === "untrusted" ? "untrusted" : "ready"],
      );
    }
    await client.query(
      "DELETE FROM market_indicator_dirty WHERE instrument_id = $1 AND freq = $2 AND generation = $3",
      [dirty.instrument_id, dirty.freq, dirty.generation],
    );
    await client.query("COMMIT");
    return { status, instrumentId: dirty.instrument_id, freq: dirty.freq, runId: run.rows[0]!.id, rowCount: bars.rows.length, gaps };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await recordFailedRun(pool, dirty, error).catch(() => {});
    throw error;
  } finally {
    if (locked) {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext(current_database()), hashtext($1))",
        [lockName],
      ).catch(() => {});
    }
    client.release();
  }
}
