// 独立研究：Donchian 新低回升法（近 T 日触及 B 日收盘新低 且 收盘创近 K 日新高）补充分析。
// 问题：量比与止跌K线消融、参数敏感性、与 W60/W13 两线的重叠与并集、退出适配、集中度稳健性。
// 只读 PostgreSQL market_bar，不写业务台账；结论 research_only，不接入生产。
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

interface DonchianConfig {
  touchWindow: number;
  lowBase: number;
  breakoutWindow: number;
  tolerance: number;
}

const BASE: DonchianConfig = { touchWindow: 13, lowBase: 60, breakoutWindow: 10, tolerance: 1.001 };

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

function donchianMatch(bars: SectorTrendBar[], index: number, config: DonchianConfig): boolean {
  if (index + 1 < Math.max(config.lowBase, config.breakoutWindow + 1, config.touchWindow)) return false;
  const lowBase = Math.min(...bars.slice(index - config.lowBase + 1, index + 1).map((bar) => bar.close));
  const touched = bars.slice(index - config.touchWindow + 1, index + 1)
    .some((bar) => bar.close <= lowBase * config.tolerance);
  if (!touched) return false;
  const priorHigh = Math.max(...bars.slice(index - config.breakoutWindow, index).map((bar) => bar.close));
  return bars[index]!.close > priorHigh;
}

interface CollectOptions {
  requirePattern: boolean;
  requireVolume: boolean;
}

const PATTERN_PARAMS: SectorTrendParams = { ...DEFAULT_SECTOR_TREND_PARAMS, bottomingLookback: 15 };

function collectDonchian(
  series: BoardSeries[],
  config: DonchianConfig,
  options: CollectOptions = { requirePattern: true, requireVolume: true },
): Map<string, number[]> {
  const indices = new Map<string, number[]>();
  for (const board of series) {
    let last = -COOLDOWN;
    for (let i = 0; i < board.bars.length; i += 1) {
      if (board.bars[i]!.bar_date < EVAL_START) continue;
      if (i - last < COOLDOWN) continue;
      if (!donchianMatch(board.bars, i, config)) continue;
      if (options.requirePattern || options.requireVolume) {
        const snapshot = sectorTrendSnapshot(board.bars, i, PATTERN_PARAMS);
        if (!snapshot) continue;
        if (options.requirePattern && !snapshot.recentBottomingPattern) continue;
        if (options.requireVolume && (snapshot.volumeRatio === null || snapshot.volumeRatio >= PATTERN_PARAMS.mildVolumeMax)) continue;
      }
      last = i;
      indices.set(board.code, [...(indices.get(board.code) ?? []), i]);
    }
  }
  return indices;
}

function collectSlope(series: BoardSeries[], params: SectorTrendParams): Map<string, number[]> {
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

interface StatsBlock {
  count: number; signalDays: number; avg5: number | null; avg20: number | null; median20: number | null;
  win_rate20: number | null; mfe20: number | null; mae20: number | null; distance_from_low60: number | null;
  by_regime: Record<string, { count: number; avg20: number | null }>;
  by_year: Record<string, { count: number; avg20: number | null; win_rate: number | null }>;
  concentration: { top3_month_share: number | null; top3_months: string[] } | null;
}

function statsOf(series: BoardSeries[], regime: Map<string, string>, indices: Map<string, number[]>): StatsBlock {
  const f5: number[] = []; const f20: number[] = []; const mfe: number[] = []; const mae: number[] = []; const dist: number[] = [];
  const byRegime: Record<string, number[]> = {};
  const byYear: Record<string, number[]> = {};
  const byMonth: Record<string, number> = {};
  const days = new Set<string>();
  let count = 0;
  for (const board of series) {
    for (const i of indices.get(board.code) ?? []) {
      const entry = board.bars[i + 1];
      if (!entry || entry.open <= 0) continue;
      count += 1;
      days.add(board.bars[i]!.bar_date);
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
      const month = board.bars[i]!.bar_date.slice(0, 7);
      byMonth[month] = (byMonth[month] ?? 0) + value;
    }
  }
  const total = Object.values(byMonth).reduce((sum, value) => sum + value, 0);
  const topMonths = Object.entries(byMonth).sort((a, b) => b[1] - a[1]).slice(0, 3);
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
    count, signalDays: days.size, avg5: round(mean(f5)), avg20: round(mean(f20)), median20: round(median(f20)),
    win_rate20: f20.length ? round(f20.filter((value) => value > 0).length / f20.length) : null,
    mfe20: round(mean(mfe)), mae20: round(mean(mae)), distance_from_low60: round(mean(dist)),
    by_regime: regimeBlock, by_year: yearBlock,
    concentration: total > 0
      ? { top3_month_share: round(topMonths.reduce((sum, [, value]) => sum + value, 0) / total), top3_months: topMonths.map(([month]) => month) }
      : null,
  };
}

