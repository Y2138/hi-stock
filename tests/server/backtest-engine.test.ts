import { afterEach, describe, expect, it, vi } from "vitest";
// 若纯内核以后误连服务配置，收集测试时立即失败，禁止加载本机环境或连接数据库。
vi.mock("../../server/config.js", () => { throw new Error("纯内核不得导入服务配置"); });
vi.mock("dotenv", () => { throw new Error("纯内核不得加载 dotenv"); });

import * as formulas from "../../server/indicators/formulas.js";
import { evaluateRightSideSignal, type RightSideSignalBar } from "../../server/modules/plans/right-side-rule.js";
import { evaluateLeftSideSignal, type LeftSideSignalBar } from "../../server/backtest/short-rules.js";
import { createStandardEngine, evaluateOscillation } from "../../server/backtest/engine.js";
import { createPortfolioEngine } from "../../server/backtest/portfolio-engine.js";
import { validateStandardPlan } from "../../server/backtest/contracts.js";
import type { StandardBacktestPlan, StandardBar, StandardDay, StandardDayResult, StandardEngine, StandardMarketFactors } from "../../server/backtest/contracts.js";

const CODE = "000001.SZ";
const CODES = [CODE, "000002.SZ", "000003.SZ", "000004.SZ"];
const date = (offset: number) => new Date(Date.UTC(2024, 0, 1 + offset)).toISOString().slice(0, 10);
const freeCosts = { label: "显式零成本对照", commission_bps: 0, minimum_commission: 0,
  sell_tax_bps: 0, slippage_bps: 0, volume_participation: 0.1 };
function plan(overrides: Partial<StandardBacktestPlan> = {}): StandardBacktestPlan {
  return { name: "固定样本研究", hypothesis: "生产右侧信号的日频可复现性", codes: [CODE],
    start: date(0), end: date(365), rule: "right_side_daily_v1", environment_mode: "current_881", price_mode: "raw_research",
    initial_cash: 10_000, max_positions: 1, daily_buy_limit: 1, position_fraction: 1,
    stop_loss_pct: 0.1, max_holding_days: 2520, drawdown_circuit: false, stop_streak_circuit: false,
    costs: { ...freeCosts }, ...overrides };
}
function day(offset: number, overrides: Partial<StandardBar> = {}, codes = [CODE], recovery: boolean | null = null,
    factors?: StandardMarketFactors): StandardDay {
  const base = { date: date(offset), market_recovery: recovery,
    bars: codes.map((code) => ({ code, date: date(offset), open: overrides.open ?? overrides.close ?? 10,
      close: overrides.close ?? overrides.open ?? 10,
      high: Math.max(overrides.open ?? overrides.close ?? 10, overrides.close ?? overrides.open ?? 10, overrides.high ?? 0),
      low: Math.min(overrides.open ?? overrides.close ?? 10, overrides.close ?? overrides.open ?? 10, overrides.low ?? Number.MAX_SAFE_INTEGER),
      volume: 100_000, ...overrides })) };
  return factors ? { ...base, market_factors: factors } : base;
}
function warm(engine: StandardEngine, codes = [CODE], volume = 100_000) {
  for (let i = -60; i < 0; i++) expect(engine.next(day(i, { volume }, codes))).toEqual({ events: [], equity: null });
}
function signal(engine: StandardEngine, codes = [CODE], offset = 0, volume = 200_000) {
  return engine.next(day(offset, { open: 10.5, close: 11, volume }, codes));
}
const fills = (result: StandardDayResult, side?: string) => result.events.filter((event) =>
  event.type === "fill" && (!side || event.details.side === side));
const closed = (result: StandardDayResult) => result.events.filter((event) => event.type === "closed");
const risks = (result: StandardDayResult) => result.events.filter((event) => event.type === "risk_trigger");
const recovery = (result: StandardDayResult) => result.events.filter((event) => event.type === "risk_recover");

afterEach(() => vi.restoreAllMocks());

