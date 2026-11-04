// 03 盘后研判的环境判定：连板情绪、指数环境、低位扩散度、主线真空与关注池规模。
// 只读 PostgreSQL，不联网、不调用 LLM；所有阈值具名并标注“待回测”，数据不足时写 gaps，不猜结论。
import { cleanLimitUpThemes } from "../market/limit-up-signals.js";
import type { DataStatus, Db } from "./types.js";

export const CORE_INDEX_CODES = ["000001.SH", "000300.SH", "000905.SH", "000852.SH"] as const;
const LARGE_CAP_INDEX = "000300.SH";
const MARKET_PROXY_INDEX = "000001.SH";
/** 指数环境统计窗口：当日 + 近 3 日涨跌 + 5 日均成交额。 */
const INDEX_LOOKBACK_BARS = 6;
/** 低位扩散度样本下限：MA20 覆盖不足 60% 时标注缺口。 */
const BREADTH_MA_COVERAGE_MIN = 0.6;
/** 沪深主板个股正则：与 server/modules/market/tradeable.ts 同一交易权限口径。 */
const MAIN_BOARD_REGEX = "^(600|601|603|605|000|001|002|003)[0-9]{3}[.](SH|SZ)$";

// 连板情绪阈值（待回测）
export const EMOTION_THRESHOLDS = {
  highest_strong: 5,
  highest_mid: 3,
  highest_weak: 2,
  limit_up_strong: 60,
  limit_up_mid: 40,
  limit_up_weak: 25,
  break_rate_strong: 0.25,
  break_rate_weak: 0.45,
  premium_strong: 2,
  premium_weak: -1,
} as const;

// 指数环境/低位扩散阈值（待回测）
export const INDEX_ENV_THRESHOLDS = {
  dispersing_advancing_ratio: 0.6,
  dispersing_below_ma20_ratio: 0.35,
  favorable_advancing_ratio: 0.45,
  amount_shrink_ratio: 0.9,
  amount_expand_ratio: 1.1,
} as const;

// 系统性风险阈值（待回测）
export const SYSTEMIC_RISK_THRESHOLDS = {
  index_pct_1d: -2,
  advancing_ratio: 0.25,
  amount_expand_ratio: 1.1,
  limit_down_count: 40,
} as const;

// 主线真空阈值（待回测）
export const MAINLINE_THRESHOLDS = {
  max_themes: 3,
  top_theme_share: 0.5,
} as const;

/** 关注池规模：系统性风险归零，其余按连板情绪为主、指数/主线为辅（03 文档 §3.4）。 */
export const POOL_CAP_RULES = {
  strong_best: { min: 4, max: 6 },
  strong_adjusted: { min: 3, max: 5 },
  mid: { min: 2, max: 4 },
  weak: { min: 2, max: 3 },
  systemic: { min: 0, max: 0 },
} as const;

export type EmotionRating = "强" | "中" | "弱";
export type IndexBias = "favorable" | "neutral" | "dispersing" | "systemic_risk" | "unknown";

export interface LimitUpEmotion {
  rating: EmotionRating | null;
  highest_streak: number | null;
  limit_up_count: number | null;
  limit_break_count: number | null;
  limit_down_count: number | null;
  break_rate: number | null;
  /** 昨日涨停今日溢价中位数（%），只用 T 日收盘价与 T-1 涨停事实。 */
  yesterday_limit_up_premium: number | null;
  gaps: string[];
}

interface IndexRow {
  code: string;
  pct_1d: number | null;
  amount_ratio_5d: number | null;
}

export interface IndexEnvironment {
  /** 主指数（优先上证指数）当日涨跌，用于系统性风险判断。 */
  market_pct_1d: number | null;
  /** 可用指数成交额 5 日比的中位数；>1 为放量。 */
  amount_ratio_5d: number | null;
  bias: IndexBias;
  gaps: string[];
}

export interface LowPositionSpread {
  stock_count: number;
  below_ma20_ratio: number | null;
  below_ma60_ratio: number | null;
  advancing_ratio: number | null;
  /** 首板股中收盘仍低于 MA20 的占比：低位首板扩散度。 */
  low_first_board_ratio: number | null;
  gaps: string[];
}

