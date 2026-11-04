// 03 盘后关注池确定性引擎：环境判定 → 收盘打板/盘中梯队/低吸三源候选 → 过滤、共振、优先级 → 写关注池。
// 纯规则、无 LLM、无网络请求；只读 T 日及以前的数据，写表只走 repo.replaceWatchlist。
import type { TransactionDb } from "../../db/transaction.js";
import {
  queryLimitUpSignals,
  type LimitUpSignalCandidate,
} from "../market/limit-up-signals.js";
import { isTradeableStockCode } from "../market/tradeable.js";
import {
  evaluateUltraShortEnvironment,
  insufficientEnvironment,
  type EmotionRating,
  type UltraShortEnvironmentResult,
} from "./environment.js";
import { queryLowBuyShapes, type LowBuyShape } from "./low-buy.js";
import { attachQueuedPosition, replaceWatchlist } from "./repo.js";

import type {
  DataStatus,
  Db,
  ReviewStatus,
  RiskLevel,
  UltraShortAuctionExpect,
  UltraShortIntradayPlan,
  UltraShortKeyLevels,
  UltraShortPriority,
  UltraShortRiskTemplate,
  WatchlistDraft,
} from "./types.js";

/** 关注池规模与确定性初值（全部待回测）。 */
export const WATCHLIST_RULES = {
  theme_cap: 2, // 同一题材最多 2 只（待回测）
  board_stop_pct: 0.04, // 打板止损 4%（待回测）
  board_position_cap_pct: 30, // 打板单票仓位上限 30%（待回测）
  low_buy_position_cap_pct: 20, // 低吸单票仓位上限 20%（待回测）
  seal_healthy_ratio: 0.1, // 封单/成交额健康线 10%（待回测）
  priority_p1_score: 4, // P1 分数下限（待回测）
  priority_p2_score: 2, // P2 分数下限（待回测）
  max_p1: 2, // 单日 P1 上限，强核心只保留 1–2 只（待回测）
  risk_flag_high_count: 3, // 确定性初值：风险标记 ≥3 项标 high（待回测）
} as const;

/** 明显偏弱的风险标记关键词：命中后只降优先级，不直接剔除（关注池语义）。 */
const WEAK_RISK_KEYWORDS = [
  "偏弱", "曾开板", "梯队单薄", "持续性不足", "负反馈", "晋级率偏低", "放量弱封", "缺失", "不确定",
] as const;

const STAGE_LABELS: Record<"first_board" | "confirmation" | "high_board", string> = {
  first_board: "首板",
  confirmation: "二至三板",
  high_board: "高位板",
};

type BoardStage = "first_board" | "confirmation" | "high_board";
type CandidateStage = BoardStage | "low_buy";
type SignalGrade = "A" | "B-抱团" | "B-主升";

export interface PriorityInput {
  sources: string[];
  resonance: boolean;
  signal_grade: SignalGrade | null;
  selected: boolean;
  stage: CandidateStage | null;
  streak_count: number | null;
  main_theme: string | null;
  one_word: boolean | null;
  seal_turnover_ratio: number | null;
  pk_status: "review" | "observe_only" | "insufficient" | null;
  risk_flags: string[];
  low_buy_stage: "formed" | "pending" | null;
}

export interface PriorityResult {
  score: number;
  priority: UltraShortPriority;
  priority_reason: string;
}

/** P1 数量上限纯函数：入参已按分数降序，超出的 P1 降为 P2。 */
export function capP1Priority<T extends { priority: PriorityResult }>(items: T[], maxP1: number): T[] {
  let count = 0;
  return items.map((item) => {
    if (item.priority.priority !== "P1") return item;
    count += 1;
    if (count <= maxP1) return item;
    return {
      ...item,
      priority: {
        ...item.priority,
        priority: "P2" as UltraShortPriority,
        priority_reason: `${item.priority.priority_reason}；P1 数量上限，降为 P2`,
      },
    };
  });
}

