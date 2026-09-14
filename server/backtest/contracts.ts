import crypto from "node:crypto";
import { Type, type Static, validateToolArguments } from "@earendil-works/pi-ai";

export const STANDARD_ENGINE_VERSION = "standard-daily-v3";
export const STANDARD_INPUT_VERSION = "standard-input-v2";
export const STANDARD_MAX_CODES = 1000;
export const STANDARD_MAX_ROWS = 3_000_000;
export const STANDARD_CHUNK_BYTES = 8 * 1024 * 1024;
const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
const date = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const bps = Type.Number({ minimum: 0, maximum: 1000 });

export const PRICE_RULE_IDS = ["right_side_daily_v1", "left_reversal_daily_v1", "trial_start_daily_v1", "swing_box_daily_v1"] as const;
export type PriceRuleId = (typeof PRICE_RULE_IDS)[number];
export const STANDARD_RULE_IDS = [...PRICE_RULE_IDS, "portfolio_daily_v1"] as const;
export type StandardRuleId = (typeof STANDARD_RULE_IDS)[number];
const priceRuleSchema = Type.Union([
  Type.Literal("right_side_daily_v1"),
  Type.Literal("left_reversal_daily_v1"),
  Type.Literal("trial_start_daily_v1"),
  Type.Literal("swing_box_daily_v1"),
]);
/** 震荡过滤器：单因素消融或组合；因子取值缺失时该因素不触发，不放大限制。 */
export const StandardOscillationFilterSchema = object({
  composite_slope_band: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 0.1 })),
  near_ma20_band: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 0.5 })),
  adx_max: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })),
  breadth_max: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
  require_all: Type.Boolean(),
  oscillating_daily_buy_limit: Type.Integer({ minimum: 0, maximum: 100 }),
});
export type StandardOscillationFilter = Static<typeof StandardOscillationFilterSchema>;
/** 左侧反转研究放宽参数：只放宽超卖深度类条件，形态（缩量长下影/优质止跌）保持生产口径。 */
export const StandardLeftReversalParamsSchema = object({
  five_day_decline_pct: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 0.3 })),
  rsi_max: Type.Optional(Type.Number({ exclusiveMinimum: 10, maximum: 70 })),
  ma20_deviation_pct: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 0.3 })),
});
export type StandardLeftReversalParams = Static<typeof StandardLeftReversalParamsSchema>;
/** 绝对动量闸门（MOP 2012）：综合指数 N 日收益低于阈值时停止新开仓，持仓仍由退出规则管理。 */
export const StandardAbsoluteMomentumSchema = object({
  days: Type.Integer({ minimum: 5, maximum: 250 }),
  min_return: Type.Number({ minimum: -0.5, maximum: 0.5 }),
});
export type StandardAbsoluteMomentum = Static<typeof StandardAbsoluteMomentumSchema>;
/** 残差动量（Blitz 2011 简化）：个股 N 日收益减基准（所在行业，缺省综合指数）同窗收益，过滤低超额候选。 */
export const StandardResidualMomentumSchema = object({
  days: Type.Integer({ minimum: 5, maximum: 250 }),
  min_value: Type.Number({ minimum: -1, maximum: 1 }),
});
export type StandardResidualMomentum = Static<typeof StandardResidualMomentumSchema>;
/** 右侧信号研究消融参数：部分确认门槛、条件屏蔽与触发阈值覆盖（缺省=生产口径完全一致）。 */
export const StandardRightSideParamsSchema = object({
  min_passed_count: Type.Optional(Type.Integer({ minimum: 3, maximum: 6 })),
  disable_conditions: Type.Optional(Type.Array(Type.Union([
    Type.Literal("dif_positive"), Type.Literal("ma20_rising"), Type.Literal("macd_accelerating"),
    Type.Literal("bullish_alignment"), Type.Literal("bullish_body"), Type.Literal("volume_expanding"),
  ]), { maxItems: 5 })),
  macd_delta_min: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 0.01 })),
  volume_ratio_min: Type.Optional(Type.Number({ minimum: 0.5, maximum: 3 })),
  body_min_pct: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 0.1 })),
});
export type StandardRightSideParams = Static<typeof StandardRightSideParamsSchema>;
/** 右侧退出模型：simple=固定止损+可选一档止盈+时间兜底；production_tiered=生产§2分档全量；
 *  profit_trail=只保留分批止盈与移动止损（去掉时间兜底/崩坏复核造成的换手），让盈利单奔跑。 */
