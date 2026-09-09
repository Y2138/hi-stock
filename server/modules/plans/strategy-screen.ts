// 策略条件参考口径筛选：任意 A 股个股代码 × 当前策略确定性规则。
// 只输出逐只条件布尔、必要数值证据和数据缺口；不产生 signal_grade、不做唯一信号合并，
// 也不评估每日计划的大盘环境门禁——正式口径仍由 pool_onboard 入池后的每日计划产出。
import type pg from "pg";
import { recomputeIndicatorSeries, type IndicatorRunResult } from "../../indicators/service.js";
import {
  evaluateLeftSideSignal,
  evaluateRightSideSignal,
  evaluateTrialStartSignal,
  type LeftSideSignalBar,
  type LeftSideSignalEvaluation,
  type RightSideSignalBar,
  type RightSideSignalEvaluation,
  type TrialBar,
  type TrialStartEvaluation,
} from "./daily-context.js";
import { evaluateSwingSignal, type SwingSignalBar, type SwingSignalEvaluation } from "./swing-signals.js";
import {
  STRATEGY_SCREEN_MIN_BARS as RULE_MIN_BARS,
  type StrategyScreenRule,
} from "./strategy-screen-rules.js";

type Db = Pick<pg.Pool, "query">;

export interface StrategyScreenRequest {
  codes: string[];
  rules: StrategyScreenRule[];
  date: string;
}

interface InstrumentRow {
  id: string;
  code: string;
  name: string;
  kind: string;
}

type RuleOutcome =
  | ({ status: "evaluated" } & (
      | { rule: "short_right"; evaluation: RightSideSignalEvaluation }
      | { rule: "short_left"; evaluation: LeftSideSignalEvaluation }
      | { rule: "trial"; evaluation: TrialStartEvaluation }
      | { rule: "swing"; evaluation: SwingSignalEvaluation; metric_date: string | null }
    ))
  | { rule: StrategyScreenRule; status: "gap"; reason: string };

export interface StrategyScreenResultItem {
  code: string;
  name: string;
  kind: string;
  latest_bar_date: string | null;
  rules: RuleOutcome[];
}

export interface StrategyScreenResult {
  requested_date: string;
  rules: StrategyScreenRule[];
  code_count: number;
  status: "success" | "partial";
  notice: string;
  instruction: string;
  items: StrategyScreenResultItem[];
  data_gaps: Array<{ code: string; rule: StrategyScreenRule | null; reason: string }>;
}

/** 评估前同步重算过期日线指标（照搬 pool_onboard 先例），不依赖 IndicatorWorker 的异步轮询时序。 */
async function recomputeDirtyIndicators(
  pool: pg.Pool,
  instrumentIds: string[],
  deps: { recomputeIndicator?: (dirty: { instrument_id: string; freq: "day"; generation: string }) => Promise<IndicatorRunResult> },
): Promise<Map<string, string>> {
  const failures = new Map<string, string>();
  if (instrumentIds.length === 0) return failures;
  const dirty = await pool.query<{ instrument_id: string; freq: "day"; generation: string }>(
    `SELECT instrument_id::text, freq, generation::text
       FROM market_indicator_dirty
      WHERE instrument_id = ANY($1::bigint[]) AND freq = 'day'`,
    [instrumentIds],
  );
  const recompute = deps.recomputeIndicator ?? ((row) => recomputeIndicatorSeries(pool, row));
  for (const row of dirty.rows) {
    try {
      const result = await recompute(row);
      if (result.status !== "success") {
        failures.set(row.instrument_id, `正式日线指标重算未成功（status=${result.status}）`);
      }
    } catch (error) {
      failures.set(row.instrument_id, `正式日线指标重算失败：${(error as Error).message}`);
    }
  }
  return failures;
}

