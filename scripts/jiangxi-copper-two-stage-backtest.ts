// 江西铜业最终T0左侧启动与结构退出回测；所有事实来自PostgreSQL。
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";

const CODE = "600362.SH";
const STOCKS = ["600362.SH", "000630.SZ", "000878.SZ", "000737.SZ"];
const START = "2016-09-12";
const END = "2026-09-11";
const LOAD_START = "2014-01-01";
const INITIAL = 100_000_000;
const LOT = 100;
const OUT = path.resolve("支撑/tmp/江西铜业两阶段结构回测/结果-2026-09-20.json");

type Key = "A" | "T0";
type Bar = { date: string; open: number; close: number };
type PricePoint = { date: string; code: string; close: number };
type Point = { date: string; close: number };
type InventoryPoint = { publishedDate: string; value: number };
type MacroPoint = { date: string; publishedDate: string; value: number };
type Costs = { slip: number; commission: number; tax: number; minFee: number; delay: number };
type Feature = {
  ma60: number | null;
  ma120: number | null;
  low60: number | null;
  low60Index: number | null;
  high252: number | null;
  drawdown252: number | null;
  rebound60: number | null;
  breadthMa60: number | null;
  cuClose: number | null;
  cuMa60: number | null;
  macroOkCount: number;
  macroOk: boolean;
};
type Result = {
  key: string;
  name: string;
  start: string;
  end: string;
  total_return: number;
  annual_return: number;
  max_drawdown: number;
  sharpe: number | null;
  average_exposure: number;
  turnover_yuan: number;
  fees_yuan: number;
  order_count: number;
  trade_count: number;
  setup_count: number;
  confirmation_count: number;
  failed_setup_count: number;
  matched_static_return?: number;
  timing_excess?: number;
  per_year: Record<string, number>;
  event_log: Array<{ date: string; event: string; close: number; macro_ok_count: number; drawdown_252: number | null; rebound_60: number | null; breadth_ma60: number | null }>;
};

const NAMES: Record<Key, string> = {
  A: "A 100%静态持有",
  T0: "T0 左侧启动直接满仓+价格结构退出",
};
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value: number, digits = 4) => Number(value.toFixed(digits));
function ma(values: number[], index: number, window: number) {
  if (index + 1 < window) return null;
  const slice = values.slice(index - window + 1, index + 1);
  return slice.every(Number.isFinite) ? mean(slice) : null;
}
function rollingExtreme(values: number[], index: number, window: number, mode: "min" | "max") {
  if (index + 1 < window) return null;
  let selectedIndex = index - window + 1;
  for (let current = selectedIndex + 1; current <= index; current++) {
    if ((mode === "min" && values[current]! <= values[selectedIndex]!)
      || (mode === "max" && values[current]! >= values[selectedIndex]!)) selectedIndex = current;
  }
  return { value: values[selectedIndex]!, index: selectedIndex };
}
function align(rows: Point[], dates: string[]) {
  let index = -1;
  let last = Number.NaN;
  return dates.map((date) => {
    while (index + 1 < rows.length && rows[index + 1]!.date <= date) {
      index++;
      last = rows[index]!.close;
    }
    return last;
  });
}
function macroSeries(rows: MacroPoint[], dates: string[]) {
  return align(rows.map((row) => ({ date: row.publishedDate, close: row.value })), dates);
}
function monthlyRolling(rows: MacroPoint[], window: number) {
  return rows.map((row, index) => ({
    date: row.date, publishedDate: row.publishedDate,
    value: index + 1 < window ? Number.NaN : mean(rows.slice(index - window + 1, index + 1).map((item) => item.value)),
  }));
}
function monthlyLag(rows: MacroPoint[], periods: number) {
  return rows.map((row, index) => ({ date: row.date, publishedDate: row.publishedDate, value: index < periods ? Number.NaN : rows[index - periods]!.value }));
}
function inventoryState(rows: InventoryPoint[], dates: string[]) {
  let index = -1;
  const values: number[] = [];
  return dates.map((date) => {
    while (index + 1 < rows.length && rows[index + 1]!.publishedDate <= date) {
      index++;
      values.push(rows[index]!.value);
    }
    const current = values.at(-1);
    const change12 = values.length >= 13 && current !== undefined ? current / values[values.length - 13]! - 1 : null;
    const history = values.slice(-156);
    const rank = current !== undefined && history.length ? history.filter((value) => value <= current).length / history.length : null;
    return { change12, rank };
  });
}

