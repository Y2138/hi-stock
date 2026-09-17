// 锌价趋势 + SHFE库存 + 核心生产商的最小回测；只读PostgreSQL，不写业务台账。
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import type pg from "pg";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import {
  copperInventoryTargetExposure,
  inventoryInversePercentile,
} from "../server/modules/market/copper-inventory-signal.js";

const START = "2016-09-12";
const END = "2026-09-11";
const INITIAL_CASH_CENTS = 100_000_000;
const LOT = 100;
const args = process.argv.slice(2);
const argOf = (flag: string): string | undefined => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const ZERO_COST = args.includes("--zero-cost");
const COMMISSION_BPS = ZERO_COST ? 0 : 2.5;
const MIN_COMMISSION_CENTS = ZERO_COST ? 0 : 500;
const SELL_TAX_BPS = ZERO_COST ? 0 : 10;
const SLIPPAGE_BPS = ZERO_COST ? 0 : Math.max(0, Number(argOf("--slippage-bps") ?? 10));
const INVENTORY_DELAY_DAYS = Math.max(0, Math.min(20, Number(argOf("--inventory-delay-days") ?? 0)));
const VOLUME_PARTICIPATION = 0.02;
const OUTPUT_DIR = path.resolve("支撑/tmp/锌库存最小回测");
const ZINC_REBALANCE_BAND = 0.20;
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

interface StockBar { date: string; code: string; open: number; close: number; volume: number; meanVolume20: number | null }
interface PricePoint { date: string; close: number }
interface InventoryPoint { periodEnd: string; publishedDate: string; value: number }
interface Profile { code: string; role: string; effectiveFrom: string; effectiveTo: string | null; publishedDate: string }
interface Signal {
  executionDate: string; signalDate: string; inventoryDate: string; inventory4w: number;
  zinc20: number | null; zinc60: number | null; trendPass: boolean; inventoryPass: boolean; inventoryScore: number;
  eligible: string[]; ranked: string[];
}
interface Allocation { codes: string[]; exposure: number }
interface Scenario { key: string; name: string; exposureBand?: number; target(signal: Signal): Allocation }
interface Position { quantity: number; lastClose: number }
interface Result {
  key: string; name: string; start: string; end: string; total_return: number; annual_return: number;
  max_drawdown: number; annual_volatility: number; sharpe_zero_rate: number | null; calmar: number | null;
  exposure: number; fees_yuan: number; turnover_yuan: number; order_count: number;
  rebalance_count: number; invested_rebalances: number; per_year: Record<string, number>;
  selected_counts: Record<string, number>; final_equity_yuan: number;
}

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
function fee(grossCents: number, side: "buy" | "sell"): number {
  const commission = Math.max(MIN_COMMISSION_CENTS, Math.round(grossCents * COMMISSION_BPS / 10_000));
  return commission + (side === "sell" ? Math.round(grossCents * SELL_TAX_BPS / 10_000) : 0);
}
function trailingReturn(points: PricePoint[], date: string, days: number): number | null {
  let index = points.length - 1;
  while (index >= 0 && points[index]!.date > date) index -= 1;
  if (index < days || points[index - days]!.close <= 0) return null;
  return points[index]!.close / points[index - days]!.close - 1;
}
function previousDate(dates: string[], date: string): string | null {
  let left = 0; let right = dates.length;
  while (left < right) { const mid = (left + right) >> 1; if (dates[mid]! < date) left = mid + 1; else right = mid; }
  return left > 0 ? dates[left - 1]! : null;
}
function nextDate(dates: string[], date: string, additionalTradingDays = 0): string | null {
  let left = 0; let right = dates.length;
  while (left < right) { const mid = (left + right) >> 1; if (dates[mid]! <= date) left = mid + 1; else right = mid; }
  return dates[left + additionalTradingDays] ?? null;
}

