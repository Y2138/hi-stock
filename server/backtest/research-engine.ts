// 标准回测价格类研究引擎：左侧反转、试盘启动、波段箱体。
// 与右侧生产内核共享日账本契约；本文件不得引用数据库、服务配置或环境变量。
import { calculateIndicators, type IndicatorPoint } from "../indicators/formulas.js";
import { evaluateLeftSideSignal, evaluateTrialStartSignal, type LeftSideSignalBar, type TrialBar } from "./short-rules.js";
import { evaluateSwingSignal, type SwingSignalBar } from "../modules/plans/swing-signals.js";
import {
  standardSeedStart,
  type StandardBacktestPlan, type StandardBar, type StandardDay, type StandardDayResult,
  type StandardEngine, type StandardEquity, type StandardEvent,
} from "./contracts.js";

const LOT = 100;
const PRICE_SCALE = 1_000_000;
type ResearchRule = "left_reversal_daily_v1" | "trial_start_daily_v1" | "swing_box_daily_v1";
type Mode = "breakout" | "open";
interface History { bars: StandardBar[]; closes: number[]; volumes: number[]; point: IndicatorPoint | null; }
interface Position {
  quantity: number; initialQuantity: number; cost: number; entryPrice: number; entryDay: number;
  realized: number; initialStop: number | null; firstScale: boolean; secondScale: boolean; halfSold: boolean;
  boxFloor20: number | null; boxTop40: number | null;
}
interface PendingBuy { code: string; mode: Mode; signalClose: number; signalHigh: number; capRatio: number; rank: number; }
interface PendingSell { reason: string; quantity: number | null; }
function average(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function safeInteger(value: number): number { if (Number.isSafeInteger(value) === false) throw new Error("研究账本金额或数量超出安全整数范围"); return value; }
function priceUnits(value: number): number { return safeInteger(Math.round(value * PRICE_SCALE)); }
function notional(price: number, quantity: number): number { return safeInteger(Number((BigInt(price) * BigInt(quantity) + 5_000n) / 10_000n)); }
function atr14(history: History): number | null {
  if (history.bars.length < 15) return null;
  const bars = history.bars.slice(-14);
  const ranges = bars.map(function(bar, index) {
    const absoluteIndex = history.bars.length - 14 + index;
    const previousClose = history.bars[absoluteIndex - 1]?.close;
    if (previousClose === undefined || Number.isFinite(previousClose) === false) return null;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  });
  return ranges.some(function(value) { return value === null; }) ? null : average(ranges as number[]);
}
function validDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value); }
function advance(history: History, bar: StandardBar): void {
  history.bars.push(bar);
  history.closes.push(bar.close);
  history.volumes.push(bar.volume);
  if (history.bars.length > 120) history.bars.shift();
  if (history.closes.length > 400) history.closes.shift();
  if (history.volumes.length > 400) history.volumes.shift();
  const points = calculateIndicators(history.closes);
  history.point = points[points.length - 1] ?? null;
}
export function createResearchEngine(input: StandardBacktestPlan): StandardEngine {
  const plan = input;
  const rule = plan.rule as ResearchRule;
  const seedStart = standardSeedStart(plan.start);
  const histories = new Map<string, History>();
  const positions = new Map<string, Position>();
  const pendingBuys = new Map<string, PendingBuy>();
  const pendingSells = new Map<string, PendingSell>();
  for (const code of plan.codes) histories.set(code, { bars: [], closes: [], volumes: [], point: null });
  let cash = safeInteger(Math.round(plan.initial_cash * 100));
  let fees = 0;
  let peak = cash;
  let maxDrawdown = 0;
  let previousEquity = cash;
  let dayIndex = -1;
  let lastDate: string | null = null;
  let externallyPaused = false;
  let seq = 0;
  let tradeCount = 0;
  let wins = 0;
  let finished = false;
  function validateDay(day: StandardDay): Map<string, StandardBar> {
    if (validDate(day.date) === false) throw new Error("研究日日期非法");
    if (lastDate !== null && day.date.localeCompare(lastDate) !== 1 && day.date.localeCompare(lastDate) !== 0) throw new Error("研究日顺序非法");
    if (day.date.localeCompare(seedStart) === -1) throw new Error("研究日早于种子起点");
    if (day.date.localeCompare(plan.end) === 1) throw new Error("研究日超过结束日");
    // 停牌近似：当日无行情的标的不出现在 bars 中，数量允许少于全集。
    if (Array.isArray(day.bars) === false || day.bars.length > plan.codes.length) throw new Error("研究日标的数量不符");
    const bars = new Map<string, StandardBar>();
    for (const bar of day.bars) {
      if (histories.has(bar.code) === false) throw new Error("研究日出现未知标的");
      if (bar.date !== day.date || bars.has(bar.code)) throw new Error("研究日日期或标的重复");
      if ([bar.open, bar.high, bar.low, bar.close].some(function(value) { return Number.isFinite(value) === false || value <= 0; })) throw new Error("研究日价格非法");
      if (bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close)) throw new Error("研究日 OHLC 非法");
      if (Number.isSafeInteger(bar.volume) === false || bar.volume <= 0) throw new Error("研究日成交量非法");
      bars.set(bar.code, bar);
    }
    return bars;
  }
  function charges(gross: number, side: "buy" | "sell"): { commission: number; tax: number; total: number } {
    const commission = Math.max(Math.round(plan.costs.minimum_commission * 100), Math.round(gross * (plan.costs.commission_bps / 10_000)));
    const tax = side === "sell" ? Math.round(gross * (plan.costs.sell_tax_bps / 10_000)) : 0;
    return { commission: commission, tax: tax, total: safeInteger(commission + tax) };
  }
  function execution(code: string, side: "buy" | "sell", requestedPrice: number): { price: number; capacity: number } | null {
    const history = histories.get(code) as History;
    if (history.closes.length === 0 || history.volumes.length < 20) return null;
    const previous = history.closes[history.closes.length - 1] as number;
    const price = priceUnits(requestedPrice);
    const upper = Math.round(previous * 1.1 * 100) * 10_000;
    const lower = Math.round(previous * 0.9 * 100) * 10_000;
    const slippage = side === "buy" ? 1 + plan.costs.slippage_bps / 10_000 : 1 - plan.costs.slippage_bps / 10_000;
    const fill = safeInteger(Math.round(price * slippage));
    if (fill < lower || fill > upper || (side === "buy" && fill >= upper) || (side === "sell" && fill <= lower)) return null;
    const meanVolume = average(history.volumes.slice(-20));
    const capacity = safeInteger(Math.floor(meanVolume * plan.costs.volume_participation / LOT) * LOT);
    if (capacity < LOT) return null;
    return { price: fill, capacity: capacity };
  }
  function makePendingSignal(code: string): PendingBuy | null {
    const history = histories.get(code) as History;
    if (history.bars.length < 15) return null;
    const currentPoint = history.point;
    const rows = history.bars.map(function(bar) {
      return { code: bar.code, bar_date: bar.date, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, ma20: currentPoint?.ma20 ?? null, rsi14: currentPoint?.rsi14 ?? null, indicator_status: currentPoint?.rsi14 === null || currentPoint?.rsi14 === undefined ? null : "ready" as const };
    });
    if (rule === "left_reversal_daily_v1") {
      if (rows.length < 21) return null;
      const evaluation = evaluateLeftSideSignal(rows.slice(-21) as LeftSideSignalBar[], plan.left_reversal_params ?? {});
      if (evaluation === null || evaluation.price_signal === false) return null;
      return { code: code, mode: "breakout", signalClose: evaluation.evidence.close, signalHigh: evaluation.evidence.high, capRatio: 1.03, rank: evaluation.quality_score };
    }
    if (rule === "trial_start_daily_v1") {
      if (rows.length < 15) return null;
      const evaluation = evaluateTrialStartSignal(rows.slice(-15) as TrialBar[]);
      if (evaluation.price_signal === false || evaluation.evidence.trial_high === null) return null;
      return { code: code, mode: "breakout", signalClose: evaluation.evidence.close, signalHigh: evaluation.evidence.trial_high, capRatio: 1.05, rank: evaluation.score };
    }
    if (rows.length < 40) return null;
    const swing = evaluateSwingSignal(rows.slice(-40) as SwingSignalBar[], "stock", plan.defense_recovery_ma10 ?? 0.5);
    if (swing === null || swing.price_signal === false) return null;
    return { code: code, mode: "breakout", signalClose: swing.evidence.close, signalHigh: swing.evidence.confirmation_must_exceed, capRatio: 1.05, rank: swing.evidence.expected_reward_risk ?? 0 };
  }
  function lotFloor(quantity: number): number { return Math.floor(quantity / LOT) * LOT; }
  function exitForPosition(_code: string, position: Position, close: number, index: number): PendingSell | null {
    const holdingDays = index - position.entryDay + 1;
    if (rule === "left_reversal_daily_v1") {
      const initialStop = position.initialStop ?? position.entryPrice * 0.93;
      if (close <= initialStop) return { reason: "stop_loss", quantity: null };
      if (position.firstScale === false && close / position.entryPrice - 1 >= 0.06) {
        const base = position.initialQuantity >= 1500 ? lotFloor(position.initialQuantity / 3) : lotFloor(position.initialQuantity / 2);
        const quantity = Math.max(LOT, Math.min(base, position.quantity));
        return { reason: "left_first_scale", quantity: quantity };
      }
      if (position.secondScale === false && close / position.entryPrice - 1 >= 0.16) {
        const quantity = Math.min(Math.max(LOT, lotFloor(position.initialQuantity / 4)), position.quantity);
        return { reason: "left_second_scale", quantity: quantity };
      }
      if (holdingDays >= plan.max_holding_days) return { reason: "max_holding_days", quantity: null };
      return null;
    }
    if (rule === "swing_box_daily_v1") {
      const boxFloor = position.boxFloor20 ?? position.entryPrice;
      const regularStop = Math.min(position.entryPrice * 0.99, Math.max(position.entryPrice * 0.93, boxFloor * 0.97));
      const observationStop = position.entryPrice * 0.75;
      const stop = holdingDays <= 10 ? observationStop : regularStop;
      if (close <= stop) return { reason: "stop_loss", quantity: null };
      const boxTop = position.boxTop40 ?? position.entryPrice;
      if (position.halfSold === false && close >= boxTop * 0.95) {
        const quantity = Math.min(Math.max(LOT, lotFloor(position.quantity / 2)), position.quantity);
        return { reason: "swing_box_top", quantity: quantity };
      }
      if (holdingDays >= plan.max_holding_days) return { reason: "max_holding_days", quantity: null };
      return null;
    }
    if (close <= position.entryPrice * (1 - plan.stop_loss_pct)) return { reason: "stop_loss", quantity: null };
    if (holdingDays >= plan.max_holding_days) return { reason: "max_holding_days", quantity: null };
    return null;
  }
  return {
    control(command: { paused: boolean }): void {
      externallyPaused = command.paused;
    },
    next(day: StandardDay): StandardDayResult {
      if (finished) throw new Error("研究内核已结束");
      const bars = validateDay(day);
      lastDate = day.date;
      const events: StandardEvent[] = [];
      function emit(type: StandardEvent["type"], code: string | null, reason: string, details: StandardEvent["details"] = {}): void {
        seq += 1;
        events.push({ seq: seq, date: day.date, type: type, code: code, reason: reason, details: details });
      }
      if (day.date.localeCompare(plan.start) === -1) {
        for (const code of plan.codes) {
          const bar = bars.get(code);
          if (bar) advance(histories.get(code) as History, bar);
        }
        return { events: events, equity: null };
      }
      dayIndex += 1;
      for (const [code, order] of pendingSells) {
        const position = positions.get(code);
        if (position === undefined) { pendingSells.delete(code); continue; }
        const bar = bars.get(code);
        if (!bar) continue;
        emit("order", code, order.reason, { side: "sell", quantity: order.quantity ?? position.quantity });
        const fill = execution(code, "sell", bar.open);
        if (fill === null) continue;
        const quantity = Math.min(position.quantity, order.quantity ?? position.quantity, fill.capacity);
        if (quantity < LOT) { pendingSells.delete(code); continue; }
        const gross = notional(fill.price, quantity);
        const fee = charges(gross, "sell");
        const allocatedCost = Number((BigInt(position.cost) * BigInt(quantity) + BigInt(position.quantity) / 2n) / BigInt(position.quantity));
        cash = safeInteger(cash + gross - fee.total);
        fees = safeInteger(fees + fee.total);
        position.cost -= allocatedCost;
        position.quantity -= quantity;
        position.realized = safeInteger(position.realized + gross - fee.total - allocatedCost);
        emit("fill", code, order.reason, { side: "sell", quantity: quantity, price: fill.price / PRICE_SCALE, gross_cents: gross, commission_cents: fee.commission, tax_cents: fee.tax, fees_cents: fee.total, allocated_cost_cents: allocatedCost, remaining_quantity: position.quantity });
        if (order.reason === "left_first_scale") position.firstScale = true;
        if (order.reason === "left_second_scale") position.secondScale = true;
        if (order.reason === "swing_box_top") position.halfSold = true;
        if (position.quantity === 0) {
          positions.delete(code);
          pendingSells.delete(code);
          tradeCount += 1;
          if (position.realized > 0) wins += 1;
          emit("closed", code, order.reason, { pnl_cents: position.realized, quantity: position.initialQuantity });
        }
      }
      for (const [code, pending] of pendingBuys) {
        pendingBuys.delete(code);
        if (positions.has(code)) continue;
        if (externallyPaused) { emit("rejected", code, "risk_paused", { side: "buy" }); continue; }
        // 停牌日无开盘：订单作废（生产口径“停牌均放弃”）。
        const bar = bars.get(code);
        if (!bar) continue;
        let requested = bar.open;
        if (pending.mode === "breakout") {
          if (bar.open > pending.signalHigh) requested = bar.open;
          else if (bar.high > pending.signalHigh) requested = pending.signalHigh;
          else continue;
        }
        if (requested > pending.signalClose * pending.capRatio) continue;
        const fill = execution(code, "buy", requested);
        if (fill === null) { emit("rejected", code, "research_price_limit", { side: "buy" }); continue; }
        const budget = Math.floor(previousEquity * plan.position_fraction);
        const desired = safeInteger(Number(BigInt(budget) * 10_000n / (BigInt(fill.price) * BigInt(LOT))) * LOT);
        const quantity = Math.min(desired, fill.capacity);
        if (quantity < LOT) { emit("rejected", code, "insufficient_cash_or_budget", { side: "buy" }); continue; }
        const gross = notional(fill.price, quantity);
        const fee = charges(gross, "buy");
        if (cash < gross + fee.total) { emit("rejected", code, "insufficient_cash_or_budget", { side: "buy" }); continue; }
        cash = safeInteger(cash - gross - fee.total);
        fees = safeInteger(fees + fee.total);
        const history = histories.get(code) as History;
        const entryPrice = fill.price / PRICE_SCALE;
        const entryAtr = atr14(history);
        const initialStop = rule === "left_reversal_daily_v1" ? Math.max(entryPrice - (entryAtr ?? 0), entryPrice * 0.93) : null;
        const boxFloor20 = rule === "swing_box_daily_v1" ? Math.min.apply(null, history.bars.slice(-20).map(function(item) { return item.low; })) : null;
        const boxTop40 = rule === "swing_box_daily_v1" ? Math.max.apply(null, history.bars.slice(-40).map(function(item) { return item.high; })) : null;
        positions.set(code, { quantity: quantity, initialQuantity: quantity, cost: gross + fee.total, entryPrice: entryPrice, entryDay: dayIndex, realized: 0, initialStop: initialStop, firstScale: false, secondScale: false, halfSold: false, boxFloor20: boxFloor20, boxTop40: boxTop40 });
        emit("fill", code, rule, { side: "buy", quantity: quantity, price: entryPrice, gross_cents: gross, commission_cents: fee.commission, tax_cents: fee.tax, fees_cents: fee.total });
      }
      for (const code of plan.codes) {
        const bar = bars.get(code);
        if (bar) advance(histories.get(code) as History, bar);
      }
      for (const [code, position] of positions) {
        const bar = bars.get(code);
        if (!bar) continue;
        const order = exitForPosition(code, position, bar.close, dayIndex);
        if (order === null) continue;
        if (pendingSells.has(code)) continue;
        pendingSells.set(code, order);
        emit("signal", code, order.reason, { side: "sell", quantity: order.quantity ?? position.quantity });
      }
      const candidates: PendingBuy[] = [];
      for (const code of plan.codes) {
        if (!bars.has(code)) continue;
        if (positions.has(code) || pendingBuys.has(code)) continue;
        const signal = makePendingSignal(code);
        if (signal === null) continue;
        if (externallyPaused) { emit("suppressed", code, "risk_paused"); continue; }
        emit("signal", code, rule, { price_signal: true, rank: signal.rank });
        candidates.push(signal);
      }
      candidates.sort(function(a, b) { return b.rank - a.rank || a.code.localeCompare(b.code); });
      let selected = 0;
      for (const candidate of candidates) {
        if (selected >= plan.daily_buy_limit) { emit("suppressed", candidate.code, "daily_buy_limit"); continue; }
        if (positions.size + pendingBuys.size >= plan.max_positions) { emit("suppressed", candidate.code, "position_limit"); continue; }
        pendingBuys.set(candidate.code, candidate);
        selected += 1;
        emit("order", candidate.code, rule, { side: "buy", next_open_only: true });
      }
      let marketValue = 0;
      const snapshots: StandardEquity["positions"] = [];
      for (const [code, position] of positions) {
        // 停牌持仓按最后成交日收盘估值。
        const bar = bars.get(code);
        const close = bar ? bar.close : (histories.get(code) as History).bars.at(-1)!.close;
        marketValue = safeInteger(marketValue + notional(priceUnits(close), position.quantity));
        snapshots.push({ code: code, quantity: position.quantity, cost_cents: position.cost, close: close });
      }
      const total = safeInteger(cash + marketValue);
      peak = Math.max(peak, total);
      const drawdown = (peak - total) / peak;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
      const equity: StandardEquity = { date: day.date, cash_cents: cash, market_value_cents: marketValue, equity_cents: total, fees_cents: fees, daily_return: previousEquity === 0 ? 0 : total / previousEquity - 1, drawdown: drawdown, paused: externallyPaused, positions: snapshots };
      previousEquity = total;
      return { events: events, equity: equity };
    },
    finish(): Record<string, number | null> {
      finished = true;
      const initial = safeInteger(Math.round(plan.initial_cash * 100));
      return { total_return: previousEquity / initial - 1, max_drawdown: maxDrawdown, trade_count: tradeCount, win_rate: tradeCount === 0 ? null : wins / tradeCount, fees_cents: fees, final_equity_cents: previousEquity, open_position_count: positions.size };
    }
  };
}
