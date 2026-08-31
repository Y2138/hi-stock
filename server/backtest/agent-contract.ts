export const AGENT_BACKTEST_WORKER_VERSION = "agent-backtest-worker-v3";
export const AGENT_BACKTEST_SDK_VERSION = "stock-backtest-sdk-v2";
export const AGENT_BACKTEST_IMAGE = "node:22-alpine";
export const AGENT_BACKTEST_SOURCE_LIMIT = 64 * 1024;
export const AGENT_BACKTEST_INPUT_LIMIT = 128 * 1024 * 1024;
export const AGENT_BACKTEST_RESULT_LIMIT = 256 * 1024;
export const AGENT_BACKTEST_MEMORY_LIMIT = "1g";
export const AGENT_BACKTEST_TIMEOUT_MS = 60_000;
export const AGENT_BACKTEST_MAX_ROWS = 500_000;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface AgentBacktestRequest {
  name: string;
  kind: "formal" | "research";
  research_outline: string;
  hypothesis: string;
  codes: string[];
  market_event_types?: Array<"up" | "down" | "break">;
  limit_up_universe?: "none" | "mainboard" | "all";
  start: string;
  end: string;
  initial_cash: number;
  parameters: Record<string, JsonValue>;
  comparison_run_ids: string[];
  base_source_run_id: string | null;
  source_code: string;
}

export interface AgentBacktestBar {
  code: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface AgentBacktestMarketEvent {
  date: string;
  type: "up" | "down" | "break";
  code: string;
  event_price: number | null;
  streak_count: number | null;
  open_count: number | null;
  first_event_time: string | null;
  last_event_time: string | null;
  industry_name: string | null;
  reason: string | null;
}

export interface AgentBacktestWorkerInput {
  sdk_version: string;
  meta: {
    codes: string[];
    start: string;
    end: string;
    initial_cash: number;
    parameters: Record<string, JsonValue>;
  };
  bars: AgentBacktestBar[];
  market_events: AgentBacktestMarketEvent[];
}

export interface AgentBacktestWorkerResult {
  metrics: Record<string, number | null>;
  conclusion: string;
  data_gaps: Array<Record<string, JsonValue>>;
  observations: number;
}

export interface AgentBacktestRunSummary {
  id: string;
  name: string;
  kind: string;
  execution_status: string;
  strategy_change_seq: string | null;
  strategy_snapshot_hash: string | null;
  research_outline: string | null;
  hypothesis: string | null;
  comparison_run_ids: string[];
  input_summary: Record<string, unknown>;
  metrics_json: Record<string, unknown> | null;
  conclusion_md: string | null;
  data_gaps: unknown[];
  worker_version: string | null;
  sdk_version: string | null;
  source_sha256: string | null;
  source_size_bytes: number | null;
  base_source_run_id: string | null;
  source_retention_status: "none" | "candidate" | "versioned";
  code_cleanup_status: string;
  error_message: string | null;
}