async function loadInputs(pool: pg.Pool): Promise<{
  dates: string[]; barsByDate: Map<string, Map<string, StockBar>>; seriesByCode: Map<string, PricePoint[]>;
  zinc: PricePoint[]; inventory: InventoryPoint[]; profiles: Profile[];
}> {
  const profiles = (await pool.query<Profile>(
    `SELECT instrument.code,profile.role,profile.effective_from::text AS "effectiveFrom",
            profile.effective_to::text AS "effectiveTo",
            (profile.published_at AT TIME ZONE 'Asia/Shanghai')::date::text AS "publishedDate"
       FROM company_commodity_profile profile
       JOIN market_instrument instrument ON instrument.id=profile.instrument_id
      WHERE profile.commodity_code='ZN' AND profile.role IN ('upstream_producer','integrated')
      ORDER BY instrument.code,profile.published_at`,
  )).rows;
  const codes = [...new Set(profiles.map(row => row.code))];
  if (codes.length < 3) throw new Error("核心锌生产商不足3只");
  const bars = (await pool.query<StockBar>(
    `SELECT instrument.code,bar.bar_date::text AS date,COALESCE(bar.open_raw,bar.open)::float8 AS open,COALESCE(bar.close_raw,bar.close)::float8 AS close,bar.volume::float8,
            avg(bar.volume::float8) OVER (PARTITION BY bar.instrument_id ORDER BY bar.bar_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS "meanVolume20"
       FROM market_bar bar JOIN market_instrument instrument ON instrument.id=bar.instrument_id
      WHERE instrument.code=ANY($1::text[]) AND bar.freq='day' AND bar.adjustment='forward'
        AND bar.bar_date BETWEEN ($2::date - interval '120 days') AND $3::date
        AND COALESCE(bar.open_raw,bar.open)>0 AND COALESCE(bar.close_raw,bar.close)>0 AND bar.volume>0
      ORDER BY instrument.code,bar.bar_date`, [codes, START, END])).rows;
  const dates = (await pool.query<{ date: string }>(
    `SELECT trade_date::text AS date FROM market_trading_day
      WHERE is_open=true AND trade_date BETWEEN $1 AND $2 ORDER BY trade_date`, [START, END])).rows.map(row => row.date);
  const barsByDate = new Map<string, Map<string, StockBar>>();
  const seriesByCode = new Map<string, PricePoint[]>(codes.map(code => [code, []]));
  for (const bar of bars) {
    if (!barsByDate.has(bar.date)) barsByDate.set(bar.date, new Map());
    barsByDate.get(bar.date)!.set(bar.code, bar);
    seriesByCode.get(bar.code)!.push({ date: bar.date, close: bar.close });
  }
  const zinc = (await pool.query<PricePoint>(
    `SELECT bar.bar_date::text AS date,bar.close::float8
       FROM market_bar bar JOIN market_instrument instrument ON instrument.id=bar.instrument_id
      WHERE instrument.code='ZN0' AND bar.freq='futures_day'
        AND bar.bar_date BETWEEN ($1::date - interval '180 days') AND $2::date
      ORDER BY bar.bar_date`, [START, END])).rows;
  const inventory = (await pool.query<InventoryPoint>(
    `SELECT observation.period_end::text AS "periodEnd",
            (observation.published_at AT TIME ZONE 'Asia/Shanghai')::date::text AS "publishedDate",
            observation.value::float8
       FROM market_factor_observation observation
       JOIN market_factor_series series ON series.id=observation.series_id
      WHERE series.series_code='shfe.zn.inventory.total' AND observation.published_at < ($1::date + interval '1 day')
      ORDER BY observation.published_at,observation.period_end`, [END])).rows;
  return { dates, barsByDate, seriesByCode, zinc, inventory, profiles };
}

function buildSignals(input: Awaited<ReturnType<typeof loadInputs>>): Signal[] {
  const signals: Signal[] = [];
  const inventoryChangeHistory: number[] = [];
  for (let index = 4; index < input.inventory.length; index += 1) {
    const current = input.inventory[index]!;
    const prior = input.inventory[index - 4]!;
    if (prior.value <= 0) continue;
    const inventory4w = current.value / prior.value - 1;
    const inventoryScore = inventoryInversePercentile(inventory4w, inventoryChangeHistory);
    inventoryChangeHistory.push(inventory4w);
    if (current.publishedDate < START) continue;
    const executionDate = nextDate(input.dates, current.publishedDate, INVENTORY_DELAY_DAYS);
    if (!executionDate || executionDate < START || executionDate > END || executionDate === signals.at(-1)?.executionDate) continue;
    const signalDate = previousDate(input.dates, executionDate);
    if (!signalDate) continue;
    const zinc20 = trailingReturn(input.zinc, signalDate, 20);
    const zinc60 = trailingReturn(input.zinc, signalDate, 60);
    const eligible = input.profiles.filter(profile => profile.publishedDate <= signalDate && profile.effectiveFrom <= signalDate &&
      (profile.effectiveTo === null || profile.effectiveTo > signalDate) && input.barsByDate.get(executionDate)?.has(profile.code))
      .map(profile => profile.code);
    const ranked = eligible.map(code => ({ code, value: trailingReturn(input.seriesByCode.get(code) ?? [], signalDate, 20) }))
      .filter((row): row is { code: string; value: number } => row.value !== null)
      .sort((left, right) => right.value - left.value || left.code.localeCompare(right.code))
      .map(row => row.code);
    if (eligible.length === 0) continue;
    signals.push({ executionDate, signalDate, inventoryDate: current.periodEnd, inventory4w, zinc20, zinc60,
      trendPass: zinc20 !== null && zinc60 !== null && zinc20 > 0 && zinc60 > 0,
      inventoryPass: inventory4w < 0, inventoryScore,
      eligible: [...new Set(eligible)].sort(), ranked });
  }
  return signals;
}

