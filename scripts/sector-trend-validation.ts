// 板块趋势结论的独立复核；仅在 PostgreSQL 只读事务中读取行情，不写运行数据。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import {
  DEFAULT_SECTOR_TREND_PARAMS, bottomingPattern, sectorTrendSnapshot,
  type SectorTrendBar, type SectorTrendSnapshot,
} from "./lib/sector-trend-rules.js";

const START = "2022-01-01";
const PARAMS = { ...DEFAULT_SECTOR_TREND_PARAMS, bottomingLookback: 15, contractionRatioMax: 0.85 };
const COST = 12.5 / 10_000; // 单边费用2.5bp + 滑点10bp，与原退出研究一致。
type Mode = "固定" | "保护" | "MA10" | "MA20";
interface Board { code: string; bars: SectorTrendBar[]; indices: Map<string, number> }
interface Signal { board: Board; index: number; snapshot: SectorTrendSnapshot; primary: boolean }
interface Trade { signal: Signal; entry: string; exit: string; value: number; days: number; reason: string }
interface IndexBar { bar_date: string; open: number; close: number; channel: string; adjustment: string | null }

const average = (values: number[]) => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = (items: number[]) => items.reduce((a, b) => a + b, 0);
  const wins = values.filter((v) => v > 0), losses = values.filter((v) => v <= 0);
  return {
    count: values.length, mean: average(values),
    median: sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2 : null,
    win_rate: values.length ? wins.length / values.length : null,
    profit_factor: sum(losses) < 0 ? sum(wins) / -sum(losses) : null,
    payoff_ratio: wins.length && losses.length && average(losses)! < 0 ? average(wins)! / -average(losses)! : null,
  };
}

/** 同一最大观察窗内比较全部退出，未成熟事件整组剔除，禁止期末开盘回填。 */
function simulate(signal: Signal, mode: Mode, horizon = 20): Trade | null {
  const { board, index, snapshot } = signal;
  const entry = board.bars[index + 1];
  if (!entry || !board.bars[index + horizon + 1] || entry.open > board.bars[index]!.close * 1.03) return null;
  const entryPrice = entry.open * (1 + COST);
  const stop = mode === "固定" ? -Infinity : Math.max(snapshot.priorLow!, entryPrice * 0.92);
  let streak = 0;
  for (let day = 1; day <= horizon; day += 1) {
    const bar = board.bars[index + day]!;
    const feature = mode === "MA10" || mode === "MA20" ? sectorTrendSnapshot(board.bars, index + day, PARAMS) : null;
    streak = feature?.ma10 != null && bar.close < feature.ma10 ? streak + 1 : 0;
    const reason = bar.close <= stop ? "结构止损"
      : mode === "MA10" && day >= 5 && streak >= 2 ? "MA10退出"
        : mode === "MA20" && feature?.ma20 != null && bar.close < feature.ma20 ? "MA20退出"
          : day === horizon ? "时间退出" : null;
    if (!reason) continue;
    const exit = board.bars[index + day + 1]!;
    return { signal, entry: entry.bar_date, exit: exit.bar_date, value: exit.open * (1 - COST) / entryPrice - 1, days: day, reason };
  }
  return null;
}

function collect(boards: Board[], pass: (s: SectorTrendSnapshot) => boolean): Signal[] {
  const signals: Signal[] = [];
  for (const board of boards) {
    let last = -15;
    for (let index = 60; index < board.bars.length; index += 1) {
      if (board.bars[index]!.bar_date < START || index - last < 15) continue;
      const snapshot = sectorTrendSnapshot(board.bars, index, PARAMS);
      if (!snapshot || !pass(snapshot)) continue;
      last = index;
      // 原规则返回窗口内最早形态；这里只为标签审计补充“窗口内存在一级形态”。
      const primary = Array.from({ length: 15 }, (_, offset) => bottomingPattern(board.bars, index - offset))
        .some((pattern) => pattern === "阳包阴" || pattern === "双日止跌");
      signals.push({ board, index, snapshot, primary });
    }
  }
  return signals.sort((a, b) => a.board.bars[a.index]!.bar_date.localeCompare(b.board.bars[b.index]!.bar_date) || a.board.code.localeCompare(b.board.code));
}

