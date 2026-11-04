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
    const pk = signal.pk && typeof signal.pk === "object" ? signal.pk as Record<string, unknown> : {};
    const pct = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "待核实";
    const stage = pk.stage === "first_board" ? "首板" : pk.stage === "confirmation" ? "二三板确认" : pk.stage === "high_board" ? "高位续板" : "阶段待核实";
    return {
      item_kind: "off_pool_opportunity",
      code: String(signal.code),
      grade,
      priority: index + 1,
      action: "observe",
      trigger_kind: "condition",
      headline: `${String(signal.name ?? signal.code)}｜${String(signal.signal_grade ?? grade)} 打板观察`,
      evidence_md: `题材 ${String(signal.main_theme ?? "未提供")}；抱团数据顺位 ${String(signal.cluster_rank ?? "—")}；主升数据顺位 ${String(signal.momentum_rank ?? "—")}；`
        + `${stage}同高度PK（前向验证）；封单/成交额 ${pct(pk.seal_turnover_ratio)}；封单保持率 ${pct(pk.seal_retention)}；`
        + `成交量/昨量 ${typeof pk.volume_ratio_prev === "number" ? `${pk.volume_ratio_prev.toFixed(2)}倍` : "待核实"}；`
        + `${pk.one_word === true ? "一字排队成交不确定" : "仍需竞价与消息复核"}；旧分仅作背景，不代表胜率`,
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
