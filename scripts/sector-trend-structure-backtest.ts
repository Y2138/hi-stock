// 独立研究：夜间板块双线趋势策略（左侧结构介入 + 右侧上涨趋势）板块级回测。
// 只读 PostgreSQL market_bar，不写业务台账；结论 research_only。
// 左侧：脱离60日中期下降趋势(斜率口径) ∧ 近期止跌K线 ∧ 温和放量；增强：二次止跌/上下收敛。
// 右侧：收盘>MA20 且 MA20 五日上行 且 温和量比。对照组：旧温度粗筛（温度≥60）。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import type pg from "pg";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import {
  DEFAULT_SECTOR_TREND_PARAMS,
  atr14,
  sectorTrendSnapshot,
  type BottomingPattern,
  type SectorTrendBar,
  type SectorTrendParams,
  type SectorTrendSnapshot,
} from "./lib/sector-trend-rules.js";

const EVAL_START = "2022-01-01";
const COOLDOWN_BARS = 15;
const MAX_POSITIONS = 3;
const INITIAL_CASH = 1_000_000;
const MAX_HOLDING = 60;
const FEE_BPS = 2.5;
const OUT_DIR = path.resolve("支撑/tmp/夜间板块双线趋势回测");
fs.mkdirSync(OUT_DIR, { recursive: true });

type VolumeRequirement = "温和放量" | "明显放量" | "爆量" | "any";
type Regime = "牛市" | "熊市" | "震荡";
type ExitReason = "破前低止损" | "固定止损" | "新下降趋势" | "时间止损" | "移动止损" | "持有上限";

interface BoardSeries {
  code: string;
  name: string;
  bars: SectorTrendBar[];
  dateIndex: Map<string, number>;
}

interface Signal {
  code: string;
  name: string;
  date: string;
  index: number;
  close: number;
  signalHigh: number;
  priorLow: number;
  pattern: BottomingPattern | null;
  volumeRatio: number | null;
  volumeClass: string | null;
  normSlope60: number | null;
  temperature: number | null;
  secondBottom: boolean;
  contracting: boolean;
}

interface EventStats {
  count: number;
  raw_count: number;
  avg5: number | null; median5: number | null;
  avg10: number | null; median10: number | null;
  avg20: number | null; median20: number | null; win_rate20: number | null;
  avg40: number | null; median40: number | null;
  mfe20: number | null; mae20: number | null;
  by_regime: Record<Regime, { count: number; avg20: number | null; median20: number | null; win_rate20: number | null }>;
}

interface PortfolioScenario {
  name: string;
  group: "left" | "right" | "temperature";
  stopPct: number;
  timeStopDays: number;
  useTrail: boolean;
  slipBps: number;
  start: string;
  end: string;
}

interface PortfolioResult {
  name: string;
  total_return: number | null;
  annual_return: number | null;
  max_drawdown: number | null;
  trades: number;
  win_rate: number | null;
  avg_trade_return: number | null;
  avg_holding_days: number | null;
  exposure: number | null;
  exits: Record<string, number>;
  per_year: Record<string, number>;
}

const round = (value: number | null, digits = 4): number | null =>
  value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
const pct = (value: number | null): string => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);
const median = (values: number[]): number | null =>
  values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]! : null;
const average = (values: number[]): number | null => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);

async function loadBoards(pool: pg.Pool): Promise<BoardSeries[]> {
  console.time("板块日线查询");
  const { rows } = await pool.query<{
    code: string; name: string; bar_date: string; open: number; high: number; low: number; close: number; volume: number;
  }>(
    `SELECT i.code, i.name, b.bar_date::text, b.open::float8, b.high::float8, b.low::float8, b.close::float8, b.volume::float8
       FROM market_bar b
       JOIN market_instrument i ON i.id = b.instrument_id
       JOIN market_board mb ON mb.instrument_id = i.id AND mb.active = true
        AND mb.source = 'hithink' AND mb.board_type = 'industry'
      WHERE i.code LIKE '881%.TI' AND b.freq = 'day'
      ORDER BY i.code, b.bar_date`,
  );
  console.timeEnd("板块日线查询");
  const map = new Map<string, BoardSeries>();
  for (const row of rows) {
    let series = map.get(row.code);
    if (!series) {
      series = { code: row.code, name: row.name, bars: [], dateIndex: new Map() };
      map.set(row.code, series);
    }
    const bar: SectorTrendBar = {
      code: row.code, bar_date: row.bar_date, open: Number(row.open), high: Number(row.high),
      low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
    };
    series.bars.push(bar);
    series.dateIndex.set(bar.bar_date, series.bars.length - 1);
  }
  return [...map.values()];
}

