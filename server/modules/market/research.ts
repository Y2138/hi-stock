// 任意本地标的的只读研究证据，不要求入池，也不把入池时画像当成当前阶段。
import { STOCK_CHARACTER_CALCULATION_VERSION } from "../../indicators/formulas.js";
import { listLatestDailyBars, type Db } from "./repo.js";

export async function queryStockResearch(db: Db, codes: string[]) {
  const [quotes, evidence] = await Promise.all([
    listLatestDailyBars(db, codes),
    db.query<{
      code: string;
      profile: Record<string, unknown> | null;
      fundamental: Record<string, unknown> | null;
      valuation: Record<string, unknown> | null;
      indicator_status: string | null;
      dirty: boolean;
    }>(
      `SELECT instrument.code, to_jsonb(profile) AS profile,
              to_jsonb(fundamental) AS fundamental, to_jsonb(valuation) AS valuation,
              latest_run.status AS indicator_status,
              EXISTS (SELECT 1 FROM market_indicator_dirty dirty
                       WHERE dirty.instrument_id = instrument.id AND dirty.freq = 'day') AS dirty
         FROM market_instrument instrument
         LEFT JOIN LATERAL (
           SELECT id, status FROM market_indicator_run
            WHERE instrument_id = instrument.id AND freq = 'day' ORDER BY id DESC LIMIT 1
         ) latest_run ON true
         LEFT JOIN LATERAL (
           SELECT metric.as_of_date::text, metric.calculation_version, run.input_sha256,
                  run.adjustment, metric.input_row_count, metric.stock_character_profile,
                  metric.stock_character, metric.stage, metric.research_score, metric.grade,
                  metric.defense_recovery_ma10, metric.tags
             FROM market_stock_character_metric metric
             JOIN market_indicator_run run ON run.id = metric.indicator_run_id
            WHERE metric.instrument_id = instrument.id AND metric.calculation_version = $2
              AND metric.indicator_run_id = latest_run.id AND run.status = 'success'
            ORDER BY metric.as_of_date DESC, metric.computed_at DESC LIMIT 1
         ) profile ON true
         LEFT JOIN LATERAL (
           SELECT as_of_date::text, report_period::text, revenue, net_profit, operating_cashflow,
                  roe, gross_margin, debt_ratio, source
             FROM fundamental_snapshot WHERE instrument_id = instrument.id
            ORDER BY as_of_date DESC, report_period DESC NULLS LAST, id DESC LIMIT 1
         ) fundamental ON true
         LEFT JOIN LATERAL (
           SELECT as_of_date::text, pe_ttm, pb, ps_ttm, dividend_yield, market_cap, source
             FROM valuation_snapshot WHERE instrument_id = instrument.id
            ORDER BY as_of_date DESC, id DESC LIMIT 1
         ) valuation ON true
        WHERE instrument.code = ANY($1::text[])`,
      [codes, STOCK_CHARACTER_CALCULATION_VERSION],
    ),
  ]);
  const quoteByCode = new Map(quotes.map((row) => [row.code, row]));
  const evidenceByCode = new Map(evidence.rows.map((row) => [row.code, row]));
  return {
    source: "PostgreSQL",
    writes_business_data: false,
    instruction: "只读已有数据；各证据日期独立。画像只在 profile_status=ready 时可作行情截止日的正式阶段；财报按报告期比较，缺失不补零。需要更新或本地未知标的时使用扶摇临时查询，不必入池。",
    items: codes.map((code) => {
      const row = evidenceByCode.get(code);
      if (!row) return { code, status: "missing", gaps: ["本地无此标的；先用扶摇 ticker_search 消歧"] };
      const quote = quoteByCode.get(code) ?? null;
      const profileStatus = !row.profile?.stage ? "missing"
        : row.dirty || row.profile.as_of_date !== quote?.bar_date ? "stale" : "ready";
      const gaps = [
        ...(!quote?.bar_date ? ["缺少日线"] : []),
        ...(profileStatus !== "ready" ? [`正式股性画像${profileStatus === "stale" ? "待重算" : "缺失或不可信"}`] : []),
        ...(!row.fundamental ? ["缺少财报"] : []),
        ...(!row.valuation ? ["缺少估值"] : []),
      ];
      return {
        code, status: gaps.length ? "partial" : "ready", gaps, quote,
        profile_status: profileStatus, profile: row.profile,
        fundamental: row.fundamental, valuation: row.valuation,
      };
    }),
  };
}
