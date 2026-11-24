// 任意本地标的的只读研究证据，不要求入池，也不把入池时画像当成当前阶段。
import { STOCK_CHARACTER_CALCULATION_VERSION } from "../../indicators/formulas.js";
import { listLatestDailyBars, type Db } from "./repo.js";
import { shanghaiDate } from "../market-news/repo.js";

interface FundamentalPeriod {
  report_period: string;
  as_of_date: string;
  revenue: number | null;
  net_profit: number | null;
  operating_cashflow: number | null;
  roe: number | null;
  gross_margin: number | null;
  debt_ratio: number | null;
  source: string;
}
interface ValuationPeriod { as_of_date: string; pe_ttm: number | null; pb: number | null; source: string }

/** 上游对历史报告期给的是最近一份包含该期的财报日期，不是首次披露日；输出与说明统一按“数据截至的报告日”表述。 */
const AS_OF_DATE_BASIS = "数据截至的报告日=最近一份包含该报告期的财报日期，不是首次披露日（仅最新一期等于实际披露日）；引用时写“数据截至该日的财报”，不写“该日披露”";

function cumulativeYoy(current: number | null, previous: number | null | undefined): number | null {
  return current === null || previous == null || previous === 0 ? null : (current - previous) / Math.abs(previous) * 100;
}
function valuationPercentile(rows: ValuationPeriod[], field: "pe_ttm" | "pb") {
  const current = rows.at(-1)?.[field] ?? null;
  const samples = rows.map(row => row[field]).filter((value): value is number => value !== null && value > 0);
  return { sample_count: samples.length, value: current,
    percentile: samples.length >= 60 && current !== null && current > 0
      ? samples.filter(value => value <= current).length / samples.length * 100 : null };
}

