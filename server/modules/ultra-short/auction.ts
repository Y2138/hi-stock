// 01 竞价判定：09:18–09:25 对 03 关注池逐只采样、判定并提醒；只更新关注池，不新增候选。
// 所有阈值都是初始口径，待真实成交样本校准；未标注时按 docs/product/策略口径与提示词规范.md 默认值。
import type { TransactionDb } from "../../db/transaction.js";
import { fetchHithinkDataset } from "../../datasource/hithink-datasets.js";
import type { HithinkDeps } from "../../datasource/hithink.js";
import { isScheduledTradingDay, shanghaiDate } from "../../scheduler/time.js";
import {
  notifyAuctionBuy,
  notifyAuctionCancel,
  notifyAuctionUpgrade,
  type AlertCandidate,
} from "./alerts.js";
import {
  firstLiveAuctionSamples,
  insertAuctionSamples,
  listWatchlist,
  saveAuctionJudgement,
  type WatchlistPatch,
} from "./repo.js";
import {
  AUCTION_BRANCH_LABELS,
  type AuctionBranch,
  type AuctionFillTier,
  type AuctionJudgement,
  type AuctionSampleInput,
  type DataStatus,
  type RiskLevel,
  type ReviewStatus,
  type UltraShortPriority,
  type UltraShortWatchlistRow,
} from "./types.js";

const AUCTION_SNAPSHOT_START_MINUTE = 9 * 60 + 18;
const AUCTION_SNAPSHOT_END_MINUTE = 9 * 60 + 25;
const AUCTION_BUY_START_MINUTE = 9 * 60 + 20;
const AUCTION_BUY_END_MINUTE = 9 * 60 + 24;

/** 达到涨停价的容差：半分钱，兼容供应商两位小数取整。 */
const LIMIT_UP_PRICE_TOLERANCE = 0.005;
/** 一字延续/换手晋级的换手上限（%），超过视为走弱。待回测。 */
const ONE_WORD_TURNOVER_LIMIT = 10;
/** 换手晋级允许的竞价涨幅上限（%），超过按高开过度。待回测。 */
const TURNOVER_ADVANCE_MAX_PCT = 5;
/** 非一字高开过度阈值（%）。待回测。 */
const HIGH_OPEN_PCT = 5;
/** 一字成交概率分档：高 = 换手 ≥1.5% 且 未匹配/竞价量 ≤1.5。待回测。 */
const FILL_HIGH_TURNOVER_PCT = 1.5;
const FILL_HIGH_UNMATCHED_RATIO = 1.5;
/** 中档下限与上限：换手 0.8%–1.5%，或未匹配/竞价量 1.5–5。待回测。 */
const FILL_MEDIUM_TURNOVER_PCT = 0.8;
const FILL_MEDIUM_UNMATCHED_RATIO = 5;
/** 升级提醒的“强度明显增强”口径：换手 +0.5 个百分点，或未匹配量增长 50%。待回测。 */
const UPGRADE_TURNOVER_DELTA_PCT = 0.5;
const UPGRADE_UNMATCHED_GROWTH = 1.5;
/** auction_snapshot 单次最多 100 只。 */
const AUCTION_SNAPSHOT_BATCH_SIZE = 100;

/** 竞价快照数值；null 表示供应商未返回，不猜。 */
export interface AuctionMetrics {
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
  data_gaps: string[];
}

/** 09:18/09:20 的 live 基线采样，用来判断未匹配量与换手的变化。 */
export interface AuctionPrevLive {
  auction_unmatched: number | null;
  auction_turnover_pct: number | null;
}

/** 竞价环境：同高度对手的竞价强弱与短线风向标首行；只影响优先级和记录，不参与硬条件。 */
export interface AuctionMarketContext {
  same_height_best_pct?: number | null;
}

export interface AuctionCycleOptions {
  /** 扶摇依赖注入；测试注入 RateLimiter(0) 与 apiKey，避免真实网络和限流等待。 */
  deps?: HithinkDeps;
}

