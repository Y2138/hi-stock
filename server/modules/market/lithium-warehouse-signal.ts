// 碳酸锂仓单防守仓位一版：固定公式只读计算，Agent只解释，不参与数值推导。
import type pg from "pg";

export const LITHIUM_WAREHOUSE_RULE_VERSION = "碳酸锂仓单防守仓位一版";
export const LITHIUM_WAREHOUSE_SERIES_CODE = "gfex.lc.warehouse_receipt.total";
export const LITHIUM_REBALANCE_BAND = 0.1;
export const LITHIUM_START = "2024-01-02";
export const LITHIUM_CODES = ["002192.SZ", "002240.SZ", "002460.SZ", "002466.SZ", "603399.SH"] as const;

interface InventoryRow { reportDate: string; publishedDate: string; publishedAt: string; value: number }
interface ProfileRow { code: string; name: string; role: string; effectiveFrom: string; effectiveTo: string | null; publishedDate: string }
export type LithiumWarehouseAction = "initial_entry" | "increase" | "decrease" | "universe_change" | "hold";
export interface LithiumWarehouseDecision {
  report_date: string; published_at: string; execution_date: string | null; warehouse_receipt: number;
  comparison_warehouse_receipt: number; warehouse_4w_change: number; warehouse_inverse_percentile: number;
  raw_target_exposure: number; applied_target_exposure: number; action: LithiumWarehouseAction;
  action_executed: boolean; eligible_codes: string[];
}
export interface LithiumWarehouseSignal {
  status: "ready" | "insufficient"; as_of: string; rule_version: string;
  formula: { warehouse_change: string; warehouse_score: string; target_exposure: string; rebalance: string; allocation: string };
  latest_observation: LithiumWarehouseDecision | null;
  latest_executed_rebalance: LithiumWarehouseDecision | null;
  pending_rebalance: LithiumWarehouseDecision | null;
  current_target: { stock_exposure: number; cash_exposure: number; per_stock_exposure: number | null; codes: Array<{ code: string; name: string; role: string }> };
  data_summary: { warehouse_observation_count: number; warehouse_start: string | null; warehouse_end: string | null; profile_count: number };
  gaps: string[];
}

function inversePercentile(value: number, history: number[]): number {
  if (!history.length) return 0.5;
  let less = 0; let equal = 0;
  for (const item of history) { if (item < value) less += 1; else if (item === value) equal += 1; }
  return Math.max(0, Math.min(1, 1 - (less + equal / 2) / history.length));
}
function targetExposure(score: number): number { return 0.5 + 0.5 * Math.max(0, Math.min(1, score)); }
function nextDate(dates: string[], date: string): string | null {
  let left = 0; let right = dates.length; while (left < right) { const mid = (left + right) >> 1; if (dates[mid]! <= date) left = mid + 1; else right = mid; } return dates[left] ?? null;
}
function previousDate(dates: string[], date: string): string | null {
  let left = 0; let right = dates.length; while (left < right) { const mid = (left + right) >> 1; if (dates[mid]! < date) left = mid + 1; else right = mid; } return left > 0 ? dates[left - 1]! : null;
}
function actionOf(raw: number, applied: number, changed: boolean): LithiumWarehouseAction {
  if (applied < 0) return "initial_entry"; if (changed) return "universe_change";
  if (raw - applied >= LITHIUM_REBALANCE_BAND) return "increase";
  if (applied - raw >= LITHIUM_REBALANCE_BAND) return "decrease";
  return "hold";
}