export async function queryStockResearch(db: Db, codes: string[], asOf = shanghaiDate()) {
  const [quotes, evidence, histories] = await Promise.all([
    listLatestDailyBars(db, codes, asOf),
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
                  metric.stock_character, metric.stage,
                  metric.defense_recovery_ma10, metric.tags
             FROM market_stock_character_metric metric
             JOIN market_indicator_run run ON run.id = metric.indicator_run_id
            WHERE metric.instrument_id = instrument.id AND metric.calculation_version = $2
              AND metric.indicator_run_id = latest_run.id AND run.status = 'success'
              AND metric.as_of_date <= $3::date
            ORDER BY metric.as_of_date DESC, metric.computed_at DESC LIMIT 1
         ) profile ON true
         LEFT JOIN LATERAL (
           SELECT as_of_date::text, report_period::text, revenue, net_profit, operating_cashflow,
                  roe, gross_margin, debt_ratio, source
             FROM fundamental_snapshot WHERE instrument_id = instrument.id
              AND as_of_date <= $3::date AND report_period <= $3::date
            ORDER BY as_of_date DESC, report_period DESC NULLS LAST, id DESC LIMIT 1
         ) fundamental ON true
         LEFT JOIN LATERAL (
           SELECT as_of_date::text, pe_ttm, pb, ps_ttm, dividend_yield, market_cap, source
             FROM valuation_snapshot WHERE instrument_id = instrument.id
              AND as_of_date <= $3::date
            ORDER BY as_of_date DESC, id DESC LIMIT 1
         ) valuation ON true
        WHERE instrument.code = ANY($1::text[])`,
      [codes, STOCK_CHARACTER_CALCULATION_VERSION, asOf],
    ),
    db.query<{ code: string; fundamental_periods: FundamentalPeriod[]; valuations: ValuationPeriod[] }>(
      `SELECT instrument.code,
              COALESCE(financial.items, '[]'::jsonb) AS fundamental_periods,
              COALESCE(valuations.items, '[]'::jsonb) AS valuations
         FROM market_instrument instrument
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(to_jsonb(period) ORDER BY period.report_period DESC) AS items FROM (
             SELECT DISTINCT ON (report_period) report_period::text, as_of_date::text,
                    revenue, net_profit, operating_cashflow, roe, gross_margin, debt_ratio, source
               FROM fundamental_snapshot
              WHERE instrument_id=instrument.id AND as_of_date<=$2::date AND report_period<=$2::date
                AND raw_summary->>'disclosure_date_basis'='reported'
                 AND CASE WHEN jsonb_typeof(raw_summary->'report_date_ms')='number'
                              AND (raw_summary->>'report_date_ms')::numeric > 0
                         THEN (to_timestamp((raw_summary->>'report_date_ms')::double precision/1000)
                               AT TIME ZONE 'Asia/Shanghai')::date=as_of_date ELSE false END
              ORDER BY report_period DESC, as_of_date DESC, id DESC
           ) period
         ) financial ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(to_jsonb(value) ORDER BY value.as_of_date) AS items FROM (
             SELECT as_of_date::text, pe_ttm, pb, source FROM valuation_snapshot
              WHERE instrument_id=instrument.id AND as_of_date<=$2::date
              ORDER BY as_of_date, id
           ) value
         ) valuations ON true
        WHERE instrument.code=ANY($1::text[])`,
      [codes, asOf],
    ),
  ]);
  const quoteByCode = new Map(quotes.map((row) => [row.code, row]));
  const evidenceByCode = new Map(evidence.rows.map((row) => [row.code, row]));
  const historyByCode = new Map(histories.rows.map(row => [row.code, row]));
  return {
    source: "PostgreSQL",
    data_source: "stored",
    as_of: asOf,
    writes_business_data: false,
    instruction: "只读目标日及此前已有数据；各证据日期独立，财报按数据截至的报告日和报告期双重过滤，估值不得晚于目标日。fundamental_periods[].as_of_date 是数据截至的报告日，即最近一份包含该报告期的财报日期，不是首次披露日（仅最新一期等于实际披露日），不得表述为披露日。画像只在 profile_status=ready 时可作行情截止日的正式阶段；缺失不补零。fundamental为保留的兼容字段（最新一期），仅fundamental_disclosure_verified=true时可作已核实报告日证据；多期财务只收录带真实报告日凭据的记录；累计同比用去年同期绝对值作分母，缺少同期或零基数返回null。估值分位只基于本地正值历史（经验分布<=当前值占比），每项少于60条返回null；不是全历史市场分位。行情与财务缺数需经服务同步，不用联网数字补齐。",
    items: codes.map((code) => {
      const row = evidenceByCode.get(code);
      if (!row) return { code, status: "missing", gaps: ["本地无此标的；先用扶摇 ticker_search 消歧"] };
      const quote = quoteByCode.get(code) ?? null;
      const profileStatus = !row.profile?.stage ? "missing"
        : row.dirty || row.profile.as_of_date !== quote?.bar_date ? "stale" : "ready";
      const history = historyByCode.get(code);
      const periods = history?.fundamental_periods ?? [];
      const valuations = history?.valuations ?? [];
      const fundamentalPeriods = periods.slice(0, 8).map(period => {
        const previousDate = `${Number(period.report_period.slice(0, 4)) - 1}${period.report_period.slice(4)}`;
        const previous = periods.find(item => item.report_period === previousDate);
        return { ...period,
          revenue_yoy_pct: cumulativeYoy(period.revenue, previous?.revenue),
          net_profit_yoy_pct: cumulativeYoy(period.net_profit, previous?.net_profit),
          operating_cashflow_yoy_pct: cumulativeYoy(period.operating_cashflow, previous?.operating_cashflow),
          yoy_basis: "累计同比=(当期-去年同期)/abs(去年同期)*100；缺失或零基数为null",
          as_of_date_basis: AS_OF_DATE_BASIS,
        };
      });
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
        fundamental_disclosure_verified: periods.some(period => period.report_period === row.fundamental?.report_period
          && period.as_of_date === row.fundamental?.as_of_date),
        fundamental_periods: fundamentalPeriods,
        fundamental_history_gaps: periods.length < 8 ? ["带真实报告日凭据的财务不足8期，累计同比可能缺少同期"] : [],
        valuation_history: { observations: valuations,
          pe_ttm: valuationPercentile(valuations, "pe_ttm"), pb: valuationPercentile(valuations, "pb"),
          percentile_basis: "本地截至目标日正值样本中<=当前值的占比；不足60条或当前非正值不出分位",
        },
      };
    }),
  };
}