async function load(pool: pg.Pool) {
  const bars = (await pool.query<Bar>(
    `SELECT bar.bar_date::text date,bar.open::float8,bar.close::float8
       FROM market_bar bar JOIN market_instrument instrument ON instrument.id=bar.instrument_id
      WHERE instrument.code=$1 AND bar.freq='day' AND bar.adjustment='forward'
        AND bar.bar_date BETWEEN $2 AND $3 AND bar.open>0 AND bar.close>0 ORDER BY bar.bar_date`,
    [CODE, LOAD_START, END],
  )).rows;
  const prices = (await pool.query<PricePoint>(
    `SELECT instrument.code,bar.bar_date::text date,bar.close::float8 close
       FROM market_bar bar JOIN market_instrument instrument ON instrument.id=bar.instrument_id
      WHERE instrument.code=ANY($1::text[]) AND bar.freq='day' AND bar.adjustment='forward'
        AND bar.bar_date BETWEEN $2 AND $3 AND bar.close>0 ORDER BY bar.bar_date,instrument.code`,
    [STOCKS, LOAD_START, END],
  )).rows;
  const cu = (await pool.query<Point>(
    `SELECT bar.bar_date::text date,bar.close::float8 close
       FROM market_bar bar JOIN market_instrument instrument ON instrument.id=bar.instrument_id
      WHERE instrument.code='CU0' AND bar.freq='futures_day' AND bar.bar_date BETWEEN $1 AND $2 ORDER BY bar.bar_date`,
    [LOAD_START, END],
  )).rows;
  const inventory = (await pool.query<InventoryPoint>(
    `SELECT (observation.published_at AT TIME ZONE 'Asia/Shanghai')::date::text "publishedDate",observation.value::float8 value
       FROM market_factor_observation observation JOIN market_factor_series series ON series.id=observation.series_id
      WHERE series.series_code='shfe.cu.inventory.total' AND observation.published_at<($1::date+interval '1 day')
      ORDER BY observation.published_at`, [END],
  )).rows;
  const macro = (await pool.query<{ series_code: string; date: string; publishedDate: string; value: number }>(
    `SELECT DISTINCT ON (series.series_code,observation.period_end) series.series_code,
            to_char(observation.period_end,'YYYY-MM') AS date,
            (observation.published_at AT TIME ZONE 'Asia/Shanghai')::date::text AS "publishedDate",
            observation.value::float8 AS value
       FROM market_factor_observation observation JOIN market_factor_series series ON series.id=observation.series_id
      WHERE series.series_code IN ('oecd.g7.cli','oecd.chn.cli') AND observation.published_at < $1::date + interval '1 day'
      ORDER BY series.series_code,observation.period_end,observation.published_at DESC,observation.revision_no DESC`, [END],
  )).rows;
  for (const code of ['oecd.g7.cli','oecd.chn.cli']) {
    if (macro.filter((row) => row.series_code === code).length < 6) throw new Error(`${code} 缺少月度数据，请先同步铜宏观因子`);
  }
  return { bars, prices, cu, inventory, macro };
}