const exitModel = Type.Union([Type.Literal("simple"), Type.Literal("production_tiered"), Type.Literal("profit_trail")]);
export type StandardExitModel = Static<typeof exitModel>;
export const StandardStrategyPlanSchema = object({
  rule: priceRuleSchema,
  codes: Type.Array(Type.String({ pattern: "^\\d{6}\\.(SH|SZ)$" }), { minItems: 1, maxItems: STANDARD_MAX_CODES }),
  allocation_pct: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
  max_positions: Type.Integer({ minimum: 1, maximum: 100 }),
  daily_buy_limit: Type.Integer({ minimum: 1, maximum: 100 }),
  position_fraction: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
  stop_loss_pct: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 0.5 })),
  max_holding_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 2520 })),
  defense_recovery_ma10: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  exit_model: Type.Optional(exitModel),
  left_reversal_params: Type.Optional(StandardLeftReversalParamsSchema),
});
export type StandardStrategyPlan = Static<typeof StandardStrategyPlanSchema>;
/** 单规则兼容 + 组合容器；单策略等价于一条 strategy 的 portfolio。 */
export const StandardBacktestPlanSchema = object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  hypothesis: Type.String({ minLength: 1, maxLength: 2000 }),
  codes: Type.Array(Type.String({ pattern: "^\\d{6}\\.(SH|SZ)$" }), { minItems: 1, maxItems: STANDARD_MAX_CODES }),
  benchmark_code: Type.Optional(Type.String({ pattern: "^\\d{6}\\.(SH|SZ)$" })),
  start: date,
  end: date,
  rule: Type.Union([
    Type.Literal("right_side_daily_v1"),
    Type.Literal("left_reversal_daily_v1"),
    Type.Literal("trial_start_daily_v1"),
    Type.Literal("swing_box_daily_v1"),
    Type.Literal("portfolio_daily_v1"),
  ]),
  strategies: Type.Optional(Type.Array(StandardStrategyPlanSchema, { minItems: 1, maxItems: 10 })),
  defense_recovery_ma10: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  oscillation_filter: Type.Optional(StandardOscillationFilterSchema),
  breadth_confirm_min: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
  left_reversal_params: Type.Optional(StandardLeftReversalParamsSchema),
  environment_mode: Type.Union([Type.Literal("none"), Type.Literal("current_881"), Type.Literal("synthetic_881")]),
  /** 环境序列在正式窗口前的预热交易日数；缺省 20（MA20/斜率）。研究实验用长窗口动量闸门时需显式加大。 */
  environment_warmup_days: Type.Optional(Type.Integer({ minimum: 20, maximum: 300 })),
  price_mode: Type.Union([Type.Literal("raw_research"), Type.Literal("forward_research")]),
  initial_cash: Type.Number({ minimum: 100, maximum: 100_000_000, multipleOf: 0.01 }),
  max_positions: Type.Integer({ minimum: 1, maximum: 100 }),
  daily_buy_limit: Type.Integer({ minimum: 1, maximum: 100 }),
  position_fraction: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
  stop_loss_pct: Type.Number({ exclusiveMinimum: 0, maximum: 0.5 }),
  take_profit_pct: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
  exit_model: Type.Optional(exitModel),
  right_side_params: Type.Optional(StandardRightSideParamsSchema),
  /** 转弱退出抗洗盘缓冲：收盘跌破 MA10 需超过该幅度才触发转弱（0=跌破即走，生产口径）。 */
  weakness_ma10_buffer: Type.Optional(Type.Number({ minimum: 0, maximum: 0.3 })),
  /** 转弱缓冲的 regime 条件化：881 宽度强（洗盘期容忍深缓冲）用 strong、宽度弱（防守期）用 weak（0=跌破即走）。 */
  adaptive_weakness_buffer: Type.Optional(object({
    strong: Type.Number({ minimum: 0, maximum: 0.3 }),
    weak: Type.Number({ minimum: 0, maximum: 0.3 }),
    breadth_threshold: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
  })),
  /** 门禁 regime 条件化：881 上涨行业占比>=0.6（宽度强）用 strong 上限，否则收紧到 weak。 */
  adaptive_open_gap: Type.Optional(object({
    strong: Type.Number({ minimum: 0, maximum: 0.2 }),
    weak: Type.Number({ minimum: 0, maximum: 0.2 }),
    breadth_threshold: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
  })),
  max_holding_days: Type.Integer({ minimum: 1, maximum: 2520 }),
  min_amplitude_20: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 0.5 })),
  max_open_gap_pct: Type.Optional(Type.Number({ minimum: 0, maximum: 0.2 })),
  near_52w_high_min: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
  absolute_momentum: Type.Optional(StandardAbsoluteMomentumSchema),
  residual_momentum: Type.Optional(StandardResidualMomentumSchema),
  vol_target_sigma: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 0.2 })),
  drawdown_scale_max: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 0.5 })),
  industry_groups: Type.Optional(Type.Array(object({
    board: Type.String({ minLength: 1, maxLength: 20 }),
    codes: Type.Array(Type.String({ pattern: "^\\d{6}\\.(SH|SZ)$" }), { minItems: 1 }),
  }), { minItems: 1, maxItems: 90 })),
  industry_momentum: Type.Optional(object({
    days: Type.Integer({ minimum: 5, maximum: 250 }),
    top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
  })),
  drawdown_circuit: Type.Boolean(),
  drawdown_circuit_pct: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 0.5 })),
  stop_streak_circuit: Type.Boolean(),
  costs: object({
    label: Type.String({ minLength: 1, maxLength: 100 }),
    commission_bps: bps,
    minimum_commission: Type.Number({ minimum: 0, maximum: 10000, multipleOf: 0.01 }),
    sell_tax_bps: bps,
    slippage_bps: bps,
    volume_participation: Type.Number({ exclusiveMinimum: 0, maximum: 0.1 }),
  }),
});
export type StandardBacktestPlan = Static<typeof StandardBacktestPlanSchema>;
export type StandardExecutionStatus = "queued" | "preparing" | "running" | "success" | "failed" | "cancelled" | "rejected";
export interface BacktestGap {
  code: "DATA_MISSING" | "POINT_IN_TIME_UNVERIFIED" | "RULE_UNSUPPORTED" | "CAPACITY_EXCEEDED" | "DATA_INVALID";
  domain: string;
  severity: "error" | "warning";
  message: string;
  instrument?: string;
  date?: string;
}