/** 优先级纯函数：环境、共振、阶段/高度、封单/换手、断板/炸板、低吸形态一起决定 P1/P2/P3。 */
export function evaluateCandidatePriority(
  input: PriorityInput,
  environment: UltraShortEnvironmentResult,
): PriorityResult {
  let score = 0;
  const reasons: string[] = [];
  if (input.resonance) {
    score += 2;
    reasons.push("来源共振");
  }
  if (input.signal_grade === "A") {
    score += 2;
    reasons.push("收盘 A 级");
  } else if (input.signal_grade) {
    score += 1;
    reasons.push(`收盘 ${input.signal_grade}`);
  }
  if (input.selected) {
    score += 1;
    reasons.push("信号榜入选");
  }
  if (input.stage === "confirmation") {
    score += 1;
    reasons.push(STAGE_LABELS.confirmation);
  } else if (input.stage === "high_board") {
    score += 1;
    reasons.push(STAGE_LABELS.high_board);
  }
  if ((input.streak_count ?? 0) >= 4) {
    score += 1;
    reasons.push(`${input.streak_count} 板高度`);
  }
  if (input.pk_status === "review") {
    score += 1;
    reasons.push("封单数据可复核");
  } else if (input.pk_status === "observe_only") {
    reasons.push("封单偏弱仅观察");
  }
  if (input.seal_turnover_ratio !== null && input.seal_turnover_ratio >= WATCHLIST_RULES.seal_healthy_ratio) {
    score += 1;
    reasons.push("封单/成交额健康");
  }
  if (input.low_buy_stage === "formed") {
    score += 1;
    reasons.push("低吸形态成立");
  } else if (input.low_buy_stage === "pending") {
    score += -1;
    reasons.push("低吸形态待触发");
  }

  const rating: EmotionRating | null = environment.limit_up_emotion.rating;
  if (rating === "强") {
    score += 1;
    reasons.push("连板情绪强");
  } else if (rating === "弱") {
    score += -1;
    reasons.push("连板情绪弱");
  }
  const bias = environment.index_environment.bias;
  if (bias === "favorable") {
    score += 1;
    reasons.push("指数/广度利于抱团");
  } else if (bias === "dispersing") {
    score += -1;
    reasons.push("指数普涨分流");
  }
  const highest = environment.limit_up_emotion.highest_streak;
  const highCore = highest !== null && input.streak_count !== null && input.streak_count >= Math.max(1, highest - 1);
  if (environment.mainline_vacuum === true) {
    if (highCore) {
      score += 1;
      reasons.push("主线真空，高标抱团");
    }
  } else if (environment.mainline_vacuum === false && environment.mainline.top_theme !== null) {
    if (input.main_theme === environment.mainline.top_theme && input.main_theme !== null) {
      score += 1;
      reasons.push("主线核心");
    } else if (input.main_theme !== null) {
      score += -1;
      reasons.push("非主线核心");
    }
  }

  const weakFlags = input.risk_flags.filter((flag) => WEAK_RISK_KEYWORDS.some((keyword) => flag.includes(keyword)));
  if (weakFlags.length > 0) {
    const penalty = Math.min(2, weakFlags.length * 1);
    score -= penalty;
    reasons.push(`风险标记 ${weakFlags.length} 项`);
  }

  let priority: UltraShortPriority = score >= WATCHLIST_RULES.priority_p1_score
    ? "P1"
    : score >= WATCHLIST_RULES.priority_p2_score ? "P2" : "P3";
  // P1 必须“验证条件明确”：一字板成交不确定，不占 P1；有确定性风险标记的只给 P2。
  if (priority === "P1" && input.one_word === true) {
    priority = "P2";
    reasons.push("一字板成交不确定，P1 降为 P2");
  } else if (priority === "P1" && input.risk_flags.length > 0) {
    priority = "P2";
    reasons.push("存在确定性风险标记，P1 降为 P2");
  }
  return { score, priority, priority_reason: reasons.length ? reasons.join("；") : "常规关注候选" };
}

export interface SelectionCandidate {
  code: string;
  main_theme: string | null;
  score: number;
}

/**
 * 关注池挑选纯函数：按分数排序，同题材最多 theme_cap 只，总量不超过 total_cap。
 * 不做最小值补齐——没有合格标的就返回空池。
 */
export function selectWatchlistCandidates<T extends SelectionCandidate>(
  candidates: T[],
  options: { total_cap: number; theme_cap?: number },
): T[] {
  if (options.total_cap <= 0) return [];
  const themeCap = options.theme_cap ?? WATCHLIST_RULES.theme_cap;
  const sorted = [...candidates].sort((left, right) =>
    right.score - left.score || left.code.localeCompare(right.code));
  const themeCounts = new Map<string, number>();
  const selected: T[] = [];
  for (const candidate of sorted) {
    if (selected.length >= options.total_cap) break;
    const themeKey = candidate.main_theme ?? candidate.code;
    const count = themeCounts.get(themeKey) ?? 0;
    if (count >= themeCap) continue;
    themeCounts.set(themeKey, count + 1);
    selected.push(candidate);
  }
  return selected;
}

interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  amount: number | null;
  prev_close: number | null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function shanghaiDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

async function previousOpenDay(db: Db, date: string): Promise<string | null> {
  return (await db.query<{ date: string }>(
    `SELECT trade_date::text AS date FROM market_trading_day
      WHERE is_open AND trade_date < $1::date ORDER BY trade_date DESC LIMIT 1`,
    [date],
  )).rows[0]?.date ?? null;
}

async function nextOpenDay(db: Db, date: string): Promise<string | null> {
  return (await db.query<{ date: string }>(
    `SELECT trade_date::text AS date FROM market_trading_day
      WHERE is_open AND trade_date > $1::date ORDER BY trade_date ASC LIMIT 1`,
    [date],
  )).rows[0]?.date ?? null;
}

