// 独立研究：夜间板块左侧趋势策略（生产参数）退出条件校准。
// 信号 = 脱离60日中期下降趋势 ∧ 近15日止跌K线 ∧ 量比<1.5（缩量或温和，排除明显/爆量）。
// 焦点：初始止损档、新下降趋势退出（敏感度/延迟）、时间止损、移动止损的逐维对比与组合。
// 只读 PostgreSQL market_bar，不写业务台账；结论 research_only。
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
  type SectorTrendBar,
  type SectorTrendParams,
  type SectorTrendSnapshot,
} from "./lib/sector-trend-rules.js";

const EVAL_START = "2022-01-01";
const COOLDOWN_BARS = 15;
const FEE_BPS = 2.5;
const SLIP_BPS = 10;
const MAX_SCAN_DAYS = 80;
const OUT_DIR = path.resolve("支撑/tmp/夜间板块双线趋势回测");
fs.mkdirSync(OUT_DIR, { recursive: true });

/** 第一阶段结论校准后的生产参数：止跌回看15日、收敛比0.85（仅作标签）；量能上界在信号层执行。 */
const PRODUCTION_PARAMS: SectorTrendParams = {
  ...DEFAULT_SECTOR_TREND_PARAMS,
  bottomingLookback: 15,
  contractionRatioMax: 0.85,
};

type StopMode = "prior_low_8" | "prior_low_10" | "prior_low_only" | "none";
type TrendExit = "single" | "ma10_2d" | "ma10_3d" | "ma10_2d_delay5" | "ma10_2d_delay10" | "none";
type Trail = "none" | "atr" | "ma20" | "pct10";

interface ExitConfig {
  name: string;
  fixedHoldDays?: number;
  stopMode: StopMode;
  trendExit: TrendExit;
  timeStopDays: number | null;
  trail: Trail;
  maxHolding: number;
}

interface Signal {
  code: string;
  name: string;
  date: string;
  index: number;
  close: number;
  signalHigh: number;
  priorLow: number;
  pattern: NonNullable<SectorTrendSnapshot["recentBottomingPattern"]>;
  volumeRatio: number;
  secondBottom: boolean;
  contracting: boolean;
}

interface TradeRecord {
  code: string; entryDate: string; exitDate: string; returnPct: number; holdingDays: number;
  reason: string; pattern: string;
}

interface ConfigStats {
  name: string;
  trades: number;
  win_rate: number | null;
  avg_return: number | null;
  median_return: number | null;
  profit_factor: number | null;
  avg_holding: number | null;
  geo_mean: number | null;
  exits: Record<string, number>;
}

interface BoardSeries {
  code: string;
  name: string;
  bars: SectorTrendBar[];
}

const round = (value: number | null, digits = 4): number | null =>
  value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
const pct = (value: number | null): string => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);
const median = (values: number[]): number | null =>
  values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]! : null;
const average = (values: number[]): number | null => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);

async function loadBoards(pool: pg.Pool): Promise<BoardSeries[]> {
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
  const map = new Map<string, BoardSeries>();
  for (const row of rows) {
    let series = map.get(row.code);
    if (!series) {
      series = { code: row.code, name: row.name, bars: [] };
      map.set(row.code, series);
    }
    series.bars.push({
      code: row.code, bar_date: row.bar_date, open: Number(row.open), high: Number(row.high),
      low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
    });
  }
  return [...map.values()];
}

/** 生产信号：脱离 ∧ 近15日止跌形态 ∧ 量比<1.5。一级形态 = 阳包阴/双日止跌。 */
function collectSignals(series: BoardSeries[]): Signal[] {
  const signals: Signal[] = [];
  for (const board of series) {
    let lastSignalIndex = -COOLDOWN_BARS;
    for (let i = 0; i < board.bars.length; i += 1) {
      const bar = board.bars[i]!;
      if (bar.bar_date < EVAL_START) continue;
      if (i - lastSignalIndex < COOLDOWN_BARS) continue;
      const snapshot = sectorTrendSnapshot(board.bars, i, PRODUCTION_PARAMS);
      if (!snapshot || !snapshot.escapesMediumDowntrend || !snapshot.recentBottomingPattern) continue;
      if (snapshot.volumeRatio === null || snapshot.volumeRatio >= PRODUCTION_PARAMS.mildVolumeMax) continue;
      lastSignalIndex = i;
      signals.push({
        code: board.code, name: board.name, date: bar.bar_date, index: i, close: bar.close,
        signalHigh: bar.high, priorLow: snapshot.priorLow ?? bar.low,
        pattern: snapshot.recentBottomingPattern, volumeRatio: snapshot.volumeRatio,
        secondBottom: snapshot.secondBottom, contracting: snapshot.contracting,
      });
    }
  }
  return signals.sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
}