/** 一次取齐全部规则所需的日线与指标列；窗口取请求规则中的最大值。 */
async function loadBars(
  db: Db,
  instrumentIds: string[],
  date: string,
  window: number,
): Promise<Map<string, Array<RightSideSignalBar & LeftSideSignalBar & SwingSignalBar>>> {
  const bars = await db.query<RightSideSignalBar & LeftSideSignalBar & SwingSignalBar>(
    `WITH ranked AS (
       SELECT instrument.code, bar.bar_date::text,
              bar.open::float8, bar.high::float8, bar.low::float8, bar.close::float8,
              bar.volume::float8,
              indicator.ma5::float8, indicator.ma10::float8, indicator.ma20::float8,
              indicator.dif::float8, indicator.macd_hist::float8, indicator.rsi14::float8,
              indicator.status AS indicator_status,
              row_number() OVER (
                PARTITION BY bar.instrument_id ORDER BY bar.bar_date DESC, bar.bar_time DESC
              ) AS row_no
         FROM market_instrument instrument
         JOIN market_bar bar ON bar.instrument_id = instrument.id
                            AND bar.freq = 'day' AND bar.bar_date <= $2::date
         LEFT JOIN market_indicator_value indicator
           ON indicator.instrument_id = bar.instrument_id AND indicator.freq = bar.freq
          AND indicator.bar_date = bar.bar_date AND indicator.bar_time = bar.bar_time
        WHERE instrument.id = ANY($1::bigint[])
     )
     SELECT code, bar_date, open, high, low, close, volume,
            ma5, ma10, ma20, dif, macd_hist, rsi14, indicator_status
       FROM ranked WHERE row_no <= $3::int ORDER BY code, bar_date`,
    [instrumentIds, date, window],
  );
  const byCode = new Map<string, Array<RightSideSignalBar & LeftSideSignalBar & SwingSignalBar>>();
  for (const bar of bars.rows) byCode.set(bar.code, [...(byCode.get(bar.code) ?? []), bar]);
  return byCode;
}

async function loadDefenseRecovery(
  db: Db,
  instrumentIds: string[],
  date: string,
): Promise<Map<string, { metric_date: string | null; metric_status: string | null; defense_recovery_ma10: number | null }>> {
  const rows = await db.query<{
    id: string;
    metric_date: string | null;
    metric_status: string | null;
    defense_recovery_ma10: number | null;
  }>(
    `SELECT instrument.id::text, metric.as_of_date::text AS metric_date,
            metric_run.status AS metric_status, metric.defense_recovery_ma10
       FROM market_instrument instrument
       LEFT JOIN LATERAL (
         SELECT current.as_of_date, current.defense_recovery_ma10, current.indicator_run_id
           FROM market_stock_character_metric current
          WHERE current.instrument_id = instrument.id AND current.as_of_date <= $2::date
          ORDER BY current.as_of_date DESC, current.computed_at DESC LIMIT 1
       ) metric ON true
       LEFT JOIN market_indicator_run metric_run ON metric_run.id = metric.indicator_run_id
      WHERE instrument.id = ANY($1::bigint[])`,
    [instrumentIds, date],
  );
  return new Map(rows.rows.map((row) => [row.id, {
    metric_date: row.metric_date,
    metric_status: row.metric_status,
    defense_recovery_ma10: row.defense_recovery_ma10,
  }]));
}

function evaluateRule(
  rule: StrategyScreenRule,
  rows: Array<RightSideSignalBar & LeftSideSignalBar & SwingSignalBar>,
  kind: string,
  defenseRecovery: { metric_date: string | null; metric_status: string | null; defense_recovery_ma10: number | null },
): RuleOutcome {
  const minBars = RULE_MIN_BARS[rule];
  const windowed = rows.slice(-minBars);
  if (windowed.length < minBars) {
    return { rule, status: "gap", reason: `该规则至少需要${minBars}根日线，当前${windowed.length}根；先用 fetch_market_data 批量补拉后重跑` };
  }
  if (rule === "trial") {
    if (windowed.some((row) => row.volume === null || !Number.isFinite(row.volume) || row.volume <= 0)) {
      return { rule, status: "gap", reason: `近${minBars}根日线存在无效成交量` };
    }
    return { rule, status: "evaluated", evaluation: evaluateTrialStartSignal(windowed as TrialBar[]) };
  }
  if (rule === "swing") {
    if (!["stock", "etf"].includes(kind)) {
      return { rule, status: "gap", reason: "波段四条件仅适用于个股或ETF" };
    }
    if (kind === "stock" &&
      (defenseRecovery.metric_status !== "success" || defenseRecovery.defense_recovery_ma10 === null)) {
      return {
        rule,
        status: "gap",
        reason: "缺少可信的股性护盘收回率（该标的未入池生成画像或画像未成功）；正式口径经 pool_onboard 入池后获得",
      };
    }
    const evaluation = evaluateSwingSignal(windowed as SwingSignalBar[], kind, defenseRecovery.defense_recovery_ma10);
    if (!evaluation) {
      return { rule, status: "gap", reason: "波段四条件缺少可信RSI14/OHLCV输入" };
    }
    return { rule, status: "evaluated", evaluation, metric_date: defenseRecovery.metric_date };
  }
  if (rule === "short_right") {
    const evaluation = evaluateRightSideSignal(windowed as RightSideSignalBar[]);
    if (!evaluation) return { rule, status: "gap", reason: "右侧六条件缺少可信MA/MACD/OHLCV输入" };
    return { rule, status: "evaluated", evaluation };
  }
  const evaluation = evaluateLeftSideSignal(windowed as LeftSideSignalBar[]);
  if (!evaluation) return { rule, status: "gap", reason: "左侧反转缺少可信RSI14/MA20/OHLCV或ATR14输入" };
  return { rule, status: "evaluated", evaluation };
}