async function tradingDayInfo(db: Db, date: string): Promise<{ exists: boolean; is_open: boolean }> {
  const row = (await db.query<{ is_open: boolean }>(
    "SELECT is_open FROM market_trading_day WHERE trade_date = $1::date",
    [date],
  )).rows[0];
  return { exists: Boolean(row), is_open: row?.is_open === true };
}

export interface ResolvedDates {
  target_date: string;
  data_date: string;
}

/**
 * 解析关注日与数据日：dataDate 默认 targetDate 前一个交易日；targetDate 默认 dataDate 后一个交易日。
 * 只接受已同步的交易日，并拒绝数据日晚于当前上海日期（不使用未来数据）。
 */
export async function resolveUltraShortDates(
  db: Db,
  options: { targetDate?: string; dataDate?: string; now?: Date },
): Promise<{ dates: ResolvedDates | null; gaps: string[] }> {
  const gaps: string[] = [];
  if (!options.targetDate && !options.dataDate) {
    return { dates: null, gaps: ["必须提供 targetDate 或 dataDate"] };
  }
  let targetDate = options.targetDate ?? null;
  let dataDate = options.dataDate ?? null;
  if (!dataDate && targetDate) {
    dataDate = await previousOpenDay(db, targetDate);
    if (!dataDate) gaps.push(`目标日 ${targetDate} 之前没有可用交易日`);
  }
  if (!targetDate && dataDate) {
    targetDate = await nextOpenDay(db, dataDate);
    if (!targetDate) gaps.push(`数据日 ${dataDate} 之后没有可用交易日`);
  }
  if (!targetDate || !dataDate) return { dates: null, gaps };
  if (dataDate >= targetDate) {
    return { dates: null, gaps: [...gaps, "数据日必须早于关注日，拒绝使用未来数据"] };
  }
  const targetInfo = await tradingDayInfo(db, targetDate);
  if (!targetInfo.exists || !targetInfo.is_open) gaps.push(`关注日 ${targetDate} 不是交易日`);
  const dataInfo = await tradingDayInfo(db, dataDate);
  if (!dataInfo.exists || !dataInfo.is_open) gaps.push(`数据日 ${dataDate} 不是交易日`);
  if (gaps.length > 0) return { dates: null, gaps };
  const expectedDataDate = await previousOpenDay(db, targetDate);
  if (expectedDataDate !== dataDate) {
    gaps.push(`数据日 ${dataDate} 不是关注日 ${targetDate} 的上一交易日`);
  }
  const today = shanghaiDate(options.now ?? new Date());
  if (dataDate > today) {
    return { dates: null, gaps: [...gaps, `数据日 ${dataDate} 晚于当前上海日期 ${today}，拒绝用未来数据`] };
  }
  return { dates: { target_date: targetDate, data_date: dataDate }, gaps };
}

async function loadDailyBars(db: Db, codes: string[], dataDate: string): Promise<Map<string, DailyBar[]>> {
  if (codes.length === 0) return new Map();
  const rows = (await db.query<DailyBar & { code: string }>(
    `WITH ranked AS (
       SELECT instrument.code, bar.bar_date::text AS date,
              bar.open::float8 AS open, bar.high::float8 AS high, bar.low::float8 AS low,
              bar.close::float8 AS close, bar.volume::float8 AS volume, bar.turnover::float8 AS amount,
              COALESCE(bar.prev_close, previous.close)::float8 AS prev_close,
              row_number() OVER (PARTITION BY instrument.id ORDER BY bar.bar_date DESC) AS row_no
         FROM market_bar bar
         JOIN market_instrument instrument ON instrument.id = bar.instrument_id
         LEFT JOIN LATERAL (
           SELECT prior.close FROM market_bar prior
            WHERE prior.instrument_id = bar.instrument_id AND prior.freq = 'day'
              AND prior.bar_date < bar.bar_date
            ORDER BY prior.bar_date DESC LIMIT 1
         ) previous ON true
        WHERE instrument.code = ANY($1::text[]) AND bar.freq = 'day' AND bar.bar_date <= $2::date
     )
     SELECT code, date, open, high, low, close, volume, amount, prev_close
       FROM ranked WHERE row_no <= 25 ORDER BY code, date`,
    [codes, dataDate],
  )).rows;
  const byCode = new Map<string, DailyBar[]>();
  for (const row of rows) {
    const list = byCode.get(row.code) ?? [];
    list.push(row);
    byCode.set(row.code, list);
  }
  return byCode;
}

