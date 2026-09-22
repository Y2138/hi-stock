import type { PlaybookItemInput } from "../plans/repo.js";
import type { EnsureStrategyEvaluationResult } from "./service.js";
import type { StrategyRuntimeDefinition } from "./types.js";

/** 仅独立收盘打板任务可调用：结构化候选来源为本轮确定性评估。 */
export function limitUpOpportunityItems(evaluation: {
  strategy: StrategyRuntimeDefinition;
  ensured: EnsureStrategyEvaluationResult;
}): PlaybookItemInput[] {
  const result = evaluation.ensured.result;
  const signals = result && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>).signals : null;
  if (!Array.isArray(signals)) return [];
  return signals.slice(0, 4).map((raw, index) => {
    const signal = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const grade: "A" | "B" = signal.signal_grade === "A" ? "A" : "B";
    return {
      item_kind: "off_pool_opportunity",
      code: String(signal.code),
      grade,
      priority: index + 1,
      action: "observe",
      trigger_kind: "condition",
      headline: `${String(signal.name ?? signal.code)}｜${String(signal.signal_grade ?? grade)} 打板观察`,
      evidence_md: `题材 ${String(signal.main_theme ?? "未提供")}；抱团分 ${String(signal.cluster_score ?? "—")}；主升分 ${String(signal.momentum_score ?? "—")}；抱团名次 ${String(signal.cluster_rank ?? "—")}；主升名次 ${String(signal.momentum_rank ?? "—")}`,
      ...(Array.isArray(signal.missing_inputs) && signal.missing_inputs.length ? { missing_md: signal.missing_inputs.join("；") } : {}),
      ...(Array.isArray(signal.risk_flags) && signal.risk_flags.length ? { risk_md: signal.risk_flags.join("；") } : {}),
      strategy_code: evaluation.strategy.code,
      strategy_runtime_version: evaluation.strategy.runtime_version,
      primary_evaluation_run_id: evaluation.ensured.run.id,
      effective_action: "observe",
      evaluation_status: "success",
      evaluation_data_date: evaluation.ensured.run.data_date,
      evaluation_missing: evaluation.ensured.run.gaps.map((value) => typeof value === "string" ? value : JSON.stringify(value)),
    };
  });
}
