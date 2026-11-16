// 盘中展示去抖与模型输出宽松边界的纯函数测试：不依赖数据库与真实模型。
import { describe, expect, it } from "vitest";
import {
  applyIntradayDebounceRound,
  initialIntradayDebounceState,
  replayIntradayDebounce,
  INTRADAY_DEBOUNCE_CONFIRM_ROUNDS,
  INTRADAY_DEBOUNCE_MIN_HOLD_ROUNDS,
  type IntradayDebounceRound,
} from "../../server/modules/intraday-risk/debounce.js";
import { normalizeIntradaySignals } from "../../server/modules/intraday-risk/signals.js";

const round = (action: "add" | "reduce" | "wait", dataUsable = true): IntradayDebounceRound => ({ action, dataUsable });

function playback(actions: Array<"add" | "reduce" | "wait">): Array<"add" | "reduce" | "wait"> {
  let state = initialIntradayDebounceState();
  return actions.map((action) => {
    const decision = applyIntradayDebounceRound(state, round(action));
    state = decision.state;
    return decision.displayAction;
  });
}

describe("盘中展示去抖", () => {
  it("阈值常量与实测口径一致", () => {
    expect(INTRADAY_DEBOUNCE_CONFIRM_ROUNDS).toBe(2);
    expect(INTRADAY_DEBOUNCE_MIN_HOLD_ROUNDS).toBe(2);
  });

  it("单轮反向不翻转，连续两轮才确认", () => {
    // wait → add 第一轮仍展示 wait，第二轮才 add。
    expect(playback(["add", "add"])).toEqual(["wait", "add"]);
    // 已确认 add 后有 2 轮最短保持；连续 reduce 要等保持期结束才转。
    expect(playback(["add", "add", "reduce", "reduce", "reduce"]))
      .toEqual(["wait", "add", "add", "add", "reduce"]);
  });

  it("同方向来回抖动不会形成切换", () => {
    // 实测最常见的形态：触发一轮就回到 wait。
    expect(playback(["wait", "add", "wait", "add", "wait", "reduce", "wait"]))
      .toEqual(["wait", "wait", "wait", "wait", "wait", "wait", "wait"]);
  });

  it("确认后至少有最短保持轮，期间不跟着反向", () => {
    const config = { confirmRounds: 2, minHoldRounds: 2 };
    let state = initialIntradayDebounceState();
    // 用两轮确认 add。
    state = applyIntradayDebounceRound(state, round("add"), config).state;
    state = applyIntradayDebounceRound(state, round("add"), config).state;
    expect(state.confirmed).toBe("add");
    // 接下来连续 reduce，也要等保持轮结束才切换。
    const first = applyIntradayDebounceRound(state, round("reduce"), config);
    const second = applyIntradayDebounceRound(first.state, round("reduce"), config);
    const third = applyIntradayDebounceRound(second.state, round("reduce"), config);
    expect([first.displayAction, second.displayAction, third.displayAction]).toEqual(["add", "add", "reduce"]);
  });

  it("数据不足的轮次不计数、不改变已确认方向", () => {
    const config = { confirmRounds: 2, minHoldRounds: 0 };
    let state = initialIntradayDebounceState();
    state = applyIntradayDebounceRound(state, round("add"), config).state;
    state = applyIntradayDebounceRound(state, round("add"), config).state;
    expect(state.confirmed).toBe("add");
    // 中间插入缺数轮：反向计数被打断。
    const missing = applyIntradayDebounceRound(state, round("reduce", false), config);
    const after = applyIntradayDebounceRound(missing.state, round("reduce"), config);
    expect(missing.displayAction).toBe("add");
    expect(after.displayAction).toBe("add");
    expect(after.state.pendingCount).toBe(1);
  });

  it("回放历史与逐轮应用结果一致", () => {
    const actions: Array<"add" | "reduce" | "wait"> = ["wait", "add", "add", "reduce", "wait", "wait", "wait"];
    const state = replayIntradayDebounce(actions.map((action) => round(action)));
    expect(state.confirmed).toBe(playback(actions).at(-1));
  });
});

describe("模型输出宽松边界（修复漏轮）", () => {
  const CODE = "990098.SZ";
  const codes = new Set([CODE]);
  const candidate = {
    code: CODE, action: "add", emotion: "ice_point", reason: "冰点后缩量止跌并回收日内平台",
    add_plan: {
      price_lower: 10.2, price_upper: 10.4, condition: "缩量回踩后放量回收",
      invalidation: "再次放量下探", status: "triggered",
    },
    reduce_plan: null,
  };
  const prices = new Map([[CODE, 10.3]]);

  it("超长条件只截断，不丢整轮", () => {
    const signal = normalizeIntradaySignals({
      items: [{ ...candidate, add_plan: { ...candidate.add_plan, condition: "回".repeat(300) } }],
    }, codes, prices, true)[0]!;
    expect(signal.action).toBe("add");
    expect(signal.add_plan?.condition).toHaveLength(160);
  });

  it("非法预案被丢弃并降级为 wait，不影响其他持仓", () => {
    const other = "990099.SZ";
    const signal = normalizeIntradaySignals({
      items: [
        { ...candidate, add_plan: "not-an-object" },
        { ...candidate, code: other, action: "wait", add_plan: null, reduce_plan: null },
      ],
    }, new Set([CODE, other]), new Map([[CODE, 10.3], [other, 9.9]]), true);
    expect(signal[0]).toMatchObject({ action: "wait", add_plan: null });
    expect(signal[1]).toMatchObject({ code: other, action: "wait" });
  });

  it("缺失、未知与重复代码降级为 wait 或忽略，不再整轮失败", () => {
    const signal = normalizeIntradaySignals({
      items: [
        { ...candidate, code: "000000.SZ" },
        { ...candidate, action: "wait", add_plan: { ...candidate.add_plan, status: "waiting" } },
        { ...candidate, action: "add" },
      ],
    }, codes, prices, true);
    expect(signal).toHaveLength(1);
    expect(signal[0]).toMatchObject({ code: CODE, action: "wait", add_plan: { status: "waiting" } });
  });

  it("相反预案同时触发时双双降级，不会产生触发动作", () => {
    const signal = normalizeIntradaySignals({
      items: [{ ...candidate, reduce_plan: { ...candidate.add_plan, price_lower: 10.1, price_upper: 10.4 } }],
    }, codes, prices, true)[0]!;
    expect(signal.action).toBe("wait");
    expect(signal.add_plan?.status).toBe("waiting");
    expect(signal.reduce_plan?.status).toBe("waiting");
  });
});