function buildBoardKeyLevels(bars: DailyBar[], gaps: string[]): UltraShortKeyLevels | null {
  const current = bars[bars.length - 1];
  const previous = bars[bars.length - 2];
  if (!current) return null;
  const closes = bars.map((bar) => bar.close);
  const ma5 = bars.length >= 5 ? average(closes.slice(-5)) : null;
  const ma10 = bars.length >= 10 ? average(closes.slice(-10)) : null;
  const ma20 = bars.length >= 20 ? average(closes.slice(-20)) : null;
  if (ma20 === null) gaps.push("MA20 缺失（日线不足 20 根）");
  const prevClose = current.prev_close ?? previous?.close ?? null;
  const limitUpPrice = prevClose !== null && prevClose > 0 ? round2(prevClose * 1.1) : null;
  const stop = round2(current.close * (1 - WATCHLIST_RULES.board_stop_pct));
  return {
    prev_close: prevClose === null ? null : round2(prevClose),
    limit_up_price: limitUpPrice,
    ma5: ma5 === null ? null : round2(ma5),
    ma10: ma10 === null ? null : round2(ma10),
    ma20: ma20 === null ? null : round2(ma20),
    pattern_low: previous ? round2(Math.min(current.low, previous.low)) : round2(current.low),
    breakout_price: limitUpPrice,
    invalidation_price: stop,
    stop_price: stop,
  };
}

function stageFromStreak(streak: number): BoardStage {
  if (streak <= 1) return "first_board";
  if (streak <= 3) return "confirmation";
  return "high_board";
}

function stageLabel(stage: CandidateStage | null): string | null {
  if (stage === null) return null;
  return stage === "low_buy" ? "低吸" : STAGE_LABELS[stage];
}

function boardAuctionExpect(input: {
  one_word: boolean | null;
  seal_turnover_ratio: number | null;
}): UltraShortAuctionExpect {
  if (input.one_word === true) {
    return { branch: "one_word", note: "T 日一字；竞价验未匹配与竞价换手，成交概率交 01 分档" };
  }
  if (input.seal_turnover_ratio !== null && input.seal_turnover_ratio >= WATCHLIST_RULES.seal_healthy_ratio) {
    return { branch: "turnover_advance", note: "封单/成交额健康；竞价验换手晋级与未匹配方向" };
  }
  return { branch: "turnover_advance", note: "竞价验换手晋级；封单偏弱或低开则降级" };
}

function boardIntradayPlan(keyLevels: UltraShortKeyLevels): UltraShortIntradayPlan {
  return {
    trigger: "turnover_advance",
    trigger_price: keyLevels.limit_up_price ?? null,
    invalidation_price: keyLevels.invalidation_price ?? null,
    note: "开盘 9:30–9:35 观察承接与换手；跌破失效位放弃，不追高",
  };
}

function boardRiskTemplate(): UltraShortRiskTemplate {
  return {
    stop_pct: WATCHLIST_RULES.board_stop_pct * 100,
    position_cap_pct: WATCHLIST_RULES.board_position_cap_pct,
    template: "打板接力：竞价/开盘确认后参与，跌破止损位或竞价走弱即失效",
  };
}

function lowBuyRiskTemplate(): UltraShortRiskTemplate {
  return {
    stop_pct: null,
    position_cap_pct: WATCHLIST_RULES.low_buy_position_cap_pct,
    template: "低吸形态：只在触发价附近低吸，不追高；跌破形态低点/均线支撑止损",
  };
}

function dataStatusRank(status: DataStatus): number {
  return status === "insufficient" ? 2 : status === "partial" ? 1 : 0;
}

function worstDataStatus(left: DataStatus, right: DataStatus): DataStatus {
  return dataStatusRank(left) >= dataStatusRank(right) ? left : right;
}

function pickSignalGrade(left: SignalGrade | null, right: SignalGrade | null): SignalGrade | null {
  if (left === "A" || right === "A") return "A";
  if (left || right) return left ?? right;
  return null;
}

interface CandidateFacts {
  code: string;
  name: string;
  sources: string[];
  tags: string[];
  stage: CandidateStage | null;
  streak_count: number | null;
  main_theme: string | null;
  signal_grade: SignalGrade | null;
  selected: boolean;
  one_word: boolean | null;
  seal_turnover_ratio: number | null;
  pk_status: "review" | "observe_only" | "insufficient" | null;
  low_buy_stage: "formed" | "pending" | null;
  t_facts: Record<string, unknown>;
  key_levels: UltraShortKeyLevels;
  auction_expect: UltraShortAuctionExpect;
  intraday_plan: UltraShortIntradayPlan;
  risk: UltraShortRiskTemplate;
  risk_flags: string[];
  gaps: string[];
  data_status: DataStatus;
}