export interface AuctionCycleResult {
  trade_date: string;
  stage: "live" | "final" | null;
  sampled: number;
  judged: number;
  reminders: number;
  status: "success" | "partial" | "insufficient" | "skipped";
  gaps: string[];
}

export interface AuctionReminderPlan {
  action: "none" | "buy" | "upgrade" | "cancel";
  reason: string;
}

export interface AuctionReminderInput {
  branch: AuctionBranch;
  fill_tier: AuctionFillTier;
  status: DataStatus;
  review_status: ReviewStatus;
  risk_level: RiskLevel;
  auction_unmatched: number | null;
  auction_turnover_pct: number | null;
  minute_of_day: number;
  reminder_type: string | null;
  reminder_note: string | null;
}

interface AuctionSnapshotEntry {
  item: Record<string, unknown>;
  sourceAt: Date | null;
  sourceStatus: DataStatus;
  sourceGap: string | null;
}

const FILL_TIER_RANK: Record<AuctionFillTier, number> = { none: 0, low: 1, medium: 2, high: 3 };

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundPrice(value: number): number {
  return Number(value.toFixed(2));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function formatMinute(minuteOfDay: number): string {
  const hour = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const minute = String(minuteOfDay % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}

function shanghaiMinuteOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** 采样阶段：09:18 上下文与 09:20–09:24 用 live，09:25 用 final；其余分钟不采样。 */
function stageForMinute(minuteOfDay: number): "live" | "final" | null {
  if (minuteOfDay === AUCTION_SNAPSHOT_END_MINUTE) return "final";
  if (minuteOfDay === AUCTION_SNAPSHOT_START_MINUTE) return "live";
  if (minuteOfDay >= AUCTION_BUY_START_MINUTE && minuteOfDay <= AUCTION_BUY_END_MINUTE) return "live";
  return null;
}

/** 涨停价：优先 03 关键价位，缺失时按前收×1.1 近似并标记缺口。 */
function effectiveLimitUp(row: UltraShortWatchlistRow): { price: number | null; approx: boolean } {
  const limitUp = num(row.key_levels.limit_up_price);
  if (limitUp !== null && limitUp > 0) return { price: limitUp, approx: false };
  const prevClose = num(row.key_levels.prev_close);
  if (prevClose !== null && prevClose > 0) return { price: roundPrice(prevClose * 1.1), approx: true };
  return { price: null, approx: false };
}

/** 一字成交概率分档：非一字/数据不足走 none；同文档初始分档阈值。 */
export function auctionFillTier(input: {
  auction_unmatched: number | null;
  auction_turnover_pct: number | null;
  unmatched_ratio: number | null;
  auction_volume: number | null;
}): AuctionFillTier {
  if (input.auction_unmatched === null || input.auction_unmatched <= 0) return "none";
  if (input.auction_turnover_pct === null) return "none";
  if (input.unmatched_ratio === null) return "low";
  const turnover = input.auction_turnover_pct;
  const ratio = input.unmatched_ratio;
  if (turnover >= FILL_HIGH_TURNOVER_PCT && ratio <= FILL_HIGH_UNMATCHED_RATIO) return "high";
  if ((turnover >= FILL_MEDIUM_TURNOVER_PCT && turnover < FILL_HIGH_TURNOVER_PCT)
    || (ratio > FILL_HIGH_UNMATCHED_RATIO && ratio <= FILL_MEDIUM_UNMATCHED_RATIO)) return "medium";
  return "low";
}

/** 竞价优先级：P1 只给高成交概率一字或强于同高度的换手晋级，其余 P2/P3。 */
export function auctionPriority(input: {
  branch: AuctionBranch;
  fill_tier: AuctionFillTier;
  auction_pct: number | null;
  auction_unmatched: number | null;
  same_height_best_pct?: number | null;
}): UltraShortPriority {
  if (input.branch === "one_word") {
    if (input.fill_tier === "high") return "P1";
    if (input.fill_tier === "medium") return "P2";
    return "P3";
  }
  if (input.branch === "turnover_advance") {
    const best = input.same_height_best_pct ?? null;
    const stronger = best !== null && input.auction_pct !== null && input.auction_pct > best;
    return stronger && input.auction_unmatched !== null && input.auction_unmatched > 0 ? "P1" : "P2";
  }
  return "P3";
}

function branchCancelReason(branch: AuctionBranch): string {
  switch (branch) {
    case "turnover_advance": return "价格离开涨停，转为换手晋级";
    case "high_open": return "高开过度，价格离开涨停";
    case "low_open": return "竞价转为低开分歧";
    case "weak": return "竞价走弱：买方未匹配转负、换手超限或跌停";
    case "insufficient": return "竞价数据不足，无法确认一字延续";
    case "one_word": return "一字延续条件不再满足";
  }
}

interface ReminderBaseline {
  fill_tier: AuctionFillTier;
  turnover: number | null;
  unmatched: number | null;
}

function parseReminderBaseline(note: string | null): ReminderBaseline | null {
  if (!note) return null;
  try {
    const parsed = JSON.parse(note) as Record<string, unknown>;
    const tier = parsed.fill_tier;
    if (typeof tier !== "string" || !(tier in FILL_TIER_RANK)) return null;
    return {
      fill_tier: tier as AuctionFillTier,
      turnover: num(parsed.turnover_pct),
      unmatched: num(parsed.auction_unmatched),
    };
  } catch {
    return null;
  }
}

function strengthIncreased(input: AuctionReminderInput, baseline: ReminderBaseline): boolean {
  if (FILL_TIER_RANK[input.fill_tier] > FILL_TIER_RANK[baseline.fill_tier]) return true;
  if (input.auction_turnover_pct !== null && baseline.turnover !== null
    && input.auction_turnover_pct >= baseline.turnover + UPGRADE_TURNOVER_DELTA_PCT) return true;
  return input.auction_unmatched !== null && baseline.unmatched !== null && baseline.unmatched > 0
    && input.auction_unmatched >= baseline.unmatched * UPGRADE_UNMATCHED_GROWTH;
}

/**
 * 一字提醒状态机（纯函数）：首次买入提醒、最多一次升级提醒、条件恶化撤单提醒。
 * 09:25 及之后不再发买入/升级提醒；09:18 只采样。
 */
export function planAuctionReminder(input: AuctionReminderInput): AuctionReminderPlan {
  const riskBlocked = input.review_status === "invalid" || input.risk_level === "high";
  if (input.reminder_type === "auction_cancel") {
    return { action: "none", reason: "已发撤单复核提醒，不再重复提醒" };
  }
  const hasReminder = input.reminder_type === "auction_buy" || input.reminder_type === "auction_upgrade";
  if (hasReminder) {
    if (riskBlocked) {
      return { action: "cancel", reason: input.review_status === "invalid" ? "复核状态变为 invalid" : "风险等级升级为 high" };
    }
    if (input.status === "insufficient") {
      return { action: "cancel", reason: "竞价数据不足，无法确认一字延续" };
    }
    if (input.branch !== "one_word" || input.fill_tier === "none") {
      return { action: "cancel", reason: branchCancelReason(input.branch) };
    }
    const inBuyWindow = input.minute_of_day >= AUCTION_BUY_START_MINUTE && input.minute_of_day <= AUCTION_BUY_END_MINUTE;
    if (inBuyWindow && input.reminder_type === "auction_buy") {
      const baseline = parseReminderBaseline(input.reminder_note);
      if (baseline !== null && strengthIncreased(input, baseline)) {
        return { action: "upgrade", reason: "成交概率档或竞价强度较上次提醒增强" };
      }
    }
    return { action: "none", reason: "已有提醒且条件未明显增强" };
  }
  if (riskBlocked) {
    return { action: "none", reason: input.review_status === "invalid" ? "复核状态为 invalid，不发买入提醒" : "风险等级为 high，不发买入提醒" };
  }
  if (input.minute_of_day < AUCTION_BUY_START_MINUTE || input.minute_of_day > AUCTION_BUY_END_MINUTE) {
    return { action: "none", reason: "不在 09:20–09:24 买入提醒窗口" };
  }
  if (input.status === "insufficient" || input.branch !== "one_word" || input.fill_tier === "none") {
    return { action: "none", reason: "未构成可提醒的一字延续" };
  }
  return {
    action: "buy",
    reason: input.fill_tier === "low" ? "一字延续成立，成交概率低，仍提醒谨慎排队" : "一字延续成立，立即提醒排队",
  };
}

/**
 * 分支判定（纯函数）：数据不足优先，其次走弱，再按价格位置分一字/高开/换手/低开。
 * prevLive 用于记录 9:20→9:25 的未匹配与换手变化；marketContext 只影响优先级和记录。
 */
export function judgeAuctionBranch(
  row: UltraShortWatchlistRow,
  metrics: AuctionMetrics,
  prevLive: AuctionPrevLive | null,
  marketContext: AuctionMarketContext = {},
): AuctionJudgement {
  const gaps = [...metrics.data_gaps];
  const price = metrics.auction_price;
  const unmatched = metrics.auction_unmatched;
  const volume = metrics.auction_volume;
  const turnover = metrics.auction_turnover_pct;
  const prevClose = num(row.key_levels.prev_close);
  const limitUp = effectiveLimitUp(row);
  if (limitUp.price === null) gaps.push("缺少涨停价与前收，无法判定一字延续");
  else if (limitUp.approx) gaps.push("涨停价按前收×1.1 近似，需 03 关键价位补齐");

  let pct = metrics.auction_pct;
  if (pct === null && price !== null && prevClose !== null && prevClose > 0) {
    pct = Number((((price / prevClose) - 1) * 100).toFixed(4));
    gaps.push("竞价涨幅缺失，按竞价价/前收推算");
  }
  const atLimitUp = limitUp.price !== null && price !== null && price >= limitUp.price - LIMIT_UP_PRICE_TOLERANCE;
  const atLimitDown = prevClose !== null && prevClose > 0 && price !== null
    && price <= roundPrice(prevClose * 0.9) + LIMIT_UP_PRICE_TOLERANCE;

  const missingFields: string[] = [];
  if (price === null) missingFields.push("竞价价");
  if (unmatched === null) missingFields.push("未匹配量");
  if (turnover === null) missingFields.push("竞价换手");
  if (pct === null) missingFields.push("竞价涨幅");

  let branch: AuctionBranch;
  if (metrics.data_status === "insufficient" || price === null || unmatched === null || turnover === null || pct === null) {
    branch = "insufficient";
    if (missingFields.length > 0) gaps.push(`关键字段缺失：${missingFields.join("、")}`);
  } else if (unmatched <= 0 || turnover > ONE_WORD_TURNOVER_LIMIT || atLimitDown) {
    // 未匹配转负、换手超限、跌停都是明确走弱，先于价格位置判断。
    branch = "weak";
  } else if (atLimitUp) {
    branch = "one_word";
  } else if (pct > HIGH_OPEN_PCT) {
    branch = "high_open";
  } else if (pct >= 0 && pct <= TURNOVER_ADVANCE_MAX_PCT) {
    branch = "turnover_advance";
  } else {
    branch = "low_open";
  }

  const fillTier = branch === "one_word"
    ? auctionFillTier({ auction_unmatched: unmatched, auction_turnover_pct: turnover, unmatched_ratio: metrics.unmatched_ratio, auction_volume: volume })
    : "none";
  const sameHeightBestPct = marketContext.same_height_best_pct ?? null;
  const priority = auctionPriority({
    branch,
    fill_tier: fillTier,
    auction_pct: pct,
    auction_unmatched: unmatched,
    same_height_best_pct: sameHeightBestPct,
  });
  const queueWindow = branch === "one_word" && limitUp.price !== null
    ? {
        window: "09:20-09:24",
        price: limitUp.price,
        price_basis: limitUp.approx ? "prev_close*1.1 近似" : "03 关键价位",
      }
    : {};

  const dataGaps = dedupe(gaps);
  const status: DataStatus = branch === "insufficient" || metrics.data_status === "insufficient"
    ? "insufficient"
    : dataGaps.length > 0 || metrics.data_status === "partial" ? "partial" : "ready";
  const prevUnmatched = prevLive?.auction_unmatched ?? null;
  const prevTurnover = prevLive?.auction_turnover_pct ?? null;
  const judgementMetrics: Record<string, unknown> = {
    ...metrics,
    auction_pct: pct,
    limit_up_price: limitUp.price,
    limit_up_approx: limitUp.approx,
    prev_close: prevClose,
    prev_unmatched: prevUnmatched,
    prev_turnover_pct: prevTurnover,
    unmatched_delta: prevUnmatched !== null && unmatched !== null
      ? Number((unmatched - prevUnmatched).toFixed(4)) : null,
    turnover_delta_pct: prevTurnover !== null && turnover !== null
      ? Number((turnover - prevTurnover).toFixed(4)) : null,
    same_height_best_pct: sameHeightBestPct,
    data_gaps: dataGaps,
  };
  return {
    branch,
    fill_tier: fillTier,
    priority,
    metrics: judgementMetrics,
    queue_window: queueWindow,
    note: judgementNote(branch, judgementMetrics, dataGaps),
    status,
  };
}

function judgementNote(branch: AuctionBranch, metrics: Record<string, unknown>, gaps: string[]): string {
  const price = num(metrics.auction_price);
  const pct = num(metrics.auction_pct);
  const unmatched = num(metrics.auction_unmatched);
  const ratio = num(metrics.unmatched_ratio);
  const turnover = num(metrics.auction_turnover_pct);
  const pctText = pct === null ? "待补" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  const parts = [
    `竞价价 ${price === null ? "待补" : price.toFixed(2)}`,
    `涨幅 ${pctText}`,
    `未匹配 ${unmatched === null ? "待补" : unmatched.toFixed(0)}`,
    `未匹配/竞价量 ${ratio === null ? "待补" : ratio.toFixed(2)}`,
    `竞价换手 ${turnover === null ? "待补" : `${turnover.toFixed(2)}%`}`,
  ];
  return `${AUCTION_BRANCH_LABELS[branch]}：${parts.join("，")}${gaps.length > 0 ? `；缺口：${gaps.join("、")}` : ""}`;
}

async function fetchAuctionSnapshots(
  codes: string[],
  stage: "live" | "final",
  tradeDate: string,
  deps: HithinkDeps | undefined,
  gaps: string[],
): Promise<Map<string, AuctionSnapshotEntry>> {
  const byCode = new Map<string, AuctionSnapshotEntry>();
  for (let index = 0; index < codes.length; index += AUCTION_SNAPSHOT_BATCH_SIZE) {
    const batch = codes.slice(index, index + AUCTION_SNAPSHOT_BATCH_SIZE);
    try {
      const result = await fetchHithinkDataset({ capability: "auction_snapshot", codes: batch, stage }, deps);
      const sourceAt = result.sourceTimestampMs === null ? null : new Date(result.sourceTimestampMs);
      let sourceStatus: DataStatus = "ready";
      let sourceGap: string | null = null;
      if (sourceAt === null) {
        // 最终快照必须能核对来源时间；live 缺时间只降级不判死。
        sourceStatus = stage === "final" ? "insufficient" : "partial";
        sourceGap = stage === "final" ? "最终竞价快照缺少来源时间" : "竞价快照缺少来源时间";
      } else if (shanghaiDate(sourceAt) !== tradeDate) {
        sourceStatus = "insufficient";
        sourceGap = `竞价快照来源日 ${shanghaiDate(sourceAt)} 与目标日 ${tradeDate} 不一致`;
      }
      if (!Array.isArray(result.payload.item)) continue;
      for (const raw of result.payload.item) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const item = raw as Record<string, unknown>;
        const code = typeof item.thscode === "string" ? item.thscode : null;
        if (code === null) continue;
        byCode.set(code, { item, sourceAt, sourceStatus, sourceGap });
      }
    } catch (error) {
      gaps.push(`竞价快照获取失败（${stage}，${batch.length} 只）：${errorMessage(error)}`);
    }
  }
  return byCode;
}

function buildAuctionMetrics(
  row: UltraShortWatchlistRow,
  snapshot: AuctionSnapshotEntry | undefined,
): AuctionMetrics {
  const gaps: string[] = [];
  const item = snapshot?.item ?? {};
  const price = num(item.auction_price);
  let pct = num(item.auction_pct);
  const unmatched = num(item.auction_unmatched);
  const volume = num(item.auction_volume);
  const amount = num(item.auction_amount);
  const turnover = num(item.auction_turnover_pct);
  const volumeRatio = num(item.auction_volume_ratio);
  const yesterdayRatio = num(item.auction_yesterday_ratio_pct);
  const floatMarketCap = num(item.float_market_cap);
  const prevClose = num(row.key_levels.prev_close);
  const unmatchedRatio = unmatched !== null && volume !== null && volume > 0
    ? Number((unmatched / volume).toFixed(6)) : null;

  let status: DataStatus;
  if (snapshot === undefined) {
    status = "insufficient";
    gaps.push("竞价快照缺失");
  } else {
    status = snapshot.sourceStatus;
    if (snapshot.sourceGap !== null) gaps.push(snapshot.sourceGap);
    // 供应商缺涨幅但有价格与前收时按同一口径推算，写入采样与判定的是同一个值。
    if (pct === null && price !== null && prevClose !== null && prevClose > 0) {
      pct = Number((((price / prevClose) - 1) * 100).toFixed(4));
      gaps.push("竞价涨幅缺失，按竞价价/前收推算");
      if (status === "ready") status = "partial";
    }
    const missing: string[] = [];
    if (price === null) missing.push("竞价价");
    if (unmatched === null) missing.push("未匹配量");
    if (turnover === null) missing.push("竞价换手");
    if (pct === null) missing.push("竞价涨幅");
    if (missing.length > 0) {
      status = "insufficient";
      gaps.push(`关键字段缺失：${missing.join("、")}`);
    } else if (volume === null) {
      if (status === "ready") status = "partial";
      gaps.push("竞价量缺失，未匹配/竞价量不可算");
    }
  }
  return {
    auction_price: price,
    auction_pct: pct,
    auction_unmatched: unmatched,
    auction_volume: volume,
    auction_amount: amount,
    auction_turnover_pct: turnover,
    auction_volume_ratio: volumeRatio,
    auction_yesterday_ratio_pct: yesterdayRatio,
    float_market_cap: floatMarketCap,
    unmatched_ratio: unmatchedRatio,
    data_status: status,
    data_gaps: gaps,
  };
}

function toAlertCandidate(row: UltraShortWatchlistRow, judgement: AuctionJudgement): AlertCandidate {
  const keyLevels: Record<string, unknown> = { ...row.key_levels };
  const limitUp = num(judgement.metrics.limit_up_price);
  if (limitUp !== null) keyLevels.limit_up_price = limitUp;
  return {
    code: row.code,
    name: row.name,
    target_date: row.target_date,
    priority: row.priority,
    auction_priority: judgement.priority,
    auction_branch: judgement.branch,
    auction_fill_tier: judgement.fill_tier,
    tags: row.tags,
    key_levels: keyLevels,
    risk: { ...row.risk },
    auction_metrics: judgement.metrics,
    queue_window: judgement.queue_window,
  };
}

function reminderBaselineNote(judgement: AuctionJudgement, at: Date): string {
  const metrics = judgement.metrics;
  return JSON.stringify({
    at: at.toISOString(),
    fill_tier: judgement.fill_tier,
    turnover_pct: num(metrics.auction_turnover_pct),
    auction_unmatched: num(metrics.auction_unmatched),
    auction_pct: num(metrics.auction_pct),
  });
}

/**
 * 01 主循环：采样 → 写 auction_intraday_sample → 逐只判定写回关注池 → 按状态机发提醒。
 * 只读关注池成员，不清空、不新增；数据失败降级为 gaps，不抛致命错误。
 */
export async function runUltraShortAuctionCycle(
  db: TransactionDb,
  now: Date,
  opts: AuctionCycleOptions = {},
): Promise<AuctionCycleResult> {
  const tradeDate = shanghaiDate(now);
  const minuteOfDay = shanghaiMinuteOfDay(now);
  const stage = stageForMinute(minuteOfDay);
  const gaps: string[] = [];
  const skipped = (reason: string): AuctionCycleResult => ({
    trade_date: tradeDate,
    stage: null,
    sampled: 0,
    judged: 0,
    reminders: 0,
    status: "skipped",
    gaps: [reason],
  });

  if (stage === null) {
    return skipped(`非集合竞价采样窗口（09:18、09:20–09:25），当前上海时间 ${formatMinute(minuteOfDay)}`);
  }
  if (!(await isScheduledTradingDay(db, tradeDate))) return skipped(`${tradeDate} 非交易日`);
  const rows = await listWatchlist(db, tradeDate);
  if (rows.length === 0) return skipped(`${tradeDate} 超短关注池为空，跳过竞价判定`);

  const validCodes: string[] = [];
  for (const code of new Set(rows.map((row) => row.code))) {
    if (/^\d{6}\.(?:SH|SZ|BJ)$/.test(code)) validCodes.push(code);
    else gaps.push(`关注池代码格式非法，跳过竞价采样：${code}`);
  }

  const snapshots = await fetchAuctionSnapshots(validCodes, stage, tradeDate, opts.deps, gaps);
  // 必须在写入本轮采样前取基线，否则会把本轮当成 09:20 基线。
  const prevLive = await firstLiveAuctionSamples(db, tradeDate, validCodes);

  const samples: AuctionSampleInput[] = [];
  const metricsByCode = new Map<string, AuctionMetrics>();
  for (const row of rows) {
    const metrics = buildAuctionMetrics(row, snapshots.get(row.code));
    metricsByCode.set(row.code, metrics);
    for (const gap of metrics.data_gaps) gaps.push(`${row.code}：${gap}`);
    samples.push({
      code: row.code,
      stage,
      sample_at: now,
      source_at: snapshots.get(row.code)?.sourceAt ?? null,
      auction_price: metrics.auction_price,
      auction_pct: metrics.auction_pct,
      auction_unmatched: metrics.auction_unmatched,
      auction_volume: metrics.auction_volume,
      auction_amount: metrics.auction_amount,
      auction_turnover_pct: metrics.auction_turnover_pct,
      auction_volume_ratio: metrics.auction_volume_ratio,
      auction_yesterday_ratio_pct: metrics.auction_yesterday_ratio_pct,
      float_market_cap: metrics.float_market_cap,
      unmatched_ratio: metrics.unmatched_ratio,
      data_status: metrics.data_status,
    });
  }
  let sampled = 0;
  try {
    sampled = await insertAuctionSamples(db, tradeDate, samples);
  } catch (error) {
    gaps.push(`竞价采样写入失败：${errorMessage(error)}`);
  }

  // 同高度对手：优先按 stage 分组（同一梯队），没有 stage 时退化为板高分组。
  const groupKeyOf = (row: UltraShortWatchlistRow): string => row.stage && row.stage.trim().length > 0
    ? `stage:${row.stage}` : row.streak_count !== null ? `streak:${row.streak_count}` : "unknown";
  const groupPcts = new Map<string, Array<{ code: string; pct: number }>>();
  for (const row of rows) {
    const pct = metricsByCode.get(row.code)?.auction_pct ?? null;
    if (pct === null) continue;
    const key = groupKeyOf(row);
    const members = groupPcts.get(key) ?? [];
    members.push({ code: row.code, pct });
    groupPcts.set(key, members);
  }

  let judged = 0;
  let reminders = 0;
  let readyCount = 0;
  let insufficientCount = 0;
  for (const row of rows) {
    const metrics = metricsByCode.get(row.code)!;
    const peers = (groupPcts.get(groupKeyOf(row)) ?? []).filter((peer) => peer.code !== row.code);
    const sameHeightBestPct = peers.length > 0 ? Math.max(...peers.map((peer) => peer.pct)) : null;
    const prev = prevLive.get(row.code) ?? null;
    const prevInput: AuctionPrevLive | null = prev === null ? null : {
      auction_unmatched: num(prev.auction_unmatched),
      auction_turnover_pct: num(prev.auction_turnover_pct),
    };
    const judgement = judgeAuctionBranch(row, metrics, prevInput, {
      same_height_best_pct: sameHeightBestPct,
    });
    const plan = planAuctionReminder({
      branch: judgement.branch,
      fill_tier: judgement.fill_tier,
      status: judgement.status,
      review_status: row.review_status,
      risk_level: row.risk_level,
      auction_unmatched: metrics.auction_unmatched,
      auction_turnover_pct: metrics.auction_turnover_pct,
      minute_of_day: minuteOfDay,
      reminder_type: row.reminder_type,
      reminder_note: row.reminder_note,
    });
    let reminderPatch: WatchlistPatch = {};
    const candidate = toAlertCandidate(row, judgement);
    if (plan.action !== "none") {
      try {
        if (plan.action === "buy") {
          const queued = await notifyAuctionBuy(db, candidate, now);
          if (queued) reminders += 1;
          reminderPatch = {
            reminder_type: "auction_buy",
            reminder_status: queued ? "sent" : "skipped",
            reminder_at: now,
            reminder_note: reminderBaselineNote(judgement, now),
          };
        } else if (plan.action === "upgrade") {
          const queued = await notifyAuctionUpgrade(db, candidate, now);
          if (queued) reminders += 1;
          reminderPatch = {
            reminder_type: "auction_upgrade",
            reminder_status: queued ? "sent" : "skipped",
            reminder_at: now,
            reminder_note: reminderBaselineNote(judgement, now),
          };
        } else {
          const queued = await notifyAuctionCancel(db, candidate, plan.reason, now);
          if (queued) reminders += 1;
          reminderPatch = {
            reminder_type: "auction_cancel",
            reminder_status: queued ? "sent" : "skipped",
            reminder_at: now,
            reminder_note: plan.reason,
          };
        }
      } catch (error) {
        // 提醒失败不阻断判定；不写 reminder_type，下一次采样可以重试同一动作。
        gaps.push(`竞价提醒发送失败 ${row.code}：${errorMessage(error)}`);
        reminderPatch = { reminder_status: "failed", reminder_at: now, reminder_note: errorMessage(error) };
      }
    }
    try {
      await saveAuctionJudgement(db, tradeDate, row.code, judgement, reminderPatch);
      judged += 1;
      if (judgement.status === "ready") readyCount += 1;
      else if (judgement.status === "insufficient") insufficientCount += 1;
    } catch (error) {
      gaps.push(`关注池竞价判定写回失败 ${row.code}：${errorMessage(error)}`);
    }
  }

  let status: AuctionCycleResult["status"];
  if (judged > 0 && insufficientCount === judged) {
    status = "insufficient";
  } else if (readyCount === judged && gaps.length === 0) {
    status = "success";
  } else if (readyCount === 0 && judged > 0) {
    status = insufficientCount === judged ? "insufficient" : "partial";
  } else {
    status = "partial";
  }
  if (judged === 0) status = "insufficient";

  return {
    trade_date: tradeDate,
    stage,
    sampled,
    judged,
    reminders,
    status,
    gaps: dedupe(gaps),
  };
}
