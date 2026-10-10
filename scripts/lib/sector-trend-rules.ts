// 板块双线趋势策略的纯规则库：中期斜率与趋势线脱离、止跌K线形态、量能分类、二次止跌、上下收敛。
// 止跌形态阈值复制自 scripts/lib/backtest-short-rules.ts 的生产口径（去掉个股超卖依赖），
// 与量能的配比按夜间板块双线策略定义：温和放量 [1.0,1.5)、爆量 ≥2.5。
// 只被仓库内研究脚本引用，不接入服务运行时，不得引用数据库、服务配置或环境变量。

export interface SectorTrendBar {
  code: string;
  bar_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type VolumeClass = "缩量" | "温和放量" | "明显放量" | "爆量";

export interface SectorTrendParams {
  /** 中期窗口（日）；默认 60。 */
  mediumWindow: number;
  /** 中期下降趋势判定：归一化拟合幅度 ≤ 该阈值（负数，如 -0.08）。 */
  mediumSlopeThreshold: number;
  /** 短期窗口（日）；默认 10。 */
  shortWindow: number;
  /** 温和放量上界（不含）；用户口径 1.5。 */
  mildVolumeMax: number;
  /** 爆量下界（含）。 */
  explosiveVolumeMin: number;
  /** 触发日前 lookback 日内需出现过止跌K线。 */
  bottomingLookback: number;
  /** 信号前低 = 含触发日在内近 N 根日线的最低低点。 */
  priorLowWindow: number;
  /** 二次止跌：回踩低点 ≥ 首次止跌锚定低点 × 容差。 */
  secondBottomTolerance: number;
  /** 二次止跌：首次止跌K线距本次触发日的最短/最长间隔（日）。 */
  secondBottomMinGap: number;
  secondBottomMaxGap: number;
  /** 上下收敛：20日振幅/40日振幅 ≤ 阈值。 */
  contractionRatioMax: number;
}

export const DEFAULT_SECTOR_TREND_PARAMS: SectorTrendParams = {
  mediumWindow: 60,
  mediumSlopeThreshold: -0.08,
  shortWindow: 10,
  mildVolumeMax: 1.5,
  explosiveVolumeMin: 2.5,
  bottomingLookback: 10,
  priorLowWindow: 20,
  secondBottomTolerance: 0.97,
  secondBottomMinGap: 5,
  secondBottomMaxGap: 20,
  contractionRatioMax: 0.75,
};

export function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 最小二乘线性回归：x = 0..n-1，返回斜率与截距。 */
export function ols(values: number[]): { slope: number; intercept: number } {
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let covariance = 0;
  let variance = 0;
  for (let x = 0; x < n; x += 1) {
    covariance += (x - xMean) * (values[x]! - yMean);
    variance += (x - xMean) ** 2;
  }
  const slope = variance > 0 ? covariance / variance : 0;
  return { slope, intercept: yMean - slope * xMean };
}

/** 归一化斜率：窗口内拟合总幅度（小数）。slope×(n-1)/均值。 */
export function normalizedSlope(values: number[]): number | null {
  if (values.length < 5) return null;
  const { slope } = ols(values);
  const average = mean(values);
  return average > 0 ? (slope * (values.length - 1)) / average : null;
}

/** 回归趋势线在最后一个点的取值（用于判断价格是否站上趋势线）。 */
export function trendLineAtLast(values: number[]): number | null {
  if (values.length < 5) return null;
  const { slope, intercept } = ols(values);
  return intercept + slope * (values.length - 1);
}

export function movingAverage(values: number[], window: number, endIndexInclusive: number): number | null {
  const start = endIndexInclusive - window + 1;
  if (start < 0) return null;
  return mean(values.slice(start, endIndexInclusive + 1));
}

export function volumeRatio(volume: number, vma5: number): number | null {
  return vma5 > 0 ? volume / vma5 : null;
}

export function classifyVolume(ratio: number, params: SectorTrendParams): VolumeClass {
  if (ratio < 1) return "缩量";
  if (ratio < params.mildVolumeMax) return "温和放量";
  if (ratio < params.explosiveVolumeMin) return "明显放量";
  return "爆量";
}

export function temperature(close: number, ma20: number): number {
  return Math.max(0, Math.min(100, 50 + (close / ma20 - 1) * 1000));
}

export type BottomingPattern = "阳包阴" | "金针探底" | "双日止跌";

/**
 * 止跌K线形态判定（板块版）：阈值复制自 backtest-short-rules.ts 生产口径。
 * 与生产左侧反转的差异：不含 RSI/MA20 乖离等个股超卖前提，量能不内嵌在形态里，
 * 由调用方按温和放量/爆量单独组合。prev 触及近5日低点的锚定保留。
 */
export function bottomingPattern(
  bars: SectorTrendBar[],
  index: number,
): BottomingPattern | null {
  if (index < 5) return null;
  const current = bars[index]!;
  const previous = bars[index - 1]!;
  if (![current.open, current.high, current.low, current.close, previous.open, previous.high,
    previous.low, previous.close].every((value) => Number.isFinite(value) && value > 0)) return null;
  const priorFiveDayLow = Math.min(...bars.slice(index - 5, index).map((bar) => bar.low));
  const priorNearFiveDayLow = previous.low <= priorFiveDayLow * 1.005;
  const bullishEngulfing = previous.close < previous.open && current.close > current.open &&
    current.open <= previous.close && current.close >= previous.open;
  const intradayRange = current.high - current.low;
  const closePosition = intradayRange > 0 ? (current.close - current.low) / intradayRange : 0;
  const lowerShadow = Math.min(current.open, current.close) - current.low;
  const body = Math.abs(current.close - current.open);
  const goldenNeedle = lowerShadow >= 0.01 * current.close && lowerShadow >= body * 1.5 &&
    closePosition >= 0.65 && priorNearFiveDayLow;
  const twoDayReversal = priorNearFiveDayLow && current.close > current.open && current.close > previous.high;
  if (bullishEngulfing) return "阳包阴";
  if (twoDayReversal) return "双日止跌";
  if (goldenNeedle) return "金针探底";
  return null;
}

export interface SectorTrendSnapshot {
  /** 归一化 60 日（中期）斜率。 */
  normSlope60: number | null;
  /** 归一化 10 日（短期）斜率。 */
  normSlope10: number | null;
  ma10: number | null;
  ma20: number | null;
  /** MA20 五日变化（小数）。 */
  ma20Slope5: number | null;
  volumeRatio: number | null;
  volumeClass: VolumeClass | null;
  /** 中期下降趋势（背景）。 */
  mediumDowntrend: boolean;
  /** 触发日收盘上穿 60 日回归趋势线且短期斜率转正（脱离）。 */
  escapesMediumDowntrend: boolean;
  /** 近 bottomingLookback 日内出现过的止跌形态（含当日）。 */
  recentBottomingPattern: BottomingPattern | null;
  /** 信号前低：含当日在内近 priorLowWindow 根最低低点。 */
  priorLow: number | null;
  /** 二次止跌：存在首次止跌K线且期间回踩未破锚定低点×容差。 */
  secondBottom: boolean;
  /** 上下收敛（高降低抬 + 振幅收缩 + 收盘站上 MA10）。 */
  contracting: boolean;
  /** 旧理论温度（对照组用）。 */
  temperature: number | null;
  /** 右侧线：收盘>MA20 且 MA20 五日上行 且 温和量比（<mildVolumeMax）。 */
  rightTrack: boolean;
}

/**
 * 在 bars[index] 当日计算板块双线趋势快照。
 * 快照是纯特征；是否构成信号由调用方按 左侧基础信号 = 脱离 ∧ 近期止跌形态 ∧ 量能 组合。
 */
export function sectorTrendSnapshot(
  bars: SectorTrendBar[],
  index: number,
  params: SectorTrendParams = DEFAULT_SECTOR_TREND_PARAMS,
): SectorTrendSnapshot | null {
  const mediumWindow = params.mediumWindow;
  const shortWindow = params.shortWindow;
  if (index < mediumWindow || index < Math.max(40, params.priorLowWindow)) return null;
  const closes = bars.map((bar) => bar.close);
  const volumes = bars.map((bar) => bar.volume);
  const current = bars[index]!;
  const previous = bars[index - 1]!;
  const mediumSlice = closes.slice(index - mediumWindow + 1, index + 1);
  const mediumSlicePrev = closes.slice(index - mediumWindow, index);
  const shortSlice = closes.slice(index - shortWindow + 1, index + 1);
  const normSlope60 = normalizedSlope(mediumSlice);
  const normSlope10 = normalizedSlope(shortSlice);
  const ma10 = movingAverage(closes, 10, index);
  const ma20 = movingAverage(closes, 20, index);
  const ma20Prev5 = movingAverage(closes, 20, index - 5);
  const ma20Slope5 = ma20 !== null && ma20Prev5 !== null && ma20Prev5 > 0 ? ma20 / ma20Prev5 - 1 : null;
  const vma5 = mean(volumes.slice(index - 4, index + 1));
  const ratio = volumeRatio(current.volume, vma5);
  const volumeClass = ratio === null ? null : classifyVolume(ratio, params);
  const trendLineNow = trendLineAtLast(mediumSlice);
  const trendLinePrev = trendLineAtLast(mediumSlicePrev);
  const mediumDowntrend = normSlope60 !== null && normSlope60 <= params.mediumSlopeThreshold;
  const escapes = mediumDowntrend && trendLineNow !== null && trendLinePrev !== null &&
    previous.close <= trendLinePrev && current.close > trendLineNow &&
    normSlope10 !== null && normSlope10 > 0;
  let recentBottomingPattern: BottomingPattern | null = null;
  for (let offset = params.bottomingLookback - 1; offset >= 0; offset -= 1) {
    const pattern = bottomingPattern(bars, index - offset);
    if (pattern) {
      recentBottomingPattern = pattern;
      break;
    }
  }
  const priorLow = Math.min(...bars.slice(index - params.priorLowWindow + 1, index + 1).map((bar) => bar.low));
  const secondBottom = secondBottomContext(bars, index, params);
  const high10 = Math.max(...bars.slice(index - 9, index + 1).map((bar) => bar.high));
  const high20 = Math.max(...bars.slice(index - 19, index + 1).map((bar) => bar.high));
  const low10 = Math.min(...bars.slice(index - 9, index + 1).map((bar) => bar.low));
  const low20 = Math.min(...bars.slice(index - 19, index + 1).map((bar) => bar.low));
  const high20Prev = Math.max(...bars.slice(index - 19, index - 9).map((bar) => bar.high));
  const low20Prev = Math.min(...bars.slice(index - 19, index - 9).map((bar) => bar.low));
  const range20 = high20 > 0 && low20 > 0 ? high20 / low20 - 1 : null;
  const high40 = Math.max(...bars.slice(index - 39, index + 1).map((bar) => bar.high));
  const low40 = Math.min(...bars.slice(index - 39, index + 1).map((bar) => bar.low));
  const range40 = high40 > 0 && low40 > 0 ? high40 / low40 - 1 : null;
  const contracting = range20 !== null && range40 !== null && range40 > 0 &&
    range20 / range40 <= params.contractionRatioMax &&
    high10 < high20Prev && low10 > low20Prev && ma10 !== null && current.close > ma10;
  const temperatureValue = ma20 !== null && ma20 > 0 ? temperature(current.close, ma20) : null;
  const rightTrack = ma20 !== null && current.close > ma20 && ma20Slope5 !== null && ma20Slope5 > 0 &&
    ratio !== null && ratio < params.mildVolumeMax;
  return {
    normSlope60,
    normSlope10,
    ma10,
    ma20,
    ma20Slope5,
    volumeRatio: ratio,
    volumeClass,
    mediumDowntrend,
    escapesMediumDowntrend: escapes,
    recentBottomingPattern,
    priorLow,
    secondBottom,
    contracting,
    temperature: temperatureValue,
    rightTrack,
  };
}

/** 二次止跌：首次止跌K线在 [index-maxGap, index-minGap] 内，且其后回踩低点未破首次锚定低点×容差。 */
export function secondBottomContext(
  bars: SectorTrendBar[],
  index: number,
  params: SectorTrendParams,
): boolean {
  for (let first = index - params.secondBottomMinGap; first >= index - params.secondBottomMaxGap; first -= 1) {
    if (first < 5) break;
    if (!bottomingPattern(bars, first)) continue;
    const anchorLow = Math.min(...bars.slice(first - 4, first + 1).map((bar) => bar.low));
    const pullbackLow = Math.min(...bars.slice(first + 1, index + 1).map((bar) => bar.low));
    if (pullbackLow >= anchorLow * params.secondBottomTolerance) return true;
  }
  return false;
}

/** ATR14（含当前日的近 14 根真波幅均值）。 */
export function atr14(bars: SectorTrendBar[], index: number): number | null {
  if (index < 15) return null;
  const ranges: number[] = [];
  for (let i = index - 13; i <= index; i += 1) {
    const bar = bars[i]!;
    const previousClose = bars[i - 1]!.close;
    if (![bar.high, bar.low, previousClose].every((value) => Number.isFinite(value))) return null;
    ranges.push(Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose)));
  }
  return mean(ranges);
}