/** 881 等权市场环境：合成指数 MA5/MA20 + 5日ROC，与生产 sector_temperature 口径一致。 */
function buildRegime(series: BoardSeries[]): Map<string, Regime> {
  const returnsByDate = new Map<string, { sum: number; count: number }>();
  for (const board of series) {
    for (let i = 1; i < board.bars.length; i += 1) {
      const previous = board.bars[i - 1]!;
      if (previous.close <= 0) continue;
      const entry = returnsByDate.get(board.bars[i]!.bar_date) ?? { sum: 0, count: 0 };
      entry.sum += board.bars[i]!.close / previous.close - 1;
      entry.count += 1;
      returnsByDate.set(board.bars[i]!.bar_date, entry);
    }
  }
  const dates = [...returnsByDate.entries()].filter(([, value]) => value.count >= 60).map(([date]) => date).sort();
  const points: number[] = [];
  const regime = new Map<string, Regime>();
  for (const date of dates) {
    const daily = returnsByDate.get(date)!;
    points.push((points.at(-1) ?? 100) * (1 + daily.sum / daily.count));
    if (points.length < 20) continue;
    const ma5 = average(points.slice(-5))!;
    const ma20 = average(points.slice(-20))!;
    const roc5 = points.at(-1)! / points.at(-6)! - 1;
    regime.set(date, ma5 > ma20 && roc5 > 0 ? "牛市" : ma5 < ma20 && roc5 < 0 ? "熊市" : "震荡");
  }
  return regime;
}

function leftSignals(
  series: BoardSeries[],
  params: SectorTrendParams,
  volume: VolumeRequirement,
  extra?: (snapshot: SectorTrendSnapshot) => boolean,
): Signal[] {
  const signals: Signal[] = [];
  for (const board of series) {
    let lastSignalIndex = -COOLDOWN_BARS;
    for (let i = 0; i < board.bars.length; i += 1) {
      const bar = board.bars[i]!;
      if (bar.bar_date < EVAL_START) continue;
      if (i - lastSignalIndex < COOLDOWN_BARS) continue;
      const snapshot = sectorTrendSnapshot(board.bars, i, params);
      if (!snapshot || !snapshot.escapesMediumDowntrend || !snapshot.recentBottomingPattern) continue;
      if (volume !== "any" && snapshot.volumeClass !== volume) continue;
      if (extra && !extra(snapshot)) continue;
      lastSignalIndex = i;
      signals.push(toSignal(board, bar, i, snapshot));
    }
  }
  return signals.sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
}

function trackSignals(
  series: BoardSeries[],
  params: SectorTrendParams,
  pass: (snapshot: SectorTrendSnapshot) => boolean,
): Signal[] {
  const signals: Signal[] = [];
  for (const board of series) {
    let lastSignalIndex = -COOLDOWN_BARS;
    for (let i = 0; i < board.bars.length; i += 1) {
      const bar = board.bars[i]!;
      if (bar.bar_date < EVAL_START) continue;
      if (i - lastSignalIndex < COOLDOWN_BARS) continue;
      const snapshot = sectorTrendSnapshot(board.bars, i, params);
      if (!snapshot || !pass(snapshot)) continue;
      lastSignalIndex = i;
      signals.push(toSignal(board, bar, i, snapshot));
    }
  }
  return signals.sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
}

function toSignal(board: BoardSeries, bar: SectorTrendBar, index: number, snapshot: SectorTrendSnapshot): Signal {
  return {
    code: board.code, name: board.name, date: bar.bar_date, index, close: bar.close,
    signalHigh: bar.high, priorLow: snapshot.priorLow ?? bar.low, pattern: snapshot.recentBottomingPattern,
    volumeRatio: snapshot.volumeRatio, volumeClass: snapshot.volumeClass, normSlope60: snapshot.normSlope60,
    temperature: snapshot.temperature, secondBottom: snapshot.secondBottom, contracting: snapshot.contracting,
  };
}