export async function queryLithiumWarehouseSignal(db: pg.Pool, asOf: string): Promise<LithiumWarehouseSignal> {
  const [inventoryResult, profileResult, calendarResult] = await Promise.all([
    db.query<InventoryRow>(`SELECT o.period_end::text AS "reportDate",(o.published_at AT TIME ZONE 'Asia/Shanghai')::date::text AS "publishedDate",o.published_at::text AS "publishedAt",o.value::float8 FROM market_factor_observation o JOIN market_factor_series s ON s.id=o.series_id WHERE s.series_code=$1 AND o.published_at<($2::date+interval '1 day') ORDER BY o.published_at,o.period_end`, [LITHIUM_WAREHOUSE_SERIES_CODE, asOf]),
    db.query<ProfileRow>(`SELECT i.code,i.name,p.role,p.effective_from::text AS "effectiveFrom",p.effective_to::text AS "effectiveTo",(p.published_at AT TIME ZONE 'Asia/Shanghai')::date::text AS "publishedDate" FROM company_commodity_profile p JOIN market_instrument i ON i.id=p.instrument_id WHERE p.commodity_code='LITHIUM_CARBONATE' AND i.code=ANY($1::text[]) ORDER BY i.code,p.published_at`, [LITHIUM_CODES]),
    db.query<{ date: string }>("SELECT trade_date::text date FROM market_trading_day WHERE is_open=true AND trade_date >= $1 ORDER BY trade_date", [LITHIUM_START]),
  ]);
  const inventory = inventoryResult.rows, profiles = profileResult.rows, dates = calendarResult.rows.map(row => row.date), gaps: string[] = [];
  if (inventory.length < 5) gaps.push("碳酸锂仓单不足5个观测"); if (profiles.length < 5) gaps.push("五只碳酸锂核心标的角色数据不完整"); if (!dates.length) gaps.push("没有可用A股交易日历");
  const decisions: LithiumWarehouseDecision[] = []; const changes: number[] = []; let applied = -1; let appliedCodes = "";
  for (let index = 4; index < inventory.length; index += 1) {
    const current = inventory[index]!, prior = inventory[index - 4]!; if (prior.value <= 0) continue;
    const change = current.value / prior.value - 1, score = inversePercentile(change, changes); changes.push(change);
    if (current.publishedDate < LITHIUM_START) continue;
    const executionDate = nextDate(dates, current.publishedDate); if (!executionDate) continue;
    const signalDate = previousDate(dates, executionDate) ?? asOf;
    const eligible = profiles.filter(p => p.publishedDate <= signalDate && p.effectiveFrom <= signalDate && (!p.effectiveTo || p.effectiveTo > signalDate));
    if (!eligible.length) continue;
    const codes = eligible.map(p => p.code).sort(), codeKey = codes.join(","), raw = targetExposure(score);
    const action = actionOf(raw, applied, appliedCodes !== "" && codeKey !== appliedCodes), actionExecuted = action !== "hold" && executionDate <= asOf;
    if (actionExecuted) { applied = raw; appliedCodes = codeKey; }
    decisions.push({ report_date: current.reportDate, published_at: current.publishedAt, execution_date: executionDate, warehouse_receipt: current.value, comparison_warehouse_receipt: prior.value, warehouse_4w_change: change, warehouse_inverse_percentile: score, raw_target_exposure: raw, applied_target_exposure: applied < 0 ? 0 : applied, action, action_executed: actionExecuted, eligible_codes: codes });
  }
  const latest = decisions.at(-1) ?? null, latestExecuted = [...decisions].reverse().find(row => row.action_executed) ?? null, pending = [...decisions].reverse().find(row => row.action !== "hold" && !row.action_executed) ?? null;
  const codes = latestExecuted?.eligible_codes ?? latest?.eligible_codes ?? [], byCode = new Map(profiles.map(p => [p.code, p])), exposure = latestExecuted?.applied_target_exposure ?? 0;
  if (!latest) gaps.push("目标日前没有可计算碳酸锂仓单信号");
  return { status: gaps.length ? "insufficient" : "ready", as_of: asOf, rule_version: LITHIUM_WAREHOUSE_RULE_VERSION,
    formula: { warehouse_change: "本周仓单量/四个观测前仓单量-1", warehouse_score: "1-当前4周变化在此前已发布历史变化中的经验百分位", target_exposure: "50%+50%×仓单逆百分位", rebalance: "目标股票仓位与上次已执行目标相差至少10个百分点", allocation: "五只有效锂资源公司之间等权；Agent不得改公式或自行调参" },
    latest_observation: latest, latest_executed_rebalance: latestExecuted, pending_rebalance: pending,
    current_target: { stock_exposure: exposure, cash_exposure: 1 - exposure, per_stock_exposure: codes.length ? exposure / codes.length : null, codes: codes.map(code => ({ code, name: byCode.get(code)?.name ?? code, role: byCode.get(code)?.role ?? "unknown" })) },
    data_summary: { warehouse_observation_count: inventory.length, warehouse_start: inventory[0]?.reportDate ?? null, warehouse_end: inventory.at(-1)?.reportDate ?? null, profile_count: profiles.length }, gaps };
}
