// 铜核心生产商实验矩阵 C-H：商品连续仓位、个股技术入场、分批止盈和移动止损。
// 独立只读研究，不写回测账本或业务事实。
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import type pg from "pg";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import { calculateIndicators } from "../server/indicators/formulas.js";
import {
  COPPER_INVENTORY_REBALANCE_BAND,
  copperInventoryTargetExposure,
  inventoryInversePercentile,
} from "../server/modules/market/copper-inventory-signal.js";

const START = "2016-09-12";
const END = "2026-09-11";
const FRONT_END = "2022-12-30";
const BACK_START = "2023-01-03";
const INITIAL_CASH = 100_000_000;
const SLOT_COUNT = 5;
const LOT = 100;
const COMMISSION_BPS = 2.5;
const MIN_COMMISSION = 500;
const SELL_TAX_BPS = 10;
const SLIPPAGE_BPS = 10;
const PARTICIPATION = 0.02;
const OUT_DIR = path.resolve("支撑/tmp/铜核心标的技术退出研究");
fs.mkdirSync(OUT_DIR, { recursive: true });

type EntryModel = "none" | "repair" | "breakout";
type ExitStage = "none" | "initial" | "tier1" | "tier2" | "trail" | "top_risk";
type ExitReason = "rebalance" | "initial_stop" | "tier1_take_profit" | "tier2_take_profit" | "trailing_stop" | "top_risk_stop";
interface RawBar { code: string; date: string; open: number; high: number; low: number; close: number; volume: number }
interface Profile { code: string; effectiveFrom: string; effectiveTo: string | null; publishedDate: string }
interface Inventory { periodEnd: string; publishedDate: string; value: number }
interface CommodityState { executionDate: string; rawExposure: number; appliedExposure: number; score: number; worseningStreak: number; changed: boolean }
interface Point extends RawBar {
  ma10: number | null; ma20: number | null; ma20Prev5: number | null; atr14: number | null; macdHist: number | null;
  prior20High: number | null; prior10Low: number | null; return20: number | null; relative20: number | null;
  basketClose: number | null; basketPrior60High: number | null; copperAt60High: boolean;
}
interface Scenario { key: string; name: string; entry: EntryModel; exit: ExitStage; commodityOverlay: boolean }
interface Position {
  code: string; quantity: number; entryPrice: number; initialQuantity: number; initialStop: number; stop: number; risk: number;
  peak: number; lastClose: number; firstScaled: boolean; secondScaled: boolean; lastMacd: number | null; realized: number;
  stopReason: "initial_stop" | "trailing_stop" | "top_risk_stop";
}
interface PendingSell { reason: ExitReason; quantity: number | null }
interface Result {
  key: string; name: string; start: string; end: string; total_return: number; annual_return: number; max_drawdown: number;
  annual_volatility: number; sharpe: number | null; calmar: number | null; exposure: number; fees_yuan: number;
  turnover_yuan: number; order_count: number; entry_count: number; exit_count: number; win_rate: number | null;
  exits: Record<string, number>; per_year: Record<string, number>; stock_pnl_yuan: Record<string, number>;
}

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));
const pct = (value: number | null): string => value === null ? "-" : `${(value * 100).toFixed(1)}%`;
function costs(gross: number, side: "buy" | "sell"): number {
  return Math.max(MIN_COMMISSION, Math.round(gross * COMMISSION_BPS / 10_000))
    + (side === "sell" ? Math.round(gross * SELL_TAX_BPS / 10_000) : 0);
}
function fillPrice(price: number, side: "buy" | "sell"): number {
  return Math.round(price * 100 * (1 + (side === "buy" ? 1 : -1) * SLIPPAGE_BPS / 10_000));
}
function nextDate(dates: string[], date: string, delay = 0): string | null {
  let left = 0; let right = dates.length;
  while (left < right) { const mid = (left + right) >> 1; if (dates[mid]! <= date) left = mid + 1; else right = mid; }
  return dates[left + delay] ?? null;
}
function mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function atr(rows: RawBar[], index: number, period = 14): number | null {
  if (index < period) return null;
  const values: number[] = [];
  for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
    const row = rows[cursor]!; const previous = rows[cursor - 1]!;
    values.push(Math.max(row.high - row.low, Math.abs(row.high - previous.close), Math.abs(row.low - previous.close)));
  }
  return mean(values);
}
function trailingReturn(rows: Array<{ close: number }>, index: number, days: number): number | null {
  return index >= days && rows[index - days]!.close > 0 ? rows[index]!.close / rows[index - days]!.close - 1 : null;
}