function countRaw(
  series: BoardSeries[],
  params: SectorTrendParams,
  volume: VolumeRequirement,
  extra?: (snapshot: SectorTrendSnapshot) => boolean,
): number {
  let count = 0;
  for (const board of series) {
    for (let i = 0; i < board.bars.length; i += 1) {
      if (board.bars[i]!.bar_date < EVAL_START) continue;
      const snapshot = sectorTrendSnapshot(board.bars, i, params);
      if (!snapshot || !snapshot.escapesMediumDowntrend || !snapshot.recentBottomingPattern) continue;
      if (volume !== "any" && snapshot.volumeClass !== volume) continue;
      if (extra && !extra(snapshot)) continue;
      count += 1;
    }
  }
  return count;
}

function forwardReturns(board: BoardSeries, signal: Signal, horizon: number): number | null {
  const target = board.bars[signal.index + horizon];
  const entry = board.bars[signal.index + 1];
  if (!target || !entry || entry.open <= 0) return null;
  return target.close / entry.open - 1;
}

function eventStats(
  series: BoardSeries[],
  signals: Signal[],
  regime: Map<string, Regime>,
  rawCount: number,
): EventStats {
  const byCode = new Map(series.map((board) => [board.code, board]));
  const windows: Record<"5" | "10" | "20" | "40", number[]> = { "5": [], "10": [], "20": [], "40": [] };
  const mfe: number[] = [];
  const mae: number[] = [];
  const regimeReturns: Record<Regime, number[]> = { 牛市: [], 熊市: [], 震荡: [] };
  for (const signal of signals) {
    const board = byCode.get(signal.code)!;
    const entry = board.bars[signal.index + 1];
    if (!entry || entry.open <= 0) continue;
    for (const horizon of ["5", "10", "20", "40"] as const) {
      const value = forwardReturns(board, signal, Number(horizon));
      if (value !== null) windows[horizon].push(value);
    }
    const future = board.bars.slice(signal.index + 1, signal.index + 21);
    if (future.length) {
      mfe.push(Math.max(...future.map((bar) => bar.high)) / entry.open - 1);
      mae.push(Math.min(...future.map((bar) => bar.low)) / entry.open - 1);
    }
    const state = regime.get(signal.date);
    const fwd20 = forwardReturns(board, signal, 20);
    if (state && fwd20 !== null) regimeReturns[state].push(fwd20);
  }
  const byRegime = {} as EventStats["by_regime"];
  for (const state of ["牛市", "熊市", "震荡"] as const) {
    const values = regimeReturns[state];
    byRegime[state] = {
      count: values.length,
      avg20: round(average(values)),
      median20: round(median(values)),
      win_rate20: values.length ? round(values.filter((value) => value > 0).length / values.length) : null,
    };
  }
  return {
    count: signals.length,
    raw_count: rawCount,
    avg5: round(average(windows["5"])), median5: round(median(windows["5"])),
    avg10: round(average(windows["10"])), median10: round(median(windows["10"])),
    avg20: round(average(windows["20"])), median20: round(median(windows["20"])),
    win_rate20: windows["20"].length ? round(windows["20"].filter((value) => value > 0).length / windows["20"].length) : null,
    avg40: round(average(windows["40"])), median40: round(median(windows["40"])),
    mfe20: round(average(mfe)), mae20: round(average(mae)),
    by_regime: byRegime,
  };
}

interface Position {
  code: string;
  entryPrice: number;
  stop: number;
  atr: number;
  signalHigh: number;
  priorLow: number;
  entryBarIndex: number;
  peak: number;
  lastClose: number;
}

interface TradeRecord {
  code: string; entryDate: string; exitDate: string; returnPct: number; holdingDays: number; reason: ExitReason;
}

