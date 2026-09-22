import type pg from "pg";
import { computeForwardOhlc, type AdjustmentEvent } from "./adjustment.js";

interface BrokenBar {
  bar_date: string;
  bar_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  open_raw: number | null;
  high_raw: number | null;
  low_raw: number | null;
  close_raw: number | null;
}

/** 仅修复批量回填时以负的收盘复权比率倒置的 OHLC；收盘价、原价和成交数据保持不变。 */
export async function repairInvalidForwardOhlc(
  pool: pg.Pool,
  sources: Array<{ code: string; events: AdjustmentEvent[] }>,
): Promise<Array<{ code: string; repaired: number }>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const results: Array<{ code: string; repaired: number }> = [];
    for (const { code, events } of sources) {
      if (!/^(?:00|60)\d{4}\.(?:SZ|SH)$/.test(code) || !events.length ||
        events.some((event) => ![event.dividend, event.bonus, event.rights_ratio, event.rights_price].every(Number.isFinite)
          || 1 + event.bonus + event.rights_ratio <= 0)) {
        throw new Error(`修复输入不完整或不合法：${code}`);
      }
      const instrument = await client.query<{ id: string; anchor: string | null }>(
        `SELECT i.id::text, max(b.bar_date)::text AS anchor FROM market_instrument i
         JOIN market_bar b ON b.instrument_id=i.id AND b.freq='day'
         WHERE i.code=$1 GROUP BY i.id`, [code],
      );
      const { id, anchor } = instrument.rows[0] ?? {};
      if (!id || !anchor) throw new Error(`标的日线不存在：${code}`);
      const invalid = await client.query<BrokenBar>(
        `SELECT bar_date::text,bar_time::text,open::float8,high::float8,low::float8,close::float8,
                open_raw::float8,high_raw::float8,low_raw::float8,close_raw::float8
           FROM market_bar WHERE instrument_id=$1 AND freq='day' AND channel='hithink_dump'
             AND adjustment='forward'
             AND (high<low OR high<open OR high<close OR low>open OR low>close)
           ORDER BY bar_date,bar_time FOR UPDATE`, [id],
      );
      if (!invalid.rows.length) { results.push({ code, repaired: 0 }); continue; }
      for (const bar of invalid.rows) {
        const raw = [bar.open_raw, bar.high_raw, bar.low_raw, bar.close_raw];
        if (raw.some((value) => value === null || !Number.isFinite(value) || value <= 0) ||
          bar.high_raw! < Math.max(bar.open_raw!, bar.close_raw!) ||
          bar.low_raw! > Math.min(bar.open_raw!, bar.close_raw!)) {
          throw new Error(`${code} ${bar.bar_date} 未复权 OHLC 不可信，拒绝修复`);
        }
      }
      const corrected = computeForwardOhlc(invalid.rows.map((bar) => ({
        date: bar.bar_date, open: bar.open_raw!, high: bar.high_raw!,
        low: bar.low_raw!, close: bar.close_raw!,
      })), events, anchor);
      const replacements = invalid.rows.map((bar) => {
        const fixed = corrected.get(bar.bar_date)!;
        if (Math.abs(bar.close - fixed.close) > 0.000005 ||
          fixed.high < Math.max(fixed.open, bar.close) || fixed.low > Math.min(fixed.open, bar.close)) {
          throw new Error(`${code} ${bar.bar_date} 收盘复权口径不匹配，拒绝修复`);
        }
        return { bar_date: bar.bar_date, bar_time: bar.bar_time,
          open: fixed.open, high: fixed.high, low: fixed.low };
      });
      const changed = await client.query(
        `UPDATE market_bar bar SET open=fix.open,high=fix.high,low=fix.low
           FROM jsonb_to_recordset($2::jsonb) AS fix(bar_date date,bar_time timestamptz,open numeric,high numeric,low numeric)
          WHERE bar.instrument_id=$1 AND bar.freq='day' AND bar.channel='hithink_dump'
            AND bar.adjustment='forward' AND bar.bar_date=fix.bar_date AND bar.bar_time=fix.bar_time`,
        [id, JSON.stringify(replacements)],
      );
      if (changed.rowCount !== replacements.length) throw new Error(`${code} 修复行数不一致`);
      await client.query(
        `INSERT INTO market_indicator_dirty (instrument_id,freq,earliest_date,generation,reason,updated_at)
         VALUES ($1,'day',$2,1,'前复权 OHLC 修复',now())
         ON CONFLICT (instrument_id,freq) DO UPDATE SET
           earliest_date=LEAST(market_indicator_dirty.earliest_date,EXCLUDED.earliest_date),
           generation=market_indicator_dirty.generation+1,reason=EXCLUDED.reason,updated_at=now()`,
        [id, invalid.rows[0]!.bar_date],
      );
      results.push({ code, repaired: replacements.length });
    }
    await client.query("COMMIT");
    return results;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
