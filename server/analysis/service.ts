import crypto from "node:crypto";
import type pg from "pg";
import { apiErrors } from "../http/router.js";
import { generateValueMonthlyRank } from "../modules/value-ranking/service.js";
import { runUltraShortAuctionCycle } from "../modules/ultra-short/auction.js";

export const ANALYSIS_SERVICE_VERSION = "analysis-v3";
export const ANALYSIS_TYPES = ["sector_temperature", "key_levels", "long_valuation", "value_monthly_rank", "sector_trend_structure", "ultra_short_auction"] as const;
export type AnalysisType = (typeof ANALYSIS_TYPES)[number];
type Db = Pick<pg.Pool, "query">;

export interface AnalysisRequest {
  analysis_type: AnalysisType;
  codes?: string[];
  as_of?: string;
  lookback?: number;
  force?: boolean;
}

export interface AnalysisRunRow {
  id: string;
  analysis_type: AnalysisType;
  request_json: Record<string, unknown>;
  input_summary: Record<string, unknown>;
  service_version: string;
  status: "queued" | "running" | "success" | "partial" | "failed";
  result_json: unknown;
  data_gaps: unknown[];
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

/** 板块温度与市场状态口径：同花顺正式板块一级行业（881 前缀），与 daily_data_update 日更范围同源；不再使用任何代理指数/ETF 映射。 */

interface Bar {
  code: string;
  bar_date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  bar_time: string;
}

function number(value: string | number | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function temperature(close: number, ma20: number): number {
  return Math.max(0, Math.min(100, 50 + (close / ma20 - 1) * 1000));
}

async function selectBars(db: Db, codes: string[], freq: "day" | "30m", asOf?: string, limit = 120): Promise<Bar[]> {
  if (codes.length === 0) return [];
  const result = await db.query<Bar>(
    `WITH ranked AS (
       SELECT i.code, b.bar_date::text, b.open::text, b.high::text, b.low::text,
              b.close::text, b.volume::text, b.bar_time::text,
              row_number() OVER (PARTITION BY b.instrument_id ORDER BY b.bar_date DESC, b.bar_time DESC) AS rn
         FROM market_bar b JOIN market_instrument i ON i.id = b.instrument_id
        WHERE i.code = ANY($1::text[]) AND b.freq = $2
          AND ($3::date IS NULL OR b.bar_date <= $3::date)
     )
     SELECT code, bar_date, open, high, low, close, volume, bar_time
       FROM ranked WHERE rn <= $4 ORDER BY code, bar_date, bar_time`,
    [codes, freq, asOf ?? null, limit],
  );
  return result.rows;
}

function grouped(bars: Bar[]): Map<string, Bar[]> {
  const map = new Map<string, Bar[]>();
  for (const bar of bars) {
    const values = map.get(bar.code) ?? [];
    values.push(bar);
    map.set(bar.code, values);
  }
  return map;
}

export interface MarketRegimeResult {
  status: "success" | "partial" | "unavailable";
  state: "牛市" | "震荡" | "熊市" | null;
  as_of: string | null;
  base_date: string | null;
  composite_index: number | null;
  ma5: number | null;
  ma20: number | null;
  roc5_pct: number | null;
  coverage: {
    expected_boards: number;
    available_boards: number;
    required_dates: number;
    available_dates: number;
    missing_codes: string[];
  };
  reason: string | null;
}

function unavailableMarketRegime(expectedBoards: number, reason: string): MarketRegimeResult {
  return {
    status: "unavailable",
    state: null,
    as_of: null,
    base_date: null,
    composite_index: null,
    ma5: null,
    ma20: null,
    roc5_pct: null,
    coverage: {
      expected_boards: expectedBoards,
      available_boards: 0,
      required_dates: 21,
      available_dates: 0,
      missing_codes: [],
    },
    reason,
  };
}

/** 一级行业可用样本等权合成综合指数；低于九成覆盖时不输出市场状态。 */
function marketRegime(codes: string[], bars: Map<string, Bar[]>): MarketRegimeResult {
  if (codes.length === 0) return unavailableMarketRegime(0, "没有有效的 881 一级行业板块");
  const dates = [...new Set(codes.flatMap((code) => (bars.get(code) ?? []).map((bar) => bar.bar_date)))].sort();
  const requiredDates = dates.slice(-21);
  if (requiredDates.length < 21) {
    const unavailable = unavailableMarketRegime(codes.length, `综合指数至少需要 21 个交易日，当前仅 ${requiredDates.length} 日`);
    unavailable.as_of = requiredDates.at(-1) ?? null;
    unavailable.base_date = requiredDates.at(0) ?? null;
    unavailable.coverage.available_dates = requiredDates.length;
    return unavailable;
  }
  const closes = new Map<string, Map<string, number>>();
  for (const code of codes) {
    closes.set(code, new Map((bars.get(code) ?? []).map((bar) => [bar.bar_date, Number(bar.close)])));
  }
  const completeCodes = codes.filter((code) => requiredDates.every((date) => Number.isFinite(closes.get(code)?.get(date))));
  const missingCodes = codes.filter((code) => !completeCodes.includes(code));
  const coverage = {
    expected_boards: codes.length,
    available_boards: completeCodes.length,
    required_dates: 21,
    available_dates: requiredDates.length,
    missing_codes: missingCodes,
  };
  if (completeCodes.length < Math.ceil(codes.length * 0.9)) {
    return {
      ...unavailableMarketRegime(codes.length, `综合指数有效一级行业不足九成（${completeCodes.length}/${codes.length}）`),
      status: "partial",
      as_of: requiredDates.at(-1)!,
      base_date: requiredDates.at(0)!,
      coverage,
    };
  }

  const points = [100];
  for (let index = 1; index < requiredDates.length; index += 1) {
    const date = requiredDates[index]!;
    const previousDate = requiredDates[index - 1]!;
    const dailyReturn = mean(completeCodes.map((code) => closes.get(code)!.get(date)! / closes.get(code)!.get(previousDate)! - 1))!;
    points.push(points.at(-1)! * (1 + dailyReturn));
  }
  const composite = points.at(-1)!;
  const ma5 = mean(points.slice(-5))!;
  const ma20 = mean(points.slice(-20))!;
  const roc5Pct = (composite / points.at(-6)! - 1) * 100;
  const state = ma5 > ma20 && roc5Pct > 0 ? "牛市" : ma5 < ma20 && roc5Pct < 0 ? "熊市" : "震荡";
  return {
    status: "success",
    state,
    as_of: requiredDates.at(-1)!,
    base_date: requiredDates.at(0)!,
    composite_index: composite,
    ma5,
    ma20,
    roc5_pct: roc5Pct,
    coverage,
    reason: missingCodes.length ? `跳过 ${missingCodes.length} 个缺少完整窗口的一级行业` : null,
  };
}

/** 同花顺一级行业板块全集：code → 板块名 */
async function industryBoards(db: Db): Promise<Map<string, string>> {
  const result = await db.query<{ code: string; name: string }>(
    `SELECT i.code, i.name
       FROM market_board board
       JOIN market_instrument i ON i.id = board.instrument_id
      WHERE board.active = true AND board.source = 'hithink' AND board.board_type = 'industry'
        AND i.code LIKE '881%'
      ORDER BY i.code`,
  );
  return new Map(result.rows.map((row) => [row.code, row.name]));
}

export interface SectorTemperatureOutcome {
  result: {
    average_temperature: number | null;
    available_average_temperature: number | null;
    state: string;
    market_regime: MarketRegimeResult;
    skipped: Array<{ code: string; reason: string }>;
    sectors: Array<{
      sector: string;
      code: string;
      as_of: string;
      close: number;
      ma20: number;
      temperature: number;
      day_return_pct: number;
      five_day_return_pct: number;
      volume_ratio_5: number | null;
    }>;
  };
  gaps: unknown[];
  input: { requested_codes: number; available_codes: number; latest_date: string | null };
}

export async function querySectorTemperature(db: Db, request: AnalysisRequest): Promise<SectorTemperatureOutcome> {
  const boards = await industryBoards(db);
  const defaultUniverse = !request.codes?.length;
  const codes = defaultUniverse ? [...boards.keys()] : request.codes!;
  const namesByCode = new Map(boards);
  const unknown = codes.filter((code) => !namesByCode.has(code));
  if (unknown.length > 0) {
    const extra = await db.query<{ code: string; name: string }>(
      `SELECT code, name FROM market_instrument WHERE code = ANY($1::text[])`,
      [unknown],
    );
    for (const row of extra.rows) namesByCode.set(row.code, row.name);
  }
  const bars = grouped(await selectBars(db, codes, "day", request.as_of, Math.max(60, request.lookback ?? 60)));
  const skipped: Array<{ code: string; reason: string }> = [];
  const items = codes.map((code) => {
    const rows = bars.get(code) ?? [];
    if (rows.length < 20) {
      skipped.push({ code, reason: `日线不足 20 条（${rows.length}）` });
      return null;
    }
    const closes = rows.map((row) => number(row.close)).filter((value): value is number => value !== null);
    const volumes = rows.map((row) => number(row.volume)).filter((value): value is number => value !== null);
    const close = closes.at(-1)!;
    const ma20 = mean(closes.slice(-20))!;
    const prior = closes.at(-2) ?? close;
    const fiveAgo = closes.at(-6) ?? close;
    const avgVolume5 = mean(volumes.slice(-5));
    return {
      sector: namesByCode.get(code) ?? code,
      code,
      as_of: rows.at(-1)!.bar_date,
      close,
      ma20,
      temperature: temperature(close, ma20),
      day_return_pct: (close / prior - 1) * 100,
      five_day_return_pct: (close / fiveAgo - 1) * 100,
      volume_ratio_5: avgVolume5 && avgVolume5 > 0 ? (volumes.at(-1) ?? 0) / avgVolume5 : null,
    };
  }).filter((item): item is NonNullable<typeof item> => item !== null);
  const availableAverage = mean(items.map((item) => item!.temperature));
  const average = codes.length > 0 && items.length >= Math.ceil(codes.length * 0.9) ? availableAverage : null;
  const regime = defaultUniverse
    ? marketRegime(codes, bars)
    : unavailableMarketRegime(codes.length, "市场状态只使用完整的 881 一级行业全集计算");
  const gaps: unknown[] = average === null ? [...skipped] : [];
  if (defaultUniverse && regime.status !== "success") {
    gaps.push({ scope: "market_regime", reason: regime.reason });
  }
  return {
    result: {
      average_temperature: average,
      available_average_temperature: availableAverage,
      state: average === null ? "数据不足" : average < 30 ? "低温" : average < 50 ? "偏冷" : average < 60 ? "中性" : average < 75 ? "偏暖" : "高温",
      market_regime: regime,
      skipped,
      sectors: items,
    },
    gaps,
    input: { requested_codes: codes.length, available_codes: items.length, latest_date: items.map((item) => item!.as_of).sort().at(-1) ?? null },
  };
}

/** 夜间板块左侧趋势结构：板块信号（主线 60 日中期脱离 + 补充线 13 日急跌反转）与补涨候选口径冻结自
 *  docs/回测结论/夜间板块左侧趋势结构研究结论.md（含窗口矩阵章节）与 夜间板块内个股选择原则与验证.md；阈值变更必须先有新的冻结回测证据。 */
const SECTOR_TREND_RULES = {
  mediumWindow: 60,
  mediumSlopeThreshold: -0.08,
  shortWindow: 10,
  /** 补充触发线（急跌反转）：13 日斜率背景 + 5 日斜率确认，口径冻结自窗口研究结论。 */
  supplementaryWindow: 13,
  supplementarySlopeThreshold: -0.08,
  supplementaryShortWindow: 5,
  /** 第三触发线（新低回升，纯 Donchian 口径）：近 13 日触及 60 日最低收盘×1.001 且收盘创近 10 日最高收盘；
   *  不附加止跌形态与量比条件（消融证明冗余），口径冻结自 Donchian 补充研究结论。 */
  donchianTouchWindow: 13,
  donchianLowBase: 60,
  donchianBreakoutWindow: 10,
  donchianTolerance: 1.001,
  mildVolumeMax: 1.5,
  bottomingLookback: 15,
  priorLowWindow: 20,
  secondBottomTolerance: 0.97,
  secondBottomMinGap: 5,
  secondBottomMaxGap: 20,
  contractionRatioMax: 0.85,
  observationDays: 20,
  minStockBars: 121,
  minTurnover20Yuan: 20_000_000,
} as const;

/** 板块当日确认度分级（docs/strategy/板块机会筛选确认度分级口径.md）：
 *  触发线只决定是否进入观察，优先级由当日确认度决定。权重与阈值在冻结回测前是初始值，不得临场调参。 */
const SECTOR_CONFIRMATION_RULES = {
  /** M1 上涨家数占比：≥90% 得 2 分，≥80% 得 1 分。 */
  advanceRatioFull: 0.9,
  advanceRatioHalf: 0.8,
  /** M2 板块涨幅 − 上证涨幅（百分点）。 */
  relativeFullPct: 3,
  relativeHalfPct: 1,
  /** M3 涨停家数：≥5 家得 2 分，1–4 家得 1 分。 */
  limitUpFull: 5,
  /** M4 量比：≥1.30 得 2 分，≥1.10 得 1 分。 */
  volumeRatioFull: 1.3,
  volumeRatioHalf: 1.1,
  /** M5 日内确认：收盘位置阈值与脉冲扣分。 */
  closePositionConfirmed: 0.9,
  closePositionPulse: 0.95,
  openReturnMaxPulse: 0.01,
  pulseJumpPct: 6,
  pulsePenalty: 2,
  /** 分档：A ≥6，B 3–5，C ≤2。 */
  tierAFull: 6,
  tierBFull: 3,
  /** 涨停推断阈值（%）按板块与代码前缀区分。 */
  limitUpPct: { main: 9.8, star: 19.8, bse: 29.8 },
  /** 结构位失效位：距收盘 ≥ 0.5×当日振幅尺度才算未被吞掉。 */
  invalidationAtrFactor: 0.5,
  /** 上证指数代码（sector_trend_structure 相对强度基准）。 */
  shanghaiIndexCode: "000001.SH",
} as const;

export type SectorConfirmationTier = "A" | "B" | "C";

export interface SectorConfirmation {
  /** 当日确认度分档：A 进前列、B 待确认、C 只记录不出候选。 */
  tier: SectorConfirmationTier;
  /** 五项分值加脉冲扣分后的总分，0–10。 */
  score: number;
  parts: { m1: number; m2: number; m3: number; m4: number; m5: number };
  metrics: {
    member_count: number;
    counted_members: number;
    advance_count: number;
    advance_ratio: number | null;
    day_return_pct: number | null;
    shanghai_return_pct: number | null;
    relative_pct: number | null;
    limit_up_count: number;
    limit_up_20cm_count: number;
    limit_event_count: number | null;
    volume_ratio_5: number | null;
    close_position: number | null;
    open_return_pct: number | null;
    intraday_pulse: boolean;
  };
  excluded: { st_or_delisting: number; inactive: number; missing_prev_close: number };
  invalidation: {
    price: number;
    distance_pct: number;
    basis: "MA5" | "MA10" | "prior_low";
    second_price: number | null;
    second_distance_pct: number | null;
    second_basis: "MA5" | "MA10" | "prior_low" | null;
    note: string | null;
  };
}

export type SectorBottomingPattern = "阳包阴" | "双日止跌" | "金针探底";

interface TrendBarRow {
  bar_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function trendBarRows(bars: Bar[]): TrendBarRow[] | null {
  const rows: TrendBarRow[] = [];
  for (const bar of bars) {
    const open = number(bar.open);
    const high = number(bar.high);
    const low = number(bar.low);
    const close = number(bar.close);
    const volume = number(bar.volume);
    if (open === null || high === null || low === null || close === null || close <= 0) return null;
    rows.push({ bar_date: bar.bar_date, open, high, low, close, volume: volume ?? 0 });
  }
  return rows;
}

function olsFit(values: number[]): { slope: number; intercept: number } {
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = mean(values)!;
  let covariance = 0;
  let variance = 0;
  for (let x = 0; x < n; x += 1) {
    covariance += (x - xMean) * (values[x]! - yMean);
    variance += (x - xMean) ** 2;
  }
  const slope = variance > 0 ? covariance / variance : 0;
  return { slope, intercept: yMean - slope * xMean };
}

/** 归一化斜率：窗口内拟合总幅度（小数），与 scripts/lib/sector-trend-rules.ts 同式。 */
function normalizedSlope(values: number[]): number | null {
  if (values.length < 5) return null;
  const average = mean(values);
  if (average === null || average <= 0) return null;
  return (olsFit(values).slope * (values.length - 1)) / average;
}

/** 回归趋势线在最后一个点的取值。 */
function trendLineAtLast(values: number[]): number | null {
  if (values.length < 5) return null;
  const { slope, intercept } = olsFit(values);
  return intercept + slope * (values.length - 1);
}

/** 二元 OLS：y = a + b·x（个股日收益对行业日收益回归）。 */
function olsBetaIntercept(x: number[], y: number[]): { slope: number; intercept: number } {
  const xMean = mean(x)!;
  const yMean = mean(y)!;
  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < x.length; i += 1) {
    covariance += (x[i]! - xMean) * (y[i]! - yMean);
    variance += (x[i]! - xMean) ** 2;
  }
  const slope = variance > 0 ? covariance / variance : 0;
  return { slope, intercept: yMean - slope * xMean };
}

/** 止跌K线形态（板块版）：阈值镜像研究冻结口径；优先级 阳包阴 > 双日止跌 > 金针探底。 */
function boardBottomingPattern(rows: TrendBarRow[], index: number): SectorBottomingPattern | null {
  if (index < 5) return null;
  const current = rows[index]!;
  const previous = rows[index - 1]!;
  const priorFiveDayLow = Math.min(...rows.slice(index - 5, index).map((row) => row.low));
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

interface BoardTrendSnapshot {
  asOf: string;
  close: number;
  normSlope60: number | null;
  normSlope10: number | null;
  normSlope13: number | null;
  ma20: number | null;
  volumeRatio5: number | null;
  signal: boolean;
  /** 触发线标签；同日多线成立按 中期脱离 > 新低回升 > 急跌反转 取最高优先级。 */
  trigger: "中期脱离" | "新低回升" | "急跌反转" | null;
  pattern: SectorBottomingPattern | null;
  patternTier: 1 | 2 | null;
  volumeClass: "缩量" | "温和放量" | "明显放量" | "爆量" | null;
  priorLow: number | null;
  signalHigh: number;
  secondBottom: boolean;
  contracting: boolean;
}

/** 在最后一根K线上计算板块趋势快照；信号 = 三触发线之一（中期脱离/新低回升/急跌反转）。 */
function boardTrendSnapshot(rows: TrendBarRow[]): BoardTrendSnapshot | null {
  const index = rows.length - 1;
  if (index < SECTOR_TREND_RULES.mediumWindow) return null;
  const current = rows[index]!;
  const previous = rows[index - 1]!;
  const closes = rows.map((row) => row.close);
  const volumes = rows.map((row) => row.volume);
  const normSlope60 = normalizedSlope(closes.slice(-SECTOR_TREND_RULES.mediumWindow));
  const normSlope10 = normalizedSlope(closes.slice(-SECTOR_TREND_RULES.shortWindow));
  const normSlope13 = normalizedSlope(closes.slice(-SECTOR_TREND_RULES.supplementaryWindow));
  const ma20 = mean(closes.slice(-20));
  const vma5 = mean(volumes.slice(-5));
  const volumeRatio5 = vma5 !== null && vma5 > 0 ? current.volume / vma5 : null;
  const volumeClass = volumeRatio5 === null ? null
    : volumeRatio5 < 1 ? "缩量"
      : volumeRatio5 < SECTOR_TREND_RULES.mildVolumeMax ? "温和放量"
        : volumeRatio5 < 2.5 ? "明显放量" : "爆量";
  // 主线：脱离 60 日中期下降趋势（上穿回归趋势线 + 10 日斜率转正）。
  const mediumDowntrend = normSlope60 !== null && normSlope60 <= SECTOR_TREND_RULES.mediumSlopeThreshold;
  const trendLineNow = trendLineAtLast(closes.slice(-SECTOR_TREND_RULES.mediumWindow));
  const trendLinePrev = trendLineAtLast(closes.slice(-SECTOR_TREND_RULES.mediumWindow - 1, -1));
  const escapeMain = mediumDowntrend && trendLineNow !== null && trendLinePrev !== null &&
    previous.close <= trendLinePrev && current.close > trendLineNow &&
    normSlope10 !== null && normSlope10 > 0;
  // 补充线：急跌反转（13 日斜率 ≤-8% 背景下上穿 13 日回归趋势线 + 5 日斜率转正）。
  const sharpDowntrend = normSlope13 !== null && normSlope13 <= SECTOR_TREND_RULES.supplementarySlopeThreshold;
  const shortLineNow = trendLineAtLast(closes.slice(-SECTOR_TREND_RULES.supplementaryWindow));
  const shortLinePrev = trendLineAtLast(closes.slice(-SECTOR_TREND_RULES.supplementaryWindow - 1, -1));
  const normSlope5 = normalizedSlope(closes.slice(-SECTOR_TREND_RULES.supplementaryShortWindow));
  const escapeSupplementary = sharpDowntrend && shortLineNow !== null && shortLinePrev !== null &&
    previous.close <= shortLinePrev && current.close > shortLineNow &&
    normSlope5 !== null && normSlope5 > 0;
  // 第三线（新低回升）：近 13 日触及 60 日最低收盘 且 当日收盘创近 10 日最高收盘；不附加形态与量比。
  const lowBase = Math.min(...closes.slice(-SECTOR_TREND_RULES.donchianLowBase));
  const touchedLow = rows.slice(index - SECTOR_TREND_RULES.donchianTouchWindow + 1, index + 1)
    .some((row) => row.close <= lowBase * SECTOR_TREND_RULES.donchianTolerance);
  const priorHighClose = Math.max(...closes.slice(-SECTOR_TREND_RULES.donchianBreakoutWindow - 1, -1));
  const donchianEscape = touchedLow && current.close > priorHighClose;
  let pattern: SectorBottomingPattern | null = null;
  for (let offset = SECTOR_TREND_RULES.bottomingLookback - 1; offset >= 0; offset -= 1) {
    const found = boardBottomingPattern(rows, index - offset);
    if (found) {
      pattern = found;
      break;
    }
  }
  let secondBottom = false;
  for (let first = index - SECTOR_TREND_RULES.secondBottomMinGap;
    first >= index - SECTOR_TREND_RULES.secondBottomMaxGap; first -= 1) {
    if (first < 5) break;
    if (!boardBottomingPattern(rows, first)) continue;
    const anchorLow = Math.min(...rows.slice(first - 4, first + 1).map((row) => row.low));
    const pullbackLow = Math.min(...rows.slice(first + 1, index + 1).map((row) => row.low));
    if (pullbackLow >= anchorLow * SECTOR_TREND_RULES.secondBottomTolerance) {
      secondBottom = true;
      break;
    }
  }
  const high10 = Math.max(...rows.slice(index - 9, index + 1).map((row) => row.high));
  const high20 = Math.max(...rows.slice(index - 19, index + 1).map((row) => row.high));
  const low20 = Math.min(...rows.slice(index - 19, index + 1).map((row) => row.low));
  const high20Prev = Math.max(...rows.slice(index - 19, index - 9).map((row) => row.high));
  const low20Prev = Math.min(...rows.slice(index - 19, index - 9).map((row) => row.low));
  const low10 = Math.min(...rows.slice(index - 9, index + 1).map((row) => row.low));
  const range20 = high20 > 0 && low20 > 0 ? high20 / low20 - 1 : null;
  const high40 = Math.max(...rows.slice(index - 39, index + 1).map((row) => row.high));
  const low40 = Math.min(...rows.slice(index - 39, index + 1).map((row) => row.low));
  const range40 = high40 > 0 && low40 > 0 ? high40 / low40 - 1 : null;
  const ma10 = mean(closes.slice(-10));
  const contracting = range20 !== null && range40 !== null && range40 > 0 &&
    range20 / range40 <= SECTOR_TREND_RULES.contractionRatioMax &&
    high10 < high20Prev && low10 > low20Prev && ma10 !== null && current.close > ma10;
  const volumeAcceptable = volumeClass === "缩量" || volumeClass === "温和放量";
  const signalMain = escapeMain && pattern !== null && volumeAcceptable;
  const signalSupplementary = escapeSupplementary && pattern !== null && volumeAcceptable;
  const signal = signalMain || signalSupplementary || donchianEscape;
  return {
    asOf: current.bar_date,
    close: current.close,
    normSlope60,
    normSlope10,
    normSlope13,
    ma20,
    volumeRatio5,
    signal,
    trigger: !signal ? null : signalMain ? "中期脱离" : donchianEscape ? "新低回升" : "急跌反转",
    pattern,
    patternTier: pattern === null ? null : pattern === "金针探底" ? 2 : 1,
    volumeClass,
    priorLow: Math.min(...rows.slice(index - SECTOR_TREND_RULES.priorLowWindow + 1, index + 1).map((row) => row.low)),
    signalHigh: current.high,
    secondBottom,
    contracting,
  };
}

/** 涨停推断阈值按交易权限区分：创业板/科创板 20cm，北交所 30cm，其余主板 10cm。 */
function boardLimitUpThresholdPct(code: string): number {
  if (/^(300|301|688|689)/.test(code)) return SECTOR_CONFIRMATION_RULES.limitUpPct.star;
  if (/^(43|83|87|88)/.test(code)) return SECTOR_CONFIRMATION_RULES.limitUpPct.bse;
  return SECTOR_CONFIRMATION_RULES.limitUpPct.main;
}

/** ST 与退市风险：以证券简称为主，is_st 与生命周期为辅（库内 is_st 存在空值）。 */
function isRiskStock(row: { name: string | null; lifecycle_status?: string | null; is_st?: boolean | null }): boolean {
  const name = row.name ?? "";
  if (/ST/i.test(name) || name.includes("退")) return true;
  if (row.is_st === true) return true;
  return (row.lifecycle_status ?? "active") !== "active";
}

/** 结构位失效位（口径 2.6）：MA5/MA10/近20日前低中，取收盘下方最近且未被当日振幅吞掉的一档。 */
function structureInvalidation(
  rows: TrendBarRow[],
  snapshot: BoardTrendSnapshot,
): SectorConfirmation["invalidation"] {
  const current = rows.at(-1)!;
  const closes = rows.map((row) => row.close);
  const close = snapshot.close;
  const amplitude = current.high > current.low ? (current.high - current.low) / close : 0;
  const minGap = amplitude * SECTOR_CONFIRMATION_RULES.invalidationAtrFactor;
  const ma5 = mean(closes.slice(-5));
  const ma10 = mean(closes.slice(-10));
  const candidates: Array<{ basis: "MA5" | "MA10" | "prior_low"; price: number }> = [];
  for (const [basis, price] of [["MA5", ma5], ["MA10", ma10], ["prior_low", snapshot.priorLow]] as const) {
    if (price !== null && price < close) candidates.push({ basis, price });
  }
  const valid = candidates.filter((candidate) => (close - candidate.price) / close >= minGap)
    .sort((left, right) => right.price - left.price);
  const primary = valid[0];
  const second = valid[1];
  const distance = (price: number) => Number((((price - close) / close) * 100).toFixed(2));
  if (!primary) {
    const fallback = snapshot.priorLow ?? close;
    return {
      price: Number(fallback.toFixed(2)),
      distance_pct: distance(fallback),
      basis: "prior_low",
      second_price: null,
      second_distance_pct: null,
      second_basis: null,
      note: "结构位过近，失效位退至近20日前低",
    };
  }
  return {
    price: Number(primary.price.toFixed(2)),
    distance_pct: distance(primary.price),
    basis: primary.basis,
    second_price: second ? Number(second.price.toFixed(2)) : null,
    second_distance_pct: second ? distance(second.price) : null,
    second_basis: second?.basis ?? null,
    note: null,
  };
}

interface BoardMemberRow {
  code: string;
  name: string | null;
  lifecycle_status: string | null;
  is_st: boolean | null;
}

/** 板块当日确认度：M1–M5 分项、脉冲、总分、分档与结构位失效位；全部服务端确定性计算。 */
async function sectorConfirmation(
  db: Db,
  boardCode: string,
  rows: TrendBarRow[],
  snapshot: BoardTrendSnapshot,
  asOf: string,
): Promise<{ confirmation: SectorConfirmation; gaps: string[] }> {
  const members = await db.query<BoardMemberRow>(
    `SELECT mi.code, mi.name, mi.lifecycle_status,
            COALESCE((SELECT bool_or(e.is_st) FROM market_limit_event e
                       WHERE e.instrument_id = mi.id AND e.trade_date = $2::date), false) AS is_st
       FROM market_board_membership m
       JOIN market_instrument bi ON bi.id = m.board_instrument_id
       JOIN market_instrument mi ON mi.id = m.member_instrument_id
      WHERE bi.code = $1 AND m.effective_from <= $2::date
        AND (m.effective_to IS NULL OR m.effective_to > $2::date)
        AND mi.kind = 'stock'
      ORDER BY mi.code`,
    [boardCode, asOf],
  );
  const gaps: string[] = [];
  let stOrDelisting = 0;
  let inactive = 0;
  const usable: BoardMemberRow[] = [];
  for (const member of members.rows) {
    if (isRiskStock(member)) {
      stOrDelisting += 1;
      continue;
    }
    if ((member.lifecycle_status ?? "active") !== "active") {
      inactive += 1;
      continue;
    }
    usable.push(member);
  }
  const memberBars = grouped(await selectBars(db, usable.map((member) => member.code), "day", asOf, 2));
  let advance = 0;
  let counted = 0;
  let limitUp = 0;
  let limitUp20cm = 0;
  let missingPrevClose = 0;
  for (const member of usable) {
    const bars = memberBars.get(member.code) ?? [];
    if (bars.length < 2) {
      missingPrevClose += 1;
      continue;
    }
    const latest = bars.at(-1)!;
    const previous = bars.at(-2)!;
    if (latest.bar_date !== asOf) {
      missingPrevClose += 1;
      continue;
    }
    const close = number(latest.close);
    const previousClose = number(previous.close);
    if (close === null || previousClose === null || previousClose <= 0) {
      missingPrevClose += 1;
      continue;
    }
    counted += 1;
    const returnPct = (close / previousClose - 1) * 100;
    if (returnPct > 0) advance += 1;
    if (returnPct >= boardLimitUpThresholdPct(member.code)) {
      limitUp += 1;
      if (boardLimitUpThresholdPct(member.code) > SECTOR_CONFIRMATION_RULES.limitUpPct.main) limitUp20cm += 1;
    }
  }
  if (stOrDelisting > 0) gaps.push(`板块 ${boardCode} 确认度统计排除 ST/退市风险股 ${stOrDelisting} 只`);
  if (missingPrevClose > 0) gaps.push(`板块 ${boardCode} 有 ${missingPrevClose} 只成分股缺少前收或当日行情，未计入扩散度`);
  const advanceRatio = counted > 0 ? advance / counted : null;
  const index = rows.at(-1)!;
  const previous = rows.at(-2)!;
  const boardReturnPct = previous.close > 0 ? (index.close / previous.close - 1) * 100 : null;
  const shanghai = grouped(await selectBars(db, [SECTOR_CONFIRMATION_RULES.shanghaiIndexCode], "day", asOf, 2))
    .get(SECTOR_CONFIRMATION_RULES.shanghaiIndexCode) ?? [];
  let shanghaiReturnPct: number | null = null;
  if (shanghai.length >= 2 && shanghai.at(-1)!.bar_date === asOf) {
    const latest = number(shanghai.at(-1)!.close);
    const prior = number(shanghai.at(-2)!.close);
    if (latest !== null && prior !== null && prior > 0) shanghaiReturnPct = (latest / prior - 1) * 100;
  }
  if (shanghaiReturnPct === null) {
    gaps.push(`缺少 ${SECTOR_CONFIRMATION_RULES.shanghaiIndexCode} 当日与前收，相对强度按 0 分计`);
  }
  const relativePct = boardReturnPct !== null && shanghaiReturnPct !== null ? boardReturnPct - shanghaiReturnPct : null;
  const range = index.high - index.low;
  const closePosition = range > 0 ? (index.close - index.low) / range : null;
  const openReturnPct = previous.close > 0 ? (index.open / previous.close - 1) * 100 : null;
  const pulse = openReturnPct !== null && boardReturnPct !== null && closePosition !== null &&
    openReturnPct <= SECTOR_CONFIRMATION_RULES.openReturnMaxPulse * 100 &&
    boardReturnPct - openReturnPct >= SECTOR_CONFIRMATION_RULES.pulseJumpPct &&
    closePosition >= SECTOR_CONFIRMATION_RULES.closePositionPulse;
  // M4 按口径字段 volume_ratio_5（两位小数）比较，与回放参考结果同一口径，避免 1.2959 这类边界分歧。
  const volumeRatio = snapshot.volumeRatio5 === null ? null : Number(snapshot.volumeRatio5.toFixed(2));
  const m1 = advanceRatio === null ? 0
    : advanceRatio >= SECTOR_CONFIRMATION_RULES.advanceRatioFull ? 2
      : advanceRatio >= SECTOR_CONFIRMATION_RULES.advanceRatioHalf ? 1 : 0;
  const m2 = relativePct === null ? 0
    : relativePct >= SECTOR_CONFIRMATION_RULES.relativeFullPct ? 2
      : relativePct >= SECTOR_CONFIRMATION_RULES.relativeHalfPct ? 1 : 0;
  const m3 = limitUp >= SECTOR_CONFIRMATION_RULES.limitUpFull ? 2 : limitUp >= 1 ? 1 : 0;
  const m4 = volumeRatio === null ? 0
    : volumeRatio >= SECTOR_CONFIRMATION_RULES.volumeRatioFull ? 2
      : volumeRatio >= SECTOR_CONFIRMATION_RULES.volumeRatioHalf ? 1 : 0;
  const m5 = closePosition === null ? 0
    : closePosition >= SECTOR_CONFIRMATION_RULES.closePositionConfirmed ? (pulse ? 1 : 2) : 0;
  const score = Math.max(0, m1 + m2 + m3 + m4 + m5 - (pulse ? SECTOR_CONFIRMATION_RULES.pulsePenalty : 0));
  const tier: SectorConfirmationTier = score >= SECTOR_CONFIRMATION_RULES.tierAFull ? "A"
    : score >= SECTOR_CONFIRMATION_RULES.tierBFull ? "B" : "C";
  const limitEvent = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM market_limit_event e
       JOIN market_board_membership m ON m.member_instrument_id = e.instrument_id
       JOIN market_instrument bi ON bi.id = m.board_instrument_id
      WHERE bi.code = $1 AND e.trade_date = $2::date AND e.event_type = 'up'
        AND m.effective_from <= $2::date AND (m.effective_to IS NULL OR m.effective_to > $2::date)`,
    [boardCode, asOf],
  );
  const eventCount = Number(limitEvent.rows[0]?.count ?? "0");
  if (limitUp > 0 && Math.abs(eventCount - limitUp) > limitUp * 0.2) {
    gaps.push(`板块 ${boardCode} 封板事件源不完整：事件表 ${eventCount} 条，日线推断 ${limitUp} 家，以推断为准`);
  }
  return {
    confirmation: {
      tier,
      score,
      parts: { m1, m2, m3, m4, m5 },
      metrics: {
        member_count: members.rows.length,
        counted_members: counted,
        advance_count: advance,
        advance_ratio: advanceRatio === null ? null : Number((advanceRatio * 100).toFixed(1)),
        day_return_pct: boardReturnPct === null ? null : round2(boardReturnPct),
        shanghai_return_pct: shanghaiReturnPct === null ? null : round2(shanghaiReturnPct),
        relative_pct: relativePct === null ? null : round2(relativePct),
        limit_up_count: limitUp,
        limit_up_20cm_count: limitUp20cm,
        limit_event_count: eventCount,
        volume_ratio_5: volumeRatio,
        close_position: closePosition === null ? null : Number(closePosition.toFixed(2)),
        open_return_pct: openReturnPct === null ? null : round2(openReturnPct),
        intraday_pulse: pulse,
      },
      excluded: { st_or_delisting: stOrDelisting, inactive, missing_prev_close: missingPrevClose },
      invalidation: structureInvalidation(rows, snapshot),
    },
    gaps,
  };
}

export interface SectorTrendStockCandidate {
  code: string;
  name: string;
  branch: "跌幅补涨" | "止跌修复确认";
  close: number;
  ret20: number;
  ret5: number;
  turnover20: number;
  residual5: number | null;
}

interface CatchUpOutcome {
  branchA: SectorTrendStockCandidate[];
  branchB: SectorTrendStockCandidate[];
  eligibleCount: number;
  skipped: Array<{ reason: string; count: number }>;
}

/** 板块内补涨候选：分支A按20日涨跌幅最低，分支B为止跌修复确认后按5日行业残差最高。 */
async function catchUpCandidates(
  db: Db,
  boardCode: string,
  boardRows: TrendBarRow[],
  signalDate: string,
): Promise<CatchUpOutcome | null> {
  const members = await db.query<BoardMemberRow>(
    `SELECT DISTINCT mi.code, mi.name, mi.lifecycle_status,
            COALESCE((SELECT bool_or(e.is_st) FROM market_limit_event e
                       WHERE e.instrument_id = mi.id AND e.trade_date = $2::date), false) AS is_st
       FROM market_board_membership m
       JOIN market_instrument bi ON bi.id = m.board_instrument_id
       JOIN market_instrument mi ON mi.id = m.member_instrument_id
      WHERE bi.code = $1 AND m.effective_from <= $2::date
        AND (m.effective_to IS NULL OR m.effective_to > $2::date)
        AND mi.kind = 'stock' AND (mi.code LIKE '60%' OR mi.code LIKE '00%')`,
    [boardCode, signalDate],
  );
  if (!members.rows.length) return null;
  const stockBars = grouped(await selectBars(db, members.rows.map((row) => row.code), "day", signalDate, 130));
  const boardCloses = boardRows.map((row) => row.close);
  const boardLogReturns: number[] = [];
  for (let i = boardCloses.length - 60; i < boardCloses.length; i += 1) {
    if (i < 1) return null;
    boardLogReturns.push(Math.log(boardCloses[i]! / boardCloses[i - 1]!));
  }
  const boardLog5 = boardLogReturns.slice(-5).reduce((sum, value) => sum + value, 0);
  const skipped = new Map<string, number>();
  const bump = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  const eligible: Array<SectorTrendStockCandidate & { residual5: number | null; branchBReady: boolean }> = [];
  for (const member of members.rows) {
    // ST/退市风险与停牌标的一律不进入补涨候选（简称优先，is_st 与生命周期为辅）。
    if (isRiskStock(member)) {
      bump((member.lifecycle_status ?? "active") !== "active" ? "非活跃标的排除" : "ST/退市风险排除");
      continue;
    }
    const rows = trendBarRows(stockBars.get(member.code) ?? []);
    if (!rows || rows.length < SECTOR_TREND_RULES.minStockBars) {
      bump("日线不足 121 根");
      continue;
    }
    const last = rows.at(-1)!;
    if (last.bar_date !== signalDate) {
      bump("行情不新鲜");
      continue;
    }
    const closes = rows.map((row) => row.close);
    const volumes = rows.map((row) => row.volume);
    const recent20Volumes = volumes.slice(-20);
    if (recent20Volumes.some((value) => !(value > 0))) {
      bump("近20日成交量为空");
      continue;
    }
    const turnover20 = mean(closes.slice(-20).map((close, i) => close * recent20Volumes[i]!));
    if (turnover20 === null || turnover20 < SECTOR_TREND_RULES.minTurnover20Yuan) {
      bump("20日均成交额不足 2000 万元");
      continue;
    }
    const index = rows.length - 1;
    const ret20 = closes[index]! / closes[index - 20]! - 1;
    const ret5 = closes[index]! / closes[index - 5]! - 1;
    const ma10 = mean(closes.slice(-10))!;
    const ma20 = mean(closes.slice(-20))!;
    let residual5: number | null = null;
    const stockLogReturns: number[] = [];
    for (let i = closes.length - 60; i < closes.length; i += 1) {
      if (i < 1 || closes[i - 1]! <= 0) {
        stockLogReturns.length = 0;
        break;
      }
      stockLogReturns.push(Math.log(closes[i]! / closes[i - 1]!));
    }
    if (stockLogReturns.length === 60 && boardLogReturns.length === 60) {
      const stockLog5 = stockLogReturns.slice(-5).reduce((sum, value) => sum + value, 0);
      // 60日日频回归 s = a + b·B；5日残差 = 个股5日累积对数收益 − (a×5 + b×行业5日累积对数收益)
      const { slope, intercept } = olsBetaIntercept(boardLogReturns, stockLogReturns);
      residual5 = stockLog5 - (intercept * 5 + slope * boardLog5);
    }
    const branchBReady = ret20 < 0 && ret5 > 0 && last.close > ma10 && last.close / ma20 - 1 <= 0.10;
    eligible.push({
      code: member.code, name: member.name ?? member.code, branch: "跌幅补涨", close: last.close,
      ret20, ret5, turnover20, residual5, branchBReady,
    });
  }
  const branchA = [...eligible].sort((a, b) => a.ret20 - b.ret20)
    .slice(0, 2).map(({ branchBReady: _ready, ...candidate }) => candidate);
  const branchB = eligible.filter((candidate) => candidate.branchBReady)
    .sort((a, b) => (b.residual5 ?? -Infinity) - (a.residual5 ?? -Infinity))
    .slice(0, 2).map((candidate) => ({ ...candidate, branch: "止跌修复确认" as const }))
    .map(({ branchBReady: _ready, ...candidate }) => candidate);
  return { branchA, branchB, eligibleCount: eligible.length, skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })) };
}

export interface SectorTrendStructureOutcome {
  result: {
    as_of: string | null;
    market_regime: MarketRegimeResult;
    boards: Array<{
      sector: string; code: string; as_of: string; close: number;
      norm_slope_60: number | null; norm_slope_10: number | null; norm_slope_13: number | null;
      ma20: number | null; volume_ratio_5: number | null;
    }>;
    signals: Array<{
      sector: string; code: string; as_of: string; close: number;
      pattern: SectorBottomingPattern | null; pattern_tier: 1 | 2 | null;
      trigger: "中期脱离" | "新低回升" | "急跌反转";
      volume_ratio_5: number | null;
      volume_class: "缩量" | "温和放量" | "明显放量" | "爆量";
      norm_slope_60: number | null; norm_slope_10: number | null; norm_slope_13: number | null;
      prior_low: number; signal_high: number; valid_through: string | null;
      second_bottom: boolean; contracting: boolean;
      confirmation: SectorConfirmation;
      catch_up: {
        branch_a: SectorTrendStockCandidate[];
        branch_b: SectorTrendStockCandidate[];
        eligible_count: number;
        skipped: Array<{ reason: string; count: number }>;
      } | null;
    }>;
    skipped: Array<{ code: string; reason: string }>;
  };
  gaps: unknown[];
  input: { requested_codes: number; available_codes: number; signal_count: number; latest_date: string | null };
}

export async function querySectorTrendStructure(db: Db, request: AnalysisRequest): Promise<SectorTrendStructureOutcome> {
  const boards = await industryBoards(db);
  const defaultUniverse = !request.codes?.length;
  const namesByCode = new Map(boards);
  const codes = defaultUniverse ? [...boards.keys()] : request.codes!.filter((code) => namesByCode.has(code));
  const bars = grouped(await selectBars(db, codes, "day", request.as_of, 140));
  const skipped: Array<{ code: string; reason: string }> = [];
  const boardItems: SectorTrendStructureOutcome["result"]["boards"] = [];
  const signalSnapshots: Array<{ code: string; snapshot: BoardTrendSnapshot; rows: TrendBarRow[] }> = [];
  for (const code of codes) {
    const rows = trendBarRows(bars.get(code) ?? []);
    const snapshot = rows ? boardTrendSnapshot(rows) : null;
    if (!rows || !snapshot) {
      skipped.push({ code, reason: `日线不足 ${SECTOR_TREND_RULES.mediumWindow + 1} 根（${rows?.length ?? 0}）` });
      continue;
    }
    boardItems.push({
      sector: namesByCode.get(code) ?? code, code, as_of: snapshot.asOf, close: snapshot.close,
      norm_slope_60: round2(snapshot.normSlope60), norm_slope_10: round2(snapshot.normSlope10),
      norm_slope_13: round2(snapshot.normSlope13),
      ma20: snapshot.ma20 === null ? null : Number(snapshot.ma20.toFixed(2)),
      volume_ratio_5: snapshot.volumeRatio5 === null ? null : Number(snapshot.volumeRatio5.toFixed(2)),
    });
    if (snapshot.signal && snapshot.priorLow !== null) {
      signalSnapshots.push({ code, snapshot, rows });
    }
  }
  const latestDate = boardItems.map((item) => item.as_of).sort().at(-1) ?? null;
  const regime = defaultUniverse
    ? marketRegime(codes, bars)
    : unavailableMarketRegime(codes.length, "市场状态只使用完整的 881 一级行业全集计算");
  const gaps: unknown[] = [];
  if (defaultUniverse && regime.status !== "success") {
    gaps.push({ scope: "market_regime", reason: regime.reason });
  }
  if (skipped.length > Math.ceil(codes.length * 0.1)) {
    gaps.push({ scope: "board_coverage", reason: `一级行业日线缺口超过一成（${skipped.length}/${codes.length}）` });
  }
  let validThrough: string | null = null;
  if (signalSnapshots.length && latestDate) {
    const calendar = await db.query<{ date: string }>(
      `SELECT trade_date::text AS date FROM market_trading_day
        WHERE is_open AND trade_date > $1::date ORDER BY trade_date
        LIMIT 1 OFFSET $2::int`,
      [latestDate, SECTOR_TREND_RULES.observationDays - 1],
    );
    validThrough = calendar.rows[0]?.date ?? null;
    if (!validThrough) gaps.push({ scope: "calendar", reason: "交易日历不足 20 个开市日，无法确定观察截止日" });
  }
  const signals: SectorTrendStructureOutcome["result"]["signals"] = [];
  for (const { code, snapshot, rows } of signalSnapshots) {
    // 补涨候选的成员剔除计数保留在板块结果内供任务报告，不计入 run 级缺口。
    const catchUp = await catchUpCandidates(db, code, rows, snapshot.asOf);
    const confirmed = await sectorConfirmation(db, code, rows, snapshot, snapshot.asOf);
    gaps.push(...confirmed.gaps);
    const confirmation = confirmed.confirmation;
    signals.push({
      sector: namesByCode.get(code) ?? code, code, as_of: snapshot.asOf, close: snapshot.close,
      pattern: snapshot.pattern, pattern_tier: snapshot.patternTier,
      trigger: snapshot.trigger!,
      volume_ratio_5: snapshot.volumeRatio5 === null ? null : Number(snapshot.volumeRatio5.toFixed(2)),
      volume_class: snapshot.volumeClass!,
      norm_slope_60: round2(snapshot.normSlope60), norm_slope_10: round2(snapshot.normSlope10),
      norm_slope_13: round2(snapshot.normSlope13),
      prior_low: Number(snapshot.priorLow!.toFixed(2)),
      signal_high: Number(snapshot.signalHigh.toFixed(2)),
      valid_through: validThrough,
      second_bottom: snapshot.secondBottom,
      contracting: snapshot.contracting,
      confirmation,
      // C 档没有当日资金确认：不输出板块内候选，也不得写入关注池。
      catch_up: confirmation.tier === "C" || catchUp === null ? null : {
        branch_a: catchUp.branchA, branch_b: catchUp.branchB,
        eligible_count: catchUp.eligibleCount, skipped: catchUp.skipped,
      },
    });
  }
  const tierRank: Record<SectorConfirmationTier, number> = { A: 0, B: 1, C: 2 };
  signals.sort((left, right) => tierRank[left.confirmation.tier] - tierRank[right.confirmation.tier]
    || right.confirmation.score - left.confirmation.score
    || right.confirmation.parts.m3 - left.confirmation.parts.m3
    || right.confirmation.parts.m4 - left.confirmation.parts.m4
    || left.code.localeCompare(right.code));
  return {
    result: {
      as_of: latestDate,
      market_regime: regime,
      boards: boardItems,
      signals,
      skipped,
    },
    gaps,
    input: {
      requested_codes: codes.length,
      available_codes: boardItems.length,
      signal_count: signals.length,
      latest_date: latestDate,
    },
  };
}

function round2(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(4));
}


function atr14(rows: Bar[]): number | null {
  const ranges: number[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const high = number(rows[index]!.high);
    const low = number(rows[index]!.low);
    const previousClose = number(rows[index - 1]!.close);
    if (high === null || low === null || previousClose === null) continue;
    ranges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }
  return mean(ranges.slice(-14));
}

function anchoredVwap(rows: Bar[]): number | null {
  if (!rows.length) return null;
  let anchor = 0;
  for (let index = 1; index < rows.length; index += 1) {
    if (Number(rows[index]!.low) < Number(rows[anchor]!.low)) anchor = index;
  }
  let value = 0;
  let volume = 0;
  for (const row of rows.slice(anchor)) {
    const rowVolume = number(row.volume) ?? 0;
    const typical = ((number(row.high) ?? 0) + (number(row.low) ?? 0) + (number(row.close) ?? 0)) / 3;
    value += typical * rowVolume;
    volume += rowVolume;
  }
  return volume > 0 ? value / volume : null;
}

function volumeZones(rows: Bar[], atr: number | null): Array<{ price: number; volume: number }> {
  if (!rows.length) return [];
  const prices = rows.map((row) => number(row.close)).filter((value): value is number => value !== null);
  const step = Math.max((atr ?? ((Math.max(...prices) - Math.min(...prices)) / 20)) / 2, 0.001);
  const bins = new Map<number, number>();
  for (const row of rows) {
    const price = number(row.close);
    if (price === null) continue;
    const bin = Math.round(price / step) * step;
    bins.set(bin, (bins.get(bin) ?? 0) + (number(row.volume) ?? 0));
  }
  return [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([price, volume]) => ({ price, volume }));
}

async function keyLevels(db: Db, request: AnalysisRequest) {
  const codes = request.codes ?? [];
  if (!codes.length) throw apiErrors.badRequest("key_levels 必须提供 codes");
  const [daily, minute] = await Promise.all([
    selectBars(db, codes, "day", request.as_of, Math.min(500, request.lookback ?? 120)),
    selectBars(db, codes, "30m", request.as_of, 240),
  ]);
  const dayMap = grouped(daily);
  const minuteMap = grouped(minute);
  const skipped: Array<{ code: string; reason: string }> = [];
  const warnings: Array<{ code: string; reason: string }> = [];
  const items = codes.map((code) => {
    const days = dayMap.get(code) ?? [];
    if (days.length < 20) {
      skipped.push({ code, reason: `日线不足 20 条（${days.length}）` });
      return null;
    }
    const atr = atr14(days);
    const recent = days.slice(-20);
    const support = Math.min(...recent.map((row) => Number(row.low)));
    const resistance = Math.max(...recent.map((row) => Number(row.high)));
    const intraday = minuteMap.get(code) ?? [];
    if (!intraday.length) warnings.push({ code, reason: "缺少 30 分钟线，量价区域仅用日线" });
    return {
      code,
      as_of: days.at(-1)!.bar_date,
      close: Number(days.at(-1)!.close),
      atr14: atr,
      support_20d: support,
      resistance_20d: resistance,
      anchored_vwap: anchoredVwap(days.slice(-60)),
      volume_zones: volumeZones(intraday.length ? intraday : days.slice(-60), atr),
    };
  }).filter(Boolean);
  return { result: { items, skipped, warnings }, gaps: items.length ? [] : skipped,
    input: { requested_codes: codes.length, available_codes: items.length, daily_rows: daily.length, minute30_rows: minute.length } };
}

async function longValuation(db: Db, request: AnalysisRequest) {
  let codes = request.codes ?? [];
  if (!codes.length) {
    const result = await db.query<{ code: string }>(
      `SELECT DISTINCT i.code FROM pool_membership p JOIN market_instrument i ON i.id = p.instrument_id
        WHERE p.effective_to IS NULL ORDER BY i.code`,
    );
    codes = result.rows.map((row) => row.code);
  }
  const rows = await db.query<Record<string, unknown>>(
    `SELECT i.code, i.name,
            v.as_of_date::text AS valuation_date, v.pe_ttm::text, v.pb::text, v.ps_ttm::text,
            v.dividend_yield::text, v.market_cap::text,
            f.as_of_date::text AS fundamental_date, f.report_period::text,
            f.revenue::text, f.net_profit::text, f.operating_cashflow::text,
            f.roe::text, f.gross_margin::text, f.debt_ratio::text
       FROM market_instrument i
       LEFT JOIN LATERAL (SELECT * FROM valuation_snapshot x WHERE x.instrument_id = i.id
         AND ($2::date IS NULL OR x.as_of_date <= $2::date) ORDER BY x.as_of_date DESC LIMIT 1) v ON true
       LEFT JOIN LATERAL (SELECT * FROM fundamental_snapshot x WHERE x.instrument_id = i.id
         AND ($2::date IS NULL OR x.as_of_date <= $2::date) ORDER BY x.as_of_date DESC, x.report_period DESC LIMIT 1) f ON true
      WHERE i.code = ANY($1::text[]) ORDER BY i.code`,
    [codes, request.as_of ?? null],
  );
  const byCode = new Map(rows.rows.map((row) => [String(row.code), row]));
  const skipped: Array<{ code: string; reason: string }> = [];
  const items = codes.map((code) => {
    const row = byCode.get(code);
    const reason = !row ? "标的不存在" : !row.valuation_date ? "缺少估值快照"
      : !row.fundamental_date ? "缺少基本面快照" : null;
    if (reason) {
      skipped.push({ code, reason });
      return null;
    }
    return row;
  }).filter(Boolean);
  return { result: { items, skipped }, gaps: items.length || codes.length === 0 ? [] : skipped,
    input: { requested_codes: codes.length, matched_codes: items.length } };
}

function validateRequest(input: AnalysisRequest): AnalysisRequest {
  if (!ANALYSIS_TYPES.includes(input.analysis_type)) throw apiErrors.badRequest(`未知 analysis_type：${input.analysis_type}`);
  if (input.codes && (input.codes.length > 200 || input.codes.some((code) => !/^[A-Za-z0-9._-]{1,32}$/.test(code)))) {
    throw apiErrors.badRequest("codes 非法或超过 200 项");
  }
  if (input.as_of && !/^\d{4}-\d{2}-\d{2}$/.test(input.as_of)) throw apiErrors.badRequest("as_of 必须是 YYYY-MM-DD");
  if (input.lookback !== undefined && (!Number.isInteger(input.lookback) || input.lookback < 20 || input.lookback > 500)) {
    throw apiErrors.badRequest("lookback 必须是 20–500 的整数");
  }
  return { ...input, codes: input.codes ? [...new Set(input.codes)] : undefined };
}

export async function executeAnalysis(db: Db, raw: AnalysisRequest): Promise<AnalysisRunRow> {
  const request = validateRequest(raw);
  const inserted = await db.query<AnalysisRunRow>(
    `INSERT INTO analysis_run (analysis_type, request_json, service_version)
     VALUES ($1, $2, $3) RETURNING *`,
    [request.analysis_type, JSON.stringify(request), ANALYSIS_SERVICE_VERSION],
  );
  const id = inserted.rows[0]!.id;
  await db.query("UPDATE analysis_run SET status = 'running', started_at = now() WHERE id = $1", [id]);
  try {
    let outcome;
    if (request.analysis_type === "sector_temperature") outcome = await querySectorTemperature(db, request);
    else if (request.analysis_type === "sector_trend_structure") outcome = await querySectorTrendStructure(db, request);
    else if (request.analysis_type === "key_levels") outcome = await keyLevels(db, request);
    else if (request.analysis_type === "long_valuation") outcome = await longValuation(db, request);
    else if (request.analysis_type === "ultra_short_auction") {
      const target = request.as_of ?? new Date().toISOString().slice(0, 10);
      // 必须把数据库传到数据源，否则取数层无法读取已配置的扶摇 API Key。
      const auction = await runUltraShortAuctionCycle(db as unknown as pg.Pool, new Date(), { deps: { db } });
      // 空池/窗口外是有效跳过，不制造数据缺口；只有取数或判定不完整才计 partial。
      outcome = {
        result: { ...auction, status: auction.status, target_date: target },
        gaps: auction.status === "insufficient" || auction.status === "partial" ? auction.gaps : [],
        input: { trade_date: auction.trade_date, stage: auction.stage },
      };
    }
    else {
      const target = request.as_of ?? new Date().toISOString().slice(0, 10);
      const calendar = await db.query<{ open: boolean | null; next_open: string | null; previous_open: string | null }>(
        `SELECT (SELECT is_open FROM market_trading_day WHERE trade_date=$1::date) AS open,
                (SELECT min(trade_date)::text FROM market_trading_day
                  WHERE is_open AND trade_date>$1::date) AS next_open,
                (SELECT max(trade_date)::text FROM market_trading_day
                  WHERE is_open AND trade_date<$1::date) AS previous_open`, [target],
      );
      const day = calendar.rows[0];
      const previousMonthClosed = day?.previous_open && day.previous_open.slice(0, 7) !== target.slice(0, 7);
      const rankDate = request.force || (day?.next_open && day.next_open.slice(0, 7) !== target.slice(0, 7))
        ? target : previousMonthClosed ? day.previous_open! : null;
      if (day?.open !== true) {
        outcome = { result: { status: "unavailable", target_date: target },
          gaps: [{ domain: "calendar", reason: "目标交易日未确认，拒绝生成排名" }], input: { skipped: true } };
      } else if (!rankDate) {
        outcome = { result: { status: "skipped", target_date: target, reason: "尚未确认月末交易日" },
          gaps: [], input: { skipped: true } };
      } else {
        const previous = !request.force && await db.query<AnalysisRunRow>(
          `SELECT run.* FROM analysis_run run JOIN value_rank_snapshot snapshot ON snapshot.analysis_run_id=run.id
            WHERE run.analysis_type='value_monthly_rank' AND run.status IN ('success','partial')
              AND snapshot.rank_date=$1::date
            ORDER BY run.id DESC LIMIT 1`, [rankDate],
        );
        if (previous && previous.rows[0]) {
          const existing = previous.rows[0];
          outcome = { result: { status: "skipped", rank_date: rankDate, existing_run_id: existing.id }, gaps: [],
            input: { reused_analysis_run_id: existing.id, target_date: target } };
        } else {
          outcome = await generateValueMonthlyRank(db, String(id), rankDate);
        }
      }
    }
    const status = outcome.gaps.length ? "partial" : "success";
    const resultHash = crypto.createHash("sha256").update(JSON.stringify(outcome.result)).digest("hex");
    const updated = await db.query<AnalysisRunRow>(
      `UPDATE analysis_run SET status = $2, input_summary = $3, result_json = $4,
              data_gaps = $5, finished_at = now()
        WHERE id = $1 RETURNING *`,
      [id, status, JSON.stringify({ ...outcome.input, result_sha256: resultHash }), JSON.stringify(outcome.result), JSON.stringify(outcome.gaps)],
    );
    return updated.rows[0]!;
  } catch (error) {
    await db.query(
      "UPDATE analysis_run SET status = 'failed', error_message = $2, finished_at = now() WHERE id = $1",
      [id, (error as Error).message],
    );
    throw error;
  }
}

export async function listAnalysisRuns(db: Db, limit = 100): Promise<AnalysisRunRow[]> {
  return (await db.query<AnalysisRunRow>("SELECT * FROM analysis_run ORDER BY id DESC LIMIT $1", [limit])).rows;
}

export async function findAnalysisRun(db: Db, id: string): Promise<AnalysisRunRow | null> {
  return (await db.query<AnalysisRunRow>("SELECT * FROM analysis_run WHERE id = $1", [id])).rows[0] ?? null;
}