async function loadInputs(pool: pg.Pool) {
  const profiles = (await pool.query<Profile>(
    `SELECT instrument.code,profile.effective_from::text AS "effectiveFrom",profile.effective_to::text AS "effectiveTo",
            (profile.published_at AT TIME ZONE 'Asia/Shanghai')::date::text AS "publishedDate"
       FROM company_commodity_profile profile JOIN market_instrument instrument ON instrument.id=profile.instrument_id
      WHERE profile.commodity_code='CU' AND profile.role IN ('upstream_producer','integrated') ORDER BY instrument.code`,
  )).rows;
  const codes = [...new Set(profiles.map(row => row.code))];
  if (codes.length !== SLOT_COUNT) throw new Error(`铜核心标的应为${SLOT_COUNT}只，当前${codes.length}只`);
  const bars = (await pool.query<RawBar>(
    `SELECT instrument.code,bar.bar_date::text AS date,bar.open::float8,bar.high::float8,bar.low::float8,
            bar.close::float8,bar.volume::float8
       FROM market_bar bar JOIN market_instrument instrument ON instrument.id=bar.instrument_id
      WHERE instrument.code=ANY($1::text[]) AND bar.freq='day' AND bar.adjustment='forward'
        AND bar.bar_date BETWEEN ($2::date - interval '180 days') AND $3::date
        AND bar.open>0 AND bar.high>0 AND bar.low>0 AND bar.close>0 AND bar.volume>0
      ORDER BY instrument.code,bar.bar_date`, [codes, START, END])).rows;
  const dates = (await pool.query<{ date: string }>(
    `SELECT trade_date::text AS date FROM market_trading_day WHERE is_open=true AND trade_date BETWEEN $1 AND $2 ORDER BY trade_date`,
    [START, END],
  )).rows.map(row => row.date);
  const inventory = (await pool.query<Inventory>(
    `SELECT observation.period_end::text AS "periodEnd",
            (observation.published_at AT TIME ZONE 'Asia/Shanghai')::date::text AS "publishedDate",observation.value::float8
       FROM market_factor_observation observation JOIN market_factor_series series ON series.id=observation.series_id
      WHERE series.series_code='shfe.cu.inventory.total' AND observation.published_at < ($1::date + interval '1 day')
      ORDER BY observation.published_at,observation.period_end`, [END])).rows;
  const copper = (await pool.query<{ date: string; close: number }>(
    `SELECT bar.bar_date::text AS date,bar.close::float8 FROM market_bar bar JOIN market_instrument instrument ON instrument.id=bar.instrument_id
      WHERE instrument.code='CU0' AND bar.freq='futures_day' AND bar.bar_date BETWEEN ($1::date - interval '120 days') AND $2
      ORDER BY bar.bar_date`, [START, END])).rows;
  return { profiles, codes, bars, dates, inventory, copper };
}