function mergeCandidateFacts(map: Map<string, CandidateFacts>, incoming: CandidateFacts): void {
  const existing = map.get(incoming.code);
  if (!existing) {
    map.set(incoming.code, incoming);
    return;
  }
  existing.sources = unique([...existing.sources, ...incoming.sources]);
  existing.tags = unique([...existing.tags, ...incoming.tags]);
  existing.risk_flags = unique([...existing.risk_flags, ...incoming.risk_flags]);
  existing.gaps = unique([...existing.gaps, ...incoming.gaps]);
  existing.t_facts = { ...existing.t_facts, ...incoming.t_facts };
  existing.signal_grade = pickSignalGrade(existing.signal_grade, incoming.signal_grade);
  existing.selected = existing.selected || incoming.selected;
  existing.one_word = existing.one_word ?? incoming.one_word;
  existing.seal_turnover_ratio = existing.seal_turnover_ratio ?? incoming.seal_turnover_ratio;
  existing.pk_status = existing.pk_status === "review" ? existing.pk_status : incoming.pk_status ?? existing.pk_status;
  existing.low_buy_stage = existing.low_buy_stage ?? incoming.low_buy_stage;
  existing.streak_count = existing.streak_count ?? incoming.streak_count;
  existing.main_theme = existing.main_theme ?? incoming.main_theme;
  existing.data_status = worstDataStatus(existing.data_status, incoming.data_status);
}

async function collectPostCloseCandidates(
  db: Db,
  dataDate: string,
  gaps: string[],
): Promise<{ candidates: CandidateFacts[]; usable: boolean }> {
  const result = await queryLimitUpSignals(db, dataDate);
  gaps.push(...result.gaps);
  if (result.status === "unavailable") return { candidates: [], usable: false };
  const selectedCodes = new Set(result.signals.map((signal) => signal.code));
  const codes = result.candidates.map((candidate) => candidate.code);
  const barsByCode = await loadDailyBars(db, codes, dataDate);
  const candidates: CandidateFacts[] = [];
  let skipped = 0;
  for (const candidate of result.candidates) {
    if (!isTradeableStockCode(candidate.code)) {
      skipped += 1;
      continue;
    }
    if (candidate.data_status !== "ready" || candidate.pk?.status === "insufficient") {
      skipped += 1;
      continue;
    }
    const bars = barsByCode.get(candidate.code) ?? [];
    const current = bars[bars.length - 1];
    if (!current || current.date !== dataDate) {
      skipped += 1;
      continue;
    }
    const rowGaps: string[] = [];
    const keyLevels = buildBoardKeyLevels(bars, rowGaps);
    if (!keyLevels) {
      skipped += 1;
      continue;
    }
    candidates.push(buildPostCloseFacts(candidate, {
      selected: selectedCodes.has(candidate.code),
      keyLevels,
      bars,
      rowGaps,
    }));
  }
  if (skipped > 0) gaps.push(`收盘打板候选 ${skipped} 只因数据不足或非主板剔除`);
  return { candidates, usable: true };
}

function buildPostCloseFacts(
  candidate: LimitUpSignalCandidate,
  input: { selected: boolean; keyLevels: UltraShortKeyLevels; bars: DailyBar[]; rowGaps: string[] },
): CandidateFacts {
  const oneWord = candidate.pk?.one_word ?? null;
  const stage = candidate.pk?.stage ?? stageFromStreak(candidate.streak_count);
  // 一字板属于“成交不确定”，由 01 的成交概率档表达，不写成高风险标记。
  const riskFlags = [...candidate.risk_flags];
  if (candidate.streak_count >= 4) riskFlags.push("高位板，断板风险");
  if ((candidate.open_count ?? 0) > 0) riskFlags.push("T 日盘中曾开板");
  const dataStatus: DataStatus = input.rowGaps.length > 0 ? "partial" : "ready";
  return {
    code: candidate.code,
    name: candidate.name,
    sources: ["post_close"],
    tags: unique(["打板接力", ...(oneWord === true ? ["一字延续"] : []), STAGE_LABELS[stage]]),
    stage,
    streak_count: candidate.streak_count,
    main_theme: candidate.main_theme,
    signal_grade: candidate.signal_grade,
    selected: input.selected,
    one_word: oneWord,
    seal_turnover_ratio: candidate.pk?.seal_turnover_ratio ?? null,
    pk_status: candidate.pk?.status ?? null,
    low_buy_stage: null,
    t_facts: { main_theme: candidate.main_theme },
    key_levels: input.keyLevels,
    auction_expect: boardAuctionExpect({ one_word: oneWord, seal_turnover_ratio: candidate.pk?.seal_turnover_ratio ?? null }),
    intraday_plan: boardIntradayPlan(input.keyLevels),
    risk: boardRiskTemplate(),
    risk_flags: unique(riskFlags),
    gaps: input.rowGaps,
    data_status: dataStatus,
  };
}

interface IntradaySnapshotRow {
  code?: unknown;
  name?: unknown;
  streak_count?: unknown;
  main_theme?: unknown;
  ladder_role?: unknown;
  theme_width_1045?: unknown;
  seal_money?: unknown;
  seal_retention?: unknown;
  auction_pct?: unknown;
  auction_strength?: unknown;
  current_price?: unknown;
  one_word?: unknown;
  eligible?: unknown;
  execution_risk?: unknown;
  limit_minute?: unknown;
  pk?: { stage?: unknown; status?: unknown; one_word?: unknown; flags?: unknown } | null;
  evidence?: Record<string, unknown>;
  invalidation?: unknown;
}