export interface MainlineState {
  top_theme: string | null;
  mainline_vacuum: boolean | null;
  gaps: string[];
}

export interface UltraShortEnvironmentResult {
  data_date: string;
  data_status: DataStatus;
  limit_up_emotion: LimitUpEmotion;
  index_environment: IndexEnvironment;
  low_position_spread: LowPositionSpread;
  mainline: MainlineState;
  systemic_risk: boolean | null;
  mainline_vacuum: boolean | null;
  pool_cap: { min: number; max: number };
  gaps: string[];
}


interface LimitEventRow {
  date: string;
  event_type: "up" | "down" | "break";
  streak_count: number | null;
  reason: string | null;
  industry_name: string | null;
  is_st: boolean | null;
  is_new: boolean | null;
  code: string;
  name: string;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

function median(values: number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function isMainBoardEvent(event: LimitEventRow): boolean {
  return /^(?:600|601|603|605|000|001|002|003)\d{3}\.(?:SH|SZ)$/u.test(event.code)
    && event.is_st === false && event.is_new === false
    && !/^(?:\*?ST|S\*ST)/iu.test(event.name.trim());
}

async function previousOpenDay(db: Db, date: string): Promise<{ date: string | null; gap: string | null }> {
  const row = (await db.query<{ date: string }>(
    `SELECT trade_date::text AS date FROM market_trading_day
      WHERE is_open AND trade_date < $1::date ORDER BY trade_date DESC LIMIT 1`,
    [date],
  )).rows[0];
  if (row) return { date: row.date, gap: null };
  const fallback = (await db.query<{ date: string | null }>(
    "SELECT max(trade_date)::text AS date FROM market_limit_event WHERE trade_date < $1::date",
    [date],
  )).rows[0];
  return { date: fallback?.date ?? null, gap: fallback?.date ? "交易日历缺失，上一交易日按涨停事件回推" : null };
}

async function loadEvents(db: Db, startDate: string, endDate: string): Promise<LimitEventRow[]> {
  return (await db.query<LimitEventRow>(
    `SELECT event.trade_date::text AS date, event.event_type, event.streak_count,
            event.reason, event.industry_name, event.is_st, event.is_new,
            instrument.code, instrument.name
       FROM market_limit_event event
       JOIN market_instrument instrument ON instrument.id = event.instrument_id
      WHERE event.trade_date BETWEEN $1::date AND $2::date
      ORDER BY event.trade_date, event.event_type, instrument.code`,
    [startDate, endDate],
  )).rows;
}

async function loadSpecialSyncReadiness(db: Db, date: string): Promise<Map<string, string>> {
  const rows = (await db.query<{ dataset: string; status: string }>(
    `SELECT DISTINCT ON (dataset) dataset, status FROM market_special_sync_run
      WHERE target_date = $1::date AND dataset IN ('limit_up','limit_break','limit_down')
      ORDER BY dataset, id DESC`,
    [date],
  )).rows;
  return new Map(rows.map((row) => [row.dataset, row.status]));
}

/** 连板情绪纯函数：只按已有分项打分，缺项写 gaps，不补造。 */
export function classifyLimitUpEmotion(input: {
  highest_streak: number | null;
  limit_up_count: number | null;
  break_rate: number | null;
  yesterday_limit_up_premium: number | null;
}): { rating: EmotionRating | null; gaps: string[] } {
  const score = { value: 0, used: 0 };
  const gaps: string[] = [];
  const { highest_streak, limit_up_count, break_rate, yesterday_limit_up_premium } = input;
  if (highest_streak !== null) {
    score.used += 1;
    if (highest_streak >= EMOTION_THRESHOLDS.highest_strong) {
      score.value += 2;
    } else if (highest_streak >= EMOTION_THRESHOLDS.highest_mid) {
      score.value += 1;
    } else if (highest_streak <= EMOTION_THRESHOLDS.highest_weak) {
      score.value -= 1;
    }
  } else {
    gaps.push("最高板缺失");
  }
  if (limit_up_count !== null) {
    score.used += 1;
    if (limit_up_count >= EMOTION_THRESHOLDS.limit_up_strong) {
      score.value += 2;
    } else if (limit_up_count >= EMOTION_THRESHOLDS.limit_up_mid) {
      score.value += 1;
    } else if (limit_up_count <= EMOTION_THRESHOLDS.limit_up_weak) {
      score.value -= 1;
    }
  } else {
    gaps.push("涨停家数缺失");
  }
  if (break_rate !== null) {
    score.used += 1;
    if (break_rate <= EMOTION_THRESHOLDS.break_rate_strong) {
      score.value += 1;
    } else if (break_rate >= EMOTION_THRESHOLDS.break_rate_weak) {
      score.value -= 2;
    } else {
    }
  } else {
    gaps.push("炸板率缺失，无法完整判定承接");
  }
  if (yesterday_limit_up_premium !== null) {
    score.used += 1;
    if (yesterday_limit_up_premium >= EMOTION_THRESHOLDS.premium_strong) {
      score.value += 1;
    } else if (yesterday_limit_up_premium <= EMOTION_THRESHOLDS.premium_weak) {
      score.value -= 1;
    } else {
    }
  } else {
    gaps.push("昨日涨停今日溢价缺失");
  }
  if (score.used < 2) return { rating: null, gaps };
  const rating: EmotionRating = score.value >= 3 ? "强" : score.value >= 0 ? "中" : "弱";
  return { rating, gaps };
}

/** 指数/广度倾向纯函数：普涨扩散偏负面（资金分流），缩量集中偏正面（资金回流抱团）。 */
export function classifyIndexBias(input: {
  systemic_risk: boolean | null;
  advancing_ratio: number | null;
  below_ma20_ratio: number | null;
  amount_ratio_5d: number | null;
  mainline_vacuum: boolean | null;
}): IndexBias {
  if (input.systemic_risk === true) return "systemic_risk";
  const { advancing_ratio, below_ma20_ratio, amount_ratio_5d, mainline_vacuum } = input;
  if (advancing_ratio === null && amount_ratio_5d === null) return "unknown";
  const dispersing = advancing_ratio !== null
    && advancing_ratio >= INDEX_ENV_THRESHOLDS.dispersing_advancing_ratio
    && (below_ma20_ratio === null || below_ma20_ratio >= INDEX_ENV_THRESHOLDS.dispersing_below_ma20_ratio)
    && (amount_ratio_5d === null || amount_ratio_5d >= INDEX_ENV_THRESHOLDS.amount_expand_ratio);
  if (dispersing) return "dispersing";
  const shrink = amount_ratio_5d !== null && amount_ratio_5d <= INDEX_ENV_THRESHOLDS.amount_shrink_ratio;
  const weakBreadth = advancing_ratio !== null && advancing_ratio <= INDEX_ENV_THRESHOLDS.favorable_advancing_ratio;
  if (weakBreadth || (shrink && mainline_vacuum === true)) return "favorable";
  return "neutral";
}

export function classifySystemicRisk(input: {
  market_pct_1d: number | null;
  amount_ratio_5d: number | null;
  advancing_ratio: number | null;
  limit_down_count: number | null;
}): { risk: boolean | null; gaps: string[] } {
  const gaps: string[] = [];
  const { market_pct_1d, amount_ratio_5d, advancing_ratio, limit_down_count } = input;
  if (limit_down_count !== null && limit_down_count >= SYSTEMIC_RISK_THRESHOLDS.limit_down_count) {
    return { risk: true, gaps };
  }
  if (market_pct_1d !== null && advancing_ratio !== null && amount_ratio_5d !== null) {
    const crash = market_pct_1d <= SYSTEMIC_RISK_THRESHOLDS.index_pct_1d
      && advancing_ratio <= SYSTEMIC_RISK_THRESHOLDS.advancing_ratio
      && amount_ratio_5d >= SYSTEMIC_RISK_THRESHOLDS.amount_expand_ratio;
    if (crash) {
      return { risk: true, gaps };
    }
    return { risk: false, gaps };
  }
  if (limit_down_count === null) gaps.push("跌停家数未同步，跌停潮无法核验");
  if (market_pct_1d === null) gaps.push("主指数当日涨跌缺失，系统性风险无法完整核验");
  if (advancing_ratio === null) gaps.push("上涨家数缺失，放量普跌无法核验");
  return { risk: null, gaps };
}

export function classifyMainlineVacuum(input: {
  theme_count: number | null;
  top_theme_share: number | null;
}): { mainline_vacuum: boolean | null; gaps: string[] } {
  const { theme_count, top_theme_share } = input;
  if (theme_count === null || top_theme_share === null) {
    return { mainline_vacuum: null, gaps: ["涨停题材归属不足，主线真空待核"] };
  }
  const vacuum = theme_count <= MAINLINE_THRESHOLDS.max_themes
    && top_theme_share >= MAINLINE_THRESHOLDS.top_theme_share;
  return { mainline_vacuum: vacuum, gaps: [] };
}

/** 关注池规模纯函数：连板情绪优先，指数只调节规模；系统性风险一票否决。 */
export function resolvePoolCap(input: {
  rating: EmotionRating | null;
  index_bias: IndexBias;
  systemic_risk: boolean | null;
  mainline_vacuum: boolean | null;
}): { min: number; max: number } {
  if (input.systemic_risk === true) {
    return { ...POOL_CAP_RULES.systemic };
  }
  if (input.rating === "强") {
    if (input.index_bias === "favorable") {
      return { ...POOL_CAP_RULES.strong_best };
    }
    return { ...POOL_CAP_RULES.strong_adjusted };
  }
  if (input.rating === "中") {
    return { ...POOL_CAP_RULES.mid };
  }
  if (input.rating === "弱") {
    return { ...POOL_CAP_RULES.weak };
  }
  return { ...POOL_CAP_RULES.weak };
}

async function evaluateLimitUpEmotion(
  db: Db,
  dataDate: string,
  previousDate: string | null,
  gaps: string[],
): Promise<LimitUpEmotion> {
  const startDate = previousDate ?? dataDate;
  const events = await loadEvents(db, startDate, dataDate);
  const current = events.filter((event) => event.date === dataDate);
  const previous = previousDate ? events.filter((event) => event.date === previousDate) : [];
  const sync = await loadSpecialSyncReadiness(db, dataDate);
  const localGaps: string[] = [];

  const upEvents = current.filter((event) => event.event_type === "up");
  const heightEvents = upEvents.filter(isMainBoardEvent);
  const highestStreak = heightEvents.length
    ? Math.max(...heightEvents.map((event) => event.streak_count ?? 0))
    : upEvents.length ? 0 : null;

  const limitUpReady = upEvents.length > 0 || sync.get("limit_up") === "success";
  const limitUpCount = limitUpReady ? upEvents.length : null;
  if (!limitUpReady) localGaps.push("T 日涨停池未同步");
  const breakReady = sync.get("limit_break") === "success";
  const limitBreakCount = breakReady ? current.filter((event) => event.event_type === "break").length : null;
  if (!breakReady) localGaps.push("炸板池未同步，炸板率待核实");
  const downReady = sync.get("limit_down") === "success";
  const limitDownCount = downReady ? current.filter((event) => event.event_type === "down").length : null;
  if (!downReady) localGaps.push("跌停池未同步，负反馈待核实");
  const breakRate = limitBreakCount === null || limitUpCount === null
    ? null
    : ratio(limitBreakCount, limitUpCount + limitBreakCount);


  // 昨日涨停今日溢价：只用前一交易日涨停事实与 T 日已收盘价，不使用任何未来数据。
  const premiumCodes = previous.filter((event) => event.event_type === "up" && isMainBoardEvent(event)).map((event) => event.code);
  let premium: number | null = null;
  if (premiumCodes.length === 0) {
    if (!previousDate) localGaps.push("上一交易日缺失，昨日涨停溢价无法计算");
  } else {
    const bars = (await db.query<{ code: string; close: number | null; prev_close: number | null }>(
      `SELECT instrument.code, bar.close::float8 AS close,
              COALESCE(bar.prev_close, previous.close)::float8 AS prev_close
         FROM market_bar bar
         JOIN market_instrument instrument ON instrument.id = bar.instrument_id
         LEFT JOIN LATERAL (
           SELECT prior.close FROM market_bar prior
            WHERE prior.instrument_id = bar.instrument_id AND prior.freq = 'day'
              AND prior.bar_date < bar.bar_date
            ORDER BY prior.bar_date DESC LIMIT 1
         ) previous ON true
        WHERE bar.freq = 'day' AND bar.bar_date = $1::date AND instrument.code = ANY($2::text[])`,
      [dataDate, premiumCodes],
    )).rows;
    const changes = bars
      .filter((bar) => bar.close !== null && bar.prev_close !== null && bar.prev_close > 0)
      .map((bar) => ((bar.close as number) / (bar.prev_close as number) - 1) * 100);
    premium = median(changes);
    if (premium === null) localGaps.push("昨日涨停股 T 日行情缺失，溢价无法计算");
  }

  const classified = classifyLimitUpEmotion({
    highest_streak: highestStreak,
    limit_up_count: limitUpCount,
    break_rate: breakRate,
    yesterday_limit_up_premium: premium,
  });
  localGaps.push(...classified.gaps);
  gaps.push(...localGaps);
  return {
    rating: classified.rating,
    highest_streak: highestStreak,
    limit_up_count: limitUpCount,
    limit_break_count: limitBreakCount,
    limit_down_count: limitDownCount,
    break_rate: breakRate === null ? null : round(breakRate, 4),
    yesterday_limit_up_premium: premium === null ? null : round(premium, 2),
    gaps: localGaps,
  };
}

async function evaluateIndexEnvironment(db: Db, dataDate: string, gaps: string[]): Promise<IndexEnvironment> {
  const rows = (await db.query<{
    code: string; name: string; date: string; close: number | null; amount: number | null;
  }>(
    `SELECT instrument.code, instrument.name, bar.bar_date::text AS date,
            bar.close::float8 AS close, bar.turnover::float8 AS amount
       FROM market_bar bar
       JOIN market_instrument instrument ON instrument.id = bar.instrument_id
      WHERE instrument.code = ANY($1::text[]) AND instrument.kind = 'index' AND bar.freq = 'day'
        AND bar.bar_date <= $2::date
      ORDER BY instrument.code, bar.bar_date DESC`,
    [[...CORE_INDEX_CODES], dataDate],
  )).rows;
  const localGaps: string[] = [];
  const byCode = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byCode.get(row.code) ?? [];
    if (list.length < INDEX_LOOKBACK_BARS) list.push(row);
    byCode.set(row.code, list);
  }
  const indices: IndexRow[] = [];
  for (const code of CORE_INDEX_CODES) {
    const series = (byCode.get(code) ?? []).slice(0, INDEX_LOOKBACK_BARS);
    const latest = series[0];
    if (!latest) {
      localGaps.push(`指数 ${code} 日线缺失`);
      continue;
    }
    const oneDayAgo = series[1];
    const pct1d = latest.close !== null && oneDayAgo?.close ? (latest.close / oneDayAgo.close - 1) * 100 : null;
    const previousAmounts = series.slice(1, INDEX_LOOKBACK_BARS)
      .map((item) => item.amount)
      .filter((value): value is number => value !== null && value > 0);
    const amountAvg = previousAmounts.length ? previousAmounts.reduce((sum, value) => sum + value, 0) / previousAmounts.length : null;
    const amountRatio = latest.amount !== null && amountAvg !== null && amountAvg > 0 ? latest.amount / amountAvg : null;
    if (pct1d === null) localGaps.push(`指数 ${code} 当日涨跌缺失`);
    indices.push({ code, pct_1d: pct1d, amount_ratio_5d: amountRatio });
  }
  const indexByCode = new Map(indices.map((item) => [item.code, item]));
  const marketProxy = indexByCode.get(MARKET_PROXY_INDEX) ?? indexByCode.get(LARGE_CAP_INDEX) ?? null;
  const amountRatio = median(indices
    .map((item) => item.amount_ratio_5d)
    .filter((value): value is number => value !== null));
  gaps.push(...localGaps);
  return {
    market_pct_1d: marketProxy?.pct_1d ?? null,
    amount_ratio_5d: amountRatio === null ? null : round(amountRatio, 4),
    bias: "unknown",
    gaps: localGaps,
  };
}

interface BreadthAggregate {
  stock_count: number;
  ma20_sample: number;
  below_ma20: number;
  ma60_sample: number;
  below_ma60: number;
  prev_sample: number;
  advancing: number;
  declining: number;
}

/**
 * 全市场主板低位扩散度：MA20/MA60 用日线收盘价在库内自算，不依赖指标表是否已补齐。
 * 只用 dataDate 及以前 130 个自然日（约 90 个交易日）的日线，保证 MA60 有足够样本。
 */
async function loadBreadthAggregate(db: Db, dataDate: string): Promise<BreadthAggregate> {
  const row = (await db.query<BreadthAggregate>(
    `WITH ranked AS (
       SELECT bar.instrument_id,
              bar.close::float8 AS close,
              COALESCE(bar.prev_close::float8,
                       lag(bar.close::float8) OVER (PARTITION BY bar.instrument_id ORDER BY bar.bar_date)) AS prev_close,
              avg(bar.close::float8) OVER w20 AS ma20,
              count(*) OVER w20 AS ma20_count,
              avg(bar.close::float8) OVER w60 AS ma60,
              count(*) OVER w60 AS ma60_count,
              row_number() OVER (PARTITION BY bar.instrument_id ORDER BY bar.bar_date DESC) AS reverse_rn
         FROM market_bar bar
         JOIN market_instrument instrument ON instrument.id = bar.instrument_id
        WHERE bar.freq = 'day'
          AND bar.bar_date BETWEEN $1::date - interval '130 days' AND $1::date
          AND instrument.kind = 'stock' AND instrument.code ~ $2
      WINDOW w20 AS (PARTITION BY bar.instrument_id ORDER BY bar.bar_date
                     ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
             w60 AS (PARTITION BY bar.instrument_id ORDER BY bar.bar_date
                     ROWS BETWEEN 59 PRECEDING AND CURRENT ROW)
     )
     SELECT count(*)::int AS stock_count,
            count(*) FILTER (WHERE ma20_count >= 20)::int AS ma20_sample,
            count(*) FILTER (WHERE ma20_count >= 20 AND close < ma20)::int AS below_ma20,
            count(*) FILTER (WHERE ma60_count >= 60)::int AS ma60_sample,
            count(*) FILTER (WHERE ma60_count >= 60 AND close < ma60)::int AS below_ma60,
            count(*) FILTER (WHERE prev_close IS NOT NULL)::int AS prev_sample,
            count(*) FILTER (WHERE prev_close IS NOT NULL AND close > prev_close)::int AS advancing,
            count(*) FILTER (WHERE prev_close IS NOT NULL AND close < prev_close)::int AS declining
       FROM ranked WHERE reverse_rn = 1`,
    [dataDate, MAIN_BOARD_REGEX],
  )).rows[0];
  return row ?? {
    stock_count: 0, ma20_sample: 0, below_ma20: 0, ma60_sample: 0, below_ma60: 0,
    prev_sample: 0, advancing: 0, declining: 0,
  };
}

async function loadLowFirstBoardRatio(
  db: Db,
  dataDate: string,
  codes: string[],
  gaps: string[],
): Promise<{ ratio: number | null; sample: number | null }> {
  if (codes.length === 0) return { ratio: null, sample: null };
  const row = (await db.query<{ sample: number; low: number }>(
    `WITH ranked AS (
       SELECT bar.instrument_id, bar.close::float8 AS close,
              avg(bar.close::float8) OVER w20 AS ma20,
              count(*) OVER w20 AS ma20_count,
              row_number() OVER (PARTITION BY bar.instrument_id ORDER BY bar.bar_date DESC) AS reverse_rn
         FROM market_bar bar
         JOIN market_instrument instrument ON instrument.id = bar.instrument_id
        WHERE bar.freq = 'day'
          AND bar.bar_date BETWEEN $1::date - interval '130 days' AND $1::date
          AND instrument.code = ANY($2::text[])
      WINDOW w20 AS (PARTITION BY bar.instrument_id ORDER BY bar.bar_date
                     ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)
     )
     SELECT count(*) FILTER (WHERE ma20_count >= 20)::int AS sample,
            count(*) FILTER (WHERE ma20_count >= 20 AND close < ma20)::int AS low
       FROM ranked WHERE reverse_rn = 1`,
    [dataDate, codes],
  )).rows[0];
  if (!row || row.sample === 0) {
    gaps.push("首板股 MA20 缺失，低位首板占比无法计算");
    return { ratio: null, sample: null };
  }
  return { ratio: round(row.low / row.sample, 4), sample: row.sample };
}

async function evaluateLowPositionSpread(
  db: Db,
  dataDate: string,
  firstBoardCodes: string[],
  gaps: string[],
): Promise<LowPositionSpread> {
  const localGaps: string[] = [];
  const aggregate = await loadBreadthAggregate(db, dataDate);
  if (aggregate.stock_count === 0) {
    localGaps.push("全市场主板日线缺失，低位扩散度无法计算");
    gaps.push(...localGaps);
    return {
      stock_count: 0, below_ma20_ratio: null, below_ma60_ratio: null,
      advancing_ratio: null, low_first_board_ratio: null, gaps: localGaps,
    };
  }
  const ma20Coverage = aggregate.ma20_sample / aggregate.stock_count;
  const ma60Coverage = aggregate.ma60_sample / aggregate.stock_count;
  if (ma20Coverage < BREADTH_MA_COVERAGE_MIN) {
    localGaps.push(`全市场 MA20 覆盖不足（${round(ma20Coverage * 100)}%）`);
  }
  if (ma60Coverage < BREADTH_MA_COVERAGE_MIN) {
    localGaps.push(`全市场 MA60 覆盖不足（${round(ma60Coverage * 100)}%）`);
  }
  const lowFirstBoard = await loadLowFirstBoardRatio(db, dataDate, firstBoardCodes, localGaps);
  gaps.push(...localGaps);
  return {
    stock_count: aggregate.stock_count,
    below_ma20_ratio: aggregate.ma20_sample > 0 ? round(aggregate.below_ma20 / aggregate.ma20_sample, 4) : null,
    below_ma60_ratio: aggregate.ma60_sample > 0 ? round(aggregate.below_ma60 / aggregate.ma60_sample, 4) : null,
    advancing_ratio: aggregate.prev_sample > 0 ? round(aggregate.advancing / aggregate.prev_sample, 4) : null,
    low_first_board_ratio: lowFirstBoard.ratio,
    gaps: localGaps,
  };
}

async function evaluateMainline(
  db: Db,
  dataDate: string,
  gaps: string[],
): Promise<MainlineState> {
  const events = await loadEvents(db, dataDate, dataDate);
  const upEvents = events.filter((event) => event.event_type === "up");
  const localGaps: string[] = [];
  if (upEvents.length === 0) {
    localGaps.push("T 日涨停事件缺失，主线集中度无法计算");
    gaps.push(...localGaps);
    return {
      top_theme: null, mainline_vacuum: null, gaps: localGaps,
    };
  }
  const themeWidth = new Map<string, number>();
  let themedWidth = 0;
  for (const event of upEvents) {
    const themes = cleanLimitUpThemes(event.reason);
    if (themes.length > 0) {
      themedWidth += 1;
      for (const theme of themes) themeWidth.set(theme, (themeWidth.get(theme) ?? 0) + 1 / themes.length);
    }
  }
  const [topThemeEntry] = [...themeWidth.entries()].sort((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"));
  if (!topThemeEntry) localGaps.push("涨停原因缺少题材归属，主线真空无法判定");
  const themeCount = themeWidth.size || null;
  const topThemeShare = topThemeEntry && themedWidth > 0 ? topThemeEntry[1] / themedWidth : null;
  const classified = classifyMainlineVacuum({ theme_count: themeCount, top_theme_share: topThemeShare });
  localGaps.push(...classified.gaps);
  gaps.push(...localGaps);
  return {
    top_theme: topThemeEntry?.[0] ?? null,
    mainline_vacuum: classified.mainline_vacuum,
    gaps: localGaps,
  };
}

/** 环境数据完全不可用时的占位结果：build 解析日期失败时也要返回同构结构。 */
export function insufficientEnvironment(dataDate: string, reason: string[]): UltraShortEnvironmentResult {
  const gaps = [...new Set(reason)];
  return {
    data_date: dataDate,
    data_status: "insufficient",
    limit_up_emotion: {
      rating: null, highest_streak: null,
      limit_up_count: null, limit_break_count: null, limit_down_count: null, break_rate: null,
      yesterday_limit_up_premium: null, gaps: [...gaps],
    },
    index_environment: {
      market_pct_1d: null, amount_ratio_5d: null, bias: "unknown", gaps: [...gaps],
    },
    low_position_spread: {
      stock_count: 0, below_ma20_ratio: null, below_ma60_ratio: null,
      advancing_ratio: null, low_first_board_ratio: null, gaps: [...gaps],
    },
    mainline: {
      top_theme: null, mainline_vacuum: null, gaps: [...gaps],
    },
    systemic_risk: null,
    mainline_vacuum: null,
    pool_cap: { ...POOL_CAP_RULES.weak },
    gaps,
  };
}

/**
 * 03 环境判定入口：只读 T 日及以前的数据。
 * 返回连板情绪、指数环境、低位扩散度、主线真空、系统性风险、关注池规模和标签。
 */
export async function evaluateUltraShortEnvironment(
  db: Db,
  dataDate: string,
): Promise<UltraShortEnvironmentResult> {
  const globalGaps: string[] = [];
  const previous = await previousOpenDay(db, dataDate);
  if (previous.gap) globalGaps.push(previous.gap);
  if (!previous.date) globalGaps.push("上一交易日缺失，昨日涨停溢价与连板反馈无法计算");

  const emotion = await evaluateLimitUpEmotion(db, dataDate, previous.date, globalGaps);
  const indexEnvironment = await evaluateIndexEnvironment(db, dataDate, globalGaps);
  const firstBoardCodes = (await loadEvents(db, dataDate, dataDate))
    .filter((event) => event.event_type === "up" && (event.streak_count ?? 1) <= 1 && isMainBoardEvent(event))
    .map((event) => event.code);
  const spread = await evaluateLowPositionSpread(db, dataDate, firstBoardCodes, globalGaps);
  const mainline = await evaluateMainline(db, dataDate, globalGaps);

  const systemic = classifySystemicRisk({
    market_pct_1d: indexEnvironment.market_pct_1d,
    amount_ratio_5d: indexEnvironment.amount_ratio_5d,
    advancing_ratio: spread.advancing_ratio,
    limit_down_count: emotion.limit_down_count,
  });
  globalGaps.push(...systemic.gaps);

  const bias = classifyIndexBias({
    systemic_risk: systemic.risk,
    advancing_ratio: spread.advancing_ratio,
    below_ma20_ratio: spread.below_ma20_ratio,
    amount_ratio_5d: indexEnvironment.amount_ratio_5d,
    mainline_vacuum: mainline.mainline_vacuum,
  });
  indexEnvironment.bias = bias;
  const poolCap = resolvePoolCap({
    rating: emotion.rating,
    index_bias: bias,
    systemic_risk: systemic.risk,
    mainline_vacuum: mainline.mainline_vacuum,
  });

  const gaps = [...new Set(globalGaps)];
  const criticalMissing = emotion.rating === null
    || (emotion.limit_up_count === null && spread.stock_count === 0);
  const dataStatus: DataStatus = criticalMissing ? "insufficient" : gaps.length > 0 ? "partial" : "ready";
  return {
    data_date: dataDate,
    data_status: dataStatus,
    limit_up_emotion: emotion,
    index_environment: indexEnvironment,
    low_position_spread: spread,
    mainline,
    systemic_risk: systemic.risk,
    mainline_vacuum: mainline.mainline_vacuum,
    pool_cap: { min: poolCap.min, max: poolCap.max },
    gaps,
  };
}
