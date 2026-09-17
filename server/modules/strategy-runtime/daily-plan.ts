import type pg from "pg";
import { queryDailyPlanContext } from "../plans/daily-context.js";
import { listPositions } from "../positions/repo.js";
import { mergeExitEvaluations } from "./exit-evaluators.js";
import { reconcileStrategyAttention, type StrategyAttentionChange } from "./attention.js";
import { ensureStrategyEvaluation, type EnsureStrategyEvaluationResult } from "./service.js";
import type { StrategyPositionEvaluation, StrategyRuntimeDefinition } from "./types.js";
import { listStrategyRuntimeDefinitions } from "./repo.js";

interface EvaluationRecord {
  strategy: StrategyRuntimeDefinition;
  phase: "entry" | "exit" | "context";
  ensured: EnsureStrategyEvaluationResult;
}

function resultRecord(result: unknown): Record<string, unknown> {
  return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
}

function positionItems(evaluation: EvaluationRecord | undefined): StrategyPositionEvaluation[] {
  const items = resultRecord(evaluation?.ensured.result).items;
  return Array.isArray(items) ? items as StrategyPositionEvaluation[] : [];
}

function evaluationGap(evaluation: EvaluationRecord): Record<string, unknown> | null {
  if (evaluation.ensured.execution === "waiting") return {
    strategy_code: evaluation.strategy.code, phase: evaluation.phase, reason: "评估运行中，等待完成",
  };
  if (["partial", "failed"].includes(evaluation.ensured.run.status)) return {
    strategy_code: evaluation.strategy.code, phase: evaluation.phase,
    reason: `评估状态 ${evaluation.ensured.run.status}`, gaps: evaluation.ensured.run.gaps,
  };
  return null;
}

function observationItems(evaluation: EvaluationRecord | undefined) {
  const signals = resultRecord(evaluation?.ensured.result).signals;
  if (!Array.isArray(signals)) return [];
  return signals.slice(0, 4).map((raw, index) => {
    const item = resultRecord(raw);
    const grade = item.signal_grade === "A" ? "A" : "B";
    return {
      item_kind: "off_pool_opportunity" as const,
      code: String(item.code),
      grade,
      priority: index + 1,
      action: "observe" as const,
      trigger_kind: "condition" as const,
      headline: `${String(item.name ?? item.code)}｜${String(item.signal_grade ?? grade)} 打板观察`,
      evidence_md: `抱团分 ${String(item.cluster_score ?? "—")}；主升分 ${String(item.momentum_score ?? "—")}；抱团名次 ${String(item.cluster_rank ?? "—")}；主升名次 ${String(item.momentum_rank ?? "—")}`,
      strategy_code: evaluation!.strategy.code,
      strategy_runtime_version: evaluation!.strategy.runtime_version,
      primary_evaluation_run_id: evaluation!.ensured.run.id,
      effective_action: "observe" as const,
      evaluation_status: evaluation!.ensured.run.status,
      evaluation_data_date: evaluation!.ensured.run.data_date,
      evaluation_missing: evaluation!.ensured.run.gaps,
    };
  });
}

