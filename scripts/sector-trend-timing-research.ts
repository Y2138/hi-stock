// 冻结372个行业事件，检查前后走势、日期去重择时与同日选板排序；只读数据库。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import { hithinkGet } from "../server/datasource/hithink.js";
import { sectorTrendSnapshot, type SectorTrendBar, type SectorTrendParams } from "./lib/sector-trend-rules.js";

const DIRECTORY = path.resolve("支撑/tmp/夜间板块双线趋势回测");
const SOURCE = path.join(DIRECTORY, "独立结论复核-2026-10-10-786a4c73ec92.json");
const COST = 12.5 / 10000;
const VERIFIED_INDICES = path.join(DIRECTORY, "远端核验指数日线.json");
const mean = (values: number[]) => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2 : null;
};
const stats = (values: number[]) => ({ count: values.length, mean: mean(values), median: median(values), win_rate: mean(values.map((v) => v > 0 ? 1 : 0)) });
const std = (values: number[]) => Math.sqrt(mean(values.map((v) => (v - mean(values)!) ** 2))!);
function spaced(indices: number[], gap: number) {
  const kept: number[] = [];
  for (const index of indices) if (!kept.length || index - kept.at(-1)! >= gap) kept.push(index);
  return kept;
}
function interval(rows: Array<{ date: string; value: number }>) {
  const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))];
  const blocks = months.map((month) => rows.filter((r) => r.date.startsWith(month)).map((r) => r.value));
  if (!blocks.length) return null;
  let seed = 20261010;
  const means: number[] = [];
  for (let trial = 0; trial < 4000; trial += 1) {
    const values: number[] = [];
    for (let i = 0; i < blocks.length; i += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      values.push(...blocks[Math.floor(seed / 2 ** 32 * blocks.length)]!);
    }
    means.push(mean(values)!);
  }
  means.sort((a, b) => a - b);
  return { months: months.length, low: means[100], high: means[3899] };
}
interface InputBar extends SectorTrendBar { channel: string; adjustment: string | null }
interface Evidence {
  sql: string; input_hash: string; as_of: string; params: SectorTrendParams;
  trades: Array<{ code: string; signal_date: string }>;
  exits: { 固定: { mean: number; count: number } };
}

