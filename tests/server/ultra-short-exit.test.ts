// 05 离场纯规则 + 真实成交关联：打板与低吸分开，硬止损优先。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { prepareTestDb, seedTestStrategy } from "./helpers.js";
import {
  countTodayStopLosses,
  evaluateExit,
  gradeBoardOpen,
  resolveR,
  resolveTradeLine,
} from "../../server/modules/ultra-short/exit.js";

import { attachQueuedPosition, listWatchlist, replaceWatchlist } from "../../server/modules/ultra-short/repo.js";
import { recordPositionChange } from "../../server/modules/positions/repo.js";
import type {
  ExitContext,
  UltraShortWatchlistRow,
  WatchlistDraft,
} from "../../server/modules/ultra-short/types.js";

const prepared = await prepareTestDb();
const TARGET = "2026-10-21";
const DATA = "2026-10-20";

function row(overrides: Partial<UltraShortWatchlistRow> = {}): UltraShortWatchlistRow {
  return {
    id: "1", target_date: TARGET, data_date: DATA, code: "600001.SH", name: "测试股",
    sources: ["post_close"], tags: ["打板接力"], resonance: false, priority: "P1",
    priority_reason: "测试", stage: "二至三板", streak_count: 2, t_facts: {},
    key_levels: { prev_close: 10, limit_up_price: 11, stop_price: 10.56 },
    auction_expect: {}, intraday_plan: {}, risk: { stop_pct: 4, position_cap_pct: 30 },
    review_status: "pass", risk_level: "low", risk_flags: [], review_note: null, review_sources: [],
    auction_branch: null, auction_fill_tier: null, auction_priority: null, auction_metrics: {},
    queue_window: {}, auction_note: null, auction_status: "ready", intraday_status: "filled",
    trigger_type: null, trigger_at: null, trigger_price: null, trigger_reason: null, intraday_note: null,
    reminder_at: null, reminder_type: null, reminder_status: null, reminder_note: null,
    gaps: [], data_status: "ready", entry_price: 11, position_opened_at: DATA, exit_status: "holding",
    exit_stage: 0, exit_reason: null, exit_price: null, exit_at: null, realized_r: null,
    exit_reminder_at: null, exit_reminder_type: null, updated_at: "2026-10-20T10:00:00+08:00",
    ...overrides,
  };
}

function context(overrides: Partial<ExitContext> = {}): ExitContext {
  return {
    trade_date: TARGET, now: new Date("2026-10-21T10:00:00+08:00"), holding_days: 2,
    sealed_before: false, open_since_ms: null, open_count: 0, seal_money: null,
    max_seal_money: null, open_volume_ratio: null, same_height_open: false,
    market_break_rate: null, limit_up_price: 11, open_pct: null, ...overrides,
  };
}