function buildPoints(input: Awaited<ReturnType<typeof loadInputs>>) {
  const rawByCode = new Map<string, RawBar[]>(input.codes.map(code => [code, []]));
  for (const bar of input.bars) rawByCode.get(bar.code)!.push(bar);
  const dateReturns = new Map<string, number[]>();
  for (const rows of rawByCode.values()) for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]!; const prior = rows[index - 1]!;
    if (prior.close > 0) dateReturns.set(row.date, [...(dateReturns.get(row.date) ?? []), row.close / prior.close - 1]);
  }
  let basket = 100;
  const basketRows: Array<{ date: string; close: number }> = [];
  for (const date of [...dateReturns.keys()].sort()) {
    const returns = dateReturns.get(date)!;
    if (returns.length >= 3) basket *= 1 + mean(returns);
    basketRows.push({ date, close: basket });
  }
  const basketByDate = new Map(basketRows.map((row, index) => [row.date, {
    close: row.close,
    return20: trailingReturn(basketRows, index, 20),
    prior60High: index >= 60 ? Math.max(...basketRows.slice(index - 60, index).map(item => item.close)) : null,
  }]));
  const copperByDate = new Map<string, { close: number; prior60High: number | null }>();
  input.copper.forEach((row, index) => copperByDate.set(row.date, {
    close: row.close,
    prior60High: index >= 60 ? Math.max(...input.copper.slice(index - 60, index).map(item => item.close)) : null,
  }));
  const pointsByCode = new Map<string, Point[]>();
  const pointByDate = new Map<string, Map<string, Point>>();
  for (const [code, rows] of rawByCode) {
    const indicators = calculateIndicators(rows.map(row => row.close));
    const points = rows.map((row, index): Point => {
      const item = indicators[index]!;
      const basketItem = basketByDate.get(row.date);
      const copperItem = copperByDate.get(row.date);
      const return20 = trailingReturn(rows, index, 20);
      return {
        ...row,
        ma10: item.ma10, ma20: item.ma20, ma20Prev5: index >= 5 ? indicators[index - 5]!.ma20 : null,
        atr14: atr(rows, index), macdHist: item.macdHist,
        prior20High: index >= 20 ? Math.max(...rows.slice(index - 20, index).map(value => value.high)) : null,
        prior10Low: index >= 10 ? Math.min(...rows.slice(index - 10, index).map(value => value.low)) : null,
        return20, relative20: return20 !== null && basketItem?.return20 !== null && basketItem?.return20 !== undefined
          ? return20 - basketItem.return20 : null,
        basketClose: basketItem?.close ?? null, basketPrior60High: basketItem?.prior60High ?? null,
        copperAt60High: copperItem?.prior60High !== null && copperItem?.prior60High !== undefined
          ? copperItem.close >= copperItem.prior60High : false,
      };
    });
    pointsByCode.set(code, points);
    for (const point of points) {
      if (!pointByDate.has(point.date)) pointByDate.set(point.date, new Map());
      pointByDate.get(point.date)!.set(code, point);
    }
  }
  return { pointsByCode, pointByDate };
}

function buildCommodityStates(input: Awaited<ReturnType<typeof loadInputs>>, delay = 0): CommodityState[] {
  const changes: number[] = [];
  const states: CommodityState[] = [];
  let applied = -1;
  let priorScore: number | null = null;
  let worseningStreak = 0;
  for (let index = 4; index < input.inventory.length; index += 1) {
    const current = input.inventory[index]!; const prior = input.inventory[index - 4]!;
    if (prior.value <= 0) continue;
    const change = current.value / prior.value - 1;
    const score = inventoryInversePercentile(change, changes);
    changes.push(change);
    if (current.publishedDate < START) continue;
    const executionDate = nextDate(input.dates, current.publishedDate, delay);
    if (!executionDate) continue;
    const rawExposure = copperInventoryTargetExposure(score);
    if (priorScore !== null && score < priorScore) worseningStreak += 1; else worseningStreak = 0;
    priorScore = score;
    const changed = applied < 0 || Math.abs(rawExposure - applied) >= COPPER_INVENTORY_REBALANCE_BAND;
    if (changed) applied = rawExposure;
    states.push({ executionDate, rawExposure, appliedExposure: applied, score, worseningStreak, changed });
  }
  return states;
}

