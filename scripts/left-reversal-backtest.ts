// 左侧两年结构反转策略最终回测：动态池、信号分档仓位、MA20减半与ATR移动止损。
// 只读 PostgreSQL，结果为 research_only，不写业务台账。
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { inspectStandardInput, decodeStandardChunk } from "./lib/backtest-input.js";
import { contentHash, validateStandardPlan, type StandardBacktestPlan, type StandardBar, type StandardDay } from "./lib/backtest-contracts.js";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";

type WindowName = "train" | "test" | "full" | "longTrain" | "longTest" | "long";
interface Point { globalIndex: number; localIndex: number; bar: StandardBar; ret5: number | null; ma20: number | null; atr14: number | null; drawdown20: number | null; volumeRatio: number | null }
interface Series { rows: Point[]; byDay: Array<Point | null> }
interface Signal { code: string; industry: string; signalDate: string; entryDate: string; entryOpen: number; signalLow: number; stockDrawdown20: number; score: number }
interface Position { quantity: number; originalQuantity: number; cost: number; entryPrice: number; entryLocalIndex: number; industry: string; stopFloor: number; peak: number; maDone: boolean; lastClose: number }
type ExitMode = "A" | "固定20" | "低点20" | "MA20低点20" | "相对低点20" | "修复止损20";
type AllocationMode = "分档" | "等权20" | "固定10";
interface Configuration { name: string; exit: ExitMode; allocation: AllocationMode; dailyLimit: number; industryLimit: number; exposureCap: number }
interface Metrics { configuration: string; slippage_bps: number; total_return: number; max_drawdown: number; closed_positions: number; partial_sells: number; win_rate: number | null; fees: number; average_holding_days: number | null; average_positions: number; paused_days: number; open_positions: number }
const WINDOWS: Record<WindowName, { start: string; end: string }> = {
  train: { start: "2023-01-03", end: "2024-12-31" }, test: { start: "2025-01-02", end: "2026-08-31" }, full: { start: "2023-01-03", end: "2026-08-31" },
  longTrain: { start: "2017-01-03", end: "2021-12-31" }, longTest: { start: "2022-01-04", end: "2026-08-31" }, long: { start: "2017-01-03", end: "2026-08-31" },
};
const args = process.argv.slice(2); const argOf = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const windows = (argOf("--window")?.split(",") ?? ["train", "test", "full", "longTrain", "longTest", "long"]) as WindowName[];
const sampleSize = Math.min(1000, Math.max(100, Number(argOf("--sample") ?? 300)));
const outputDir = path.resolve("支撑/tmp/左侧两年结构反转"); const db = getPool(loadConfig().databaseUrl);
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const pct = (value: number | null) => value === null ? "-" : `${(value * 100).toFixed(2)}%`;
function atr(rows: StandardBar[], index: number): number | null { if (index < 14) return null; let total = 0; for (let i = index - 13; i <= index; i += 1) { const row = rows[i]!; const prior = rows[i - 1]!.close; total += Math.max(row.high - row.low, Math.abs(row.high - prior), Math.abs(row.low - prior)); } return total / 14; }
async function selectCodes(): Promise<string[]> {
  const { rows } = await db.query<{ code: string }>(`WITH eligible AS (
    SELECT i.code FROM market_instrument i JOIN market_bar b ON b.instrument_id=i.id
    WHERE i.kind='stock' AND i.code~'^\\d{6}\\.(SH|SZ)$' AND b.freq='day' AND b.bar_date BETWEEN '2011-01-03' AND '2026-08-31'
      AND b.adjustment='forward' AND b.volume_unit IN ('share','shares','股') AND b.close>0 AND b.volume>0
      AND b.low<=LEAST(b.open,b.close) AND b.high>=GREATEST(b.open,b.close)
    GROUP BY i.code HAVING count(*)>=200
  ), bad AS (
    SELECT i.code FROM market_instrument i JOIN market_bar b ON b.instrument_id=i.id
    WHERE i.kind='stock' AND i.code~'^\\d{6}\\.(SH|SZ)$' AND b.freq='day' AND b.bar_date BETWEEN '2011-01-03' AND '2026-08-31'
      AND (b.adjustment IS DISTINCT FROM 'forward' OR b.volume_unit IS NULL OR b.open<=0 OR b.high<=0 OR b.low<=0 OR b.close<=0
        OR b.low>LEAST(b.open,b.close) OR b.high<GREATEST(b.open,b.close) OR b.volume<0 OR b.volume<>trunc(b.volume)) GROUP BY i.code
  ), duplicate AS (
    SELECT i.code FROM market_instrument i JOIN market_bar b ON b.instrument_id=i.id
    WHERE i.kind='stock' AND i.code~'^\\d{6}\\.(SH|SZ)$' AND b.freq='day' AND b.bar_date BETWEEN '2011-01-03' AND '2026-08-31'
    GROUP BY i.code HAVING count(*)>count(DISTINCT b.bar_date)
  ) SELECT code FROM eligible WHERE code NOT IN (SELECT code FROM bad) AND code NOT IN (SELECT code FROM duplicate) ORDER BY md5(code) LIMIT $1`, [sampleSize]);
  return rows.map(row => row.code).sort();
}
async function loadIndustries(codes: string[]): Promise<Map<string, string>> {
  const { rows } = await db.query<{ code: string; industry: string }>(`SELECT DISTINCT ON(mi.code) mi.code,bi.code AS industry
    FROM market_board_membership mm JOIN market_instrument mi ON mi.id=mm.member_instrument_id
    JOIN market_board mb ON mb.instrument_id=mm.board_instrument_id AND mb.active AND mb.source='hithink' AND mb.board_type='industry'
    JOIN market_instrument bi ON bi.id=mb.instrument_id WHERE mm.effective_to IS NULL AND mi.code=ANY($1::text[]) ORDER BY mi.code,bi.code`, [codes]);
  return new Map(rows.map(row => [row.code, row.industry]));
}
async function loadBoardSeries(codes: string[], start: string, end: string): Promise<Map<string, StandardBar[]>> {
  const { rows } = await db.query<StandardBar>(`SELECT i.code,b.bar_date::text AS date,b.open::float8,b.high::float8,b.low::float8,b.close::float8,b.volume::float8
    FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id WHERE i.code=ANY($1::text[]) AND b.freq='day'
      AND b.bar_date BETWEEN ($2::date-interval '30 days') AND $3::date ORDER BY i.code,b.bar_date`, [codes, start, end]);
  const result = new Map<string, StandardBar[]>(); for (const row of rows) result.set(row.code, [...(result.get(row.code) ?? []), row]); return result;
}
function buildSeries(days: StandardDay[], codes: string[]): Map<string, Series> {
  const raw = new Map<string, Array<{ globalIndex: number; bar: StandardBar }>>(codes.map(code => [code, []]));
  days.forEach((day, globalIndex) => day.bars.forEach(bar => raw.get(bar.code)?.push({ globalIndex, bar })));
  const result = new Map<string, Series>();
  for (const code of codes) {
    const source = raw.get(code) ?? []; const bars = source.map(item => item.bar); const points: Point[] = [];
    for (let localIndex = 0; localIndex < bars.length; localIndex += 1) {
      const bar = bars[localIndex]!; const closes20 = bars.slice(Math.max(0, localIndex - 19), localIndex + 1).map(row => row.close);
      const averageVolume = mean(bars.slice(Math.max(0, localIndex - 60), localIndex).map(row => row.volume));
      points.push({ globalIndex: source[localIndex]!.globalIndex, localIndex, bar,
        ret5: localIndex >= 5 ? bar.close / bars[localIndex - 5]!.close - 1 : null,
        ma20: closes20.length === 20 ? mean(closes20) : null, atr14: atr(bars, localIndex),
        drawdown20: closes20.length === 20 ? bar.close / Math.max(...closes20) - 1 : null,
        volumeRatio: averageVolume && averageVolume > 0 ? bar.volume / averageVolume : null });
    }
    const byDay: Array<Point | null> = Array(days.length).fill(null); points.forEach(point => { byDay[point.globalIndex] = point; }); result.set(code, { rows: points, byDay });
  }
  return result;
}
function buildIndustryIndices(dayCount: number, groups: Map<string, string[]>, series: Map<string, Series>): Map<string, Array<number | null>> {
  const result = new Map<string, Array<number | null>>();
  for (const [industry, members] of groups) { let value = 100; const previous = new Map<string, number>(); const values: Array<number | null> = [];
    for (let index = 0; index < dayCount; index += 1) { const returns: number[] = []; for (const code of members) { const point = series.get(code)?.byDay[index]; const prior = previous.get(code); if (point && prior && prior > 0) returns.push(point.bar.close / prior - 1); if (point) previous.set(code, point.bar.close); } if (returns.length >= 3) value *= 1 + (mean(returns) ?? 0); values.push(returns.length >= 3 ? value : null); }
    result.set(industry, values);
  } return result;
}
function generateSignals(codes: string[], groups: Map<string, string[]>, industries: Map<string, string>, series: Map<string, Series>, industryIndices: Map<string, Array<number | null>>, start: string, end: string): Signal[] {
  const raw: Signal[] = [];
  for (const code of codes) { const stock = series.get(code); const industry = industries.get(code); if (!stock || !industry) continue; const indexValues = industryIndices.get(industry) ?? [];
    for (const point of stock.rows) { if (point.bar.date < start || point.bar.date > end || point.ret5 === null || point.drawdown20 === null || point.volumeRatio === null) continue; const index = point.globalIndex; const current = indexValues[index] ?? null; const prior5 = indexValues[index - 5] ?? null; const prior500 = indexValues[index - 500] ?? null; const longValues = indexValues.slice(Math.max(0, index - 499), index + 1).filter((value): value is number => value !== null); const recent20 = indexValues.slice(Math.max(0, index - 19), index + 1).filter((value): value is number => value !== null); if (current === null || prior5 === null || prior500 === null || longValues.length < 450 || recent20.length < 10) continue; const peerReturns = (groups.get(industry) ?? []).flatMap(member => { const peer = series.get(member)?.byDay[index]; return peer?.ret5 === null || peer?.ret5 === undefined ? [] : [peer.ret5]; });
      if (peerReturns.length < 3) continue; const relative5 = point.ret5 - (mean(peerReturns) ?? 0); const industryDrawdown = current / Math.max(...recent20) - 1; const longBull = current >= (mean(longValues) ?? current) && current / prior500 - 1 > 0; if (!longBull || industryDrawdown > -0.10 || industryDrawdown <= -0.30 || point.ret5 > -0.08 || relative5 > -0.05) continue; const entry = stock.rows[point.localIndex + 1]; if (!entry || entry.bar.open <= 0) continue; const volumeScore = point.volumeRatio >= 2 ? 4 : point.volumeRatio >= 1.5 ? 3 : point.volumeRatio >= 1.2 ? 2 : point.volumeRatio >= 1 ? 1 : 0; raw.push({ code, industry, signalDate: point.bar.date, entryDate: entry.bar.date, entryOpen: entry.bar.open, signalLow: point.bar.low, stockDrawdown20: point.drawdown20, score: Math.max(0, -relative5 * 100) + Math.max(0, -point.drawdown20 * 30) + volumeScore * 2 }); }
  }
  const kept: Signal[] = []; const last = new Map<string, number>();
  for (const signal of raw.sort((a, b) => a.code.localeCompare(b.code) || a.signalDate.localeCompare(b.signalDate))) { const timestamp = Date.parse(signal.signalDate); const previous = last.get(signal.code); if (previous !== undefined && timestamp - previous <= 10 * 86_400_000) continue; last.set(signal.code, timestamp); kept.push(signal); }
  return kept.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || b.score - a.score || a.code.localeCompare(b.code));
}
function allocation(signal: Signal): number { return -signal.stockDrawdown20 >= 0.20 ? 0.25 : -signal.stockDrawdown20 >= 0.15 ? 0.20 : 0.12; }
function simulate(days: StandardDay[], series: Map<string, Series>, boardSeries: Map<string, StandardBar[]>, signals: Signal[], start: string, end: string, slippageBps: number, config: Configuration): Metrics {
  const initial = 1_000_000; let cash = initial; let peakEquity = initial; let maxDrawdown = 0; let fees = 0; let closed = 0; let partials = 0; let wins = 0; let positionDays = 0; let pausedDays = 0; let paused = false; const holdings: number[] = []; const recent: number[] = [];
  const entries = new Map<string, Signal[]>(); signals.forEach(signal => entries.set(signal.entryDate, [...(entries.get(signal.entryDate) ?? []), signal])); const positions = new Map<string, Position>();
  const sell = (position: Position, quantity: number, close: number, full: boolean, held: number) => { const gross = quantity * close * (1 - slippageBps / 10_000); const fee = Math.max(5, gross * 0.00025) + gross * 0.001; const ratio = quantity / position.quantity; const allocatedCost = position.cost * ratio; cash += gross - fee; fees += fee; position.quantity -= quantity; position.cost -= allocatedCost; if (full) { closed += 1; holdings.push(held); if (gross - fee > allocatedCost) wins += 1; } else partials += 1; };
  for (let index = 0; index < days.length; index += 1) { const day = days[index]!; if (day.date < start || day.date > end) continue; const bars = new Map(day.bars.map(bar => [bar.code, bar])); const equity = () => cash + [...positions].reduce((sum, [code, position]) => sum + position.quantity * (bars.get(code)?.close ?? position.lastClose), 0); if (paused) pausedDays += 1; let opened = 0;
    if (!paused) for (const signal of [...(entries.get(day.date) ?? [])].sort((a, b) => (b.score - a.score) || a.code.localeCompare(b.code))) { if (opened >= config.dailyLimit || positions.size >= 5 || positions.has(signal.code)) continue; const sameIndustry = [...positions.values()].filter(position => position.industry === signal.industry).length; if (sameIndustry >= config.industryLimit) continue; const rawOpen = bars.get(signal.code)?.open; if (!rawOpen) continue; const price = rawOpen * (1 + slippageBps / 10_000); const total = equity(); const exposure = [...positions.values()].reduce((sum, position) => sum + position.quantity * position.lastClose, 0); const fraction = config.allocation === "分档" ? allocation(signal) : config.allocation === "等权20" ? 0.20 : 0.10; const budget = Math.min(cash, total * fraction, Math.max(0, total * config.exposureCap - exposure)); const quantity = Math.floor(budget / price / 100) * 100; if (quantity < 100) continue; const gross = quantity * price; const fee = Math.max(5, gross * 0.00025); if (gross + fee > cash) continue; const entryPoint = series.get(signal.code)?.byDay[index]; if (!entryPoint) continue; cash -= gross + fee; fees += fee; opened += 1; positions.set(signal.code, { quantity, originalQuantity: quantity, cost: gross + fee, entryPrice: price, entryLocalIndex: entryPoint.localIndex, industry: signal.industry, stopFloor: signal.signalLow, peak: price, maDone: false, lastClose: price }); }
    for (const [code, position] of [...positions]) { const point = series.get(code)?.byDay[index]; if (!point) continue; position.lastClose = point.bar.close; position.peak = Math.max(position.peak, point.bar.close); const held = point.localIndex - position.entryLocalIndex + 1;
      const boardRows = boardSeries.get(position.industry) ?? []; const boardIndex = boardRows.findIndex(row => row.date === day.date); const boardRet5 = boardIndex >= 5 ? boardRows[boardIndex]!.close / boardRows[boardIndex - 5]!.close - 1 : null; const industryRet5 = boardRet5; const relativeRepaired = held >= 2 && point.ret5 !== null && industryRet5 !== null && point.ret5 - industryRet5 >= -0.01; const maRepaired = held >= 2 && point.ma20 !== null && point.bar.close >= point.ma20; const lowBroken = point.bar.close <= position.stopFloor; const timed = held >= 20;
      if (config.exit !== "A") { const shouldExit = config.exit === "固定20" ? timed : config.exit === "低点20" ? lowBroken || timed : config.exit === "MA20低点20" ? lowBroken || maRepaired || timed : config.exit === "相对低点20" ? lowBroken || relativeRepaired || timed : lowBroken || maRepaired || relativeRepaired || timed; if (shouldExit) { sell(position, position.quantity, point.bar.close, true, held); positions.delete(code); } continue; }
      if (!position.maDone && maRepaired) { const quantity = Math.floor(position.originalQuantity / 2 / 100) * 100; if (quantity >= 100 && quantity < position.quantity) sell(position, quantity, point.bar.close, false, held); position.maDone = true; position.stopFloor = Math.max(position.stopFloor, position.entryPrice); }
      if (relativeRepaired) position.stopFloor = Math.max(position.stopFloor, position.entryPrice);
      const gain = position.peak / position.entryPrice - 1; if (gain >= 0.10 && point.atr14 !== null) position.stopFloor = Math.max(position.stopFloor, position.peak - Math.max(position.peak * 0.08, point.atr14 * 3)); if (point.bar.close <= position.stopFloor) { sell(position, position.quantity, point.bar.close, true, held); positions.delete(code); }
    }
    const total = equity(); peakEquity = Math.max(peakEquity, total); maxDrawdown = Math.max(maxDrawdown, 1 - total / peakEquity); positionDays += positions.size; recent.push(total); if (recent.length > 20) recent.shift(); const recentPeak = Math.max(...recent); if (!paused && recent.length >= 5 && 1 - total / recentPeak > 0.05) paused = true; else if (paused && day.market_recovery === true) paused = false;
  }
  const finalEquity = cash + [...positions.values()].reduce((sum, position) => sum + position.quantity * position.lastClose, 0); return { configuration: config.name, slippage_bps: slippageBps, total_return: finalEquity / initial - 1, max_drawdown: maxDrawdown, closed_positions: closed, partial_sells: partials, win_rate: closed ? wins / closed : null, fees, average_holding_days: mean(holdings), average_positions: days.filter(day => day.date >= start && day.date <= end).length ? positionDays / days.filter(day => day.date >= start && day.date <= end).length : 0, paused_days: pausedDays, open_positions: positions.size };
}
async function run(window: WindowName, codes: string[], industries: Map<string, string>): Promise<void> {
  const range = WINDOWS[window]; const plan: StandardBacktestPlan = validateStandardPlan({ name: "左侧两年结构反转最终回测", hypothesis: "两年结构行业深回撤中的个股相对超跌，采用信号分档和MA20减半ATR退出", codes, start: range.start, end: range.end, rule: "left_reversal_daily_v1", environment_mode: "synthetic_881", environment_warmup_days: 260, price_mode: "forward_research", initial_cash: 1_000_000, max_positions: 5, daily_buy_limit: 3, position_fraction: 0.25, stop_loss_pct: 0.10, max_holding_days: 2520, drawdown_circuit: false, stop_streak_circuit: false, costs: { label: "正式研究费用：佣金万2.5最低5元、卖税10bp、滑点10/30bp", commission_bps: 2.5, minimum_commission: 5, sell_tax_bps: 10, slippage_bps: 10, volume_participation: 0.02 } }); const { report, chunks } = await inspectStandardInput(db, plan, true); if (!report.executable) throw new Error(report.manifest.gaps.filter(gap => gap.severity === "error").map(gap => gap.message).join("；")); const days = chunks.map(chunk => decodeStandardChunk({ payload: chunk.payload, encoding: "gzip-json-v1", raw_bytes: chunk.rawBytes, sha256: chunk.hash, trade_date: chunk.day })); const series = buildSeries(days, codes); const groups = new Map<string, string[]>(); for (const code of codes) { const industry = industries.get(code); if (industry) groups.set(industry, [...(groups.get(industry) ?? []), code]); } const industryIndices = buildIndustryIndices(days.length, groups, series); const boardSeries = await loadBoardSeries([...groups.keys()], range.start, range.end); const signals = generateSignals(codes, groups, industries, series, industryIndices, range.start, range.end); const configurations: Configuration[] = [
    { name: "A_MA20减半_ATR", exit: "A", allocation: "分档", dailyLimit: 3, industryLimit: 5, exposureCap: 0.85 },
    { name: "标准1_MA20全退_20日", exit: "MA20低点20", allocation: "等权20", dailyLimit: 2, industryLimit: 2, exposureCap: 1 },
  ]; const results = [10, 30].flatMap(slippage => configurations.map(config => simulate(days, series, boardSeries, signals, range.start, range.end, slippage, config))); fs.mkdirSync(outputDir, { recursive: true }); fs.writeFileSync(path.join(outputDir, `${window}.json`), JSON.stringify({ window, range, evidence: "research_only", input_hash: report.input_hash, codes_hash: contentHash(codes), strategy_hash: contentHash({ version: "left-reversal-v1", pool: "MA500且500日收益正，行业20日回撤10%-30%，个股5日<=-8%，相对行业<=-5%", configurations, slippage_bps: [10, 30] }), sample_size: codes.length, signal_count: signals.length, configurations, results }, null, 2)); console.log(`\n${window}：信号${signals.length}`); for (const result of results) console.log(`${result.configuration} ${result.slippage_bps}bp 收益${pct(result.total_return)} 回撤${pct(result.max_drawdown)} 闭环${result.closed_positions} 部分卖出${result.partial_sells}`); }
const codes = await selectCodes(); const industries = await loadIndustries(codes); for (const window of windows) await run(window, codes, industries); await closePool();