function buildFeatures(input: Awaited<ReturnType<typeof load>>) {
  const dates = input.bars.map((bar) => bar.date);
  const close = input.bars.map((bar) => bar.close);
  const byCode = new Map(STOCKS.map((code) => [code, input.prices.filter((row) => row.code === code).map(({ date, close: value }) => ({ date, close: value }))]));
  const stockSeries = new Map([...byCode].map(([code, rows]) => [code, align(rows, dates)]));
  const cu = align(input.cu, dates);
  const g7Monthly = input.macro.filter((row) => row.series_code === "oecd.g7.cli");
  const chinaMonthly = input.macro.filter((row) => row.series_code === "oecd.chn.cli");
  const chinaAverageMonthly = monthlyRolling(chinaMonthly, 3);
  const g7 = macroSeries(g7Monthly, dates);
  const g7Old = macroSeries(monthlyLag(g7Monthly, 3), dates);
  const china = macroSeries(chinaAverageMonthly, dates);
  const chinaOld = macroSeries(monthlyLag(chinaAverageMonthly, 3), dates);
  const inventory = inventoryState(input.inventory, dates);
  return dates.map((_, index): Feature => {
    const ma60 = ma(close, index, 60);
    const ma120 = ma(close, index, 120);
    const low = rollingExtreme(close, index, 60, "min");
    const high = rollingExtreme(close, index, 252, "max");
    const cuMa60 = ma(cu, index, 60);
    const breadthValues = [...stockSeries.values()].map((values) => {
      const value = ma(values, index, 60);
      return value === null || !Number.isFinite(values[index]!) ? null : values[index]! > value;
    }).filter((value): value is boolean => value !== null);
    const growth = Number.isFinite(g7[index]!) && (g7[index]! >= 99.5 || (Number.isFinite(g7Old[index]!) && g7[index]! >= g7Old[index]!));
    const demand = Number.isFinite(china[index]!)
      && (china[index]! >= 99 || (Number.isFinite(chinaOld[index]!) && china[index]! >= chinaOld[index]!));
    const supply = inventory[index]!.change12 !== null && inventory[index]!.rank !== null
      && (inventory[index]!.change12! <= 0.25 || inventory[index]!.rank! <= 0.7);
    const macroOkCount = [growth, demand, supply].filter(Boolean).length;
    return {
      ma60,
      ma120,
      low60: low?.value ?? null,
      low60Index: low?.index ?? null,
      high252: high?.value ?? null,
      drawdown252: high ? close[index]! / high.value - 1 : null,
      rebound60: low ? close[index]! / low.value - 1 : null,
      breadthMa60: breadthValues.length ? breadthValues.filter(Boolean).length / breadthValues.length : null,
      cuClose: Number.isFinite(cu[index]!) ? cu[index]! : null,
      cuMa60,
      macroOkCount,
      macroOk: macroOkCount >= 2,
    };
  });
}

function setupSignal(feature: Feature, index: number) {
  return feature.drawdown252 !== null && feature.drawdown252 <= -0.15 && feature.drawdown252 >= -0.4
    && feature.rebound60 !== null && feature.rebound60 >= 0.08 && feature.rebound60 <= 0.15
    && feature.low60Index !== null && index - feature.low60Index <= 30
    && feature.macroOk;
}
class Engine {
  cash = INITIAL;
  shares = 0;
  peak = INITIAL;
  previous = INITIAL;
  maxDrawdown = 0;
  fees = 0;
  turnover = 0;
  orders = 0;
  trades = 0;
  setupCount = 0;
  confirmationCount = 0;
  failedSetupCount = 0;
  exposureSum = 0;
  days = 0;
  dailyReturns: number[] = [];
  years: Record<string, number> = {};
  eventLog: Result["event_log"] = [];
  scheduled = new Map<number, number>();
  stage: "idle" | "waiting" | "confirmed" = "idle";
  setupIndex = -1;
  setupLow = 0;
  usedLowIndex = -1;
  priceBreakDays = 0;
  macroBreakDays = 0;
  cooldownUntil = -1;

  constructor(
    readonly key: Key,
    readonly bars: Bar[],
    readonly features: Feature[],
    readonly costs: Costs,
    readonly start: string,
    readonly end: string,
    readonly constantExposure?: number,
  ) {}