function activeCodes(profiles: Profile[], date: string): string[] {
  return profiles.filter(profile => profile.publishedDate <= date && profile.effectiveFrom <= date
    && (profile.effectiveTo === null || profile.effectiveTo > date)).map(profile => profile.code).sort();
}
function entryPassed(model: EntryModel, current: Point, previous: Point | null): boolean {
  if (model === "none" || !previous || current.ma20 === null || current.ma20Prev5 === null || current.atr14 === null
      || current.relative20 === null || current.prior20High === null) return false;
  const rising = current.ma20 > current.ma20Prev5;
  if (!rising || current.relative20 <= 0) return false;
  if (model === "repair") {
    const extension = (current.close - current.ma20) / current.atr14;
    return previous.ma20 !== null && previous.close <= previous.ma20 && current.close > current.ma20 && extension <= 2;
  }
  return current.close > current.prior20High;
}

class Portfolio {
  private cash = INITIAL_CASH;
  private positions = new Map<string, Position>();
  private pendingBuys = new Set<string>();
  private pendingSells = new Map<string, PendingSell>();
  private exposureTarget = 1;
  private peak = INITIAL_CASH;
  private previous = INITIAL_CASH;
  private maxDrawdown = 0;
  private fees = 0;
  private turnover = 0;
  private orders = 0;
  private entries = 0;
  private closed = 0;
  private wins = 0;
  private exposureSum = 0;
  private days = 0;
  private dailyReturns: number[] = [];
  private exits: Record<string, number> = {};
  private perYear: Record<string, number> = {};
  private stockPnl: Record<string, number> = {};
  private worseningStreak = 0;
  private activeKey = "";
  private initialized = false;

