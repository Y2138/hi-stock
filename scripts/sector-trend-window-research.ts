// 独立研究：夜间板块左侧趋势的斜率窗口矩阵、W60/W13 并集互补性与备选短期趋势定义。
// 问题一：中期下降趋势背景窗口（60/30/20/13/6 日）对信号质量的影响。
// 问题二：W13 斜率-8% 补充线的独有信号质量与市况互补。
// 问题三：除 OLS 斜率外，均线位置、Donchian 新低回升、低点抬高结构三种短期趋势确定性定义的对比。
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
  sectorTrendSnapshot,
  type SectorTrendBar,
  type SectorTrendParams,
} from "./lib/sector-trend-rules.js";

const EVAL_START = "2022-01-01";
const COOLDOWN = 15;
const OUT_DIR = path.resolve("支撑/tmp/夜间板块双线趋势回测");
fs.mkdirSync(OUT_DIR, { recursive: true });

interface BoardSeries {
  code: string;
  name: string;
  bars: SectorTrendBar[];
}

interface Variant {
  name: string;
  window: number;
  threshold: number;
  shortWindow: number;
}

const VARIANTS: Variant[] = [
  { name: "W60 斜率-8%（主线）", window: 60, threshold: -0.08, shortWindow: 10 },
  { name: "W30 斜率-8%", window: 30, threshold: -0.08, shortWindow: 10 },
  { name: "W30 斜率-12%", window: 30, threshold: -0.12, shortWindow: 10 },
  { name: "W20 斜率-6%", window: 20, threshold: -0.06, shortWindow: 10 },
  { name: "W20 斜率-8%", window: 20, threshold: -0.08, shortWindow: 10 },
  { name: "W20 斜率-10%", window: 20, threshold: -0.10, shortWindow: 10 },
  { name: "W13 斜率-5%", window: 13, threshold: -0.05, shortWindow: 5 },
  { name: "W13 斜率-8%（补充线）", window: 13, threshold: -0.08, shortWindow: 5 },
  { name: "W6 斜率-3%", window: 6, threshold: -0.03, shortWindow: 3 },
  { name: "W6 斜率-5%", window: 6, threshold: -0.05, shortWindow: 3 },
];

const mean = (values: number[]): number | null => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);
const median = (values: number[]): number | null =>
  values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]! : null;
const round = (value: number | null, digits = 4): number | null =>
  value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
const pct = (value: number | null): string => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);

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

function buildRegime(series: BoardSeries[]): Map<string, "牛市" | "熊市" | "震荡"> {
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
  const regime = new Map<string, "牛市" | "熊市" | "震荡">();
  for (const date of dates) {
    const daily = returnsByDate.get(date)!;
    points.push((points.at(-1) ?? 100) * (1 + daily.sum / daily.count));
    if (points.length < 20) continue;
    const ma5 = mean(points.slice(-5))!;
    const ma20 = mean(points.slice(-20))!;
    const roc5 = points.at(-1)! / points.at(-6)! - 1;
    regime.set(date, ma5 > ma20 && roc5 > 0 ? "牛市" : ma5 < ma20 && roc5 < 0 ? "熊市" : "震荡");
  }
  return regime;
}

interface StatsBlock {
  count: number; avg5: number | null; avg20: number | null; median20: number | null; win_rate20: number | null;
  mfe20: number | null; mae20: number | null; distance_from_low60: number | null;
  by_regime: Record<string, { count: number; avg20: number | null }>;
  by_year: Record<string, { count: number; avg20: number | null; win_rate: number | null }>;
}

