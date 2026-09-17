// 独立研究：行业相对强度首突破。与既有六条件/行业普涨脚本隔离，只读 PostgreSQL，不写业务台账。
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
const QUERY_START = "2020-01-01";
const INITIAL_CASH_CENTS = 100_000_000;
const LOT = 100;
const COMMISSION_BPS = 2.5;
const MIN_COMMISSION_CENTS = 500;
const SELL_TAX_BPS = 10;
const VOLUME_PARTICIPATION = 0.02;
const DEFAULT_BOARDS = ["881105.TI", "881107.TI", "881108.TI", "881112.TI", "881115.TI", "881137.TI",
  "881148.TI", "881168.TI", "881169.TI", "881170.TI", "881180.TI", "881264.TI", "881267.TI"];
const args = process.argv.slice(2);
const argOf = (flag: string): string | undefined => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const boards = argOf("--boards")?.split(",").map(value => value.trim()).filter(Boolean) ?? DEFAULT_BOARDS;
const outDir = path.resolve("支撑/tmp/行业相对强度首突破研究");
fs.mkdirSync(outDir, { recursive: true });

type ExitReason = "initial_stop" | "volatility_trail" | "ma10_two_days" | "time_stop" | "max_holding";
const STOP_REASONS = new Set<ExitReason>(["initial_stop", "volatility_trail"]);
interface Candidate {
  date: string; code: string; board: string; signal_close: number; breakout_close: number; sigma20: number;
  industry_return20: number; industry_return60: number; breadth: number; breadth5: number | null;
  industry_rank60: number; stock_rank20: number; stock_rank60: number; extension: number;
  next_open: number | null; future_close20: number | null;
}
interface DayRow { code: string; open: number; close: number; volume: number; ma10: number | null; previous_close: number | null; mean_volume20: number | null }
interface PendingBuy extends Candidate { budgetRiskPct: number; maxPositionPct: number }
interface PendingSell { reason: ExitReason }
interface Position {
  code: string; board: string; quantity: number; entryPrice: number; costCents: number; realizedCents: number;
  entryDayIndex: number; initialStop: number; initialRisk: number; sigma20: number; highestClose: number;
  belowMa10Days: number; lastClose: number;
}
interface Scenario {
  name: string; start: string; end: string; industryTrend: boolean; stockRelativeStrength: boolean;
  maxPositions: number; dailyBuyLimit: number; onePerIndustry: boolean; slippageBps: number; excludeSmall: boolean;
  riskPct: number; maxPositionPct: number; cooldownDays?: number;
}
interface Result {
  name: string; total_return: number; annual_return: number; max_drawdown: number; trade_count: number;
  win_rate: number | null; exposure: number; fees_yuan: number; paused_days: number; candidate_count: number;
  eligible_count: number; selected_count: number; fills: number; exits: Record<string, number>;
  per_year: Record<string, number>; industry_pnl_yuan: Record<string, number>;
}