  constructor(private readonly scenario: Scenario, private readonly start: string, private readonly end: string) {}
  private capacity(point: Point): number { return Math.floor(point.volume * PARTICIPATION / LOT) * LOT; }
  private sell(code: string, position: Position, point: Point, intent: PendingSell): void {
    const quantity = Math.min(position.quantity, intent.quantity ?? position.quantity, this.capacity(point));
    const rounded = Math.floor(quantity / LOT) * LOT;
    if (rounded < LOT) return;
    const price = fillPrice(point.open, "sell"); const gross = rounded * price; const fee = costs(gross, "sell");
    const allocatedCost = Math.round(position.entryPrice * rounded);
    this.cash += gross - fee; this.fees += fee; this.turnover += gross; this.orders += 1;
    position.quantity -= rounded; position.realized += gross - fee - allocatedCost;
    if (intent.reason === "tier1_take_profit") position.firstScaled = true;
    if (intent.reason === "tier2_take_profit") position.secondScaled = true;
    this.exits[intent.reason] = (this.exits[intent.reason] ?? 0) + 1;
    if (position.quantity === 0) {
      this.positions.delete(code); this.closed += 1; if (position.realized > 0) this.wins += 1;
      this.stockPnl[code] = (this.stockPnl[code] ?? 0) + position.realized;
    }
  }
  private buy(code: string, point: Point, budget: number): void {
    const price = fillPrice(point.open, "buy");
    let quantity = Math.min(Math.floor(budget / price / LOT) * LOT, this.capacity(point));
    while (quantity >= LOT && quantity * price + costs(quantity * price, "buy") > this.cash) quantity -= LOT;
    if (quantity < LOT) return;
    const gross = quantity * price; const fee = costs(gross, "buy");
    const recentLow = point.prior10Low ?? point.low; const atrStop = point.open - 2 * (point.atr14 ?? point.open * 0.05);
    const initialStop = Math.min(point.open * 0.995, Math.max(recentLow, atrStop, point.open * 0.90));
    this.cash -= gross + fee; this.fees += fee; this.turnover += gross; this.orders += 1; this.entries += 1;
    const existing = this.positions.get(code);
    if (existing) {
      const oldCost = existing.entryPrice * existing.quantity; existing.quantity += quantity;
      existing.entryPrice = Math.round((oldCost + price * quantity) / existing.quantity);
      existing.initialQuantity = Math.max(existing.initialQuantity, existing.quantity);
      existing.lastClose = point.close;
    } else {
      this.positions.set(code, { code, quantity, entryPrice: price, initialQuantity: quantity,
        initialStop, stop: initialStop, risk: Math.max(1, price - Math.round(initialStop * 100)),
        peak: point.close, lastClose: point.close, firstScaled: false, secondScaled: false,
        lastMacd: point.macdHist, realized: -fee, stopReason: "initial_stop" });
    }
  }
  open(date: string, points: Map<string, Point>, profiles: Profile[], commodity: CommodityState | null): void {
    if (commodity) {
      this.worseningStreak = commodity.worseningStreak;
      this.exposureTarget = this.scenario.commodityOverlay ? commodity.appliedExposure : 1;
    }
    for (const [code, intent] of [...this.pendingSells]) {
      const position = this.positions.get(code); const point = points.get(code);
      if (position && point) this.sell(code, position, point, intent);
      this.pendingSells.delete(code);
    }
    const activeCodesNow = activeCodes(profiles, date);
    const active = new Set(activeCodesNow);
    const activeKey = activeCodesNow.join(",");
    const universeChanged = activeKey !== this.activeKey;
    const allocationChanged = !this.initialized || universeChanged || (this.scenario.commodityOverlay && commodity?.changed === true);
    this.activeKey = activeKey;
    this.initialized = true;
    let equity = this.cash;
    for (const [code, position] of this.positions) equity += position.quantity * Math.round((points.get(code)?.open ?? position.lastClose) * 100);
    const slotBudget = equity * this.exposureTarget / SLOT_COUNT;
    if (allocationChanged) {
      for (const [code, position] of [...this.positions]) {
        const point = points.get(code); if (!point) continue;
        const desired = active.has(code) ? Math.floor(slotBudget / fillPrice(point.open, "sell") / LOT) * LOT : 0;
        if (position.quantity > desired) this.sell(code, position, point, { reason: "rebalance", quantity: position.quantity - desired });
      }
    }
    for (const code of active) {
      const point = points.get(code); if (!point) continue;
      const position = this.positions.get(code);
      const entryTriggered = this.pendingBuys.has(code);
      const mayOpen = this.scenario.entry === "none" ? allocationChanged : entryTriggered;
      if (!position && mayOpen) this.buy(code, point, slotBudget);
      else if (position && allocationChanged && position.quantity * point.open * 100 < slotBudget * 0.8) {
        this.buy(code, point, slotBudget - position.quantity * point.open * 100);
      }
    }
    this.pendingBuys.clear();
  }
  close(date: string, points: Map<string, Point>, previousPoints: Map<string, Point>, profiles: Profile[]): void {
    for (const code of activeCodes(profiles, date)) {
      const current = points.get(code);
      if (current && !this.positions.has(code) && entryPassed(this.scenario.entry, current, previousPoints.get(code) ?? null)) this.pendingBuys.add(code);
    }
    let marketValue = 0;
    for (const [code, position] of this.positions) {
      const point = points.get(code); if (!point) { marketValue += position.quantity * Math.round(position.lastClose * 100); continue; }
      position.lastClose = point.close; position.peak = Math.max(position.peak, point.close); marketValue += position.quantity * Math.round(point.close * 100);
      if (this.scenario.exit === "none") continue;
      let reason: PendingSell | null = null;
      if (point.close <= position.stop) reason = { reason: position.stopReason, quantity: null };
      const gainR = (point.close * 100 - position.entryPrice) / position.risk;
      if (!reason && ["tier1","tier2","trail","top_risk"].includes(this.scenario.exit) && !position.firstScaled && gainR >= 1.5) {
        const quantity = Math.floor(position.initialQuantity / 3 / LOT) * LOT;
        reason = { reason: "tier1_take_profit", quantity: Math.max(LOT, quantity) };
        position.stop = Math.max(position.stop, position.entryPrice / 100);
      }
      if (!reason && ["tier2","trail","top_risk"].includes(this.scenario.exit) && position.firstScaled && !position.secondScaled && gainR >= 3) {
        const quantity = Math.floor(position.initialQuantity / 3 / LOT) * LOT;
        reason = { reason: "tier2_take_profit", quantity: Math.max(LOT, quantity) };
      }
      if (["trail","top_risk"].includes(this.scenario.exit) && point.atr14 !== null && position.peak / (position.entryPrice / 100) - 1 >= 0.10) {
        let topRiskCount = 0;
        if (point.relative20 !== null && point.relative20 < 0) topRiskCount += 1;
        if (point.ma20 !== null && point.close < point.ma20) topRiskCount += 1;
        if (position.lastMacd !== null && position.lastMacd > 0 && point.macdHist !== null && point.macdHist <= 0
            && point.ma10 !== null && point.close < point.ma10) topRiskCount += 1;
        if (this.worseningStreak >= 2) topRiskCount += 1;
        if (point.copperAt60High && point.basketPrior60High !== null && point.basketClose !== null && point.basketClose < point.basketPrior60High) topRiskCount += 1;
        const tighten = this.scenario.exit === "top_risk" && topRiskCount >= 2;
        const trail = position.peak - Math.max(position.peak * (tighten ? 0.05 : 0.08), point.atr14 * (tighten ? 2 : 3));
        if (trail > position.stop) {
          position.stop = trail;
          position.stopReason = tighten ? "top_risk_stop" : "trailing_stop";
        }
        if (!reason && point.close <= position.stop) reason = { reason: tighten ? "top_risk_stop" : "trailing_stop", quantity: null };
      }
      if (reason && !this.pendingSells.has(code)) this.pendingSells.set(code, reason);
      position.lastMacd = point.macdHist;
    }
    const equity = this.cash + marketValue;
    this.peak = Math.max(this.peak, equity); this.maxDrawdown = Math.max(this.maxDrawdown, 1 - equity / this.peak);
    const dailyReturn = this.previous > 0 ? equity / this.previous - 1 : 0; this.dailyReturns.push(dailyReturn);
    this.perYear[date.slice(0, 4)] = (this.perYear[date.slice(0, 4)] ?? 1) * (1 + dailyReturn);
    this.previous = equity; this.exposureSum += equity > 0 ? marketValue / equity : 0; this.days += 1;
  }
  finish(): Result {
    const total = this.previous / INITIAL_CASH - 1; const annual = Math.pow(1 + total, 252 / Math.max(1, this.days)) - 1;
    const average = mean(this.dailyReturns); const variance = this.dailyReturns.reduce((sum, value) => sum + (value - average) ** 2, 0) / Math.max(1, this.dailyReturns.length - 1);
    const volatility = Math.sqrt(variance * 252);
    return { key: this.scenario.key, name: this.scenario.name, start: this.start, end: this.end,
      total_return: round(total), annual_return: round(annual), max_drawdown: round(this.maxDrawdown), annual_volatility: round(volatility),
      sharpe: volatility > 0 ? round(annual / volatility) : null, calmar: this.maxDrawdown > 0 ? round(annual / this.maxDrawdown) : null,
      exposure: round(this.exposureSum / Math.max(1, this.days)), fees_yuan: round(this.fees / 100, 2), turnover_yuan: round(this.turnover / 100, 2),
      order_count: this.orders, entry_count: this.entries, exit_count: this.closed, win_rate: this.closed ? round(this.wins / this.closed) : null,
      exits: this.exits, per_year: Object.fromEntries(Object.entries(this.perYear).map(([year, factor]) => [year, round(factor - 1)])),
      stock_pnl_yuan: Object.fromEntries(Object.entries(this.stockPnl).map(([code, pnl]) => [code, round(pnl / 100, 2)])) };
  }
}