function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function loadIntradaySnapshot(
  db: Db,
  dataDate: string,
  gaps: string[],
): Promise<{ candidates: IntradaySnapshotRow[]; signalCodes: Set<string>; found: boolean }> {
  const row = (await db.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM first_board_intraday_snapshot
      WHERE scan_date = $1::date ORDER BY captured_at DESC, id DESC LIMIT 1`,
    [dataDate],
  )).rows[0];
  if (!row) {
    gaps.push("T 日盘中梯队快照缺失，未纳入盘中打板候选");
    return { candidates: [], signalCodes: new Set(), found: false };
  }
  const candidates = Array.isArray(row.payload.candidates) ? row.payload.candidates as IntradaySnapshotRow[] : [];
  const signals = Array.isArray(row.payload.signals) ? row.payload.signals as IntradaySnapshotRow[] : [];
  const payloadGaps = Array.isArray(row.payload.gaps) ? row.payload.gaps.map(String) : [];
  gaps.push(...payloadGaps.map((item) => `盘中快照：${item}`));
  if (candidates.length === 0) gaps.push("盘中梯队快照没有候选");
  const signalCodes = new Set(signals
    .map((signal) => toText(signal.code))
    .filter((code): code is string => code !== null));
  return { candidates, signalCodes, found: true };
}

async function collectIntradayCandidates(
  db: Db,
  dataDate: string,
  closingCodes: Set<string>,
  gaps: string[],
): Promise<{ candidates: CandidateFacts[]; usable: boolean }> {
  const snapshot = await loadIntradaySnapshot(db, dataDate, gaps);
  if (!snapshot.found) return { candidates: [], usable: false };
  const usableRows = snapshot.candidates.filter((row) => {
    const code = toText(row.code);
    if (!code) return false;
    const status = toText(row.pk?.status);
    const eligible = row.eligible !== false;
    // 盘中观察级标的只有在与收盘候选共振时纳入，避免把弱标的当凑数候选。
    return eligible && status !== "insufficient" && (status === "review" || closingCodes.has(code));
  });
  const codes = usableRows
    .map((row) => toText(row.code))
    .filter((code): code is string => code !== null);
  if (codes.length === 0) return { candidates: [], usable: true };
  const barsByCode = await loadDailyBars(db, codes, dataDate);
  const candidates: CandidateFacts[] = [];
  let skipped = 0;
  for (const row of usableRows) {
    const code = toText(row.code);
    if (!code) continue;
    const name = toText(row.name) ?? code;
    if (!isTradeableStockCode(code) || /^(?:\*?ST|S\*ST)/iu.test(name.trim())) {
      skipped += 1;
      continue;
    }
    const bars = barsByCode.get(code) ?? [];
    const current = bars[bars.length - 1];
    if (!current || current.date !== dataDate) {
      skipped += 1;
      continue;
    }
    const rowGaps: string[] = [];
    const keyLevels = buildBoardKeyLevels(bars, rowGaps);
    if (!keyLevels) {
      skipped += 1;
      continue;
    }
    const streakCount = toNumber(row.streak_count) ?? 1;
    const stage = stageFromStreak(streakCount);
    const pkStatus = toText(row.pk?.status);
    const oneWord = typeof row.one_word === "boolean" ? row.one_word
      : typeof row.pk?.one_word === "boolean" ? row.pk.one_word : null;
    const pkFlags = Array.isArray(row.pk?.flags) ? row.pk.flags.map(String) : [];
    const riskFlags = [...pkFlags];
    if (pkStatus === "observe_only") riskFlags.push("盘中封单偏弱，仅观察");
    if (streakCount >= 4) riskFlags.push("高位板，断板风险");
    const theme = toText(row.main_theme);
    candidates.push({
      code,
      name,
      sources: ["intraday_ladder"],
      tags: unique(["盘中梯队", ...(oneWord === true ? ["一字延续"] : []), STAGE_LABELS[stage]]),
      stage,
      streak_count: streakCount,
      main_theme: theme,
      signal_grade: snapshot.signalCodes.has(code) ? "B-主升" : null,
      selected: snapshot.signalCodes.has(code),
      one_word: oneWord,
      seal_turnover_ratio: null,
      pk_status: pkStatus === "review" || pkStatus === "observe_only" ? pkStatus : null,
      low_buy_stage: null,
      t_facts: { main_theme: theme },
      key_levels: keyLevels,
      auction_expect: boardAuctionExpect({ one_word: oneWord, seal_turnover_ratio: null }),
      intraday_plan: boardIntradayPlan(keyLevels),
      risk: boardRiskTemplate(),
      risk_flags: unique(riskFlags),
      gaps: rowGaps,
      data_status: rowGaps.length > 0 ? "partial" : "ready",
    });
  }
  if (skipped > 0) gaps.push(`盘中梯队候选 ${skipped} 只因数据不足或权限剔除`);
  return { candidates, usable: true };
}

function lowBuyFacts(shape: LowBuyShape): CandidateFacts {
  const riskFlags = ["低吸形态，触发前不追高"];
  if (shape.stage === "pending") riskFlags.push("低吸形态待触发");
  return {
    code: shape.code,
    name: shape.name,
    sources: ["low_buy"],
    tags: shape.tags,
    stage: "low_buy",
    streak_count: null,
    main_theme: shape.main_theme,
    signal_grade: null,
    selected: false,
    one_word: null,
    seal_turnover_ratio: null,
    pk_status: null,
    low_buy_stage: shape.stage,
    t_facts: { main_theme: shape.main_theme },
    key_levels: shape.key_levels,
    auction_expect: { branch: "low_open", note: "低吸形态：竞价低开分歧观察承接，不追高" },
    intraday_plan: shape.plan,
    risk: lowBuyRiskTemplate(),
    risk_flags: riskFlags,
    gaps: shape.gaps,
    data_status: shape.gaps.length > 0 ? "partial" : "ready",
  };
}

function toWatchlistDraft(candidate: CandidateFacts, priority: PriorityResult): WatchlistDraft {
  const baseRisk: RiskLevel = candidate.risk_flags.length >= WATCHLIST_RULES.risk_flag_high_count
    ? "high"
    : candidate.risk_flags.length > 0 ? "medium" : "low";
  // 一字板不是 high 风险：成交不确定由 01 竞价分档表达，避免与“一字延续可提醒买入”冲突。
  const riskLevel: RiskLevel = candidate.one_word === true && baseRisk === "high" ? "medium" : baseRisk;
  const reviewStatus: ReviewStatus = riskLevel === "high" ? "flag" : "pass";
  return {
    code: candidate.code,
    name: candidate.name,
    sources: candidate.sources,
    tags: candidate.tags,
    resonance: candidate.sources.length >= 2,
    priority: priority.priority,
    priority_reason: priority.priority_reason,
    stage: stageLabel(candidate.stage),
    streak_count: candidate.streak_count,
    t_facts: candidate.t_facts,
    key_levels: candidate.key_levels,
    auction_expect: candidate.auction_expect,
    intraday_plan: candidate.intraday_plan,
    risk: candidate.risk,
    review_status: reviewStatus,
    risk_level: riskLevel,
    risk_flags: candidate.risk_flags,
    review_note: null,
    gaps: candidate.gaps,
    data_status: candidate.data_status,
  };
}

export interface UltraShortWatchlistBuildOptions {
  targetDate?: string;
  dataDate?: string;
  /** 仅用于“不使用未来数据”校验，不参与任何行情读取。 */
  now?: Date;
}

export interface UltraShortWatchlistBuildResult {
  target_date: string;
  data_date: string;
  status: "success" | "partial" | "unavailable";
  environment: UltraShortEnvironmentResult;
  rows: WatchlistDraft[];
  gaps: string[];
}

/**
 * 03 关注池构建入口：
 * 1) 解析 targetDate/dataDate；2) 评估环境；3) 取收盘打板、盘中梯队、低吸三源候选；
 * 4) 按代码合并、过滤、共振、优先级、同题材最多 2 只、总量按环境收缩；5) 写关注池。
 */
export async function buildUltraShortWatchlist(
  db: TransactionDb,
  options: UltraShortWatchlistBuildOptions = {},
): Promise<UltraShortWatchlistBuildResult> {
  const resolution = await resolveUltraShortDates(db, options);
  if (!resolution.dates) {
    const fallbackDate = options.dataDate ?? options.targetDate ?? "";
    return {
      target_date: options.targetDate ?? "",
      data_date: fallbackDate,
      status: "unavailable",
      environment: insufficientEnvironment(fallbackDate, resolution.gaps),
      rows: [],
      gaps: resolution.gaps,
    };
  }
  const { target_date, data_date } = resolution.dates;
  const environment = await evaluateUltraShortEnvironment(db, data_date);
  const gaps: string[] = [...resolution.gaps, ...environment.gaps];

  const postClose = await collectPostCloseCandidates(db, data_date, gaps);
  const closingCodes = new Set(postClose.candidates.map((candidate) => candidate.code));
  const intraday = await collectIntradayCandidates(db, data_date, closingCodes, gaps);
  const lowBuy = await queryLowBuyShapes(db, data_date);
  gaps.push(...lowBuy.gaps);

  const merged = new Map<string, CandidateFacts>();
  for (const candidate of postClose.candidates) mergeCandidateFacts(merged, candidate);
  for (const candidate of intraday.candidates) mergeCandidateFacts(merged, candidate);
  for (const shape of lowBuy.shapes) mergeCandidateFacts(merged, lowBuyFacts(shape));

  const scored = [...merged.values()]
    .filter((candidate) => candidate.data_status !== "insufficient")
    .map((candidate) => ({
      candidate,
      priority: evaluateCandidatePriority({
        sources: candidate.sources,
        resonance: candidate.sources.length >= 2,
        signal_grade: candidate.signal_grade,
        selected: candidate.selected,
        stage: candidate.stage,
        streak_count: candidate.streak_count,
        main_theme: candidate.main_theme,
        one_word: candidate.one_word,
        seal_turnover_ratio: candidate.seal_turnover_ratio,
        pk_status: candidate.pk_status,
        risk_flags: candidate.risk_flags,
        low_buy_stage: candidate.low_buy_stage,
      }, environment),
    }));
  const selected = selectWatchlistCandidates(
    scored.map((item) => ({
      code: item.candidate.code,
      main_theme: item.candidate.main_theme,
      score: item.priority.score,
      candidate: item.candidate,
      priority: item.priority,
    })),
    { total_cap: environment.pool_cap.max, theme_cap: WATCHLIST_RULES.theme_cap },
  );
  const capped = capP1Priority(selected, WATCHLIST_RULES.max_p1);
  const rows = capped.map((item) => toWatchlistDraft(item.candidate, item.priority));

  const uniqueGaps = unique(gaps);
  const usableSources = postClose.usable || intraday.usable || lowBuy.shapes.length > 0;
  if (!usableSources) {
    // 三源都不可用时清空该目标日旧行，避免重跑失败后页面继续展示过期候选。
    await replaceWatchlist(db, target_date, data_date, []);
    return {
      target_date,
      data_date,
      status: "unavailable",
      environment,
      rows: [],
      gaps: uniqueGaps,
    };
  }
  await replaceWatchlist(db, target_date, data_date, rows);
  // 02 在 T 日排队成交的持仓，T+1 关注池生成时补上入场价，交给 05 快速层管理退出。
  await attachQueuedPosition(db, target_date, data_date);
  const partial = uniqueGaps.length > 0 || environment.data_status !== "ready";
  return {
    target_date,
    data_date,
    status: partial ? "partial" : "success",
    environment,
    rows,
    gaps: uniqueGaps,
  };
}

// 03 关注池的提示词摘要：只把服务端已写入的结构化事实压缩成可复核文本。
function renderNum(value: unknown): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "—";
}
function renderRatio(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}
const RENDER_SOURCE_LABELS: Record<string, string> = {
  post_close: "收盘打板", intraday_ladder: "盘中梯队", low_buy: "低吸",
};
function renderWatchlistRow(row: WatchlistDraft): string {
  const key = row.key_levels;
  const auction = row.auction_expect;
  const plan = row.intraday_plan;
  return [
    `- ${row.name}（${row.code}）｜${row.priority}｜${row.stage ?? "阶段待核"}${row.streak_count ? ` ${row.streak_count} 板` : ""}${row.resonance ? "｜共振" : ""}`,
    `  来源：${row.sources.map((source) => RENDER_SOURCE_LABELS[source] ?? source).join(" + ") || "—"}｜标签：${row.tags.join("、") || "—"}`,
    `  关键价位：前收 ${renderNum(key.prev_close)} / 涨停 ${renderNum(key.limit_up_price)} / 止损 ${renderNum(key.stop_price)} / 失效 ${renderNum(key.invalidation_price)}`,
    `  竞价预期：${auction.branch ?? "待判定"}${auction.note ? `（${auction.note}）` : ""}`,
    `  盘中计划：${plan.trigger ?? "none"}${plan.trigger_price ? ` @ ${renderNum(plan.trigger_price)}` : ""}${plan.note ? `（${plan.note}）` : ""}`,
    `  优先级理由：${row.priority_reason || "—"}`,
    row.risk_flags.length ? `  风险初值：${row.risk_flags.join("、")}` : "",
  ].filter(Boolean).join("\n");
}
export function renderUltraShortWatchlist(result: UltraShortWatchlistBuildResult): string {
  const env = result.environment;
  const lines = [
    `数据日 ${result.data_date} → 关注日 ${result.target_date}｜状态 ${result.status}`,
    `环境：连板情绪 ${env.limit_up_emotion.rating ?? "待核"}（最高 ${env.limit_up_emotion.highest_streak ?? "—"} 板，炸板率 ${renderRatio(env.limit_up_emotion.break_rate)}）`
      + `｜指数 ${env.index_environment.bias}｜MA20 下方 ${renderRatio(env.low_position_spread.below_ma20_ratio)}`
      + `｜主线真空 ${env.mainline_vacuum === null ? "待核" : env.mainline_vacuum ? "是" : "否"}`
      + `｜系统性风险 ${env.systemic_risk === null ? "待核" : env.systemic_risk ? "是" : "否"}`
      + `｜池上限 ${env.pool_cap.min}–${env.pool_cap.max}`,
    "",
  ];
  if (result.rows.length === 0) lines.push("关注池为空：没有合格候选，空池是有效结论。");
  else lines.push(...result.rows.map(renderWatchlistRow));
  if (result.gaps.length > 0) lines.push("", `数据缺口：${result.gaps.join("；")}`);
  return lines.join("\n");
}
