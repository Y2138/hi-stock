import type { IntradayAction } from "./signals.js";

// 盘中动作展示去抖：只影响给用户的提醒与 API 展示，不改动落库的原始判断。
//
// 阈值依据：2026-10-23～2026-11-10 的 intraday_position_signal 实测 39 个「标的-日」共 2944 轮、
// 330 次动作切换；已触发态（add/reduce）的连续段共 167 段，其中单轮游走 142 段（85%）、
// 不超过 2 轮的 156 段（93%）。连续 2 轮确认可把切换降到 49 次（-85%）；再加 2 轮最短保持降到 47 次，
// 收益有限但能挡住确认后立刻反向。采样约 90 秒/轮，确认延迟约 1.5～3 分钟，仍在盘中可接受范围。
export const INTRADAY_DEBOUNCE_CONFIRM_ROUNDS = 2;
export const INTRADAY_DEBOUNCE_MIN_HOLD_ROUNDS = 2;

export interface IntradayDebounceRound {
  action: IntradayAction;
  /** false 表示本轮量价采样不足或过期，不参与翻转计数。 */
  dataUsable: boolean;
}

export interface IntradayDebounceState {
  /** 已确认并对外展示的方向。 */
  confirmed: IntradayAction;
  /** 还需经过多少轮才允许再次切换。 */
  holdRemaining: number;
  /** 正在累积的反向动作。 */
  pending: IntradayAction | null;
  pendingCount: number;
}

export interface IntradayDebounceDecision {
  state: IntradayDebounceState;
  displayAction: IntradayAction;
  /** 本轮是否刚完成一次确认切换。 */
  confirmedNow: boolean;
}

export function initialIntradayDebounceState(): IntradayDebounceState {
  return { confirmed: "wait", holdRemaining: 0, pending: null, pendingCount: 0 };
}

/**
 * 处理一轮原始动作。
 *
 * 规则（保守口径）：
 * - 数据不足的轮次不参与确认，也不改变已确认方向；
 * - 任何方向变化（含触发态回到 wait）都要连续 CONFIRM 轮才生效；
 * - 每次确认后至少保持 MIN_HOLD 轮，期间即使连续确认也先不改展示。
 */
export function applyIntradayDebounceRound(
  state: IntradayDebounceState,
  round: IntradayDebounceRound,
  config: { confirmRounds: number; minHoldRounds: number } = {
    confirmRounds: INTRADAY_DEBOUNCE_CONFIRM_ROUNDS,
    minHoldRounds: INTRADAY_DEBOUNCE_MIN_HOLD_ROUNDS,
  },
): IntradayDebounceDecision {
  // holdRemaining 是还要挡住的轮数：确认后先挡住 minHoldRounds 轮，期间仍累积反向计数。
  const blocked = state.holdRemaining > 0;
  const holdRemaining = blocked ? state.holdRemaining - 1 : 0;
  if (!round.dataUsable) {
    return {
      state: { confirmed: state.confirmed, holdRemaining, pending: null, pendingCount: 0 },
      displayAction: state.confirmed,
      confirmedNow: false,
    };
  }
  if (round.action === state.confirmed) {
    return {
      state: { confirmed: state.confirmed, holdRemaining, pending: null, pendingCount: 0 },
      displayAction: state.confirmed,
      confirmedNow: false,
    };
  }
  const pendingCount = state.pending === round.action ? state.pendingCount + 1 : 1;
  if (!blocked && pendingCount >= config.confirmRounds) {
    return {
      state: { confirmed: round.action, holdRemaining: config.minHoldRounds, pending: null, pendingCount: 0 },
      displayAction: round.action,
      confirmedNow: true,
    };
  }
  return {
    state: { confirmed: state.confirmed, holdRemaining, pending: round.action, pendingCount },
    displayAction: state.confirmed,
    confirmedNow: false,
  };
}

/** 回放一段历史，得到当前展示方向；用于进程重启后从数据库重建状态。 */
export function replayIntradayDebounce(
  rounds: IntradayDebounceRound[],
  config: { confirmRounds: number; minHoldRounds: number } = {
    confirmRounds: INTRADAY_DEBOUNCE_CONFIRM_ROUNDS,
    minHoldRounds: INTRADAY_DEBOUNCE_MIN_HOLD_ROUNDS,
  },
): IntradayDebounceState {
  return rounds.reduce((state, round) => applyIntradayDebounceRound(state, round, config).state, initialIntradayDebounceState());
}
