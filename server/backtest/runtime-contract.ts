import { Type, validateToolArguments, type Static, type TSchema } from "@earendil-works/pi-ai";
import { StandardBacktestPlanSchema, canonicalJson, type StandardBacktestPlan, type StandardExecutionStatus, type BacktestGap } from "./contracts.js";
const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const id = Type.String({ pattern: "^[1-9][0-9]{0,18}$" });
export const PreflightBacktestSchema = object({ plan: StandardBacktestPlanSchema });
export const StartStandardBacktestSchema = object({
  plan: StandardBacktestPlanSchema,
  plan_hash: hash,
  input_hash: hash,
  idempotency_key: Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" }),
  comparison_run_ids: Type.Optional(Type.Array(id, { maxItems: 10 })),
});
export const GetBacktestStatusSchema = object({ run_id: id });
export const CancelBacktestSchema = object({ run_id: id, reason: Type.String({ minLength: 1, maxLength: 300 }) });
export type StartStandardBacktestInput = Static<typeof StartStandardBacktestSchema>;
export function validateRuntimeInput<T>(name: string, schema: TSchema, input: unknown): T {
  if (Buffer.byteLength(canonicalJson(input)) > 40 * 1024) throw new Error("标准回测请求超过预算");
  try {
    return validateToolArguments({name, description: "标准回测严格入口", parameters: schema},
      { type: "toolCall", id: "standard", name, arguments: structuredClone(input) as Record<string, unknown> }) as T;
  } catch { throw new Error("标准回测请求不符合严格契约"); }
}
export interface StandardComparison {
  run_id: string;
  comparable: boolean;
  reasons: string[];
  parameter_differences: string[];
}
export interface StandardRunStatus {
  id: string;
  name: string;
  engine_type: "standard_daily";
  execution_status: StandardExecutionStatus;
  phase: string;
  progress: number;
  quality_status: string;
  evidence_status: "research_only";
  replay_status: string;
  plan_sha256: string;
  input_sha256: string | null;
  execution_plan: StandardBacktestPlan;
  metrics_json: Record<string, number | null> | null;
  data_gaps: BacktestGap[];
  error_message: string | null;
  session_id: string;
  started_at: string | null;
  finished_at: string | null;
  cancel_requested_at: string | null;
  comparisons: StandardComparison[];
  enabled: boolean;
}
export interface StandardPage<T> { items: T[]; next_cursor: string | null }