/** 逐日盯市组合模拟：等权三槽、同板块一仓、次日开盘出入场、收盘判定次日开盘退出。 */
function simulatePortfolio(
  series: BoardSeries[],
  signals: Signal[],
  scenario: PortfolioScenario,
  allDates: string[],
): { result: PortfolioResult; trades: TradeRecord[] } {
  const byCode = new Map(series.map((board) => [board.code, board]));
  const signalsByDate = new Map<string, Signal[]>();
  for (const signal of signals) {
    signalsByDate.set(signal.date, [...(signalsByDate.get(signal.date) ?? []), signal]);
  }
  const slotCapital = INITIAL_CASH / MAX_POSITIONS;
  const costRate = (FEE_BPS + scenario.slipBps) / 10_000;
  const positions = new Map<string, Position>();
  const pendingBuys: Signal[] = [];
  const pendingSells = new Map<string, ExitReason>();
  const trades: TradeRecord[] = [];
  const exits: Record<string, number> = {};
  const equityPoints: number[] = [];
  const perYear: Record<string, number> = {};
  let cash = INITIAL_CASH;
  let exposureSum = 0;
  let dayCount = 0;
  let previous = INITIAL_CASH;
  const dates = allDates.filter((date) => date >= scenario.start && date <= scenario.end);
  for (const date of dates) {
    // 开盘：先卖后买
    for (const [code, reason] of [...pendingSells.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const position = positions.get(code);
      const board = byCode.get(code);
      if (!position || !board) { pendingSells.delete(code); continue; }
      const barIndex = board.dateIndex.get(date);
      const exitBar = barIndex === undefined ? null : board.bars[barIndex]!;
      const exitPrice = exitBar ? exitBar.open * (1 - costRate) : position.lastClose * (1 - costRate);
      cash += slotCapital * (exitPrice / position.entryPrice);
      positions.delete(code);
      pendingSells.delete(code);
      const holdingDays = (barIndex ?? position.entryBarIndex) - position.entryBarIndex;
      trades.push({
        code, entryDate: board.bars[position.entryBarIndex]!.bar_date, exitDate: date,
        returnPct: exitPrice / position.entryPrice - 1, holdingDays, reason,
      });
      exits[reason] = (exits[reason] ?? 0) + 1;
    }
    const occupiedBoards = new Set(positions.keys());
    for (const signal of pendingBuys) {
      if (positions.size >= MAX_POSITIONS) break;
      if (positions.has(signal.code) || occupiedBoards.has(signal.code)) continue;
      const board = byCode.get(signal.code)!;
      const barIndex = board.dateIndex.get(date);
      if (barIndex === undefined) continue;
      const bar = board.bars[barIndex]!;
      if (bar.open <= 0 || bar.open > signal.close * 1.03) continue;
      const entryPrice = bar.open * (1 + costRate);
      cash -= slotCapital;
      positions.set(signal.code, {
        code: signal.code, entryPrice,
        stop: Math.max(signal.priorLow, entryPrice * (1 - scenario.stopPct)),
        atr: atr14(board.bars, barIndex - 1) ?? entryPrice * 0.05,
        signalHigh: signal.signalHigh, priorLow: signal.priorLow,
        entryBarIndex: barIndex, peak: bar.close, lastClose: bar.close,
      });
      occupiedBoards.add(signal.code);
    }
    pendingBuys.length = 0;
    // 收盘：盯市并判定退出
    let marketValue = 0;
    for (const position of positions.values()) {
      const board = byCode.get(position.code)!;
      const barIndex = board.dateIndex.get(date);
      const bar = barIndex === undefined ? null : board.bars[barIndex]!;
      if (bar) {
        position.lastClose = bar.close;
        position.peak = Math.max(position.peak, bar.close);
        const snapshot = sectorTrendSnapshot(board.bars, barIndex!, DEFAULT_SECTOR_TREND_PARAMS);
        const newDowntrend = snapshot !== null && snapshot.normSlope10 !== null && snapshot.normSlope10 < 0 &&
          snapshot.ma10 !== null && bar.close < snapshot.ma10;
        const holdingDays = barIndex! - position.entryBarIndex;
        const trail = scenario.useTrail
          ? Math.max(position.stop, position.peak - Math.max(position.peak * 0.08, 3 * position.atr))
          : Number.NEGATIVE_INFINITY;
        const reason: ExitReason | null =
          bar.close <= position.stop ? (position.stop === position.priorLow ? "破前低止损" : "固定止损")
            : scenario.useTrail && bar.close <= trail ? "移动止损"
              : newDowntrend ? "新下降趋势"
                : holdingDays >= scenario.timeStopDays && position.peak < position.signalHigh ? "时间止损"
                  : holdingDays >= MAX_HOLDING ? "持有上限" : null;
        if (reason) pendingSells.set(position.code, reason);
      }
      marketValue += slotCapital * (position.lastClose / position.entryPrice);
    }
    // 收盘后登记明日买入（今日信号次日开盘成交）
    const candidates = (signalsByDate.get(date) ?? [])
      .filter((signal) => !positions.has(signal.code) && !pendingSells.has(signal.code) && ![...pendingBuys].some((buy) => buy.code === signal.code));
    pendingBuys.push(...candidates.slice(0, MAX_POSITIONS));
    const equity = cash + marketValue;
    equityPoints.push(equity);
    exposureSum += positions.size / MAX_POSITIONS;
    dayCount += 1;
    const year = date.slice(0, 4);
    perYear[year] = (perYear[year] ?? 1) * equity / previous;
    previous = equity;
  }
  const finalEquity = equityPoints.at(-1) ?? INITIAL_CASH;
  const totalReturn = equityPoints.length ? finalEquity / INITIAL_CASH - 1 : null;
  let peak = INITIAL_CASH;
  let maxDrawdown = 0;
  for (const point of equityPoints) {
    peak = Math.max(peak, point);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - point) / peak : 0);
  }
  const returns = trades.map((trade) => trade.returnPct);
  for (const year of Object.keys(perYear)) perYear[year] = round(perYear[year]! - 1)!;
  return {
    result: {
      name: scenario.name,
      total_return: round(totalReturn),
      annual_return: totalReturn === null || !equityPoints.length ? null
        : round(Math.pow(1 + totalReturn, 252 / Math.max(1, dayCount)) - 1),
      max_drawdown: round(maxDrawdown),
      trades: trades.length,
      win_rate: trades.length ? round(returns.filter((value) => value > 0).length / trades.length) : null,
      avg_trade_return: round(average(returns)),
      avg_holding_days: round(average(trades.map((trade) => trade.holdingDays)), 1),
      exposure: dayCount ? round(exposureSum / dayCount) : null,
      exits,
      per_year: perYear,
    },
    trades,
  };
}

