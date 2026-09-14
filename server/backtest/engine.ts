import { calculateIndicators, type IndicatorPoint } from "../indicators/formulas.js";
import { evaluateRightSideSignal, type RightSideSignalBar, type RightSideSignalEvaluation } from "../modules/plans/right-side-rule.js";
import {
  standardSeedStart, validateStandardPlan,
  type StandardBacktestPlan, type StandardBar, type StandardDay, type StandardDayResult,
  type StandardEngine, type StandardEquity, type StandardEvent, type StandardMarketFactors,
} from "./contracts.js";

const LOT = 100;
const PRICE_SCALE = 1_000_000;
type ExitReason = "stop_loss" | "take_profit" | "max_holding_days"
  | "cooldown_stop" | "technical_stop" | "trailing_stop"
  | "weakness_exit" | "review_exit" | "time_fallback"
  | "tier1_take_profit" | "tier2_take_profit";
/** 计入连止损熔断的退出原因：只有策略止损类闭环累计，普通亏损与止盈不累计。 */
export const STOP_EXIT_REASONS: ReadonlySet<string> = new Set(["stop_loss", "cooldown_stop", "technical_stop", "trailing_stop"]);
interface History {
  count: number;
  closes: number[];
  volumes: number[];
  sums: number[];
  fast: number | null;
  slow: number | null;
  dea: number | null;
  rows: RightSideSignalBar[];
  amplitudes: number[];
  longCloses: number[];
}
interface Position {
  quantity: number;
  initialQuantity: number;
  cost: number;
  entryPrice: number;
  entryDay: number;
  realized: number;
  firstScaled: boolean;
  secondScaled: boolean;
}
interface SellIntent { reason: ExitReason; quantity: number | null }

/** 与生产相同的起点、运算次序、有效样本数；只递推右侧规则实际使用的指标。 */
function advance(history: History, bar: StandardBar): void {
  const { closes, sums } = history;
  for (const [index, window] of [5, 10, 20].entries()) {
    sums[index] = sums[index]! + bar.close;
    if (history.count >= window) sums[index]! -= closes.at(-window)!;
  }
  history.count += 1;
  history.fast = history.fast === null ? bar.close : (2 / 13) * bar.close + (1 - 2 / 13) * history.fast;
  history.slow = history.slow === null ? bar.close : (2 / 27) * bar.close + (1 - 2 / 27) * history.slow;
  const dif = history.count < 26 ? null : history.fast - history.slow;
  if (dif !== null) history.dea = history.dea === null ? dif : (2 / 10) * dif + (1 - 2 / 10) * history.dea;
  closes.push(bar.close);
  let point: Pick<IndicatorPoint, "ma5" | "ma10" | "ma20" | "dif" | "macdHist">;
  if (history.count <= 34) {
    // 有界启动段复用生产公式：每标的最多 34 次，之后每日 O(1)，不截短 EMA 六年种子。
    point = calculateIndicators(closes).at(-1)!;
  } else {
    point = { ma5: sums[0]! / 5, ma10: sums[1]! / 10, ma20: sums[2]! / 20,
      dif, macdHist: dif! - history.dea! };
  }
  if (closes.length > 34) closes.shift();
  history.volumes.push(bar.volume);
  if (history.volumes.length > 20) history.volumes.shift();
  // 已实现振幅（当日高低价相对收盘）滚动 20 根：股性过滤用时点安全数据，仅用截至当日的行情。
  history.amplitudes.push((bar.high - bar.low) / bar.close);
  if (history.amplitudes.length > 20) history.amplitudes.shift();
  history.longCloses.push(bar.close);
  if (history.longCloses.length > 252) history.longCloses.shift();
  history.rows.push({ ...bar, bar_date: bar.date, ma5: point.ma5, ma10: point.ma10,
    ma20: point.ma20, dif: point.dif, macd_hist: point.macdHist,
    indicator_status: point.macdHist === null ? null : "ready" });
  if (history.rows.length > 5) history.rows.shift();
}

function safeInteger(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error("研究账本金额或数量超出安全整数范围");
  return value;
}
function priceUnits(value: number): number { return safeInteger(Math.round(value * PRICE_SCALE)); }
function notional(price: number, quantity: number): number {
  // 微元价格 × 整数股数，逐笔四舍五入至分；不先把单股价格截成分。
  return safeInteger(Number((BigInt(price) * BigInt(quantity) + 5_000n) / 10_000n));
}
function exactKeys(value: unknown, keys: string[]): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
/**
 * 震荡判定：只使用计划中显式定义的因素；因子缺失视为该因素未触发，不放大限制。
 * 生产排序分（MACD柱单日增量/收盘价）在 0.003 处封顶，与短线策略 §1.1 一致。
 */