export function canonicalJson(value: unknown): string {
  function normalize(input: unknown): unknown {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object" && Object.getPrototypeOf(input) === Object.prototype) {
      return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, normalize(entry)]));
    }
    throw new Error("标准回测只接受有限 JSON 数据");
  }
  return JSON.stringify(normalize(value));
}
export const contentHash = (value: unknown): string => crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");

export function validateStandardPlan(input: unknown): StandardBacktestPlan {
  if (Buffer.byteLength(canonicalJson(input)) > 32 * 1024) throw new Error("标准回测计划超过 32 KiB");
  // 校验器不得修改调用方对象；不采用模型自行声明的 schema/规则实现。
  let parsed: StandardBacktestPlan;
  try {
    parsed = validateToolArguments(
      { name: "standard_backtest", description: "标准化日频回测", parameters: StandardBacktestPlanSchema },
      { type: "toolCall", id: "standard-validation", name: "standard_backtest", arguments: structuredClone(input) as Record<string, unknown> },
    ) as StandardBacktestPlan;
  } catch {
    throw new Error("标准回测参数不符合严格契约");
  }
  const isPortfolio = parsed.rule === "portfolio_daily_v1";
  if (isPortfolio) {
    const strategies = parsed.strategies;
    if (strategies === undefined || strategies.length === 0) throw new Error("组合回测必须提供 strategies");
    const allCodes = new Set<string>();
    let sumMaxPositions = 0;
    let sumDailyBuyLimit = 0;
    let sumAllocation = 0;
    for (const strategy of strategies) {
      for (const code of strategy.codes) {
        if (allCodes.has(code)) throw new Error("组合内同一标的不得重复分配给多个策略");
        allCodes.add(code);
      }
      if (strategy.max_positions !== Math.min(strategy.max_positions, strategy.codes.length)) throw new Error("策略持仓数不得超过该策略标的数");
      if (strategy.daily_buy_limit !== Math.min(strategy.daily_buy_limit, strategy.max_positions)) throw new Error("策略每日买入上限不得超过该策略持仓上限");
      sumMaxPositions += strategy.max_positions;
      sumDailyBuyLimit += strategy.daily_buy_limit;
      sumAllocation += strategy.allocation_pct;
    }
    if (sumAllocation > Math.min(sumAllocation, 1)) throw new Error("组合策略分配比例之和不得超过 1");
    if (sumMaxPositions !== Math.min(sumMaxPositions, 100)) throw new Error("组合总持仓上限不得超过 100");
    parsed.codes = [...allCodes].sort();
    parsed.max_positions = sumMaxPositions;
    parsed.daily_buy_limit = sumDailyBuyLimit;
    parsed.position_fraction = 1;
  } else if (parsed.strategies !== undefined && parsed.strategies.length !== 0) {
    throw new Error("单规则计划不得携带 strategies");
  }
  for (const value of [parsed.start, parsed.end]) {
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || Number(value.slice(0, 4)) < 1906 || new Date(timestamp).toISOString().slice(0, 10) !== value) throw new Error("回测日期非法");
  }
  if (parsed.oscillation_filter !== undefined || parsed.breadth_confirm_min !== undefined) {
    if (parsed.rule !== "right_side_daily_v1") throw new Error("震荡过滤器与宽度确认仅支持右侧单规则研究");
    if (parsed.environment_mode === "none") throw new Error("震荡过滤器与宽度确认依赖881市场因子，必须选择881环境");
    const filter = parsed.oscillation_filter;
    if (filter && ![filter.composite_slope_band, filter.near_ma20_band, filter.adx_max, filter.breadth_max]
        .some(value => value !== undefined)) throw new Error("震荡过滤器必须至少定义一个判定因素");
    if (filter && filter.oscillating_daily_buy_limit > parsed.daily_buy_limit) throw new Error("震荡期买入上限不得超过常规每日买入上限");
  }
  if (parsed.start > parsed.end || new Set(parsed.codes).size !== parsed.codes.length) throw new Error("回测区间或重复标的非法");
  if (parsed.benchmark_code && parsed.codes.includes(parsed.benchmark_code)) throw new Error("基准不能兼作交易标的");
  if (parsed.max_positions > parsed.codes.length || parsed.daily_buy_limit > parsed.max_positions) throw new Error("持仓数量和每日买入上限不一致");
  if (parsed.left_reversal_params !== undefined && parsed.rule !== "left_reversal_daily_v1") {
    throw new Error("左侧放宽参数仅支持左侧反转单规则研究");
  }
  if (parsed.exit_model !== undefined && parsed.rule !== "right_side_daily_v1") throw new Error("退出模型仅右侧单规则研究支持");
  if (parsed.right_side_params !== undefined && parsed.rule !== "right_side_daily_v1") throw new Error("右侧信号消融参数仅右侧单规则研究支持");
  if (parsed.right_side_params?.min_passed_count !== undefined) {
    const active = 6 - (parsed.right_side_params.disable_conditions?.length ?? 0);
    if (parsed.right_side_params.min_passed_count > active) throw new Error("部分确认门槛不得超过启用条件数");
  }
  if (parsed.exit_model === "production_tiered" && parsed.take_profit_pct !== undefined) {
    throw new Error("生产分档退出模型已含分批止盈，不与一档止盈并用");
  }
  if ((parsed.min_amplitude_20 !== undefined || parsed.max_open_gap_pct !== undefined) && parsed.rule !== "right_side_daily_v1") {
    throw new Error("股性过滤与开盘缺口上限仅右侧单规则研究支持");
  }
  if ((parsed.near_52w_high_min !== undefined || parsed.vol_target_sigma !== undefined || parsed.drawdown_scale_max !== undefined)
      && parsed.rule !== "right_side_daily_v1") {
    throw new Error("52周高位/波动率目标/回撤缩仓仅右侧单规则研究支持");
  }
  if (parsed.weakness_ma10_buffer !== undefined && parsed.rule !== "right_side_daily_v1") throw new Error("抗洗盘缓冲仅右侧单规则研究支持");
  if (parsed.adaptive_weakness_buffer !== undefined) {
    if (parsed.rule !== "right_side_daily_v1") throw new Error("转弱缓冲regime条件化仅右侧单规则研究支持");
    if (parsed.environment_mode === "none") throw new Error("转弱缓冲regime条件化依赖881宽度因子，必须选择881环境");
    if (parsed.weakness_ma10_buffer !== undefined) throw new Error("转弱缓冲与其regime条件化版本不得同时设置");
  }
  if (parsed.adaptive_open_gap !== undefined) {
    if (parsed.rule !== "right_side_daily_v1") throw new Error("门禁regime条件化仅右侧单规则研究支持");
    if (parsed.environment_mode === "none") throw new Error("门禁regime条件化依赖881宽度因子，必须选择881环境");
    if (parsed.adaptive_open_gap.weak > parsed.adaptive_open_gap.strong) throw new Error("弱市门禁不得宽于强市门禁");
  }
  if (parsed.absolute_momentum !== undefined || parsed.residual_momentum !== undefined) {
    if (parsed.rule !== "right_side_daily_v1") throw new Error("绝对动量与残差动量仅右侧单规则研究支持");
    if (parsed.environment_mode === "none") throw new Error("绝对动量与残差动量依赖综合指数环境因子，必须选择881环境");
  }
  if (parsed.industry_groups !== undefined || parsed.industry_momentum !== undefined) {
    if (parsed.rule !== "right_side_daily_v1") throw new Error("行业动量闸门仅右侧单规则研究支持");
    if (parsed.environment_mode === "none") throw new Error("行业动量闸门依赖881行业日线，必须选择881环境");
    if (parsed.industry_groups === undefined || parsed.industry_momentum === undefined) {
      // 行业分组可单独存在（仅作为残差动量的行业基准）；行业动量闸门本身必须两者齐备。
      if (parsed.industry_groups === undefined) throw new Error("行业动量闸门必须同时提供 industry_groups 与 industry_momentum");
      if (parsed.industry_momentum === undefined && parsed.residual_momentum === undefined) {
        throw new Error("行业分组仅服务于行业闸门或残差动量基准，必须至少启用其一");
      }
    }
    if (parsed.industry_groups.length > 90) throw new Error("行业分组不得超过 90 个");
    const known = new Set(parsed.codes);
    const grouped = new Set<string>();
    for (const group of parsed.industry_groups) {
      for (const code of group.codes) {
        if (!known.has(code)) throw new Error("行业分组包含未在计划标的中的代码");
        if (grouped.has(code)) throw new Error("行业分组内同一标的重复出现");
        grouped.add(code);
      }
    }
    if (parsed.industry_momentum?.top_k !== undefined && parsed.industry_groups.length < parsed.industry_momentum.top_k) {
      throw new Error("行业动量 top_k 不得超过行业分组数");
    }
  }
  if (parsed.take_profit_pct !== undefined && parsed.rule !== "right_side_daily_v1") throw new Error("一档止盈仅右侧内核实现");
  if (parsed.drawdown_circuit_pct !== undefined && (!parsed.drawdown_circuit || !(parsed.rule === "right_side_daily_v1" || parsed.rule === "portfolio_daily_v1"))) {
    throw new Error("回撤熔断阈值仅可与右侧或组合回撤熔断同时启用");
  }
  if ((parsed.drawdown_circuit || parsed.stop_streak_circuit) && !(parsed.rule === "right_side_daily_v1" || parsed.rule === "portfolio_daily_v1")) {
    throw new Error("回撤与连止损熔断仅右侧与组合内核实现");
  }
  if ((parsed.drawdown_circuit || parsed.stop_streak_circuit) && parsed.environment_mode === "none") throw new Error("熔断恢复必须显式选择881环境输入");
  if (isPortfolio) {
    for (const strategy of parsed.strategies!) {
      if (strategy.exit_model !== undefined && strategy.rule !== "right_side_daily_v1") throw new Error("组合内退出模型仅右侧策略可设置");
      if (strategy.left_reversal_params !== undefined && strategy.rule !== "left_reversal_daily_v1") throw new Error("组合内左侧放宽参数仅左侧策略可设置");
    }
  }
  if (!parsed.name.trim() || !parsed.hypothesis.trim() || !parsed.costs.label.trim()) throw new Error("回测名称、假设及费用说明不能为空");
  return { ...parsed, name: parsed.name.trim(), hypothesis: parsed.hypothesis.trim(), codes: [...parsed.codes].sort(), costs: { ...parsed.costs, label: parsed.costs.label.trim() } };
}