function stopPriceOf(mode: StopMode, priorLow: number, entryPrice: number): number {
  if (mode === "none") return Number.NEGATIVE_INFINITY;
  if (mode === "prior_low_only") return priorLow;
  return Math.max(priorLow, entryPrice * (1 - (mode === "prior_low_8" ? 0.08 : 0.10)));
}

function trendExitTriggered(kind: TrendExit, snapshot: SectorTrendSnapshot | null, close: number, belowMa10Streak: number, holdingDays: number): boolean {
  if (kind === "none") return false;
  if (snapshot?.ma10 === null || snapshot?.ma10 === undefined) return false;
  switch (kind) {
    case "single":
      return snapshot.normSlope10 !== null && snapshot.normSlope10 < 0 && close < snapshot.ma10;
    case "ma10_2d":
      return belowMa10Streak >= 2;
    case "ma10_3d":
      return belowMa10Streak >= 3;
    case "ma10_2d_delay5":
      return holdingDays >= 5 && belowMa10Streak >= 2;
    case "ma10_2d_delay10":
      return holdingDays >= 10 && belowMa10Streak >= 2;
  }
}

function simulateTrade(board: BoardSeries, signal: Signal, config: ExitConfig): TradeRecord | null {
  const costRate = (FEE_BPS + SLIP_BPS) / 10_000;
  const entryBar = board.bars[signal.index + 1];
  if (!entryBar || entryBar.open <= 0 || entryBar.open > signal.close * 1.03) return null;
  const entryPrice = entryBar.open * (1 + costRate);
  const atr = atr14(board.bars, signal.index) ?? entryPrice * 0.05;
  const stop = stopPriceOf(config.stopMode, signal.priorLow, entryPrice);
  const maxHolding = config.fixedHoldDays ?? config.maxHolding;
  let peak = entryBar.close;
  let belowMa10Streak = 0;
  let reason = "持有上限";
  let exitIndex = Math.min(signal.index + maxHolding, board.bars.length - 1);
  for (let i = signal.index + 1; i < board.bars.length && i <= signal.index + Math.max(maxHolding, MAX_SCAN_DAYS); i += 1) {
    const bar = board.bars[i]!;
    peak = Math.max(peak, bar.close);
    const holdingDays = i - signal.index;
    const snapshot = sectorTrendSnapshot(board.bars, i, PRODUCTION_PARAMS);
    belowMa10Streak = snapshot?.ma10 != null && bar.close < snapshot.ma10 ? belowMa10Streak + 1 : 0;
    // 保护性规则优先于时间退出；全部按次日开盘成交
    if (bar.close <= stop) {
      reason = stop === signal.priorLow ? "破前低止损" : "固定止损";
      exitIndex = i;
      break;
    }
    const trailLine = config.trail === "atr" ? peak - Math.max(peak * 0.08, 3 * atr)
      : config.trail === "pct10" ? peak * 0.90
        : null;
    if (config.trail === "ma20") {
      if (snapshot?.ma20 != null && bar.close < snapshot.ma20) { reason = "移动止损(MA20)"; exitIndex = i; break; }
    } else if (trailLine !== null && bar.close <= trailLine) {
      reason = config.trail === "atr" ? "移动止损(ATR)" : "移动止损(10%)";
      exitIndex = i;
      break;
    }
    if (trendExitTriggered(config.trendExit, snapshot, bar.close, belowMa10Streak, holdingDays)) {
      reason = "新下降趋势";
      exitIndex = i;
      break;
    }
    if (config.fixedHoldDays !== undefined && holdingDays >= config.fixedHoldDays) {
      reason = "时间退出(固定)";
      exitIndex = i;
      break;
    }
    if (config.timeStopDays !== null && holdingDays >= config.timeStopDays && peak < signal.signalHigh) {
      reason = "时间止损";
      exitIndex = i;
      break;
    }
    if (holdingDays >= config.maxHolding) { reason = "持有上限"; exitIndex = i; break; }
  }
  const exitBar = board.bars[exitIndex + 1] ?? board.bars[exitIndex]!;
  const exitPrice = exitBar.open * (1 - costRate);
  return {
    code: signal.code, entryDate: entryBar.bar_date, exitDate: exitBar.bar_date,
    returnPct: exitPrice / entryPrice - 1, holdingDays: exitIndex - signal.index,
    reason, pattern: signal.pattern,
  };
}

