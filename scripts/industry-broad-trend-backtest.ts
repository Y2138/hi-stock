// 原右侧六条件研究：支持共享池实验与逐板块独立适配性筛选。
// 只读 PostgreSQL；当前行业归属回看；结果为 research_only，不写业务台账。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import type pg from "pg";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";

const START = "2020-11-05";
const END = "2026-08-31";
const SEED_START = "2016-01-01";
const INITIAL_CASH_YUAN = 1_000_000;
const LOT = 100;
const COMMISSION_BPS = 2.5;
const MIN_COMMISSION_CENTS = 500;
const SELL_TAX_BPS = 10;
const VOLUME_PARTICIPATION = 0.02;
const MAX_POSITIONS = 5;
const DAILY_BUY_LIMIT = 5;
const POSITION_FRACTION = 0.2;
const OPEN_GAP_CAP = 0.05;
const DRAWDOWN_CIRCUIT = 0.05;
const INDUSTRY_RETURN20 = 0.08;
const INDUSTRY_BREADTH = 0.65;
const MIN_INDUSTRY_MEMBERS = 10;
const args = process.argv.slice(2);
const argOf = (flag: string): string | undefined => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const boardFilter = argOf("--boards")?.split(",").map(value => value.trim()).filter(Boolean) ?? null;
const codesFrom = argOf("--codes-from");
const codeFilter = codesFrom ? (JSON.parse(fs.readFileSync(codesFrom, "utf8")) as { codes?: string[] }).codes ?? null : null;
const boardSuitabilityMode = args.includes("--board-suitability");
const outDir = path.resolve("支撑/tmp/行业普涨右侧回测");
fs.mkdirSync(outDir, { recursive: true });

type ExitReason = "cooldown_stop" | "technical_stop" | "trailing_stop" | "weakness_exit" | "tier1_take_profit" | "tier2_take_profit";
const STOP_REASONS = new Set<ExitReason>(["cooldown_stop", "technical_stop", "trailing_stop"]);
interface SignalRow {
  date: string; code: string; board: string; signal_close: number; macd_hist: number; rank: number;
  industry_return20: number; breadth: number; valid_members: number;
  stock_return20: number; stock_return60: number; extension_ma20: number; turnover20: number;
  return20_percentile: number; return60_percentile: number; extension_percentile: number; turnover_percentile: number;
}
interface DayRow {
  code: string; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma10: number | null; macd_hist: number | null;
  previous_close: number | null; mean_volume20: number | null;
}
interface PendingBuy extends SignalRow { budgetCents: number }
interface PendingSell { reason: ExitReason; quantity: number | null }
interface Position {
  code: string; board: string; quantity: number; initialQuantity: number; entryPrice: number; entryDayIndex: number;
  signalDate: string; entryDate: string; initialCostCents: number; costCents: number; realizedCents: number; firstScaled: boolean; secondScaled: boolean;
  lastClose: number; lastMacdHist: number | null;
}
interface ScenarioConfig {
  name: string; start: string; end: string; industryGate: boolean; circuits: boolean; slippageBps: number;
  excludeSmall: boolean; industryReturn20: number; industryBreadth: number;
  maxPositions?: number; dailyBuyLimit?: number; positionFraction?: number;
  board?: string; variant?: "base" | "post" | "stress" | "ch3";
}
interface ScenarioResult {
  name: string; start: string; end: string; total_return: number; annual_return: number; max_drawdown: number;
  trade_count: number; win_rate: number | null; fees_yuan: number; exposure: number; paused_days: number;
  signal_count: number; active_signal_count: number; selected_orders: number; fills: number; gap_rejects: number;
  exits: Record<string, number>; per_year: Record<string, number>; industry_pnl_yuan: Record<string, number>;
  stock_stats: Record<string, { board: string; entries: number; trades: number; wins: number; pnl_yuan: number;
    avg_return20_percentile: number | null; avg_return60_percentile: number | null;
    avg_extension_percentile: number | null; avg_turnover_percentile: number | null }>;
  trade_log: Array<{ code: string; board: string; signal_date: string; entry_date: string; exit_date: string;
    reason: ExitReason; pnl_yuan: number; return_pct: number }>;
}