/** 统一六年种子；日期减年按月底截断，避免闰日溢出。 */
export function standardSeedStart(start: string): string {
  const year = Number(start.slice(0, 4)) - 6;
  const month = Number(start.slice(5, 7));
  const day = Math.min(Number(start.slice(8, 10)), new Date(Date.UTC(year, month, 0)).getUTCDate());
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface StandardBar {
  code: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
/** 由冻结输入在环境起始日后逐日派生的市场因子；缺失因子为 null，不回填估计值。 */
export interface StandardMarketFactors {
  composite_close: number;
  composite_ma20: number | null;
  composite_slope: number | null;
  industry_rising_ratio: number | null;
  industry_adx14_median: number | null;
}
export interface StandardDay {
  /** 仅当日收盘阶段可用；缺失不得恢复开仓。 */
  market_recovery: boolean | null;
  market_factors?: StandardMarketFactors;
  environment_bars?: StandardBar[];
  benchmark?: {code: string; close: number};
  date: string;
  bars: StandardBar[];
}
export interface StandardInputManifest {
  version: typeof STANDARD_INPUT_VERSION;
  data_request_hash: string;
  environment_codes: string[];
  benchmark_code?: string;
  seed_start: string;
  start: string;
  end: string;
  codes: string[];
  row_count: number;
  day_count: number;
  chunks: Array<{ date: string; sha256: string; bytes: number; rows: number }>;
  gaps: BacktestGap[];
}
export interface StandardEvent {
  seq: number;
  date: string;
  type: "signal" | "suppressed" | "order" | "rejected" | "expired" | "fill" | "closed" | "risk_trigger" | "risk_recover";
  code: string | null;
  reason: string;
  details: Record<string, string | number | boolean | null>;
}
export interface StandardEquity {
  benchmark_close?: number;
  benchmark_equity_cents?: number;
  benchmark_return?: number;
  date: string;
  cash_cents: number;
  market_value_cents: number;
  equity_cents: number;
  fees_cents: number;
  daily_return: number;
  drawdown: number;
  paused: boolean;
  positions: Array<{ code: string; quantity: number; cost_cents: number; close: number }>;
}
export interface StandardDayResult { events: StandardEvent[]; equity: StandardEquity | null }
export interface StandardEngine {
  next(day: StandardDay): StandardDayResult;
  finish(): Record<string, number | null>;
  /** 组合层风控命令：暂停/恢复全部新开仓，退出不受限；未实现的子引擎可不提供。 */
  control?(command: { paused: boolean }): void;
}