describe("05 离场纯规则", () => {
  it("区分打板与低吸", () => {
    expect(resolveTradeLine(row())).toBe("board");
    expect(resolveTradeLine(row({ tags: ["龙回头"], sources: ["low_buy"] }))).toBe("low_buy");
  });

  it("硬止损优先于一切，跌破即清仓", () => {
    const decision = evaluateExit(row(), { close: 10.5 }, context());
    expect(decision).toMatchObject({ action: "sell_all", reason: "hard_stop", data_status: "ready" });
  });

  it("R 与止盈按入场价和结构止损计算", () => {
    const resolved = resolveR(row())!;
    expect(resolved.entry).toBe(11);
    expect(resolved.stop).toBeCloseTo(10.56, 2);
    expect(resolved.r).toBeCloseTo(0.44, 2);
  });

  it("打板封住持有，断板时间止损清仓", () => {
    expect(evaluateExit(row(), { close: 11 }, context({ sealed_before: true })).action).toBe("hold");
    const timeStop = evaluateExit(row(), { close: 10.8 }, context({
      now: new Date("2026-10-21T14:55:00+08:00"),
    }));
    expect(timeStop).toMatchObject({ action: "sell_all", reason: "time_stop" });
  });

  it("开板分级：强回封持有、弱回封卖一半、弱转跌清仓", () => {
    const open = (ctx: Partial<ExitContext>) => evaluateExit(row(), { close: 10.95 }, context({
      sealed_before: true, open_since_ms: new Date("2026-10-21T10:00:00+08:00").getTime() - 20_000,
      open_count: 1, seal_money: 900, max_seal_money: 1000, open_volume_ratio: 1, ...ctx,
    }));
    expect(open({})).toMatchObject({ action: "hold" });
    expect(open({ open_since_ms: new Date("2026-10-21T10:00:00+08:00").getTime() - 120_000, seal_money: 500 }))
      .toMatchObject({ action: "sell_half", reason: "board_open_weak" });
    expect(open({ open_since_ms: new Date("2026-10-21T10:00:00+08:00").getTime() - 240_000, seal_money: 350 }))
      .toMatchObject({ action: "sell_all", reason: "board_break" });
  });

  it("高位板/尾盘/第三次开板/放量开板直接清仓", () => {
    const openCtx = context({
      sealed_before: true, open_since_ms: new Date("2026-10-21T10:00:00+08:00").getTime() - 10_000,
      open_count: 1, seal_money: 900, max_seal_money: 1000,
    });
    expect(gradeBoardOpen(row({ streak_count: 5 }), openCtx)).toMatchObject({ action: "sell_all" });
    expect(gradeBoardOpen(row(), context({
      ...openCtx, now: new Date("2026-10-21T14:40:00+08:00"),
    }))).toMatchObject({ action: "sell_all" });
    expect(gradeBoardOpen(row(), { ...openCtx, open_count: 3 })).toMatchObject({ action: "sell_all" });
    expect(gradeBoardOpen(row(), { ...openCtx, open_volume_ratio: 3 })).toMatchObject({ action: "sell_all" });
  });

  it("一字板第一次开板卖一半，第二次开板清仓", () => {
    const oneWord = row({ tags: ["打板接力", "一字延续"] });
    const ctx = context({
      sealed_before: true, open_since_ms: new Date("2026-10-21T10:00:00+08:00").getTime() - 90_000,
      open_count: 1, seal_money: 900, max_seal_money: 1000,
    });
    expect(gradeBoardOpen(oneWord, ctx)).toMatchObject({ action: "sell_half" });
    expect(gradeBoardOpen(oneWord, { ...ctx, open_count: 3 })).toMatchObject({ action: "sell_all" });
  });

  it("已因开板卖过一半，再次弱开板清剩余", () => {
    const decision = evaluateExit(row({ exit_stage: 1 }), { close: 10.95 }, context({
      sealed_before: true,
      open_since_ms: new Date("2026-10-21T10:00:00+08:00").getTime() - 120_000,
      open_count: 2, seal_money: 500, max_seal_money: 1000, open_volume_ratio: 1,
    }));
    expect(decision).toMatchObject({ action: "sell_all", reason: "board_break" });
  });

  it("D+1 开盘纪律：低开/高开不足3%开盘卖，高开>5%冲高不封卖一半、10:00 未封清仓", () => {
    const at = (hhmm: string) => new Date(`2026-10-21T${hhmm}:00+08:00`);
    expect(evaluateExit(row(), { close: 10.8 }, context({ now: at("09:31"), open_pct: 0 })))
      .toMatchObject({ action: "sell_all", reason: "board_open_weak" });
    expect(evaluateExit(row(), { close: 10.82 }, context({ now: at("09:32"), open_pct: 2 })))
      .toMatchObject({ action: "sell_all", reason: "board_open_weak" });
    expect(evaluateExit(row(), { close: 10.9 }, context({ now: at("09:36"), open_pct: 4 })))
      .toMatchObject({ action: "sell_half", reason: "board_open_weak" });
    expect(evaluateExit(row(), { close: 10.9 }, context({ now: at("09:36"), open_pct: 6 })))
      .toMatchObject({ action: "sell_half", reason: "board_open_weak" });
    expect(evaluateExit(row(), { close: 10.9 }, context({ now: at("10:00"), open_pct: 6 })))
      .toMatchObject({ action: "sell_all", reason: "board_break" });
  });

  it("低吸第一止盈卖一半、第二止盈清仓、回落成本清剩余", () => {
    const low = row({
      tags: ["龙回头"], sources: ["low_buy"], entry_price: 10,
      key_levels: { stop_price: 9.6 },
    });
    const ctx = context({ limit_up_price: null });
    expect(evaluateExit(low, { close: 10.65 }, ctx)).toMatchObject({ action: "sell_half", reason: "target_1" });
    expect(evaluateExit(low, { close: 11.1 }, ctx)).toMatchObject({ action: "sell_all", reason: "target_2" });
    expect(evaluateExit({ ...low, exit_stage: 1 }, { close: 10 }, ctx)).toMatchObject({ action: "sell_all", reason: "take_profit_weak" });
  });

  it("低吸时间止损：线上阴线第 2 日未收复均线即清", () => {
    const low = row({
      tags: ["线上阴线买"], sources: ["low_buy"], entry_price: 10,
      key_levels: { stop_price: 9.6 },
    });
    const decision = evaluateExit(low, { close: 10.05 }, context({
      now: new Date("2026-10-21T14:50:00+08:00"), holding_days: 2, limit_up_price: null,
    }));
    expect(decision).toMatchObject({ action: "sell_all", reason: "time_stop" });
  });

  it("缺行情不猜，标 insufficient", () => {
    expect(evaluateExit(row(), null, context())).toMatchObject({ action: "hold", data_status: "insufficient" });
  });
});