const SCENARIOS: Scenario[] = [
  { name: "核心_三仓每日一只", start: START, end: END, industryTrend: true, stockRelativeStrength: true, maxPositions: 3, dailyBuyLimit: 1, onePerIndustry: true, slippageBps: 10, excludeSmall: false, riskPct: 0.008, maxPositionPct: 0.30 },
  { name: "消融_无行业趋势", start: START, end: END, industryTrend: false, stockRelativeStrength: true, maxPositions: 3, dailyBuyLimit: 1, onePerIndustry: true, slippageBps: 10, excludeSmall: false, riskPct: 0.008, maxPositionPct: 0.30 },
  { name: "消融_无个股相对强度", start: START, end: END, industryTrend: true, stockRelativeStrength: false, maxPositions: 3, dailyBuyLimit: 1, onePerIndustry: true, slippageBps: 10, excludeSmall: false, riskPct: 0.008, maxPositionPct: 0.30 },
  { name: "对照_五仓每日一只", start: START, end: END, industryTrend: true, stockRelativeStrength: true, maxPositions: 5, dailyBuyLimit: 1, onePerIndustry: true, slippageBps: 10, excludeSmall: false, riskPct: 0.008, maxPositionPct: 0.20 },
  { name: "消融_允许同行业重复", start: START, end: END, industryTrend: true, stockRelativeStrength: true, maxPositions: 3, dailyBuyLimit: 1, onePerIndustry: false, slippageBps: 10, excludeSmall: false, riskPct: 0.008, maxPositionPct: 0.30 },
  { name: "压力_30bp", start: START, end: END, industryTrend: true, stockRelativeStrength: true, maxPositions: 3, dailyBuyLimit: 1, onePerIndustry: true, slippageBps: 30, excludeSmall: false, riskPct: 0.008, maxPositionPct: 0.30 },
  { name: "卫生_CH3", start: START, end: END, industryTrend: true, stockRelativeStrength: true, maxPositions: 3, dailyBuyLimit: 1, onePerIndustry: true, slippageBps: 10, excludeSmall: true, riskPct: 0.008, maxPositionPct: 0.30 },
  { name: "核心_前窗", start: START, end: "2022-12-30", industryTrend: true, stockRelativeStrength: true, maxPositions: 3, dailyBuyLimit: 1, onePerIndustry: true, slippageBps: 10, excludeSmall: false, riskPct: 0.008, maxPositionPct: 0.30 },
  { name: "核心_后窗", start: "2023-01-03", end: END, industryTrend: true, stockRelativeStrength: true, maxPositions: 3, dailyBuyLimit: 1, onePerIndustry: true, slippageBps: 10, excludeSmall: false, riskPct: 0.008, maxPositionPct: 0.30 },
  { name: "修正_无行业趋势_20日冷却", start: START, end: END, industryTrend: false, stockRelativeStrength: true, maxPositions: 3, dailyBuyLimit: 1, onePerIndustry: true, slippageBps: 10, excludeSmall: false, riskPct: 0.008, maxPositionPct: 0.30, cooldownDays: 20 },
  { name: "修正_无行业趋势_五仓", start: START, end: END, industryTrend: false, stockRelativeStrength: true, maxPositions: 5, dailyBuyLimit: 1, onePerIndustry: true, slippageBps: 10, excludeSmall: false, riskPct: 0.008, maxPositionPct: 0.20 },
  { name: "修正_无行业趋势_30bp", start: START, end: END, industryTrend: false, stockRelativeStrength: true, maxPositions: 3, dailyBuyLimit: 1, onePerIndustry: true, slippageBps: 30, excludeSmall: false, riskPct: 0.008, maxPositionPct: 0.30 },
  { name: "修正_无行业趋势_CH3", start: START, end: END, industryTrend: false, stockRelativeStrength: true, maxPositions: 3, dailyBuyLimit: 1, onePerIndustry: true, slippageBps: 10, excludeSmall: true, riskPct: 0.008, maxPositionPct: 0.30 },
  { name: "修正_无行业趋势_前窗", start: START, end: "2022-12-30", industryTrend: false, stockRelativeStrength: true, maxPositions: 3, dailyBuyLimit: 1, onePerIndustry: true, slippageBps: 10, excludeSmall: false, riskPct: 0.008, maxPositionPct: 0.30 },
  { name: "修正_无行业趋势_后窗", start: "2023-01-03", end: END, industryTrend: false, stockRelativeStrength: true, maxPositions: 3, dailyBuyLimit: 1, onePerIndustry: true, slippageBps: 10, excludeSmall: false, riskPct: 0.008, maxPositionPct: 0.30 },
];

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
function charges(grossCents: number, side: "buy" | "sell"): number {
  const commission = Math.max(MIN_COMMISSION_CENTS, Math.round(grossCents * COMMISSION_BPS / 10_000));
  return commission + (side === "sell" ? Math.round(grossCents * SELL_TAX_BPS / 10_000) : 0);
}
function selfCheck(): void {
  assert.equal(charges(100_000, "buy"), 500);
  assert.equal(clamp(0.02, 0.05, 0.10), 0.05);
  assert.equal(clamp(0.12, 0.05, 0.10), 0.10);
}