export async function queryDailyPlanStrategyContext(
  pool: pg.Pool,
  input: { date: string; requested_by_job_run_id?: string | null },
) {
  const [definitions, positions, legacyContext] = await Promise.all([
    listStrategyRuntimeDefinitions(pool),
    listPositions(pool),
    queryDailyPlanContext(pool, input.date),
  ]);
  const byCode = new Map(definitions.map((definition) => [definition.code, definition]));
  const requests = new Map<string, { strategy: StrategyRuntimeDefinition; phase: "entry" | "exit" | "context" }>();
  const add = (strategy: StrategyRuntimeDefinition, phase: "entry" | "exit" | "context") =>
    requests.set(`${strategy.code}:${phase}`, { strategy, phase });

  for (const strategy of definitions) {
    if (strategy.status === "active" && strategy.allow_new_entry && strategy.daily_plan_scope.includes("entry")) add(strategy, "entry");
    if (strategy.status === "active" && strategy.daily_plan_scope.includes("observe")) add(strategy, "entry");
    if (strategy.status === "active" && strategy.daily_plan_scope.includes("context")) add(strategy, "context");
  }
  const gaps: Record<string, unknown>[] = [];
  for (const position of positions) {
    if (!position.strategy_code) {
      gaps.push({ code: position.code, scope: "position", reason: "当前持仓尚未归因运行时策略" });
      continue;
    }
    const strategy = byCode.get(position.strategy_code);
    if (!strategy) {
      gaps.push({ code: position.code, scope: "position", reason: `持仓策略不存在：${position.strategy_code}` });
      continue;
    }
    if (strategy.exit_evaluator_code) add(strategy, "exit");
    if (position.fallback_strategy_code) {
      const fallback = byCode.get(position.fallback_strategy_code);
      if (fallback?.exit_evaluator_code) add(fallback, "exit");
      else gaps.push({ code: position.code, scope: "fallback", reason: `兜底策略不可用：${position.fallback_strategy_code}` });
    }
  }

  const evaluations = await Promise.all([...requests.values()].map(async ({ strategy, phase }): Promise<EvaluationRecord> => ({
    strategy,
    phase,
    ensured: await ensureStrategyEvaluation(pool, {
      strategy_code: strategy.code,
      phase,
      target_date: input.date,
      requested_by_job_run_id: input.requested_by_job_run_id ?? null,
    }),
  })));
  const evaluationByKey = new Map(evaluations.map((evaluation) => [`${evaluation.strategy.code}:${evaluation.phase}`, evaluation]));
  for (const evaluation of evaluations) {
    const gap = evaluationGap(evaluation);
    if (gap) gaps.push(gap);
  }

  const attentionChanges: StrategyAttentionChange[] = [];
  for (const evaluation of evaluations.filter((item) => item.phase === "entry" && item.strategy.attention_policy !== "none")) {
    if (evaluation.ensured.execution !== "waiting") {
      attentionChanges.push(...await reconcileStrategyAttention(pool, {
        run: evaluation.ensured.run,
        source_job: "daily_plan_flow",
      }));
    }
  }

  const positionEvaluations = positions.map((position) => {
    if (!position.strategy_code) return {
      code: position.code, name: position.name, strategy_code: null, strategy_name: null,
      exit_policy_mode: null, primary: null, fallback: null,
      effective_action: "observe" as const, effective_source: "none" as const,
      effective_reason: "持仓待归因，无法选择出场策略",
      primary_evaluation_run_id: null, fallback_evaluation_run_id: null,
      evaluation_status: "partial" as const, data_date: legacyContext.market.data_date,
      missing_items: ["持仓待归因"], strategy_runtime_version: null,
    };
    const strategy = byCode.get(position.strategy_code)!;
    const primaryRun = strategy.exit_evaluator_code ? evaluationByKey.get(`${strategy.code}:exit`) : undefined;
    const fallbackRun = position.fallback_strategy_code
      ? evaluationByKey.get(`${position.fallback_strategy_code}:exit`) : undefined;
    const primary = positionItems(primaryRun).find((item) => item.code === position.code) ?? null;
    const fallback = positionItems(fallbackRun).find((item) => item.code === position.code) ?? null;
    const merged = mergeExitEvaluations(position.strategy_code, position.exit_policy_mode ?? strategy.exit_policy_mode, primary, fallback);
    const missingItems = [
      ...(primary?.missing_items ?? []), ...(fallback?.missing_items ?? []),
      ...(primaryRun?.ensured.run.gaps ?? []), ...(fallbackRun?.ensured.run.gaps ?? []),
    ];
    const evaluationStatus = primaryRun?.ensured.execution === "waiting" || fallbackRun?.ensured.execution === "waiting"
      ? "waiting" as const
      : primaryRun?.ensured.run.status === "partial" || fallbackRun?.ensured.run.status === "partial" || missingItems.length
        ? "partial" as const : "success" as const;
    return {
      ...merged,
      strategy_name: strategy.name,
      strategy_runtime_version: position.strategy_runtime_version ?? strategy.runtime_version,
      primary_evaluation_run_id: primaryRun?.ensured.run.id ?? null,
      fallback_evaluation_run_id: fallbackRun?.ensured.run.id ?? null,
      evaluation_status: evaluationStatus,
      data_date: primaryRun?.ensured.run.data_date ?? fallbackRun?.ensured.run.data_date ?? legacyContext.market.data_date,
      missing_items: missingItems,
    };
  });

  const observation = evaluationByKey.get("limit_up:entry");
  const playbookItems = [
    ...positionEvaluations.map((item) => {
      const effective = item.effective_source === "primary" ? item.primary : item.effective_source === "fallback" ? item.fallback : null;
      return {
        item_kind: "position_action" as const,
        code: item.code,
        action: item.effective_action,
        trigger_kind: (effective?.trigger_kind === "open" || effective?.trigger_kind === "price_range")
          ? effective.trigger_kind : "condition" as const,
        ...(effective?.trigger_price_lower !== null && effective?.trigger_price_lower !== undefined
          ? { price_lower: effective.trigger_price_lower } : {}),
        ...(effective?.trigger_price_upper !== null && effective?.trigger_price_upper !== undefined
          ? { price_upper: effective.trigger_price_upper } : {}),
        headline: `${item.strategy_name ?? "待归因"}｜${item.effective_reason}`,
        evidence_md: `主策略：${item.primary?.reason ?? "无"}；兜底：${item.fallback?.reason ?? "无"}`,
        ...(item.missing_items.length ? { missing_md: item.missing_items.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("；") } : {}),
        ...(item.strategy_code ? { strategy_code: item.strategy_code } : {}),
        ...(item.strategy_runtime_version ? { strategy_runtime_version: item.strategy_runtime_version } : {}),
        primary_evaluation_run_id: item.primary_evaluation_run_id,
        fallback_evaluation_run_id: item.fallback_evaluation_run_id,
        primary_action: item.primary?.action ?? null,
        fallback_action: item.fallback?.action ?? null,
        effective_action: item.effective_action,
        evaluation_status: item.evaluation_status,
        evaluation_data_date: item.data_date,
        evaluation_missing: item.missing_items.map((value) => typeof value === "string" ? value : JSON.stringify(value)),
      };
    }),
    ...observationItems(observation),
  ];

  const requiredDocuments = new Set<string>(["daily_plan_strategy"]);
  const portfolioDocuments = await pool.query<{ code: string }>(
    "SELECT code FROM strategy_document WHERE role='portfolio' ORDER BY injection_order,id",
  );
  for (const document of portfolioDocuments.rows) requiredDocuments.add(document.code);
  for (const evaluation of evaluations) requiredDocuments.add(evaluation.strategy.strategy_document_code);
  const waitingCount = evaluations.filter((item) => item.ensured.execution === "waiting").length;
  const status = gaps.length || legacyContext.status !== "success" || waitingCount ? "partial" as const : "success" as const;
  return {
    requested_date: input.date,
    status,
    strategy_snapshot_hash: evaluations[0]?.ensured.run.strategy_snapshot_hash ?? null,
    market: legacyContext.market,
    market_structure_sync: legacyContext.market_structure_sync,
    risk_gate: legacyContext.risk_gate,
    trial_evaluation: legacyContext.trial_evaluation,
    strategy_coverage: {
      expected_evaluations: requests.size,
      completed_evaluations: evaluations.filter((item) => item.ensured.execution !== "waiting").length,
      waiting_evaluations: waitingCount,
      executed_evaluations: evaluations.filter((item) => item.ensured.execution === "executed").length,
      reused_evaluations: evaluations.filter((item) => item.ensured.execution === "reused").length,
      position_count: positions.length,
      attributed_position_count: positions.filter((position) => position.strategy_code !== null).length,
      primary_position_count: positionEvaluations.filter((item) => item.primary !== null).length,
      fallback_position_count: positionEvaluations.filter((item) => item.fallback !== null).length,
      attention_change_count: attentionChanges.length,
    },
    required_strategy_documents: [...requiredDocuments],
    evaluations: evaluations.map((item) => ({
      strategy_code: item.strategy.code, strategy_name: item.strategy.name, phase: item.phase,
      execution: item.ensured.execution, run: item.ensured.run, result: item.ensured.result,
    })),
    position_evaluations: positionEvaluations,
    attention_changes: attentionChanges,
    playbook_items: playbookItems,
    gaps: [...legacyContext.gaps, ...gaps],
  };
}