describe.skipIf(!prepared)("05 真实成交关联", () => {
  let pool: pg.Pool;

  function draft(code: string): WatchlistDraft {
    return {
      code, name: "测试股", sources: ["post_close"], tags: ["打板接力"], resonance: false,
      priority: "P1", priority_reason: "测试", stage: "二至三板", streak_count: 2, t_facts: {},
      key_levels: { prev_close: 10, limit_up_price: 11, stop_price: 10.56 },
      auction_expect: {}, intraday_plan: {}, risk: { stop_pct: 4, position_cap_pct: 30 },
      review_status: "pass", risk_level: "low", risk_flags: [], review_note: null, gaps: [], data_status: "ready",
    };
  }

  beforeAll(async () => {
    pool = prepared!.pool;
    await seedTestStrategy(pool);
    await pool.query("INSERT INTO market_instrument (code,name,kind) VALUES ('600001.SH','测试股','stock') ON CONFLICT (code) DO NOTHING");
  });
  afterAll(async () => { await pool.end(); });

  it("买入写 holding + 入场价，清仓写 closed + realized_r", async () => {
    await pool.query("DELETE FROM portfolio_position WHERE instrument_id=(SELECT id FROM market_instrument WHERE code='600001.SH')");
    await pool.query("DELETE FROM portfolio_position_change WHERE instrument_id=(SELECT id FROM market_instrument WHERE code='600001.SH')");
    await replaceWatchlist(pool, TARGET, DATA, [draft("600001.SH")]);

    await recordPositionChange(pool, {
      code: "600001.SH", kind: "buy", quantity: 100, price: 11, change_date: TARGET,
      source: "job", decision_origin: "strategy_signal", execution_compliance: "matched",
      strategy_code: "limit_up", entry_signal_type: "limit_up",
    });
    let watch = (await listWatchlist(pool, TARGET))[0]!;
    expect(watch).toMatchObject({ exit_status: "holding", entry_price: 11, intraday_status: "filled" });

    await recordPositionChange(pool, {
      code: "600001.SH", kind: "sell", quantity: 100, price: 10.5, change_date: "2026-10-22",
      source: "job", decision_origin: "strategy_signal", execution_compliance: "matched",
    });
    watch = (await listWatchlist(pool, TARGET))[0]!;
    expect(watch).toMatchObject({ exit_status: "closed", exit_price: 10.5, exit_stage: 2 });
    expect(watch.realized_r).toBeCloseTo(-1.14, 2);
  });

  it("03 构建时补关联 T 日排队成交的 02 持仓", async () => {
    await pool.query("DELETE FROM portfolio_position WHERE instrument_id=(SELECT id FROM market_instrument WHERE code='600001.SH')");
    await replaceWatchlist(pool, TARGET, DATA, [draft("600001.SH")]);
    await recordPositionChange(pool, {
      code: "600001.SH", kind: "buy", quantity: 100, price: 10.9, change_date: DATA,
      source: "job", decision_origin: "strategy_signal", execution_compliance: "matched",
      strategy_code: "limit_up", entry_signal_type: "limit_up",
    });
    expect(await attachQueuedPosition(pool, TARGET, DATA)).toBe(1);
    const watch = (await listWatchlist(pool, TARGET))[0]!;
    expect(watch).toMatchObject({ exit_status: "holding", entry_price: 10.9 });
  });

  it("熔断统计当日 limit_up 亏损卖出", async () => {
    expect(await countTodayStopLosses(pool, "2026-10-22")).toBe(1);
  });
});
