// 标准组合回测容器：把单策略子账户聚合为组合级净值、费用、事件与结果。
import { createStandardEngine, STOP_EXIT_REASONS } from "./engine.js";
import { createResearchEngine } from "./research-engine.js";
import {
  validateStandardPlan,
  type StandardBacktestPlan, type StandardDay, type StandardDayResult,
  type StandardEngine, type StandardEquity, type StandardEvent, type StandardStrategyPlan,
} from "./contracts.js";
function safeInteger(value: number): number { if (Number.isSafeInteger(value) === false) throw new Error("组合账本金额或数量超出安全整数范围"); return value; }
function normalizedStrategies(plan: StandardBacktestPlan): StandardStrategyPlan[] {
  if (plan.rule === "portfolio_daily_v1") return plan.strategies as StandardStrategyPlan[];
  return [{ rule: plan.rule as StandardStrategyPlan["rule"], codes: plan.codes, allocation_pct: 1, max_positions: plan.max_positions, daily_buy_limit: plan.daily_buy_limit, position_fraction: plan.position_fraction, stop_loss_pct: plan.stop_loss_pct, max_holding_days: plan.max_holding_days, defense_recovery_ma10: plan.defense_recovery_ma10 }];
}
function childPlan(plan: StandardBacktestPlan, strategy: StandardStrategyPlan, initialCash: number): StandardBacktestPlan {
  // 单规则运行与组合共用本容器；单规则子账户保留计划的熔断与过滤器，组合模式由组合层统一熔断。
  const isPortfolio = plan.rule === "portfolio_daily_v1";
  const child: StandardBacktestPlan = {
    name: plan.name, hypothesis: plan.hypothesis, codes: strategy.codes, start: plan.start, end: plan.end,
    rule: strategy.rule, environment_mode: plan.environment_mode, price_mode: plan.price_mode,
    initial_cash: initialCash, max_positions: strategy.max_positions, daily_buy_limit: strategy.daily_buy_limit,
    position_fraction: strategy.position_fraction,
    stop_loss_pct: strategy.stop_loss_pct ?? plan.stop_loss_pct,
    max_holding_days: strategy.max_holding_days ?? plan.max_holding_days,
    drawdown_circuit: isPortfolio ? false : plan.drawdown_circuit,
    stop_streak_circuit: isPortfolio ? false : plan.stop_streak_circuit,
    costs: plan.costs,
    defense_recovery_ma10: strategy.defense_recovery_ma10 ?? plan.defense_recovery_ma10 ?? 0.5,
  };
  // 可选参数继承：单规则运行从计划继承全部可选能力；组合模式按策略继承，账本契约不接受 undefined 键。
  const inherit = (key: string, value: unknown): void => {
    if (value !== undefined) (child as unknown as Record<string, unknown>)[key] = value;
  };
  inherit("exit_model", strategy.exit_model ?? (!isPortfolio ? plan.exit_model : undefined));
  inherit("left_reversal_params", strategy.left_reversal_params ?? (!isPortfolio ? plan.left_reversal_params : undefined));
  inherit("take_profit_pct", !isPortfolio ? plan.take_profit_pct : undefined);
  inherit("drawdown_circuit_pct", !isPortfolio ? plan.drawdown_circuit_pct : undefined);
  inherit("oscillation_filter", !isPortfolio ? plan.oscillation_filter : undefined);
  inherit("breadth_confirm_min", !isPortfolio ? plan.breadth_confirm_min : undefined);
  inherit("min_amplitude_20", !isPortfolio ? plan.min_amplitude_20 : undefined);
  inherit("max_open_gap_pct", !isPortfolio ? plan.max_open_gap_pct : undefined);
  inherit("industry_groups", !isPortfolio ? plan.industry_groups : undefined);
  inherit("industry_momentum", !isPortfolio ? plan.industry_momentum : undefined);
  inherit("near_52w_high_min", !isPortfolio ? plan.near_52w_high_min : undefined);
  inherit("absolute_momentum", !isPortfolio ? plan.absolute_momentum : undefined);
  inherit("residual_momentum", !isPortfolio ? plan.residual_momentum : undefined);
  inherit("vol_target_sigma", !isPortfolio ? plan.vol_target_sigma : undefined);
  inherit("drawdown_scale_max", !isPortfolio ? plan.drawdown_scale_max : undefined);
  return child;
}
export function createPortfolioEngine(input: StandardBacktestPlan): StandardEngine {
  const plan = validateStandardPlan(input);
  const strategies = normalizedStrategies(plan);
  const initialCents = safeInteger(Math.round(plan.initial_cash * 100));
  const children = strategies.map(function(strategy) {
    const cash = Math.round(plan.initial_cash * strategy.allocation_pct * 100) / 100;
    const subPlan = childPlan(plan, strategy, cash);
    const engine = subPlan.rule === "right_side_daily_v1" ? createStandardEngine(subPlan) : createResearchEngine(subPlan);
    return { plan: subPlan, engine: engine, codes: new Set(subPlan.codes) };
  });
  const allocatedCents = children.reduce(function(sum, child) { return sum + Math.round(child.plan.initial_cash * 100); }, 0);
  const reserveCents = safeInteger(initialCents - allocatedCents);
  let seq = 0;
  let previousEquity = initialCents;
  let peak = initialCents;
  let maxDrawdown = 0;
  let tradeCount = 0;
  let wins = 0;
  let lastEquity = initialCents;
  let lastFees = 0;
  let lastPositionCount = 0;
  let finished = false;
  // 组合级风控（预案§3）：20 日高点回撤熔断与连止损熔断作用于全部子策略的新开仓；退出不受限。
  let recentEquities: number[] = [];
  let pausedSince: number | null = null;
  let stopStreak = 0;
  let dayIndex = -1;
  return {
    next(day: StandardDay): StandardDayResult {
      if (finished) throw new Error("组合内核已结束");
      const globalEvents: StandardEvent[] = [];
      const results: StandardDayResult[] = [];
      children.forEach(function(child, index) {
        const subBars = day.bars.filter(function(bar) { return child.codes.has(bar.code); });
        const subDay: StandardDay = { date: day.date, market_recovery: day.market_recovery, bars: subBars,
          ...(day.market_factors ? { market_factors: day.market_factors } : {}),
          ...(day.environment_bars ? { environment_bars: day.environment_bars } : {}) };
        const result = child.engine.next(subDay);
        results.push(result);
        for (const event of result.events) {
          seq += 1;
          const details: StandardEvent["details"] = Object.assign({}, event.details, { strategy_index: index, strategy_rule: child.plan.rule });
          globalEvents.push({ seq: seq, date: event.date, type: event.type, code: event.code, reason: event.reason, details: details });
          if (event.type === "closed") {
            tradeCount += 1;
            const pnl = event.details.pnl_cents;
            if (typeof pnl === "number" && pnl > 0) wins += 1;
          }
        }
      });
      if (day.date.localeCompare(plan.start) === -1) return { events: globalEvents, equity: null };
      const childEquities = results.map(function(result) { return result.equity; });
      if (childEquities.some(function(equity) { return equity === null; })) throw new Error("组合子账户结算缺失");
      let cashCents = reserveCents;
      let marketValueCents = 0;
      let feesCents = 0;
      const flatPositions: StandardEquity["positions"] = [];
      for (const equity of childEquities as StandardEquity[]) {
        cashCents = safeInteger(cashCents + equity.cash_cents);
        marketValueCents = safeInteger(marketValueCents + equity.market_value_cents);
        feesCents = safeInteger(feesCents + equity.fees_cents);
        for (const position of equity.positions) flatPositions.push(position);
      }
      const total = safeInteger(cashCents + marketValueCents);
      peak = Math.max(peak, total);
      const drawdown = (peak - total) / peak;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
      const dailyReturn = previousEquity === 0 ? 0 : total / previousEquity - 1;
      dayIndex += 1;
      // 组合级熔断：回撤按含当日在内最近 20 次结算高点严格大于阈值；连止损按当日全组合闭环顺序计数。
      let newStopRisk = 0;
      for (const event of globalEvents) {
        if (event.type !== "closed") continue;
        const stopExit = STOP_EXIT_REASONS.has(event.reason);
        stopStreak = stopExit ? stopStreak + 1 : 0;
        if (stopExit && stopStreak >= 3) newStopRisk = stopStreak;
      }
      const emitRisk = (type: StandardEvent["type"], reason: string, details: StandardEvent["details"]): void => {
        seq += 1;
        globalEvents.push({ seq, date: day.date, type, code: null, reason, details });
      };
      // 组合级熔断只由组合计划触发；单规则运行的熔断由子内核自带，避免同一路径双重生效。
      if (plan.rule === "portfolio_daily_v1" && (plan.drawdown_circuit || plan.stop_streak_circuit)) {
        recentEquities.push(total);
        if (recentEquities.length > 20) recentEquities.shift();
        const recentPeak = Math.max(...recentEquities);
        const thresholdBps = BigInt(Math.round((plan.drawdown_circuit_pct ?? 0.05) * 10_000));
        const drawdownRisk = plan.drawdown_circuit && BigInt(recentPeak - total) * 10_000n > BigInt(recentPeak) * thresholdBps;
        const streakRisk = plan.stop_streak_circuit && newStopRisk >= 3;
        if (drawdownRisk || streakRisk) {
          if (pausedSince === null) pausedSince = dayIndex;
          if (drawdownRisk) emitRisk("risk_trigger", "drawdown_circuit", { peak_cents: recentPeak, equity_cents: total });
          if (streakRisk) emitRisk("risk_trigger", "stop_streak_circuit", { stop_streak: newStopRisk });
          for (const child of children) child.engine.control?.({ paused: true });
        } else if (pausedSince !== null && dayIndex > pausedSince && day.market_recovery === true) {
          pausedSince = null;
          stopStreak = 0;
          emitRisk("risk_recover", "market_recovery", { stop_streak: stopStreak });
          for (const child of children) child.engine.control?.({ paused: false });
        }
      }
      const equity: StandardEquity = { date: day.date, cash_cents: cashCents, market_value_cents: marketValueCents, equity_cents: total, fees_cents: feesCents, daily_return: dailyReturn, drawdown: drawdown, paused: pausedSince !== null, positions: flatPositions };
      previousEquity = total;
      lastEquity = total;
      lastFees = feesCents;
      lastPositionCount = flatPositions.length;
      return { events: globalEvents, equity: equity };
    },
    finish(): Record<string, number | null> {
      finished = true;
      return { total_return: lastEquity / initialCents - 1, max_drawdown: maxDrawdown, trade_count: tradeCount, win_rate: tradeCount === 0 ? null : wins / tradeCount, fees_cents: lastFees, final_equity_cents: lastEquity, open_position_count: lastPositionCount };
    }
  };
}
