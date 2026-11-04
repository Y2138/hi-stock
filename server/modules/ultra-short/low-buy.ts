// 03 低吸池：只判断四种低吸形态是否形成/待触发，不产生买入触发（触发在 04）。
// 形态识别全部是纯函数，阈值具名并标注“待回测”；数据不足时返回 gaps，不用代理数据凑结论。
import { cleanLimitUpThemes } from "../market/limit-up-signals.js";
import { isTradeableStockCode } from "../market/tradeable.js";
import type { Db, UltraShortIntradayPlan, UltraShortKeyLevels } from "./types.js";

/** 低吸形态的观察窗口与阈值（全部待回测）。 */
export const LOW_BUY_THRESHOLDS = {
  window_events: 10, // 近 10 个交易日涨停/炸板事件构成低吸候选池（待回测）
  min_bars: 20, // MA20 与形态判定所需最少日线（待回测）
  min_avg_amount: 1e8, // 近 5 日均成交额下限 1 亿元，过滤流动性不足（待回测）
  max_drawdown: 0.18, // 近 10 日高点回撤超过 18% 视为 A 杀（待回测）
  a_sha_decline_days: 3, // 连续下跌天数（待回测）
  a_sha_decline_pct: -0.1, // 连续下跌累计跌幅（待回测）
  breakdown_volume_ratio: 1.5, // 放量破位：当日量 ≥1.5 倍前 5 日均量（待回测）
  shrink_volume_ratio: 0.75, // 缩量：当日量 ≤0.75 倍前 5 日均量（待回测）
  ma_tolerance: 0.02, // 回踩均线的价格容差 ±2%（待回测）
  long_huitou_streak: 2, // 龙回头要求近窗口最高连板 ≥2（待回测）
  big_yang_pct: 0.06, // 单阳不破的大阳线实体涨幅 ≥6%（待回测）
  big_yang_volume_ratio: 1.5, // 大阳线量 ≥1.5 倍前 5 日均量（待回测）
  dan_yang_lookback: 5, // 大阳线最多回溯 5 个交易日（待回测）
  small_k_amplitude: 0.04, // 横盘小 K 振幅 ≤4%（待回测）
  dan_yang_max_hold_pct: 0.08, // 横盘期间收盘距大阳收盘不超过 8%（待回测）
  n_wave_min_gain: 0.08, // N 字第一波最小涨幅 8%（待回测）
  n_pullback_max_days: 4, // N 字回调最多 4 个交易日（待回测）
  n_pullback_shrink: 0.8, // 回调均量 ≤ 第一波均量的 0.8（待回测）
  n_breakout_volume_ratio: 1.2, // 再放量拉起：当日量 ≥1.2 倍前一日（待回测）
  online_yin_volume_ratio: 0.9, // 线上阴线买回调缩量：当日量 ≤0.9 倍前 5 日均量（待回测）
  online_yin_ma_backup: 20, // 跌破 MA10 后回退 MA20 观察（待回测）
} as const;

export interface LowBuyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  /** market_bar.turnover，即成交额。 */
  amount: number | null;
}

export interface LowBuyPatternInput {
  code: string;
  name: string;
  /** 升序日线，最后一根必须是 dataDate。 */
  bars: LowBuyBar[];
  /** 近窗口最高连板数。 */
  prior_max_streak: number;
  prior_limit_up_count: number;
  /** 近窗口跌停事件数。 */
  recent_limit_down_count: number;
  had_break: boolean;
  is_st: boolean;
  is_new: boolean;
  main_theme: string | null;
}

export interface LowBuyShape {
  code: string;
  name: string;
  main_theme: string | null;
  tags: string[];
  stage: "formed" | "pending";
  key_levels: UltraShortKeyLevels;
  plan: UltraShortIntradayPlan;
  reason: string;
  gaps: string[];
}

export type LowBuyPattern =
  | "long_huitou"
  | "dan_yang_bu_po"
  | "n_structure"
  | "online_yin";

