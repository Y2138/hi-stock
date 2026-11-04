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
}

export const ACTION_LABELS: Record<IntradayAction, string> = { add: "加仓触发", reduce: "减仓触发", wait: "等待" };
export const EMOTION_LABELS: Record<MarketEmotion, string> = { ice_point: "情绪冰点", weak: "情绪偏弱", neutral: "情绪平稳", strong: "情绪偏热", unknown: "情绪待确认" };

function plan(value: unknown): IntradayTradePlan | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("盘中价位预案格式无效");
  const item = value as Record<string, unknown>;
  if (typeof item.price_lower !== "number" || !Number.isFinite(item.price_lower) || item.price_lower <= 0
    || typeof item.price_upper !== "number" || !Number.isFinite(item.price_upper) || item.price_upper < item.price_lower
    || typeof item.condition !== "string" || !item.condition.trim() || item.condition.length > 160
    || typeof item.invalidation !== "string" || !item.invalidation.trim() || item.invalidation.length > 160
    || !["waiting", "triggered"].includes(String(item.status))) throw new Error("盘中价位预案区间或条件无效");
  return { price_lower: item.price_lower, price_upper: item.price_upper, condition: item.condition.trim(), invalidation: item.invalidation.trim(), status: item.status as IntradayTradePlan["status"] };
}

/** 只有当天连续、有效的量价采样才允许输出已触发提醒。 */
export function normalizeIntradaySignals(raw: unknown, codes: Set<string>, prices: Map<string, number>, sentimentReady: boolean): IntradaySignal[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length !== codes.size) throw new Error("盘中价位模型未完整覆盖持仓");
  const seen = new Set<string>();
  return items.map((raw): IntradaySignal => {
    if (!raw || typeof raw !== "object") throw new Error("盘中价位模型条目无效");
    const item = raw as Record<string, unknown>;
    const code = String(item.code ?? "");
    if (!codes.has(code) || seen.has(code)) throw new Error("盘中价位模型返回未知或重复持仓");
    seen.add(code);
    if (!["add", "reduce", "wait"].includes(String(item.action)) || typeof item.reason !== "string" || !item.reason.trim()
      || !["ice_point", "weak", "neutral", "strong", "unknown"].includes(String(item.emotion))) throw new Error("盘中价位模型动作或依据无效");
    const add = plan(item.add_plan);
    const reduce = plan(item.reduce_plan);
    if (add?.status === "triggered" && reduce?.status === "triggered") throw new Error("盘中价位模型同时触发相反动作");
    const price = prices.get(code);
    const usable = price !== undefined && (sentimentReady || item.emotion !== "ice_point");
    for (const candidate of [add, reduce]) if (candidate && (!usable || price! < candidate.price_lower || price! > candidate.price_upper)) candidate.status = "waiting";
    const action = item.action as IntradayAction;
    if ((action !== "add" && add?.status === "triggered") || (action !== "reduce" && reduce?.status === "triggered")) throw new Error("盘中价位模型动作与预案不一致");
    return { code, action: action === "add" && add?.status === "triggered" ? "add" : action === "reduce" && reduce?.status === "triggered" ? "reduce" : "wait",
      add_plan: price === undefined ? null : add, reduce_plan: price === undefined ? null : reduce, emotion: sentimentReady ? item.emotion as MarketEmotion : "unknown",
      reason: price === undefined ? "当日量价采样不足或过期，等待有效承接证据" : !sentimentReady && item.emotion === "ice_point" ? "情绪数据不足，冰点加仓条件待确认" : item.reason.trim().slice(0, 240) };
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