/** 同日开仓、同日平仓的90行业等权买入持有基准；不含择时或事后排序。 */
function benchmark(boards: Board[], entryDate: string, exitDate: string, closeExit = false, downtrend = false): number | null {
  const returns: number[] = [];
  for (const board of boards) {
    const entryIndex = board.indices.get(entryDate), exitIndex = board.indices.get(exitDate);
    if (entryIndex === undefined || exitIndex === undefined) continue;
    if (downtrend) {
      const snapshot = sectorTrendSnapshot(board.bars, entryIndex - 1, PARAMS);
      if (!snapshot?.mediumDowntrend) continue;
    }
    const entry = board.bars[entryIndex]!, exit = board.bars[exitIndex]!;
    returns.push((closeExit ? exit.close : exit.open * (1 - COST)) / (entry.open * (closeExit ? 1 : 1 + COST)) - 1);
  }
  return average(returns);
}

function indexReturn(bars: Map<string, IndexBar>, entryDate: string, exitDate: string): number | null {
  const entry = bars.get(entryDate), exit = bars.get(exitDate);
  return entry && exit ? exit.open * (1 - COST) / (entry.open * (1 + COST)) - 1 : null;
}

/** 按信号月整块重采样，保留同月跨行业相关；区间仅是历史描述，非样本外检验。 */
function blockInterval(rows: Array<{ date: string; value: number }>) {
  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    grouped.set(month, [...(grouped.get(month) ?? []), row.value]);
  }
  const blocks = [...grouped.values()].map((values) => ({ sum: values.reduce((a, b) => a + b, 0), count: values.length }));
  if (!blocks.length) return null;
  let seed = 20261010;
  const draws: number[] = [];
  for (let iteration = 0; iteration < 4000; iteration += 1) {
    let sum = 0, count = 0;
    for (let i = 0; i < blocks.length; i += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const block = blocks[Math.floor(seed / 2 ** 32 * blocks.length)]!;
      sum += block.sum; count += block.count;
    }
    draws.push(sum / count);
  }
  draws.sort((a, b) => a - b);
  return { months: blocks.length, low: draws[100]!, high: draws[3899]! };
}

function selfCheck() {
  const bars: SectorTrendBar[] = Array.from({ length: 120 }, (_, index) => {
    const close = 120 - index * 0.3 + Math.sin(index) * 2;
    return { code: "测试", bar_date: `第${index}日`, open: close + 0.2, high: close + 2, low: close - 2, close, volume: 100 + index };
  });
  for (const index of [60, 75, 95]) {
    assert.deepEqual(sectorTrendSnapshot(bars, index, PARAMS), sectorTrendSnapshot(bars.slice(0, index + 1), index, PARAMS));
  }
  const board: Board = { code: "测试", bars, indices: new Map(bars.map((b, i) => [b.bar_date, i])) };
  const signal: Signal = { board, index: 60, snapshot: sectorTrendSnapshot(bars, 60, PARAMS)!, primary: false };
  const trade = simulate(signal, "固定")!;
  assert.equal(trade.entry, bars[61]!.bar_date);
  assert.equal(trade.exit, bars[81]!.bar_date);
  assert.equal(trade.days, 20);
  assert.equal(trade.value, bars[81]!.open * (1 - COST) / (bars[61]!.open * (1 + COST)) - 1);
  assert.equal(simulate({ ...signal, board: { ...board, bars: bars.slice(0, 81) } }, "固定"), null);
  const stopped = { ...board, bars: bars.map((bar) => ({ ...bar })) };
  stopped.bars[63]!.close = signal.snapshot.priorLow! * 0.9;
  assert.equal(simulate({ ...signal, board: stopped }, "保护")!.exit, bars[64]!.bar_date);
  assert.equal(stats([0.1, 0.2, -0.05, -0.1]).median, 0.025);
  assert.equal(blockInterval([{ date: "2022-01-01", value: 0.1 }])!.low, 0.1);
  const indexBars = new Map<string, IndexBar>([
    ["入场日", { bar_date: "入场日", open: 100, close: 150, channel: "测试", adjustment: "none" }],
    ["退出日", { bar_date: "退出日", open: 110, close: 200, channel: "测试", adjustment: "none" }],
  ]);
  assert.equal(indexReturn(indexBars, "入场日", "退出日"), 110 * (1 - COST) / (100 * (1 + COST)) - 1);
  assert.equal(indexReturn(indexBars, "入场日", "缺数日"), null);
  console.log("独立复核自检通过：特征前缀一致、完整窗口、次日退出、保护止损、统计口径。");
}