const PATTERN_LABELS: Record<LowBuyPattern, string> = {
  long_huitou: "龙回头",
  dan_yang_bu_po: "单阳不破",
  n_structure: "N 字结构",
  online_yin: "线上阴线买",
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function lastBar(bars: LowBuyBar[], offset = 0): LowBuyBar | null {
  return bars[bars.length - 1 - offset] ?? null;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function closes(bars: LowBuyBar[]): number[] {
  return bars.map((bar) => bar.close);
}

/** 收盘价简单均线；不足周期返回 null，不用短样本冒充长期均线。 */
function movingAverage(bars: LowBuyBar[], period: number, trailingOffset = 0): number | null {
  const end = bars.length - trailingOffset;
  const start = end - period;
  if (start < 0) return null;
  return average(closes(bars.slice(start, end)));
}

function averageVolumeBefore(bars: LowBuyBar[], endIndex: number, count: number): number | null {
  const start = endIndex - count;
  if (start < 0) return null;
  const values = bars.slice(start, endIndex)
    .map((bar) => bar.volume)
    .filter((value): value is number => value !== null && value > 0);
  return average(values);
}

/** 低吸排除项：A 杀、连续跌停、放量破位、ST/新股、非沪深主板、流动性不足。 */
export function lowBuyExclusion(input: LowBuyPatternInput): string | null {
  if (!isTradeableStockCode(input.code)) return "非沪深主板";
  if (input.is_st || /^(?:\*?ST|S\*ST)/iu.test(input.name.trim())) return "ST";
  if (input.is_new) return "新股未开板";
  if (input.bars.length < LOW_BUY_THRESHOLDS.min_bars) return "日线不足 20 根";
  if (input.recent_limit_down_count >= 2) return "连续跌停";
  const recent = input.bars.slice(-5);
  const amounts = recent.map((bar) => bar.amount).filter((value): value is number => value !== null && value > 0);
  if (amounts.length < 3) return "近 5 日成交额缺失";
  const avgAmount = average(amounts);
  if (avgAmount === null || avgAmount < LOW_BUY_THRESHOLDS.min_avg_amount) return "流动性不足";
  const current = lastBar(input.bars);
  if (!current) return "缺少 T 日行情";
  const window = input.bars.slice(-LOW_BUY_THRESHOLDS.window_events);
  const maxHigh = Math.max(...window.map((bar) => bar.high));
  if (maxHigh > 0 && current.close / maxHigh - 1 <= -LOW_BUY_THRESHOLDS.max_drawdown) {
    return "A 杀（近 10 日高点回撤过大）";
  }
  if (input.bars.length >= LOW_BUY_THRESHOLDS.a_sha_decline_days + 1) {
    const tail = input.bars.slice(-(LOW_BUY_THRESHOLDS.a_sha_decline_days + 1));
    let declining = true;
    for (let index = 1; index < tail.length; index += 1) {
      if (tail[index]!.close >= tail[index - 1]!.close) {
        declining = false;
        break;
      }
    }
    const first = tail[0]!;
    const last = tail[tail.length - 1]!;
    if (declining && last.close / first.close - 1 <= LOW_BUY_THRESHOLDS.a_sha_decline_pct) {
      return "A 杀（连续下跌）";
    }
  }
  const currentVolume = current.volume;
  const avgVolume = averageVolumeBefore(input.bars, input.bars.length - 1, 5);
  const previousLows = input.bars.slice(-4, -1).map((bar) => bar.low);
  if (currentVolume !== null && avgVolume !== null && previousLows.length > 0
    && currentVolume >= avgVolume * LOW_BUY_THRESHOLDS.breakdown_volume_ratio
    && current.close < Math.min(...previousLows)) {
    return "放量破位";
  }
  return null;
}

/** 龙回头：前期强势、回踩 5/10 日线缩量、企稳且未破 10 日线。 */
function detectLongHuitou(input: LowBuyPatternInput, shapes: LowBuyShape[]): void {
  const bars = input.bars;
  const current = lastBar(bars);
  const previous = lastBar(bars, 1);
  if (!current || !previous) return;
  const strong = input.prior_max_streak >= LOW_BUY_THRESHOLDS.long_huitou_streak
    || input.prior_limit_up_count >= LOW_BUY_THRESHOLDS.long_huitou_streak;
  if (!strong) return;
  const ma5 = movingAverage(bars, 5);
  const ma10 = movingAverage(bars, 10);
  const ma20 = movingAverage(bars, 20);
  if (ma10 === null) return;
  const touched = (ma5 !== null && current.low <= ma5 * (1 + LOW_BUY_THRESHOLDS.ma_tolerance))
    || current.low <= ma10 * (1 + LOW_BUY_THRESHOLDS.ma_tolerance);
  const held = current.close >= ma10 * (1 - LOW_BUY_THRESHOLDS.ma_tolerance);
  const stable = current.close >= current.open || current.close >= previous.close * 0.99;
  if (!touched || !held || !stable) return;
  const avgVolume = averageVolumeBefore(bars, bars.length - 1, 5);
  const shrink = current.volume !== null && avgVolume !== null
    && current.volume <= avgVolume * LOW_BUY_THRESHOLDS.shrink_volume_ratio;
  const patternLow = Math.min(current.low, previous.low);
  const invalidation = round2(patternLow * 0.98);
  const trigger = round2(Math.max(current.high, previous.high));
  shapes.push({
    code: input.code,
    name: input.name,
    main_theme: input.main_theme,
    tags: [PATTERN_LABELS.long_huitou],
    stage: shrink ? "formed" : "pending",
    key_levels: {
      prev_close: round2(previous.close),
      ma5: ma5 === null ? null : round2(ma5),
      ma10: round2(ma10),
      ma20: ma20 === null ? null : round2(ma20),
      pattern_low: round2(patternLow),
      breakout_price: trigger,
      invalidation_price: invalidation,
      stop_price: invalidation,
    },
    plan: {
      trigger: "long_huitou",
      trigger_price: trigger,
      invalidation_price: invalidation,
      note: "次日站上 T 日高点且量能不缩再确认；跌破形态低点放弃",
    },
    reason: `前期最高 ${input.prior_max_streak} 板后回踩 ${ma10 === null ? "均线" : "MA10"}，`
      + `${shrink ? "缩量" : "量能尚未缩到位"}、${held ? "未破 10 日线" : "破位"}`,
    gaps: shrink ? [] : ["回调量能尚未缩到位，形态待触发"],
  });
}

/** 单阳不破：放量大阳后小 K 横盘，不破大阳低点。 */
function detectDanYangBuPo(input: LowBuyPatternInput, shapes: LowBuyShape[]): void {
  const bars = input.bars;
  const current = lastBar(bars);
  if (!current) return;
  const latestStart = bars.length - 2;
  const earliest = Math.max(5, bars.length - 1 - LOW_BUY_THRESHOLDS.dan_yang_lookback);
  for (let index = latestStart; index >= earliest; index -= 1) {
    const big = bars[index]!;
    const avgVolume = averageVolumeBefore(bars, index, 5);
    const isBigYang = big.close >= big.open * (1 + LOW_BUY_THRESHOLDS.big_yang_pct)
      && big.volume !== null && avgVolume !== null
      && big.volume >= avgVolume * LOW_BUY_THRESHOLDS.big_yang_volume_ratio;
    if (!isBigYang) continue;
    const consolidation = bars.slice(index + 1);
    if (consolidation.length === 0) continue;
    let valid = true;
    for (let offset = 0; offset < consolidation.length; offset += 1) {
      const bar = consolidation[offset]!;
      const priorClose = (offset === 0 ? big : consolidation[offset - 1]!).close;
      const amplitude = priorClose > 0 ? (bar.high - bar.low) / priorClose : Number.POSITIVE_INFINITY;
      if (bar.low < big.low * 0.995
        || amplitude > LOW_BUY_THRESHOLDS.small_k_amplitude
        || bar.close > big.close * (1 + LOW_BUY_THRESHOLDS.dan_yang_max_hold_pct)) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    const ma5 = movingAverage(bars, 5);
    const ma10 = movingAverage(bars, 10);
    const ma20 = movingAverage(bars, 20);
    const invalidation = round2(big.low * 0.99);
    shapes.push({
      code: input.code,
      name: input.name,
      main_theme: input.main_theme,
      tags: [PATTERN_LABELS.dan_yang_bu_po],
      stage: "formed",
      key_levels: {
        prev_close: round2(big.close),
        ma5: ma5 === null ? null : round2(ma5),
        ma10: ma10 === null ? null : round2(ma10),
        ma20: ma20 === null ? null : round2(ma20),
        pattern_low: round2(big.low),
        breakout_price: round2(big.high),
        invalidation_price: invalidation,
        stop_price: invalidation,
      },
      plan: {
        trigger: "dan_yang_bu_po",
        trigger_price: round2(big.high),
        invalidation_price: invalidation,
        note: "放量突破大阳高点再确认；横盘跌破大阳低点放弃",
      },
      reason: `${big.date} 放量大阳后横盘 ${consolidation.length} 日，未破大阳低点 ${round2(big.low)}`,
      gaps: [],
    });
    return;
  }
}

/** N 字结构：第一波强、缩量回调、低点守住关键位，等待再放量拉起。 */
function detectNStructure(input: LowBuyPatternInput, shapes: LowBuyShape[]): void {
  const bars = input.bars;
  if (bars.length < 8) return;
  const firstWave = bars.slice(-7, -LOW_BUY_THRESHOLDS.n_pullback_max_days);
  const pullback = bars.slice(-LOW_BUY_THRESHOLDS.n_pullback_max_days);
  if (firstWave.length < 2 || pullback.length < 2) return;
  const firstWaveHigh = Math.max(...firstWave.map((bar) => bar.high));
  const firstWaveLow = Math.min(...firstWave.map((bar) => bar.low));
  if (firstWaveLow <= 0 || firstWaveHigh / firstWaveLow - 1 < LOW_BUY_THRESHOLDS.n_wave_min_gain) return;
  const current = lastBar(bars);
  const previous = lastBar(bars, 1);
  if (!current || !previous) return;
  const ma10 = movingAverage(bars, 10);
  const pullbackLow = Math.min(...pullback.map((bar) => bar.low));
  const keyLevel = ma10 === null ? firstWaveLow * 1.02 : Math.max(ma10, firstWaveLow * 1.02);
  const held = pullbackLow >= keyLevel * (1 - LOW_BUY_THRESHOLDS.ma_tolerance);
  if (!held) return;
  const firstWaveVolume = average(firstWave
    .map((bar) => bar.volume)
    .filter((value): value is number => value !== null && value > 0));
  const pullbackVolume = average(pullback
    .map((bar) => bar.volume)
    .filter((value): value is number => value !== null && value > 0));
  const shrink = firstWaveVolume !== null && pullbackVolume !== null
    && pullbackVolume <= firstWaveVolume * LOW_BUY_THRESHOLDS.n_pullback_shrink;
  const restart = current.close > previous.close && current.volume !== null && previous.volume !== null
    && previous.volume > 0 && current.volume >= previous.volume * LOW_BUY_THRESHOLDS.n_breakout_volume_ratio;
  const stage: "formed" | "pending" = restart ? "formed" : "pending";
  const ma5 = movingAverage(bars, 5);
  const ma20 = movingAverage(bars, 20);
  const invalidation = round2(pullbackLow * 0.98);
  shapes.push({
    code: input.code,
    name: input.name,
    main_theme: input.main_theme,
    tags: [PATTERN_LABELS.n_structure],
    stage,
    key_levels: {
      prev_close: round2(previous.close),
      ma5: ma5 === null ? null : round2(ma5),
      ma10: ma10 === null ? null : round2(ma10),
      ma20: ma20 === null ? null : round2(ma20),
      pattern_low: round2(pullbackLow),
      breakout_price: round2(firstWaveHigh),
      invalidation_price: invalidation,
      stop_price: invalidation,
    },
    plan: {
      trigger: "n_structure",
      trigger_price: round2(Math.max(current.high, firstWaveHigh)),
      invalidation_price: invalidation,
      note: "放量突破第一波高点再确认；跌破回调低点放弃",
    },
    reason: `第一波 ${round2((firstWaveHigh / firstWaveLow - 1) * 100)}%、回调 ${pullback.length} 日`
      + `${shrink ? "缩量" : "量能未缩"}${held ? "并守住关键位" : ""}`,
    gaps: restart ? [] : ["第二波尚未放量拉起，形态待触发"],
  });
}

/** 线上阴线买：趋势向上，回踩 MA10/MA20 收阴但不破位。 */
function detectOnlineYin(input: LowBuyPatternInput, shapes: LowBuyShape[]): void {
  const bars = input.bars;
  const current = lastBar(bars);
  const previous = lastBar(bars, 1);
  if (!current || !previous) return;
  const ma10 = movingAverage(bars, 10);
  const ma20 = movingAverage(bars, 20);
  const ma20FiveDaysAgo = movingAverage(bars, 20, 5);
  if (ma10 === null || ma20 === null || ma20FiveDaysAgo === null) return;
  const uptrend = current.close > ma20 && ma20 > ma20FiveDaysAgo;
  const isYin = current.close < current.open;
  const touched = current.low <= ma10 * (1 + LOW_BUY_THRESHOLDS.ma_tolerance)
    || current.low <= ma20 * (1 + LOW_BUY_THRESHOLDS.ma_tolerance);
  if (!uptrend || !isYin || !touched) return;
  const avgVolume = averageVolumeBefore(bars, bars.length - 1, 5);
  const shrink = current.volume !== null && avgVolume !== null
    && current.volume <= avgVolume * LOW_BUY_THRESHOLDS.online_yin_volume_ratio;
  const aboveMa10 = current.close >= ma10 * (1 - LOW_BUY_THRESHOLDS.ma_tolerance);
  const aboveMa20 = current.close >= ma20 * (1 - LOW_BUY_THRESHOLDS.ma_tolerance);
  if (!aboveMa10 && !aboveMa20) return;
  const keyMa = aboveMa10 ? ma10 : ma20;
  const stage: "formed" | "pending" = aboveMa10 && shrink ? "formed" : "pending";
  const ma5 = movingAverage(bars, 5);
  const patternLow = Math.min(current.low, keyMa * (1 - LOW_BUY_THRESHOLDS.ma_tolerance));
  const invalidation = round2(patternLow * 0.99);
  shapes.push({
    code: input.code,
    name: input.name,
    main_theme: input.main_theme,
    tags: [PATTERN_LABELS.online_yin],
    stage,
    key_levels: {
      prev_close: round2(previous.close),
      ma5: ma5 === null ? null : round2(ma5),
      ma10: round2(ma10),
      ma20: round2(ma20),
      pattern_low: round2(patternLow),
      breakout_price: round2(current.high),
      invalidation_price: invalidation,
      stop_price: invalidation,
    },
    plan: {
      trigger: "online_yin",
      trigger_price: round2(current.high),
      invalidation_price: invalidation,
      note: "次日站上阴线高点再确认；跌破均线支撑放弃",
    },
    reason: `趋势向上，回踩 ${aboveMa10 ? "MA10" : "MA20"} 收阴，`
      + `${shrink ? "缩量" : "量能未缩"}${aboveMa10 ? "、未破 10 日线" : "、退守 20 日线"}`,
    gaps: stage === "formed" ? [] : ["量能或支撑确认不足，形态待触发"],
  });
}

/** 形态识别纯函数：按固定顺序返回命中的全部形态，同一标的可并列多个标签。 */
export function detectLowBuyPatterns(input: LowBuyPatternInput): LowBuyShape[] {
  if (lowBuyExclusion(input) !== null) return [];
  const shapes: LowBuyShape[] = [];
  detectLongHuitou(input, shapes);
  detectDanYangBuPo(input, shapes);
  detectNStructure(input, shapes);
  detectOnlineYin(input, shapes);
  return shapes;
}

interface LowBuyEventRow {
  date: string;
  event_type: "up" | "down" | "break";
  streak_count: number | null;
  reason: string | null;
  is_st: boolean | null;
  is_new: boolean | null;
  code: string;
  name: string;
}

interface LowBuyEventSummary {
  max_streak: number;
  up_count: number;
  down_count: number;
  had_break: boolean;
  is_st: boolean;
  is_new: boolean;
  main_theme: string | null;
}

export interface LowBuyQueryResult {
  shapes: LowBuyShape[];
  gaps: string[];
}

/**
 * 03 低吸池读取：只从近 10 个交易日的涨停/炸板/跌停事件里取候选，再叠加日线形态识别。
 * 不扫描全市场、不使用 dataDate 之后的数据。
 */
export async function queryLowBuyShapes(db: Db, dataDate: string): Promise<LowBuyQueryResult> {
  const gaps: string[] = [];
  let dates = (await db.query<{ date: string }>(
    `SELECT trade_date::text AS date FROM market_trading_day
      WHERE is_open AND trade_date <= $1::date
      ORDER BY trade_date DESC LIMIT $2`,
    [dataDate, LOW_BUY_THRESHOLDS.window_events],
  )).rows.map((row) => row.date);
  if (dates.length === 0) {
    dates = (await db.query<{ date: string }>(
      `SELECT DISTINCT bar_date::text AS date FROM market_bar
        WHERE freq = 'day' AND bar_date <= $1::date
        ORDER BY date DESC LIMIT $2`,
      [dataDate, LOW_BUY_THRESHOLDS.window_events],
    )).rows.map((row) => row.date);
    if (dates.length > 0) gaps.push("交易日历缺失，低吸事件窗口按行情日回退");
  }
  if (dates.length === 0) {
    return { shapes: [], gaps: [...gaps, "交易日历与行情日缺失，低吸池无法确定观察窗口"] };
  }
  const startDate = dates[dates.length - 1]!;
  const events = (await db.query<LowBuyEventRow>(
    `SELECT event.trade_date::text AS date, event.event_type, event.streak_count,
            event.reason, event.is_st, event.is_new, instrument.code, instrument.name
       FROM market_limit_event event
       JOIN market_instrument instrument ON instrument.id = event.instrument_id
      WHERE event.trade_date BETWEEN $1::date AND $2::date
      ORDER BY event.trade_date, instrument.code`,
    [startDate, dataDate],
  )).rows;
  if (events.length === 0) {
    return { shapes: [], gaps: [...gaps, "近 10 个交易日无涨停/炸板事件，低吸池为空"] };
  }
  const summaries = new Map<string, LowBuyEventSummary>();
  for (const event of events) {
    if (!isTradeableStockCode(event.code)) continue;
    const summary = summaries.get(event.code) ?? {
      max_streak: 0, up_count: 0, down_count: 0, had_break: false,
      is_st: false, is_new: false, main_theme: null,
    };
    summary.is_st = summary.is_st || event.is_st === true;
    summary.is_new = summary.is_new || event.is_new === true;
    if (event.event_type === "up") {
      summary.up_count += 1;
      summary.max_streak = Math.max(summary.max_streak, event.streak_count ?? 1);
      if (event.reason) {
        const theme = cleanLimitUpThemes(event.reason)[0] ?? null;
        if (theme && !summary.main_theme) summary.main_theme = theme;
      }
    } else if (event.event_type === "break") {
      summary.had_break = true;
    } else if (event.event_type === "down") {
      summary.down_count += 1;
    }
    summaries.set(event.code, summary);
  }
  const candidateCodes = [...summaries.keys()];
  if (candidateCodes.length === 0) {
    return { shapes: [], gaps: [...gaps, "近 10 个交易日无沪深主板涨停/炸板事件，低吸池为空"] };
  }
  const barRows = (await db.query<{
    code: string; date: string; open: number; high: number; low: number; close: number;
    volume: number | null; amount: number | null;
  }>(
    `SELECT instrument.code, bar.bar_date::text AS date,
            bar.open::float8 AS open, bar.high::float8 AS high, bar.low::float8 AS low,
            bar.close::float8 AS close, bar.volume::float8 AS volume, bar.turnover::float8 AS amount
       FROM market_bar bar
       JOIN market_instrument instrument ON instrument.id = bar.instrument_id
      WHERE instrument.code = ANY($1::text[]) AND bar.freq = 'day'
        AND bar.bar_date <= $2::date AND bar.bar_date >= $2::date - interval '180 days'
      ORDER BY instrument.code, bar.bar_date`,
    [candidateCodes, dataDate],
  )).rows;
  const barsByCode = new Map<string, LowBuyBar[]>();
  for (const row of barRows) {
    const list = barsByCode.get(row.code) ?? [];
    list.push({
      date: row.date, open: row.open, high: row.high, low: row.low, close: row.close,
      volume: row.volume, amount: row.amount,
    });
    barsByCode.set(row.code, list);
  }
  const shapes: LowBuyShape[] = [];
  const missingBarCodes: string[] = [];
  for (const code of candidateCodes.sort()) {
    const summary = summaries.get(code)!;
    const name = events.find((event) => event.code === code)?.name ?? code;
    // 缺 T 日行情前先排除 ST/新股，避免把停牌或权限不符的标的报成数据缺口。
    if (summary.is_st || /^(?:\*?ST|S\*ST)/iu.test(name.trim()) || summary.is_new) continue;
    const bars = (barsByCode.get(code) ?? []).slice(-60);
    const current = bars[bars.length - 1];
    if (!current || current.date !== dataDate) {
      missingBarCodes.push(code);
      continue;
    }
    const input: LowBuyPatternInput = {
      code,
      name,
      bars,
      prior_max_streak: summary.max_streak,
      prior_limit_up_count: summary.up_count,
      recent_limit_down_count: summary.down_count,
      had_break: summary.had_break,
      is_st: summary.is_st,
      is_new: summary.is_new,
      main_theme: summary.main_theme,
    };
    shapes.push(...detectLowBuyPatterns(input));
  }
  if (missingBarCodes.length > 0) {
    const listed = missingBarCodes.slice(0, 10).join("、");
    gaps.push(`低吸候选缺少 T 日行情，已跳过：${listed}${missingBarCodes.length > 10 ? ` 等 ${missingBarCodes.length} 只` : ""}`);
  }
  const stageOrder = { formed: 0, pending: 1 };
  shapes.sort((left, right) =>
    stageOrder[left.stage] - stageOrder[right.stage]
    || left.code.localeCompare(right.code)
    || left.tags.join("").localeCompare(right.tags.join(""), "zh-CN"));
  return { shapes, gaps: [...new Set(gaps)] };
}