async function loadCandidates(pool: pg.Pool): Promise<Candidate[]> {
  const cacheKey = createHash("sha256").update(JSON.stringify({ version: 1, boards, start: START, end: END })).digest("hex").slice(0, 12);
  const cacheFile = path.join(outDir, `候选缓存-${cacheKey}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Candidate[];
  console.time("首突破候选查询");
  const { rows } = await pool.query<Candidate>(
    `WITH membership AS (
       SELECT mi.id AS stock_id, mi.code, bi.code AS board
       FROM market_board_membership m
       JOIN market_instrument bi ON bi.id=m.board_instrument_id
       JOIN market_instrument mi ON mi.id=m.member_instrument_id
       WHERE m.effective_to IS NULL AND bi.code LIKE '881%.TI' AND mi.kind='stock'
         AND mi.code ~ '^[0-9]{6}[.](SH|SZ)$'
     ), raw AS (
       SELECT m.stock_id, m.code, m.board, b.bar_date, b.open::float8, b.close::float8, b.volume::float8,
              v.ma10::float8, v.ma20::float8, v.ma60::float8, v.status,
              lag(b.close,1) OVER w::float8 AS previous_close,
              lag(b.close,20) OVER w::float8 AS close20,
              lag(b.close,60) OVER w::float8 AS close60,
              lag(v.ma20,1) OVER w::float8 AS previous_ma20,
              max(b.close) OVER (PARTITION BY m.stock_id ORDER BY b.bar_date ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)::float8 AS breakout_close,
              avg(b.volume) OVER (PARTITION BY m.stock_id ORDER BY b.bar_date ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)::float8 AS volume20,
              lead(b.open,1) OVER w::float8 AS next_open,
              lead(b.close,20) OVER w::float8 AS future_close20
       FROM membership m
       JOIN market_bar b ON b.instrument_id=m.stock_id AND b.freq='day' AND b.bar_date BETWEEN $1 AND $3
       JOIN market_indicator_value v ON v.instrument_id=b.instrument_id AND v.freq=b.freq
         AND v.bar_date=b.bar_date AND v.bar_time=b.bar_time
       WINDOW w AS (PARTITION BY m.stock_id ORDER BY b.bar_date)
     ), returns AS (
       SELECT *, close/NULLIF(previous_close,0)-1 AS daily_return,
              close/NULLIF(close20,0)-1 AS stock_return20,
              close/NULLIF(close60,0)-1 AS stock_return60
       FROM raw
     ), stock_features AS (
       SELECT *, stddev_samp(daily_return) OVER (PARTITION BY stock_id ORDER BY bar_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)::float8 AS sigma20
       FROM returns
     ), industry AS (
       SELECT board, bar_date,
              avg(stock_return20) FILTER (WHERE stock_return20 IS NOT NULL)::float8 AS industry_return20,
              avg(stock_return60) FILTER (WHERE stock_return60 IS NOT NULL)::float8 AS industry_return60,
              avg(CASE WHEN close>=ma20 THEN 1.0 ELSE 0.0 END) FILTER (WHERE ma20 IS NOT NULL AND stock_return60 IS NOT NULL)::float8 AS breadth
       FROM stock_features GROUP BY board,bar_date
     ), industry_features AS (
       SELECT *, lag(breadth,5) OVER (PARTITION BY board ORDER BY bar_date)::float8 AS breadth5,
              percent_rank() OVER (PARTITION BY bar_date ORDER BY industry_return60)::float8 AS industry_rank60
       FROM industry WHERE industry_return60 IS NOT NULL
     ), ranked AS (
       SELECT s.*, i.industry_return20, i.industry_return60, i.breadth, i.breadth5, i.industry_rank60,
              percent_rank() OVER (PARTITION BY s.board,s.bar_date ORDER BY s.stock_return20)::float8 AS stock_rank20,
              percent_rank() OVER (PARTITION BY s.board,s.bar_date ORDER BY s.stock_return60)::float8 AS stock_rank60
       FROM stock_features s JOIN industry_features i USING(board,bar_date)
       WHERE s.stock_return20 IS NOT NULL AND s.stock_return60 IS NOT NULL
     )
     SELECT bar_date::text AS date, code, board, close AS signal_close, breakout_close, sigma20,
            industry_return20, industry_return60, breadth, breadth5, industry_rank60, stock_rank20, stock_rank60,
            close/NULLIF(ma20,0)-1 AS extension, next_open, future_close20
     FROM ranked
     WHERE bar_date BETWEEN $2 AND $3 AND board=ANY($4::text[]) AND status='ready'
       AND ma10 IS NOT NULL AND ma20 IS NOT NULL AND ma60 IS NOT NULL AND previous_ma20 IS NOT NULL
       AND close>ma20 AND ma20>ma60 AND ma20>previous_ma20
       AND breakout_close IS NOT NULL AND close>breakout_close
       AND volume20>0 AND volume>volume20*1.2
       AND sigma20 IS NOT NULL AND sigma20>0
       AND close/ma20-1<=LEAST(0.15,GREATEST(0.06,3*sigma20))
     ORDER BY bar_date,board,code`,
    [QUERY_START, START, END, boards],
  );
  console.timeEnd("首突破候选查询");
  const result = rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, value === null || ["date", "code", "board"].includes(key) ? value : Number(value)])) as unknown as Candidate);
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
       SELECT b.bar_date,b.close/NULLIF(lag(b.close) OVER(PARTITION BY b.instrument_id ORDER BY b.bar_date),0)-1 AS ret
       FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id
       WHERE i.kind='board' AND i.code LIKE '881%.SY' AND b.freq='day' AND b.bar_date BETWEEN '2020-01-01' AND $1)
     SELECT bar_date::text AS date,avg(ret)::float8 AS ret FROM board_ret WHERE ret IS NOT NULL
     GROUP BY bar_date HAVING count(*)>=60 ORDER BY bar_date`, [END]);
  let level = 1000; const closes: number[] = []; const recovery = new Map<string, boolean>();
  for (let index = 0; index < rows.length; index += 1) {
    level *= 1 + Number(rows[index]!.ret ?? 0); closes.push(level);
    recovery.set(rows[index]!.date, index >= 20 && level >= closes[index - 20]!);
  }
  return { dates: rows.map(row => row.date).filter(date => date >= START && date <= END), recovery };
}