export async function queryStrategyScreen(
  pool: pg.Pool,
  request: StrategyScreenRequest,
  deps: { recomputeIndicator?: (dirty: { instrument_id: string; freq: "day"; generation: string }) => Promise<IndicatorRunResult> } = {},
): Promise<StrategyScreenResult> {
  const codes = [...new Set(request.codes.map((code) => code.toUpperCase()))];
  const rules = [...new Set(request.rules)];
  const dataGaps: StrategyScreenResult["data_gaps"] = [];
  const instruments = await pool.query<InstrumentRow>(
    `SELECT id::text, code, name, kind FROM market_instrument WHERE code = ANY($1::text[])`,
    [codes],
  );
  const byCode = new Map(instruments.rows.map((row) => [row.code, row]));
  for (const code of codes) {
    if (!byCode.has(code)) {
      dataGaps.push({
        code,
        rule: null,
        reason: "市场目录中不存在该标的；先用 fetch_market_data 补拉行情或核对代码",
      });
    }
  }
  const stockRows = instruments.rows.filter((row) => row.kind === "stock");
  for (const row of instruments.rows.filter((item) => item.kind !== "stock")) {
    dataGaps.push({ code: row.code, rule: null, reason: `筛选仅支持 A 股个股，该标的 kind=${row.kind}` });
  }

  const indicatorFailures = await recomputeDirtyIndicators(pool, stockRows.map((row) => row.id), deps);
  const window = Math.max(...rules.map((rule) => RULE_MIN_BARS[rule]));
  const barsByCode = await loadBars({ query: pool.query.bind(pool) }, stockRows.map((row) => row.id), request.date, window);
  const defenseByInstrument = rules.includes("swing")
    ? await loadDefenseRecovery({ query: pool.query.bind(pool) }, stockRows.map((row) => row.id), request.date)
    : new Map<string, { metric_date: string | null; metric_status: string | null; defense_recovery_ma10: number | null }>();

  const items: StrategyScreenResultItem[] = stockRows.map((instrument) => {
    const rows = barsByCode.get(instrument.code) ?? [];
    const indicatorFailure = indicatorFailures.get(instrument.id);
    const ruleOutcomes: RuleOutcome[] = rules.map((rule) => {
      if (indicatorFailure && rule !== "trial") {
        return { rule, status: "gap", reason: indicatorFailure };
      }
      return evaluateRule(
        rule,
        rows,
        instrument.kind,
        defenseByInstrument.get(instrument.id) ?? {
          metric_date: null,
          metric_status: null,
          defense_recovery_ma10: null,
        },
      );
    });
    for (const outcome of ruleOutcomes) {
      if (outcome.status === "gap") dataGaps.push({ code: instrument.code, rule: outcome.rule, reason: outcome.reason });
    }
    return {
      code: instrument.code,
      name: instrument.name,
      kind: instrument.kind,
      latest_bar_date: rows.at(-1)?.bar_date ?? null,
      rules: ruleOutcomes,
    };
  });

  return {
    requested_date: request.date,
    rules,
    code_count: codes.length,
    status: dataGaps.length === 0 ? "success" : "partial",
    notice:
      "参考口径：逐只条件布尔与证据，不产生 signal_grade，不做“右侧>左侧>试盘”唯一信号合并，也不评估大盘环境门禁；正式口径经 pool_onboard 入池后由每日计划产出。",
    instruction:
      dataGaps.some((gap) => gap.reason.includes("fetch_market_data") || gap.reason.includes("根日线"))
        ? "存在缺日线的标的：先用 fetch_market_data 批量补拉（勿逐只调用）后按相同参数重跑本筛选。"
        : "全部标的已完成评估或明确缺口。",
    items,
    data_gaps: dataGaps,
  };
}