async function main() {
  assert.deepEqual(spaced([0, 3, 19, 20, 22, 40], 20), [0, 20, 40]);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(std([1, 1, 1]), 0);
  assert(Math.abs(interval([{ date: "2022-01-01", value: 0.1 }])!.low! - 0.1) < 1e-12);
  if (process.argv.includes("--self-check")) { console.log("择时研究自检通过"); return; }
  const evidence = JSON.parse(fs.readFileSync(SOURCE, "utf8")) as Evidence;
  const pool = getPool(loadConfig().databaseUrl), client = await pool.connect();
  const indexSql = `SELECT i.code,b.bar_date::text,b.open::float8,b.close::float8,b.channel,b.adjustment
    FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id
    WHERE i.code=ANY($1::text[]) AND i.kind='index' AND b.freq='day'
      AND b.bar_date>='2021-09-13' AND b.bar_date<=$2::date ORDER BY i.code,b.bar_date,b.bar_time`;
  let bars: InputBar[], indexBars: Array<{ code: string; bar_date: string; open: number; close: number; channel: string; adjustment: string | null }>;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30s'");
    bars = (await client.query(evidence.sql, [evidence.as_of])).rows;
    indexBars = (await client.query(indexSql, [["000001.SH", "000300.SH"], evidence.as_of])).rows;
    await client.query("ROLLBACK");
    if (process.argv.includes("--refresh-index")) {
      const verified: typeof indexBars = [];
      for (const code of ["000001.SH", "000300.SH"]) {
        for (let year = 2022; year <= 2026; year += 1) {
          const start = `${year}-01-01`;
          const end = year === 2026 ? evidence.as_of : `${year}-12-31`;
          const cache = path.join(DIRECTORY, `基准真实日线-${code}-${year}.json`);
          const params = { thscode: code, interval: "1d", start: Date.parse(`${start}T00:00:00+08:00`), end: Date.parse(`${end}T23:59:59+08:00`) };
          const data = fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, "utf8"))
            : await hithinkGet("/api/a-share-index/prices/historical", params, { db: client, timeoutMs: 30000 });
          assert(Array.isArray(data.item) && data.item.length > 0, `${code} ${year}远端日线为空`);
          fs.writeFileSync(cache, JSON.stringify(data));
          for (const row of data.item) {
            const date = new Date(Number(row.date_ms) + 8 * 3600 * 1000).toISOString().slice(0, 10);
            assert(date >= start && date <= end, "远端返回日期越界");
            verified.push({ code, bar_date: date, open: Number(row.open_price), close: Number(row.close_price), channel: "hithink_remote_verified", adjustment: null });
          }
          console.log(`远端核验 ${code} ${year}：${data.item.length}根`);
        }
      }
      verified.sort((a, b) => a.code.localeCompare(b.code) || a.bar_date.localeCompare(b.bar_date));
      fs.writeFileSync(VERIFIED_INDICES, JSON.stringify(verified));
    }
  } finally { client.release(); await closePool(); }
  const localIndexBars = indexBars;
  assert(fs.existsSync(VERIFIED_INDICES), "本地指数历史已发现错位，必须先执行--refresh-index核验，禁止继续使用旧基准");
  indexBars = JSON.parse(fs.readFileSync(VERIFIED_INDICES, "utf8"));
  const localMismatch = localIndexBars.filter((bar) => {
    const remote = indexBars.find((r) => r.code === bar.code && r.bar_date === bar.bar_date);
    return remote && (Math.abs(bar.open - remote.open) > 0.01 || Math.abs(bar.close - remote.close) > 0.01);
  });
  assert.equal(createHash("sha256").update(JSON.stringify(bars)).digest("hex"), evidence.input_hash, "行情与冻结证据不一致，请先复核源证据");
  const boards = new Map<string, InputBar[]>(), boardDates = new Map<string, Map<string, InputBar>>();
  for (const bar of bars) {
    const values = boards.get(bar.code) ?? []; values.push(bar); boards.set(bar.code, values);
    const dates = boardDates.get(bar.code) ?? new Map<string, InputBar>();
    assert(!dates.has(bar.bar_date), "行业日期重复"); dates.set(bar.bar_date, bar); boardDates.set(bar.code, dates);
  }
  const dates = [...new Set(bars.map((b) => b.bar_date))].sort(), dateIndex = new Map(dates.map((date, i) => [date, i]));
  const indices = new Map<string, Map<string, typeof indexBars[number]>>();
  for (const bar of indexBars) {
    const values = indices.get(bar.code) ?? new Map(); assert(!values.has(bar.bar_date), "指数日期重复");
    assert(Number.isFinite(bar.open) && bar.open > 0 && Number.isFinite(bar.close) && bar.close > 0, "指数行情非法");
    values.set(bar.bar_date, bar); indices.set(bar.code, values);
  }
  const daily = dates.map((date, i) => {
    if (!i) return 0;
    const returns = [...boardDates.values()].flatMap((map) => {
      const current = map.get(date), previous = map.get(dates[i - 1]!);
      return current && previous ? [current.close / previous.close - 1] : [];
    });
    assert(returns.length >= 81, `行业覆盖不足九成：${date}`);
    return mean(returns)!;
  });
  const composite: number[] = [100];
  for (let i = 1; i < dates.length; i += 1) composite.push(composite.at(-1)! * (1 + daily[i]!));
  const closePath = (code: string, anchor: number, offset: number) => {
    if (code === "行业等权") return composite[anchor + offset]! / composite[anchor]! - 1;
    const map = indices.get(code)!;
    const target = map.get(dates[anchor + offset]!), base = map.get(dates[anchor]!);
    return target && base ? target.close / base.close - 1 : null;
  };
  const netBoard = (map: Map<string, InputBar>, anchor: number) => {
    const entry = map.get(dates[anchor + 1]!), exit = map.get(dates[anchor + 21]!);
    return entry && exit ? exit.open * (1 - COST) / (entry.open * (1 + COST)) - 1 : null;
  };
  const netBroad = (anchor: number) => mean([...boardDates.values()].flatMap((map) => {
    const value = netBoard(map, anchor); return value === null ? [] : [value];
  }))!;
  const netIndex = (code: string, anchor: number) => {
    const map = indices.get(code)!, entry = map.get(dates[anchor + 1]!), exit = map.get(dates[anchor + 21]!);
    return entry && exit ? exit.open * (1 - COST) / (entry.open * (1 + COST)) - 1 : null;
  };
  const events = evidence.trades.map((trade) => {
    const anchor = dateIndex.get(trade.signal_date)!;
    const map = boardDates.get(trade.code)!, values = boards.get(trade.code)!;
    const barIndex = values.findIndex((bar) => bar.bar_date === trade.signal_date);
    const snapshot = sectorTrendSnapshot(values, barIndex, evidence.params)!;
    assert(snapshot.escapesMediumDowntrend && snapshot.recentBottomingPattern && snapshot.volumeRatio! < 1.5, "源信号规则不一致");
    const value = netBoard(map, anchor); assert(value !== null, "事件未来开盘缺失");
    const daily20 = dates.slice(anchor - 19, anchor + 1).map((date, k) => map.get(date)!.close / map.get(dates[anchor - 20 + k]!)!.close - 1);
    const relative20 = map.get(dates[anchor]!)!.close / map.get(dates[anchor - 20]!)!.close - composite[anchor]! / composite[anchor - 20]!;
    return { code: trade.code, date: trade.signal_date, anchor, value, broad: netBroad(anchor),
      relative20, volatility20: std(daily20), volumeRatio: snapshot.volumeRatio!,
      distanceLow: map.get(trade.signal_date)!.close / snapshot.priorLow! - 1,
      pre20: map.get(trade.signal_date)!.close / map.get(dates[anchor - 20]!)!.close - 1 };
  });
  assert.equal(events.length, evidence.exits.固定.count, "冻结事件数不一致");
  assert(Math.abs(mean(events.map((e) => e.value))! - evidence.exits.固定.mean) < 1e-10, "公共交易日成交收益与原逐笔规则不一致");
  const anchors = [...new Set(events.map((e) => e.anchor))].sort((a, b) => a - b);
  const nonoverlap = spaced(anchors, 20);
  const eligible = dates.map((_, i) => i).filter((i) => dates[i]! >= "2022-01-01" && i >= 40 && i + 40 < dates.length
    && [...indices.values()].every((map) => dates.slice(i - 40, i + 41).every((date) => map.has(date))));
  const eligibleSet = new Set(eligible), fullEvents = events.filter((e) => eligibleSet.has(e.anchor));
  const curveCohorts = {
    行业事件: fullEvents.map((e) => e.anchor),
    信号日期: anchors.filter((i) => eligibleSet.has(i)),
    间隔20日: nonoverlap.filter((i) => eligibleSet.has(i)),
    全部可比日期: eligible,
    无信号日期: eligible.filter((i) => !anchors.includes(i)),
  };
  const returnDates = dates.map((_, i) => i).filter((i) => dates[i]! >= "2022-01-01" && i >= 20 && i + 21 < dates.length
    && !!netIndex("000300.SH", i) && !!netIndex("000001.SH", i));
  const cohorts = {
    行业事件: events.map((e) => e.anchor), 信号日期: anchors, 间隔20日: nonoverlap,
    全部可比日期: returnDates, 无信号日期: returnDates.filter((i) => !anchors.includes(i)),
  };
  const summarizeTiming = (values: number[]) => ({
    count: values.length,
    broad_pre20: stats(values.map((i) => composite[i]! / composite[i - 20]! - 1)),
    broad_pre5: stats(values.map((i) => composite[i]! / composite[i - 5]! - 1)),
    broad_post20: stats(values.map((i) => netBroad(i))),
    csi300_post20: stats(values.map((i) => netIndex("000300.SH", i)!)),
    broad_post20_month_ci: interval(values.map((i) => ({ date: dates[i]!, value: netBroad(i) }))),
    rebound_from_low20: stats(values.map((i) => composite[i]! / Math.min(...composite.slice(i - 20, i + 1)) - 1)),
    days_since_low20: stats(values.map((i) => { const slice = composite.slice(i - 20, i + 1); return 20 - slice.indexOf(Math.min(...slice)); })),
    drawdown_next20: stats(values.map((i) => Math.min(...composite.slice(i + 1, i + 21)) / composite[i]! - 1)),
    by_year: Object.fromEntries([...new Set(values.map((i) => dates[i]!.slice(0, 4)))].map((year) => [year, stats(values.filter((i) => dates[i]!.startsWith(year)).map((i) => netBroad(i)))])),
  });
  const curves = Object.fromEntries(Object.entries(curveCohorts).filter(([name]) => name !== "无信号日期").map(([name, values]) => [name, {
    count: values.length,
    points: Array.from({ length: 81 }, (_, j) => j - 40).map((offset) => ({ offset,
      行业等权: mean(values.map((i) => closePath("行业等权", i, offset)!)),
      沪深300: mean(values.map((i) => closePath("000300.SH", i, offset)!)),
      上证指数: mean(values.map((i) => closePath("000001.SH", i, offset)!)),
      入选行业: name === "行业事件" ? mean(fullEvents.map((e) => {
        const map = boardDates.get(e.code)!;
        return map.get(dates[e.anchor + offset]!)!.close / map.get(e.date)!.close - 1;
      })) : null,
    })),
  }]));
  const grouped = anchors.map((anchor) => events.filter((e) => e.anchor === anchor));
  const multiple = grouped.filter((rows) => rows.length >= 2);
  const rankings = Object.fromEntries((["relative20", "volatility20", "volumeRatio"] as const).map((feature) => {
    const samples = multiple.map((rows) => {
      const sorted = [...rows].sort((a, b) => (feature === "relative20" ? b[feature] - a[feature] : a[feature] - b[feature]) || a.code.localeCompare(b.code));
      const selected = sorted[0]!;
      return { date: selected.date, code: selected.code, value: selected.value, baseline: mean(rows.map((e) => e.value))!, broad: selected.broad };
    });
    return [feature, { top1: stats(samples.map((s) => s.value)), all_same_date: stats(samples.map((s) => s.baseline)),
      improvement: stats(samples.map((s) => s.value - s.baseline)), broad_excess: stats(samples.map((s) => s.value - s.broad)),
      improvement_month_ci: interval(samples.map((s) => ({ date: s.date, value: s.value - s.baseline }))),
      by_year: Object.fromEntries([...new Set(samples.map((s) => s.date.slice(0, 4)))].map((year) => [year, stats(samples.filter((s) => s.date.startsWith(year)).map((s) => s.value - s.baseline))])), samples }];
  }));
  const calendar = anchors.map((anchor) => ({ date: dates[anchor]!, count: events.filter((e) => e.anchor === anchor).length,
    selected: stats(events.filter((e) => e.anchor === anchor).map((e) => e.value)), broad20: netBroad(anchor), csi30020: netIndex("000300.SH", anchor),
    pre20: composite[anchor]! / composite[anchor - 20]! - 1, pre5: composite[anchor]! / composite[anchor - 5]! - 1 }));
  const episodeDates = ["2022-05", "2024-02", "2024-09"].map((month) => calendar.find((e) => e.date.startsWith(month))!.date);
  episodeDates.push([...calendar].filter((e) => e.date.startsWith("2023") && eligibleSet.has(dateIndex.get(e.date)!)).sort((a, b) => a.broad20 - b.broad20)[0]!.date);
  const episodes = episodeDates.map((date) => {
    const anchor = dateIndex.get(date)!;
    const codes = events.filter((e) => e.date === date).map((e) => e.code);
    return { date, codes, points: Array.from({ length: 61 }, (_, j) => j - 20).map((offset) => ({ offset, date: dates[anchor + offset]!,
      行业等权: closePath("行业等权", anchor, offset), 沪深300: closePath("000300.SH", anchor, offset),
      入选行业: mean(codes.map((code) => { const map = boardDates.get(code)!; return map.get(dates[anchor + offset]!)!.close / map.get(date)!.close - 1; })) })),
      summary: calendar.find((e) => e.date === date) };
  });
  const matchedOversold = cohorts.信号日期.map((anchor) => {
    const pre = composite[anchor]! / composite[anchor - 20]! - 1, year = dates[anchor]!.slice(0, 4);
    // 只按已知年度、过去20日跌幅和最近5日是否反弹匹配；不使用未来回报选日期。
    const controls = cohorts.无信号日期.filter((i) => dates[i]!.startsWith(year)
      && Math.abs(composite[i]! / composite[i - 20]! - 1 - pre) <= 0.02
      && (composite[i]! > composite[i - 5]!) === (composite[anchor]! > composite[anchor - 5]!));
    return controls.length ? [{ date: dates[anchor]!, signal: netBroad(anchor), control: mean(controls.map((i) => netBroad(i)))!, controls: controls.length }] : [];
  }).flat();
  const result = { evidence: "research_only", source: SOURCE, input_hash: evidence.input_hash,
    index_source: VERIFIED_INDICES, local_index_mismatches: Object.fromEntries(["000001.SH", "000300.SH"].map((code) => [code, {
      count: localMismatch.filter((r) => r.code === code).length,
      by_year: Object.fromEntries([...new Set(localMismatch.filter((r) => r.code === code).map((r) => r.bar_date.slice(0, 4)))].map((year) => [year, localMismatch.filter((r) => r.code === code && r.bar_date.startsWith(year)).length])),
    }])),
    local_index_unverified_dates: localIndexBars.filter((r) => !indexBars.some((v) => v.code === r.code && v.bar_date === r.bar_date)).map((r) => ({ code: r.code, date: r.bar_date })),
    index_input_hash: createHash("sha256").update(JSON.stringify(indexBars)).digest("hex"), index_sql: indexSql,
    scope: { original_events: events.length, signal_dates: anchors.length, spaced_dates: nonoverlap.length, curve_events: fullEvents.length,
      curve_dates: curveCohorts.信号日期.length, curve_spaced_dates: curveCohorts.间隔20日.length,
      curves: "公共交易日-40至+40，信号日收盘归零，未扣费用；行业等权曲线为每日再平衡合成",
      returns: "公共交易日+1开盘至+21开盘，单边12.5bp，行业基准为等权行业买入持有" },
    timing: Object.fromEntries(Object.entries(cohorts).map(([name, values]) => [name, summarizeTiming(values)])),
    oversold_match: { count: matchedOversold.length, signal: stats(matchedOversold.map((r) => r.signal)), control: stats(matchedOversold.map((r) => r.control)),
      difference: stats(matchedOversold.map((r) => r.signal - r.control)), month_ci: interval(matchedOversold.map((r) => ({ date: r.date, value: r.signal - r.control }))) },
    curves, rankings, calendar, episodes,
    caveats: ["择时与排序为已观察历史的探索，非样本外", "日期去重和间隔20日样本仍可能共享市场周期", "匹配对照允许日期重复且未来窗口重叠，区间未校正参数搜索", "所有排序仅使用信号收盘可得数据，不代表个股选股收益", "三个成功月按已知贡献选取，2023案例按已知失败挑选，均为说明样例而非随机抽样"] };
  const out = path.join(DIRECTORY, "反弹择时与选板增强复核.json");
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  const { curves: _curves, calendar: _calendar, episodes: _episodes, rankings: _rankings, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
  console.log("排序", JSON.stringify(Object.fromEntries(Object.entries(rankings).map(([k, v]) => { const { samples: _samples, ...rest } = v; return [k, rest]; })), null, 2));
  console.log(`证据：${out}`);
}

await main();