async function main() {
  selfCheck();
  if (process.argv.includes("--self-check")) return;
  const asOfIndex = process.argv.indexOf("--as-of");
  const asOf = asOfIndex >= 0 ? process.argv[asOfIndex + 1] : "2026-10-10";
  assert(asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf), "--as-of 必须为YYYY-MM-DD");
  const pool = getPool(loadConfig().databaseUrl);
  const client = await pool.connect();
  const sql = `SELECT i.code, b.bar_date::text, b.open::float8, b.high::float8, b.low::float8,
      b.close::float8, b.volume::float8, b.channel, b.adjustment
    FROM market_bar b JOIN market_instrument i ON i.id = b.instrument_id
    JOIN market_board mb ON mb.instrument_id = i.id AND mb.active = true
      AND mb.source = 'hithink' AND mb.board_type = 'industry'
    WHERE i.code LIKE '881%.TI' AND b.freq = 'day' AND b.bar_date <= $1::date
    ORDER BY i.code, b.bar_date, b.bar_time`;
  let rows: Array<SectorTrendBar & { channel: string; adjustment: string | null }>;
  const indexSql = `SELECT b.bar_date::text, b.open::float8, b.close::float8, b.channel, b.adjustment
    FROM market_bar b JOIN market_instrument i ON i.id = b.instrument_id
    WHERE i.code = $3 AND i.name = $4 AND i.kind = 'index'
      AND b.freq = 'day' AND b.bar_date >= $1::date AND b.bar_date <= $2::date
    ORDER BY b.bar_date, b.bar_time`;
  let indexRows: IndexBar[];
  let csi300Rows: IndexBar[];
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    rows = (await client.query(sql, [asOf])).rows;
    indexRows = (await client.query(indexSql, [START, asOf, "000001.SH", "上证指数"])).rows;
    csi300Rows = (await client.query(indexSql, [START, asOf, "000300.SH", "沪深300"])).rows;
    await client.query("ROLLBACK");
  } finally { client.release(); await closePool(); }
  assert(rows.length, "没有881行业日线");
  const inputHash = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  // 本地宽基历史存在重复填充与错位，研究基准仅采用按远端原始日期核验的缓存。
  const verifiedIndexPath = path.resolve("支撑/tmp/夜间板块双线趋势回测/远端核验指数日线.json");
  if (!fs.existsSync(verifiedIndexPath)) console.log("宽基基准未核验：仅输出行业证据，宽基比较标为缺数；可再运行择时脚本--refresh-index。");
  const verifiedIndexRows = (fs.existsSync(verifiedIndexPath) ? JSON.parse(fs.readFileSync(verifiedIndexPath, "utf8")) : []) as Array<IndexBar & { code: string }>;
  indexRows = verifiedIndexRows.filter((row) => row.code === "000001.SH" && row.bar_date >= START && row.bar_date <= asOf);
  csi300Rows = verifiedIndexRows.filter((row) => row.code === "000300.SH" && row.bar_date >= START && row.bar_date <= asOf);
  const indexBars = new Map<string, IndexBar>();
  const csi300Bars = new Map<string, IndexBar>();
  for (const [name, source, target] of [["上证", indexRows, indexBars], ["沪深300", csi300Rows, csi300Bars]] as const) {
    for (const row of source) {
      assert(Number.isFinite(row.open) && row.open > 0 && Number.isFinite(row.close) && row.close > 0, `${name}行情缺失或非正`);
      assert(!target.has(row.bar_date), `${name}同日重复K线`);
      target.set(row.bar_date, row);
    }
  }
  const boardMap = new Map<string, Board>();
  for (const row of rows) {
    assert([row.open, row.high, row.low, row.close, row.volume].every((v) => Number.isFinite(v) && v > 0), "行情缺失或非正");
    assert(row.high >= Math.max(row.open, row.close, row.low) && row.low <= Math.min(row.open, row.close), "OHLC不一致");
    const board = boardMap.get(row.code) ?? { code: row.code, bars: [], indices: new Map<string, number>() };
    assert(!board.indices.has(row.bar_date), "同板块同日重复K线");
    board.indices.set(row.bar_date, board.bars.length); board.bars.push(row); boardMap.set(row.code, board);
  }
  const boards = [...boardMap.values()];
  const dates = [...new Set(rows.map((row) => row.bar_date))].sort();
  const structure = (s: SectorTrendSnapshot) => s.escapesMediumDowntrend && s.recentBottomingPattern !== null;
  const left = collect(boards, (s) => structure(s) && s.volumeRatio !== null && s.volumeRatio < 1.5);
  // 全部消融共享同一冷却事件宇宙，先产生事件再按标签分组。
  const unfiltered = collect(boards, structure);
  const right = collect(boards, (s) => s.rightTrack);
  const temperature = collect(boards, (s) => s.temperature !== null && s.temperature >= 60);
  const trades = (signals: Signal[], mode: Mode, horizon = 20) => signals.map((s) => simulate(s, mode, horizon)).filter((t): t is Trade => t !== null);
  const describe = (items: Trade[]) => ({ ...stats(items.map((t) => t.value)), avg_days: average(items.map((t) => t.days)),
    stop_count: items.filter((t) => t.reason === "结构止损").length, unique_dates: new Set(items.map((t) => t.signal.board.bars[t.signal.index]!.bar_date)).size });
  const fixed = trades(left, "固定"), protectedTrades = trades(left, "保护"), ma10Trades = trades(left, "MA10");
  const matched = fixed.map((trade) => ({ trade, baseline: benchmark(boards, trade.entry, trade.exit)! }));
  const rowDate = (t: Trade) => t.signal.board.bars[t.signal.index]!.bar_date;
  const compareIndex = (items: Trade[], baselineBars = indexBars) => {
    const pairs = items.flatMap((trade) => {
      const value = indexReturn(baselineBars, trade.entry, trade.exit);
      return value === null ? [] : [{ trade, value }];
    });
    return {
      expected: items.length, missing: items.length - pairs.length,
      strategy: stats(pairs.map((p) => p.trade.value)), index: stats(pairs.map((p) => p.value)),
      excess: stats(pairs.map((p) => p.trade.value - p.value)),
      excess_month_ci: blockInterval(pairs.map((p) => ({ date: rowDate(p.trade), value: p.trade.value - p.value }))),
      by_year: Object.fromEntries([...new Set(pairs.map((p) => rowDate(p.trade).slice(0, 4)))].sort().map((year) => {
        const subset = pairs.filter((p) => rowDate(p.trade).startsWith(year));
        return [year, { strategy: stats(subset.map((p) => p.trade.value)), index: stats(subset.map((p) => p.value)),
          excess: stats(subset.map((p) => p.trade.value - p.value)) }];
      })),
    };
  };
  const common40 = left.filter((s) => !!s.board.bars[s.index + 41]);
  const protected20 = trades(common40, "保护", 20);
  const protected30 = trades(common40, "保护", 30);
  const protected25 = trades(common40, "保护", 25);
  const byYear = Object.fromEntries([...new Set(fixed.map((t) => rowDate(t).slice(0, 4)))].sort().map((year) => {
    const subset = matched.filter(({ trade }) => rowDate(trade).startsWith(year));
    return [year, { fixed: describe(subset.map((r) => r.trade)), protected: describe(protectedTrades.filter((t) => rowDate(t).startsWith(year))),
      benchmark: stats(subset.map((r) => r.baseline)), excess: stats(subset.map((r) => r.trade.value - r.baseline)) }];
  }));
  const event = (signals: Signal[]) => signals.flatMap((signal) => {
    const { bars } = signal.board, entry = bars[signal.index + 1], exit = bars[signal.index + 20];
    if (!entry || !exit || entry.open > bars[signal.index]!.close * 1.03) return [];
    return [{ value: exit.close / entry.open - 1, signal, date: bars[signal.index]!.bar_date,
      baseline: benchmark(boards, entry.bar_date, exit.bar_date, true)!,
      downtrend_baseline: benchmark(boards, entry.bar_date, exit.bar_date, true, true),
      mae: Math.min(...bars.slice(signal.index + 1, signal.index + 21).map((bar) => bar.low)) / entry.open - 1 }];
  });
  const events = event(left);
  const months = [...new Set(events.map((e) => e.date.slice(0, 7)))].map((month) => {
    const subset = events.filter((e) => e.date.startsWith(month));
    return { month, count: subset.length, sum: subset.reduce((sum, e) => sum + e.value, 0), mean: average(subset.map((e) => e.value)) };
  }).sort((a, b) => b.sum - a.sum);
  const regimeByDate = new Map<string, string>();
  // 与生产相同：近21个公共日期且九成完整行业才输出环境，禁止缺数默认为震荡。
  for (let index = 20; index < dates.length; index += 1) {
    const window = dates.slice(index - 20, index + 1);
    const complete = boards.filter((board) => window.every((date) => board.indices.has(date)));
    if (complete.length < Math.ceil(boards.length * 0.9)) continue;
    const points = [100];
    for (let i = 1; i < window.length; i += 1) {
      points.push(points.at(-1)! * (1 + average(complete.map((board) => board.bars[board.indices.get(window[i]!)!]!.close / board.bars[board.indices.get(window[i - 1]!)!]!.close - 1))!));
    }
    const ma5 = average(points.slice(-5))!, ma20 = average(points.slice(-20))!, roc = points.at(-1)! / points.at(-6)! - 1;
    regimeByDate.set(dates[index]!, ma5 > ma20 && roc > 0 ? "牛市" : ma5 < ma20 && roc < 0 ? "熊市" : "震荡");
  }
  const relative = (items: Trade[]) => ({ ...describe(items),
    excess: stats(items.map((t) => t.value - benchmark(boards, t.entry, t.exit)!)) });
  const shapeGroups = Object.fromEntries(["阳包阴", "双日止跌", "金针探底"].map((pattern) => [pattern, relative(fixed.filter((t) => t.signal.snapshot.recentBottomingPattern === pattern))]));
  const gaps = boards.map((b) => ({ code: b.code, missing_dates: dates.filter((d) => d >= b.bars[0]!.bar_date && d <= b.bars.at(-1)!.bar_date && !b.indices.has(d)) })).filter((b) => b.missing_dates.length > 0);
  let overlapping = 0;
  const previousByCode = new Map<string, number>();
  for (const signal of left) {
    const previous = previousByCode.get(signal.board.code);
    if (previous !== undefined && signal.index - previous <= 20) overlapping += 1;
    previousByCode.set(signal.board.code, signal.index);
  }
  const output = {
    evidence: "research_only", as_of: asOf, input_hash: inputHash, sql, params: PARAMS, cost_per_side_bps: 12.5,
    data: { rows: rows.length, boards: boards.length, first: dates[0], last: dates.at(-1),
      channels: [...new Set(rows.map((r) => r.channel))], adjustments: [...new Set(rows.map((r) => r.adjustment))],
      calendar_gaps: gaps },
    signals: { count: left.length, completed20: fixed.length, completed40: trades(left, "固定", 40).length,
      boards: new Set(left.map((s) => s.board.code)).size, overlapping20: overlapping,
      relabeled_needle_with_primary: left.filter((s) => s.snapshot.recentBottomingPattern === "金针探底" && s.primary).length },
    exits: Object.fromEntries((["固定", "保护", "MA10", "MA20"] as const).map((mode) => [mode, describe(trades(left, mode))])),
    common40_horizons: Object.fromEntries([10, 15, 20, 25, 30, 40].map((horizon) => {
      return [horizon, { fixed: describe(trades(common40, "固定", horizon)), protected: describe(trades(common40, "保护", horizon)) }];
    })),
    event20: { ...stats(events.map((e) => e.value)), mae_mean: average(events.map((e) => e.mae)),
      benchmark: stats(events.map((e) => e.baseline)), excess: stats(events.map((e) => e.value - e.baseline)),
      downtrend_excess: stats(events.filter((e) => e.downtrend_baseline !== null).map((e) => e.value - e.downtrend_baseline!)),
      excess_month_ci: blockInterval(events.map((e) => ({ date: e.date, value: e.value - e.baseline }))) },
    fixed20_benchmark: stats(matched.map((r) => r.baseline)),
    fixed20_excess: stats(matched.map((r) => r.trade.value - r.baseline)),
    fixed20_excess_month_ci: blockInterval(matched.map((r) => ({ date: rowDate(r.trade), value: r.trade.value - r.baseline }))),
    shanghai_comparison: {
      code: "000001.SH", name: "上证指数", sql: indexSql,
      source: verifiedIndexPath,
      query_params: [START, asOf, "000001.SH", "上证指数"],
      input_hash: createHash("sha256").update(JSON.stringify(indexRows)).digest("hex"),
      rows: indexRows.length, first: indexRows[0]?.bar_date, last: indexRows.at(-1)?.bar_date,
      channels: [...new Set(indexRows.map((r) => r.channel))], adjustments: [...new Set(indexRows.map((r) => r.adjustment))],
      fixed20: compareIndex(fixed), protected20: compareIndex(protectedTrades),
    },
    csi300_comparison: {
      code: "000300.SH", name: "沪深300", sql: indexSql,
      source: verifiedIndexPath,
      query_params: [START, asOf, "000300.SH", "沪深300"],
      input_hash: createHash("sha256").update(JSON.stringify(csi300Rows)).digest("hex"),
      rows: csi300Rows.length, first: csi300Rows[0]?.bar_date, last: csi300Rows.at(-1)?.bar_date,
      channels: [...new Set(csi300Rows.map((r) => r.channel))], adjustments: [...new Set(csi300Rows.map((r) => r.adjustment))],
      fixed20: compareIndex(fixed, csi300Bars), protected20: compareIndex(protectedTrades, csi300Bars),
      industry_equal_weight20: compareIndex(matched.map((r) => ({ ...r.trade, value: r.baseline })), csi300Bars),
    },
    exit_paired_month_ci: blockInterval(protectedTrades.map((t, i) => ({ date: rowDate(t), value: t.value - ma10Trades[i]!.value }))),
    horizon_paired_month_ci: {
      protected20_minus25: blockInterval(protected20.map((t, i) => ({ date: rowDate(t), value: t.value - protected25[i]!.value }))),
      protected20_minus30: blockInterval(protected20.map((t, i) => ({ date: rowDate(t), value: t.value - protected30[i]!.value }))),
    },
    controls_same_exit: { right_fixed: describe(trades(right, "固定")), right_protected: describe(trades(right, "保护")), temperature_fixed: describe(trades(temperature, "固定")), temperature_protected: describe(trades(temperature, "保护")) },
    by_year: byYear, by_pattern: shapeGroups,
    primary_presence: { exists: describe(fixed.filter((t) => t.signal.primary)), needle_only: describe(fixed.filter((t) => !t.signal.primary)) },
    contraction: { yes: relative(fixed.filter((t) => t.signal.snapshot.contracting)), no: relative(fixed.filter((t) => !t.signal.snapshot.contracting)) },
    excluding_gap_boards: relative(fixed.filter((t) => !gaps.some((g) => g.code === t.signal.board.code))),
    volume_common_universe: Object.fromEntries(["缩量", "温和放量", "明显放量", "爆量"].map((label) => [label, stats(event(unfiltered.filter((s) => s.snapshot.volumeClass === label)).map((e) => e.value))])),
    regimes: Object.fromEntries(["牛市", "震荡", "熊市"].map((regime) => {
      const subset = events.filter((e) => regimeByDate.get(e.date) === regime);
      return [regime, { ...stats(subset.map((e) => e.value)), mae_mean: average(subset.map((e) => e.mae)), benchmark: stats(subset.map((e) => e.baseline)), excess: stats(subset.map((e) => e.value - e.baseline)) }];
    })),
    concentration: { top_months: months.slice(0, 5),
      excluding_top3: stats(events.filter((e) => !months.slice(0, 3).some((m) => e.date.startsWith(m.month))).map((e) => e.value)),
      excluding_top3_excess: stats(events.filter((e) => !months.slice(0, 3).some((m) => e.date.startsWith(m.month))).map((e) => e.value - e.baseline)) },
    trades: protectedTrades.map((t) => ({ code: t.signal.board.code, signal_date: rowDate(t), entry: t.entry, exit: t.exit, value: t.value, days: t.days, reason: t.reason })),
    caveats: ["当前行业目录回看，不是点时成分", "指数代理不可直接交易", "全部参数已在历史上观察，年度切片及重采样不构成样本外", "月块区间未校正参数搜索且未覆盖所有跨月相关", "无仓位约束，逐笔均值不等于组合收益"],
  };
  const out = path.resolve("支撑/tmp/夜间板块双线趋势回测", `独立结论复核-${asOf}-${inputHash.slice(0, 12)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(output, null, 2));
  const { trades: _trades, ...summary } = output;
  console.log(JSON.stringify(summary, null, 2)); console.log(`证据：${out}`);
}

await main();
