// 与服务端 API 同构的响应类型（字段形状见 server/modules/*/repo.ts）
// 服务端直接返回 data 负载（无外层信封），client.ts 已按此约定解包。

// ---- 当前策略、简要演进与真人发布门禁 ----

export interface StrategyState {
  change_seq: string;
  current_hash: string;
  last_evolution_id: string | null;
  updated_at: string;
}

export interface StrategyDocument {
  id: string;
  code: string;
  title: string;
  role: "portfolio" | "short" | "long" | "guidance";
  injection_order: number;
  current_revision_id: string;
  current_revision_no: number;
  current_sha256: string;
  current_content: string;
  updated_at: string;
}

export interface CurrentStrategy {
  state: StrategyState;
  documents: StrategyDocument[];
}

export interface StrategyEvolution {
  id: string;
  session_id: string | null;
  outline: string;
  conclusion: string;
  adjustments: string[];
  adoption_status: "pending" | "adopted" | "rejected";
  strategy_hash_before: string;
  strategy_hash_after: string | null;
  backtest_run_ids: string[];
  created_at: string;
  decided_at: string | null;
}

export interface StrategyProposalChange {
  document_id: string;
  base_revision_id: string;
  content: string;
}

export interface StrategyProposal {
  id: string;
  session_id: string;
  evolution_id: string;
  base_change_seq: string;
  base_strategy_hash: string;
  summary: string;
  proposed_changes: StrategyProposalChange[] | null;
  status: "pending" | "approved" | "rejected" | "expired" | "conflict";
  requires_human: true;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
  outline?: string;
  conclusion?: string;
  adjustments?: string[];
}

// ---- Agent 自驱回测（历史一期记录只读兼容） ----

export interface BacktestRun {
  id: string;
  name: string;
  kind: string;
  engine_path: string | null;
  engine_git_commit: string | null;
  config_snapshot: unknown;
  input_manifest: unknown[];
  output_dir: string | null;
  report_path: string | null;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  metrics: unknown;
  request_json: Record<string, unknown> | null;
  input_summary: Record<string, unknown>;
  service_version: string | null;
  metrics_json: Record<string, unknown> | null;
  conclusion_md: string | null;
  data_gaps: unknown[];
  execution_status: "legacy" | "queued" | "running" | "success" | "partial" | "failed";
  progress: number;
  error_message: string | null;
  execution_origin: "legacy" | "service" | "agent_workspace";
  session_id: string | null;
  strategy_change_seq: string | null;
  strategy_snapshot_hash: string | null;
  research_outline: string | null;
  hypothesis: string | null;
  worker_version: string | null;
  sdk_version: string | null;
  source_sha256: string | null;
  source_size_bytes: number | null;
  code_cleanup_status: "not_applicable" | "deleted" | "cleanup_failed";
  conclusion_status: "working" | "final" | "superseded";
  conclusion_summary: string | null;
  applicability_boundary: string | null;
  finalized_at: string | null;
  superseded_by_run_id: string | null;
  comparison_run_ids: string[];
  notes: string | null;
  created_at: string;
}

export interface BacktestListItem extends BacktestRun {
  is_active_anchor: boolean;
}

export interface BacktestArtifact {
  role: string;
  artifact_id: string;
  dataset_id: string;
  dataset_key: string;
  source_path: string;
  source_sha256: string;
  source_type: string;
}

export interface BacktestDetail extends BacktestListItem {
  artifacts: BacktestArtifact[];
  comparisons: Array<{
    id: string;
    name: string;
    kind: string;
    execution_status: string;
    strategy_change_seq: string | null;
    strategy_snapshot_hash: string | null;
    research_outline: string | null;
    hypothesis: string | null;
    metrics_json: Record<string, unknown> | null;
    conclusion_md: string | null;
    created_at: string;
  }>;
}

// ---- 二期 M3：系统调度作业 ----

