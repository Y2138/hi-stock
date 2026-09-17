import type pg from "pg";
import { queryLimitUpSignals } from "../market/limit-up-signals.js";
import { queryCopperInventorySignal } from "../market/copper-inventory-signal.js";
import { queryLithiumWarehouseSignal } from "../market/lithium-warehouse-signal.js";
import { querySwingSignals } from "../plans/swing-signals.js";
import { queryTwoYearReversalSignals } from "../plans/two-year-reversal-signal.js";
import { queryValueAnchorSignals } from "../plans/value-anchor-signal.js";
import type { StrategyEvaluationPhase } from "./types.js";

export interface StrategyEvaluatorContext {
  pool: pg.Pool;
  targetDate: string;
  strategyDocumentId?: string | null;
}

export interface StrategyEvaluatorDefinition<T = unknown> {
  code: string;
  phase: StrategyEvaluationPhase;
  version: number;
  status: "ready" | "pending";
  execute?: (context: StrategyEvaluatorContext) => Promise<T>;
}

const ready = <T>(
  code: string,
  phase: StrategyEvaluationPhase,
  execute: (context: StrategyEvaluatorContext) => Promise<T>,
): StrategyEvaluatorDefinition<T> => ({ code, phase, version: 1, status: "ready", execute });

const pending = (code: string, phase: StrategyEvaluationPhase): StrategyEvaluatorDefinition => ({
  code,
  phase,
  version: 1,
  status: "pending",
});

/**
 * 策略评估器唯一代码白名单。数据库只能引用这里登记的稳定编码，不能保存模块路径或脚本。
 * 出场评估器在阶段五完成专属与兜底拆分前先登记为 pending，现有每日计划继续走兼容链路。
 */
const DEFINITIONS: readonly StrategyEvaluatorDefinition[] = [
  ready("swing_entry_v1", "entry", ({ pool, targetDate }) => querySwingSignals(pool, targetDate)),
  ready("two_year_reversal_entry_v1", "entry", ({ pool, targetDate }) => queryTwoYearReversalSignals(pool, targetDate)),
  ready("limit_up_observation_v1", "entry", ({ pool, targetDate, strategyDocumentId }) =>
    queryLimitUpSignals(pool, targetDate, strategyDocumentId)),
  ready("value_anchor_entry_v1", "entry", ({ pool, targetDate }) => queryValueAnchorSignals(pool, targetDate)),
  ready("copper_inventory_context_v1", "context", ({ pool, targetDate }) => queryCopperInventorySignal(pool, targetDate)),
  ready("lithium_warehouse_context_v1", "context", ({ pool, targetDate }) => queryLithiumWarehouseSignal(pool, targetDate)),
  pending("nightly_sector_attention_v1", "entry"),
  pending("manual_entry_v1", "entry"),
  pending("swing_exit_v1", "exit"),
  pending("two_year_reversal_exit_v1", "exit"),
  pending("legacy_right_side_exit_v1", "exit"),
  pending("legacy_left_reversal_exit_v1", "exit"),
  pending("fallback_exit_v1", "exit"),
];

const REGISTRY = new Map(DEFINITIONS.map((definition) => [definition.code, definition]));

export function listStrategyEvaluatorDefinitions(): StrategyEvaluatorDefinition[] {
  return [...DEFINITIONS];
}

export function getStrategyEvaluatorDefinition(code: string): StrategyEvaluatorDefinition {
  const definition = REGISTRY.get(code);
  if (!definition) throw new Error(`未注册策略评估器：${code}`);
  return definition;
}

export async function executeStrategyEvaluator<T = unknown>(
  code: string,
  context: StrategyEvaluatorContext,
): Promise<T> {
  const definition = getStrategyEvaluatorDefinition(code);
  if (definition.status !== "ready" || !definition.execute) {
    throw new Error(`策略评估器尚未接入统一执行链路：${code}`);
  }
  return definition.execute(context) as Promise<T>;
}

export interface StrategyEvaluatorBindingGap {
  strategy_code: string;
  field: "entry_evaluator_code" | "exit_evaluator_code" | "context_evaluator_code";
  evaluator_code: string;
  reason: "unregistered" | "phase_mismatch";
}

/** 校验数据库固定资产只引用代码白名单，pending 允许迁移期间存在但阶段必须匹配。 */
export async function findStrategyEvaluatorBindingGaps(
  db: Pick<pg.Pool | pg.PoolClient, "query">,
): Promise<StrategyEvaluatorBindingGap[]> {
  const result = await db.query<{
    code: string;
    entry_evaluator_code: string | null;
    exit_evaluator_code: string | null;
    context_evaluator_code: string | null;
  }>(`SELECT code, entry_evaluator_code, exit_evaluator_code, context_evaluator_code
        FROM strategy_definition ORDER BY code`);
  const gaps: StrategyEvaluatorBindingGap[] = [];
  const fields = [
    ["entry_evaluator_code", "entry"],
    ["exit_evaluator_code", "exit"],
    ["context_evaluator_code", "context"],
  ] as const;
  for (const row of result.rows) {
    for (const [field, phase] of fields) {
      const evaluatorCode = row[field];
      if (!evaluatorCode) continue;
      const definition = REGISTRY.get(evaluatorCode);
      if (!definition) {
        gaps.push({ strategy_code: row.code, field, evaluator_code: evaluatorCode, reason: "unregistered" });
      } else if (definition.phase !== phase) {
        gaps.push({ strategy_code: row.code, field, evaluator_code: evaluatorCode, reason: "phase_mismatch" });
      }
    }
  }
  return gaps;
}