const SCENARIOS: ScenarioConfig[] = [
  { name: "新规则_全窗", start: START, end: END, industryGate: true, circuits: true, slippageBps: 10, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH },
  { name: "对照_无行业激活", start: START, end: END, industryGate: false, circuits: true, slippageBps: 10, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH },
  { name: "消融_无熔断", start: START, end: END, industryGate: true, circuits: false, slippageBps: 10, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH },
  { name: "压力_滑点30bp", start: START, end: END, industryGate: true, circuits: true, slippageBps: 30, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH },
  { name: "卫生_CH3", start: START, end: END, industryGate: true, circuits: true, slippageBps: 10, excludeSmall: true, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH },
  { name: "稳健_宽松阈值", start: START, end: END, industryGate: true, circuits: true, slippageBps: 10, excludeSmall: false, industryReturn20: 0.06, industryBreadth: 0.60 },
  { name: "稳健_严格阈值", start: START, end: END, industryGate: true, circuits: true, slippageBps: 10, excludeSmall: false, industryReturn20: 0.10, industryBreadth: 0.70 },
  { name: "新规则_前窗", start: START, end: "2022-12-30", industryGate: true, circuits: true, slippageBps: 10, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH },
  { name: "新规则_后窗", start: "2023-01-03", end: END, industryGate: true, circuits: true, slippageBps: 10, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH },
  { name: "对照_无行业激活_后窗", start: "2023-01-03", end: END, industryGate: false, circuits: true, slippageBps: 10, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH },
  { name: "仓位_三仓每日最强_20%", start: START, end: END, industryGate: false, circuits: true, slippageBps: 10, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH, maxPositions: 3, dailyBuyLimit: 1, positionFraction: 0.2 },
  { name: "仓位_三仓每日最强_等权", start: START, end: END, industryGate: false, circuits: true, slippageBps: 10, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH, maxPositions: 3, dailyBuyLimit: 1, positionFraction: 1 / 3 },
  { name: "仓位_三仓每日前三_20%", start: START, end: END, industryGate: false, circuits: true, slippageBps: 10, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH, maxPositions: 3, dailyBuyLimit: 3, positionFraction: 0.2 },
  { name: "仓位_三仓每日前三_等权", start: START, end: END, industryGate: false, circuits: true, slippageBps: 10, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH, maxPositions: 3, dailyBuyLimit: 3, positionFraction: 1 / 3 },
  { name: "仓位_三仓每日最强_等权_后窗", start: "2023-01-03", end: END, industryGate: false, circuits: true, slippageBps: 10, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH, maxPositions: 3, dailyBuyLimit: 1, positionFraction: 1 / 3 },
  { name: "仓位_三仓每日前三_等权_后窗", start: "2023-01-03", end: END, industryGate: false, circuits: true, slippageBps: 10, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH, maxPositions: 3, dailyBuyLimit: 3, positionFraction: 1 / 3 },
  { name: "仓位_三仓每日前三_等权_CH3", start: START, end: END, industryGate: false, circuits: true, slippageBps: 10, excludeSmall: true, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH, maxPositions: 3, dailyBuyLimit: 3, positionFraction: 1 / 3 },
  { name: "仓位_三仓每日前三_等权_30bp", start: START, end: END, industryGate: false, circuits: true, slippageBps: 30, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH, maxPositions: 3, dailyBuyLimit: 3, positionFraction: 1 / 3 },
];

function boardScenarios(boardCodes: string[]): ScenarioConfig[] {
  return boardCodes.flatMap(board => [
    { name: `${board}|基准`, board, variant: "base" as const, start: START, end: END, industryGate: false, circuits: true, slippageBps: 10, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH },
    { name: `${board}|后窗`, board, variant: "post" as const, start: "2023-01-03", end: END, industryGate: false, circuits: true, slippageBps: 10, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH },
    { name: `${board}|30bp`, board, variant: "stress" as const, start: START, end: END, industryGate: false, circuits: true, slippageBps: 30, excludeSmall: false, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH },
    { name: `${board}|CH3`, board, variant: "ch3" as const, start: START, end: END, industryGate: false, circuits: true, slippageBps: 10, excludeSmall: true, industryReturn20: INDUSTRY_RETURN20, industryBreadth: INDUSTRY_BREADTH },
  ]);
}

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
function charges(grossCents: number, side: "buy" | "sell"): number {
  const commission = Math.max(MIN_COMMISSION_CENTS, Math.round(grossCents * COMMISSION_BPS / 10_000));
  return commission + (side === "sell" ? Math.round(grossCents * SELL_TAX_BPS / 10_000) : 0);
}
function selfCheck(): void {
  assert.equal(charges(100_000, "buy"), 500);
  assert.equal(charges(10_000_000, "sell"), 12_500);
  assert.equal(Math.floor(19_999 / LOT) * LOT, 19_900);
}