describe("固定样本日频研究内核（纯函数，无数据库）", () => {
  it("预热不交易、不结算；零交易指标与终止状态稳定", () => {
    const engine = createStandardEngine(plan());
    warm(engine);
    const result = engine.next(day(0));
    expect(fills(result)).toEqual([]);
    expect(result.equity).toEqual({ date: date(0), cash_cents: 1_000_000, equity_cents: 1_000_000,
      market_value_cents: 0, fees_cents: 0, daily_return: 0, drawdown: 0, paused: false, positions: [] });
    const metrics = engine.finish();
    expect(metrics).toEqual({ total_return: 0, max_drawdown: 0, trade_count: 0, win_rate: null,
      fees_cents: 0, final_equity_cents: 1_000_000, open_position_count: 0 });
    expect(engine.finish()).toEqual(metrics);
    expect(() => engine.next(day(1))).toThrow("已结束");
    expect(createStandardEngine(plan()).finish()).toMatchObject({ trade_count: 0, win_rate: null });
  });

  it("六年共同种子后递推指标/信号与生产全历史公式一致，批量计算只运行固定启动段", () => {
    // 共同种子取 2018-01-01（含闰年），正式窗口再延续一年；波动序列覆盖信号真/假。
    const start = -2191;
    const data = Array.from({ length: 2557 }, (_, index) => {
      const close = 10 + index * 0.002 + Math.sin(index / 7) * 0.5 + (index % 31 === 0 ? 1 : 0);
      return day(start + index, { open: close * (index % 31 === 0 ? 0.96 : 1), close,
        volume: index % 31 === 0 ? 250_000 : 100_000 });
    });
    const production = formulas.calculateIndicators(data.map((item) => item.bars[0]!.close));
    const rows: RightSideSignalBar[] = data.map((item, index) => {
      const point = production[index]!;
      return { ...item.bars[0]!, bar_date: item.date, ma5: point.ma5, ma10: point.ma10,
        ma20: point.ma20, dif: point.dif, macd_hist: point.macdHist,
        indicator_status: point.macdHist === null ? null : "ready" };
    });
    const spy = vi.spyOn(formulas, "calculateIndicators");
    const engine = createStandardEngine(plan({ end: date(365) }));
    let signals = 0;
    for (let i = 0; i < data.length; i++) {
      const result = engine.next(data[i]!);
      if (data[i]!.date < date(0)) { expect(result).toEqual({ events: [], equity: null }); continue; }
      const reference = evaluateRightSideSignal(rows.slice(Math.max(0, i - 4), i + 1))!;
      const perCode = result.events.filter((event) => event.type === "signal" && event.code !== null);
      // 事件预算：只有 price_signal 候选逐只记录，落选评估进 evaluation_summary。
      if (reference.price_signal) {
        expect(perCode).toHaveLength(1);
        const actual = perCode[0]!;
        expect(actual.details.price_signal).toBe(true);
        expect(actual.details.passed_count).toBe(reference.passed_count);
        for (const key of ["ma5", "ma10", "ma20", "dif", "macd_hist", "previous_macd_hist", "macd_hist_delta_ratio"] as const) {
          expect(actual.details[key]).toBeCloseTo(reference.evidence[key], 12);
        }
        signals++;
      } else {
        expect(perCode).toHaveLength(0);
      }
      const summary = result.events.find((event) => event.type === "signal" && event.code === null)!;
      expect(summary.details.evaluated).toBe(1);
    }
    expect(signals).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledTimes(34);
    expect(Math.max(...spy.mock.calls.map(([closes]) => closes.length))).toBeLessThanOrEqual(34);
  });

  it("收盘信号只能下一开盘成交；当日收盘、高低价、成交量和恢复字段不泄漏到开盘", () => {
    const a = createStandardEngine(plan());
    const b = createStandardEngine(plan());
    warm(a); warm(b);
    const first = signal(a);
    expect(signal(b)).toEqual(first);
    expect(fills(first)).toEqual([]);
    expect(first.events.some((event) => event.type === "order" && event.details.side === "buy")).toBe(true);
    const saved = JSON.stringify(first);
    const normal = a.next(day(1, { open: 11, close: 11 }));
    const changedFuture = b.next(day(1, { open: 11, close: 20, high: 30, low: 1, volume: 1 }, [CODE], true));
    expect(fills(normal, "buy")).toEqual(fills(changedFuture, "buy"));
    expect(fills(normal, "buy")[0]!.details.quantity).toBe(900);
    expect(normal.equity!.cash_cents).toBe(changedFuture.equity!.cash_cents);
    expect(normal.equity!.market_value_cents).not.toBe(changedFuture.equity!.market_value_cents);
    expect(JSON.stringify(first)).toBe(saved);
  });

  it("费用、滑点与整数分账本可逐笔手算，盈利率扣除双边最低佣金和卖税", () => {
    const engine = createStandardEngine(plan({ max_holding_days: 1, costs: {
      ...freeCosts, label: "显式佣金、卖税和滑点", commission_bps: 3, minimum_commission: 5, sell_tax_bps: 5, slippage_bps: 25,
    } }));
    warm(engine); signal(engine);
    const bought = engine.next(day(1, { open: 11.03, close: 11.03 }));
    expect(fills(bought)[0]!.details).toMatchObject({ side: "buy", quantity: 900, price: 11.057575,
      gross_cents: 995_182, commission_cents: 500, tax_cents: 0, fees_cents: 500 });
    expect(bought.equity).toMatchObject({ cash_cents: 4_318, market_value_cents: 992_700, equity_cents: 997_018,
      fees_cents: 500, positions: [{ quantity: 900, cost_cents: 995_682 }] });
    const sold = engine.next(day(2, { open: 11.2, close: 11.2 }));
    expect(fills(sold)[0]!.details).toMatchObject({ side: "sell", quantity: 900, price: 11.172,
      gross_cents: 1_005_480, commission_cents: 500, tax_cents: 503, fees_cents: 1_003 });
    expect(closed(sold)[0]!.details.pnl_cents).toBe(8_795);
    expect(sold.equity).toMatchObject({ cash_cents: 1_008_795, equity_cents: 1_008_795, fees_cents: 1_503, positions: [] });
    expect(engine.finish()).toMatchObject({ total_return: 1_008_795 / 1_000_000 - 1,
      max_drawdown: 0.002982, trade_count: 1, win_rate: 1, fees_cents: 1503 });
    for (const result of [bought, sold]) {
      for (const key of ["cash_cents", "market_value_cents", "equity_cents", "fees_cents"] as const) {
        expect(Number.isSafeInteger(result.equity![key])).toBe(true);
      }
      expect(result.equity!.cash_cents + result.equity!.market_value_cents).toBe(result.equity!.equity_cents);
    }
  });

  it("超过最低佣金时按比例收费，现金不足向下缩为整手，余单过期不加仓", () => {
    const engine = createStandardEngine(plan({ initial_cash: 2200,
      costs: { ...freeCosts, commission_bps: 100, minimum_commission: 5 } }));
    warm(engine); signal(engine);
    const bought = engine.next(day(1, { open: 11, close: 12, volume: 300_000 }));
    expect(fills(bought)[0]!.details).toMatchObject({ quantity: 100, commission_cents: 1100 });
    expect(bought.equity!.cash_cents).toBe(108_900);
    expect(bought.events).toContainEqual(expect.objectContaining({ type: "expired", reason: "unfilled_remainder", details: { side: "buy", quantity: 100 } }));
    expect(bought.events).toContainEqual(expect.objectContaining({ type: "suppressed", reason: "already_held" }));
    const next = engine.next(day(2, { open: 12, close: 12 }));
    expect(fills(next, "buy")).toEqual([]);
    expect(next.equity!.positions[0]!.quantity).toBe(100);
  });

  it("订单排名与输入数组顺序无关，先到订单不能透支后到订单现金", () => {
    const codes = CODES.slice(0, 2);
    const config = plan({ codes: [...codes].reverse(), max_positions: 2, daily_buy_limit: 2, position_fraction: 0.75 });
    const a = createStandardEngine(config);
    const b = createStandardEngine(config);
    warm(a, codes); warm(b, [...codes].reverse());
    const candidates = day(0, { open: 10.5, close: 11, volume: 200_000 }, codes);
    candidates.bars[1]!.volume = 400_000;
    // 生产排序分（MACD柱增量/收盘价，0.003封顶）与量比无关：两候选证据相同则并列，按代码升序。
    expect(a.next(candidates)).toEqual(b.next({ ...candidates, bars: [...candidates.bars].reverse() }));
    const result = a.next(day(1, { close: 11 }, codes));
    expect(result).toEqual(b.next(day(1, { close: 11 }, [...codes].reverse())));
    expect(fills(result).map((event) => [event.code, event.details.quantity])).toEqual([[codes[0], 600], [codes[1], 300]]);
    expect(result.equity!.cash_cents).toBe(10_000);
  });

  it("同日候选按生产排序分（MACD柱增量/收盘价）排名，0.003封顶后并列按代码升序", () => {
    const codes = CODES.slice(0, 2);
    const warmup = (engine: StandardEngine) => warm(engine, codes);
    const jumpDay = (moves: [number, number]) => ({
      date: date(0), market_recovery: null,
      bars: codes.map((code, index) => ({
        code, date: date(0), open: 10 + moves[index]! * 5, close: 10 * (1 + moves[index]!),
        high: 10 * (1 + moves[index]!), low: 10 + moves[index]! * 5, volume: 300_000 })),
    });
    // 增量排名：000002.SZ 跳升10%（增量0.0058封顶为0.003）排在000001.SZ跳升4%（增量0.0025）之前，代码序相反。
    const deltaFirst = createStandardEngine(plan({ codes, max_positions: 2, daily_buy_limit: 1, position_fraction: 0.75 }));
    warmup(deltaFirst);
    deltaFirst.next(jumpDay([0.04, 0.10]));
    expect(fills(deltaFirst.next(day(1, { close: 11 }, codes)), "buy").map((event) => event.code)).toEqual([codes[1]]);
    // 封顶并列：+5% 与 +6.2% 的原始增量都超过0.003，封顶后并列，按代码升序取 000001.SZ。
    const capTie = createStandardEngine(plan({ codes, max_positions: 2, daily_buy_limit: 1, position_fraction: 0.75 }));
    warmup(capTie);
    capTie.next(jumpDay([0.05, 0.062]));
    expect(fills(capTie.next(day(1, { close: 11 }, codes)), "buy").map((event) => event.code)).toEqual([codes[0]]);
  });

  it.each([
    ["open_gap_above_cap", { open: 11.8, close: 11.8 }, freeCosts],
    ["slippage_outside_limit", { open: 11.54, close: 11.54 }, { ...freeCosts, slippage_bps: 500 }],
    ["insufficient_cash_or_budget", { open: 11, close: 11 }, { ...freeCosts, minimum_commission: 10000 }],
  ])("买单 %s 后仅下一开盘有效，不顺延", (reason, bar, costs) => {
    const engine = createStandardEngine(plan({ costs }));
    warm(engine); signal(engine);
    const failed = engine.next(day(1, { ...bar, volume: 1 }));
    expect(fills(failed)).toEqual([]);
    if (reason === "open_gap_above_cap") {
      expect(failed.events).toContainEqual(expect.objectContaining({ type: "expired", reason }));
    } else {
      expect(failed.events).toContainEqual(expect.objectContaining({ type: "rejected", reason }));
      expect(failed.events).toContainEqual(expect.objectContaining({ type: "expired", reason: "next_open_only" }));
    }
    expect(fills(engine.next(day(2, { close: bar.close, volume: 1 })))).toEqual([]);
    expect(engine.finish()).toMatchObject({ fees_cents: 0, trade_count: 0, win_rate: null });
  });

  it("T+1开盘价不高于信号收盘5%才能建仓：恰好5%可成交，超过则订单过期", () => {
    const capped = createStandardEngine(plan());
    warm(capped); signal(capped);
    const filled = capped.next(day(1, { open: 11.55, close: 11.55 }));
    expect(fills(filled, "buy")[0]!.details.side).toBe("buy");
    const expired = createStandardEngine(plan());
    warm(expired); signal(expired);
    const skipped = expired.next(day(1, { open: 11.56, close: 11.56 }));
    expect(fills(skipped)).toEqual([]);
    expect(skipped.events).toContainEqual(expect.objectContaining({ type: "expired", reason: "open_gap_above_cap" }));
    expect(expired.finish()).toMatchObject({ trade_count: 0, fees_cents: 0 });
  });

  it("震荡期把每日新开仓限制为震荡名额：单因素触发收紧，取值缺失不放大限制", () => {
    const filter = { composite_slope_band: 0.001, require_all: false, oscillating_daily_buy_limit: 0 };
    const config = plan({ oscillation_filter: filter });
    const engine = createStandardEngine(config);
    warm(engine);
    // 信号日斜率绝对值低于阈值：震荡，名额为0，全部候选被抑制。
    const oscillating = engine.next(day(0, { open: 10.5, close: 11, volume: 200_000 }, [CODE],
      true, { composite_close: 100, composite_ma20: 100, composite_slope: 0.0005,
        industry_rising_ratio: 0.8, industry_adx14_median: 30 }));
    expect(oscillating.events).toContainEqual(expect.objectContaining({ type: "suppressed", reason: "daily_buy_limit" }));
    expect(oscillating.events.some((event) => event.type === "order")).toBe(false);
    // 相同价格路径、因子缺失：过滤器不触发，正常产生订单。
    const control = createStandardEngine(config);
    warm(control);
    const unfiltered = control.next(day(0, { open: 10.5, close: 11, volume: 200_000 }));
    expect(unfiltered.events.some((event) => event.type === "order")).toBe(true);
  });

  it("宽度确认未通过时不开新仓；因素充足且达标则放行", () => {
    const engine = createStandardEngine(plan({ breadth_confirm_min: 0.5 }));
    warm(engine);
    const blocked = engine.next(day(0, { open: 10.5, close: 11, volume: 200_000 }, [CODE],
      true, { composite_close: 100, composite_ma20: 100, composite_slope: 0.01,
        industry_rising_ratio: 0.3, industry_adx14_median: 30 }));
    expect(blocked.events).toContainEqual(expect.objectContaining({ type: "suppressed", reason: "breadth_confirm" }));
    const passing = createStandardEngine(plan({ breadth_confirm_min: 0.5 }));
    warm(passing);
    const allowed = passing.next(day(0, { open: 10.5, close: 11, volume: 200_000 }, [CODE],
      true, { composite_close: 100, composite_ma20: 100, composite_slope: 0.01,
        industry_rising_ratio: 0.7, industry_adx14_median: 30 }));
    expect(allowed.events.some((event) => event.type === "order")).toBe(true);
    expect(allowed.events.some((event) => event.type === "suppressed" && event.reason === "breadth_confirm")).toBe(false);
  });

  it("震荡过滤 require_all 要求全部因素同时成立；计划校验拒绝非右侧与超限名额", () => {
    const filter = { composite_slope_band: 0.001, adx_max: 25, require_all: true, oscillating_daily_buy_limit: 1 };
    // 斜率平但 ADX 强：require_all 下不判定震荡。
    expect(evaluateOscillation({ composite_close: 100, composite_ma20: 100, composite_slope: 0.0005,
      industry_rising_ratio: 0.5, industry_adx14_median: 40 }, filter)).toBe(false);
    // 任一因素缺失时该因素不触发：ADX 缺失且斜率平 → 不震荡。
    expect(evaluateOscillation({ composite_close: 100, composite_ma20: 100, composite_slope: 0.0005,
      industry_rising_ratio: 0.5, industry_adx14_median: null }, filter)).toBe(false);
    // 两因素同时成立 → 震荡。
    expect(evaluateOscillation({ composite_close: 100, composite_ma20: 100, composite_slope: 0.0005,
      industry_rising_ratio: 0.5, industry_adx14_median: 20 }, filter)).toBe(true);
    expect(evaluateOscillation(null, filter)).toBe(false);
    expect(() => validateStandardPlan(plan({ oscillation_filter: filter }))).not.toThrow();
    expect(() => validateStandardPlan(plan({ rule: "left_reversal_daily_v1", oscillation_filter: filter })))
      .toThrow("仅支持右侧");
    expect(() => validateStandardPlan(plan({ oscillation_filter: { ...filter, oscillating_daily_buy_limit: 5 } })))
      .toThrow("不得超过常规每日买入上限");
    expect(() => validateStandardPlan(plan({ breadth_confirm_min: 0.5 }))).not.toThrow();
    expect(() => validateStandardPlan(plan({ rule: "left_reversal_daily_v1", breadth_confirm_min: 0.5 })))
      .toThrow("仅支持右侧");
    expect(() => validateStandardPlan(plan({ breadth_confirm_min: 0.5, environment_mode: "none" })))
      .toThrow("依赖881市场因子");
    const portfolio = { rule: "portfolio_daily_v1" as const, strategies: [{ rule: "left_reversal_daily_v1" as const,
      codes: [CODE], allocation_pct: 1, max_positions: 1, daily_buy_limit: 1, position_fraction: 1 }] };
    expect(() => validateStandardPlan(plan({ ...portfolio, breadth_confirm_min: 0.5 }))).toThrow("仅支持右侧");
    // 组合级熔断已实现：组合计划可携带熔断；其他价格规则仍拒绝。
    expect(() => validateStandardPlan(plan({ ...portfolio, drawdown_circuit: true, stop_streak_circuit: true }))).not.toThrow();
    expect(() => validateStandardPlan(plan({ rule: "trial_start_daily_v1", drawdown_circuit: true }))).toThrow("仅右侧与组合内核实现");
    expect(() => validateStandardPlan(plan({ exit_model: "production_tiered", take_profit_pct: 0.12 }))).toThrow("不与一档止盈并用");
    expect(() => validateStandardPlan(plan({ rule: "left_reversal_daily_v1", exit_model: "production_tiered" }))).toThrow("退出模型仅右侧");
  });

  it("一档止盈：收盘达到止盈线时生成信号，下一开盘全额退出并计入盈利闭环", () => {
    const engine = createStandardEngine(plan({ take_profit_pct: 0.12 }));
    warm(engine); signal(engine);
    const bought = engine.next(day(1, { open: 11, close: 11 }));
    expect(fills(bought, "buy")).toHaveLength(1);
    const win = engine.next(day(2, { open: 12, close: 12.5 }));
    expect(win.events).toContainEqual(expect.objectContaining({ type: "signal", reason: "take_profit" }));
    const sold = engine.next(day(3, { open: 12.5, close: 12.5 }));
    const sellFill = fills(sold, "sell")[0]!;
    expect(sellFill.reason).toBe("take_profit");
    const closedEvent = closed(sold)[0]!;
    expect(closedEvent.reason).toBe("take_profit");
    expect(closedEvent.details.pnl_cents).toBeGreaterThan(0);
    expect(engine.finish()).toMatchObject({ trade_count: 1, win_rate: 1, open_position_count: 0 });
  });

  it("左侧放宽参数只放开超卖深度条件，形态与缺省口径不变", () => {
    // 构造 21 根日线：5日跌 -4.5%（严格-6%不达标）、RSI14=38（严格35不达标）、
    // 收盘低于MA20 6%（严格8%不达标）、且满足缩量长下影形态。
    const rows: LeftSideSignalBar[] = [];
    for (let index = 0; index < 21; index += 1) {
      const close = 10 - Math.max(0, index - 15) * 0.1;
      rows.push({ code: CODE, bar_date: date(index - 30), open: close, high: close * 1.001,
        low: close, close, volume: 100_000, ma20: 10.1, rsi14: 38, indicator_status: "ready" });
    }
    const current = rows.at(-1)!;
    current.open = current.close * 1.005;
    current.low = current.close * 0.965;
    current.high = current.open * 1.001;
    const strict = evaluateLeftSideSignal(rows);
    expect(strict!.price_signal).toBe(false);
    expect(strict!.stage).toBe("base_conditions");
    expect(strict!.conditions.five_day_decline).toBe(false);
    expect(strict!.conditions.rsi_oversold).toBe(false);
    expect(strict!.conditions.below_ma20).toBe(false);
    const loosened = evaluateLeftSideSignal(rows, { five_day_decline_pct: 0.04, rsi_max: 40, ma20_deviation_pct: 0.05 });
    expect(loosened!.price_signal).toBe(true);
    // 形态缺失时放宽也不产生信号。
    const noPattern = rows.map((row) => ({ ...row }));
    noPattern.at(-1)!.low = noPattern.at(-1)!.close;
    expect(evaluateLeftSideSignal(noPattern, { five_day_decline_pct: 0.04, rsi_max: 40, ma20_deviation_pct: 0.05 })!.price_signal).toBe(false);
  });

  it("左侧放宽参数仅限左侧单规则计划", () => {
    expect(() => validateStandardPlan(plan({ rule: "left_reversal_daily_v1", left_reversal_params: { rsi_max: 40 } }))).not.toThrow();
    expect(() => validateStandardPlan(plan({ left_reversal_params: { rsi_max: 40 } }))).toThrow("左侧放宽参数");
    expect(() => validateStandardPlan(plan({ rule: "trial_start_daily_v1", left_reversal_params: { rsi_max: 40 } }))).toThrow("左侧放宽参数");
  });

  it("生产分档退出：冷却期止损、一档分批止盈与移动止损按生产口径触发", () => {
    const engine = createStandardEngine(plan({ exit_model: "production_tiered" }));
    warm(engine); signal(engine);
    const bought = engine.next(day(1, { open: 11, close: 11 }));
    expect(fills(bought, "buy")).toHaveLength(1);
    // 冷却期（第2个交易日）内跌破买入价×0.88 → 冷却止损意图。
    const cooldown = engine.next(day(2, { open: 11, close: 9.5 }));
    expect(cooldown.events).toContainEqual(expect.objectContaining({ type: "signal", reason: "cooldown_stop" }));
    const stopSold = engine.next(day(3, { open: 9.5, close: 9.5 }));
    expect(fills(stopSold, "sell")[0]!.reason).toBe("cooldown_stop");
    expect(engine.finish()).toMatchObject({ trade_count: 1, open_position_count: 0 });
  });

  it("生产分档退出：+12% 卖出一半，剩余持仓在 MA5 保护位下移时移动止损全退", () => {
    const engine = createStandardEngine(plan({ exit_model: "production_tiered" }));
    warm(engine); signal(engine);
    engine.next(day(1, { open: 11, close: 11 }));
    engine.next(day(2, { open: 11, close: 11 }));
    engine.next(day(3, { open: 11, close: 11 }));
    // 第4个交易日（冷却期结束）浮盈 ≥12%：初始 900 股 < 1500，卖出一半 400 股。
    const tier1 = engine.next(day(4, { open: 12.4, close: 12.4 }));
    expect(tier1.events).toContainEqual(expect.objectContaining({ type: "signal", reason: "tier1_take_profit", details: expect.objectContaining({ quantity: 400 }) }));
    const scaled = engine.next(day(5, { open: 12.4, close: 12.4 }));
    const partialSell = fills(scaled, "sell")[0]!;
    expect(partialSell.reason).toBe("tier1_take_profit");
    expect(partialSell.details.quantity).toBe(400);
    expect(scaled.equity!.positions[0]!.quantity).toBe(500);
    // 一档后收盘跌到 MA5×0.99 之下 → 移动止损全退。
    const trailing = engine.next(day(6, { open: 11.5, close: 11.5 }));
    expect(trailing.events).toContainEqual(expect.objectContaining({ type: "signal", reason: "trailing_stop" }));
    const final = engine.next(day(7, { open: 11.5, close: 11.5 }));
    expect(closed(final)[0]!.reason).toBe("trailing_stop");
    expect(engine.finish()).toMatchObject({ trade_count: 1, open_position_count: 0 });
  });

  it("生产分档退出：一档前第 5 个交易日时间兜底退出", () => {
    const engine = createStandardEngine(plan({ exit_model: "production_tiered" }));
    warm(engine); signal(engine);
    engine.next(day(1, { open: 11, close: 11 }));
    engine.next(day(2, { open: 11.2, close: 11.2 }));
    engine.next(day(3, { open: 11.2, close: 11.2 }));
    engine.next(day(4, { open: 11.2, close: 11.2 }));
    const fifth = engine.next(day(5, { open: 11.2, close: 11.2 }));
    expect(fifth.events).toContainEqual(expect.objectContaining({ type: "signal", reason: "time_fallback" }));
    const settled = engine.next(day(6, { open: 11.2, close: 11.2 }));
    expect(closed(settled).map((event) => event.reason)).toContain("time_fallback");
    expect(engine.finish()).toMatchObject({ trade_count: 1, open_position_count: 0 });
  });

  it("组合级熔断：回撤超阈值暂停全部子策略新开仓，回撤窗口滚出且881恢复后重置", () => {
    const codes = CODES.slice(0, 2);
    const config = validateStandardPlan(plan({
      codes, rule: "portfolio_daily_v1", max_positions: 2, daily_buy_limit: 2,
      drawdown_circuit: true, stop_streak_circuit: false,
      strategies: [
        { rule: "right_side_daily_v1", codes: [codes[0]!], allocation_pct: 0.5, max_positions: 1, daily_buy_limit: 1, position_fraction: 0.9, stop_loss_pct: 0.1, max_holding_days: 2520 },
        { rule: "right_side_daily_v1", codes: [codes[1]!], allocation_pct: 0.5, max_positions: 1, daily_buy_limit: 1, position_fraction: 0.9, stop_loss_pct: 0.1, max_holding_days: 2520 },
      ],
    }));
    const engine = createPortfolioEngine(config);
    warm(engine, codes);
    engine.next(day(0, { open: 10.5, close: 11, volume: 200_000 }, codes));
    const filled = engine.next(day(1, { open: 11, close: 11 }, codes));
    expect(fills(filled, "buy")).toHaveLength(2);
    // 深跌触发组合回撤熔断（组合级事件 code 为 null）。
    const crash = engine.next(day(2, { open: 9, close: 9 }, codes));
    expect(crash.events).toContainEqual(expect.objectContaining({ type: "risk_trigger", reason: "drawdown_circuit", code: null }));
    expect(crash.equity!.paused).toBe(true);
    // 止损退出不受限；连续平盘后 20 日窗口滚出旧高点，回撤回到阈值内。
    for (let offset = 3; offset <= 20; offset += 1) engine.next(day(offset, { open: 9.5, close: 9.5 }, codes, true));
    const recoveryDay = engine.next(day(21, { open: 9.6, close: 9.9, volume: 300_000 }, codes, true));
    expect(recoveryDay.events).toContainEqual(expect.objectContaining({ type: "risk_recover", reason: "market_recovery", code: null }));
    expect(recoveryDay.equity!.paused).toBe(false);
    // 恢复后新开仓不再被组合风控抑制（强信号日产生订单而非 risk_paused）。
    const resumed = engine.next(day(22, { open: 10, close: 10.6, volume: 400_000 }, codes, true));
    expect(resumed.events.some((event) => event.type === "order" && event.details.side === "buy")).toBe(true);
    expect(resumed.events.some((event) => event.type === "suppressed" && event.reason === "risk_paused")).toBe(false);
  });

  it("profit_trail 模型去掉时间兜底与复核：盈利单不被第5日强制退出", () => {
    const engine = createStandardEngine(plan({ exit_model: "profit_trail" }));
    warm(engine); signal(engine);
    engine.next(day(1, { open: 11, close: 11 }));
    for (const offset of [2, 3, 4, 5, 6]) engine.next(day(offset, { open: 11.2, close: 11.2 }));
    expect(engine.finish()).toMatchObject({ trade_count: 0, open_position_count: 1 });
  });

  it("股性过滤：20日振幅均值不足的标的不进入候选（时点安全）", () => {
    const engine = createStandardEngine(plan({ min_amplitude_20: 0.01 }));
    warm(engine);
    // 横盘期高低价贴合（20日振幅均值≈0），不足阈值 → 无候选、无订单。
    const filtered = engine.next(day(0, { open: 10.5, close: 11, volume: 200_000 }));
    expect(filtered.events.some((event) => event.type === "order")).toBe(false);
    // 对照：同一路径不启用过滤 → 正常产生订单。
    const control = createStandardEngine(plan());
    warm(control);
    expect(control.next(day(0, { open: 10.5, close: 11, volume: 200_000 })).events.some((event) => event.type === "order")).toBe(true);
  });

  it("开盘缺口上限可收紧：max_open_gap_pct=0 时不追高开盘", () => {
    const engine = createStandardEngine(plan({ max_open_gap_pct: 0 }));
    warm(engine); signal(engine);
    // 信号收盘 11，次日开盘 11.3（高于信号收盘但不超生产 5% 上限）→ 收紧后放弃。
    const skipped = engine.next(day(1, { open: 11.3, close: 11.3 }));
    expect(skipped.events).toContainEqual(expect.objectContaining({ type: "expired", reason: "open_gap_above_cap" }));
    // 开盘不高于信号收盘则可成交。
    const accepted = createStandardEngine(plan({ max_open_gap_pct: 0 }));
    warm(accepted); signal(accepted);
    const filled = accepted.next(day(1, { open: 11, close: 11 }));
    expect(fills(filled, "buy")).toHaveLength(1);
  });

  it("行业动量闸门：仅所属行业动量排名达标（或为正）的候选可入场", () => {
    const CODE_A = "000001.SZ";
    const CODE_B = "000002.SZ";
    const BOARD_A = "881105.TI";
    const BOARD_B = "881136.TI";
    const config = validateStandardPlan(plan({
      codes: [CODE_A, CODE_B], max_positions: 2, daily_buy_limit: 2,
      environment_mode: "current_881",
      industry_groups: [
        { board: BOARD_A, codes: [CODE_A] },
        { board: BOARD_B, codes: [CODE_B] },
      ],
      industry_momentum: { days: 5, top_k: 1 },
    }));
    const engine = createPortfolioEngine(config);
    const stockBar = (offset: number, code: string, open: number, close: number, volume = 300_000) =>
      ({ code, date: date(offset), open, close, high: Math.max(open, close), low: Math.min(open, close), volume });
    const envBar = (offset: number, code: string, close: number) =>
      ({ code, date: date(offset), open: close, close, high: close, low: close, volume: 0 });
    // 60 个种子日（MACD 需 26 根以上收敛）：行业A收盘上行、行业B下行；个股横盘预热。
    for (let offset = -60; offset < 0; offset += 1) {
      engine.next({ date: date(offset), market_recovery: null, bars: [stockBar(offset, CODE_A, 10, 10), stockBar(offset, CODE_B, 10, 10)],
        environment_bars: [envBar(offset, BOARD_A, 10 + (offset + 60) * 0.05), envBar(offset, BOARD_B, 12 - (offset + 60) * 0.05)] });
    }
    // 信号日：两票同时满足六条件；行业A动量为正排名1，行业B为负 → 仅 A 获得订单。
    const day0 = engine.next({ date: date(0), market_recovery: null,
      bars: [stockBar(0, CODE_A, 10.2, 10.4, 600_000), stockBar(0, CODE_B, 10.2, 10.4, 600_000)],
      environment_bars: [envBar(0, BOARD_A, 13), envBar(0, BOARD_B, 8)] });
    const orderCodes = day0.events.filter((event) => event.type === "order").map((event) => event.code);
    expect(orderCodes).toEqual([CODE_A]);
    expect(day0.events.some((event) => event.type === "order" && event.code === CODE_B)).toBe(false);
    // 绝对动量模式（不设 top_k）：行业B动量为负仍然被闸。
    const absolute = validateStandardPlan(plan({
      codes: [CODE_A, CODE_B], max_positions: 2, daily_buy_limit: 2, environment_mode: "current_881",
      industry_groups: [{ board: BOARD_A, codes: [CODE_A] }, { board: BOARD_B, codes: [CODE_B] }],
      industry_momentum: { days: 5 },
    }));
    const absoluteEngine = createPortfolioEngine(absolute);
    for (let offset = -60; offset < 0; offset += 1) {
      absoluteEngine.next({ date: date(offset), market_recovery: null, bars: [stockBar(offset, CODE_A, 10, 10), stockBar(offset, CODE_B, 10, 10)],
        environment_bars: [envBar(offset, BOARD_A, 10 + (offset + 60) * 0.05), envBar(offset, BOARD_B, 12 - (offset + 60) * 0.05)] });
    }
    const absoluteDay = absoluteEngine.next({ date: date(0), market_recovery: null,
      bars: [stockBar(0, CODE_A, 10.2, 10.4, 600_000), stockBar(0, CODE_B, 10.2, 10.4, 600_000)],
      environment_bars: [envBar(0, BOARD_A, 13), envBar(0, BOARD_B, 8)] });
    expect(absoluteDay.events.filter((event) => event.type === "order").map((event) => event.code)).toEqual([CODE_A]);
  });

  it("52周高位过滤：未满足阈值与数据不足的候选被闸", () => {
    const engine = createStandardEngine(plan({ near_52w_high_min: 0.99 }));
    warm(engine, [CODE]);
    // 不足 252 根收盘：闸住（先吃掉 190 个正式日）。
    for (let offset = 0; offset < 190; offset += 1) engine.next(day(offset, { open: 10, close: 10 }));
    const early = engine.next(day(190, { open: 10.5, close: 11, volume: 200_000 }));
    expect(early.events.some((event) => event.type === "order")).toBe(false);
    // 补足 252 根后：创新高的信号日放行。
    for (let offset = 191; offset < 252; offset += 1) engine.next(day(offset, { open: 10, close: 10 }));
    const fresh = engine.next(day(252, { open: 10.5, close: 11, volume: 200_000 }));
    expect(fresh.events.some((event) => event.type === "order")).toBe(true);
    // 远离 52 周高点的信号日被闸（阈值 0.99，收盘 9.8 → 距离 0.98）。
    const far = createStandardEngine(plan({ near_52w_high_min: 0.99 }));
    warm(far, [CODE]);
    for (let offset = 0; offset < 252; offset += 1) far.next(day(offset, { open: 10, close: 10 }));
    const dropped = far.next(day(252, { open: 9.8, close: 9.8, volume: 200_000 }));
    expect(dropped.events.some((event) => event.type === "order")).toBe(false);
  });

  it("波动率目标与回撤连续缩仓：高波动标的仓位更小，回撤加深后预算收缩", () => {
    // 高低波动对照：同一信号形态，高波动票的成交股数应少于低波动票（两个独立单规则引擎）。
    const VOL_A = "000001.SZ";
    const VOL_B = "000002.SZ";
    const runVol = (code: string, swingMode: boolean): number => {
      const engine = createStandardEngine(plan({ codes: [code], initial_cash: 100_000, position_fraction: 0.5, vol_target_sigma: 0.02 }));
      const bar = (offset: number, open: number, close: number, volume: number) =>
        ({ code, date: date(offset), open, close, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, volume });
      for (let offset = -60; offset < 0; offset += 1) {
        // A 高波动：±6% 振荡 + 上行漂移（保证 dif>0）；B 低波动：缓涨。
        const base = 10 * (1 + (offset + 60) * 0.003);
        const swing = swingMode ? (offset % 2 === 0 ? 1.06 : 0.945) : 1;
        engine.next({ date: date(offset), market_recovery: null, bars: [bar(offset, base * swing, base * swing, 300_000)] });
      }
      // 信号日：满足六条件（实体≥1%、量能扩张、MACD 加速）。
      const base0 = 10 * (1 + 60 * 0.003);
      const signalDay = swingMode ? bar(0, base0 * 1.005, base0 * 1.04, 600_000) : bar(0, base0 * 1.005, base0 * 1.03, 600_000);
      engine.next({ date: date(0), market_recovery: null, bars: [signalDay] });
      const nextDay = swingMode ? bar(1, base0 * 1.04, base0 * 1.04, 300_000) : bar(1, base0 * 1.03, base0 * 1.03, 300_000);
      const bought = engine.next({ date: date(1), market_recovery: null, bars: [nextDay] });
      const quantity = fills(bought, "buy")[0]!.details.quantity as number;
      return quantity;
    };
    expect(runVol(VOL_A, true)).toBeLessThan(runVol(VOL_B, false));
    // 回撤连续缩仓：回撤超过阈值后新开仓预算归零（订单生成但执行因预算不足拒绝）。
    const ddEngine = createStandardEngine(plan({ drawdown_scale_max: 0.05 }));
    warm(ddEngine); signal(ddEngine);
    ddEngine.next(day(1, { open: 11, close: 11 }));
    ddEngine.next(day(2, { open: 9.5, close: 9.5 }));
    ddEngine.next(day(3, { open: 9.5, close: 9.5 }));
    // 连续反弹直到 dif 转正出现新信号；期间回撤保持 >5%，预算恒为 0。
    for (let offset = 4; offset <= 8; offset += 1) {
      const prevClose = offset === 4 ? 9.5 : 9.5 * Math.pow(1.03, offset - 4);
      const volume = offset === 8 ? 700_000 : 500_000;
      ddEngine.next(day(offset, { open: prevClose * 1.002, close: prevClose * 1.02, volume }));
    }
    const bought = ddEngine.next(day(9, { open: 10.3 * 1.02 * 1.002, close: 10.3 * 1.02 * 1.002 }));
    expect(fills(bought, "buy")).toEqual([]);
    expect(bought.events.some((event) => event.type === "rejected" && event.reason === "insufficient_cash_or_budget")).toBe(true);
  });

  it("市场因子结构非法时整日拒绝且状态不推进；已生成订单的成交不受次日因子影响", () => {
    const oscillatingFactors = { composite_close: 100, composite_ma20: 100, composite_slope: 0.0005, industry_rising_ratio: 0.8, industry_adx14_median: 30 };
    const calmFactors = { composite_close: 100, composite_ma20: 100, composite_slope: 0.01, industry_rising_ratio: 0.8, industry_adx14_median: 30 };
    const config = plan({ oscillation_filter: { composite_slope_band: 0.001, require_all: false, oscillating_daily_buy_limit: 0 } });
    const engine = createStandardEngine(config);
    warm(engine);
    expect(() => engine.next({ ...day(0), market_factors: { composite_close: -1, composite_ma20: null,
      composite_slope: null, industry_rising_ratio: null, industry_adx14_median: null } } as StandardDay)).toThrow("市场因子");
    // 非法日未推进：合法日重试仍从同一起点开始（震荡日无订单）。
    const signalDay = engine.next(day(0, { open: 10.5, close: 11, volume: 200_000 }, [CODE], true, oscillatingFactors));
    expect(signalDay.events.some((event) => event.type === "order")).toBe(false);
    // 对照：信号日非震荡产生订单；次日即使转为震荡，开盘成交发生在当日决策之前，不受影响。
    const reference = createStandardEngine(config);
    warm(reference);
    const ordered = reference.next(day(0, { open: 10.5, close: 11, volume: 200_000 }, [CODE], true, calmFactors));
    expect(ordered.events.some((event) => event.type === "order")).toBe(true);
    const saved = JSON.stringify(ordered);
    const nextDay = reference.next(day(1, { open: 11, close: 11 }, [CODE], true, oscillatingFactors));
    expect(fills(nextDay, "buy")).toHaveLength(1);
    expect(nextDay.events.some((event) => event.type === "order")).toBe(false);
    expect(JSON.stringify(ordered)).toBe(saved);
  });

  it("容量取截至前一日的完整 20 日均量，不能用信号日放量替代整个窗口", () => {
    const engine = createStandardEngine(plan());
    warm(engine, [CODE], 1);
    for (let i = 0; i < 4; i++) engine.next(day(i, { volume: 1000 }));
    const candidate = signal(engine, [CODE], 4, 1100);
    expect(candidate.events.some((event) => event.type === "order")).toBe(true);
    const rejected = engine.next(day(5, { close: 11, volume: 10_000_000 }));
    expect(fills(rejected)).toEqual([]);
    expect(rejected.events).toContainEqual(expect.objectContaining({ type: "rejected", reason: "prior_volume_capacity" }));
  });

  it("未成交止损意图持续；当日低点不触发盘中止损，收盘相对入场成交价触发", () => {
    const engine = createStandardEngine(plan());
    warm(engine); signal(engine);
    const buy = engine.next(day(1, { open: 11, close: 11, low: 8 }));
    expect(buy.events.some((event) => event.reason === "stop_loss")).toBe(false);
    const stop = engine.next(day(2, { open: 11, close: 9.9 }));
    expect(fills(stop)).toEqual([]);
    expect(stop.events).toContainEqual(expect.objectContaining({ type: "signal", reason: "stop_loss" }));
    const blocked = engine.next(day(3, { open: 8.91, close: 11 }));
    expect(fills(blocked)).toEqual([]);
    expect(blocked.events).toContainEqual(expect.objectContaining({ type: "rejected", reason: "research_price_limit" }));
    const sold = engine.next(day(4, { open: 11, close: 11 }));
    expect(closed(sold)[0]).toMatchObject({ reason: "stop_loss", details: { stop_streak: 1 } });
    expect(sold.equity!.positions).toEqual([]);
  });

  it("容量部分卖出保留成本与退出意图，只有最后完全退出才统计止损闭环", () => {
    const engine = createStandardEngine(plan({ initial_cash: 11005, costs: { ...freeCosts, minimum_commission: 5 } }));
    warm(engine, [CODE], 10_000); signal(engine, [CODE], 0, 11_000);
    const bought = engine.next(day(1, { open: 11, close: 9.9, volume: 1 }));
    expect(bought.equity!.positions[0]).toMatchObject({ quantity: 1000, cost_cents: 1_100_500 });
    const partial = engine.next(day(2, { close: 9.9, volume: 1 }));
    expect(fills(partial)[0]!.details).toMatchObject({ quantity: 900, allocated_cost_cents: 990_450, remaining_quantity: 100 });
    expect(partial.equity!.positions[0]).toMatchObject({ quantity: 100, cost_cents: 110_050 });
    expect(closed(partial)).toEqual([]);
    const final = engine.next(day(3, { close: 9.9, volume: 1 }));
    expect(closed(final)[0]).toMatchObject({ reason: "stop_loss", details: { pnl_cents: -111_500, stop_streak: 1 } });
    expect(final.equity).toMatchObject({ cash_cents: 989_000, fees_cents: 1500, positions: [] });
    expect(engine.finish()).toMatchObject({ trade_count: 1, win_rate: 0 });
  });

  it("恰好 5% 不熔断，严格超过才触发；恢复只能在完整暂停日收盘且无新风险", () => {
    const engine = createStandardEngine(plan({ stop_loss_pct: 0.5, drawdown_circuit: true }));
    warm(engine); signal(engine);
    engine.next(day(1, { open: 10, close: 10 }));
    const exact = engine.next(day(2, { open: 10, close: 9.5 }, [CODE], true));
    expect(exact.equity!.drawdown).toBe(0.05);
    expect(risks(exact)).toEqual([]);
    const trigger = engine.next(day(3, { open: 9.5, close: 9.49999 }, [CODE], true));
    expect(trigger.equity!.paused).toBe(true);
    expect(risks(trigger)).toHaveLength(1);
    expect(recovery(trigger)).toEqual([]);
    const stillRisk = engine.next(day(4, { close: 9.49999 }, [CODE], true));
    expect(recovery(stillRisk)).toEqual([]);
    const unknown = engine.next(day(5, { open: 9.5, close: 10 }, [CODE], null));
    expect(risks(unknown)).toEqual([]);
    expect(unknown.equity!.paused).toBe(true);
    const recovered = engine.next(day(6, { close: 10 }, [CODE], true));
    expect(recovery(recovered)).toHaveLength(1);
    expect(recovered.equity!.paused).toBe(false);
  });

  it("回撤熔断高点仅包含最近 20 次正式结算，不把全期高点当成恢复障碍", () => {
    const engine = createStandardEngine(plan({ stop_loss_pct: 0.5, drawdown_circuit: true }));
    warm(engine); signal(engine);
    engine.next(day(1, { open: 10, close: 12 }));
    for (let i = 2; i <= 20; i++) {
      const result = engine.next(day(i, { close: 11 }, [CODE], true));
      expect(result.equity!.paused).toBe(true);
      expect(recovery(result)).toEqual([]);
    }
    const result = engine.next(day(21, { close: 11 }, [CODE], true));
    expect(result.equity!.drawdown).toBeCloseTo(1 / 12);
    expect(risks(result)).toEqual([]);
    expect(recovery(result)).toHaveLength(1);
  });

  it("三笔新止损闭环触发一次，旧计数不重复触发，null/false 不恢复且恢复清零", () => {
    const codes = CODES.slice(0, 3);
    const engine = createStandardEngine(plan({ codes, initial_cash: 33000, max_positions: 3,
      daily_buy_limit: 3, position_fraction: 1 / 3, stop_streak_circuit: true }));
    warm(engine, codes); signal(engine, codes);
    engine.next(day(1, { open: 11, close: 9.9 }, codes));
    const triggered = engine.next(day(2, { close: 9.9 }, codes, true));
    expect(closed(triggered).map((event) => event.details.stop_streak)).toEqual([1, 2, 3]);
    expect(risks(triggered).map((event) => event.reason)).toEqual(["stop_streak_circuit"]);
    expect(recovery(triggered)).toEqual([]);
    for (const [offset, state] of [[3, null], [4, false]] as const) {
      const held = engine.next(day(offset, { close: 9.9 }, codes, state));
      expect(risks(held)).toEqual([]);
      expect(held.equity!.paused).toBe(true);
    }
    const resumed = engine.next(day(5, { close: 9.9 }, codes, true));
    expect(recovery(resumed)[0]!.details.stop_streak).toBe(0);
    for (let i = 6; i <= 65; i++) engine.next(day(i, { close: 9.9 }, codes));
    const one = day(66, { close: 9.9 }, codes);
    one.bars[0] = { ...one.bars[0]!, open: 10.4, low: 10.4, high: 10.89, close: 10.89, volume: 200_000 };
    engine.next(one);
    const next = day(67, { close: 9.9 }, codes);
    next.bars[0] = { ...next.bars[0]!, open: 10.89, high: 10.89, low: 9.801, close: 9.801 };
    engine.next(next);
    const last = engine.next(day(68, { close: 9.9 }, codes));
    expect(closed(last)).toHaveLength(1);
    expect(closed(last)[0]!.details.stop_streak).toBe(1);
    expect(risks(last)).toEqual([]);
  });

  it("普通亏损退出清零；风险退出优先于普通退出，同日曾达到三次即保留新触发", () => {
    for (const stopCount of [2, 3]) {
      const codes = CODES.slice(0, stopCount + 1);
      const engine = createStandardEngine(plan({ codes, initial_cash: codes.length * 11000,
        max_positions: codes.length, daily_buy_limit: codes.length, position_fraction: 1 / codes.length,
        max_holding_days: 1, stop_streak_circuit: true }));
      warm(engine, codes); signal(engine, codes);
      const buy = day(1, { open: 11, close: 9.9 }, codes);
      buy.bars[0] = { ...buy.bars[0]!, close: 10.5 };
      engine.next(buy);
      const sell = day(2, { close: 9.9 }, codes, true);
      sell.bars[0] = { ...sell.bars[0]!, open: 10.5, close: 10.5, low: 10.5, high: 10.5 };
      const result = engine.next(sell);
      expect(closed(result).map((event) => event.reason)).toEqual([...Array<string>(stopCount).fill("stop_loss"), "max_holding_days"]);
      expect(closed(result).at(-1)!.details).toMatchObject({ stop_streak: 0 });
      expect(Number(closed(result).at(-1)!.details.pnl_cents)).toBeLessThan(0);
      expect(risks(result)).toHaveLength(stopCount === 3 ? 1 : 0);
    }
  });

  it("风险卖出先释放现金再买入；退出失败时不借用预订名额，买单当日过期", () => {
    const codes = CODES.slice(0, 2);
    for (const blocked of [false, true]) {
      const engine = createStandardEngine(plan({ codes }));
      warm(engine, codes);
      const first = day(0, {}, codes);
      first.bars[0] = signalBar(0, codes[0]!);
      engine.next(first);
      const second = day(1, { open: 11, close: 9.9 }, codes);
      second.bars[1] = signalBar(1, codes[1]!);
      engine.next(second);
      const third = day(2, { close: 11 }, codes);
      third.bars[0] = { ...third.bars[0]!, open: blocked ? 8.91 : 9.9, close: 9.9,
        low: blocked ? 8.91 : 9.9, high: 9.9 };
      const result = engine.next(third);
      if (blocked) {
        expect(fills(result)).toEqual([]);
        expect(result.events).toContainEqual(expect.objectContaining({ type: "rejected", code: codes[1], reason: "position_limit" }));
        expect(result.events).toContainEqual(expect.objectContaining({ type: "expired", code: codes[1] }));
      } else {
        expect(fills(result).map((event) => [event.code, event.details.side])).toEqual([[codes[0], "sell"], [codes[1], "buy"]]);
        expect(result.equity).toMatchObject({ cash_cents: 21000, positions: [{ code: codes[1], quantity: 800 }] });
      }
    }
    function signalBar(offset: number, code: string): StandardBar {
      return day(offset, { open: 10.5, close: 11, volume: 200_000 }, [code]).bars[0]!;
    }
  });

  it("完整暂停日的恢复标记仅在收盘生效，恢复日信号到后续开盘才成交", () => {
    const codes = CODES.slice(0, 3);
    const run = (canRecover: boolean | null) => {
      const engine = createStandardEngine(plan({ codes, initial_cash: 33000, max_positions: 3,
        daily_buy_limit: 3, position_fraction: 1 / 3, stop_streak_circuit: true }));
      warm(engine, codes); signal(engine, codes);
      engine.next(day(1, { open: 11, close: 9.9 }, codes));
      engine.next(day(2, { close: 9.9 }, codes, true));
      const closing = engine.next(day(3, { open: 10.5, close: 11, volume: 200_000 }, codes, canRecover));
      const opening = engine.next(day(4, { close: 11 }, codes, true));
      return { closing, opening };
    };
    const resumed = run(true);
    const unknown = run(null);
    expect(fills(resumed.closing)).toEqual(fills(unknown.closing));
    expect(fills(resumed.closing)).toEqual([]);
    expect(recovery(resumed.closing)).toHaveLength(1);
    expect(recovery(unknown.closing)).toEqual([]);
    expect(unknown.closing.events.filter((event) => event.type === "suppressed").map((event) => event.reason))
      .toEqual(["risk_paused", "risk_paused", "risk_paused"]);
    expect(fills(resumed.opening, "buy")).toHaveLength(3);
    expect(fills(unknown.opening, "buy")).toEqual([]);
  });

  it("冻结环境日线只作证据，既不改变成交/指标，也不能自行推导恢复", () => {
    const a = createStandardEngine(plan());
    const b = createStandardEngine(plan({ environment_mode: "none" }));
    warm(a); warm(b); signal(a); signal(b);
    const input = day(1, { close: 11 });
    const evidence = { ...input, environment_bars: day(1, { open: 100, close: 200, volume: 0 }, ["881001.TI"]).bars };
    expect(a.next(evidence)).toEqual(b.next(input));
    const invalid = createStandardEngine(plan());
    for (const environment_bars of [null, [null], [evidence.environment_bars[0]],
      [day(0).bars[0]], [...day(0, { volume: 0 }, ["881001.TI"]).bars, ...day(0, { volume: 0 }, ["881001.TI"]).bars]]) {
      expect(() => invalid.next({ ...day(0), environment_bars } as StandardDay)).toThrow();
    }
    expect(invalid.next({ ...day(0), environment_bars: [] }).equity!.equity_cents).toBe(1_000_000);
  });

  it("止损相对含滑点的入场成交价，而非信号价、开盘原价或含佣金成本", () => {
    const engine = createStandardEngine(plan({ costs: { ...freeCosts, slippage_bps: 100 } }));
    warm(engine); signal(engine);
    const result = engine.next(day(1, { open: 11, close: 9.95 }));
    expect(fills(result)[0]!.details.price).toBe(11.11);
    expect(result.events).toContainEqual(expect.objectContaining({ type: "signal", reason: "stop_loss" }));
    expect(fills(result, "sell")).toEqual([]);
  });

  it("max_holding_days 含买入日但不允许当天卖出；终点持仓估值，不伪造平仓", () => {
    const engine = createStandardEngine(plan({ max_holding_days: 1, end: date(1) }));
    warm(engine); signal(engine);
    const end = engine.next(day(1, { open: 11, close: 12 }));
    expect(fills(end, "buy")).toHaveLength(1);
    expect(fills(end, "sell")).toEqual([]);
    expect(end.events).toContainEqual(expect.objectContaining({ type: "signal", reason: "max_holding_days" }));
    const saved = structuredClone(end);
    expect(engine.finish()).toMatchObject({ total_return: 1_090_000 / 1_000_000 - 1, trade_count: 0, win_rate: null,
      final_equity_cents: 1_090_000, open_position_count: 1 });
    expect(end).toEqual(saved);
  });

  it("严格拒绝未知规则/标的、重复日、未知 tick、非法 OHLCV/日期；非法日不推进状态；缺行情按停牌合法", () => {
    expect(() => createStandardEngine({ ...plan(), rule: "unknown" } as unknown as StandardBacktestPlan)).toThrow();
    expect(() => createStandardEngine(plan({ codes: [CODE, CODE] }))).toThrow();
    expect(() => createStandardEngine(plan({ start: "2024-02-30" }))).toThrow();
    expect(() => createStandardEngine({ ...plan(), tick: true } as StandardBacktestPlan)).toThrow();
    const invalid: unknown[] = [
      { ...day(0), date: "2024-02-30" }, { ...day(0), date: "2024-1-1" }, day(-2192), day(366),
      { ...day(0), market_recovery: undefined }, { ...day(0), tick: "09:30" },
      { ...day(0), bars: [null] }, day(0, { code: "UNKNOWN" }), day(0, { date: date(1) }),
      day(0, { open: Number.NaN }), day(0, { close: Infinity }), day(0, { low: 0 }),
      day(0, { close: -1 }), day(0, { close: 1e20 }), day(0, { high: 9 }), day(0, { low: 11 }),
      day(0, { volume: -1 }), day(0, { volume: 0 }), day(0, { volume: 0.5 }), day(0, { volume: Infinity }),
      { ...day(0), bars: [{ ...day(0).bars[0], tick: "09:30" }] },
    ];
    for (const value of invalid) {
      const engine = createStandardEngine(plan());
      expect(() => engine.next(value as StandardDay)).toThrow();
      expect(engine.next(day(0)).equity!.equity_cents).toBe(1_000_000);
      expect(() => engine.next(day(0))).toThrow();
      expect(() => engine.next(day(-1))).toThrow();
    }
    const codes = CODES.slice(0, 2);
    const engine = createStandardEngine(plan({ codes }));
    warm(engine, codes);
    const duplicate = day(0, {}, codes);
    duplicate.bars[1] = { ...duplicate.bars[0]! };
    expect(() => engine.next(duplicate)).toThrow();
    expect(() => engine.next(day(0, { code: "999999.SZ" }, codes))).toThrow();
    // 部分标的缺行情（停牌近似）合法：只有在场标的参与信号与成交。
    const partialBars = day(0, { open: 10.5, close: 11, volume: 200_000 }, codes).bars.slice(0, 1);
    const partial = engine.next({ date: date(0), market_recovery: null, bars: partialBars });
    expect(partial.equity!.positions).toEqual([]);
    expect(partial.events.filter((event) => event.type === "signal" && event.code !== null).map((event) => event.code)).toEqual([codes[0]]);
    // 全部标的停牌也合法：空结算、无成交。
    const empty = engine.next({ ...day(1, { close: 11 }, codes), bars: [] });
    expect(empty.equity!.positions).toEqual([]);
    expect(empty.equity!.market_value_cents).toBe(0);
  });

  it("停牌日：持仓按最后收盘估值且不重算退出；复牌按新收盘判定，卖出意图保留到复牌开盘", () => {
    const engine = createStandardEngine(plan({ take_profit_pct: 0.12 }));
    warm(engine); signal(engine);
    const bought = engine.next(day(1, { open: 11, close: 11 }));
    expect(fills(bought, "buy")).toHaveLength(1);
    const suspendedDay = { ...day(2, { close: 11 }), bars: [] };
    const suspended = engine.next(suspendedDay);
    expect(suspended.events).toEqual([expect.objectContaining({ type: "signal", code: null, reason: "evaluation_summary" })]);
    expect(suspended.equity!.positions).toEqual([{ code: CODE, quantity: 900, cost_cents: 990_000, close: 11 }]);
    expect(suspended.equity!.market_value_cents).toBe(990_000);
    // 复牌日才有新收盘：达到止盈线即生成止盈意图。
    const resumed = engine.next(day(3, { open: 12.6, close: 12.6 }));
    expect(resumed.events).toContainEqual(expect.objectContaining({ type: "signal", reason: "take_profit" }));
    const sold = engine.next(day(4, { open: 12.6, close: 12.6 }));
    expect(fills(sold, "sell")[0]!.reason).toBe("take_profit");
    expect(engine.finish()).toMatchObject({ trade_count: 1, win_rate: 1 });
  });

  it("停牌日买单过期不成交；信号只能由新收盘产生", () => {
    const engine = createStandardEngine(plan());
    warm(engine); signal(engine);
    const suspended = engine.next({ ...day(1, { close: 11 }), bars: [] });
    expect(fills(suspended)).toEqual([]);
    expect(suspended.events).toContainEqual(expect.objectContaining({ type: "expired", reason: "suspended_no_open" }));
    const after = engine.next(day(2, { close: 11 }));
    expect(fills(after, "buy")).toEqual([]);
    expect(engine.finish()).toMatchObject({ trade_count: 0, fees_cents: 0 });
  });

  it("调用方修改计划、行情或已返回快照不会改写内核状态", () => {
    const original = plan();
    const engine = createStandardEngine(original);
    warm(engine);
    original.costs.minimum_commission = 10000;
    original.codes.length = 0;
    const input = day(0, { open: 10.5, close: 11, volume: 200_000 });
    engine.next(input);
    input.bars[0]!.close = 1;
    const bought = engine.next(day(1, { close: 11 }));
    expect(fills(bought)[0]!.details.quantity).toBe(900);
    bought.equity!.positions[0]!.quantity = 12345;
    bought.equity!.cash_cents = 0;
    const next = engine.next(day(2, { close: 11 }));
    expect(next.equity).toMatchObject({ cash_cents: 10000, positions: [{ quantity: 900 }] });
  });
});

  it("绝对动量闸门：综合指数N日收益低于阈值停止新开仓，恢复后继续；退出不受影响", () => {
    const factors = (close: number): StandardMarketFactors =>
      ({ composite_close: close, composite_ma20: null, composite_slope: null, industry_rising_ratio: null, industry_adx14_median: null });
    // 上涨综合（20 日收益 > 0）与下跌综合两个引擎，其余条件完全一致且都能产生信号。
    const rising = createStandardEngine(plan({ absolute_momentum: { days: 20, min_return: 0 } }));
    const falling = createStandardEngine(plan({ absolute_momentum: { days: 20, min_return: 0 } }));
    for (let i = -40; i < 0; i += 1) {
      const stock = day(i, { volume: 100_000 });
      rising.next({ ...stock, market_factors: factors(100 + (i + 40) * 0.5) });
      falling.next({ ...stock, market_factors: factors(100 - (i + 40) * 0.5) });
    }
    const risingDay = rising.next({ ...day(0, { open: 10.5, close: 11, volume: 200_000 }), market_factors: factors(120) });
    const fallingDay = falling.next({ ...day(0, { open: 10.5, close: 11, volume: 200_000 }), market_factors: factors(80) });
    expect(risingDay.events.some((event) => event.type === "order")).toBe(true);
    expect(fallingDay.events.some((event) => event.type === "order")).toBe(false);
    expect(fallingDay.events).toContainEqual(expect.objectContaining({ type: "signal", code: null, reason: "absolute_momentum_gate" }));
    expect(fallingDay.events).toContainEqual(expect.objectContaining({ type: "suppressed", code: CODE, reason: "absolute_momentum" }));
  });

  it("残差动量：个股N日收益须跑赢基准（无分组用综合指数），跑输基准的候选被过滤", () => {
    const factors = (close: number): StandardMarketFactors =>
      ({ composite_close: close, composite_ma20: null, composite_slope: null, industry_rising_ratio: null, industry_adx14_median: null });
    // days=50 覆盖 34 根有界启动窗口边界（残差序列必须来自 252 根滚动窗口而非 closes）。
    const outperform = createStandardEngine(plan({ residual_momentum: { days: 50, min_value: 0 } }));
    const underperform = createStandardEngine(plan({ residual_momentum: { days: 50, min_value: 0 } }));
    // flat 预热 90 日 + 信号日突破：个股 50 日收益 +10%；温和综合 +4%（个股跑赢）保留，陡涨综合 +11%（跑输）过滤。
    for (let i = -90; i < 0; i += 1) {
      const stock = day(i);
      outperform.next({ ...stock, market_factors: factors(100) });
      underperform.next({ ...stock, market_factors: factors(i >= -50 ? 100 * (1 + (i + 50) * 0.0044) : 100) });
    }
    const kept = outperform.next({ ...day(0, { open: 10.5, close: 11, volume: 200_000 }), market_factors: factors(104) });
    const dropped = underperform.next({ ...day(0, { open: 10.5, close: 11, volume: 200_000 }), market_factors: factors(111) });
    expect(kept.events.some((event) => event.type === "order")).toBe(true);
    expect(dropped.events.some((event) => event.type === "order")).toBe(false);
    expect(dropped.events).not.toContainEqual(expect.objectContaining({ type: "suppressed", code: CODE }));
    expect(dropped.events.find((event) => event.reason === "evaluation_summary")!.details.evaluated).toBe(0);
  });

  it("残差动量行业基准：基准优先取个股所在行业序列，行业外候选回退综合指数", () => {
    const board = "881101.TI";
    const factors = (close: number): StandardMarketFactors =>
      ({ composite_close: close, composite_ma20: null, composite_slope: null, industry_rising_ratio: null, industry_adx14_median: null });
    const config = plan({ codes: [CODE], industry_groups: [{ board, codes: [CODE] }],
      residual_momentum: { days: 50, min_value: 0 } });
    const engine = createStandardEngine(config);
    const envBar = (offset: number, close: number) =>
      ({ code: board, date: date(offset), open: close, close, high: close, low: close, volume: 0 });
    // flat 预热 90 日 + 信号日突破：个股 50 日 +10%；行业 +12%（跑输行业）→ 过滤（综合仅 +3%，若误用综合基准则会放行）。
    for (let i = -90; i < 0; i += 1) {
      engine.next({ ...day(i),
        market_factors: factors(100),
        environment_bars: [envBar(i, i >= -50 ? 100 * (1 + (i + 50) * 0.0048) : 100)] });
    }
    const result = engine.next({ ...day(0, { open: 10.5, close: 11, volume: 200_000 }),
      market_factors: factors(103), environment_bars: [envBar(0, 112)] });
    expect(result.events.some((event) => event.type === "order")).toBe(false);
    expect(result.events.find((event) => event.reason === "evaluation_summary")!.details.evaluated).toBe(0);
  });

  it("行业分组与残差动量组合校验：分组可单独作为残差基准，无消费方的分组被拒绝", () => {
    const groups = [{ board: "881101.TI", codes: [CODE] }];
    expect(() => validateStandardPlan(plan({ industry_groups: groups, residual_momentum: { days: 20, min_value: 0 } }))).not.toThrow();
    expect(() => validateStandardPlan(plan({ industry_groups: groups }))).toThrow("至少启用其一");
    expect(() => validateStandardPlan(plan({ environment_mode: "synthetic_881", industry_groups: groups,
      industry_momentum: { days: 20, top_k: 1 } }))).not.toThrow();
    expect(() => validateStandardPlan(plan({ absolute_momentum: { days: 20, min_return: 0 } } as Partial<StandardBacktestPlan>)))
      .not.toThrow();
  });

  it("右侧信号消融参数：部分确认、条件屏蔽与阈值覆盖改变信号触发（缺省行为不变）", () => {
    // 量能未放大（与预热持平）的突破日（收盘+8%，避开涨停使量能阈值不减半）：历史六条件口径无信号；
    // min5 或屏蔽量能条件后触发。
    const quietVolumeDay = { ...day(0, { open: 10.5, close: 10.8, volume: 100_000 }) };
    const strict = createStandardEngine(plan());
    const minFive = createStandardEngine(plan({ right_side_params: { min_passed_count: 5 } }));
    const noVolume = createStandardEngine(plan({ right_side_params: { disable_conditions: ["volume_expanding"] } }));
    for (const engine of [strict, minFive, noVolume]) {
      for (let i = -60; i < 0; i += 1) engine.next(day(i));
    }
    const strictResult = strict.next(quietVolumeDay);
    const fiveResult = minFive.next(quietVolumeDay);
    const noVolumeResult = noVolume.next(quietVolumeDay);
    expect(strictResult.events.some((event) => event.type === "signal" && event.code === CODE)).toBe(false);
    expect(fiveResult.events.some((event) => event.type === "order")).toBe(true);
    expect(noVolumeResult.events.some((event) => event.type === "order")).toBe(true);
    // 阈值覆盖：弱阳线（+0.47% < 生产1%）默认无信号；body_min_pct=0.004 时触发。
    const weakBodyDay = day(0, { open: 10.75, close: 10.8, volume: 200_000 });
    const weakStrict = createStandardEngine(plan());
    const weakBody = createStandardEngine(plan({ right_side_params: { body_min_pct: 0.004 } }));
    for (const engine of [weakStrict, weakBody]) {
      for (let i = -60; i < 0; i += 1) engine.next(day(i));
    }
    expect(weakStrict.next(weakBodyDay).events.some((event) => event.type === "order")).toBe(false);
    expect(weakBody.next(weakBodyDay).events.some((event) => event.type === "order")).toBe(true);
    // 校验：门槛不得超过启用条件数；消融参数仅右侧规则支持。
    expect(() => validateStandardPlan(plan({ right_side_params: { min_passed_count: 6, disable_conditions: ["volume_expanding"] } })))
      .toThrow("不得超过启用条件数");
  });

  it("抗洗盘缓冲与自适应门禁：缓冲改变转弱触发点，门禁按宽度切换上限", () => {
    const plan0 = { ...plan(), initial_cash: 100_000, max_positions: 1, daily_buy_limit: 1 };
    // —— 抗洗盘缓冲：V型洗盘形态手工构造不稳定，行为差异由真数据矩阵验证；此处验证参数接入契约 ——
    expect(() => validateStandardPlan({ ...plan0, weakness_ma10_buffer: 0.03 })).not.toThrow();
    expect(() => createStandardEngine(validateStandardPlan({ ...plan0, weakness_ma10_buffer: 0.03 }))).not.toThrow();
    expect(() => validateStandardPlan({ ...plan0, adaptive_open_gap: { strong: 0.05, weak: 0.02 } })).not.toThrow();
    expect(() => validateStandardPlan({ ...plan0, environment_mode: "none", adaptive_open_gap: { strong: 0.05, weak: 0.02 } } as Partial<StandardBacktestPlan>)).toThrow("881宽度因子");
    expect(() => validateStandardPlan({ ...plan0, adaptive_open_gap: { strong: 0.02, weak: 0.05 } })).toThrow("不得宽于");
    expect(() => validateStandardPlan({ ...plan0, adaptive_weakness_buffer: { strong: 0.15, weak: 0 } })).not.toThrow();
    expect(() => validateStandardPlan({ ...plan0, weakness_ma10_buffer: 0.05, adaptive_weakness_buffer: { strong: 0.15, weak: 0 } })).toThrow("不得同时设置");
    expect(() => validateStandardPlan({ ...plan0, environment_mode: "none", adaptive_weakness_buffer: { strong: 0.15, weak: 0 } } as Partial<StandardBacktestPlan>)).toThrow("881宽度因子");
    // —— 自适应门禁：宽度强用 strong、宽度弱用 weak ——
    const factors = (ratio: number): StandardMarketFactors =>
      ({ composite_close: 100, composite_ma20: null, composite_slope: null, industry_rising_ratio: ratio, industry_adx14_median: null });
    const gapEngine = (ratio: number) => {
      const engine = createStandardEngine(validateStandardPlan({ ...plan0,
        adaptive_open_gap: { strong: 0.05, weak: 0.02 },
        max_open_gap_pct: 0.2 })); // 计划级上限放宽，验证 adaptive 接管
      for (let i = -40; i < 0; i += 1) engine.next({ ...day(i), market_factors: factors(ratio) });
      // 信号日高开 4%：宽度强（0.7）应按 5% 上限放行，宽度弱（0.3）应按 2% 上限拒绝
      const signalDay = engine.next({ ...day(0, { open: 10.5, close: 11, volume: 200_000 }), market_factors: factors(ratio) });
      expect(signalDay.events.some(e => e.type === "order")).toBe(true);
      const openDay = engine.next({ ...day(1, { open: 11.44, close: 11.44, volume: 150_000 }), market_factors: factors(ratio) });
      return openDay.events.some(e => e.type === "expired" && e.reason === "open_gap_above_cap");
    };
    expect(gapEngine(0.7)).toBe(false); // 宽度强：4% 高开 < 5% 上限 → 成交
    expect(gapEngine(0.3)).toBe(true);  // 宽度弱：4% 高开 > 2% 上限 → 拒绝
  });
