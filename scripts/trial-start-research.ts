// 全市场试盘启动信号研究：复用生产纯函数，只读 PostgreSQL，不写业务台账。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import { evaluateTrialStartSignal, type TrialBar } from "./lib/backtest-short-rules.js";

const QUERY_START = "2016-11-01";
const START = "2017-01-03";
const END = "2026-08-31";
const BATCH_SIZE = 100;
const ENTRY_SLIPPAGE_BPS = 10;
const EXIT_SLIPPAGE_BPS = 10;
const COMMISSION_BPS = 2.5;
const SELL_TAX_BPS = 10;
const INITIAL_CASH = 1_000_000;
const LOT = 100;
const outDir = path.resolve("支撑/tmp/试盘启动回测");

type MarketState = "市场上行" | "市场震荡" | "市场下行" | "数据不足";
type Bar = TrialBar & { dateIndex: number };
type EventBar = { date: string; open: number; high: number; low: number; close: number };
type TrialEvent = {
  code: string; signalDate: string; signalDateIndex: number; score: number; signalClose: number;
  signalVolumeRatio: number; trialVolumeRatio: number | null; trialUpperShadowRatio: number | null;
  trialDate: string; trialHigh: number; trialLow: number; distance: number; limitUpRelief: boolean;
  trialRangePosition60: number | null; trialReturn20: number | null; trialReturn60: number | null;
  trialShadowAtr14: number | null; trialClosePosition: number | null;
  signalRangePosition60: number | null; signalReturn20: number | null; breakoutExtension: number;
  marketState: MarketState; currentShortPool: boolean; future: Map<string, EventBar>;
};
type Summary = {
  signals: number; executable: number; evaluated_5: number; evaluated_20: number;
  avg_return_5: number | null; median_return_5: number | null; win_rate_5: number | null;
  avg_return_10: number | null; win_rate_10: number | null;
  avg_return_20: number | null; win_rate_20: number | null; avg_mae_20: number | null;
  avg_mfe_20: number | null; hit_12pct_20: number | null; hit_minus_12pct_20: number | null;
};
type Scenario = {
  name: string; start: string; end: string; holdingDays: number; slippageBps: number;
  maxPositions: number; dailyBuyLimit: number; filter: (event: TrialEvent) => boolean;
  compare?: (left: TrialEvent, right: TrialEvent) => number;
};
type Position = { event: TrialEvent; quantity: number; entryPrice: number; entryCost: number; entryDateIndex: number; lastClose: number; exitSignalDateIndex: number | null };
type PortfolioResult = {
  name: string; total_return: number; annual_return: number; max_drawdown: number; trade_count: number;
  win_rate: number | null; signal_count: number; fill_count: number; exposure: number;
};
type PanelRow = {
  date: string; code: string; next_open: number | null; close5: number | null; close20: number | null;
  return20: number | null; volatility20: number | null;
};
type MatchedObservation = {
  date: string; code: string; group: "低位且未过热" | "高位且已过热" | "其他"; controls: number;
  target5: number; control5: number; excess5: number; target20: number; control20: number; excess20: number;
};
type MatchedSummary = {
  events: number; avg_controls: number | null; target_return_5: number | null; control_return_5: number | null;
  excess_return_5: number | null; median_excess_5: number | null; positive_excess_rate_5: number | null;
  target_return_20: number | null; control_return_20: number | null; excess_return_20: number | null;
  median_excess_20: number | null; positive_excess_rate_20: number | null;
};

const args = process.argv.slice(2);
const argOf = (flag: string): string | undefined => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const requestedStart = argOf("--start") ?? START;
const requestedEnd = argOf("--end") ?? END;