function run(input: Awaited<ReturnType<typeof loadInputs>>, built: ReturnType<typeof buildPoints>, commodityStates: CommodityState[], scenarios: Scenario[], start: string, end: string): Result[] {
  const portfolios = scenarios.map(scenario => new Portfolio(scenario, start, end));
  const commodityByDate = new Map(commodityStates.map(state => [state.executionDate, state]));
  let previous = new Map<string, Point>();
  for (const date of input.dates.filter(value => value >= start && value <= end)) {
    const points = built.pointByDate.get(date) ?? new Map(); const commodity = commodityByDate.get(date) ?? null;
    for (const portfolio of portfolios) portfolio.open(date, points, input.profiles, commodity);
    for (const portfolio of portfolios) portfolio.close(date, points, previous, input.profiles);
    previous = points;
  }
  return portfolios.map(portfolio => portfolio.finish());
}

const baseScenarios: Scenario[] = [
  { key: "A", name: "A_核心满仓等权", entry: "none", exit: "none", commodityOverlay: false },
  { key: "B", name: "B_库存连续仓位", entry: "none", exit: "none", commodityOverlay: true },
  { key: "C1", name: "C1_趋势修复入场", entry: "repair", exit: "none", commodityOverlay: true },
  { key: "C2", name: "C2_趋势突破入场", entry: "breakout", exit: "none", commodityOverlay: true },
];
const pool = getPool(loadConfig().databaseUrl);
try {
  const input = await loadInputs(pool); const built = buildPoints(input); const commodity = buildCommodityStates(input);
  const baseFront = run(input, built, commodity, baseScenarios, START, FRONT_END);
  const cCandidates = baseFront.filter(result => result.key === "C1" || result.key === "C2");
  const selected = [...cCandidates].sort((left, right) => (right.calmar ?? -Infinity) - (left.calmar ?? -Infinity)
    || right.annual_return - left.annual_return)[0]!;
  const entry: EntryModel = selected.key === "C1" ? "repair" : "breakout";
  const chain: Scenario[] = [
    ...baseScenarios,
    { key: "D", name: `D_${selected.name}+初始止损`, entry, exit: "initial", commodityOverlay: true },
    { key: "E", name: `E_${selected.name}+1.5R止盈`, entry, exit: "tier1", commodityOverlay: true },
    { key: "F", name: `F_${selected.name}+3R止盈`, entry, exit: "tier2", commodityOverlay: true },
    { key: "G", name: `G_${selected.name}+ATR移动止损`, entry, exit: "trail", commodityOverlay: true },
    { key: "H", name: `H_${selected.name}+顶部风险收紧`, entry, exit: "top_risk", commodityOverlay: true },
  ];
  const windows = [
    { key: "front", start: START, end: FRONT_END }, { key: "back", start: BACK_START, end: END }, { key: "full", start: START, end: END },
  ];
  const results = Object.fromEntries(windows.map(window => [window.key, run(input, built, commodity, chain, window.start, window.end)])) as Record<string, Result[]>;
  const output = { generated_at: new Date().toISOString(), evidence: "research_only", selected_entry: selected.key,
    assumptions: { commodity_overlay: "50%底仓+50%库存逆百分位，20个百分点缓冲", initial_stop: "max(10日低点,入场-2ATR,入场×90%)",
      tier1: "1.5R卖出1/3并抬止损至成本", tier2: "3R再卖出1/3", trailing: "峰值盈利10%后max(8%,3ATR)", top_risk: "至少2项风险时max(5%,2ATR)" },
    windows, results };
  const file = path.join(OUT_DIR, "结果-2026-09-16.json"); fs.writeFileSync(file, JSON.stringify(output, null, 2));
  console.log(`前窗入场选择：${selected.key} ${selected.name} Calmar=${selected.calmar} 年化=${pct(selected.annual_return)}`);
  for (const window of windows) {
    console.log(`\n${window.key}\t收益\t年化\t回撤\tSharpe\tCalmar\t暴露\t订单`);
    for (const row of results[window.key]!) console.log(`${row.key}\t${pct(row.total_return)}\t${pct(row.annual_return)}\t${pct(row.max_drawdown)}\t${row.sharpe ?? "-"}\t${row.calmar ?? "-"}\t${pct(row.exposure)}\t${row.order_count}`);
  }
  console.log(`\n结果：${file}`);
} finally {
  await closePool();
}
