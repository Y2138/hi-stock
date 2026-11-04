// 超短策略共享类型：四个执行节点只通过关注池行交接，不新增决策表。
import type pg from "pg";

export type Db = Pick<pg.Pool | pg.PoolClient, "query">;
export type UltraShortPriority = "P1" | "P2" | "P3";
export type ReviewStatus = "pass" | "flag" | "invalid";
export type RiskLevel = "high" | "medium" | "low" | "unknown";
export type DataStatus = "ready" | "partial" | "insufficient";
export type AuctionBranch = "one_word" | "turnover_advance" | "high_open" | "low_open" | "weak" | "insufficient";
export type AuctionFillTier = "high" | "medium" | "low" | "none";
export type IntradayStatus = "waiting" | "triggered" | "invalidated" | "no_chase" | "filled";
export type TriggerType = "turnover_advance" | "long_huitou" | "dan_yang_bu_po" | "n_structure" | "online_yin";
export type TradeLine = "board" | "low_buy";
export type ExitStatus = "none" | "holding" | "exit_triggered" | "closed";
export type ExitAction = "hold" | "sell_half" | "sell_all";
export type ExitReason =
  | "hard_stop"
  | "board_open_weak"
  | "board_break"
  | "time_stop"
  | "target_1"
  | "target_2"
  | "take_profit_weak"
  | "circuit_breaker";

export const AUCTION_BRANCH_LABELS: Record<AuctionBranch, string> = {
  one_word: "一字延续",
  turnover_advance: "换手晋级",
  high_open: "高开过度",
  low_open: "低开分歧",
  weak: "走弱",
  insufficient: "数据不足",
};


/** 关键价位：只保存判定和提醒实际用到的数值，不复制整段日线。 */
export interface UltraShortKeyLevels {
  prev_close?: number | null;
  limit_up_price?: number | null;
  ma5?: number | null;
  ma10?: number | null;
  ma20?: number | null;
  ma60?: number | null;
  pattern_low?: number | null;
  breakout_price?: number | null;
  invalidation_price?: number | null;
  stop_price?: number | null;
}

export interface UltraShortRiskTemplate {
  stop_pct?: number | null;
  position_cap_pct?: number | null;
  template?: string;
}

export interface UltraShortAuctionExpect {
  branch?: AuctionBranch | "unknown";
  note?: string;
}

export interface UltraShortIntradayPlan {
  trigger?: TriggerType | "none";
  trigger_price?: number | null;
  invalidation_price?: number | null;
  note?: string;
}

/** 03 生成一行关注标的所需的最小事实。 */
export interface WatchlistDraft {
  code: string;
  name: string;
  sources: string[];
  tags: string[];
  resonance: boolean;
  priority: UltraShortPriority;
  priority_reason: string;
  stage: string | null;
  streak_count: number | null;
  t_facts: Record<string, unknown>;
  key_levels: UltraShortKeyLevels;
  auction_expect: UltraShortAuctionExpect;
  intraday_plan: UltraShortIntradayPlan;
  risk: UltraShortRiskTemplate;
  review_status: ReviewStatus;
  risk_level: RiskLevel;
  risk_flags: string[];
  review_note: string | null;
  gaps?: string[];
  data_status?: DataStatus;
}

export interface UltraShortWatchlistRow extends Omit<WatchlistDraft, "gaps" | "data_status"> {
  id: string;
  target_date: string;
  data_date: string;
  review_sources: unknown[];
  auction_branch: AuctionBranch | null;
  auction_fill_tier: AuctionFillTier | null;
  auction_priority: UltraShortPriority | null;
  auction_metrics: Record<string, unknown>;
  queue_window: Record<string, unknown>;
  auction_note: string | null;
  auction_status: string;
  intraday_status: IntradayStatus;
  trigger_type: TriggerType | null;
  trigger_at: string | null;
  trigger_price: number | null;
  trigger_reason: string | null;
  intraday_note: string | null;
  reminder_at: string | null;
  reminder_type: string | null;
  reminder_status: string | null;
  reminder_note: string | null;
  gaps: unknown[];
  data_status: DataStatus;
  entry_price: number | null;
  position_opened_at: string | null;
  exit_status: ExitStatus;
  exit_stage: number;
  exit_reason: ExitReason | null;
  exit_price: number | null;
  exit_at: string | null;
  realized_r: number | null;
  exit_reminder_at: string | null;
  exit_reminder_type: string | null;
  updated_at: string;
}

/** 退出引擎的即时上下文；由快速层维护，纯规则不自己读库。 */
export interface ExitContext {
  trade_date: string;
  now: Date;
  /** 含买入日在内的交易日计数：D=1、D+1=2。 */
  holding_days: number;
  /** 上一个快照是否封住涨停。 */
  sealed_before: boolean;
  /** 本轮开板开始时间（毫秒）；未开板为 null。 */
  open_since_ms: number | null;
  /** 含本轮在内的当日开板次数。 */
  open_count: number;
  seal_money: number | null;
  max_seal_money: number | null;
  /** 开板后成交量 / 开板前 5 分钟均量；无法计算为 null。 */
  open_volume_ratio: number | null;
  same_height_open: boolean;
  market_break_rate: number | null;
  limit_up_price: number | null;
  /** 当日开盘相对前收涨跌幅（%）；用于 D+1 开盘纪律。 */
  open_pct: number | null;
}

export interface ExitDecision {
  action: ExitAction;
  reason: ExitReason | null;
  price: number | null;
  stop_price: number | null;
  r_multiple: number | null;
  note: string;
  data_status: DataStatus;
  /** 退出阶段：0 未触发、1 已发第一止盈/半仓、2 已发清仓。 */
  next_stage: number;
}

export interface AuctionSampleInput {
  code: string;
  stage: "live" | "final";
  sample_at: Date;
  source_at: Date | null;
  auction_price: number | null;
  auction_pct: number | null;
  auction_unmatched: number | null;
  auction_volume: number | null;
  auction_amount: number | null;
  auction_turnover_pct: number | null;
  auction_volume_ratio: number | null;
  auction_yesterday_ratio_pct: number | null;
  float_market_cap: number | null;
  unmatched_ratio: number | null;
  data_status: DataStatus;
}

/** 竞价判定结果：只更新关注池，不改变池子成员。 */
export interface AuctionJudgement {
  branch: AuctionBranch;
  fill_tier: AuctionFillTier;
  priority: UltraShortPriority;
  metrics: Record<string, unknown>;
  queue_window: Record<string, unknown>;
  note: string;
  status: DataStatus;
}

export interface IntradayTriggerResult {
  status: IntradayStatus;
  trigger_type: TriggerType | null;
  trigger_price: number | null;
  trigger_reason: string | null;
  invalidation_price: number | null;
  note: string;
  data_status: DataStatus;
}