function printStats(title: string, rows: Array<[string, StatsBlock]>): void {
  console.log(`\n## ${title}`);
  console.log("口径\t信号\t信号日\t均值5\t均值20\t中位20\t胜率20\tMFE20\tMAE20\t距60日低\t牛20\t震荡20\t熊20\t前三月贡献");
  for (const [name, stats] of rows) {
    const regime = (state: string) => {
      const item = stats.by_regime[state];
      return item ? `${item.count}@${pct(item.avg20)}` : "0";
    };
    console.log([
      name, stats.count, stats.signalDays, pct(stats.avg5), pct(stats.avg20), pct(stats.median20), pct(stats.win_rate20),
      pct(stats.mfe20), pct(stats.mae20), pct(stats.distance_from_low60),
      regime("牛市"), regime("震荡"), regime("熊市"),
      stats.concentration ? `${pct(stats.concentration.top3_month_share)}(${stats.concentration.top3_months.join("/")})` : "-",
    ].join("\t"));
  }
  for (const [name, stats] of rows) {
    const years = Object.entries(stats.by_year).map(([year, item]) =>
      `${year}:${item.count}个${pct(item.avg20)}/${item.win_rate === null ? "-" : Math.round(item.win_rate * 100) + "%"}`).join("  ");
    console.log(`  ${name} 分年：${years}`);
  }
}

/** 逐笔退出适配：固定20日 vs 20日+保护(前低/-8%)，次日开盘出入。 */
function exitSim(series: BoardSeries[], indices: Map<string, number[]>) {
  const configs = [
    { name: "固定20日", protect: false },
    { name: "20日+前低8%保护", protect: true },
  ];
  for (const config of configs) {
    const returns: number[] = [];
    const exits: Record<string, number> = {};
    for (const board of series) {
      for (const i of indices.get(board.code) ?? []) {
        const entry = board.bars[i + 1];
        if (!entry || entry.open <= 0 || entry.open > board.bars[i]!.close * 1.03) continue;
        const entryPrice = entry.open * 1.0025;
        const priorLow = Math.min(...board.bars.slice(Math.max(0, i - 19), i + 1).map((bar) => bar.low));
        const stop = Math.max(priorLow, entryPrice * 0.92);
        let exitIndex = Math.min(i + 20, board.bars.length - 1);
        let reason = "时间退出(固定)";
        if (config.protect) {
          for (let k = i + 1; k <= Math.min(i + 20, board.bars.length - 1); k += 1) {
            if (board.bars[k]!.close <= stop) {
              exitIndex = k;
              reason = stop === priorLow ? "破前低止损" : "固定止损";
              break;
            }
          }
        }
        const exitBar = board.bars[Math.min(exitIndex + 1, board.bars.length - 1)]!;
        const exitPrice = (config.protect && reason !== "时间退出(固定)" ? board.bars[exitIndex]!.close : exitBar.open) * 0.9975;
        returns.push(exitPrice / entryPrice - 1);
        exits[reason] = (exits[reason] ?? 0) + 1;
      }
    }
    const wins = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const losses = returns.filter((value) => value <= 0).reduce((sum, value) => sum + value, 0);
    console.log(`  ${config.name}：${returns.length}笔 胜率${returns.length ? (returns.filter((v) => v > 0).length / returns.length * 100).toFixed(1) : "-"}% 均笔${pct(mean(returns))} 中位${pct(median(returns))} 盈利因子${losses < 0 ? (wins / Math.abs(losses)).toFixed(2) : "-"} 退出[${Object.entries(exits).map(([k, v]) => `${k}${v}`).join(",")}]`);
  }
}

