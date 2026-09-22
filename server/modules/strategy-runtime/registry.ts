import type pg from "pg";
import { queryLimitUpSignals } from "../market/limit-up-signals.js";
import { queryIntradayLimitLadder } from "../market/first-board-advance.js";
import { queryCopperLeftLaunchEntry, queryCopperLeftLaunchExit } from "../market/copper-left-launch-signal.js";
import { querySwingSignals } from "../plans/swing-signals.js";
import { queryTwoYearReversalSignals } from "../plans/two-year-reversal-signal.js";
import { queryValueAnchorSignals } from "../plans/value-anchor-signal.js";
import { evaluateStrategyExit } from "./exit-evaluators.js";
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
  version = 1,
): StrategyEvaluatorDefinition<T> => ({ code, phase, version, status: "ready", execute });

const pending = (code: string, phase: StrategyEvaluationPhase): StrategyEvaluatorDefinition => ({
  code,
  phase,
  version: 1,
  status: "pending",
});

/**
 * 策略评估器唯一代码白名单。数据库只能引用这里登记的稳定编码，不能保存模块路径或脚本。
 * 入场、出场和组合评估均通过稳定编码复用领域服务；尚未接入的能力显式标记 pending。
 */
const DEFINITIONS: readonly StrategyEvaluatorDefinition[] = [
  ready("swing_entry_v1", "entry", ({ pool, targetDate }) => querySwingSignals(pool, targetDate)),
  ready("two_year_reversal_entry_v1", "entry", ({ pool, targetDate }) => queryTwoYearReversalSignals(pool, targetDate)),
  ready("limit_up_observation_v1", "entry", ({ pool, targetDate, strategyDocumentId }) =>
    queryLimitUpSignals(pool, targetDate, strategyDocumentId), 2),
  ready("first_board_advance_entry_v1", "entry", ({ pool, targetDate }) => queryIntradayLimitLadder(pool, targetDate), 2),
  ready("value_anchor_entry_v1", "entry", ({ pool, targetDate }) => queryValueAnchorSignals(pool, targetDate), 2),
  ready("copper_left_launch_entry_v1", "entry", ({ pool, targetDate }) => queryCopperLeftLaunchEntry(pool, targetDate)),
  ready("copper_left_launch_exit_v1", "exit", ({ pool, targetDate }) => queryCopperLeftLaunchExit(pool, targetDate)),
  pending("nightly_sector_attention_v1", "entry"),
  pending("manual_entry_v1", "entry"),
  ready("swing_exit_v1", "exit", ({ pool, targetDate }) => evaluateStrategyExit({ pool, targetDate, strategyCode: "swing" })),
  ready("two_year_reversal_exit_v1", "exit", ({ pool, targetDate }) => evaluateStrategyExit({ pool, targetDate, strategyCode: "two_year_reversal" })),
  ready("legacy_right_side_exit_v1", "exit", ({ pool, targetDate }) => evaluateStrategyExit({ pool, targetDate, strategyCode: "legacy_right_side" })),
  ready("legacy_left_reversal_exit_v1", "exit", ({ pool, targetDate }) => evaluateStrategyExit({ pool, targetDate, strategyCode: "legacy_left_reversal" })),
  ready("fallback_exit_v1", "exit", ({ pool, targetDate }) => evaluateStrategyExit({ pool, targetDate, strategyCode: "portfolio_fallback_exit" })),
];

const REGISTRY = new Map(DEFINITIONS.map((definition) => [definition.code, definition]));

export function listStrategyEvaluatorDefinitions(): StrategyEvaluatorDefinition[] {
  return [...DEFINITIONS];
}

/** 只读展示信息；业务执行仍只认稳定编码与注册表状态。 */
const EVALUATOR_LABELS: Record<string, string> = {
  swing_entry_v1: "波段入场", two_year_reversal_entry_v1: "两年结构反转入场",
  limit_up_observation_v1: "涨停接力观察", first_board_advance_entry_v1: "涨停梯队盘中先手", value_anchor_entry_v1: "价值错杀关注",
  copper_left_launch_entry_v1: "铜左侧启动入场",
  copper_left_launch_exit_v1: "铜价格结构出场",
  nightly_sector_attention_v1: "夜间板块关注", manual_entry_v1: "自主决策入场",
  swing_exit_v1: "波段出场", two_year_reversal_exit_v1: "两年结构反转出场",
  legacy_right_side_exit_v1: "旧右侧持仓出场", legacy_left_reversal_exit_v1: "旧左侧持仓出场",
  fallback_exit_v1: "分批止盈与移动止损兜底",
};

export function strategyEvaluatorMetadata(code: string | null): { code: string; label: string; phase: StrategyEvaluationPhase | null; status: "ready" | "pending" | "unregistered"; version: number | null } | null {
  if (!code) return null;
  const definition = REGISTRY.get(code);
  return { code, label: EVALUATOR_LABELS[code] ?? code, phase: definition?.phase ?? null, status: definition?.status ?? "unregistered", version: definition?.version ?? null };
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
        FROM strategy_definition WHERE status <> 'retired' ORDER BY code`);
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
