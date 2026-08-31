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
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface JobRunRow {
  id: string;
  job_id: string;
  /** 一期历史关联，只读兼容；新 Runner 永远保持 null。 */
  task_run_id: string | null;
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
  legacy_content_document_id: string | null;
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
  | "daily_market_structure";

export interface DatasourceJobConfig {
  pipeline: DatasourcePipeline;
  export_volume: boolean;
}

export interface AnalysisJobConfig {
  analysis_type: "sector_temperature" | "key_levels" | "long_valuation";
  request?: { codes?: string[]; as_of?: string; lookback?: number };
}

export interface AgentFlowJobConfig {
  pool_attention_write?: true;
  daily_plan_write?: true;
}

export type ValidatedJobConfig = DatasourceJobConfig | AnalysisJobConfig | AgentFlowJobConfig;