function statsOf(name: string, trades: TradeRecord[]): ConfigStats {
  const returns = trades.map((trade) => trade.returnPct);
  const winsSum = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const lossesSum = returns.filter((value) => value <= 0).reduce((sum, value) => sum + value, 0);
  const exits: Record<string, number> = {};
  for (const trade of trades) exits[trade.reason] = (exits[trade.reason] ?? 0) + 1;
  const compound = returns.reduce((product, value) => product * (1 + value), 1);
  return {
    name,
    trades: trades.length,
    win_rate: trades.length ? round(returns.filter((value) => value > 0).length / trades.length) : null,
    avg_return: round(average(returns)),
    median_return: round(median(returns)),
    profit_factor: lossesSum < 0 ? round(winsSum / Math.abs(lossesSum), 2) : winsSum > 0 ? null : 0,
    avg_holding: round(average(trades.map((trade) => trade.holdingDays)), 1),
    geo_mean: returns.length ? round(Math.pow(compound, 1 / returns.length) - 1) : null,
    exits,
  };
}

function printTable(title: string, rows: ConfigStats[]): void {
  console.log(`\n## ${title}`);
  console.log("配置\t笔数\t胜率\t均笔\t中位\t盈亏比\t持有日\t几何均笔\t退出分布");
  for (const row of rows) {
    console.log([
      row.name, row.trades, pct(row.win_rate), pct(row.avg_return), pct(row.median_return),
      row.profit_factor === null ? "-" : String(row.profit_factor), row.avg_holding ?? "-", pct(row.geo_mean),
      Object.entries(row.exits).map(([reason, count]) => `${reason}${count}`).join(","),
    ].join("\t"));
  }
}