class Portfolio {
  private cash = INITIAL_CASH_CENTS;
  private positions = new Map<string, Position>();
  private peak = INITIAL_CASH_CENTS;
  private previousEquity = INITIAL_CASH_CENTS;
  private maxDrawdown = 0;
  private exposureSum = 0;
  private days = 0;
  private fees = 0;
  private turnover = 0;
  private orders = 0;
  private rebalances = 0;
  private investedRebalances = 0;
  private perYear: Record<string, number> = {};
  private selectedCounts: Record<string, number> = {};
  private dailyReturns: number[] = [];
  private lastTargetCodes = "";
  private lastTargetExposure = -1;

  constructor(private readonly scenario: Scenario, private readonly start: string, private readonly end: string) {}

  private price(bar: StockBar, side: "buy" | "sell"): number {
    return Math.round(bar.open * 100 * (1 + (side === "buy" ? 1 : -1) * SLIPPAGE_BPS / 10_000));
  }

  private capacity(bar: StockBar): number {
    return Math.floor((bar.meanVolume20 ?? 0) * VOLUME_PARTICIPATION / LOT) * LOT;
  }

  rebalance(signal: Signal, rows: Map<string, StockBar>): void {
    const allocation = this.scenario.target(signal);
    const targets = allocation.codes.filter(code => rows.has(code));
    const targetExposure = Math.max(0, Math.min(1, allocation.exposure));
    for (const code of targets) this.selectedCounts[code] = (this.selectedCounts[code] ?? 0) + 1;
    const targetCodes = [...targets].sort().join(",");
    const exposureChange = Math.abs(targetExposure - this.lastTargetExposure);
    if (targetCodes === this.lastTargetCodes && (exposureChange < 1e-9 || exposureChange < (this.scenario.exposureBand ?? 0))) return;
    this.lastTargetCodes = targetCodes;
    this.lastTargetExposure = targetExposure;
    this.rebalances += 1;
    if (targets.length) this.investedRebalances += 1;
    let equityAtOpen = this.cash;
    for (const [code, position] of this.positions) equityAtOpen += position.quantity * Math.round((rows.get(code)?.open ?? position.lastClose) * 100);
    const targetValue = targets.length ? Math.floor(equityAtOpen * targetExposure / targets.length) : 0;
    const targetSet = new Set(targets);

    for (const [code, position] of [...this.positions]) {
      const row = rows.get(code);
      if (!row) continue;
      const desired = targetSet.has(code) ? Math.floor(targetValue / Math.round(row.open * 100) / LOT) * LOT : 0;
      const quantity = Math.min(Math.max(0, position.quantity - desired), this.capacity(row));
      if (quantity < LOT) continue;
      const gross = quantity * this.price(row, "sell");
      const costs = fee(gross, "sell");
      this.cash += gross - costs;
      this.fees += costs;
      this.turnover += gross;
      this.orders += 1;
      position.quantity -= quantity;
      if (position.quantity === 0) this.positions.delete(code);
    }
    for (const code of targets) {
      const row = rows.get(code)!;
      const current = this.positions.get(code)?.quantity ?? 0;
      const desired = Math.floor(targetValue / Math.round(row.open * 100) / LOT) * LOT;
      let quantity = Math.min(Math.max(0, desired - current), this.capacity(row));
      quantity = Math.floor(quantity / LOT) * LOT;
      const price = this.price(row, "buy");
      while (quantity >= LOT) {
        const gross = quantity * price;
        if (gross + fee(gross, "buy") <= this.cash) break;
        quantity -= LOT;
      }
      if (quantity < LOT) continue;
      const gross = quantity * price;
      const costs = fee(gross, "buy");
      this.cash -= gross + costs;
      this.fees += costs;
      this.turnover += gross;
      this.orders += 1;
      const position = this.positions.get(code) ?? { quantity: 0, lastClose: row.close };
      position.quantity += quantity;
      this.positions.set(code, position);
    }
  }