export type JobType = "datasource" | "analysis" | "agent_flow";
export type JobStatus = "queued" | "running" | "success" | "failed" | "partial" | "missed" | "cancelled";

export interface JobRunSummary {
  id: string;
  session_id: string | null;
  strategy_change_seq: string | null;
  strategy_snapshot_hash: string | null;
  target_date: string;
  trigger_kind: "cron" | "manual";
  status: JobStatus;
  attempt_count: number;
  scheduled_for: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobDefinition {
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
  latest_run: JobRunSummary | null;
  next_run: string | null;
}

export interface JobRun extends JobRunSummary {
  job_id: string;
  task_run_id: string | null;
  prompt_revision_id: string | null;
  next_retry_at: string | null;
  log: string;
  artifacts: unknown[];
  data_gaps: unknown[];
  result_md: string | null;
  created_at: string;
}

export interface JobRunOutput {
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

export interface JobPrompt {
  id: string;
  code: string;
  name: string;
  status: "active" | "archived";
  current_revision_id: string;
  current_revision_no: number;
  current_sha256: string;
  current_content?: string;
  created_at: string;
  updated_at: string;
}

export interface JobPromptRevision {
  id: string;
  prompt_id: string;
  revision_no: number;
  content: string;
  sha256: string;
  source: "legacy_import" | "user" | "agent" | "rollback";
  base_revision_id: string | null;
  change_summary: string | null;
  created_at: string;
}

export interface JobRunDetail extends JobRun {
  job: Omit<JobDefinition, "latest_run" | "next_run">;
  outputs: JobRunOutput[];
}

// ---- 行情与标的（server/modules/market） ----

export interface Instrument {
  id?: string;
  code: string;
  name: string;
  kind: "stock" | "etf" | "index" | "board" | "fund" | "futures";
  sector_code: string | null;
  ticker?: string | null;
  exchange?: string | null;
  source_asset_type?: string | null;
  lifecycle_status?: string;
  capabilities?: Record<string, boolean>;
  persisted?: boolean;
}

export const INSTRUMENT_KIND_LABELS: Record<string, string> = {
  stock: "股票",
  etf: "ETF",
  index: "指数",
  board: "板块",
  fund: "基金",
  futures: "期货",
};

export interface MarketBar {
  bar_date: string;
  bar_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  dif: number | null;
  dea: number | null;
  macd_hist: number | null;
  adjustment: string | null;
  channel: string;
}

export interface BarsResponse {
  instrument: Instrument;
  bars: MarketBar[];
  data_source: "stored" | "remote_on_demand";
  indicators: {
    requested: string[];
    source: "indicator_v2" | "legacy_ma" | "remote_on_demand";
    available: boolean;
    calculation_version: string | null;
    status: "success" | "partial" | "failed" | "untrusted" | "stale" | "pending";
    adjustment: string | null;
    gaps: unknown[];
  };
}

export type MarketFreq = "day" | "30m" | "futures_day";

export const FREQ_LABELS: Record<MarketFreq, string> = {
  day: "日线",
  "30m": "30分钟",
  futures_day: "期货日线",
};

export interface MarketCoverage {
  freq: MarketFreq;
  instrument_count: number;
  stock_count: number;
  board_count: number;
  etf_count: number;
  index_count: number;
  first_date: string | null;
  last_date: string | null;
  row_count: number;
}

export type BoardType = "industry" | "concept" | "region" | "special";

export interface MarketBoard {
  code: string;
  name: string;
  board_type: BoardType;
  source_updated_at: string | null;
  last: number | null;
  quote_time: string | null;
  constituent_count: number;
  pool_intersection: number;
}

export interface MarketStructureResponse {
  date: string;
  dataset: MarketStructureDataset;
  status: "success" | "partial" | "failed" | "missing";
  coverage: {
    completed_pages: number;
    total_pages: number | null;
    row_count: number;
    source_time: string | null;
    finished_at: string | null;
  };
  gaps: unknown[];
  page: number;
  size: number;
  items: Array<Record<string, unknown>>;
  counts?: Partial<Record<MarketStructureDataset, number>>;
}

export type MarketStructureDataset =
  | "limit_up"
  | "limit_down"
  | "limit_break"
  | "limit_ladder"
  | "dragon_tiger_all"
  | "dragon_tiger_org"
  | "dragon_tiger_hot_money";

// ---- 持仓与账户（server/modules/positions） ----

export interface Position {
  instrument_id: string;
  code: string;
  name: string;
  kind: string;
  quantity: number;
  cost_price: number;
  cost_basis: string | null;
  opened_at: string | null;
  updated_at: string;
  close: number | null;
  close_date: string | null;
  market_value: number | null;
  pnl_amount: number | null;
  pnl_ratio: number | null;
  attribution_breakdown: Record<string, number>;
}

export interface PositionChange {
  id: string;
  instrument_id: string;
  code: string;
  name: string;
  change_date: string;
  kind: "buy" | "sell" | "adjust" | "note";
  quantity: number | null;
  price: number | null;
  amount: number | null;
  reason: string | null;
  source: string;
  decision_origin: "strategy_signal" | "planned_discretionary" | "unplanned_exception" | "fact_correction" | "unknown";
  execution_compliance: "matched" | "deviated" | "not_applicable" | "unknown";
  strategy_change_seq: string | null;
  strategy_snapshot_hash: string | null;
  plan_output_id: string | null;
  plan_output_type: string | null;
  plan_target_date: string | null;
  source_session_id: string | null;
  attribution_note: string | null;
  deviation_reason: string | null;
  created_at: string;
}

export const CHANGE_KIND_LABELS: Record<string, string> = {
  buy: "买入",
  sell: "卖出",
  adjust: "调整",
  note: "备注",
};

export const DECISION_ORIGIN_LABELS: Record<string, string> = {
  strategy_signal: "策略信号", planned_discretionary: "计划内主观",
  unplanned_exception: "计划外例外", fact_correction: "事实校正", unknown: "未知",
};
export const EXECUTION_COMPLIANCE_LABELS: Record<string, string> = {
  matched: "符合", deviated: "偏离", not_applicable: "不适用", unknown: "未知",
};

export interface AccountSnapshot {
  snap_date: string;
  total_asset: number | null;
  market_value: number | null;
  cash: number | null;
  closed_pnl: number | null;
  raw_text: string | null;
  precision: "exact" | "approx";
  source: string;
}

/** 实时资金摘要（/api/account/summary）：台账现金 + 持仓×最新收盘派生 */
export interface AccountSummary {
  tracked: boolean;
  anchor_date: string | null;
  cash: number | null;
  closed_pnl: number | null;
  market_value: number;
  total_asset: number | null;
  missing_quote: number;
}

// ---- 标的池（server/modules/pools） ----

export interface PoolMember {
  id: string;
  pool: "short" | "long";
  role: string;
  grade: string | null;
  score: number | null;
  tags: string[];
  stock_character: string | null;
  stage: string | null;
  evaluation_summary: string | null;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  attention_reason: string | null;
  attention_from: string | null;
  attention_until: string | null;
  code: string;
  name: string;
  kind: string;
  last: number | null;
  prev_close: number | null;
  change_pct: number | null;
  quote_time: string | null;
  price_source: "close" | null;
  boards: Array<{ code: string; name: string; board_type: string; level: "primary" | "secondary" }>;
}

export interface PoolBoard {
  code: string;
  name: string;
  board_type: string;
  source_updated_at: string | null;
  sort: number | null;
  member_count: number;
  last: number | null;
  prev_close: number | null;
  change_pct: number | null;
  quote_time: string | null;
  level: "primary";
}

export interface PoolViewData {
  pool: "short" | "long";
  members: PoolMember[];
  boards: PoolBoard[];
  attention_count: number;
  unclassified_count: number;
}

// ---- Agent 可复用记忆 ----
export interface AgentMemory {
  id: string;
  title: string;
  category: "research_method" | "evaluation_template" | "data_source_knowledge" | "task_playbook" | "incident_resolution" | "user_preference";
  summary: string;
  content: string;
  tags: string[];
  scope: string;
  source_session_id: string;
  source_run_type: "job" | "backtest" | "analysis" | "tool" | null;
  source_run_id: string | null;
  evidence: string;
  status: "active" | "review_required" | "superseded" | "deprecated";
  supersedes_id: string | null;
  last_verified_at: string;
  created_at: string;
  updated_at: string;
}

// ---- 数据卷（server/volume/routes） ----

export interface FreqCoverage {
  count: number;
  min: string | null;
  max: string | null;
}

export interface VolumeSnapshot {
  id: string;
  path: string;
  created_at: string;
  kind: "scheduled" | "manual";
  manifest: {
    exported_at: string;
    database: string;
    table_count: number;
    market_bar_coverage: Record<string, FreqCoverage>;
  };
}

export interface VolumeExportResult {
  path: string;
  manifest_path: string;
  tool: { mode: "local" | "docker"; version: string };
  pruned: number;
  exported_at: string;
}

export interface VolumeRestoreResult {
  path: string;
  target: string;
  tool: { mode: "local" | "docker"; version: string };
  data_only: boolean;
  diffs: string[];
  verified: boolean;
}

export interface PortablePackage {
  path: string;
  size_bytes: number;
  exported_at: string;
  migration_max: number;
  table_count: number;
  strategy_revision_count: number;
  prompt_revision_count: number;
  job_definition_count: number;
  payload_sha256: string;
}

export interface PortableExportResult {
  path: string;
  manifest_path: string;
  exported_at: string;
  migration_max: number;
  strategy_revision_count: number;
  prompt_revision_count: number;
  job_definition_count: number;
}

// ---- AI 对话（server/agent，设计 §6.3/§6.4） ----

/** GET /api/llm/status：未配置时 configured=false 并附 code/message */
export interface LlmStatus {
  configured: boolean;
  provider: string | null;
  provider_name: string | null;
  model: string | null;
  vision: boolean;
  yolo_mode: boolean;
  code?: string;
  message?: string;
}

export interface AgentSettings {
  yolo_mode: boolean;
  market_domain_tools_enabled: boolean;
  web_research_enabled: boolean;
  updated_at: string;
}

export interface SystemSettings {
  hithink_api_key_configured: boolean;
  updated_at: string;
}

export interface AgentMetricSummary {
  range: { from: string | null; to: string | null; model_id: string | null };
  runs: { total: number; status: Record<string, number>; average_tool_calls: number };
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    reasoning: number;
  };
  cost_amount: number;
  latency_ms: {
    first_text_average: number | null;
    first_text_p95: number | null;
    total_average: number | null;
    total_p95: number | null;
  };
  tools: { total: number; average_duration_ms: number | null; status: Record<string, number> };
}

export type LlmApiProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

export interface LlmModelConfig {
  id: string;
  provider_id: string;
  model_key: string;
  name: string;
  input_modalities: ("text" | "image")[];
  reasoning: boolean;
  context_window: number;
  max_tokens: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface LlmProviderConfig {
  id: string;
  provider_key: string;
  name: string;
  api_protocol: LlmApiProtocol;
  base_url: string;
  api_key_configured: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  models: LlmModelConfig[];
}

export interface LlmConfigCatalog {
  providers: LlmProviderConfig[];
  active_model_id: string | null;
  protocols: LlmApiProtocol[];
}

export interface ChatSession {
  id: string;
  title: string;
  archived: boolean;
  /** 本会话固定模型；模型被删除后为 null，发送时回退全局当前模型。 */
  model_id: string | null;
  session_type: "interactive" | "job" | "backtest" | "strategy_evolution";
  session_status: "idle" | "queued" | "running" | "waiting_confirmation" | "success" | "partial" | "failed" | "cancelled";
  source: "user" | "cron" | "manual_job" | "agent";
  parent_session_id: string | null;
  context_summary: string | null;
  context_summary_through_seq: number;
  context_summary_estimated_tokens: number;
  context_compacted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** chat_message 行；content 即 pi AgentMessage 纯 JSON（user/assistant/toolResult） */
export interface ChatMessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: "user" | "assistant" | "tool";
  content: unknown;
  created_at: string;
}

export type UiRefreshTarget =
  | "dashboard"
  | "positions"
  | "jobs"
  | "pools"
  | "market"
  | "strategies"
  | "backtests"
  | "memories"
  | "datasync"
  | "status";

export interface UiRefreshRequest {
  targets: UiRefreshTarget[];
  reason: string;
  requested_at: string;
  cursor?: string;
}

export interface ChatAttachment {
  id: string;
  session_id: string;
  path: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

export type ConfirmationStatus = "pending" | "approved" | "rejected" | "expired";

export interface Confirmation {
  id: string;
  session_id: string | null;
  tool_name: string;
  payload: unknown;
  status: ConfirmationStatus;
  decided_at: string | null;
  result: unknown;
  created_at: string;
}

/** POST /api/chat/:sessionId/messages SSE 帧（设计 §6.4） */
export type ChatSseFrame =
  | { type: "run_started"; data: { run_id: string } }
  | { type: "assistant_start"; data: { timestamp?: number } }
  | { type: "context_compacted"; data: { through_seq: number; estimated_tokens: number } }
  | { type: "text"; data: { delta: string } }
  | { type: "tool_start"; data: { toolCallId: string; name: string; args: Record<string, unknown> } }
  | { type: "tool_update"; data: { toolCallId: string; name: string; result: unknown } }
  | {
      type: "tool_end";
      data: { toolCallId: string; name: string; result: unknown; isError: boolean };
    }
  | {
      type: "confirmation_pending";
      data: { confirmation_id: string; tool_name: string; payload: unknown };
    }
  | { type: "done"; data: { message: unknown } }
  | { type: "aborted"; data: { run_id: string; message: string } }
  | { type: "error"; data: { code: string; message: string } };

export interface AgentControlResult {
  accepted: true;
  action: "abort" | "steer" | "follow_up";
  run_id: string;
  timing: "now" | "next_step" | "next_turn";
}

/** GET /api/chat/:sessionId/events 长连帧（确认结果推送通道） */
export interface ConfirmationResultEvent {
  confirmation_id: string;
  tool_name: string;
  status: "approved" | "rejected";
  result?: unknown;
}

/** 工具名中文标签（与 server/agent/tools.ts 的 label 对齐） */
export const TOOL_LABELS: Record<string, string> = {
  database_schema: "发现数据库结构",
  database_query: "查询数据库",
  instrument_search: "检索标的目录",
  market_snapshot_query: "查询最新行情快照",
  board_query: "查询板块与成分",
  market_event_query: "查询市场结构",
  indicator_query: "查询可信行情指标",
  portfolio_write: "维护持仓",
  pool_write: "维护标的池",
  finalize_backtest: "确认回测结论",
  memory_query: "查询 Agent 记忆",
  memory_write: "维护 Agent 记忆",
  job_write: "维护系统作业",
  analysis_run: "运行复合分析",
  run_backtest: "编写并运行回测",
  query_positions: "查询持仓",
  query_market_bars: "查询K线",
  query_pool: "查询标的池",
  get_strategy_doc: "读取策略文档",
  list_backtests: "回测台账列表",
  get_backtest_detail: "回测详情",
  fetch_market_data: "批量补拉数据",
  trigger_job: "触发系统作业",
  ui_refresh: "刷新页面数据",
};