function mean(values: number[]): number | null { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function pct(value: number | null): string { return value === null ? "-" : `${(value * 100).toFixed(2)}%`; }
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
function trailingReturn(bars: Bar[], index: number, days: number): number | null {
  return index >= days && bars[index - days]!.close > 0 ? bars[index]!.close / bars[index - days]!.close - 1 : null;
}
function rangePosition(bars: Bar[], index: number, days: number): number | null {
  if (index + 1 < days) return null;
  const window = bars.slice(index - days + 1, index + 1);
  const low = Math.min(...window.map(bar => bar.low));
  const high = Math.max(...window.map(bar => bar.high));
  return high > low ? (bars[index]!.close - low) / (high - low) : null;
}
function atrAt(bars: Bar[], index: number, days = 14): number | null {
  if (index < days) return null;
  const ranges = bars.slice(index - days + 1, index + 1).map((bar, offset) => {
    const previousClose = bars[index - days + offset]!.close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  });
  return mean(ranges);
}
function netReturn(entryPrice: number, exitPrice: number, slippageBps = ENTRY_SLIPPAGE_BPS): number {
  const buy = entryPrice * (1 + slippageBps / 10_000) * (1 + COMMISSION_BPS / 10_000);
  const sell = exitPrice * (1 - EXIT_SLIPPAGE_BPS / 10_000) * (1 - (COMMISSION_BPS + SELL_TAX_BPS) / 10_000);
  return sell / buy - 1;
}
function executableEntry(event: TrialEvent, calendar: string[], slippageBps = ENTRY_SLIPPAGE_BPS): { date: string; price: number } | null {
  const nextDate = calendar[event.signalDateIndex + 1];
  if (!nextDate) return null;
  const bar = event.future.get(nextDate);
  if (!bar) return null;
  const requested = bar.open > event.trialHigh ? bar.open : bar.high > event.trialHigh ? event.trialHigh : null;
  if (requested === null || requested > event.signalClose * 1.05) return null;
  const fill = requested * (1 + slippageBps / 10_000);
  const limit = Math.round(event.signalClose * 1.1 * 100) / 100;
  return fill >= limit ? null : { date: nextDate, price: fill };
}
function horizonClose(event: TrialEvent, calendar: string[], entryDate: string, days: number): EventBar | null {
  const entryIndex = calendar.indexOf(entryDate);
  if (entryIndex < 0) return null;
  return event.future.get(calendar[entryIndex + days - 1] ?? "") ?? null;
}
function summarize(events: TrialEvent[], calendar: string[]): Summary {
  const rows = events.map(event => {
    const entry = executableEntry(event, calendar);
    if (!entry) return null;
    const bars20 = calendar.slice(calendar.indexOf(entry.date), calendar.indexOf(entry.date) + 20)
      .map(date => event.future.get(date)).filter((bar): bar is EventBar => bar !== undefined);
    const close5 = horizonClose(event, calendar, entry.date, 5);
    const close10 = horizonClose(event, calendar, entry.date, 10);
    const close20 = horizonClose(event, calendar, entry.date, 20);
    return {
      r5: close5 ? netReturn(entry.price / (1 + ENTRY_SLIPPAGE_BPS / 10_000), close5.close) : null,
      r10: close10 ? netReturn(entry.price / (1 + ENTRY_SLIPPAGE_BPS / 10_000), close10.close) : null,
      r20: close20 ? netReturn(entry.price / (1 + ENTRY_SLIPPAGE_BPS / 10_000), close20.close) : null,
      mae20: bars20.length ? Math.min(...bars20.map(bar => bar.low / entry.price - 1)) : null,
      mfe20: bars20.length ? Math.max(...bars20.map(bar => bar.high / entry.price - 1)) : null,
    };
  }).filter((row): row is NonNullable<typeof row> => row !== null);
  const r5 = rows.flatMap(row => row.r5 === null ? [] : [row.r5]);
  const r10 = rows.flatMap(row => row.r10 === null ? [] : [row.r10]);
  const r20 = rows.flatMap(row => row.r20 === null ? [] : [row.r20]);
  const mae = rows.flatMap(row => row.mae20 === null ? [] : [row.mae20]);
  const mfe = rows.flatMap(row => row.mfe20 === null ? [] : [row.mfe20]);
  return {
    signals: events.length, executable: rows.length, evaluated_5: r5.length, evaluated_20: r20.length,
    avg_return_5: mean(r5), median_return_5: median(r5), win_rate_5: r5.length ? r5.filter(value => value > 0).length / r5.length : null,
    avg_return_10: mean(r10), win_rate_10: r10.length ? r10.filter(value => value > 0).length / r10.length : null,
    avg_return_20: mean(r20), win_rate_20: r20.length ? r20.filter(value => value > 0).length / r20.length : null,
    avg_mae_20: mean(mae), avg_mfe_20: mean(mfe),
    hit_12pct_20: mfe.length ? mfe.filter(value => value >= 0.12).length / mfe.length : null,
    hit_minus_12pct_20: mae.length ? mae.filter(value => value <= -0.12).length / mae.length : null,
  };
}
function cluster(events: TrialEvent[], cooldownDays: number): TrialEvent[] {
  const last = new Map<string, number>();
  return events.filter(event => {
    const previous = last.get(event.code);
    if (previous !== undefined && event.signalDateIndex - previous <= cooldownDays) return false;
    last.set(event.code, event.signalDateIndex);
    return true;
  });
}
function moderateVolumeCompare(left: TrialEvent, right: TrialEvent): number {
  const leftDistance = Math.abs(left.signalVolumeRatio - 1.35) + Math.abs((left.trialVolumeRatio ?? 1.35) - 1.35) * 0.25;
  const rightDistance = Math.abs(right.signalVolumeRatio - 1.35) + Math.abs((right.trialVolumeRatio ?? 1.35) - 1.35) * 0.25;
  return leftDistance - rightDistance || left.breakoutExtension - right.breakoutExtension || left.code.localeCompare(right.code);
}
async function loadCalendar(pool: pg.Pool): Promise<string[]> {
  const result = await pool.query<{ date: string }>(
    `SELECT trade_date::text AS date FROM market_trading_day
      WHERE is_open = true AND trade_date BETWEEN $1::date AND $2::date ORDER BY trade_date`,
    [QUERY_START, requestedEnd],
  );
  return result.rows.map(row => row.date);
}
async function loadMarketStates(pool: pg.Pool): Promise<Map<string, MarketState>> {
  const result = await pool.query<{ date: string; code: string; close: number }>(
    `SELECT bar.bar_date::text AS date, instrument.code, bar.close::float8 AS close
       FROM market_bar bar
       JOIN market_instrument instrument ON instrument.id = bar.instrument_id
       JOIN market_board board ON board.instrument_id = instrument.id
      WHERE bar.freq = 'day' AND bar.adjustment = 'none' AND board.board_type = 'industry' AND board.active = true
        AND instrument.code LIKE '881%.TI' AND bar.bar_date BETWEEN $1::date AND $2::date
      ORDER BY bar.bar_date, instrument.code`,
    [QUERY_START, requestedEnd],
  );
  const closes = new Map<string, number>();
  const composite: { date: string; close: number }[] = [];
  let currentDate = ""; let dayReturn = 0; let count = 0; let level = 100;
  const flush = () => { if (!currentDate || count === 0) return; level *= 1 + dayReturn / count; composite.push({ date: currentDate, close: level }); };
  for (const row of result.rows) {
    if (row.date !== currentDate) { flush(); currentDate = row.date; dayReturn = 0; count = 0; }
    const previous = closes.get(row.code);
    if (previous !== undefined && previous > 0) { dayReturn += row.close / previous - 1; count += 1; }
    closes.set(row.code, row.close);
  }
  flush();
  const states = new Map<string, MarketState>();
  for (let index = 0; index < composite.length; index += 1) {
    if (index < 19) { states.set(composite[index]!.date, "数据不足"); continue; }
    const ma5 = mean(composite.slice(index - 4, index + 1).map(row => row.close))!;
    const ma20 = mean(composite.slice(index - 19, index + 1).map(row => row.close))!;
    const roc5 = index >= 5 ? composite[index]!.close / composite[index - 5]!.close - 1 : 0;
    states.set(composite[index]!.date, ma5 > ma20 && roc5 > 0 ? "市场上行" : ma5 < ma20 && roc5 < 0 ? "市场下行" : "市场震荡");
  }
  return states;
}
async function loadCodes(pool: pg.Pool): Promise<{ codes: string[]; shortPool: Set<string> }> {
  const [universe, poolRows] = await Promise.all([
    pool.query<{ code: string }>(
      `SELECT code FROM market_instrument
        WHERE kind = 'stock' AND lifecycle_status = 'active'
          AND code ~ '^(600|601|603|605|000|001|002|003)' ORDER BY code`,
    ),
    pool.query<{ code: string }>(
      `SELECT instrument.code FROM pool_membership membership
       JOIN market_instrument instrument ON instrument.id = membership.instrument_id
       WHERE membership.pool = 'short' AND membership.role = '短线' AND membership.effective_to IS NULL`,
    ),
  ]);
  return { codes: universe.rows.map(row => row.code), shortPool: new Set(poolRows.rows.map(row => row.code)) };
}
async function loadIndustries(pool: pg.Pool): Promise<Map<string, string>> {
  const result = await pool.query<{ code: string; industry: string }>(
    `SELECT member.code, board.code AS industry
       FROM market_board_membership membership
       JOIN market_instrument member ON member.id = membership.member_instrument_id
       JOIN market_instrument board ON board.id = membership.board_instrument_id
       JOIN market_board board_meta ON board_meta.instrument_id = board.id
      WHERE membership.effective_to IS NULL AND board_meta.board_type = 'industry' AND board.code LIKE '881%.TI'`,
  );
  return new Map(result.rows.map(row => [row.code, row.industry]));
}
async function loadEvents(pool: pg.Pool, codes: string[], shortPool: Set<string>, calendar: string[], marketStates: Map<string, MarketState>) {
  const dateIndex = new Map(calendar.map((date, index) => [date, index]));
  const events: TrialEvent[] = [];
  const inputHash = createHash("sha256");
  for (let offset = 0; offset < codes.length; offset += BATCH_SIZE) {
    const batch = codes.slice(offset, offset + BATCH_SIZE);
    const result = await pool.query<{ code: string; date: string; open: number; high: number; low: number; close: number; volume: number }>(
      `SELECT instrument.code, bar.bar_date::text AS date, bar.open::float8 AS open, bar.high::float8 AS high,
              bar.low::float8 AS low, bar.close::float8 AS close, bar.volume::float8 AS volume
         FROM market_bar bar JOIN market_instrument instrument ON instrument.id = bar.instrument_id
        WHERE instrument.code = ANY($1::text[]) AND bar.freq = 'day' AND bar.adjustment = 'forward'
          AND bar.bar_date BETWEEN $2::date AND $3::date
        ORDER BY instrument.code, bar.bar_date`,
      [batch, QUERY_START, requestedEnd],
    );
    const byCode = new Map<string, Bar[]>();
    for (const row of result.rows) {
      inputHash.update(`${row.code}|${row.date}|${row.open}|${row.high}|${row.low}|${row.close}|${row.volume}\n`);
      const index = dateIndex.get(row.date);
      if (index === undefined || row.volume <= 0 || row.low <= 0 || row.high < row.low) continue;
      const bar: Bar = { code: row.code, bar_date: row.date, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume, dateIndex: index };
      byCode.set(row.code, [...(byCode.get(row.code) ?? []), bar]);
    }
    for (const [code, bars] of byCode) {
      const byDate = new Map(bars.map(bar => [bar.bar_date, bar]));
      for (let index = 14; index < bars.length; index += 1) {
        const signal = bars[index]!;
        if (signal.bar_date < requestedStart || signal.bar_date > requestedEnd) continue;
        const evaluation = evaluateTrialStartSignal(bars.slice(index - 14, index + 1));
        if (!evaluation.price_signal || evaluation.evidence.trial_date === null || evaluation.evidence.trial_high === null ||
            evaluation.evidence.trial_low === null || evaluation.evidence.trading_day_distance === null) continue;
        const trialIndex = index - evaluation.evidence.trading_day_distance;
        const trial = bars[trialIndex]!;
        const trialAtr = atrAt(bars, trialIndex);
        const trialRange = trial.high - trial.low;
        const future = new Map<string, EventBar>();
        for (const date of calendar.slice(signal.dateIndex + 1, signal.dateIndex + 51)) {
          const bar = byDate.get(date);
          if (bar) future.set(date, { date, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
        }
        events.push({ code, signalDate: signal.bar_date, signalDateIndex: signal.dateIndex, score: evaluation.score,
          signalClose: signal.close, signalVolumeRatio: evaluation.evidence.signal_volume_ratio_5,
          trialVolumeRatio: evaluation.evidence.trial_volume_ratio_5, trialUpperShadowRatio: evaluation.evidence.trial_upper_shadow_ratio,
          trialDate: evaluation.evidence.trial_date, trialHigh: evaluation.evidence.trial_high, trialLow: evaluation.evidence.trial_low,
          distance: evaluation.evidence.trading_day_distance, limitUpRelief: evaluation.evidence.limit_up_volume_relief,
          trialRangePosition60: rangePosition(bars, trialIndex, 60), trialReturn20: trailingReturn(bars, trialIndex, 20),
          trialReturn60: trailingReturn(bars, trialIndex, 60),
          trialShadowAtr14: trialAtr && trialAtr > 0 ? (trial.high - Math.max(trial.open, trial.close)) / trialAtr : null,
          trialClosePosition: trialRange > 0 ? (trial.close - trial.low) / trialRange : null,
          signalRangePosition60: rangePosition(bars, index, 60), signalReturn20: trailingReturn(bars, index, 20),
          breakoutExtension: signal.close / evaluation.evidence.trial_high - 1,
          marketState: marketStates.get(signal.bar_date) ?? "数据不足", currentShortPool: shortPool.has(code), future });
      }
    }
    console.log(`已扫描 ${Math.min(offset + BATCH_SIZE, codes.length)}/${codes.length} 只股票，累计信号 ${events.length}。`);
  }
  return { events: events.sort((left, right) => left.signalDate.localeCompare(right.signalDate) || left.code.localeCompare(right.code)), inputHash: inputHash.digest("hex") };
}
function simulate(events: TrialEvent[], calendar: string[], scenario: Scenario): PortfolioResult {
  const selected = events.filter(event => event.signalDate >= scenario.start && event.signalDate <= scenario.end && scenario.filter(event));
  const byDate = new Map<string, TrialEvent[]>();
  for (const event of selected) byDate.set(event.signalDate, [...(byDate.get(event.signalDate) ?? []), event]);
  const positions = new Map<string, Position>();
  let pending: TrialEvent[] = [];
  let cash = INITIAL_CASH; let equity = INITIAL_CASH; let peak = equity; let maxDrawdown = 0;
  let trades = 0; let wins = 0; let fills = 0; let exposureDays = 0; let totalDays = 0;
  const startIndex = calendar.indexOf(scenario.start); const endIndex = calendar.indexOf(scenario.end);
  for (let dateIndex = startIndex; dateIndex <= endIndex; dateIndex += 1) {
    const date = calendar[dateIndex]!;
    for (const event of pending) {
      if (positions.has(event.code)) continue;
      const entry = executableEntry(event, calendar, scenario.slippageBps);
      if (!entry || entry.date !== date) continue;
      const budget = equity / scenario.maxPositions;
      const quantity = Math.floor(budget / entry.price / LOT) * LOT;
      if (quantity < LOT) continue;
      const entryIndex = calendar.indexOf(entry.date);
      const exitSignalDate = calendar[entryIndex + scenario.holdingDays - 1];
      const exitDate = calendar[entryIndex + scenario.holdingDays];
      if (!exitSignalDate || !exitDate || !event.future.has(exitSignalDate) || !event.future.has(exitDate)) continue;
      const gross = entry.price * quantity;
      const fee = Math.max(5, gross * COMMISSION_BPS / 10_000);
      if (gross + fee > cash) continue;
      cash -= gross + fee;
      positions.set(event.code, { event, quantity, entryPrice: entry.price, entryCost: gross + fee, entryDateIndex: dateIndex, lastClose: entry.price, exitSignalDateIndex: null });
      fills += 1;
    }
    pending = [];
    for (const [code, position] of [...positions]) {
      const bar = position.event.future.get(date);
      if (!bar) continue;
      if (position.exitSignalDateIndex !== null && dateIndex > position.exitSignalDateIndex) {
        const exitPrice = bar.open * (1 - scenario.slippageBps / 10_000);
        const gross = exitPrice * position.quantity;
        const fee = Math.max(5, gross * COMMISSION_BPS / 10_000) + gross * SELL_TAX_BPS / 10_000;
        const pnl = gross - fee - position.entryCost;
        cash += gross - fee; positions.delete(code); trades += 1; if (pnl > 0) wins += 1;
        continue;
      }
      position.lastClose = bar.close;
      const holdingDays = dateIndex - position.entryDateIndex + 1;
      if (holdingDays >= scenario.holdingDays) position.exitSignalDateIndex = dateIndex;
    }
    const candidates = (byDate.get(date) ?? []).filter(event => !positions.has(event.code))
      .sort(scenario.compare ?? ((left, right) => right.score - left.score || left.code.localeCompare(right.code)));
    pending = candidates.slice(0, Math.max(0, Math.min(scenario.dailyBuyLimit, scenario.maxPositions - positions.size)));
    let marketValue = 0;
    for (const position of positions.values()) marketValue += position.lastClose * position.quantity;
    equity = cash + marketValue; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak === 0 ? 0 : (peak - equity) / peak);
    totalDays += 1; if (positions.size > 0) exposureDays += 1;
  }
  const years = Math.max(1 / 252, (endIndex - startIndex + 1) / 252);
  return { name: scenario.name, total_return: equity / INITIAL_CASH - 1, annual_return: Math.pow(equity / INITIAL_CASH, 1 / years) - 1,
    max_drawdown: maxDrawdown, trade_count: trades, win_rate: trades ? wins / trades : null,
    signal_count: selected.length, fill_count: fills, exposure: totalDays ? exposureDays / totalDays : 0 };
}
function summarizeMatched(rows: MatchedObservation[]): MatchedSummary {
  const values = (key: keyof MatchedObservation): number[] => rows.map(row => row[key]).filter((value): value is number => typeof value === "number");
  const excess5 = values("excess5"); const excess20 = values("excess20");
  return {
    events: rows.length, avg_controls: mean(values("controls")),
    target_return_5: mean(values("target5")), control_return_5: mean(values("control5")),
    excess_return_5: mean(excess5), median_excess_5: median(excess5),
    positive_excess_rate_5: excess5.length ? excess5.filter(value => value > 0).length / excess5.length : null,
    target_return_20: mean(values("target20")), control_return_20: mean(values("control20")),
    excess_return_20: mean(excess20), median_excess_20: median(excess20),
    positive_excess_rate_20: excess20.length ? excess20.filter(value => value > 0).length / excess20.length : null,
  };
}
async function matchedExcessStudy(pool: pg.Pool, events: TrialEvent[], calendar: string[], industries: Map<string, string>): Promise<MatchedObservation[]> {
  const signalCodesByDate = new Map<string, Set<string>>();
  for (const event of events) signalCodesByDate.set(event.signalDate, new Set([...(signalCodesByDate.get(event.signalDate) ?? []), event.code]));
  const eventByDate = new Map<string, TrialEvent[]>();
  for (const event of events) eventByDate.set(event.signalDate, [...(eventByDate.get(event.signalDate) ?? []), event]);
  const observations: MatchedObservation[] = [];
  const first = calendar.indexOf(requestedStart); const last = calendar.indexOf(requestedEnd);
  const chunkSize = 120;
  for (let chunkStart = first; chunkStart <= last; chunkStart += chunkSize) {
    const chunkEnd = Math.min(last, chunkStart + chunkSize - 1);
    const queryStart = calendar[Math.max(0, chunkStart - 80)]!;
    const queryEnd = calendar[Math.min(calendar.length - 1, chunkEnd + 25)]!;
    const coreStart = calendar[chunkStart]!; const coreEnd = calendar[chunkEnd]!;
    const result = await pool.query<PanelRow>(
      `WITH priced AS (
         SELECT instrument.code, bar.bar_date, bar.open::float8 AS open, bar.close::float8 AS close,
                lag(bar.close::float8) OVER code_day AS previous_close,
                lag(bar.close::float8, 20) OVER code_day AS close20_ago,
                lead(bar.open::float8, 1) OVER code_day AS next_open,
                lead(bar.close::float8, 5) OVER code_day AS close5,
                lead(bar.close::float8, 20) OVER code_day AS close20
           FROM market_bar bar JOIN market_instrument instrument ON instrument.id = bar.instrument_id
          WHERE bar.freq = 'day' AND bar.adjustment = 'forward' AND instrument.kind = 'stock'
            AND instrument.lifecycle_status = 'active' AND instrument.code ~ '^(600|601|603|605|000|001|002|003)'
            AND bar.bar_date BETWEEN $1::date AND $2::date
          WINDOW code_day AS (PARTITION BY instrument.code ORDER BY bar.bar_date)
       ), featured AS (
         SELECT *, CASE WHEN previous_close > 0 THEN close / previous_close - 1 END AS daily_return,
                CASE WHEN close20_ago > 0 THEN close / close20_ago - 1 END AS return20
           FROM priced
       ), panel AS (
         SELECT *, stddev_samp(daily_return) OVER (PARTITION BY code ORDER BY bar_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS volatility20
           FROM featured
       )
       SELECT bar_date::text AS date, code, next_open, close5, close20, return20, volatility20
         FROM panel WHERE bar_date BETWEEN $3::date AND $4::date ORDER BY bar_date, code`,
      [queryStart, queryEnd, coreStart, coreEnd],
    );
    const rowsByDateIndustry = new Map<string, PanelRow[]>();
    const rowsByDateCode = new Map<string, PanelRow>();
    for (const row of result.rows) {
      rowsByDateCode.set(`${row.date}|${row.code}`, row);
      const industry = industries.get(row.code);
      if (industry) rowsByDateIndustry.set(`${row.date}|${industry}`, [...(rowsByDateIndustry.get(`${row.date}|${industry}`) ?? []), row]);
    }
    for (let index = chunkStart; index <= chunkEnd; index += 1) {
      const date = calendar[index]!;
      for (const event of eventByDate.get(date) ?? []) {
        const target = rowsByDateCode.get(`${date}|${event.code}`); const industry = industries.get(event.code);
        if (!target || !industry || target.next_open === null || target.close5 === null || target.close20 === null ||
            target.return20 === null || target.volatility20 === null || target.volatility20 <= 0) continue;
        const excluded = signalCodesByDate.get(date) ?? new Set<string>();
        const peers = (rowsByDateIndustry.get(`${date}|${industry}`) ?? []).filter(row => row.code !== event.code && !excluded.has(row.code) &&
          row.next_open !== null && row.close5 !== null && row.close20 !== null && row.return20 !== null && row.volatility20 !== null && row.volatility20 > 0);
        const ranked = peers.map(row => ({ row, distance: Math.abs(row.return20! - target.return20!) / 0.05 +
          Math.abs(Math.log(row.volatility20! / target.volatility20!)) / Math.log(1.25) }))
          .sort((left, right) => left.distance - right.distance || left.row.code.localeCompare(right.row.code));
        const strict = ranked.filter(item => Math.abs(item.row.return20! - target.return20!) <= 0.05 &&
          item.row.volatility20! / target.volatility20! >= 0.8 && item.row.volatility20! / target.volatility20! <= 1.25);
        const controls = (strict.length >= 5 ? strict : ranked).slice(0, 10).map(item => item.row);
        if (controls.length < 3) continue;
        const target5 = netReturn(target.next_open, target.close5); const target20 = netReturn(target.next_open, target.close20);
        const control5 = mean(controls.map(row => netReturn(row.next_open!, row.close5!)))!;
        const control20 = mean(controls.map(row => netReturn(row.next_open!, row.close20!)))!;
        const group = event.trialRangePosition60 !== null && event.trialRangePosition60 <= 0.35 && event.trialReturn20 !== null && event.trialReturn20 <= 0.10
          ? "低位且未过热" : event.trialRangePosition60 !== null && event.trialRangePosition60 >= 0.70 && event.trialReturn20 !== null && event.trialReturn20 > 0.10
            ? "高位且已过热" : "其他";
        observations.push({ date, code: event.code, group, controls: controls.length, target5, control5, excess5: target5 - control5,
          target20, control20, excess20: target20 - control20 });
      }
    }
    console.log(`已完成匹配对照 ${coreStart} 至 ${coreEnd}，累计 ${observations.length} 条。`);
  }
  return observations;
}

async function main(): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  const pool = getPool(loadConfig().databaseUrl);
  const [calendar, marketStates, universe, industries] = await Promise.all([loadCalendar(pool), loadMarketStates(pool), loadCodes(pool), loadIndustries(pool)]);
  if (!calendar.includes(requestedStart) || !calendar.includes(requestedEnd)) throw new Error("起止日期必须是已入库交易日");
  console.log(`研究区间 ${requestedStart} 至 ${requestedEnd}；主板存续股票 ${universe.codes.length} 只；当前短线池 ${universe.shortPool.size} 只。`);
  const loaded = await loadEvents(pool, universe.codes, universe.shortPool, calendar, marketStates);
  const clustered = cluster(loaded.events, 5);
  const matchedObservations = await matchedExcessStudy(pool, clustered, calendar, industries);
  const windows = {
    前窗2017_2021: { start: "2017-01-03", end: "2021-12-31" },
    后窗2022_2026: { start: "2022-01-04", end: requestedEnd },
    全期: { start: requestedStart, end: requestedEnd },
  };
  const filters: Record<string, (event: TrialEvent) => boolean> = {
    原规则: () => true,
    非涨停信号: event => !event.limitUpRelief,
    涨停信号全部: event => event.limitUpRelief,
    不依赖涨停放宽: event => !event.limitUpRelief || event.signalVolumeRatio > 1.2,
    依赖涨停放宽: event => event.limitUpRelief && event.signalVolumeRatio <= 1.2,
    信号量比1_2至1_5: event => event.signalVolumeRatio > 1.2 && event.signalVolumeRatio < 1.5,
    信号量比1_5至2: event => event.signalVolumeRatio >= 1.5 && event.signalVolumeRatio < 2,
    信号量比至少2: event => event.signalVolumeRatio >= 2,
    双量比至少1_5: event => event.signalVolumeRatio >= 1.5 && (event.trialVolumeRatio ?? 0) >= 1.5,
    上影至少3pct: event => (event.trialUpperShadowRatio ?? 0) >= 0.03,
    间隔2至5日: event => event.distance <= 5,
    当前短线池: event => event.currentShortPool,
  };
  const summaries: Record<string, Record<string, Summary>> = {};
  const locationFilters: Record<string, (event: TrialEvent) => boolean> = {
    试盘低位0至30pct: event => event.trialRangePosition60 !== null && event.trialRangePosition60 <= 0.30,
    试盘中位30至70pct: event => event.trialRangePosition60 !== null && event.trialRangePosition60 > 0.30 && event.trialRangePosition60 < 0.70,
    试盘高位70至100pct: event => event.trialRangePosition60 !== null && event.trialRangePosition60 >= 0.70,
    试盘前20日下跌: event => event.trialReturn20 !== null && event.trialReturn20 <= 0,
    试盘前20日上涨0至10pct: event => event.trialReturn20 !== null && event.trialReturn20 > 0 && event.trialReturn20 <= 0.10,
    试盘前20日上涨超过10pct: event => event.trialReturn20 !== null && event.trialReturn20 > 0.10,
    低位且未过热: event => event.trialRangePosition60 !== null && event.trialRangePosition60 <= 0.35 && event.trialReturn20 !== null && event.trialReturn20 <= 0.10,
    高位且已过热: event => event.trialRangePosition60 !== null && event.trialRangePosition60 >= 0.70 && event.trialReturn20 !== null && event.trialReturn20 > 0.10,
    信号突破后仍低于60日区间90pct: event => event.signalRangePosition60 !== null && event.signalRangePosition60 < 0.90,
    信号突破后位于60日区间顶部10pct: event => event.signalRangePosition60 !== null && event.signalRangePosition60 >= 0.90,
  };
  const locationSummaries: Record<string, Record<string, Summary>> = {};
  const matchedSummaries: Record<string, Record<string, MatchedSummary>> = {};
  for (const [windowName, window] of Object.entries(windows)) {
    summaries[windowName] = {};
    locationSummaries[windowName] = {};
    const windowMatched = matchedObservations.filter(row => row.date >= window.start && row.date <= window.end);
    matchedSummaries[windowName] = {
      原规则: summarizeMatched(windowMatched),
      低位且未过热: summarizeMatched(windowMatched.filter(row => row.group === "低位且未过热")),
      高位且已过热: summarizeMatched(windowMatched.filter(row => row.group === "高位且已过热")),
    };
    for (const [filterName, filter] of Object.entries(filters)) {
      summaries[windowName]![filterName] = summarize(clustered.filter(event => event.signalDate >= window.start && event.signalDate <= window.end && filter(event)), calendar);
    }
    for (const state of ["市场上行", "市场震荡", "市场下行"] as const) {
      summaries[windowName]![state] = summarize(clustered.filter(event => event.signalDate >= window.start && event.signalDate <= window.end && event.marketState === state), calendar);
    }
    for (const [name, filter] of Object.entries(locationFilters)) {
      locationSummaries[windowName]![name] = summarize(clustered.filter(event => event.signalDate >= window.start && event.signalDate <= window.end && filter(event)), calendar);
    }
  }
  const baseScenarios: Omit<Scenario, "start" | "end">[] = [
    { name: "原规则5日", holdingDays: 5, slippageBps: 10, maxPositions: 5, dailyBuyLimit: 3, filter: () => true },
    { name: "原规则10日", holdingDays: 10, slippageBps: 10, maxPositions: 5, dailyBuyLimit: 3, filter: () => true },
    { name: "原规则20日", holdingDays: 20, slippageBps: 10, maxPositions: 5, dailyBuyLimit: 3, filter: () => true },
    { name: "取消涨停放宽5日", holdingDays: 5, slippageBps: 10, maxPositions: 5, dailyBuyLimit: 3, filter: filters.不依赖涨停放宽! },
    { name: "严格双量比5日", holdingDays: 5, slippageBps: 10, maxPositions: 5, dailyBuyLimit: 3, filter: filters.双量比至少1_5! },
    { name: "原规则5日_30bp滑点", holdingDays: 5, slippageBps: 30, maxPositions: 5, dailyBuyLimit: 3, filter: () => true },
    { name: "当前短线池5日", holdingDays: 5, slippageBps: 10, maxPositions: 5, dailyBuyLimit: 3, filter: filters.当前短线池! },
    { name: "低位未过热5日", holdingDays: 5, slippageBps: 10, maxPositions: 5, dailyBuyLimit: 3, filter: locationFilters.低位且未过热! },
    { name: "低位未过热10日", holdingDays: 10, slippageBps: 10, maxPositions: 5, dailyBuyLimit: 3, filter: locationFilters.低位且未过热! },
    { name: "低位未过热20日", holdingDays: 20, slippageBps: 10, maxPositions: 5, dailyBuyLimit: 3, filter: locationFilters.低位且未过热! },
    { name: "低位未过热且取消涨停放宽5日", holdingDays: 5, slippageBps: 10, maxPositions: 5, dailyBuyLimit: 3,
      filter: event => locationFilters.低位且未过热!(event) && filters.不依赖涨停放宽!(event) },
    { name: "低位未过热温和量优先5日", holdingDays: 5, slippageBps: 10, maxPositions: 5, dailyBuyLimit: 3,
      filter: event => locationFilters.低位且未过热!(event) && filters.不依赖涨停放宽!(event), compare: moderateVolumeCompare },
    { name: "低位未过热温和量优先10日", holdingDays: 10, slippageBps: 10, maxPositions: 5, dailyBuyLimit: 3,
      filter: event => locationFilters.低位且未过热!(event) && filters.不依赖涨停放宽!(event), compare: moderateVolumeCompare },
    { name: "低位未过热温和量优先20日", holdingDays: 20, slippageBps: 10, maxPositions: 5, dailyBuyLimit: 3,
      filter: event => locationFilters.低位且未过热!(event) && filters.不依赖涨停放宽!(event), compare: moderateVolumeCompare },
    { name: "高位已过热5日", holdingDays: 5, slippageBps: 10, maxPositions: 5, dailyBuyLimit: 3, filter: locationFilters.高位且已过热! },
  ];
  const portfolios = Object.entries(windows).flatMap(([windowName, window]) => baseScenarios.map(scenario => simulate(loaded.events, calendar, { ...scenario, name: `${windowName}_${scenario.name}`, ...window })));
  console.log("\n窗口/过滤\t信号\t成交\t5日有效\t20日有效\t5日均值\t5日中位\t5日胜率\t20日均值\t20日胜率\t20日+12%\t20日-12%");
  for (const [windowName, rows] of Object.entries(summaries)) for (const [name, summary] of Object.entries(rows)) {
    console.log(`${windowName}/${name}\t${summary.signals}\t${summary.executable}\t${summary.evaluated_5}\t${summary.evaluated_20}\t${pct(summary.avg_return_5)}\t${pct(summary.median_return_5)}\t${pct(summary.win_rate_5)}\t${pct(summary.avg_return_20)}\t${pct(summary.win_rate_20)}\t${pct(summary.hit_12pct_20)}\t${pct(summary.hit_minus_12pct_20)}`);
  }
  console.log("\n位置假设\t信号\t5日均值\t5日中位\t5日胜率\t20日均值\t20日胜率");
  for (const [windowName, rows] of Object.entries(locationSummaries)) for (const [name, summary] of Object.entries(rows)) {
    console.log(`${windowName}/${name}\t${summary.signals}\t${pct(summary.avg_return_5)}\t${pct(summary.median_return_5)}\t${pct(summary.win_rate_5)}\t${pct(summary.avg_return_20)}\t${pct(summary.win_rate_20)}`);
  }
  console.log("\n匹配对照\t事件\t平均对照数\t目标5日\t对照5日\t超额5日\t超额5日胜率\t目标20日\t对照20日\t超额20日\t超额20日胜率");
  for (const [windowName, rows] of Object.entries(matchedSummaries)) for (const [name, summary] of Object.entries(rows)) {
    console.log(`${windowName}/${name}\t${summary.events}\t${summary.avg_controls?.toFixed(1) ?? "-"}\t${pct(summary.target_return_5)}\t${pct(summary.control_return_5)}\t${pct(summary.excess_return_5)}\t${pct(summary.positive_excess_rate_5)}\t${pct(summary.target_return_20)}\t${pct(summary.control_return_20)}\t${pct(summary.excess_return_20)}\t${pct(summary.positive_excess_rate_20)}`);
  }
  console.log("\n组合\t总收益\t年化\t最大回撤\t交易\t胜率\t暴露");
  for (const result of portfolios) console.log(`${result.name}\t${pct(result.total_return)}\t${pct(result.annual_return)}\t${pct(result.max_drawdown)}\t${result.trade_count}\t${pct(result.win_rate)}\t${pct(result.exposure)}`);
  const output = path.join(outDir, `试盘启动-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.json`);
  fs.writeFileSync(output, JSON.stringify({ strategy: "试盘启动生产规则广域研究", evidence: "research_only", date: "2026-09-15",
    range: { start: requestedStart, end: requestedEnd, query_start: QUERY_START }, universe: { active_main_board_codes: universe.codes.length, current_short_pool_codes: universe.shortPool.size },
    input_hash: loaded.inputHash, methodology: { signal: "复用evaluateTrialStartSignal生产纯函数；同股信号按5个交易日聚类",
      entry: "T+1开盘或盘中首次突破试盘高点，成交请求不高于信号收盘5%，买入滑点10bp；涨停不可成交",
      event_return: "固定5/10/20交易日收盘，含双边佣金2.5bp、卖出税10bp和双边滑点10bp；不含最低佣金",
      location_hypothesis: "试盘日收盘在截至当日近60日最高价与最低价区间中的位置；未过热指试盘日前20日收益不高于10%",
      ranking_hypothesis: "温和量优先按突破日量比接近1.35排序，试盘日量比只占四分之一权重，并以突破伸长度作为次序",
      matched_control: "同交易日、当前一级行业相同、前20日收益差优先不超过5个百分点、20日波动率比优先在0.8至1.25；每个信号取最多10个非信号对照并统一按T+1开盘计算收益",
      portfolio: "100万元、5仓、每日最多3笔、等权；固定持有5/10/20日后次日开盘退出；用于隔离信号，不等同完整生产退出" },
    caveats: ["全市场扩展违反正式策略只扫描当前短线池的边界，仅用于检验形态泛化能力", "股票宇宙使用当前存续主板清单，存在幸存者偏差且缺少历史ST状态", "前复权价格含未来公司行动影响，只具研究资格", "组合退出使用固定持有期，不复刻右侧完整分批止盈、技术止损和六条件复核", "当前短线池分组使用当前成员回看，存在选择偏差", "行业归属使用2026年8月后同步的当前一级行业回看", "温和量排序使用同一历史样本提出并验证，不是真正样本外", "没有真正未使用样本外"],
    raw_signals: loaded.events.length, clustered_signals: clustered.length, summaries, location_hypothesis: locationSummaries,
    matched_excess: matchedSummaries, portfolios }, null, 2));
  console.log(`\n输入哈希 ${loaded.inputHash.slice(0, 12)}；结果 ${output}`);
  await closePool();
}
await main();