  mark(date: string, rows: Map<string, StockBar>): void {
    let marketValue = 0;
    for (const [code, position] of this.positions) {
      const close = rows.get(code)?.close ?? position.lastClose;
      position.lastClose = close;
      marketValue += position.quantity * Math.round(close * 100);
    }
    const equity = this.cash + marketValue;
    this.peak = Math.max(this.peak, equity);
    this.maxDrawdown = Math.max(this.maxDrawdown, (this.peak - equity) / this.peak);
    this.exposureSum += equity > 0 ? marketValue / equity : 0;
    const year = date.slice(0, 4);
    const dailyReturn = this.previousEquity > 0 ? equity / this.previousEquity - 1 : 0;
    this.perYear[year] = (this.perYear[year] ?? 1) * (1 + dailyReturn);
    this.dailyReturns.push(dailyReturn);
    this.previousEquity = equity;
    this.days += 1;
  }

  finish(): Result {
    const totalReturn = this.previousEquity / INITIAL_CASH_CENTS - 1;
    const annualReturn = Math.pow(1 + totalReturn, 252 / Math.max(1, this.days)) - 1;
    const mean = this.dailyReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, this.dailyReturns.length);
    const variance = this.dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, this.dailyReturns.length - 1);
    const annualVolatility = Math.sqrt(variance * 252);
    return { key: this.scenario.key, name: this.scenario.name, start: this.start, end: this.end,
      total_return: round(totalReturn), annual_return: round(annualReturn),
      max_drawdown: round(this.maxDrawdown), annual_volatility: round(annualVolatility),
      sharpe_zero_rate: annualVolatility > 0 ? round(annualReturn / annualVolatility) : null,
      calmar: this.maxDrawdown > 0 ? round(annualReturn / this.maxDrawdown) : null,
      exposure: round(this.exposureSum / Math.max(1, this.days)),
      fees_yuan: round(this.fees / 100, 2), turnover_yuan: round(this.turnover / 100, 2), order_count: this.orders,
      rebalance_count: this.rebalances, invested_rebalances: this.investedRebalances,
      per_year: Object.fromEntries(Object.entries(this.perYear).map(([year, factor]) => [year, round(factor - 1)])),
      selected_counts: this.selectedCounts, final_equity_yuan: round(this.previousEquity / 100, 2) };
  }
}

const scenarios: Scenario[] = [
  { key: "A", name: "基线A_核心生产商等权", target: signal => ({ codes: signal.eligible, exposure: 1 }) },
  { key: "B", name: "基线B_股票相对强度", target: signal => ({ codes: signal.ranked.slice(0, 2), exposure: 1 }) },
  { key: "C", name: "基线C_锌价趋势加相对强度", target: signal => ({ codes: signal.trendPass ? signal.ranked.slice(0, 2) : [], exposure: 1 }) },
  { key: "D", name: "实验D_锌价趋势库存下降加相对强度", target: signal => ({ codes: signal.trendPass && signal.inventoryPass ? signal.ranked.slice(0, 2) : [], exposure: 1 }) },
  { key: "E", name: "消融E_锌价趋势加核心等权", target: signal => ({ codes: signal.trendPass ? signal.eligible : [], exposure: 1 }) },
  { key: "F", name: "消融F_锌价趋势库存下降加核心等权", target: signal => ({ codes: signal.trendPass && signal.inventoryPass ? signal.eligible : [], exposure: 1 }) },
  { key: "G", name: "连续G_库存分位仓位加核心等权", target: signal => ({ codes: signal.eligible, exposure: signal.inventoryScore }) },
  { key: "H", name: "连续H_半仓底仓加库存分位加核心等权", target: signal => ({ codes: signal.eligible, exposure: copperInventoryTargetExposure(signal.inventoryScore) }) },
  { key: "I", name: "连续I_库存分位10个百分点缓冲", exposureBand: 0.10, target: signal => ({ codes: signal.eligible, exposure: signal.inventoryScore }) },
  { key: "J", name: "连续J_半仓底仓加库存分位10个百分点缓冲", exposureBand: 0.10, target: signal => ({ codes: signal.eligible, exposure: copperInventoryTargetExposure(signal.inventoryScore) }) },
  { key: "K", name: "连续K_半仓底仓加库存分位20个百分点缓冲", exposureBand: ZINC_REBALANCE_BAND, target: signal => ({ codes: signal.eligible, exposure: copperInventoryTargetExposure(signal.inventoryScore) }) },
];

