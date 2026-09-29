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
  role: "portfolio" | "task" | "guidance";
  injection_order: number;
  job_code: string | null;
  sha256: string;
  content: string;
  updated_at: string;
}

export interface CurrentStrategy {
  state: StrategyState;
  documents: StrategyDocument[];
}

export type StrategyRuntimeType = "position" | "attention" | "observation" | "fallback_exit" | "portfolio_overlay";
export type StrategyRuntimeStatus = "active" | "exit_only" | "paused" | "retired";
export type StrategyEvaluationPhase = "entry" | "exit" | "context";
export type StrategyEvaluationStatus = "queued" | "running" | "success" | "partial" | "failed";

export interface StrategyEvaluationRun {
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
  requested_by_job_code: string | null;
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

export interface StrategyRuntimeTask {
  code: string;
  available_tools: string[];
  name: string;
  enabled: boolean;
  agent_role: string | null;
  purpose: string | null;
  phase: string | null;
  priority: number | null;
}

export interface StrategyEvaluatorMetadata {
  code: string;
  label: string;
  phase: StrategyEvaluationPhase | null;
  status: "ready" | "pending" | "unregistered";
  version: number | null;
}

export interface StrategyRuntimeDefinition {
  code: string;
  name: string;
  strategy_type: StrategyRuntimeType;
  strategy_document_code: string;
  strategy_document_title: string;
  strategy_document_sha256: string;
  status: StrategyRuntimeStatus;
  allow_new_entry: boolean;
  entry_evaluator_code: string | null;
  exit_evaluator_code: string | null;
  context_evaluator_code: string | null;
  fallback_strategy_code: string | null;
  fallback_strategy_name: string | null;
  exit_policy_mode: "none" | "dedicated" | "fallback_only" | "dedicated_plus_fallback";
  daily_plan_scope: Array<"entry" | "exit" | "attention" | "observe" | "context">;
  attention_policy: "none" | "qualified_only" | "qualified_and_approaching" | "manual_review";
  runtime_version: number;
  created_at: string;
  updated_at: string;
  position_count: number;
  attention_count: number;
  latest_evaluation: StrategyEvaluationRun | null;
  evaluators: { entry: StrategyEvaluatorMetadata | null; exit: StrategyEvaluatorMetadata | null; context: StrategyEvaluatorMetadata | null };
  tasks: StrategyRuntimeTask[];
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
  /** Agent 任务固定模型；为空时创建运行会话时跟随系统当前模型。 */
  model_id: string | null;
  /** 任务职责与产出：读取哪些事实、做出什么判断、留下什么结果。 */
  purpose: string | null;
  /** 调度时段特征：盘前/盘中/盘后/夜间/周末。 */
  phase: JobPhase | null;
  /** 重要性排序权重：数值越小越靠前。 */
  priority: number | null;
  strategy_code: string | null;
  agent_role: string | null;
  /** 仅交易日执行：非交易所开市日的 cron 触发不入队；周维护任务为 false。 */
  trading_day_only: boolean;
  available_tools: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
  latest_run: JobRunSummary | null;
  next_run: string | null;
}

export type JobPhase = "盘前" | "盘中" | "盘后" | "夜间" | "周末";
export const JOB_PHASES: readonly JobPhase[] = ["盘前", "盘中", "盘后", "夜间", "周末"];

export interface JobRun extends JobRunSummary {
  job_id: string;
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
  tool_usage: Array<{ tool_name: string; status: string; count: number }>;
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
  turnover: number | null;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  dif: number | null;
  dea: number | null;
  macd_hist: number | null;
  rsi14: number | null;
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

export type EntrySignalType =
  | "right_side"
  | "left_reversal"
  | "two_year_reversal"
  | "trial_start"
  | "swing"
  | "limit_up"
  | "discretionary";

export const ENTRY_SIGNAL_TYPE_LABELS: Record<string, string> = {
  right_side: "右侧主升", left_reversal: "旧左侧反转", two_year_reversal: "两年结构反转", trial_start: "试盘启动",
  swing: "波段", limit_up: "打板", discretionary: "自主决策",
};

export interface Position {
  instrument_id: string;
  code: string;
  name: string;
  kind: string;
  quantity: number;
  cost_price: number;
  cost_basis: string | null;
  opened_at: string | null;
  entry_signal_type: EntrySignalType | null;
  strategy_code: string | null;
  strategy_name: string | null;
  strategy_status: string | null;
  strategy_runtime_version: number | null;
  entry_signal_id: string | null;
  fallback_strategy_code: string | null;
  fallback_strategy_name: string | null;
  exit_policy_mode: "dedicated" | "fallback_only" | "dedicated_plus_fallback" | null;
  updated_at: string;
  close: number | null;
  close_date: string | null;
  market_value: number | null;
  pnl_amount: number | null;
  pnl_ratio: number | null;
  attribution_breakdown: Record<string, number>;
}

// ---- 每日计划盯防预案（server/modules/plans） ----

/** 情景预案五类固定情景；kind 与服务端 daily_plan_scenario 一致。 */
export type DailyPlanScenarioKind =
  | "surge_reversal"
  | "open_plunge"
  | "wide_swing"
  | "strong_continuation"
  | "weak_breakdown";

export interface DailyPlanScenario {
  id: string;
  scenario_kind: DailyPlanScenarioKind;
  observable_md: string;
  response_md: string;
  invalidation_md: string;
}

/** 关键点位事实：服务端机械计算（均线/近10、20日高低/前日高低/次日涨跌停）。 */
export interface DailyPlanKeyLevel {
  kind: "support" | "resistance" | "limit";
  label: string;
  price: number;
}

/** 做T预案：默认低吸/兑现区间；仅流动性极端允许 skip_reason。 */
export type DailyPlanTPlan =
  | { buy_lower: number; buy_upper: number; sell_lower: number; sell_upper: number; confirm_md: string; cancel_md: string }
  | { skip_reason: string };

export interface DailyPlanPlaybookItem {
  id: string;
  item_kind: "position_action" | "off_pool_opportunity";
  code: string;
  name: string;
  grade: "A" | "B" | "C" | null;
  priority: number;
  action: "exit" | "reduce" | "buy" | "hold" | "observe";
  trigger_kind: "open" | "price_range" | "condition";
  price_lower: number | null;
  price_upper: number | null;
  headline: string;
  auction_md: string | null;
  intraday_md: string | null;
  evidence_md: string | null;
  missing_md: string | null;
  invalidation_md: string | null;
  risk_md: string | null;
  key_levels: DailyPlanKeyLevel[];
  t_plan: DailyPlanTPlan | null;
  scenarios?: DailyPlanScenario[];
  strategy_code: string | null;
  strategy_runtime_version: number | null;
  primary_evaluation_run_id: string | null;
  fallback_evaluation_run_id: string | null;
  primary_action: "hold" | "observe" | "reduce" | "exit" | null;
  fallback_action: "hold" | "observe" | "reduce" | "exit" | null;
  effective_action: "hold" | "observe" | "reduce" | "exit" | "buy" | null;
  evaluation_status: "success" | "partial" | "failed" | "waiting" | null;
  evaluation_data_date: string | null;
  evaluation_missing: string[];
  target_date: string;
  auction_assessment: {
    id: string;
    output_id: string | null;
    code: string;
    conclusion: "worth_entering" | "signal_passed" | "observe" | "give_up" | "unavailable";
    review_type: "one_word_continue" | "turnover_advance" | "divergence" | "give_up" | "data_insufficient" | "legacy_observe";
    metrics_summary: string;
    assessment_summary: string;
    benchmark_tags: string[];
    data_status: "ready" | "not_ready" | "missing" | "stale";
    data_time?: string;
    assessed_at: string;
  } | null;
}

export interface DailyPlanBoard {
  plan: { output_id: string; target_date: string; status: string; created_at: string };
  position_actions: DailyPlanPlaybookItem[];
  opportunities: DailyPlanPlaybookItem[];
}
export interface AuctionScopeAssessment {
  id: string;
  target_key: string;
  scope_kind: "position" | "attention";
  code: string;
  name: string;
  attention_entry_id: string | null;
  strategy_code: string | null;
  strategy_name: string | null;
  conclusion: "plan_aligned" | "risk_alert" | "confirmed" | "wait" | "give_up" | "unavailable";
  metrics_summary: string;
  assessment_summary: string;
  data_status: "ready" | "not_ready" | "missing" | "stale";
  data_time: string | null;
}

export interface AuctionScopeBoard {
  output_id: string;
  target_date: string;
  items: AuctionScopeAssessment[];
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
  cost_price_before: number | null;
  realized_pnl: number | null;
  reason: string | null;
  source: string;
  decision_origin: "strategy_signal" | "planned_discretionary" | "unplanned_exception" | "fact_correction" | "unknown";
  execution_compliance: "matched" | "deviated" | "not_applicable" | "unknown";
  strategy_change_seq: string | null;
  strategy_snapshot_hash: string | null;
  plan_output_id: string | null;
  plan_output_type: string | null;
  plan_target_date: string | null;
  entry_auction_assessment_id: string | null;
  entry_signal_type: EntrySignalType | null;
  strategy_code: string | null;
  strategy_runtime_version: number | null;
  entry_signal_id: string | null;
  fallback_strategy_code: string | null;
  exit_policy_mode: "dedicated" | "fallback_only" | "dedicated_plus_fallback" | null;
  entry_signal_date: string | null;
  entry_assessment_date: string | null;
  entry_signal_review_type: string | null;
  entry_signal_grade: string | null;
  entry_signal_headline: string | null;
  source_session_id: string | null;
  attribution_note: string | null;
  deviation_reason: string | null;
  created_at: string;
}

export interface RealizedPnlSummary {
  baseline_pnl: number;
  event_pnl: number;
  realized_pnl: number;
  sell_count: number;
  missing_sell_count: number;
  fee_status: "excluded";
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

// ---- 标的池（server/modules/pools） ----

export interface PoolAttentionEntry {
  id: string;
  source_type: "manual" | "strategy";
  strategy_code: string | null;
  strategy_name: string | null;
  source_job: string;
  source_evaluation_run_id: string | null;
  last_evaluated_at: string | null;
  data_date: string | null;
  stale_reason: string | null;
  status: "qualified" | "approaching" | "manual";
  reason: string;
  missing_signals: string[];
  valid_from: string;
  valid_until: string | null;
}

export interface PoolResearch {
  attention_id: string;
  strategy_code: string | null;
  strategy_name: string | null;
  reason: string;
  status: PoolAttentionEntry["status"];
  missing_signals: string[];
  stale_reason: string | null;
  run_id: string | null;
  target_date: string | null;
  data_date: string | null;
  run_status: string | null;
  strategy_runtime_version: number | null;
  evidence: Record<string, unknown> | null;
  trigger_price_lower: number | null;
  trigger_price_upper: number | null;
  invalidation: string | null;
}

export interface PoolMember {
  id: string;
  pool: "watch";
  role: string;
  tags: string[];
  stock_character: string | null;
  stock_character_profile: Record<string, unknown>;
  stage: string | null;
  evaluation_summary: string | null;
  profile_as_of: string | null;
  profile_calculation_version: string | null;
  profile_input_sha256: string | null;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  attention_entries: PoolAttentionEntry[];
  code: string;
  name: string;
  kind: string;
  last: number | null;
  prev_close: number | null;
  change_pct: number | null;
  quote_time: string | null;
  price_source: "close" | null;
  boards: Array<{ code: string; name: string; board_type: string; level: "primary" | "secondary" }>;
  news: {
    direction: "positive" | "neutral" | "negative" | "mixed" | "unknown";
    status: "pending" | "stale" | "uncovered" | "empty" | "unverified" | "ready";
    captured_at: string | null;
    target_date: string | null;
    items: Array<MarketNewsItem>;
  };
}

export interface MarketNewsItem {
  id: string;
  title: string;
  summary: string;
  category: string;
  scope: string;
  direction: "positive" | "neutral" | "negative" | "mixed" | "unknown";
  impact_level: "high" | "medium" | "low";
  relation_type: string;
  source_level: string;
  source_name: string;
  source_url: string;
  published_at: string | null;
  fetched_at: string;
  facts: string;
  impact_note: string;
  expires_at: string | null;
  codes: string[];
}

export interface MarketNewsSnapshot {
  id: string;
  target_date: string;
  captured_at: string;
  status: "success" | "partial" | "failed";
  market_bias: "positive" | "neutral" | "negative" | "mixed" | "unknown";
  summary: string;
  checked_codes: string[];
  gaps: string[];
  items: MarketNewsItem[];
  stale: boolean;
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
  pool: "watch";
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
  session_type: "interactive" | "job";
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
  | { type: "activity"; data: AgentActivity }
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

export interface AgentActivity {
  phase: "thinking" | "writing" | "preparing_tool" | "executing_tool" | "tool_finished" | "tool_failed" | "saving";
  at: number;
  started_at?: number;
  tool_name?: string;
  job_code?: string;
  completed?: number;
  total?: number;
}

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
  tool_catalog: "加载所需工具",
  daily_plan_strategy_query: "统筹每日计划策略评估",
  strategy_evaluation_query: "查询单策略结构化评估",
  web_search: "搜索公开网页", web_fetch: "读取公开网页",
  two_year_reversal_signal_query: "查询两年结构反转信号", value_anchor_signal_query: "查询价值错杀信号",
  strategy_screen_query: "筛选策略条件",
  portfolio_context_query: "查询组合与持仓",
  pool_context_query: "查询标的池",
  job_context_query: "查询任务与历史结果",
  strategy_document_query: "读取策略文档",
  auction_context_query: "读取竞价候选与预案",
  pool_attention_write: "同步标的池近期关注",
  daily_plan_write: "写入每日计划与打板机会草稿",
  auction_assessment_write: "写入打板机会竞价复核草稿",
  database_schema: "发现数据库结构",
  database_query: "查询数据库",
  instrument_search: "检索标的目录",
  market_snapshot_query: "查询最新行情快照",
  stock_research_query: "查询标的研究证据",
  board_query: "查询板块与成分",
  market_event_query: "查询市场结构",
  daily_plan_context_query: "查询每日计划确定性上下文",
  swing_signal_query: "查询波段确定性信号",
  limit_up_signal_query: "查询打板确定性评分",
  indicator_query: "查询可信行情指标",
  portfolio_write: "维护持仓",
  pool_onboard: "标的入池初始化",
  pool_write: "维护标的池",
  memory_query: "查询 Agent 记忆",
  memory_write: "维护 Agent 记忆",
  job_write: "维护系统作业",
  analysis_run: "运行复合分析",
  query_positions: "查询持仓",
  query_market_bars: "查询K线",
  query_pool: "查询标的池",
  get_strategy_doc: "读取策略文档",
  list_backtests: "回测台账列表",
  get_backtest_detail: "回测详情",
  fetch_market_data: "批量补拉数据",
  fetch_hithink_data: "同步扶摇研究数据",
  hithink_catalog: "发现扶摇数据能力",
  hithink_query: "临时查询扶摇数据",
  trigger_job: "触发系统作业",
  ui_refresh: "刷新页面数据",
};

export interface NotificationSettings {
  enabled: boolean;
  job_codes: string[] | null;
  strategy_job_codes: string[] | null;
  jobs: Array<{ code: string; name: string; enabled: boolean }>;
  strategy_jobs: Array<{ code: string; name: string; enabled: boolean }>;
  personal_enabled: boolean;
  personal_webhook_configured: boolean;
  personal_sign_secret_configured: boolean;
  strategy_enabled: boolean;
  strategy_webhook_configured: boolean;
  strategy_sign_secret_configured: boolean;
  webhook_configured: boolean;
  sign_secret_configured: boolean;
  revision: number;
  personal_revision: number;
  strategy_revision: number;
  updated_at: string;
}
export interface NotificationDelivery {
  id: string;
  output_id: string | null;
  kind: "daily_plan" | "agent_result" | "intraday_risk" | "test";
  channel: "personal" | "strategy";
  job_code: string | null;
  job_name: string | null;
  content: string;
  status: "pending" | "sending" | "sent" | "failed" | "cancelled";
  attempts: number;
  error: string | null;
  created_at: string;
  sent_at: string | null;
  next_attempt_at: string;
}

export interface NotificationPage {
  items: Omit<NotificationDelivery, "content">[];
  next_cursor: string | null;
}

export type IntradayRiskLevel = "normal" | "watch" | "high";
export interface IntradayRiskRow {
  code: string;
  name: string;
  risk: IntradayRiskLevel;
  key_level: string | null;
  reason: string;
  sample_at: string | null;
  data_time: string | null;
  model_key: string;
  updated_at: string;
}
export interface IntradayRiskSnapshot {
  trade_date: string;
  running: boolean;
  sample_at: string | null;
  data_status: "ready" | "partial" | "stale" | "unavailable";
  positions: IntradayRiskRow[];
}