function printEventTable(title: string, groups: Array<[string, EventStats]>): void {
  console.log(`\n## ${title}`);
  console.log("组\t样本\t均值5\t均值10\t均值20\t中位20\t胜率20\t均值40\tMFE20\tMAE20\t牛20\t震荡20\t熊20");
  for (const [name, stats] of groups) {
    const regime = (state: Regime) => {
      const item = stats.by_regime[state];
      return `${item.count}@${pct(item.avg20)}`;
    };
    console.log([
      name, stats.count, pct(stats.avg5), pct(stats.avg10), pct(stats.avg20), pct(stats.median20),
      pct(stats.win_rate20), pct(stats.avg40), pct(stats.mfe20), pct(stats.mae20),
      regime("牛市"), regime("震荡"), regime("熊市"),
    ].join("\t"));
  }
}

async function main(): Promise<void> {
  const pool = getPool(loadConfig().databaseUrl);
  const series = await loadBoards(pool);
  const allDates = [...new Set(series.flatMap((board) => board.bars.map((bar) => bar.bar_date)))].sort();
  const endDate = allDates.at(-1)!;
  const regime = buildRegime(series);
  console.log(`板块 ${series.length} 个，${allDates[0]} ~ ${endDate}，共 ${series.reduce((sum, board) => sum + board.bars.length, 0)} 根日线；评估区间 ${EVAL_START} 起。`);

  const base = DEFAULT_SECTOR_TREND_PARAMS;

  // —— 主分组：左侧线（含量能消融）、右侧线、温度对照 ——
  const leftMild = leftSignals(series, base, "温和放量");
  const secondBottom = leftMild.filter((signal) => signal.secondBottom);
  const contracting = leftMild.filter((signal) => signal.contracting);
  const enhanced = leftMild.filter((signal) => signal.secondBottom || signal.contracting);
  const byPattern = (pattern: BottomingPattern) => leftMild.filter((signal) => signal.pattern === pattern);
  const right = trackSignals(series, base, (snapshot) => snapshot.rightTrack);
  const temperatureControl = trackSignals(series, base, (snapshot) => snapshot.temperature !== null && snapshot.temperature >= 60);

  const mainGroups: Array<[string, EventStats]> = [
    ["L基础_温和放量", eventStats(series, leftMild, regime, countRaw(series, base, "温和放量"))],
    ["L形态_阳包阴", eventStats(series, byPattern("阳包阴"), regime, byPattern("阳包阴").length)],
    ["L形态_金针探底", eventStats(series, byPattern("金针探底"), regime, byPattern("金针探底").length)],
    ["L形态_双日止跌", eventStats(series, byPattern("双日止跌"), regime, byPattern("双日止跌").length)],
    ["L增强_二次止跌", eventStats(series, secondBottom, regime, secondBottom.length)],
    ["L增强_上下收敛", eventStats(series, contracting, regime, contracting.length)],
    ["L增强_二者其一", eventStats(series, enhanced, regime, enhanced.length)],
    ["L消融_明显放量", eventStats(series, leftSignals(series, base, "明显放量"), regime, countRaw(series, base, "明显放量"))],
    ["L消融_爆量", eventStats(series, leftSignals(series, base, "爆量"), regime, countRaw(series, base, "爆量"))],
    ["L消融_无量条件", eventStats(series, leftSignals(series, base, "any"), regime, countRaw(series, base, "any"))],
    ["R右侧线", eventStats(series, right, regime, right.length)],
    ["对照_温度≥60", eventStats(series, temperatureControl, regime, temperatureControl.length)],
  ];
  printEventTable("主分组事件研究（入场=次日开盘，冷却15日）", mainGroups);

  // —— OAT 阈值矩阵 ——
  const slopeVariants = [-0.05, -0.08, -0.12].map((threshold) => {
    const params = { ...base, mediumSlopeThreshold: threshold };
    const key = `斜率阈值${(threshold * 100).toFixed(0)}%`;
    return [key, eventStats(series, leftSignals(series, params, "温和放量"), regime, countRaw(series, params, "温和放量"))] as [string, EventStats];
  });
  printEventTable("OAT：中期斜率阈值（其余默认）", slopeVariants);

  const lookbackVariants = [5, 10, 15].map((days) => {
    const params = { ...base, bottomingLookback: days };
    const key = `止跌回看${days}日`;
    return [key, eventStats(series, leftSignals(series, params, "温和放量"), regime, countRaw(series, params, "温和放量"))] as [string, EventStats];
  });
  printEventTable("OAT：止跌K线回看窗口", lookbackVariants);

  const toleranceVariants = [0.95, 0.97, 1.00].map((tolerance) => {
    const params = { ...base, secondBottomTolerance: tolerance };
    const extra = (snapshot: SectorTrendSnapshot) => snapshot.secondBottom;
    const key = `回踩容差${tolerance.toFixed(2)}`;
    return [key, eventStats(series, leftSignals(series, params, "温和放量", extra), regime, countRaw(series, params, "温和放量", extra))] as [string, EventStats];
  });
  printEventTable("OAT：二次止跌回踩容差", toleranceVariants);

  const contractionVariants = [0.70, 0.75, 0.85].map((ratio) => {
    const params = { ...base, contractionRatioMax: ratio };
    const extra = (snapshot: SectorTrendSnapshot) => snapshot.contracting;
    const key = `收敛比≤${ratio.toFixed(2)}`;
    return [key, eventStats(series, leftSignals(series, params, "温和放量", extra), regime, countRaw(series, params, "温和放量", extra))] as [string, EventStats];
  });
  printEventTable("OAT：上下收敛振幅比", contractionVariants);

  // —— 组合模拟 ——
  const signalGroups = { left: leftMild, right, temperature: temperatureControl };
  const portfolioScenarios: PortfolioScenario[] = [
    { name: "左侧核心_止损8_时间15", group: "left", stopPct: 0.08, timeStopDays: 15, useTrail: false, slipBps: 10, start: EVAL_START, end: endDate },
    { name: "左侧_止损10_时间15", group: "left", stopPct: 0.10, timeStopDays: 15, useTrail: false, slipBps: 10, start: EVAL_START, end: endDate },
    { name: "左侧_止损8_时间10", group: "left", stopPct: 0.08, timeStopDays: 10, useTrail: false, slipBps: 10, start: EVAL_START, end: endDate },
    { name: "左侧_止损8_时间20", group: "left", stopPct: 0.08, timeStopDays: 20, useTrail: false, slipBps: 10, start: EVAL_START, end: endDate },
    { name: "左侧_移动止损变体", group: "left", stopPct: 0.08, timeStopDays: 20, useTrail: true, slipBps: 10, start: EVAL_START, end: endDate },
    { name: "左侧_压力30bp", group: "left", stopPct: 0.08, timeStopDays: 15, useTrail: false, slipBps: 30, start: EVAL_START, end: endDate },
    { name: "左侧_前窗至2023", group: "left", stopPct: 0.08, timeStopDays: 15, useTrail: false, slipBps: 10, start: EVAL_START, end: "2023-12-31" },
    { name: "左侧_后窗2024起", group: "left", stopPct: 0.08, timeStopDays: 15, useTrail: false, slipBps: 10, start: "2024-01-01", end: endDate },
    { name: "右侧线_止损8_时间15", group: "right", stopPct: 0.08, timeStopDays: 15, useTrail: false, slipBps: 10, start: EVAL_START, end: endDate },
    { name: "温度对照_止损8_时间15", group: "temperature", stopPct: 0.08, timeStopDays: 15, useTrail: false, slipBps: 10, start: EVAL_START, end: endDate },
  ];
  const portfolioResults: PortfolioResult[] = [];
  for (const scenario of portfolioScenarios) {
    portfolioResults.push(simulatePortfolio(series, signalGroups[scenario.group], scenario, allDates).result);
  }
  console.log("\n## 组合模拟（等权三槽、同板块一仓、次日开盘出入场、费用2.5bp+滑点）");
  console.log("配置\t总收益\t年化\t回撤\t交易\t胜率\t均笔\t持有日\t暴露\t退出分布");
  for (const result of portfolioResults) {
    console.log([
      result.name, pct(result.total_return), pct(result.annual_return), pct(result.max_drawdown),
      result.trades, pct(result.win_rate), pct(result.avg_trade_return), result.avg_holding_days ?? "-",
      pct(result.exposure),
      Object.entries(result.exits).map(([reason, count]) => `${reason}${count}`).join(","),
    ].join("\t"));
  }

  const inputHash = createHash("sha256").update(JSON.stringify({
    boards: series.map((board) => [board.code, board.bars.length, board.bars[0]?.bar_date, board.bars.at(-1)?.bar_date]),
    evalStart: EVAL_START, params: base, cooldown: COOLDOWN_BARS,
  })).digest("hex");
  const output = path.join(OUT_DIR, `夜间板块双线趋势-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.json`);
  fs.writeFileSync(output, JSON.stringify({
    strategy: "夜间板块双线趋势策略v1（左侧结构介入优先+右侧上涨趋势）",
    evidence: "research_only",
    range: { start: EVAL_START, end: endDate, data_from: allDates[0] },
    input_hash: inputHash,
    methodology: {
      left_base: "中期下降趋势(60日OLS归一化斜率≤-8%)背景下，收盘上穿60日回归趋势线且10日斜率转正；近10日出现止跌K线（阳包阴/金针探底/双日止跌，生产口径）；量比温和[1.0,1.5)",
      enhanced: "二次止跌=首次止跌K线后5–20日回踩不破锚定低点×0.97；上下收敛=20/40日振幅比≤0.75且高降低抬且收盘>MA10",
      right: "收盘>MA20 且 MA20五日上行 且 量比<1.5",
      control: "温度≥60（旧理论粗筛代理，温度=收盘对MA20乖离线性映射0–100）",
      exits: "止损=max(前低,入场价×(1-档))；新下降趋势=10日斜率转负且跌破MA10；时间止损=N日未升破信号K线高点；上限60日",
      portfolio: "等权三槽、同板块一仓、次日开盘出入场(跳空>3%放弃入场)、费用2.5bp+滑点10bp(压力30bp)、板块指数代理",
    },
    caveats: [
      "板块指数为代理标的，实际须经个股/ETF落地，成交约束未建模",
      "881行业构成与成分为当前时点回看，存在幸存者偏差",
      "2021-09前无真实板块日线，评估自2022-01起、初期窗口较短",
      "温度对照组是阈值粗筛代理，非旧Agent提示词的完整多因子选择",
      "全区间参数扫描无真正样本外，阈值须保守取用",
    ],
    defaults: base,
    groups: Object.fromEntries(mainGroups),
    oat: {
      slope: Object.fromEntries(slopeVariants),
      lookback: Object.fromEntries(lookbackVariants),
      tolerance: Object.fromEntries(toleranceVariants),
      contraction: Object.fromEntries(contractionVariants),
    },
    portfolios: portfolioResults,
    left_sample_signals: leftMild.slice(0, 200),
  }, null, 2));
  console.log(`\n结果已写入 ${output}`);
  await closePool();
}

await main();