function statsOf(series: BoardSeries[], regime: Map<string, string>, indices: Map<string, number[]>): StatsBlock {
  const f5: number[] = []; const f20: number[] = []; const mfe: number[] = []; const mae: number[] = []; const dist: number[] = [];
  const byRegime: Record<string, number[]> = {};
  const byYear: Record<string, number[]> = {};
  let count = 0;
  for (const board of series) {
    const list = indices.get(board.code) ?? [];
    for (const i of list) {
      const entry = board.bars[i + 1];
      if (!entry || entry.open <= 0) continue;
      count += 1;
      const t5 = board.bars[i + 5];
      if (t5) f5.push(t5.close / entry.open - 1);
      const t20 = board.bars[i + 20];
      if (!t20) continue;
      const value = t20.close / entry.open - 1;
      f20.push(value);
      const future = board.bars.slice(i + 1, i + 21);
      if (future.length) {
        mfe.push(Math.max(...future.map((bar) => bar.high)) / entry.open - 1);
        mae.push(Math.min(...future.map((bar) => bar.low)) / entry.open - 1);
      }
      const low60 = Math.min(...board.bars.slice(Math.max(0, i - 59), i + 1).map((bar) => bar.low));
      dist.push(board.bars[i]!.close / low60 - 1);
      const state = regime.get(board.bars[i]!.bar_date);
      if (state) (byRegime[state] ??= []).push(value);
      (byYear[board.bars[i]!.bar_date.slice(0, 4)] ??= []).push(value);
    }
  }
  const regimeBlock: StatsBlock["by_regime"] = {};
  for (const [state, values] of Object.entries(byRegime)) {
    regimeBlock[state] = { count: values.length, avg20: round(mean(values)) };
  }
  const yearBlock: StatsBlock["by_year"] = {};
  for (const [year, values] of Object.entries(byYear)) {
    yearBlock[year] = {
      count: values.length, avg20: round(mean(values)),
      win_rate: values.length ? round(values.filter((value) => value > 0).length / values.length) : null,
    };
  }
  return {
    count, avg5: round(mean(f5)), avg20: round(mean(f20)), median20: round(median(f20)),
    win_rate20: f20.length ? round(f20.filter((value) => value > 0).length / f20.length) : null,
    mfe20: round(mean(mfe)), mae20: round(mean(mae)), distance_from_low60: round(mean(dist)),
    by_regime: regimeBlock, by_year: yearBlock,
  };
}

function collectSlopeSignals(series: BoardSeries[], params: SectorTrendParams): Map<string, number[]> {
  const indices = new Map<string, number[]>();
  for (const board of series) {
    let last = -COOLDOWN;
    for (let i = 0; i < board.bars.length; i += 1) {
      if (board.bars[i]!.bar_date < EVAL_START) continue;
      if (i - last < COOLDOWN) continue;
      const snapshot = sectorTrendSnapshot(board.bars, i, params);
      if (!snapshot || !snapshot.escapesMediumDowntrend || !snapshot.recentBottomingPattern) continue;
      if (snapshot.volumeRatio === null || snapshot.volumeRatio >= params.mildVolumeMax) continue;
      last = i;
      indices.set(board.code, [...(indices.get(board.code) ?? []), i]);
    }
  }
  return indices;
}

/** 备选短期趋势定义：共享 止跌K线(15日) + 量比<1.5 + 冷却15日 + 前低20日，仅背景与转涨判定不同。 */
type AltDefinition = (bars: SectorTrendBar[], index: number) => boolean;

function ma(bars: SectorTrendBar[], index: number, window: number): number | null {
  if (index + 1 < window) return null;
  return mean(bars.slice(index - window + 1, index + 1).map((bar) => bar.close));
}

/** 斜率法（补充线现行口径）：13日OLS斜率≤-8%背景，收盘上穿13日回归线且5日斜率>0。 */
const slopeDefinition = (bars: SectorTrendBar[], index: number): boolean => {
  const params: SectorTrendParams = { ...DEFAULT_SECTOR_TREND_PARAMS, mediumWindow: 13, mediumSlopeThreshold: -0.08, shortWindow: 5, bottomingLookback: 15 };
  const snapshot = sectorTrendSnapshot(bars, index, params);
  return !!snapshot && snapshot.escapesMediumDowntrend;
};

/** 均线位置法：收盘在下行 MA13 下方，当日收盘上穿 MA13 且 MA5>MA10。 */
const maCrossDefinition: AltDefinition = (bars, index) => {
  const ma13 = ma(bars, index, 13);
  const ma13Prev = ma(bars, index - 1, 13);
  const ma13Prev5 = ma(bars, index - 5, 13);
  const ma5 = ma(bars, index, 5);
  const ma10 = ma(bars, index, 10);
  if (ma13 === null || ma13Prev === null || ma13Prev5 === null || ma5 === null || ma10 === null) return false;
  const previous = bars[index - 1]!;
  return ma13 < ma13Prev5 && previous.close <= ma13Prev && bars[index]!.close > ma13 && ma5 > ma10;
};