  fee(gross: number, side: "buy" | "sell") {
    return Math.max(this.costs.minFee, Math.round(gross * this.costs.commission / 10000))
      + (side === "sell" ? Math.round(gross * this.costs.tax / 10000) : 0);
  }
  schedule(index: number, exposure: number) {
    const executionIndex = index + 1 + this.costs.delay;
    if (executionIndex < this.bars.length) this.scheduled.set(executionIndex, exposure);
  }
  rebalance(index: number, exposure: number) {
    const price = Math.round(this.bars[index]!.open * 100 * (1 + (exposure > 0 ? 1 : -1) * this.costs.slip / 10000));
    const equity = this.cash + this.shares * price;
    let targetShares = Math.floor(equity * exposure / price / LOT) * LOT;
    if (exposure === 0) targetShares = 0;
    if (targetShares > this.shares) {
      let delta = targetShares - this.shares;
      while (delta >= LOT) {
        const gross = delta * price;
        if (gross + this.fee(gross, "buy") <= this.cash) break;
        delta -= LOT;
      }
      if (delta < LOT) return;
      const gross = delta * price;
      const fee = this.fee(gross, "buy");
      this.cash -= gross + fee;
      this.shares += delta;
      this.fees += fee;
      this.turnover += gross;
      this.orders++;
    } else if (targetShares < this.shares) {
      const delta = this.shares - targetShares;
      const gross = delta * price;
      const fee = this.fee(gross, "sell");
      this.cash += gross - fee;
      this.shares -= delta;
      this.fees += fee;
      this.turnover += gross;
      this.orders++;
      if (targetShares === 0) this.trades++;
    }
  }
  run(): Result {
    const first = this.bars.findIndex((bar) => bar.date >= this.start);
    let last = this.bars.length - 1;
    while (last > first && this.bars[last]!.date > this.end) last--;
    if (this.key === "A" || this.constantExposure !== undefined) this.rebalance(first, this.constantExposure ?? 1);
    for (let index = first; index <= last; index++) {
      const scheduled = this.scheduled.get(index);
      if (scheduled !== undefined) this.rebalance(index, scheduled);
      const bar = this.bars[index]!;
      const feature = this.features[index]!;
      if (this.key !== "A" && this.constantExposure === undefined) {
        const priceBroken = feature.ma60 !== null && feature.cuClose !== null && feature.cuMa60 !== null
          && bar.close < feature.ma60 && feature.cuClose < feature.cuMa60 && (feature.breadthMa60 ?? 1) < 0.5;
        this.priceBreakDays = priceBroken ? this.priceBreakDays + 1 : 0;
        this.macroBreakDays = feature.macroOkCount <= 1 ? this.macroBreakDays + 1 : 0;
        if (this.stage === "confirmed") {
          const exit = this.priceBreakDays >= 10;
          if (exit) {
            this.eventLog.push({ date: bar.date, event: "exit_signal", close: bar.close, macro_ok_count: feature.macroOkCount, drawdown_252: feature.drawdown252, rebound_60: feature.rebound60, breadth_ma60: feature.breadthMa60 });
            this.schedule(index, 0);
            this.stage = "idle";
            this.cooldownUntil = index + 5;
            this.priceBreakDays = 0;
            this.macroBreakDays = 0;
          }
        }
        if (this.stage === "idle" && index > this.cooldownUntil && setupSignal(feature, index)
          && feature.low60Index !== this.usedLowIndex) {
          this.eventLog.push({ date: bar.date, event: "setup", close: bar.close, macro_ok_count: feature.macroOkCount, drawdown_252: feature.drawdown252, rebound_60: feature.rebound60, breadth_ma60: feature.breadthMa60 });
          this.setupCount++;
          this.setupIndex = index;
          this.setupLow = feature.low60!;
          this.usedLowIndex = feature.low60Index!;
          this.stage = "confirmed";
          this.confirmationCount++;
          this.priceBreakDays = 0;
          this.macroBreakDays = 0;
          this.schedule(index, 1);
        }
      }
      const market = this.shares * Math.round(bar.close * 100);
      const equity = this.cash + market;
      this.peak = Math.max(this.peak, equity);
      this.maxDrawdown = Math.max(this.maxDrawdown, (this.peak - equity) / this.peak);
      const dailyReturn = equity / this.previous - 1;
      this.previous = equity;
      this.dailyReturns.push(dailyReturn);
      this.exposureSum += equity > 0 ? market / equity : 0;
      this.days++;
      const year = bar.date.slice(0, 4);
      this.years[year] = (this.years[year] ?? 1) * (1 + dailyReturn);
    }
    const total = this.previous / INITIAL - 1;
    const annual = (1 + total) ** (252 / Math.max(1, this.days)) - 1;
    const average = mean(this.dailyReturns);
    const volatility = Math.sqrt(this.dailyReturns.reduce((sum, value) => sum + (value - average) ** 2, 0)
      / Math.max(1, this.dailyReturns.length - 1) * 252);
    return {
      key: this.key,
      name: this.constantExposure === undefined ? NAMES[this.key] : `matched_${this.key}`,
      start: this.start,
      end: this.end,
      total_return: round(total),
      annual_return: round(annual),
      max_drawdown: round(this.maxDrawdown),
      sharpe: volatility ? round(annual / volatility) : null,
      average_exposure: round(this.exposureSum / Math.max(1, this.days)),
      turnover_yuan: round(this.turnover / 100, 2),
      fees_yuan: round(this.fees / 100, 2),
      order_count: this.orders,
      trade_count: this.trades,
      setup_count: this.setupCount,
      confirmation_count: this.confirmationCount,
      failed_setup_count: this.failedSetupCount,
      per_year: Object.fromEntries(Object.entries(this.years).map(([year, value]) => [year, round(value - 1)])),
      event_log: this.eventLog,
    };
  }
}

