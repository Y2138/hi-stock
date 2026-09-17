// 铜库存防守仓位一版：固定公式只读计算，Agent只负责解释，不参与数值推导。
import type pg from "pg";

export const COPPER_INVENTORY_RULE_VERSION = "铜库存防守仓位一版";
export const COPPER_INVENTORY_SERIES_CODE = "shfe.cu.inventory.total";
export const COPPER_INVENTORY_BASE_EXPOSURE = 0.5;
export const COPPER_INVENTORY_OVERLAY_EXPOSURE = 0.5;
export const COPPER_INVENTORY_REBALANCE_BAND = 0.2;
export const COPPER_INVENTORY_LOOKBACK_OBSERVATIONS = 4;
export const COPPER_INVENTORY_START = "2016-09-12";

interface InventoryRow { reportDate: string; publishedDate: string; publishedAt: string; value: number }
interface ProfileRow { code: string; name: string; role: string; effectiveFrom: string; effectiveTo: string | null; publishedDate: string }
export type CopperInventoryAction = "initial_entry" | "increase" | "decrease" | "universe_change" | "hold";

export interface CopperInventoryDecision {
  report_date: string;
  published_at: string;
  execution_date: string | null;
  inventory_tonnes: number;
  comparison_inventory_tonnes: number;
  inventory_4w_change: number;
  inventory_inverse_percentile: number;
  raw_target_exposure: number;
  applied_target_exposure: number;
  action: CopperInventoryAction;
  action_executed: boolean;
  eligible_codes: string[];
}

export interface CopperInventorySignal {
  status: "ready" | "insufficient";
  as_of: string;
  rule_version: string;
  formula: {
    inventory_change: string;
    inventory_score: string;
    target_exposure: string;
    rebalance: string;
    allocation: string;
  };
  latest_observation: CopperInventoryDecision | null;
  latest_executed_rebalance: CopperInventoryDecision | null;
  pending_rebalance: CopperInventoryDecision | null;
  current_target: {
    stock_exposure: number;
    cash_exposure: number;
    per_stock_exposure: number | null;
    codes: Array<{ code: string; name: string; role: string }>;
  };
  data_summary: {
    inventory_observation_count: number;
    inventory_start: string | null;
    inventory_end: string | null;
    profile_count: number;
  };
  gaps: string[];
}

export function inventoryInversePercentile(value: number, history: number[]): number {
  if (!history.length) return 0.5;
  let less = 0;
  let equal = 0;
  for (const item of history) {
    if (item < value) less += 1;
    else if (item === value) equal += 1;
  }
  return Math.max(0, Math.min(1, 1 - (less + equal / 2) / history.length));
}

