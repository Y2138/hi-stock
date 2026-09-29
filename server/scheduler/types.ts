import type pg from "pg";

export type Db = Pick<pg.Pool, "query">;
export type JobType = "datasource" | "agent_flow" | "analysis";
export type JobStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "partial"
  | "missed"
  | "cancelled";
export type JobTriggerKind = "cron" | "manual";

export interface JobDefinitionRow {
  id: string;
  code: string;
  name: string;
  cron: string;
  job_type: JobType;
  config: Record<string, unknown>;
  prompt_id: string | null;
  /** Agent 任务固定模型；空值表示创建运行会话时跟随系统当前模型。 */
  model_id: string | null;
  /** 任务职责与产出：说明读取哪些事实、做出什么判断、留下什么结果。 */
  purpose: string | null;
  /** 调度时段特征：盘前/盘中/盘后/夜间/周末；用于任务分组，不参与调度计算。 */
  phase: JobPhase | null;
  /** 重要性排序权重：数值越小越靠前。 */
  priority: number | null;
  /** 单策略任务关联的运行时策略；组合聚合和数据任务为空。 */
  strategy_code: string | null;
  /** 任务在策略运行时中的受控角色。 */
  agent_role: string | null;
  /** 仅交易日执行：目标日非交易所日历开市日时 cron/missed 触发不入队；周维护任务为 false。 */
  trading_day_only: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export const JOB_PHASES = ["盘前", "盘中", "盘后", "夜间", "周末"] as const;
export type JobPhase = (typeof JOB_PHASES)[number];

export interface JobRunRow {
  id: string;
  job_id: string;
  prompt_revision_id: string | null;
  session_id: string | null;
  strategy_change_seq: string | null;
  strategy_snapshot_hash: string | null;
  target_date: string;
  trigger_kind: JobTriggerKind;
  scheduled_for: string | null;
  status: JobStatus;
  attempt_count: number;
  next_retry_at: string | null;
  log: string;
  artifacts: unknown[];
  data_gaps: unknown[];
  result_md: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface JobRunOutputRow {
  id: string;
  job_id: string;
  run_id: string | null;
  session_id: string | null;
  output_type: string;
  target_date: string;
  markdown: string;
  sha256: string;
  status: "generated" | "approved" | "rejected" | "superseded";
  source: "agent_flow" | "historical_import" | "user_edit";
  supersedes_output_id: string | null;
  strategy_change_seq: string | null;
  strategy_snapshot_hash: string | null;
  created_at: string;
}

export interface JobDefinitionWithLatest extends JobDefinitionRow {
  latest_run: Partial<JobRunRow> | null;
  next_run: string | null;
}

export type DatasourcePipeline =
  | "daily_market_update"
  | "market_catalog_sync"
  | "board_membership_sync"
  | "daily_market_structure"
  | "full_market_indicator_refresh"
  | "commodity_copper_sync"
  | "commodity_copper_inventory_sync"
  | "commodity_copper_macro_sync"
  | "value_candidate_sync";

export interface DatasourceJobConfig {
  pipeline: DatasourcePipeline;
  export_volume: boolean;
}

export interface AnalysisJobConfig {
  analysis_type: "sector_temperature" | "key_levels" | "long_valuation" | "value_monthly_rank";
  request?: { codes?: string[]; as_of?: string; lookback?: number; force?: boolean };
}

export type AgentFlowJobConfig = Record<string, never>;

export type ValidatedJobConfig = DatasourceJobConfig | AnalysisJobConfig | AgentFlowJobConfig;