/** Donchian 新低回升法：近13日内触及60日收盘新低，当日收盘创近10日最高收盘。 */
const donchianDefinition: AltDefinition = (bars, index) => {
  if (index < 60) return false;
  const low60 = Math.min(...bars.slice(index - 59, index + 1).map((bar) => bar.close));
  const touchedLow = bars.slice(index - 12, index + 1).some((bar) => bar.close <= low60 * 1.001);
  const high10 = Math.max(...bars.slice(index - 10, index).map((bar) => bar.close));
  return touchedLow && bars[index]!.close > high10;
};

/** 低点抬高结构法：近13日低点低于前13日低点（新低结构），近5日低点高于其前5日低点（抬高），收盘>MA10。 */
const higherLowDefinition: AltDefinition = (bars, index) => {
  if (index < 30) return false;
  const low13 = Math.min(...bars.slice(index - 12, index + 1).map((bar) => bar.low));
  const low13Prev = Math.min(...bars.slice(index - 25, index - 12).map((bar) => bar.low));
  const low5 = Math.min(...bars.slice(index - 4, index + 1).map((bar) => bar.low));
  const low5Prev = Math.min(...bars.slice(index - 9, index - 4).map((bar) => bar.low));
  const ma10 = ma(bars, index, 10);
  return low13 < low13Prev && low5 > low5Prev && ma10 !== null && bars[index]!.close > ma10;
};

function collectAltSignals(series: BoardSeries[], definition: AltDefinition): Map<string, number[]> {
  const indices = new Map<string, number[]>();
  for (const board of series) {
    let last = -COOLDOWN;
    for (let i = 0; i < board.bars.length; i += 1) {
      if (board.bars[i]!.bar_date < EVAL_START) continue;
      if (i - last < COOLDOWN) continue;
      if (!definition(board.bars, i)) continue;
      const snapshot = sectorTrendSnapshot(board.bars, i, { ...DEFAULT_SECTOR_TREND_PARAMS, bottomingLookback: 15 });
      if (!snapshot || !snapshot.recentBottomingPattern) continue;
      if (snapshot.volumeRatio === null || snapshot.volumeRatio >= DEFAULT_SECTOR_TREND_PARAMS.mildVolumeMax) continue;
      last = i;
      indices.set(board.code, [...(indices.get(board.code) ?? []), i]);
    }
  }
  return indices;
}

function printStats(title: string, rows: Array<[string, StatsBlock]>): void {
  console.log(`\n## ${title}`);
  console.log("口径\t样本\t均值5\t均值20\t中位20\t胜率20\tMFE20\tMAE20\t距60日低\t牛20\t震荡20\t熊20");
  for (const [name, stats] of rows) {
    const regime = (state: string) => {
      const item = stats.by_regime[state];
      return item ? `${item.count}@${pct(item.avg20)}` : "0";
    };
    console.log([
      name, stats.count, pct(stats.avg5), pct(stats.avg20), pct(stats.median20), pct(stats.win_rate20),
      pct(stats.mfe20), pct(stats.mae20), pct(stats.distance_from_low60),
      regime("牛市"), regime("震荡"), regime("熊市"),
    ].join("\t"));
  }
  for (const [name, stats] of rows) {
    const years = Object.entries(stats.by_year).map(([year, item]) =>
      `${year}:${item.count}个${pct(item.avg20)}/${item.win_rate === null ? "-" : Math.round(item.win_rate * 100) + "%"}`).join("  ");
    console.log(`  ${name} 分年：${years}`);
  }
}