class DayLoader {
  private cache = new Map<string, Map<string, DayRow | null>>();
  constructor(private pool: pg.Pool) {}
  async load(date: string, codes: string[]): Promise<Map<string, DayRow | null>> {
    let day = this.cache.get(date); if (!day) { day = new Map(); this.cache.set(date, day); }
    const missing = [...new Set(codes)].filter(code => !day!.has(code));
    if (missing.length) {
      const { rows } = await this.pool.query<DayRow>(
        `SELECT i.code,b.open::float8,b.close::float8,b.volume::float8,v.ma10::float8,
                previous.close::float8 AS previous_close,volume20.mean_volume20::float8
         FROM market_instrument i JOIN market_bar b ON b.instrument_id=i.id AND b.freq='day' AND b.bar_date=$1
         LEFT JOIN market_indicator_value v ON v.instrument_id=b.instrument_id AND v.freq=b.freq AND v.bar_date=b.bar_date AND v.bar_time=b.bar_time
         LEFT JOIN LATERAL (SELECT pb.close FROM market_bar pb WHERE pb.instrument_id=i.id AND pb.freq='day' AND pb.bar_date<$1 ORDER BY pb.bar_date DESC LIMIT 1) previous ON true
         LEFT JOIN LATERAL (SELECT avg(x.volume) AS mean_volume20 FROM (SELECT pb.volume FROM market_bar pb WHERE pb.instrument_id=i.id AND pb.freq='day' AND pb.bar_date<$1 ORDER BY pb.bar_date DESC LIMIT 20) x) volume20 ON true
         WHERE i.code=ANY($2::text[])`, [date, missing]);
      const found = new Set<string>();
      for (const row of rows) { found.add(row.code); day.set(row.code, Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key === "code" || value === null ? value : Number(value)])) as unknown as DayRow); }
      for (const code of missing) if (!found.has(code)) day.set(code, null);
    }
    return day;
  }
}