const normal: Costs = { slip: 10, commission: 2.5, tax: 10, minFee: 500, delay: 0 };
const stress: Costs = { ...normal, slip: 30, delay: 5 };
const windows = [
  { key: "full", start: START, end: END },
  { key: "front", start: START, end: "2022-12-30" },
  { key: "back", start: "2023-01-03", end: END },
  { key: "2021_2024", start: "2021-01-01", end: "2024-12-31" },
];
const pool = getPool(loadConfig().databaseUrl);
try {
  const input = await load(pool);
  const features = buildFeatures(input);
  const results: Record<string, Result[]> = {};
  for (const window of windows) {
    results[window.key] = (["A", "T0"] as Key[]).map((key) => {
      const result = new Engine(key, input.bars, features, normal, window.start, window.end).run();
      if (key !== "A") {
        const matched = new Engine("A", input.bars, features, normal, window.start, window.end, result.average_exposure).run();
        result.matched_static_return = matched.total_return;
        result.timing_excess = round(result.total_return - matched.total_return);
      }
      return result;
    });
  }
  const runStress = (key: Key, start: string, end: string) => {
    const result = new Engine(key, input.bars, features, stress, start, end).run();
    const matched = new Engine("A", input.bars, features, stress, start, end, result.average_exposure).run();
    result.matched_static_return = matched.total_return;
    result.timing_excess = round(result.total_return - matched.total_return);
    return result;
  };
  const stressResults = Object.fromEntries((["T0"] as Key[]).map((key) => [key, {
    full: runStress(key, START, END),
    back: runStress(key, "2023-01-03", END),
  }]));
  const output = {
    generated_at: new Date().toISOString(),
    rules: {
      setup: "距252日高点回撤15%-40%，较60日低点反弹8%-15%，低点在30个交易日内，宏观3项至少2项正常",
      price_exit: "江西铜业与CU0同时低于MA60且铜股MA60宽度低于50%，连续10个交易日",
    },
    windows,
    results,
    stress: stressResults,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
  for (const [window, rows] of Object.entries(results)) {
    console.log(`\n${window}`);
    for (const row of rows) console.log(`${row.name}\t收益${(row.total_return * 100).toFixed(1)}%\t回撤${(row.max_drawdown * 100).toFixed(1)}%\t暴露${(row.average_exposure * 100).toFixed(1)}%\t同仓位超额${row.timing_excess === undefined ? "—" : `${(row.timing_excess * 100).toFixed(1)}%`}\t设置${row.setup_count}/确认${row.confirmation_count}`);
  }
  console.log(`结果：${OUT}`);
} finally {
  await closePool();
}