async function main(): Promise<void> {
  const pool = getPool(loadConfig().databaseUrl);
  const series = await loadBoards(pool);
  const byCode = new Map(series.map((board) => [board.code, board]));
  const signals = collectSignals(series);
  const firstRate = signals.length ? signals.filter((signal) => signal.pattern !== "金针探底").length : 0;
  console.log(`生产信号 ${signals.length} 笔（其中一级形态 ${firstRate} 笔），评估区间 ${EVAL_START} 起。`);

  const run = (config: ExitConfig, subset?: (signal: Signal) => boolean): ConfigStats => {
    const trades: TradeRecord[] = [];
    for (const signal of signals) {
      if (subset && !subset(signal)) continue;
      const trade = simulateTrade(byCode.get(signal.code)!, signal, config);
      if (trade) trades.push(trade);
    }
    return statsOf(config.name, trades);
  };
  const core: ExitConfig = {
    name: "核心", stopMode: "prior_low_8", trendExit: "ma10_2d_delay5", timeStopDays: null, trail: "none", maxHolding: 40,
  };
  const variant = (name: string, overrides: Partial<ExitConfig>): ExitConfig => ({ ...core, name, ...overrides });

  // 锚点：固定持有（无任何退出规则）
  const anchors = [
    variant("锚点_固定持有10日", { fixedHoldDays: 10, stopMode: "none", trendExit: "none", trail: "none", timeStopDays: null, maxHolding: 10 }),
    variant("锚点_固定持有20日", { fixedHoldDays: 20, stopMode: "none", trendExit: "none", trail: "none", timeStopDays: null, maxHolding: 20 }),
    variant("锚点_固定持有40日", { fixedHoldDays: 40, stopMode: "none", trendExit: "none", trail: "none", timeStopDays: null, maxHolding: 40 }),
  ].map((config) => run(config));
  printTable("锚点：固定持有（无退出规则，含费用滑点，次日出）", anchors);

  // OAT：初始止损档
  printTable("OAT：初始止损档（核心=前低8%档/延迟5日MA10/无时间/无移动/上限40）", [
    run(core),
    run(variant("止损_前低10%档", { stopMode: "prior_low_10" })),
    run(variant("止损_仅前低", { stopMode: "prior_low_only" })),
  ]);

  // OAT：新下降趋势退出（第一阶段证明单日版过于敏感，本组是校准重点）
  printTable("OAT：新下降趋势退出", [
    run(core),
    run(variant("趋势_单日斜率+破MA10", { trendExit: "single" })),
    run(variant("趋势_连续2日破MA10", { trendExit: "ma10_2d" })),
    run(variant("趋势_连续3日破MA10", { trendExit: "ma10_3d" })),
    run(variant("趋势_延迟5日+2日破MA10", { trendExit: "ma10_2d_delay5" })),
    run(variant("趋势_延迟10日+2日破MA10", { trendExit: "ma10_2d_delay10" })),
    run(variant("趋势_不启用", { trendExit: "none" })),
  ]);

  // OAT：时间止损
  printTable("OAT：时间止损（N日未升破信号高点）", [
    run(core),
    run(variant("时间_10日", { timeStopDays: 10 })),
    run(variant("时间_15日", { timeStopDays: 15 })),
    run(variant("时间_20日", { timeStopDays: 20 })),
    run(variant("时间_30日", { timeStopDays: 30 })),
  ]);

  // OAT：移动止损
  printTable("OAT：移动止损", [
    run(core),
    run(variant("移动_ATR(峰值-8%/3ATR)", { trail: "atr" })),
    run(variant("移动_MA20跟随", { trail: "ma20" })),
    run(variant("移动_峰值回撤10%", { trail: "pct10" })),
  ]);

  // 组合候选
  const combos = [
    variant("组合_让利润跑_MA20跟随", { trendExit: "none", trail: "ma20", maxHolding: 60 }),
    variant("组合_趋势_2日破MA10", { trendExit: "ma10_2d", maxHolding: 60 }),
    variant("组合_延迟5日MA10+ATR移动", { trail: "atr" }),
    variant("组合_延迟5日MA10+20日时间", { timeStopDays: 20 }),
    variant("组合_MA20跟随+20日时间", { trendExit: "none", trail: "ma20", timeStopDays: 20, maxHolding: 60 }),
  ].map((config) => run(config));
  printTable("组合候选", combos);

  // 混合退出：固定时间持有 + 保护性止损/趋势退出（逐维对比的重点补充）
  const hybrids = [
    variant("混合_20日+前低8%保护", { fixedHoldDays: 20, trendExit: "none", trail: "none", timeStopDays: null, maxHolding: 20 }),
    variant("混合_20日+仅前低保护", { fixedHoldDays: 20, stopMode: "prior_low_only", trendExit: "none", trail: "none", timeStopDays: null, maxHolding: 20 }),
    variant("混合_20日+前低8%+MA10三连", { fixedHoldDays: 20, trendExit: "ma10_3d", trail: "none", timeStopDays: null, maxHolding: 20 }),
    variant("混合_20日+前低8%+峰值回撤10%", { fixedHoldDays: 20, trendExit: "none", trail: "pct10", timeStopDays: null, maxHolding: 20 }),
    variant("混合_15日+前低8%保护", { fixedHoldDays: 15, trendExit: "none", trail: "none", timeStopDays: null, maxHolding: 15 }),
    variant("混合_25日+前低8%保护", { fixedHoldDays: 25, trendExit: "none", trail: "none", timeStopDays: null, maxHolding: 25 }),
    variant("混合_30日+前低8%保护", { fixedHoldDays: 30, trendExit: "none", trail: "none", timeStopDays: null, maxHolding: 30 }),
  ].map((config) => run(config));
  printTable("混合退出：固定时间 + 保护规则", hybrids);

  // 一级形态子集（剔除金针探底）
  printTable("形态过滤：仅一级形态（阳包阴/双日止跌）× 关键配置", [
    run({ ...core, name: "核心×一级形态" }, (signal) => signal.pattern !== "金针探底"),
    run({ ...variant("组合_让利润跑_MA20跟随", { trendExit: "none", trail: "ma20", maxHolding: 60 }), name: "让利润跑×一级形态" }, (signal) => signal.pattern !== "金针探底"),
  ]);

  // 前后窗稳健性
  const windows: Array<[string, string, string]> = [
    ["前窗2022-2023", EVAL_START, "2023-12-31"],
    ["后窗2024-2026", "2024-01-01", "9999-12-31"],
  ];
  const windowRows: ConfigStats[] = [];
  for (const [windowName, start, end] of windows) {
    const subset = (signal: Signal) => signal.date >= start && signal.date <= end;
    windowRows.push(run({ ...core, name: `${windowName}×核心` }, subset));
    windowRows.push(run({ ...variant("组合_让利润跑_MA20跟随", { trendExit: "none", trail: "ma20", maxHolding: 60 }), name: `${windowName}×让利润跑` }, subset));
    windowRows.push(run({ ...variant("混合_20日+前低8%保护", { fixedHoldDays: 20, trendExit: "none", trail: "none", timeStopDays: null, maxHolding: 20 }), name: `${windowName}×混合20日` }, subset));
    windowRows.push(run({ ...variant("混合_20日+前低8%+MA10三连", { fixedHoldDays: 20, trendExit: "ma10_3d", trail: "none", timeStopDays: null, maxHolding: 20 }), name: `${windowName}×混合20日+MA10三连` }, subset));
  }
  printTable("前后窗稳健性", windowRows);

  const inputHash = createHash("sha256").update(JSON.stringify({
    boards: series.map((board) => [board.code, board.bars.length]),
    params: PRODUCTION_PARAMS, signals: signals.length, cooldown: COOLDOWN_BARS,
  })).digest("hex");
  const output = path.join(OUT_DIR, `板块趋势退出研究-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.json`);
  fs.writeFileSync(output, JSON.stringify({
    strategy: "夜间板块左侧趋势策略退出校准v1",
    evidence: "research_only",
    range: { start: EVAL_START },
    input_hash: inputHash,
    signal_rule: "脱离60日中期下降趋势(斜率≤-8%且上穿趋势线且10日斜率>0) ∧ 近15日止跌K线 ∧ 量比<1.5（缩量或温和）",
    params: PRODUCTION_PARAMS,
    costs_bps: { fee: FEE_BPS, slip: SLIP_BPS },
    caveats: [
      "逐笔独立模拟无仓位/槽位约束，连乘收益允许重叠，仅用于组间对比",
      "板块指数代理交易，实际落地有个股选择与成交约束",
      "退出参数在全区间内选取，存在过拟合风险，应结合前后窗与逻辑可解释性取用",
    ],
    anchors,
    oat_stop: [run(core), run(variant("止损_前低10%档", { stopMode: "prior_low_10" })), run(variant("止损_仅前低", { stopMode: "prior_low_only" }))],
    oat_trend: [run(core), run(variant("趋势_单日斜率+破MA10", { trendExit: "single" })), run(variant("趋势_连续2日破MA10", { trendExit: "ma10_2d" })), run(variant("趋势_连续3日破MA10", { trendExit: "ma10_3d" })), run(variant("趋势_延迟5日+2日破MA10", { trendExit: "ma10_2d_delay5" })), run(variant("趋势_延迟10日+2日破MA10", { trendExit: "ma10_2d_delay10" })), run(variant("趋势_不启用", { trendExit: "none" }))],
    oat_time: [run(core), run(variant("时间_10日", { timeStopDays: 10 })), run(variant("时间_15日", { timeStopDays: 15 })), run(variant("时间_20日", { timeStopDays: 20 })), run(variant("时间_30日", { timeStopDays: 30 }))],
    oat_trail: [run(core), run(variant("移动_ATR(峰值-8%/3ATR)", { trail: "atr" })), run(variant("移动_MA20跟随", { trail: "ma20" })), run(variant("移动_峰值回撤10%", { trail: "pct10" }))],
    combos,
    hybrids,
    windows: windowRows,
    signals: signals.map((signal) => ({
      code: signal.code, name: signal.name, date: signal.date, pattern: signal.pattern,
      volumeRatio: round(signal.volumeRatio, 2), secondBottom: signal.secondBottom, contracting: signal.contracting,
    })),
  }, null, 2));
  console.log(`\n结果已写入 ${output}`);
  await closePool();
}

await main();
