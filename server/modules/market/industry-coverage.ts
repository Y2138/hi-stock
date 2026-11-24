import type pg from "pg";

export type IndustryFreshness = "ok" | "missing" | "stale" | "not_scheduled" | "upstream_failed";

export function industryFreshness(scheduled: boolean, latest: string | null, target: string, upstreamError: string | null): IndustryFreshness {
  if (!scheduled) return "not_scheduled";
  if (latest === target) return "ok";
  if (upstreamError) return "upstream_failed";
  return latest ? "stale" : "missing";
}

/** 只读行业覆盖；日期差以本机显式交易日历计算，未发布日历不猜测。 */
export async function queryIndustryCoverage(pool: pg.Pool, codes: string[], target: string) {
  const result = await pool.query<{
    code: string; name: string | null; scheduled: boolean; latest_bar_date: string | null;
    history_count: number; latest_fetched_at: string | null; lag_trading_days: number | null; upstream_error: string | null;
  }>(`SELECT requested.code,i.name,
      coalesce(i.lifecycle_status='active' AND EXISTS (
        SELECT 1 FROM market_board d WHERE d.instrument_id=i.id AND d.active
          AND d.source='hithink' AND d.board_type='industry'
          AND (i.code LIKE '881%.TI' OR i.code LIKE '884%.TI')),false) AS scheduled,
      bars.latest_bar_date,bars.history_count,bars.latest_fetched_at,
      CASE WHEN bars.latest_bar_date IS NULL THEN NULL ELSE
        (SELECT count(*)::int FROM market_trading_day WHERE is_open
          AND trade_date>bars.latest_bar_date::date AND trade_date<=$2::date) END AS lag_trading_days,
      failure.reason AS upstream_error
    FROM unnest($1::text[]) requested(code)
    LEFT JOIN market_instrument i ON i.code=requested.code
    LEFT JOIN LATERAL (
      SELECT max(bar_date)::text AS latest_bar_date,count(*)::int AS history_count,
             max(fetched_at)::text AS latest_fetched_at
      FROM market_bar WHERE instrument_id=i.id AND freq='day' AND bar_date<=$2::date
    ) bars ON true
    LEFT JOIN LATERAL (
      SELECT coalesce(gap->>'reason',gap->>'error') AS reason
      FROM market_fetch_run f CROSS JOIN LATERAL jsonb_array_elements(f.gaps) gap
      WHERE gap->>'code'=requested.code AND
        (f.scope->>'date'=$2::date::text OR f.scope->'range'->>'end'=$2::date::text)
        AND coalesce(gap->>'reason',gap->>'error','') ~* '(上游|upstream|HTTP|全部通道失败|快照不可用|timeout|超时)'
      ORDER BY f.id DESC LIMIT 1
    ) failure ON true
    ORDER BY array_position($1::text[],requested.code)`, [codes, target]);
  const calendar = (await pool.query<{ is_open: boolean }>(
    "SELECT is_open FROM market_trading_day WHERE trade_date=$1::date", [target],
  )).rows[0];
  return {
    target_date: target, calendar_status: calendar ? (calendar.is_open ? "open" : "closed") : "unknown",
    allowed_lag_trading_days: 0,
    items: result.rows.map(row => ({ ...row,
      freshness_status: industryFreshness(row.scheduled, row.latest_bar_date, target, row.upstream_error),
    })),
  };
}
