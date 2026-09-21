export const STRATEGY_TYPES = ["position", "attention", "observation", "fallback_exit", "portfolio_overlay"] as const;
export type StrategyType = (typeof STRATEGY_TYPES)[number];

export const STRATEGY_STATUSES = ["active", "exit_only", "paused", "retired"] as const;
export type StrategyStatus = (typeof STRATEGY_STATUSES)[number];

export const EXIT_POLICY_MODES = ["none", "dedicated", "fallback_only", "dedicated_plus_fallback"] as const;
export type ExitPolicyMode = (typeof EXIT_POLICY_MODES)[number];

export const DAILY_PLAN_SCOPES = ["entry", "exit", "attention", "observe", "context"] as const;
export type DailyPlanScope = (typeof DAILY_PLAN_SCOPES)[number];

export const ATTENTION_POLICIES = ["none", "qualified_only", "qualified_and_approaching", "manual_review"] as const;
export type AttentionPolicy = (typeof ATTENTION_POLICIES)[number];

export const STRATEGY_EVALUATION_PHASES = ["entry", "exit", "context"] as const;
export type StrategyEvaluationPhase = (typeof STRATEGY_EVALUATION_PHASES)[number];

export const STRATEGY_EVALUATION_STATUSES = ["queued", "running", "success", "partial", "failed"] as const;
export type StrategyEvaluationStatus = (typeof STRATEGY_EVALUATION_STATUSES)[number];

export interface StrategyTaskLink {
  code: string;
  name: string;
  enabled: boolean;
  agent_role: string | null;
  purpose: string | null;
  phase: string | null;
  priority: number | null;
}

export interface StrategyRuntimeDefinition {
  code: string;
  name: string;
  strategy_type: StrategyType;
  strategy_document_code: string;
  strategy_document_title: string;
  strategy_document_sha256: string;
  status: StrategyStatus;
  allow_new_entry: boolean;
  entry_evaluator_code: string | null;
  exit_evaluator_code: string | null;
  context_evaluator_code: string | null;
  fallback_strategy_code: string | null;
  fallback_strategy_name: string | null;
  exit_policy_mode: ExitPolicyMode;
  daily_plan_scope: DailyPlanScope[];
  attention_policy: AttentionPolicy;
  runtime_version: number;
  created_at: string;
  updated_at: string;
  position_count: number;
  attention_count: number;
  latest_evaluation: StrategyEvaluationRunSummary | null;
  tasks: StrategyTaskLink[];
}

export interface StrategyEvaluationRunSummary {
  id: string;
  strategy_code: string;
  phase: StrategyEvaluationPhase;
  target_date: string;
  data_date: string | null;
  evaluator_code: string;
  evaluator_version: number;
  strategy_runtime_version: number;
  strategy_snapshot_hash: string;
  input_fingerprint: string;
  status: StrategyEvaluationStatus;
  requested_by_job_run_id: string | null;
  requested_by_job_code?: string | null;
  reused_from_run_id: string | null;
  coverage: Record<string, unknown>;
  gaps: unknown[];
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  result: unknown | null;
  attempt_count: number;
  last_requested_at: string;
}

export interface StrategyPositionEvaluation {
  code: string;
  name: string;
  strategy_code: string;
  evaluation_role: "primary" | "fallback";
  action: "hold" | "observe" | "reduce" | "exit";
  trigger_kind: string;
  trigger_price_lower: number | null;
  trigger_price_upper: number | null;
  protection_price: number | null;
  reason: string;
  evidence: Record<string, unknown>;
  missing_items: unknown[];
}