async function main(): Promise<void> {
  const pool = getPool(loadConfig().databaseUrl);
  const series = await loadBoards(pool);
  const regime = buildRegime(series);

  // 一、窗口 OAT
  const oatRows: Array<[string, StatsBlock]> = [];
  for (const variant of VARIANTS) {
    const params: SectorTrendParams = {
      ...DEFAULT_SECTOR_TREND_PARAMS, mediumWindow: variant.window,
      mediumSlopeThreshold: variant.threshold, shortWindow: variant.shortWindow, bottomingLookback: 15,
    };
    oatRows.push([variant.name, statsOf(series, regime, collectSlopeSignals(series, params))]);
  }
  printStats("一、斜率窗口 OAT（共享：止跌K线15日、量比<1.5、冷却15日）", oatRows);

  // 二、W60/W13 并集与 W13 独有信号
  const mainLine = { ...DEFAULT_SECTOR_TREND_PARAMS, mediumWindow: 60, mediumSlopeThreshold: -0.08, shortWindow: 10, bottomingLookback: 15 };
  const mainIndices = collectSlopeSignals(series, mainLine);
  const w13Indices = collectSlopeSignals(series, { ...DEFAULT_SECTOR_TREND_PARAMS, mediumWindow: 13, mediumSlopeThreshold: -0.08, shortWindow: 5, bottomingLookback: 15 });
  const unionIndices = new Map<string, number[]>();
  for (const board of series) {
    const merged = [...new Set([...(mainIndices.get(board.code) ?? []), ...(w13Indices.get(board.code) ?? [])])].sort((a, b) => a - b);
    // 并集后按板块重算冷却
    const kept: number[] = [];
    for (const index of merged) {
      if (kept.length && index - kept.at(-1)! < COOLDOWN) continue;
      kept.push(index);
    }
    if (kept.length) unionIndices.set(board.code, kept);
  }
  const exclusiveIndices = new Map<string, number[]>();
  for (const [code, list] of w13Indices) {
    const mainList = mainIndices.get(code) ?? [];
    const exclusive = list.filter((index) => !mainList.some((main) => Math.abs(main - index) <= 10));
    if (exclusive.length) exclusiveIndices.set(code, exclusive);
  }
  printStats("二、并集与独有（同板块±10日重叠视为同一机会）", [
    ["W60 主线", statsOf(series, regime, mainIndices)],
    ["W13 补充线", statsOf(series, regime, w13Indices)],
    ["W60∪W13 并集", statsOf(series, regime, unionIndices)],
    ["W13 独有（主线±10日无信号）", statsOf(series, regime, exclusiveIndices)],
  ]);

  // 三、备选短期趋势定义（替换斜率法，其余口径不变）
  printStats("三、备选短期趋势定义（急跌背景+转涨确认的不同确定性表达）", [
    ["斜率法 W13（现行补充线）", statsOf(series, regime, collectAltSignals(series, slopeDefinition))],
    ["均线位置法 MA13上穿", statsOf(series, regime, collectAltSignals(series, maCrossDefinition))],
    ["Donchian新低回升法", statsOf(series, regime, collectAltSignals(series, donchianDefinition))],
    ["低点抬高结构法", statsOf(series, regime, collectAltSignals(series, higherLowDefinition))],
  ]);

  const inputHash = createHash("sha256").update(JSON.stringify({
    boards: series.map((board) => [board.code, board.bars.length]),
    evalStart: EVAL_START, variants: VARIANTS,
  })).digest("hex");
  const output = path.join(OUT_DIR, `窗口与短期趋势定义研究-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.json`);
  fs.writeFileSync(output, JSON.stringify({
    strategy: "夜间板块左侧趋势：斜率窗口矩阵与备选短期趋势定义研究v1",
    evidence: "research_only",
    range: { start: EVAL_START },
    input_hash: inputHash,
    shared_rules: "止跌K线(阳包阴/双日止跌/金针探底)15日回看、量比<1.5、同板块冷却15日、入场次日开盘、20日前瞻",
    sections: { window_oat: Object.fromEntries(oatRows), alternatives: null },
    caveats: [
      "全区间参数对比无真正样本外，取用时须结合分年稳定性与逻辑可解释性",
      "备选定义各自包含背景与转涨两个环节，不是对单一条件的孤立消融",
      "板块指数代理，未含个股落地与成交约束",
    ],
  }, null, 2));
  console.log(`\n结果已写入 ${output}`);
  await closePool();
}

await main();