export const PRODUCTION_RANK_CAP = 0.003;
export function evaluateOscillation(factors: StandardMarketFactors | null,
    filter: NonNullable<StandardBacktestPlan["oscillation_filter"]>): boolean {
  if (!factors) return false;
  const active: boolean[] = [];
  if (filter.composite_slope_band !== undefined) {
    active.push(factors.composite_slope !== null && Math.abs(factors.composite_slope) < filter.composite_slope_band);
  }
  if (filter.near_ma20_band !== undefined) {
    active.push(factors.composite_ma20 !== null && factors.composite_close > 0 &&
      Math.abs(factors.composite_close / factors.composite_ma20 - 1) <= filter.near_ma20_band);
  }
  if (filter.adx_max !== undefined) {
    active.push(factors.industry_adx14_median !== null && factors.industry_adx14_median < filter.adx_max);
  }
  if (filter.breadth_max !== undefined) {
    active.push(factors.industry_rising_ratio !== null && factors.industry_rising_ratio < filter.breadth_max);
  }
  if (!active.length) return false;
  return filter.require_all ? active.every(passed => passed) : active.some(passed => passed);
}
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/**
 * 固定样本日频研究模型：100 股单位、前收 ±10% 保守限制，不代表制度或公司行为资格。
 * 日期在六年种子至终点内且每日必须覆盖全部 codes；交易日历/整段种子覆盖由冻结输入层核验。
 * 开盘只消费 open 与先前状态；全日数据先做形状校验，不用于开盘资格、容量或预算。
 * 价格量化到微元，账本/手续费到分；fees_cents 为累计显式费用（滑点已进入成交价格）。
 * 收益和回撤为小数比例，drawdown/max_drawdown 为非负损失幅度；交易数只计完全闭环批次。
 */