async function loadSignals(pool: pg.Pool): Promise<SignalRow[]> {
  const cacheKey = createHash("sha256").update(JSON.stringify({ version: 4, start: START, end: END, boardFilter, codeFilter })).digest("hex").slice(0, 12);
  const cacheFile = path.join(outDir, `六条件信号缓存-${cacheKey}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as SignalRow[];
  console.time("全标的六条件与行业状态查询");
  const { rows } = await pool.query<SignalRow>(
    `WITH membership AS (
       SELECT mi.id AS stock_id, mi.code, bi.code AS board
       FROM market_board_membership m
       JOIN market_instrument bi ON bi.id=m.board_instrument_id
       JOIN market_instrument mi ON mi.id=m.member_instrument_id
       WHERE m.effective_to IS NULL AND bi.code LIKE '881%.TI' AND mi.kind='stock'
         AND ($4::text[] IS NULL OR bi.code=ANY($4::text[]))
         AND ($5::text[] IS NULL OR mi.code=ANY($5::text[]))
         AND mi.code ~ '^[0-9]{6}[.](SH|SZ)$'
     ), base AS (
       SELECT m.board, m.code, b.bar_date, b.open::float8, b.high::float8, b.low::float8, b.close::float8, b.volume::float8,
              v.ma5::float8, v.ma10::float8, v.ma20::float8, v.dif::float8, v.macd_hist::float8, v.status,
              lag(b.close, 1) OVER w::float8 AS previous_close,
              lag(b.close, 20) OVER w::float8 AS close20,
              lag(b.close, 60) OVER w::float8 AS close60,
              lag(v.ma20, 1) OVER w::float8 AS previous_ma20,
              lag(v.macd_hist, 1) OVER w::float8 AS previous_macd_hist,
              avg(b.volume) OVER (PARTITION BY m.stock_id ORDER BY b.bar_date ROWS BETWEEN 4 PRECEDING AND CURRENT ROW)::float8 AS vma5,
              avg(b.close*b.volume) OVER (PARTITION BY m.stock_id ORDER BY b.bar_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)::float8 AS turnover20
       FROM membership m
       JOIN market_bar b ON b.instrument_id=m.stock_id AND b.freq='day' AND b.bar_date BETWEEN $1 AND $3
       JOIN market_indicator_value v ON v.instrument_id=b.instrument_id AND v.freq=b.freq
         AND v.bar_date=b.bar_date AND v.bar_time=b.bar_time
       WINDOW w AS (PARTITION BY m.stock_id ORDER BY b.bar_date)
     ), features AS (
       SELECT *, close/NULLIF(close20,0)-1 AS stock_return20, close/NULLIF(close60,0)-1 AS stock_return60,
              close/NULLIF(ma20,0)-1 AS extension_ma20
       FROM base
     ), ranked AS (
       SELECT *,
              percent_rank() OVER (PARTITION BY board,bar_date ORDER BY stock_return20)::float8 AS return20_percentile,
              percent_rank() OVER (PARTITION BY board,bar_date ORDER BY stock_return60)::float8 AS return60_percentile,
              percent_rank() OVER (PARTITION BY board,bar_date ORDER BY extension_ma20)::float8 AS extension_percentile,
              percent_rank() OVER (PARTITION BY board,bar_date ORDER BY turnover20)::float8 AS turnover_percentile
       FROM features
     ), industry AS (
       SELECT board, bar_date,
              count(*) FILTER (WHERE close20>0 AND ma20 IS NOT NULL)::int AS valid_members,
              avg(close/NULLIF(close20,0)-1) FILTER (WHERE close20>0 AND ma20 IS NOT NULL)::float8 AS industry_return20,
              avg(CASE WHEN close>=ma20 THEN 1.0 ELSE 0.0 END) FILTER (WHERE close20>0 AND ma20 IS NOT NULL)::float8 AS breadth
       FROM features GROUP BY board, bar_date
     )
     SELECT b.bar_date::text AS date, b.code, b.board, b.close AS signal_close, b.macd_hist,
            (b.macd_hist-b.previous_macd_hist)/b.close AS rank,
            i.industry_return20, i.breadth, i.valid_members,
            b.stock_return20, b.stock_return60, b.extension_ma20, b.turnover20,
            b.return20_percentile, b.return60_percentile, b.extension_percentile, b.turnover_percentile
     FROM ranked b JOIN industry i USING(board,bar_date)
     WHERE b.bar_date BETWEEN $2 AND $3 AND b.status='ready'
       AND b.previous_close>0 AND b.previous_ma20 IS NOT NULL AND b.previous_macd_hist IS NOT NULL
       AND b.dif>0 AND b.ma20>b.previous_ma20
       AND b.macd_hist>0 AND (b.macd_hist-b.previous_macd_hist)/b.close>0.001
       AND b.close>b.ma5 AND b.ma5>b.ma10
       AND b.close/b.open-1>=0.01
       AND b.volume>b.vma5*(CASE WHEN b.close>=round((b.previous_close*1.1)::numeric,2)::float8 THEN 0.5 ELSE 1.2 END)
     ORDER BY b.bar_date, rank DESC, b.code`,
    [SEED_START, START, END, boardFilter, codeFilter],
  );
  console.timeEnd("全标的六条件与行业状态查询");
  const result = rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    ["date", "code", "board"].includes(key) ? value : Number(value)])) as unknown as SignalRow)
    .map(row => ({ ...row, rank: Math.min(row.rank, 0.003) }));
  fs.writeFileSync(cacheFile, JSON.stringify(result));
  return result;
}

async function loadLowTurnover(pool: pg.Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ code: string }>(
    `WITH px AS (
       SELECT i.code, percentile_cont(0.5) WITHIN GROUP (ORDER BY b.close*b.volume) AS turnover
       FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id
       WHERE i.kind='stock' AND b.freq='day' AND b.bar_date BETWEEN '2021-01-01' AND '2022-12-31'
         AND b.close>0 AND b.volume>0 GROUP BY i.code
     ), ranked AS (SELECT code, percent_rank() OVER (ORDER BY turnover) AS pct FROM px WHERE turnover IS NOT NULL)
     SELECT code FROM ranked WHERE pct<0.3`);
  return new Set(rows.map(row => row.code));
}

async function loadCalendar(pool: pg.Pool): Promise<{ dates: string[]; recovery: Map<string, boolean> }> {
  const { rows } = await pool.query<{ date: string; ret: number | null }>(
    `WITH board_ret AS (
       SELECT b.bar_date, b.close/NULLIF(lag(b.close) OVER (PARTITION BY b.instrument_id ORDER BY b.bar_date),0)-1 AS ret
       FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id
       WHERE i.kind='board' AND i.code LIKE '881%.SY' AND b.freq='day' AND b.bar_date BETWEEN '2015-01-01' AND $1
     )
     SELECT bar_date::text AS date, avg(ret)::float8 AS ret FROM board_ret
     WHERE ret IS NOT NULL GROUP BY bar_date HAVING count(*)>=60 ORDER BY bar_date`, [END]);
  const closes = new Map<string, number>();
  let level = 1000;
  for (const row of rows) { level *= 1 + Number(row.ret ?? 0); closes.set(row.date, level); }
  const dates = [...closes.keys()].filter(date => date >= START && date <= END);
  const allDates = [...closes.keys()];
  const recovery = new Map<string, boolean>();
  for (let index = 0; index < allDates.length; index += 1) {
    const current = closes.get(allDates[index]!)!;
    const prior20 = index >= 20 ? closes.get(allDates[index - 20]!) : null;
    recovery.set(allDates[index]!, prior20 != null && current >= prior20);
  }
  return { dates, recovery };
}

class DayLoader {
  private readonly cache = new Map<string, Map<string, DayRow | null>>();
  constructor(private readonly pool: pg.Pool) {}
  async load(date: string, codes: string[]): Promise<Map<string, DayRow | null>> {
    let day = this.cache.get(date);
    if (!day) { day = new Map(); this.cache.set(date, day); }
    const missing = [...new Set(codes)].filter(code => !day!.has(code));
    if (missing.length) {
      const { rows } = await this.pool.query<DayRow>(
        `SELECT i.code, b.open::float8, b.high::float8, b.low::float8, b.close::float8, b.volume::float8,
                v.ma5::float8, v.ma10::float8, v.macd_hist::float8,
                previous.close::float8 AS previous_close, volume20.mean_volume20::float8
         FROM market_instrument i
         JOIN market_bar b ON b.instrument_id=i.id AND b.freq='day' AND b.bar_date=$1
         LEFT JOIN market_indicator_value v ON v.instrument_id=b.instrument_id AND v.freq=b.freq
           AND v.bar_date=b.bar_date AND v.bar_time=b.bar_time
         LEFT JOIN LATERAL (
           SELECT pb.close FROM market_bar pb WHERE pb.instrument_id=i.id AND pb.freq='day' AND pb.bar_date<$1
           ORDER BY pb.bar_date DESC LIMIT 1
         ) previous ON true
         LEFT JOIN LATERAL (
           SELECT avg(x.volume) AS mean_volume20 FROM (
             SELECT pb.volume FROM market_bar pb WHERE pb.instrument_id=i.id AND pb.freq='day' AND pb.bar_date<$1
             ORDER BY pb.bar_date DESC LIMIT 20
           ) x
         ) volume20 ON true
         WHERE i.code=ANY($2::text[])`, [date, missing]);
      const found = new Set<string>();
      for (const row of rows) {
        found.add(row.code);
        day.set(row.code, { ...row, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close),
          volume: Number(row.volume), ma5: row.ma5 === null ? null : Number(row.ma5), ma10: row.ma10 === null ? null : Number(row.ma10),
          macd_hist: row.macd_hist === null ? null : Number(row.macd_hist), previous_close: row.previous_close === null ? null : Number(row.previous_close),
          mean_volume20: row.mean_volume20 === null ? null : Number(row.mean_volume20) });
      }
      for (const code of missing) if (!found.has(code)) day.set(code, null);
    }
    return day;
  }
}

class ScenarioState {
  private cash = INITIAL_CASH_YUAN * 100;
  private fees = 0;
  private positions = new Map<string, Position>();
  private buys: PendingBuy[] = [];
  private sells = new Map<string, PendingSell>();
  private recentEquities: number[] = [];
  private peak = this.cash;
  private maxDrawdown = 0;
  private previousEquity = this.cash;
  private stopStreak = 0;
  private pausedSince: number | null = null;
  private tradeCount = 0;
  private wins = 0;
  private exposureSum = 0;
  private tradingDays = 0;
  private pausedDays = 0;
  private signalCount = 0;
  private activeSignalCount = 0;
  private selectedOrders = 0;
  private fills = 0;
  private gapRejects = 0;
  private exits: Record<string, number> = {};
  private perYear: Record<string, number> = {};
  private industryPnl: Record<string, number> = {};
  private stockStats = new Map<string, { board: string; entries: number; trades: number; wins: number; pnlCents: number;
    return20PercentileSum: number; return60PercentileSum: number; extensionPercentileSum: number; turnoverPercentileSum: number }>();
  private tradeLog: ScenarioResult["trade_log"] = [];

  constructor(readonly config: ScenarioConfig, private readonly lowTurnover: Set<string>) {}
  private maxPositions(): number { return this.config.maxPositions ?? MAX_POSITIONS; }
  private dailyBuyLimit(): number { return this.config.dailyBuyLimit ?? DAILY_BUY_LIMIT; }
  private positionFraction(): number { return this.config.positionFraction ?? POSITION_FRACTION; }
  active(date: string): boolean { return date >= this.config.start && date <= this.config.end; }
  neededCodes(): string[] { return [...new Set([...this.positions.keys(), ...this.buys.map(order => order.code), ...this.sells.keys()])]; }

  private execution(row: DayRow, side: "buy" | "sell"): { price: number; capacity: number } | null {
    if (row.previous_close === null || row.mean_volume20 === null) return null;
    const upper = Math.round(row.previous_close * 1.1 * 100) / 100;
    const lower = Math.round(row.previous_close * 0.9 * 100) / 100;
    if (row.open < lower || row.open > upper || (side === "buy" && row.open >= upper) || (side === "sell" && row.open <= lower)) return null;
    const price = row.open * (1 + (side === "buy" ? 1 : -1) * this.config.slippageBps / 10_000);
    if (price <= 0 || price < lower || price > upper) return null;
    const capacity = Math.floor(row.mean_volume20 * VOLUME_PARTICIPATION / LOT) * LOT;
    return capacity >= LOT ? { price, capacity } : null;
  }

  processOpen(date: string, dayRows: Map<string, DayRow | null>, dayIndex: number): void {
    const sellOrders = [...this.sells.entries()].sort(([a, av], [b, bv]) =>
      Number(STOP_REASONS.has(bv.reason)) - Number(STOP_REASONS.has(av.reason)) || a.localeCompare(b));
    let newStopRisk = 0;
    for (const [code, intent] of sellOrders) {
      const row = dayRows.get(code); const position = this.positions.get(code);
      if (!row || !position) continue;
      const fill = this.execution(row, "sell");
      if (!fill) continue;
      const quantity = Math.min(intent.quantity ?? position.quantity, fill.capacity);
      if (quantity < LOT) continue;
      const gross = Math.round(fill.price * quantity * 100);
      const fee = charges(gross, "sell");
      const allocatedCost = Math.round(position.costCents * quantity / position.quantity);
      this.cash += gross - fee; this.fees += fee;
      position.costCents -= allocatedCost; position.quantity -= quantity;
      position.realizedCents += gross - fee - allocatedCost;
      if (intent.reason === "tier1_take_profit") position.firstScaled = true;
      if (intent.reason === "tier2_take_profit") position.secondScaled = true;
      this.sells.delete(code); this.fills += 1;
        if (position.quantity === 0) {
        this.positions.delete(code); this.tradeCount += 1;
        if (position.realizedCents > 0) this.wins += 1;
        this.exits[intent.reason] = (this.exits[intent.reason] ?? 0) + 1;
        this.industryPnl[position.board] = (this.industryPnl[position.board] ?? 0) + position.realizedCents;
        const stock = this.stockStats.get(code);
        if (stock) { stock.trades += 1; stock.wins += Number(position.realizedCents > 0); stock.pnlCents += position.realizedCents; }
        this.tradeLog.push({ code, board: position.board, signal_date: position.signalDate, entry_date: position.entryDate,
          exit_date: date, reason: intent.reason, pnl_yuan: round(position.realizedCents / 100, 2),
          return_pct: round(position.realizedCents / position.initialCostCents) });
        const stop = STOP_REASONS.has(intent.reason);
        this.stopStreak = stop ? this.stopStreak + 1 : 0;
        if (stop && this.stopStreak >= 3) newStopRisk = this.stopStreak;
      }
    }
    for (const order of this.buys) {
      if (this.pausedSince !== null || this.positions.has(order.code) || this.positions.size >= this.maxPositions()) continue;
      const row = dayRows.get(order.code);
      if (!row) continue;
      if (row.open > order.signal_close * (1 + OPEN_GAP_CAP)) { this.gapRejects += 1; continue; }
      const fill = this.execution(row, "buy");
      if (!fill) continue;
      const limit = Math.min(this.cash, order.budgetCents);
      let quantity = Math.min(Math.floor(order.budgetCents / (fill.price * 100) / LOT) * LOT, fill.capacity);
      while (quantity >= LOT) {
        const gross = Math.round(fill.price * quantity * 100); const fee = charges(gross, "buy");
        if (gross + fee <= limit) {
          this.cash -= gross + fee; this.fees += fee; this.fills += 1;
          this.positions.set(order.code, { code: order.code, board: order.board, quantity, initialQuantity: quantity,
            entryPrice: fill.price, entryDayIndex: dayIndex, signalDate: order.date, entryDate: date,
            initialCostCents: gross + fee, costCents: gross + fee, realizedCents: 0,
            firstScaled: false, secondScaled: false, lastClose: row.close, lastMacdHist: order.macd_hist });
          const stock = this.stockStats.get(order.code) ?? { board: order.board, entries: 0, trades: 0, wins: 0, pnlCents: 0,
            return20PercentileSum: 0, return60PercentileSum: 0, extensionPercentileSum: 0, turnoverPercentileSum: 0 };
          stock.entries += 1;
          stock.return20PercentileSum += order.return20_percentile;
          stock.return60PercentileSum += order.return60_percentile;
          stock.extensionPercentileSum += order.extension_percentile;
          stock.turnoverPercentileSum += order.turnover_percentile;
          this.stockStats.set(order.code, stock);
          break;
        }
        quantity -= LOT;
      }
    }
    this.buys = [];
    if (this.config.circuits && newStopRisk >= 3 && this.pausedSince === null) this.pausedSince = dayIndex;
  }

  processClose(date: string, dayIndex: number, dayRows: Map<string, DayRow | null>, signals: SignalRow[], marketRecovery: boolean): void {
    let marketValue = 0;
    for (const position of this.positions.values()) {
      const row = dayRows.get(position.code);
      if (row) position.lastClose = row.close;
      marketValue += Math.round(position.lastClose * position.quantity * 100);
      if (!row) continue;
      const gain = row.close / position.entryPrice - 1;
      const holdingDays = dayIndex - position.entryDayIndex + 1;
      let intent: PendingSell | null = null;
      if (holdingDays <= 3) intent = gain <= -0.12 ? { reason: "cooldown_stop", quantity: null } : null;
      else {
        let stopGain = -0.10; let trailing = false;
        for (const [threshold, protect] of [[0.5, 0.35], [0.3, 0.2], [0.15, 0.1], [0.08, 0.08]] as const) {
          if (gain >= threshold) { stopGain = Math.max(stopGain, protect); trailing = true; break; }
        }
        if (position.firstScaled && row.ma5 !== null) {
          const ma5Stop = row.ma5 * 0.99 / position.entryPrice - 1;
          if (ma5Stop > stopGain) { stopGain = ma5Stop; trailing = true; }
        }
        if (gain <= stopGain) intent = { reason: trailing ? "trailing_stop" : "technical_stop", quantity: null };
        else if (!position.firstScaled && gain >= 0.12) {
          const base = position.initialQuantity >= 1500 ? Math.floor(position.initialQuantity / 3) : Math.floor(position.initialQuantity / 2);
          intent = { reason: "tier1_take_profit", quantity: Math.min(Math.max(LOT, Math.floor(base / LOT) * LOT), position.quantity) };
        } else if (position.firstScaled && !position.secondScaled && gain >= 0.28) {
          const base = Math.floor(position.initialQuantity / 3);
          intent = { reason: "tier2_take_profit", quantity: Math.min(Math.max(LOT, Math.floor(base / LOT) * LOT), position.quantity) };
        } else if (position.lastMacdHist !== null && position.lastMacdHist > 0 && row.macd_hist !== null && row.macd_hist <= 0 && row.ma10 !== null && row.close < row.ma10) {
          intent = { reason: "weakness_exit", quantity: null };
        }
      }
      if (intent && (!this.sells.has(position.code) || STOP_REASONS.has(intent.reason) || !STOP_REASONS.has(this.sells.get(position.code)!.reason))) this.sells.set(position.code, intent);
      position.lastMacdHist = row.macd_hist;
    }
    const total = this.cash + marketValue;
    this.peak = Math.max(this.peak, total);
    this.maxDrawdown = Math.max(this.maxDrawdown, (this.peak - total) / this.peak);
    this.recentEquities.push(total); if (this.recentEquities.length > 20) this.recentEquities.shift();
    const recentPeak = Math.max(...this.recentEquities);
    const drawdownRisk = this.config.circuits && (recentPeak - total) / recentPeak > DRAWDOWN_CIRCUIT;
    if (drawdownRisk && this.pausedSince === null) this.pausedSince = dayIndex;
    else if (this.pausedSince !== null && dayIndex > this.pausedSince && marketRecovery) { this.pausedSince = null; this.stopStreak = 0; }

    this.signalCount += signals.length;
    const active = signals.filter(signal => (!this.config.board || signal.board === this.config.board) && (!this.config.industryGate || (
      signal.valid_members >= MIN_INDUSTRY_MEMBERS && signal.industry_return20 >= this.config.industryReturn20 && signal.breadth >= this.config.industryBreadth
    )) && (!this.config.excludeSmall || !this.lowTurnover.has(signal.code)));
    this.activeSignalCount += active.length;
    if (this.pausedSince === null) {
      const slots = this.maxPositions() - this.positions.size + this.sells.size;
      const candidates = active.sort((a, b) => b.rank - a.rank || a.code.localeCompare(b.code)).slice(0, 100)
        .filter(signal => !this.positions.has(signal.code) && !this.buys.some(order => order.code === signal.code));
      for (const signal of candidates.slice(0, Math.min(this.dailyBuyLimit(), slots))) {
        this.buys.push({ ...signal, budgetCents: Math.floor(total * this.positionFraction()) });
        this.selectedOrders += 1;
      }
    }
    this.tradingDays += 1;
    this.exposureSum += total > 0 ? marketValue / total : 0;
    if (this.pausedSince !== null) this.pausedDays += 1;
    const year = date.slice(0, 4);
    this.perYear[year] = (this.perYear[year] ?? 1) * (this.previousEquity > 0 ? total / this.previousEquity : 1);
    this.previousEquity = total;
  }

  finish(): ScenarioResult {
    const totalReturn = this.previousEquity / (INITIAL_CASH_YUAN * 100) - 1;
    for (const year of Object.keys(this.perYear)) this.perYear[year] = round(this.perYear[year]! - 1);
    return {
      name: this.config.name, start: this.config.start, end: this.config.end,
      total_return: round(totalReturn), annual_return: round(Math.pow(1 + totalReturn, 252 / Math.max(1, this.tradingDays)) - 1),
      max_drawdown: round(this.maxDrawdown), trade_count: this.tradeCount, win_rate: this.tradeCount ? round(this.wins / this.tradeCount) : null,
      fees_yuan: round(this.fees / 100, 2), exposure: round(this.exposureSum / Math.max(1, this.tradingDays)), paused_days: this.pausedDays,
      signal_count: this.signalCount, active_signal_count: this.activeSignalCount, selected_orders: this.selectedOrders,
      fills: this.fills, gap_rejects: this.gapRejects, exits: this.exits, per_year: this.perYear,
      industry_pnl_yuan: Object.fromEntries(Object.entries(this.industryPnl).map(([board, cents]) => [board, round(cents / 100, 2)])),
      stock_stats: Object.fromEntries([...this.stockStats.entries()].map(([code, stock]) => [code, {
        board: stock.board, entries: stock.entries, trades: stock.trades, wins: stock.wins, pnl_yuan: round(stock.pnlCents / 100, 2),
        avg_return20_percentile: stock.entries ? round(stock.return20PercentileSum / stock.entries) : null,
        avg_return60_percentile: stock.entries ? round(stock.return60PercentileSum / stock.entries) : null,
        avg_extension_percentile: stock.entries ? round(stock.extensionPercentileSum / stock.entries) : null,
        avg_turnover_percentile: stock.entries ? round(stock.turnoverPercentileSum / stock.entries) : null,
      }])), trade_log: this.tradeLog,
    };
  }
}

async function main(): Promise<void> {
  selfCheck();
  const pool = getPool(loadConfig().databaseUrl);
  const [signals, lowTurnover, calendar] = await Promise.all([loadSignals(pool), loadLowTurnover(pool), loadCalendar(pool)]);
  const signalsByDate = new Map<string, SignalRow[]>();
  for (const signal of signals) signalsByDate.set(signal.date, [...(signalsByDate.get(signal.date) ?? []), signal]);
  const inputHash = createHash("sha256").update(JSON.stringify(signals)).digest("hex");
  console.log(`全标的六条件信号 ${signals.length} 条，涉及 ${new Set(signals.map(signal => signal.code)).size} 只股票、${new Set(signals.map(signal => signal.board)).size} 个行业；输入哈希 ${inputHash.slice(0, 12)}。`);
  const scenarioConfigs = boardSuitabilityMode ? boardScenarios([...new Set(signals.map(signal => signal.board))].sort()) : SCENARIOS;
  const states = scenarioConfigs.map(config => new ScenarioState(config, lowTurnover));
  const loader = new DayLoader(pool);
  const signalsByDateBoard = new Map<string, SignalRow[]>();
  if (boardSuitabilityMode) for (const signal of signals) {
    const key = `${signal.date}|${signal.board}`;
    signalsByDateBoard.set(key, [...(signalsByDateBoard.get(key) ?? []), signal]);
  }
  for (let dayIndex = 0; dayIndex < calendar.dates.length; dayIndex += 1) {
    const date = calendar.dates[dayIndex]!;
    const activeStates = states.filter(state => state.active(date));
    const needed = [...new Set(activeStates.flatMap(state => state.neededCodes()))];
    const dayRows = needed.length ? await loader.load(date, needed) : new Map<string, DayRow | null>();
    for (const state of activeStates) {
      state.processOpen(date, dayRows, dayIndex);
      const daySignals = state.config.board
        ? signalsByDateBoard.get(`${date}|${state.config.board}`) ?? []
        : signalsByDate.get(date) ?? [];
      state.processClose(date, dayIndex, dayRows, daySignals, calendar.recovery.get(date) ?? false);
    }
    if ((dayIndex + 1) % 250 === 0) console.log(`已处理 ${date}（${dayIndex + 1}/${calendar.dates.length}）`);
  }
  const results = states.map(state => state.finish());
  if (boardSuitabilityMode) {
    const { rows: boardRows } = await pool.query<{ code: string; name: string }>(
      `SELECT code,name FROM market_instrument WHERE code=ANY($1::text[]) ORDER BY code`,
      [[...new Set(scenarioConfigs.map(config => config.board).filter((value): value is string => Boolean(value)))]],
    );
    const names = new Map(boardRows.map(row => [row.code, row.name]));
    const byBoard = new Map<string, Partial<Record<NonNullable<ScenarioConfig["variant"]>, ScenarioResult>>>();
    for (let index = 0; index < scenarioConfigs.length; index += 1) {
      const config = scenarioConfigs[index]!; const result = results[index]!;
      if (!config.board || !config.variant) continue;
      const variants = byBoard.get(config.board) ?? {}; variants[config.variant] = result; byBoard.set(config.board, variants);
    }
    const ranking = [...byBoard.entries()].map(([board, variants]) => {
      const base = variants.base!; const post = variants.post!; const stress = variants.stress!; const ch3 = variants.ch3!;
      const positiveCount = [base, post, stress, ch3].filter(result => result.total_return > 0).length;
      const verdict: "适配候选" | "观察" | "样本不足" | "不适配" = base.trade_count < 20 ? "样本不足" :
        positiveCount === 4 && base.max_drawdown <= 0.45 ? "适配候选" :
          base.total_return > 0 && positiveCount >= 3 ? "观察" : "不适配";
      return { board, name: names.get(board) ?? board, verdict, positive_count: positiveCount,
        base, post, stress, ch3 };
    }).sort((left, right) => {
      const order = { "适配候选": 3, "观察": 2, "样本不足": 1, "不适配": 0 } as const;
      return order[right.verdict] - order[left.verdict] || right.base.annual_return - left.base.annual_return || left.board.localeCompare(right.board);
    });
    console.log("\n板块\t裁定\t基准收益\t年化\t回撤\t交易\t后窗\t30bp\tCH3");
    for (const item of ranking) console.log(`${item.name}\t${item.verdict}\t${pct(item.base.total_return)}\t${pct(item.base.annual_return)}\t${pct(item.base.max_drawdown)}\t${item.base.trade_count}\t${pct(item.post.total_return)}\t${pct(item.stress.total_return)}\t${pct(item.ch3.total_return)}`);
    const outputFile = path.join(outDir, `板块右侧适配性-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.json`);
    fs.writeFileSync(outputFile, JSON.stringify({
      rule: "原六条件+盈利奔跑退出+组合熔断；单板块独立五仓等权，无行业资格门禁",
      evidence: "research_only", range: { start: START, end: END }, input_hash: inputHash,
      criteria: { candidate: "基准/后窗/30bp/CH3四口径均为正，基准交易不少于20笔且最大回撤不超过45%", observe: "基准为正且四口径至少三项为正" },
      assumptions: ["当前行业归属回看", "各板块独立组合，不存在跨板块资金竞争", "前复权研究价格", "没有真正未使用过的样本外数据"],
      ranking,
    }, null, 2));
    console.log(`结果已写入 ${outputFile}`);
    await closePool();
    return;
  }
  console.log("\n配置\t总收益\t年化\t回撤\t交易\t胜率\t暴露\t暂停日\t激活信号");
  for (const result of results) console.log(`${result.name}\t${pct(result.total_return)}\t${pct(result.annual_return)}\t${pct(result.max_drawdown)}\t${result.trade_count}\t${result.win_rate === null ? "-" : pct(result.win_rate)}\t${pct(result.exposure)}\t${result.paused_days}\t${result.active_signal_count}`);
  const outputFile = path.join(outDir, `行业普涨右侧系统回测-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.json`);
  fs.writeFileSync(outputFile, JSON.stringify({
    rule: { name: "行业普涨右侧确认规则v1", industry_return20: INDUSTRY_RETURN20, industry_breadth_above_ma20: INDUSTRY_BREADTH,
      min_industry_members: MIN_INDUSTRY_MEMBERS, stock_signal: "右侧六条件全过", open_gap_cap: OPEN_GAP_CAP,
      exit: "profit_trail生产近似", circuits: "20日回撤5%+连续止损3，881合成指数20日收益非负恢复" },
    evidence: "research_only", range: { start: START, end: END }, input_hash: inputHash,
    universe: { board_filter: boardFilter, codes_from: codesFrom ?? null, current_881_industries: new Set(signals.map(signal => signal.board)).size, signal_stocks: new Set(signals.map(signal => signal.code)).size, signal_count: signals.length },
    assumptions: ["当前881行业归属回看，无历史点时成员", "前复权研究价格", "T+1开盘成交", "100股整手", "前收±10%保守限制", "成交量参与上限2%", "完整费用与滑点显式计入", "没有未使用过的真正样本外数据"],
    scenarios: scenarioConfigs, results,
  }, null, 2));
  console.log(`结果已写入 ${outputFile}`);
  await closePool();
}

await main();