export function copperInventoryTargetExposure(score: number): number {
  return COPPER_INVENTORY_BASE_EXPOSURE + COPPER_INVENTORY_OVERLAY_EXPOSURE * Math.max(0, Math.min(1, score));
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function nextDate(dates: string[], date: string): string | null {
  let left = 0; let right = dates.length;
  while (left < right) { const mid = (left + right) >> 1; if (dates[mid]! <= date) left = mid + 1; else right = mid; }
  return dates[left] ?? null;
}

function previousDate(dates: string[], date: string): string | null {
  let left = 0; let right = dates.length;
  while (left < right) { const mid = (left + right) >> 1; if (dates[mid]! < date) left = mid + 1; else right = mid; }
  return left > 0 ? dates[left - 1]! : null;
}

function actionOf(rawTarget: number, applied: number, codesChanged: boolean): CopperInventoryAction {
  if (applied < 0) return "initial_entry";
  if (codesChanged) return "universe_change";
  if (rawTarget - applied >= COPPER_INVENTORY_REBALANCE_BAND) return "increase";
  if (applied - rawTarget >= COPPER_INVENTORY_REBALANCE_BAND) return "decrease";
  return "hold";
}

export async function queryCopperInventorySignal(db: pg.Pool, asOf: string): Promise<CopperInventorySignal> {
  if (!validDate(asOf)) throw new Error("asOf 必须为有效YYYY-MM-DD日期");
  const [inventoryResult, profileResult, calendarResult] = await Promise.all([
    db.query<InventoryRow>(
      `SELECT observation.period_end::text AS "reportDate",
              (observation.published_at AT TIME ZONE 'Asia/Shanghai')::date::text AS "publishedDate",
              observation.published_at::text AS "publishedAt", observation.value::float8
         FROM market_factor_observation observation
         JOIN market_factor_series series ON series.id=observation.series_id
        WHERE series.series_code=$1
          AND observation.published_at < ($2::date + interval '1 day')
        ORDER BY observation.published_at,observation.period_end`, [COPPER_INVENTORY_SERIES_CODE, asOf]),
    db.query<ProfileRow>(
      `SELECT instrument.code,instrument.name,profile.role,
              profile.effective_from::text AS "effectiveFrom",profile.effective_to::text AS "effectiveTo",
              (profile.published_at AT TIME ZONE 'Asia/Shanghai')::date::text AS "publishedDate"
         FROM company_commodity_profile profile
         JOIN market_instrument instrument ON instrument.id=profile.instrument_id
        WHERE profile.commodity_code='CU' AND profile.role IN ('upstream_producer','integrated')
        ORDER BY instrument.code,profile.published_at`),
    db.query<{ date: string }>(
      "SELECT trade_date::text AS date FROM market_trading_day WHERE is_open=true AND trade_date >= $1 ORDER BY trade_date",
      [COPPER_INVENTORY_START]),
  ]);
  const inventory = inventoryResult.rows;
  const profiles = profileResult.rows;
  const dates = calendarResult.rows.map(row => row.date);
  const gaps: string[] = [];
  if (inventory.length < COPPER_INVENTORY_LOOKBACK_OBSERVATIONS + 1) gaps.push("SHFE铜库存不足5个观测");
  if (!profiles.length) gaps.push("没有上游或矿冶一体化公司角色");
  if (!dates.length) gaps.push("没有可用A股交易日历");
  const decisions: CopperInventoryDecision[] = [];
  const changes: number[] = [];
  let applied = -1;
  let appliedCodes = "";
  for (let index = COPPER_INVENTORY_LOOKBACK_OBSERVATIONS; index < inventory.length; index += 1) {
    const current = inventory[index]!;
    const comparison = inventory[index - COPPER_INVENTORY_LOOKBACK_OBSERVATIONS]!;
    if (comparison.value <= 0) continue;
    const change = current.value / comparison.value - 1;
    const score = inventoryInversePercentile(change, changes);
    changes.push(change);
    if (current.publishedDate < COPPER_INVENTORY_START) continue;
    const executionDate = nextDate(dates, current.publishedDate);
    const signalDate = executionDate ? previousDate(dates, executionDate) ?? asOf : asOf;
    const eligible = profiles.filter(profile => profile.publishedDate <= signalDate && profile.effectiveFrom <= signalDate
      && (profile.effectiveTo === null || profile.effectiveTo > signalDate));
    if (!eligible.length) continue;
    const codeKey = eligible.map(profile => profile.code).sort().join(",");
    const rawTarget = copperInventoryTargetExposure(score);
    const action = actionOf(rawTarget, applied, appliedCodes !== "" && appliedCodes !== codeKey);
    const actionExecuted = action !== "hold" && executionDate !== null && executionDate <= asOf;
    if (actionExecuted) {
      applied = rawTarget;
      appliedCodes = codeKey;
    }
    decisions.push({
      report_date: current.reportDate,
      published_at: current.publishedAt,
      execution_date: executionDate,
      inventory_tonnes: current.value,
      comparison_inventory_tonnes: comparison.value,
      inventory_4w_change: change,
      inventory_inverse_percentile: score,
      raw_target_exposure: rawTarget,
      applied_target_exposure: applied < 0 ? 0 : applied,
      action,
      action_executed: actionExecuted,
      eligible_codes: eligible.map(profile => profile.code).sort(),
    });
  }
  const latest = decisions.at(-1) ?? null;
  const latestExecuted = [...decisions].reverse().find(decision => decision.action_executed) ?? null;
  const pending = [...decisions].reverse().find(decision => decision.action !== "hold" && !decision.action_executed) ?? null;
  const currentCodes = latestExecuted?.eligible_codes ?? latest?.eligible_codes ?? [];
  const profileByCode = new Map(profiles.map(profile => [profile.code, profile]));
  const currentExposure = latestExecuted?.applied_target_exposure ?? 0;
  if (!latest) gaps.push("目标日之前没有可计算库存信号");
  return {
    status: gaps.length ? "insufficient" : "ready",
    as_of: asOf,
    rule_version: COPPER_INVENTORY_RULE_VERSION,
    formula: {
      inventory_change: "本周库存/四个观测前库存-1",
      inventory_score: "1-当前4周变化在此前已发布历史变化中的经验百分位",
      target_exposure: "50%+50%×库存逆百分位",
      rebalance: "目标股票仓位与上次已执行目标相差至少20个百分点",
      allocation: "在有效上游及矿冶一体化公司之间等权；Agent不得改公式或自行调参",
    },
    latest_observation: latest,
    latest_executed_rebalance: latestExecuted,
    pending_rebalance: pending,
    current_target: {
      stock_exposure: currentExposure,
      cash_exposure: 1 - currentExposure,
      per_stock_exposure: currentCodes.length ? currentExposure / currentCodes.length : null,
      codes: currentCodes.map(code => ({ code, name: profileByCode.get(code)?.name ?? code, role: profileByCode.get(code)?.role ?? "unknown" })),
    },
    data_summary: {
      inventory_observation_count: inventory.length,
      inventory_start: inventory[0]?.reportDate ?? null,
      inventory_end: inventory.at(-1)?.reportDate ?? null,
      profile_count: profiles.length,
    },
    gaps,
  };
}