export function createStandardEngine(input: StandardBacktestPlan): StandardEngine {
  const plan = validateStandardPlan(input);
  const seedStart = standardSeedStart(plan.start);
  const histories = new Map<string, History>(plan.codes.map((code) => [code, {
    count: 0, closes: [], volumes: [], sums: [0, 0, 0], fast: null, slow: null, dea: null, rows: [], amplitudes: [], longCloses: [],
  }]));
  const positions = new Map<string, Position>();
  const sells = new Map<string, SellIntent>();
  let buys: Array<{ code: string; budget: number; signalClose: number }> = [];
  const tieredExits = plan.exit_model === "production_tiered" || plan.exit_model === "profit_trail";
  let externallyPaused = false;
  const industryGate = plan.industry_momentum;
  const residualGate = plan.residual_momentum;
  const codeBoard = new Map<string, string>();
  if (industryGate || residualGate) {
    for (const group of plan.industry_groups ?? []) for (const code of group.codes) codeBoard.set(code, group.board);
    const gateDays = Math.max(industryGate?.days ?? 0, residualGate?.days ?? 0);
    if (gateDays > 240) throw new Error("行业动量窗口超过行业收盘缓存容量");
  }
  const boardCloses = new Map<string, number[]>();
  // 综合指数收盘序列：绝对动量闸门与残差动量的市场基准（参数上限 250 日 + 1，保留 251 根）。
  const compositeCloses: number[] = [];
  function trackComposite(day: StandardDay): void {
    const close = day.market_factors?.composite_close;
    if (typeof close !== "number" || !Number.isFinite(close) || close <= 0) return;
    compositeCloses.push(close);
    if (compositeCloses.length > 251) compositeCloses.shift();
  }
  const initialCash = safeInteger(Math.round(plan.initial_cash * 100));
  const minimumCommission = safeInteger(Math.round(plan.costs.minimum_commission * 100));
  let cash = initialCash;
  let fees = 0;
  let previousEquity = initialCash;
  let peak = initialCash;
  let maxDrawdown = 0;
  let tradeCount = 0;
  let wins = 0;
  let stopStreak = 0;
  let pausedSince: number | null = null;
  let dayIndex = -1;
  let lastDate: string | null = null;
  let seq = 0;
  let finished = false;
  const recentEquities: number[] = [];

  function validateDay(day: StandardDay): Map<string, StandardBar> {
    const dayKeys = ["date", "bars", "market_recovery"];
    if (day && Object.hasOwn(day, "benchmark")) dayKeys.push("benchmark");
    if (day && Object.hasOwn(day, "environment_bars")) dayKeys.push("environment_bars");
    if (day && Object.hasOwn(day, "market_factors")) dayKeys.push("market_factors");
    if (!exactKeys(day, dayKeys) || !validDate(day.date) ||
        (day.market_recovery !== true && day.market_recovery !== false && day.market_recovery !== null) ||
        day.date < seedStart || day.date > plan.end || (lastDate !== null && day.date <= lastDate) ||
        !Array.isArray(day.bars) || day.bars.length > plan.codes.length) {
      throw new Error("研究日输入日期、顺序、收盘恢复字段或完整日结构非法");
    }
    if (day.market_factors !== undefined) {
      const factors = day.market_factors;
      if (!exactKeys(factors, ["composite_close", "composite_ma20", "composite_slope", "industry_rising_ratio", "industry_adx14_median"]) ||
          typeof factors.composite_close !== "number" || !Number.isFinite(factors.composite_close) || factors.composite_close <= 0 ||
          [factors.composite_ma20, factors.composite_slope, factors.industry_rising_ratio, factors.industry_adx14_median]
            .some(value => value !== null && (typeof value !== "number" || !Number.isFinite(value)))) {
        throw new Error("市场因子结构或取值非法");
      }
    }
    if(day.benchmark && (!exactKeys(day.benchmark,["code","close"]) || day.benchmark.code!==plan.benchmark_code || !Number.isFinite(day.benchmark.close) || day.benchmark.close<=0)) throw new Error("基准日线非法");
    const bars = new Map<string, StandardBar>();
    for (const bar of day.bars) {
      if (!exactKeys(bar, ["code", "date", "open", "high", "low", "close", "volume"]) ||
          !histories.has(bar.code) || bars.has(bar.code) || bar.date !== day.date ||
          [bar.open, bar.high, bar.low, bar.close].some((price) =>
            typeof price !== "number" || !Number.isFinite(price) || price < 1 / PRICE_SCALE ||
            !Number.isSafeInteger(Math.round(price * PRICE_SCALE))) ||
          bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) ||
          !Number.isSafeInteger(bar.volume) || bar.volume <= 0) {
        throw new Error("研究日行情价格、成交量、标的、重复或未知 tick 字段非法");
      }
      bars.set(bar.code, { ...bar });
    }
    // 环境日线仅为冻结证据，不进入股票指标、成交或恢复推断；环境全集由 manifest 核验。
    if (Object.hasOwn(day, "environment_bars")) {
      if (!Array.isArray(day.environment_bars)) throw new Error("环境冻结证据必须为日线数组");
      const seen = new Set<string>();
      for (const bar of day.environment_bars) {
        if (!exactKeys(bar, ["code", "date", "open", "high", "low", "close", "volume"]) ||
            typeof bar.code !== "string" || !/^\d{6}\.[A-Z]{2,3}$/.test(bar.code) ||
            seen.has(bar.code) || histories.has(bar.code) || bar.date !== day.date ||
            [bar.open, bar.high, bar.low, bar.close].some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0) ||
            bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) ||
            typeof bar.volume !== "number" || !Number.isFinite(bar.volume) || bar.volume < 0) {
          throw new Error("环境冻结证据日期、重复标的或行情字段非法");
        }
        seen.add(bar.code);
      }
    }
    return bars;
  }
  function charges(gross: number, side: "buy" | "sell") {
    const commission = Math.max(minimumCommission, Math.round(gross * (plan.costs.commission_bps / 10_000)));
    const tax = side === "sell" ? Math.round(gross * (plan.costs.sell_tax_bps / 10_000)) : 0;
    return { commission, tax, total: safeInteger(commission + tax) };
  }

  /** 行业收盘序列跟踪：environment_bars 是每日冻结证据，行业闸门与残差动量的行业基准从中递推（最多保留 241 根）。 */
  function trackBoards(day: StandardDay): void {
    if ((!industryGate && !residualGate) || !day.environment_bars) return;
    for (const bar of day.environment_bars) {
      let closes = boardCloses.get(bar.code);
      if (!closes) { closes = []; boardCloses.set(bar.code, closes); }
      closes.push(bar.close);
      if (closes.length > 241) closes.shift();
    }
  }
  function industryEligible(code: string): boolean {
    if (!industryGate) return true;
    const board = codeBoard.get(code);
    if (!board) return false;
    const gateDays = industryGate.days;
    const closes = boardCloses.get(board);
    if (!closes || closes.length < gateDays + 1) return false;
    const ranked = [...boardCloses.entries()]
      .filter(([, series]) => series.length >= gateDays + 1)
      .map(([name, series]) => ({ board: name, momentum: series.at(-1)! / series[series.length - 1 - gateDays]! - 1 }))
      .sort((a, b) => b.momentum - a.momentum || a.board.localeCompare(b.board));
    const index = ranked.findIndex(item => item.board === board);
    if (index < 0) return false;
    return industryGate.top_k === undefined ? ranked[index]!.momentum > 0 : index < industryGate.top_k;
  }

  /**
   * 生产§2分档退出（收盘判定，下一开盘执行）。研究近似：无股性数据，冷却期统一 3 个交易日，
   * 技术止损线取买入价×0.90（区间 0.88—0.95 的生产公式结果），MA5 保护位仅一档止盈后参与。
   */
  function tieredExitIntent(position: Position, code: string, close: number, dayIndex: number): SellIntent | null {
    const closeUnits = priceUnits(close);
    const gain = (closeUnits - position.entryPrice) / position.entryPrice;
    const holdingDays = dayIndex - position.entryDay + 1;
    const history = histories.get(code)!;
    const rows = history.rows;
    if (holdingDays <= 3) {
      // 冷却期内只使用买入价×0.88 的止损，不因均线或复核提前退出。
      return gain <= -0.12 ? { reason: "cooldown_stop", quantity: null } : null;
    }
    // 技术止损 = min(max(买入价×0.90, 买入价×0.88), 买入价×0.95) = 买入价×0.90；分档保护位与 MA5 取最高。
    let stopGain = -0.10;
    let trailing = false;
    for (const [threshold, protect] of [[0.5, 0.35], [0.3, 0.2], [0.15, 0.1], [0.08, 0.08]] as const) {
      if (gain >= threshold) { stopGain = Math.max(stopGain, protect); trailing = true; break; }
    }
    const currentRow = rows.at(-1)!;
    if (position.firstScaled && currentRow.ma5 !== null) {
      const ma5StopGain = (priceUnits(currentRow.ma5) * 0.99 - position.entryPrice) / position.entryPrice;
      if (ma5StopGain > stopGain) { stopGain = ma5StopGain; trailing = true; }
    }
    if (gain <= stopGain) return { reason: trailing ? "trailing_stop" : "technical_stop", quantity: null };
    if (!position.firstScaled && gain >= 0.12) {
      const base = position.initialQuantity >= 1500 ? Math.floor(position.initialQuantity / 3) : Math.floor(position.initialQuantity / 2);
      return { reason: "tier1_take_profit", quantity: Math.min(Math.max(LOT, Math.floor(base / LOT) * LOT), position.quantity) };
    }
    if (position.firstScaled && !position.secondScaled && gain >= 0.28) {
      const base = Math.floor(position.initialQuantity / 3);
      return { reason: "tier2_take_profit", quantity: Math.min(Math.max(LOT, Math.floor(base / LOT) * LOT), position.quantity) };
    }
    const previousRow = rows.at(-2);
    if (previousRow?.macd_hist !== null && previousRow?.macd_hist !== undefined && previousRow.macd_hist > 0 &&
        currentRow.macd_hist !== null && currentRow.macd_hist <= 0 &&
        currentRow.ma10 !== null && closeUnits < priceUnits(currentRow.ma10)) {
      return { reason: "weakness_exit", quantity: null };
    }
    // profit_trail 模型去掉时间兜底与崩坏复核（两者是分档全量模型换手的主要来源），保留盈利奔跑部分。
    if (plan.exit_model === "production_tiered" && !position.firstScaled) {
      const evaluation = evaluateRightSideSignal(rows);
      if (evaluation && evaluation.passed_count <= 2) return { reason: "review_exit", quantity: null };
      if (holdingDays >= 5) return { reason: "time_fallback", quantity: null };
    }
    return null;
  }

  return {
    control(command: { paused: boolean }): void {
      externallyPaused = command.paused;
    },
    next(day: StandardDay): StandardDayResult {
      if (finished) throw new Error("研究内核已结束，不接受后续交易日");
      // 完整校验先于任何状态写入，非法日可修正后重试。
      const bars = validateDay(day);
      lastDate = day.date;
      const events: StandardEvent[] = [];
      const emit = (type: StandardEvent["type"], code: string | null, reason: string,
        details: StandardEvent["details"] = {}) => events.push({ seq: ++seq, date: day.date, type, code, reason, details });
      if (day.date < plan.start) {
        for (const code of plan.codes) {
          const bar = bars.get(code);
          if (bar) advance(histories.get(code)!, bar);
        }
        trackBoards(day);
        trackComposite(day);
        return { events, equity: null };
      }
      dayIndex += 1;
      let newStopRisk = 0;

      function execution(code: string, side: "buy" | "sell"): { price: number; capacity: number } | null {
        const history = histories.get(code)!;
        const previous = history.rows.at(-1);
        const reject = (reason: string) => { emit("rejected", code, reason, { side }); return null; };
        if (!previous || history.volumes.length < 20) return reject("prior_volume_window_missing");
        const open = priceUnits(bars.get(code)!.open);
        const upper = Math.round(previous.close * 1.1 * 100) * 10_000;
        const lower = Math.round(previous.close * 0.9 * 100) * 10_000;
        if (open < lower || open > upper || (side === "buy" && open >= upper) || (side === "sell" && open <= lower)) {
          return reject("research_price_limit");
        }
        const price = safeInteger(Math.round(open * (1 + (side === "buy" ? 1 : -1) * plan.costs.slippage_bps / 10_000)));
        if (price <= 0 || price < lower || price > upper) return reject("slippage_outside_limit");
        const meanVolume = history.volumes.reduce((sum, volume) => sum + volume, 0) / 20;
        const capacity = safeInteger(Math.floor(meanVolume * plan.costs.volume_participation / LOT) * LOT);
        if (capacity < LOT) return reject("prior_volume_capacity");
        return { price, capacity };
      }

      // 卖单按风险优先、代码升序稳定执行；部分退出不形成闭环，剩余意图逐日有效。
      const exitOrders = [...sells].sort(([a, ra], [b, rb]) =>
        Number(STOP_EXIT_REASONS.has(rb.reason)) - Number(STOP_EXIT_REASONS.has(ra.reason)) || a.localeCompare(b));
      for (const [code, intent] of exitOrders) {
        // 停牌日无行情：卖出意图保留到复牌开盘执行。
        if (!bars.has(code)) continue;
        const position = positions.get(code)!;
        emit("order", code, intent.reason, { side: "sell", quantity: intent.quantity ?? position.quantity });
        const fill = execution(code, "sell");
        if (!fill) continue;
        const quantity = Math.min(intent.quantity ?? position.quantity, fill.capacity);
        if (quantity < LOT) continue;
        const gross = notional(fill.price, quantity);
        const fee = charges(gross, "sell");
        if (cash + gross < fee.total) {
          emit("rejected", code, "insufficient_cash_for_fees", { side: "sell" });
          continue;
        }
        const allocatedCost = Number((BigInt(position.cost) * BigInt(quantity) + BigInt(position.quantity) / 2n) / BigInt(position.quantity));
        cash = safeInteger(cash + gross - fee.total);
        fees = safeInteger(fees + fee.total);
        position.cost -= allocatedCost;
        position.quantity -= quantity;
        position.realized = safeInteger(position.realized + gross - fee.total - allocatedCost);
        if (intent.reason === "tier1_take_profit") position.firstScaled = true;
        if (intent.reason === "tier2_take_profit") position.secondScaled = true;
        emit("fill", code, intent.reason, { side: "sell", quantity, price: fill.price / PRICE_SCALE,
          gross_cents: gross, commission_cents: fee.commission, tax_cents: fee.tax, fees_cents: fee.total,
          allocated_cost_cents: allocatedCost, remaining_quantity: position.quantity });
        sells.delete(code);
        if (position.quantity === 0) {
          positions.delete(code);
          tradeCount += 1;
          if (position.realized > 0) wins += 1;
          const stopExit = STOP_EXIT_REASONS.has(intent.reason);
          stopStreak = stopExit ? stopStreak + 1 : 0;
          if (stopExit && stopStreak >= 3) newStopRisk = stopStreak;
          emit("closed", code, intent.reason, { pnl_cents: position.realized, quantity: position.initialQuantity, stop_streak: stopStreak });
        }
      }
      for (const order of buys) {
        const { code, budget, signalClose } = order;
        const expire = (reason: string, quantity = 0) => emit("expired", code, reason, { side: "buy", quantity });
        if (pausedSince !== null || externallyPaused || positions.has(code) || positions.size >= plan.max_positions) {
          emit("rejected", code, pausedSince !== null || externallyPaused ? "risk_paused" : "position_limit", { side: "buy" });
          expire("next_open_only");
          continue;
        }
        // 停牌日无开盘可成交，订单当日过期；生产口径“停牌均放弃”。
        if (!bars.has(code)) { expire("suspended_no_open"); continue; }
        // 短线策略§1.1：T+1开盘价高于T日收盘价5%时放弃建仓，不等待盘中回落。
        // 短线策略§1.1：T+1开盘价高于信号收盘5%（可由 max_open_gap_pct 收紧）时放弃建仓，不等待盘中回落。
        if (priceUnits(bars.get(code)!.open) > priceUnits(signalClose * (1 + (plan.max_open_gap_pct ?? 0.05)))) {
          expire("open_gap_above_cap");
          continue;
        }
        const fill = execution(code, "buy");
        if (!fill) { expire("next_open_only"); continue; }
        const limit = Math.min(cash, budget);
        const desired = safeInteger(Number(BigInt(budget) * 10_000n / (BigInt(fill.price) * BigInt(LOT))) * LOT);
        let low = 0;
        let high = Math.min(desired, fill.capacity) / LOT;
        // 二分按费用后现金缩量，避免低价/大订单逐手循环。
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          const gross = notional(fill.price, middle * LOT);
          if (gross + charges(gross, "buy").total <= limit) low = middle;
          else high = middle - 1;
        }
        const quantity = low * LOT;
        if (quantity === 0) {
          emit("rejected", code, "insufficient_cash_or_budget", { side: "buy", budget_cents: budget, cash_cents: cash });
          expire("next_open_only", desired);
          continue;
        }
        const gross = notional(fill.price, quantity);
        const fee = charges(gross, "buy");
        cash -= gross + fee.total;
        fees = safeInteger(fees + fee.total);
        positions.set(code, { quantity, initialQuantity: quantity, cost: gross + fee.total,
          entryPrice: fill.price, entryDay: dayIndex, realized: 0, firstScaled: false, secondScaled: false });
        emit("fill", code, "right_side_daily_v1", { side: "buy", quantity, price: fill.price / PRICE_SCALE,
          gross_cents: gross, commission_cents: fee.commission, tax_cents: fee.tax, fees_cents: fee.total });
        if (quantity < desired) expire("unfilled_remainder", desired - quantity);
      }
      buys = [];

      // 从这里开始才消费当日收盘、全日成交量和 market_recovery；停牌标的不推进指标序列。
      for (const code of plan.codes) {
        const bar = bars.get(code);
        if (bar) advance(histories.get(code)!, bar);
      }
      trackBoards(day);
      trackComposite(day);
      const snapshots: StandardEquity["positions"] = [];
      let marketValue = 0;
      for (const code of plan.codes) {
        const position = positions.get(code);
        if (!position) continue;
        // 停牌持仓按最后成交日收盘估值；只有当日有新收盘才做退出判定。
        const bar = bars.get(code);
        const close = bar ? bar.close : histories.get(code)!.rows.at(-1)!.close;
        marketValue = safeInteger(marketValue + notional(priceUnits(close), position.quantity));
        snapshots.push({ code, quantity: position.quantity, cost_cents: position.cost, close });
        if (!bar) continue;
        // 收盘判定：止损优先于止盈（保守顺序），止盈优先于时间兜底；全部下一开盘执行。
        let intent: SellIntent | null;
        if (tieredExits) {
          // 生产分档退出：冷却期→技术/移动止损→分批止盈→转弱→崩坏复核→时间兜底（短线策略§2）。
          intent = tieredExitIntent(position, code, close, dayIndex);
        } else {
          const reason = (position.entryPrice - priceUnits(close)) / position.entryPrice >= plan.stop_loss_pct
            ? "stop_loss"
            : (priceUnits(close) - position.entryPrice) / position.entryPrice >= (plan.take_profit_pct ?? Infinity)
              ? "take_profit"
              : dayIndex - position.entryDay + 1 >= plan.max_holding_days ? "max_holding_days" : null;
          intent = reason ? { reason, quantity: null } : null;
        }
        if (intent && (!sells.has(code) || STOP_EXIT_REASONS.has(intent.reason) || !STOP_EXIT_REASONS.has(sells.get(code)!.reason))) {
          sells.set(code, intent);
          emit("signal", code, intent.reason, { side: "sell", quantity: intent.quantity ?? position.quantity });
        }
      }
      const total = safeInteger(cash + marketValue);
      peak = Math.max(peak, total);
      const drawdown = (peak - total) / peak;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
      recentEquities.push(total);
      if (recentEquities.length > 20) recentEquities.shift();
      const recentPeak = Math.max(...recentEquities);
      // 回撤阈值默认5%（预案§3），可显式调整；严格大于才触发。
      const drawdownThresholdBps = BigInt(Math.round((plan.drawdown_circuit_pct ?? 0.05) * 10_000));
      const drawdownRisk = plan.drawdown_circuit && BigInt(recentPeak - total) * 10_000n > BigInt(recentPeak) * drawdownThresholdBps;
      const streakRisk = plan.stop_streak_circuit && newStopRisk >= 3;
      if (drawdownRisk || streakRisk) {
        if (pausedSince === null) pausedSince = dayIndex;
        if (drawdownRisk) emit("risk_trigger", null, "drawdown_circuit", { peak_cents: recentPeak, equity_cents: total });
        if (streakRisk) emit("risk_trigger", null, "stop_streak_circuit", { stop_streak: newStopRisk });
      } else if (pausedSince !== null && dayIndex > pausedSince && day.market_recovery === true) {
        pausedSince = null;
        stopStreak = 0;
        emit("risk_recover", null, "market_recovery", { stop_streak: stopStreak });
      }

      const candidates: Array<{ code: string; rank: number; signalClose: number; evidence: RightSideSignalEvaluation["evidence"]; passedCount: number }> = [];
      let evaluatedCount = 0;
      for (const code of plan.codes) {
        // 停牌标的无新收盘：不重算信号，也不重复emit旧状态。
        if (!bars.has(code)) continue;
        // 股性过滤：截至当日的 20 根已实现振幅均值不足者不进入候选（时点安全，无前视）。
        if (plan.min_amplitude_20 !== undefined) {
          const amplitudes = histories.get(code)!.amplitudes;
          if (amplitudes.length < 20) continue;
          const meanAmplitude = amplitudes.reduce((sum, value) => sum + value, 0) / amplitudes.length;
          if (meanAmplitude < plan.min_amplitude_20) continue;
        }
        // 52 周高位锚定（George-Hwang 2004）：现价距 52 周最高收盘过远不入场。
        if (plan.near_52w_high_min !== undefined) {
          const longCloses = histories.get(code)!.longCloses;
          if (longCloses.length < 252) continue;
          let high52 = 0;
          for (const value of longCloses) if (value > high52) high52 = value;
          if (bars.get(code)!.close / high52 < plan.near_52w_high_min) continue;
        }
        // 行业动量闸门（Moskowitz-Grinblatt 行业动量 + MOP 绝对动量）。
        if (!industryEligible(code)) continue;
        // 残差动量（Blitz 2011 简化，β=1）：个股 N 日收益须跑赢基准同窗收益；
        // 基准优先取个股所在行业序列，无分组或序列不足时回退综合指数，基准缺失则保守不放行。
        // 个股序列用 longCloses（252 根滚动）：closes 是 34 根有界启动窗口，仅供指标递推启动段使用。
        if (residualGate) {
          const closes = histories.get(code)!.longCloses;
          if (closes.length <= residualGate.days) continue;
          const stockReturn = closes.at(-1)! / closes[closes.length - 1 - residualGate.days]! - 1;
          const board = codeBoard.get(code);
          const boardSeries = board ? boardCloses.get(board) : undefined;
          let benchReturn: number | null = null;
          if (boardSeries && boardSeries.length > residualGate.days) {
            benchReturn = boardSeries.at(-1)! / boardSeries[boardSeries.length - 1 - residualGate.days]! - 1;
          } else if (compositeCloses.length > residualGate.days) {
            benchReturn = compositeCloses.at(-1)! / compositeCloses[compositeCloses.length - 1 - residualGate.days]! - 1;
          }
          if (benchReturn === null || stockReturn - benchReturn < residualGate.min_value) continue;
        }
        const signal = evaluateRightSideSignal(histories.get(code)!.rows);
        if (!signal) continue;
        evaluatedCount += 1;
        if (signal.price_signal) {
          candidates.push({ code, rank: Math.min(signal.evidence.macd_hist_delta_ratio, PRODUCTION_RANK_CAP),
            signalClose: signal.evidence.close, evidence: signal.evidence, passedCount: signal.passed_count });
        }
      }
      // 事件预算：只有排名前 100 的候选（覆盖全部可下单标的，daily_buy_limit ≤ 100）逐只记录，
      // 其余落选评估进汇总事件（架构规划§5.2：一般落选股票不逐只记录全套指标）。
      const detailBudget = 100;
      let emittedDetails = 0;
      candidates.sort((a, b) => b.rank - a.rank || a.code.localeCompare(b.code));
      // 震荡期同类限仓与大盘/板块宽度确认只作用于新开仓名额；因素取值缺失不放大限制，宽度确认缺失则不开新仓。
      const filter = plan.oscillation_filter;
      const oscillating = filter ? evaluateOscillation(day.market_factors ?? null, filter) : false;
      const dailyLimit = filter && oscillating ? Math.min(filter.oscillating_daily_buy_limit, plan.daily_buy_limit) : plan.daily_buy_limit;
      const breadthBlocked = plan.breadth_confirm_min !== undefined &&
        (!day.market_factors || day.market_factors.industry_rising_ratio === null ||
          day.market_factors.industry_rising_ratio < plan.breadth_confirm_min);
      // 绝对动量闸门（MOP 2012）：综合指数 N 日收益低于阈值时停止新开仓，只影响开仓不影响退出。
      let absoluteBlocked = false;
      if (plan.absolute_momentum) {
        const days = plan.absolute_momentum.days;
        absoluteBlocked = compositeCloses.length <= days ||
          compositeCloses.at(-1)! / compositeCloses[compositeCloses.length - 1 - days]! - 1 < plan.absolute_momentum.min_return;
        if (absoluteBlocked) {
          const observed = compositeCloses.length > days
            ? compositeCloses.at(-1)! / compositeCloses[compositeCloses.length - 1 - days]! - 1 : null;
          emit("signal", null, "absolute_momentum_gate", { composite_return: observed, min_return: plan.absolute_momentum.min_return });
        }
      }
      // 已排退出的仓位可预订下一开盘名额；若卖出失败，开盘重新检查持仓上限。
      const slots = plan.max_positions - positions.size + sells.size;
      let suppressedTail = 0;
      // 回撤连续缩仓（20 日滚动高点回撤越深，新开仓预算越小；替代熔断二值开关的连续版本）。
      const drawdownScale = plan.drawdown_scale_max !== undefined
        ? Math.max(0, Math.min(1, 1 - ((recentPeak - total) / recentPeak) / plan.drawdown_scale_max)) : 1;
      for (const candidate of candidates) {
        if (emittedDetails >= detailBudget) { suppressedTail += 1; continue; }
        emittedDetails += 1;
        const { code, signalClose } = candidate;
        emit("signal", code, "right_side_daily_v1", { ...candidate.evidence, price_signal: true, passed_count: candidate.passedCount });
        const suppressed = breadthBlocked ? "breadth_confirm" : absoluteBlocked ? "absolute_momentum" : pausedSince !== null || externallyPaused ? "risk_paused" : positions.has(code) ? "already_held" :
          buys.length >= dailyLimit ? "daily_buy_limit" : buys.length >= slots ? "position_limit" : null;
        if (suppressed) { emit("suppressed", code, suppressed); continue; }
        // 波动率目标仓位（Moreira-Muir 口径）：单笔预算按自身 20 日已实现波动率缩放，上限 2 倍。
        let volScale = 1;
        if (plan.vol_target_sigma !== undefined) {
          const longCloses = histories.get(code)!.longCloses;
          if (longCloses.length >= 21) {
            const returns: number[] = [];
            for (let index = longCloses.length - 20; index < longCloses.length; index += 1) {
              returns.push(longCloses[index]! / longCloses[index - 1]! - 1);
            }
            const meanReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length;
            const variance = returns.reduce((sum, value) => sum + (value - meanReturn) * (value - meanReturn), 0) / returns.length;
            const realized = Math.sqrt(variance);
            if (realized > 0) volScale = Math.min(2, plan.vol_target_sigma / realized);
          }
        }
        const budget = Math.floor(total * plan.position_fraction * volScale * drawdownScale);
        buys.push({ code, budget, signalClose });
        emit("order", code, "right_side_daily_v1", { side: "buy", budget_cents: budget, next_open_only: true });
      }
      emit("signal", null, "evaluation_summary", { evaluated: evaluatedCount, passed: candidates.length,
        detail_emitted: emittedDetails, detail_truncated: candidates.length - emittedDetails });
      const equity: StandardEquity = {
        date: day.date, cash_cents: cash, market_value_cents: marketValue, equity_cents: total,
        fees_cents: fees, daily_return: previousEquity === 0 ? 0 : total / previousEquity - 1,
        drawdown, paused: pausedSince !== null || externallyPaused, positions: snapshots,
      };
      previousEquity = total;
      return { events, equity };
    },
    finish(): Record<string, number | null> {
      finished = true;
      return { total_return: previousEquity / initialCash - 1, max_drawdown: maxDrawdown,
        trade_count: tradeCount, win_rate: tradeCount === 0 ? null : wins / tradeCount,
        fees_cents: fees, final_equity_cents: previousEquity, open_position_count: positions.size };
    },
  };
}