function runWindow(input: Awaited<ReturnType<typeof loadInputs>>, signals: Signal[], start: string, end: string): Result[] {
  const portfolios = scenarios.map(scenario => new Portfolio(scenario, start, end));
  const signalByDate = new Map(signals.filter(signal => signal.executionDate >= start && signal.executionDate <= end)
    .map(signal => [signal.executionDate, signal]));
  for (const date of input.dates.filter(value => value >= start && value <= end)) {
    const rows = input.barsByDate.get(date) ?? new Map();
    const signal = signalByDate.get(date);
    if (signal) for (const portfolio of portfolios) portfolio.rebalance(signal, rows);
    for (const portfolio of portfolios) portfolio.mark(date, rows);
  }
  return portfolios.map(portfolio => portfolio.finish());
}

function simpleReturn(points: PricePoint[], start: string, end: string): number | null {
  const first = points.find(point => point.date >= start);
  const last = [...points].reverse().find(point => point.date <= end);
  return first && last && first.close > 0 ? round(last.close / first.close - 1) : null;
}

const pool = getPool(loadConfig().databaseUrl);
try {
  const input = await loadInputs(pool);
  const signals = buildSignals(input);
  const windows = [
    { key: "full", start: START, end: END },
    { key: "front", start: START, end: "2022-12-30" },
    { key: "back", start: "2023-01-03", end: END },
  ];
  const results = Object.fromEntries(windows.map(window => [window.key, runWindow(input, signals, window.start, window.end)])) as Record<string, Result[]>;
  const diagnostics = {
    signal_count: signals.length,
    trend_pass_count: signals.filter(signal => signal.trendPass).length,
    inventory_pass_count: signals.filter(signal => signal.inventoryPass).length,
    combined_pass_count: signals.filter(signal => signal.trendPass && signal.inventoryPass).length,
    first_signal: signals[0] ?? null,
    last_signal: signals.at(-1) ?? null,
    zinc_return: simpleReturn(input.zinc, START, END),
    stock_codes: [...new Set(input.profiles.map(profile => profile.code))],
  };
  const output = { generated_at: new Date().toISOString(), assumptions: {
    initial_cash_yuan: INITIAL_CASH_CENTS / 100, lot: LOT, commission_bps: COMMISSION_BPS,
    minimum_commission_yuan: MIN_COMMISSION_CENTS / 100, sell_tax_bps: SELL_TAX_BPS,
    slippage_bps_each_side: SLIPPAGE_BPS, volume_participation: VOLUME_PARTICIPATION,
    inventory_rule: "硬门禁使用当前周库存较四个观测前下降；连续规则使用4周变化在历史已知样本中的逆百分位",
    copper_rule: "CU0的20日和60日收益均为正",
    stock_rule: "核心生产商20日收益排序前2；连续规则取消排名并保持核心生产商等权",
    continuous_candidate: "50%底仓 + 50%库存逆百分位；目标仓位变化不足20个百分点不调仓",
    execution: "库存可得后的下一A股交易日开盘调仓",
    inventory_additional_delay_days: INVENTORY_DELAY_DAYS,
    price_mode: "股票使用库内原始价格，不含现金分红；期货只作外生信号",
  }, diagnostics, windows, results };
  const suffix = ZERO_COST ? "零成本" : INVENTORY_DELAY_DAYS || SLIPPAGE_BPS !== 10
    ? `压力-${SLIPPAGE_BPS}bp-${INVENTORY_DELAY_DAYS}日延迟` : "";
  const outputPath = path.join(OUTPUT_DIR, `结果${suffix ? `-${suffix}` : ""}-2026-09-16.json`);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log("组合\t全窗收益\t年化\t最大回撤\t暴露\t订单\t费用");
  for (const result of results.full!) console.log(`${result.name}\t${pct(result.total_return)}\t${pct(result.annual_return)}\t${pct(result.max_drawdown)}\t${pct(result.exposure)}\t${result.order_count}\t${result.fees_yuan}`);
  console.log("\n后窗（2023-2026）");
  for (const result of results.back!) console.log(`${result.name}\t${pct(result.total_return)}\t${pct(result.annual_return)}\t${pct(result.max_drawdown)}\t${pct(result.exposure)}`);
  console.log(`\n信号=${diagnostics.signal_count} 趋势通过=${diagnostics.trend_pass_count} 库存下降=${diagnostics.inventory_pass_count} 组合通过=${diagnostics.combined_pass_count}`);
  console.log(`结果：${outputPath}`);
} finally {
  await closePool();
}
