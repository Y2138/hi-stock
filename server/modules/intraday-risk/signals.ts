export type IntradayAction = "add" | "reduce" | "wait";
export type MarketEmotion = "ice_point" | "weak" | "neutral" | "strong" | "unknown";
export interface IntradayTradePlan {
  price_lower: number;
  price_upper: number;
  condition: string;
  invalidation: string;
  status: "waiting" | "triggered";
}
export interface IntradaySignal {
  code: string;
  action: IntradayAction;
  add_plan: IntradayTradePlan | null;
  reduce_plan: IntradayTradePlan | null;
  emotion: MarketEmotion;
  reason: string;
  /** 本轮量价采样是否可用；展示去抖据此排除缺数轮，不落库。 */
  data_usable?: boolean;
}

export const ACTION_LABELS: Record<IntradayAction, string> = { add: "加仓触发", reduce: "减仓触发", wait: "等待" };
export const EMOTION_LABELS: Record<MarketEmotion, string> = { ice_point: "情绪冰点", weak: "情绪偏弱", neutral: "情绪平稳", strong: "情绪偏热", unknown: "情绪待确认" };

const ACTIONS: IntradayAction[] = ["add", "reduce", "wait"];
const EMOTIONS: MarketEmotion[] = ["ice_point", "weak", "neutral", "strong", "unknown"];

/**
 * 预案宽松解析：字段缺失或越界时丢弃该预案（返回 null），不再整轮丢弃模型输出。
 * 丢弃是保守的——没有合法预案就不会产生触发动作；区间上限只截断展示文案，不改判定。
 */
function plan(value: unknown): IntradayTradePlan | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const lower = Number(item.price_lower);
  const upper = Number(item.price_upper);
  const condition = typeof item.condition === "string" ? item.condition.trim().slice(0, 160) : "";
  const invalidation = typeof item.invalidation === "string" ? item.invalidation.trim().slice(0, 160) : "";
  if (!Number.isFinite(lower) || lower <= 0 || !Number.isFinite(upper) || upper < lower || !condition || !invalidation) return null;
  return {
    price_lower: lower,
    price_upper: upper,
    condition,
    invalidation,
    status: item.status === "triggered" ? "triggered" : "waiting",
  };
}

/**
 * 只有当天连续、有效的量价采样才允许输出已触发提醒。
 *
 * 宽松边界：单条结构错误、未知/重复代码、字段越界都不再让整轮失败（历史上一轮失败会导致
 * 5 分钟退避再丢 3 轮）；对应持仓降级为 wait，缺失持仓补 wait，未知代码忽略。
 */
export function normalizeIntradaySignals(raw: unknown, codes: Set<string>, prices: Map<string, number>, sentimentReady: boolean): IntradaySignal[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error("盘中价位模型未返回条目数组");
  const byCode = new Map<string, Record<string, unknown>>();
  for (const value of items) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    const code = String(item.code ?? "");
    if (!codes.has(code) || byCode.has(code)) continue;
    byCode.set(code, item);
  }
  return [...codes].map((code): IntradaySignal => {
    const price = prices.get(code);
    const item = byCode.get(code);
    if (!item) {
      return { code, action: "wait", add_plan: null, reduce_plan: null, emotion: "unknown",
        reason: "本轮模型未返回该标的，保持观察", data_usable: false };
    }
    const rawAction = ACTIONS.includes(String(item.action) as IntradayAction) ? item.action as IntradayAction : "wait";
    const rawEmotion = EMOTIONS.includes(String(item.emotion) as MarketEmotion) ? item.emotion as MarketEmotion : "unknown";
    const add = plan(item.add_plan);
    const reduce = plan(item.reduce_plan);
    if (add?.status === "triggered" && reduce?.status === "triggered") {
      add.status = "waiting";
      reduce.status = "waiting";
    }
    const usable = price !== undefined && (sentimentReady || rawEmotion !== "ice_point");
    for (const candidate of [add, reduce]) {
      if (candidate && (!usable || price! < candidate.price_lower || price! > candidate.price_upper)) candidate.status = "waiting";
    }
    const action: IntradayAction = !usable ? "wait"
      : rawAction === "add" && add?.status === "triggered" ? "add"
      : rawAction === "reduce" && reduce?.status === "triggered" ? "reduce" : "wait";
    const reason = price === undefined ? "当日量价采样不足或过期，等待有效承接证据"
      : !sentimentReady && rawEmotion === "ice_point" ? "情绪数据不足，冰点加仓条件待确认"
      : typeof item.reason === "string" && item.reason.trim() ? item.reason.trim().slice(0, 240) : "本轮未给出有效量价依据";
    return {
      code, action,
      add_plan: price === undefined ? null : add,
      reduce_plan: price === undefined ? null : reduce,
      emotion: sentimentReady ? rawEmotion : "unknown",
      reason,
      data_usable: price !== undefined,
    };
  });
}

export function tradePlanLabel(plan: IntradayTradePlan): string {
  return `${plan.price_lower.toFixed(2)}～${plan.price_upper.toFixed(2)}`;
}

/** 同方向价区间的轻微抖动不重复提醒；状态退出后再次触发可以重新提醒。 */
export function sameIntradaySignal(before: Pick<IntradaySignal, "action" | "add_plan" | "reduce_plan"> | undefined, next: IntradaySignal): boolean {
  if (!before || before.action !== next.action) return false;
  if (next.action === "wait") return true;
  const previous = before.action === "add" ? before.add_plan : before.reduce_plan;
  const current = next.action === "add" ? next.add_plan : next.reduce_plan;
  return Boolean(previous && current && ["price_lower", "price_upper"].every((key) => {
    const field = key as "price_lower" | "price_upper";
    return Math.abs(previous[field] - current[field]) <= Math.max(0.01, previous[field] * 0.003);
  }));
}