function eligible(candidate: Candidate, scenario: Scenario): boolean {
  const industry = candidate.industry_return20 > 0 && candidate.industry_return60 > 0 && candidate.industry_rank60 >= 0.7 &&
    candidate.breadth >= 0.5 && candidate.breadth5 !== null && candidate.breadth >= candidate.breadth5;
  const stock = candidate.stock_rank60 >= 0.7 && candidate.stock_rank20 >= 0.6;
  return (!scenario.industryTrend || industry) && (!scenario.stockRelativeStrength || stock);
}
function compareCandidate(left: Candidate, right: Candidate): number {
  return right.industry_rank60 - left.industry_rank60 || right.stock_rank60 - left.stock_rank60 ||
    right.stock_rank20 - left.stock_rank20 || left.extension - right.extension || left.code.localeCompare(right.code);
}

class Portfolio {
  private cash = INITIAL_CASH_CENTS; private fees = 0; private positions = new Map<string, Position>();
  private buys: PendingBuy[] = []; private sells = new Map<string, PendingSell>(); private stopStreak = 0;
  private pausedSince: number | null = null; private recentEquities: number[] = []; private peak = INITIAL_CASH_CENTS;
  private previousEquity = INITIAL_CASH_CENTS; private maxDrawdown = 0; private trades = 0; private wins = 0;
  private exposureSum = 0; private days = 0; private pausedDays = 0; private candidateCount = 0; private eligibleCount = 0;
  private selectedCount = 0; private fills = 0; private lastSignalDay = new Map<string, number>();
  private exits: Record<string, number> = {}; private perYear: Record<string, number> = {}; private industryPnl: Record<string, number> = {};
  constructor(readonly scenario: Scenario, private lowTurnover: Set<string>) {}
  active(date: string): boolean { return date >= this.scenario.start && date <= this.scenario.end; }
  neededCodes(): string[] { return [...new Set([...this.positions.keys(), ...this.buys.map(order => order.code), ...this.sells.keys()])]; }
  private execution(row: DayRow, side: "buy" | "sell"): { price: number; capacity: number } | null {
    if (row.previous_close === null || row.mean_volume20 === null) return null;
    const upper = Math.round(row.previous_close * 1.1 * 100) / 100; const lower = Math.round(row.previous_close * 0.9 * 100) / 100;
    if (row.open < lower || row.open > upper || (side === "buy" && row.open >= upper) || (side === "sell" && row.open <= lower)) return null;
    const price = row.open * (1 + (side === "buy" ? 1 : -1) * this.scenario.slippageBps / 10_000);
    const capacity = Math.floor(row.mean_volume20 * VOLUME_PARTICIPATION / LOT) * LOT;
    return price > 0 && capacity >= LOT ? { price, capacity } : null;
  }
  processOpen(rows: Map<string, DayRow | null>, dayIndex: number): void {
    let newStopRisk = 0;
    for (const [code, intent] of [...this.sells.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const row = rows.get(code); const position = this.positions.get(code); if (!row || !position) continue;
      const fill = this.execution(row, "sell"); if (!fill) continue;
      const quantity = Math.min(position.quantity, fill.capacity); if (quantity < LOT) continue;
      const gross = Math.round(fill.price * quantity * 100); const fee = charges(gross, "sell");
      const allocated = Math.round(position.costCents * quantity / position.quantity);
      this.cash += gross - fee; this.fees += fee; position.costCents -= allocated; position.quantity -= quantity;
      position.realizedCents += gross - fee - allocated; this.fills += 1;
      if (position.quantity === 0) {
        this.positions.delete(code); this.sells.delete(code); this.trades += 1; if (position.realizedCents > 0) this.wins += 1;
        this.exits[intent.reason] = (this.exits[intent.reason] ?? 0) + 1;
        this.industryPnl[position.board] = (this.industryPnl[position.board] ?? 0) + position.realizedCents;
        const stop = STOP_REASONS.has(intent.reason); this.stopStreak = stop ? this.stopStreak + 1 : 0;
        if (stop && this.stopStreak >= 3) newStopRisk = this.stopStreak;
      }
    }
    for (const order of this.buys) {
      if (this.pausedSince !== null || this.positions.has(order.code) || this.positions.size >= this.scenario.maxPositions) continue;
      const row = rows.get(order.code); if (!row || row.open > order.signal_close * 1.03) continue;
      const fill = this.execution(row, "buy"); if (!fill) continue;
      const stopPct = clamp(2.5 * order.sigma20, 0.05, 0.10);
      const initialStop = Math.min(fill.price * 0.995, Math.max(fill.price * (1 - stopPct), order.breakout_close * (1 - order.sigma20)));
      const riskPerShare = fill.price - initialStop; if (riskPerShare <= 0) continue;
      const equity = this.previousEquity;
      const riskQuantity = Math.floor((equity / 100 * order.budgetRiskPct) / riskPerShare / LOT) * LOT;
      const positionQuantity = Math.floor((equity / 100 * order.maxPositionPct) / fill.price / LOT) * LOT;
      let quantity = Math.min(riskQuantity, positionQuantity, fill.capacity);
      while (quantity >= LOT) {
        const gross = Math.round(fill.price * quantity * 100); const fee = charges(gross, "buy");
        if (gross + fee <= this.cash) {
          this.cash -= gross + fee; this.fees += fee; this.fills += 1;
          this.positions.set(order.code, { code: order.code, board: order.board, quantity, entryPrice: fill.price, costCents: gross + fee,
            realizedCents: 0, entryDayIndex: dayIndex, initialStop, initialRisk: riskPerShare, sigma20: order.sigma20,
            highestClose: row.close, belowMa10Days: 0, lastClose: row.close });
          break;
        }
        quantity -= LOT;
      }
    }
    this.buys = [];
    if (newStopRisk >= 3 && this.pausedSince === null) this.pausedSince = dayIndex;
  }
  processClose(date: string, dayIndex: number, rows: Map<string, DayRow | null>, candidates: Candidate[], marketRecovery: boolean): void {
    let marketValue = 0;
    for (const position of this.positions.values()) {
      const row = rows.get(position.code); if (row) position.lastClose = row.close;
      marketValue += Math.round(position.lastClose * position.quantity * 100); if (!row) continue;
      position.highestClose = Math.max(position.highestClose, row.close);
      position.belowMa10Days = row.ma10 !== null && row.close < row.ma10 ? position.belowMa10Days + 1 : 0;
      const holdingDays = dayIndex - position.entryDayIndex + 1;
      const reachedTwoR = position.highestClose >= position.entryPrice + 2 * position.initialRisk;
      const trailPct = clamp(3 * position.sigma20, 0.08, 0.18);
      const trail = Math.max(position.initialStop, position.highestClose * (1 - trailPct));
      let reason: ExitReason | null = row.close <= position.initialStop ? "initial_stop" :
        reachedTwoR && row.close <= trail ? "volatility_trail" : position.belowMa10Days >= 2 ? "ma10_two_days" :
          holdingDays >= 10 && position.highestClose < position.entryPrice + position.initialRisk ? "time_stop" :
            holdingDays >= 60 ? "max_holding" : null;
      if (reason) this.sells.set(position.code, { reason });
    }
    const total = this.cash + marketValue; this.peak = Math.max(this.peak, total); this.maxDrawdown = Math.max(this.maxDrawdown, (this.peak - total) / this.peak);
    this.recentEquities.push(total); if (this.recentEquities.length > 20) this.recentEquities.shift();
    const recentPeak = Math.max(...this.recentEquities);
    if ((recentPeak - total) / recentPeak > 0.05 && this.pausedSince === null) this.pausedSince = dayIndex;
    else if (this.pausedSince !== null && dayIndex > this.pausedSince && marketRecovery) { this.pausedSince = null; this.stopStreak = 0; }

    this.candidateCount += candidates.length;
    const ranked = candidates.filter(candidate => eligible(candidate, this.scenario) && (!this.scenario.excludeSmall || !this.lowTurnover.has(candidate.code)))
      .sort(compareCandidate);
    const cooled: Candidate[] = [];
    for (const candidate of ranked) {
      const previous = this.lastSignalDay.get(candidate.code);
      if (previous !== undefined && dayIndex - previous < (this.scenario.cooldownDays ?? 10)) continue;
      this.lastSignalDay.set(candidate.code, dayIndex); cooled.push(candidate);
    }
    this.eligibleCount += cooled.length;
    if (this.pausedSince === null) {
      const slots = this.scenario.maxPositions - this.positions.size + this.sells.size;
      const usedBoards = new Set([...this.positions.values()].map(position => position.board));
      for (const candidate of cooled) {
        if (this.buys.length >= Math.min(this.scenario.dailyBuyLimit, slots)) break;
        if (this.positions.has(candidate.code) || this.buys.some(order => order.code === candidate.code)) continue;
        if (this.scenario.onePerIndustry && usedBoards.has(candidate.board)) continue;
        this.buys.push({ ...candidate, budgetRiskPct: this.scenario.riskPct, maxPositionPct: this.scenario.maxPositionPct });
        usedBoards.add(candidate.board); this.selectedCount += 1;
      }
    }
    this.days += 1; this.exposureSum += total > 0 ? marketValue / total : 0; if (this.pausedSince !== null) this.pausedDays += 1;
    const year = date.slice(0, 4); this.perYear[year] = (this.perYear[year] ?? 1) * total / this.previousEquity; this.previousEquity = total;
  }
  finish(): Result {
    const totalReturn = this.previousEquity / INITIAL_CASH_CENTS - 1;
    for (const year of Object.keys(this.perYear)) this.perYear[year] = round(this.perYear[year]! - 1);
    return { name: this.scenario.name, total_return: round(totalReturn), annual_return: round(Math.pow(1 + totalReturn, 252 / Math.max(1, this.days)) - 1),
      max_drawdown: round(this.maxDrawdown), trade_count: this.trades, win_rate: this.trades ? round(this.wins / this.trades) : null,
      exposure: round(this.exposureSum / Math.max(1, this.days)), fees_yuan: round(this.fees / 100, 2), paused_days: this.pausedDays,
      candidate_count: this.candidateCount, eligible_count: this.eligibleCount, selected_count: this.selectedCount, fills: this.fills,
      exits: this.exits, per_year: this.perYear, industry_pnl_yuan: Object.fromEntries(Object.entries(this.industryPnl).map(([key, value]) => [key, round(value / 100, 2)])) };
  }
}

function eventSummary(candidates: Candidate[]): Record<string, number | null> {
  const valid = candidates.filter(candidate => candidate.next_open !== null && candidate.future_close20 !== null && candidate.next_open! <= candidate.signal_close * 1.03);
  const returns = valid.map(candidate => candidate.future_close20! / (candidate.next_open! * 1.001) - 1);
  const sorted = [...returns].sort((a, b) => a - b);
  return { count: valid.length, avg_return20: returns.length ? round(returns.reduce((sum, value) => sum + value, 0) / returns.length) : null,
    median_return20: sorted.length ? round(sorted[Math.floor(sorted.length / 2)]!) : null,
    win_rate20: returns.length ? round(returns.filter(value => value > 0).length / returns.length) : null };
}

async function main(): Promise<void> {
  selfCheck(); const pool = getPool(loadConfig().databaseUrl);
  const [candidates, lowTurnover, calendar] = await Promise.all([loadCandidates(pool), loadLowTurnover(pool), loadCalendar(pool)]);
  const byDate = new Map<string, Candidate[]>(); for (const candidate of candidates) byDate.set(candidate.date, [...(byDate.get(candidate.date) ?? []), candidate]);
  const inputHash = createHash("sha256").update(JSON.stringify(candidates)).digest("hex");
  console.log(`首突破候选 ${candidates.length} 条，${new Set(candidates.map(item => item.code)).size} 只股票，输入哈希 ${inputHash.slice(0, 12)}。`);
  const portfolios = SCENARIOS.map(scenario => new Portfolio(scenario, lowTurnover)); const loader = new DayLoader(pool);
  for (let index = 0; index < calendar.dates.length; index += 1) {
    const date = calendar.dates[index]!; const active = portfolios.filter(portfolio => portfolio.active(date));
    const needed = [...new Set(active.flatMap(portfolio => portfolio.neededCodes()))]; const rows = needed.length ? await loader.load(date, needed) : new Map<string, DayRow | null>();
    for (const portfolio of active) { portfolio.processOpen(rows, index); portfolio.processClose(date, index, rows, byDate.get(date) ?? [], calendar.recovery.get(date) ?? false); }
    if ((index + 1) % 250 === 0) console.log(`已处理 ${date}（${index + 1}/${calendar.dates.length}）`);
  }
  const results = portfolios.map(portfolio => portfolio.finish());
  console.log("\n配置\t总收益\t年化\t回撤\t交易\t胜率\t暴露\t合格候选");
  for (const result of results) console.log(`${result.name}\t${pct(result.total_return)}\t${pct(result.annual_return)}\t${pct(result.max_drawdown)}\t${result.trade_count}\t${result.win_rate === null ? "-" : pct(result.win_rate)}\t${pct(result.exposure)}\t${result.eligible_count}`);
  const eventSummaries = Object.fromEntries(SCENARIOS.slice(0, 3).map(scenario => [
    scenario.name,
    eventSummary(candidates.filter(candidate => eligible(candidate, scenario) &&
      (!scenario.excludeSmall || !lowTurnover.has(candidate.code)))),
  ]));
  const output = path.join(outDir, `行业相对强度首突破-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.json`);
  fs.writeFileSync(output, JSON.stringify({ strategy: "行业相对强度首突破v1", evidence: "research_only", range: { start: START, end: END }, boards,
    input_hash: inputHash, methodology: { industry: "20/60日收益为正、60日行业强度前30%、站上MA20宽度不低于50%且较5日前不下降",
      stock: "收盘>MA20>MA60、MA20上行、首次突破前20日最高收盘、量比>1.2、60日行业内强度前30%、20日前40%、不过度伸长、10日信号冷却",
      ranking: "行业60日强度→个股60日行业内强度→个股20日行业内强度→低伸长度，非MACD增量",
      portfolio: "三仓、每日一只、每行业一只、单笔风险0.8%、名义仓位上限30%",
      exit: "初始波动止损、达到2R后波动移动止损、连续两日跌破MA10、10日未达1R时间退出、60日上限、组合熔断" },
    caveats: ["当前行业归属回看", "正式指标自2020-11起有效", "前复权研究价格", "无真正未使用样本外", "停牌与涨跌停为研究近似"],
    candidates: candidates.length, event_summaries: eventSummaries, scenarios: SCENARIOS, results }, null, 2));
  console.log(`结果已写入 ${output}`); await closePool();
}
await main();