async function main(): Promise<void> {
  const pool = getPool(loadConfig().databaseUrl);
  const series = await loadBoards(pool);
  const regime = buildRegime(series);

  // 一、基准与消融：量比与止跌K线对 Donchian 是否仍有增量
  const baseIndices = collectDonchian(series, BASE);
  printStats("一、基准与消融", [
    ["基准(止跌K线+量比<1.5)", statsOf(series, regime, baseIndices)],
    ["消融:去量比条件", statsOf(series, regime, collectDonchian(series, BASE, { requirePattern: true, requireVolume: false }))],
    ["消融:去止跌K线", statsOf(series, regime, collectDonchian(series, BASE, { requirePattern: false, requireVolume: true }))],
    ["纯Donchian(无形态无量比)", statsOf(series, regime, collectDonchian(series, BASE, { requirePattern: false, requireVolume: false }))],
  ]);
  // 量能分层
  const volumeLayers: Array<[string, number[]]> = [["缩量", []], ["温和", []], ["明显", []], ["爆量", []]];
  for (const board of series) {
    let last = -COOLDOWN;
    for (let i = 0; i < board.bars.length; i += 1) {
      if (board.bars[i]!.bar_date < EVAL_START) continue;
      if (i - last < COOLDOWN) continue;
      if (!donchianMatch(board.bars, i, BASE)) continue;
      const snapshot = sectorTrendSnapshot(board.bars, i, PATTERN_PARAMS);
      if (!snapshot || !snapshot.recentBottomingPattern) continue;
      last = i;
      const entry = board.bars[i + 1];
      const target = board.bars[i + 20];
      if (!entry || !target || entry.open <= 0 || snapshot.volumeRatio === null) continue;
      const value = target.close / entry.open - 1;
      const layer = snapshot.volumeRatio < 1 ? 0 : snapshot.volumeRatio < 1.5 ? 1 : snapshot.volumeRatio < 2.5 ? 2 : 3;
      volumeLayers[layer]![1].push(value);
    }
  }
  console.log("\n量能分层（含止跌K线，无量比门槛）：");
  for (const [name, values] of volumeLayers) {
    console.log(`  ${name}: ${values.length}个 均值${pct(mean(values))} 胜率${values.length ? (values.filter((v) => v > 0).length / values.length * 100).toFixed(1) + "%" : "-"}`);
  }

  // 二、参数 OAT
  printStats("二、参数OAT：触及窗口", [
    ["触及8日", statsOf(series, regime, collectDonchian(series, { ...BASE, touchWindow: 8 }))],
    ["触及13日(基准)", statsOf(series, regime, baseIndices)],
    ["触及20日", statsOf(series, regime, collectDonchian(series, { ...BASE, touchWindow: 20 }))],
  ]);
  printStats("二、参数OAT：新低基准", [
    ["40日新低", statsOf(series, regime, collectDonchian(series, { ...BASE, lowBase: 40 }))],
    ["60日新低(基准)", statsOf(series, regime, baseIndices)],
    ["120日新低", statsOf(series, regime, collectDonchian(series, { ...BASE, lowBase: 120 }))],
  ]);
  printStats("二、参数OAT：突破窗口", [
    ["破5日高", statsOf(series, regime, collectDonchian(series, { ...BASE, breakoutWindow: 5 }))],
    ["破10日高(基准)", statsOf(series, regime, baseIndices)],
    ["破20日高", statsOf(series, regime, collectDonchian(series, { ...BASE, breakoutWindow: 20 }))],
  ]);

  // 三、与现有两线的重叠与并集
  const w60 = collectSlope(series, { ...DEFAULT_SECTOR_TREND_PARAMS, mediumWindow: 60, mediumSlopeThreshold: -0.08, shortWindow: 10, bottomingLookback: 15 });
  const w13 = collectSlope(series, { ...DEFAULT_SECTOR_TREND_PARAMS, mediumWindow: 13, mediumSlopeThreshold: -0.08, shortWindow: 5, bottomingLookback: 15 });
  const nearAny = (list: number[], index: number, window = 10) => list.some((item) => Math.abs(item - index) <= window);
  const union = (maps: Map<string, number[]>[]): Map<string, number[]> => {
    const result = new Map<string, number[]>();
    for (const board of series) {
      const merged = [...new Set(maps.flatMap((map) => map.get(board.code) ?? []))].sort((a, b) => a - b);
      const kept: number[] = [];
      for (const index of merged) {
        if (kept.length && index - kept.at(-1)! < COOLDOWN) continue;
        kept.push(index);
      }
      if (kept.length) result.set(board.code, kept);
    }
    return result;
  };
  const donchianOnly = new Map<string, number[]>();
  let overlapW60 = 0; let overlapW13 = 0; let donchianTotal = 0;
  for (const [code, list] of baseIndices) {
    const exclusive = list.filter((index) => {
      donchianTotal += 1;
      const inW60 = nearAny(w60.get(code) ?? [], index);
      const inW13 = nearAny(w13.get(code) ?? [], index);
      if (inW60) overlapW60 += 1;
      if (inW13) overlapW13 += 1;
      return !inW60 && !inW13;
    });
    if (exclusive.length) donchianOnly.set(code, exclusive);
  }
  console.log(`\n## 三、与现有两线重叠：Donchian ${donchianTotal} 个信号中，±10日内有W60信号 ${overlapW60}（${Math.round(overlapW60 / donchianTotal * 100)}%）、有W13信号 ${overlapW13}（${Math.round(overlapW13 / donchianTotal * 100)}%）`);
  printStats("三、并集与独有", [
    ["W60主线", statsOf(series, regime, w60)],
    ["W13补充线", statsOf(series, regime, w13)],
    ["Donchian(现行口径)", statsOf(series, regime, baseIndices)],
    ["Donchian独有(两线±10日无)", statsOf(series, regime, donchianOnly)],
    ["生产并集 W60∪W13", statsOf(series, regime, union([w60, w13]))],
    ["三线并集 W60∪W13∪D", statsOf(series, regime, union([w60, w13, baseIndices]))],
  ]);

  // 四、退出适配
  console.log("\n## 四、退出适配（Donchian 基准信号，费用双边2.5bp近似）");
  exitSim(series, baseIndices);

  const inputHash = createHash("sha256").update(JSON.stringify({
    boards: series.map((board) => [board.code, board.bars.length]), evalStart: EVAL_START, base: BASE,
  })).digest("hex");
  const output = path.join(OUT_DIR, `Donchian新低回升补充研究-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.json`);
  fs.writeFileSync(output, JSON.stringify({
    strategy: "夜间板块 Donchian 新低回升法补充研究v1（research_only，未接入生产）",
    range: { start: EVAL_START },
    input_hash: inputHash,
    base_definition: "近13日触及60日收盘新低(×1.001) 且 收盘创近10日最高收盘；共享止跌K线15日、量比<1.5、冷却15日",
    caveats: [
      "全区间参数对比无真正样本外；参数OAT取值须结合分年稳定性",
      "重叠判定用±10日窗口，不能识别同机会不同日的精确对应",
      "退出模拟为逐笔近似，无组合与槽位约束",
    ],
  }, null, 2));
  console.log(`\n结果已写入 ${output}`);
  await closePool();
}

await main();
