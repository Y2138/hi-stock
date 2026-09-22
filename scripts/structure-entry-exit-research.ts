// 两类量价/趋势入场与退出结构研究。只读 PostgreSQL，不接入生产策略。
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import type pg from "pg";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";

const START = "2020-11-05";
const END = "2026-09-18";
const QUERY_START = "2020-01-01";
const COST_BPS = 10;
const BOARDS = [
  "881105.TI", "881107.TI", "881108.TI", "881112.TI", "881115.TI", "881137.TI", "881148.TI",
  "881168.TI", "881169.TI", "881170.TI", "881180.TI", "881264.TI", "881267.TI",
];
const allMarket = process.argv.includes("--all-market");
const outDir = path.resolve("支撑/tmp/结构入场与退出研究");
fs.mkdirSync(outDir, { recursive: true });

type Signal = "低位波动收缩直接突破" | "趋势缩量回踩再启动";
type Exit = "结构止损40日" | "1R保本40日" | "2R减半3ATR" | "20日低点60日" | "时间止损3ATR";

interface RawSignal {
  stock_id: string;
  code: string;
  board: string;
  signal: Signal;
  signal_date: string;
  rn: number;
  signal_close: number;
  entry_date: string;
  entry_open: number;
  atr20: number;
  stop_anchor: number;
  breakout_level: number;
  volume_ratio20: number;
  pullback_depth: number | null;
}

interface SelectedSignal extends RawSignal {
  id: number;
  initial_stop: number;
  risk: number;
  risk_pct: number;
}

interface PathRow {
  id: number;
  day_no: number;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  atr20: number | null;
  prior_low20: number | null;
}

interface TradeResult {
  id: number;
  signal: Signal;
  exit: Exit;
  signal_date: string;
  exit_date: string;
  holding_days: number;
  return_pct: number;
  realized_r: number;
  mfe_r: number;
  mae_r: number;
  hit_1r: boolean;
  hit_2r: boolean;
  hit_3r: boolean;
  reason: string;
  risk_pct: number;
}

const mean = (values: number[]): number | null => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
const round = (value: number | null, digits = 4): number | null => value === null ? null : Number(value.toFixed(digits));
const pct = (value: number | null): string => value === null ? "-" : `${(value * 100).toFixed(2)}%`;

function dedupe(rows: RawSignal[]): RawSignal[] {
  const result: RawSignal[] = [];
  const last = new Map<string, number>();
  for (const row of [...rows].sort((a, b) => a.signal.localeCompare(b.signal) || a.code.localeCompare(b.code) || a.rn - b.rn)) {
    const key = `${row.signal}|${row.code}`;
    const previous = last.get(key);
    if (previous !== undefined && row.rn - previous < 15) continue;
    last.set(key, row.rn);
    result.push(row);
  }
  return result;
}

async function createFeatures(client: pg.PoolClient): Promise<void> {
  const membership = allMarket
    ? `SELECT instrument.id AS stock_id,instrument.code,'ALL'::text AS board
         FROM market_instrument instrument
        WHERE instrument.kind='stock' AND instrument.code~'^[0-9]{6}[.](SH|SZ)$'
          AND instrument.name!~*'(^|\\*)ST'`
    : `SELECT DISTINCT ON (member.id) member.id AS stock_id,member.code,board.code AS board
         FROM market_board_membership membership
         JOIN market_instrument board ON board.id=membership.board_instrument_id
         JOIN market_instrument member ON member.id=membership.member_instrument_id
        WHERE membership.effective_to IS NULL AND board.code=ANY($3::text[])
          AND member.kind='stock' AND member.code~'^[0-9]{6}[.](SH|SZ)$'
        ORDER BY member.id,board.code`;
  await client.query(
    `CREATE TEMP TABLE entry_exit_features AS
     WITH membership AS (${membership}), base AS (
       SELECT membership.stock_id,membership.code,membership.board,bar.bar_date,
              bar.open::float8,bar.high::float8,bar.low::float8,bar.close::float8,bar.volume::float8,
              indicator.ma20::float8,indicator.ma60::float8,indicator.status,
              row_number() OVER(PARTITION BY membership.stock_id ORDER BY bar.bar_date)::int AS rn
         FROM membership
         JOIN market_bar bar ON bar.instrument_id=membership.stock_id AND bar.freq='day'
          AND bar.bar_date BETWEEN $1 AND $2
         JOIN market_indicator_value indicator ON indicator.instrument_id=bar.instrument_id
          AND indicator.freq=bar.freq AND indicator.bar_date=bar.bar_date AND indicator.bar_time=bar.bar_time
     ), lagged AS (
       SELECT *,lag(close) OVER w::float8 AS previous_close,lag(volume) OVER w::float8 AS previous_volume,
              lag(close,60) OVER w::float8 AS close60,lag(ma20,5) OVER w::float8 AS ma20_5,
              lag(ma60,5) OVER w::float8 AS ma60_5
         FROM base WINDOW w AS(PARTITION BY stock_id ORDER BY rn)
     ), ranged AS (
       SELECT *,greatest(high-low,abs(high-previous_close),abs(low-previous_close))::float8 AS true_range
         FROM lagged
     ), features AS (
       SELECT *,
              max(high) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)::float8 AS high20,
              min(low) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)::float8 AS low20,
              max(high) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 60 PRECEDING AND 1 PRECEDING)::float8 AS high60,
              max(high) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING)::float8 AS high5,
              min(low) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING)::float8 AS low5,
              min(low) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 10 PRECEDING AND 1 PRECEDING)::float8 AS low10,
              min(close/NULLIF(ma20,0)) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 10 PRECEDING AND 1 PRECEDING)::float8 AS min_close_ma20_10,
              min(low/NULLIF(ma20,0)) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 10 PRECEDING AND 1 PRECEDING)::float8 AS min_low_ma20_10,
              avg(volume) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING)::float8 AS volume5,
              avg(volume) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)::float8 AS volume20,
              avg(true_range) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 10 PRECEDING AND 1 PRECEDING)::float8 AS atr10,
              avg(true_range) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)::float8 AS atr20,
              avg(true_range) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 40 PRECEDING AND 1 PRECEDING)::float8 AS atr40
         FROM ranged
     )
     SELECT *,lead(bar_date) OVER w::text AS entry_date,lead(open) OVER w::float8 AS entry_open,
            min(low) OVER(PARTITION BY stock_id ORDER BY rn ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)::float8 AS prior_low20
       FROM features WINDOW w AS(PARTITION BY stock_id ORDER BY rn)`,
    allMarket ? [QUERY_START, END] : [QUERY_START, END, BOARDS],
  );
  await client.query("CREATE INDEX ON entry_exit_features(stock_id,rn)");
  await client.query("ANALYZE entry_exit_features");
}

async function loadSignals(client: pg.PoolClient): Promise<RawSignal[]> {
  const result = await client.query<RawSignal>(
    `WITH direct AS (
       SELECT stock_id::text,code,board,'低位波动收缩直接突破'::text AS signal,bar_date::text AS signal_date,rn,
              close AS signal_close,entry_date,entry_open,atr20,
              greatest(high20-atr20,low5*.99) AS stop_anchor,high20 AS breakout_level,
              volume/NULLIF(volume20,0) AS volume_ratio20,NULL::float8 AS pullback_depth
         FROM entry_exit_features
        WHERE bar_date BETWEEN $1 AND $2 AND status='ready' AND low20>0 AND atr20>0 AND atr40>0
          AND close60>0 AND volume20>0 AND high20/low20-1<=.15 AND atr10/atr40<=.75
          AND ma20>=ma60 AND ma60>=ma60_5*.995 AND close/close60-1 BETWEEN -.20 AND .30
          AND close>high20 AND volume/volume20 BETWEEN 1.2 AND 2.0 AND (close-ma20)/atr20<=2
          AND entry_open>0 AND entry_open/close-1<=.03
     ), restart AS (
       SELECT stock_id::text,code,board,'趋势缩量回踩再启动'::text AS signal,bar_date::text AS signal_date,rn,
              close AS signal_close,entry_date,entry_open,atr20,
              greatest(low10*.99,close-2*atr20) AS stop_anchor,high5 AS breakout_level,
              volume/NULLIF(volume20,0) AS volume_ratio20,low10/NULLIF(high20,0)-1 AS pullback_depth
         FROM entry_exit_features
        WHERE bar_date BETWEEN $1 AND $2 AND status='ready' AND atr20>0 AND high20>0 AND high60>0
          AND close60>0 AND volume20>0 AND volume5>0 AND ma20>ma60 AND ma20>ma20_5
          AND ma60>=ma60_5*.995 AND close/close60-1>0 AND close>=high60*.85
          AND low10/high20-1 BETWEEN -.12 AND -.05 AND min_low_ma20_10<=1.03 AND min_close_ma20_10>=.97
          AND volume5<=volume20*.70 AND close>high5 AND close>open
          AND (volume>previous_volume OR volume>=volume5) AND (close-ma20)/atr20<=2
          AND entry_open>0 AND entry_open/close-1<=.03
     ) SELECT * FROM direct UNION ALL SELECT * FROM restart`,
    [START, END],
  );
  return result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    ["stock_id", "code", "board", "signal", "signal_date", "entry_date"].includes(key) || value === null
      ? value
      : Number(value),
  ])) as unknown as RawSignal);
}

function selectSignals(rows: RawSignal[]): SelectedSignal[] {
  return dedupe(rows).flatMap((row, index) => {
    const initialStop = Math.min(row.entry_open * .99, Math.max(row.stop_anchor, row.entry_open - 2 * row.atr20));
    const risk = row.entry_open - initialStop;
    const riskPct = risk / row.entry_open;
    if (riskPct < .01 || riskPct > .10) return [];
    return [{ ...row, id: index + 1, initial_stop: initialStop, risk, risk_pct: riskPct }];
  });
}

async function createSelectedTable(client: pg.PoolClient, signals: SelectedSignal[]): Promise<void> {
  await client.query(`CREATE TEMP TABLE selected_entry_signals(
    id int PRIMARY KEY,stock_id bigint,entry_rn int,signal text,signal_date date,entry_date date,
    entry_open float8,initial_stop float8,risk float8)`);
  for (let offset = 0; offset < signals.length; offset += 500) {
    const batch = signals.slice(offset, offset + 500);
    const params: unknown[] = [];
    const values = batch.map((row, index) => {
      const base = index * 9;
      params.push(row.id, row.stock_id, row.rn + 1, row.signal, row.signal_date, row.entry_date, row.entry_open, row.initial_stop, row.risk);
      return `(${Array.from({ length: 9 }, (_, column) => `$${base + column + 1}`).join(",")})`;
    });
    await client.query(`INSERT INTO selected_entry_signals VALUES ${values.join(",")}`, params);
  }
}

function stopFill(row: PathRow, stop: number): number | null {
  if (row.open <= stop) return row.open;
  return row.low <= stop ? stop : null;
}

function simulate(signal: SelectedSignal, pathRows: PathRow[], exit: Exit): TradeResult | null {
  if (!pathRows.length) return null;
  let stop = signal.initial_stop;
  let peakHigh = signal.entry_open;
  let highestClose = signal.entry_open;
  let minLow = signal.entry_open;
  let partial = false;
  let proceeds = 0;
  let quantity = 1;
  let exitPrice = pathRows.at(-1)!.close;
  let reason = "数据结束";
  let exitDate = pathRows.at(-1)!.date;
  let holdingDays = pathRows.length;
  const maxDays = exit === "结构止损40日" || exit === "1R保本40日" ? 40 : 60;

  for (const row of pathRows.slice(0, maxDays)) {
    holdingDays = row.day_no;
    peakHigh = Math.max(peakHigh, row.high);
    minLow = Math.min(minLow, row.low);
    const stopped = stopFill(row, stop);
    if (stopped !== null) {
      proceeds += quantity * stopped;
      exitPrice = proceeds;
      exitDate = row.date;
      reason = stop > signal.initial_stop + 1e-9 ? "保护止损" : "初始止损";
      quantity = 0;
      break;
    }

    if (exit === "2R减半3ATR" && !partial && row.high >= signal.entry_open + 2 * signal.risk) {
      proceeds += .5 * (signal.entry_open + 2 * signal.risk);
      quantity = .5;
      partial = true;
    }

    highestClose = Math.max(highestClose, row.close);
    if (exit === "1R保本40日" && peakHigh >= signal.entry_open + signal.risk) stop = Math.max(stop, signal.entry_open);
    if (exit === "2R减半3ATR" && partial && row.atr20) stop = Math.max(stop, highestClose - 3 * row.atr20);
    if (exit === "时间止损3ATR") {
      if (row.day_no >= 10 && peakHigh < signal.entry_open + .5 * signal.risk) {
        proceeds += quantity * row.close;
        exitPrice = proceeds;
        exitDate = row.date;
        reason = "10日未达0.5R";
        quantity = 0;
        break;
      }
      if (peakHigh >= signal.entry_open + 2 * signal.risk && row.atr20) stop = Math.max(stop, highestClose - 3 * row.atr20);
    }
    if (exit === "20日低点60日" && row.day_no >= 10 && row.prior_low20 && row.close < row.prior_low20) {
      proceeds += quantity * row.close;
      exitPrice = proceeds;
      exitDate = row.date;
      reason = "收盘跌破20日低点";
      quantity = 0;
      break;
    }
    if (row.day_no === maxDays) {
      proceeds += quantity * row.close;
      exitPrice = proceeds;
      exitDate = row.date;
      reason = `${maxDays}日到期`;
      quantity = 0;
      break;
    }
  }
  if (quantity > 0) exitPrice = proceeds + quantity * pathRows[Math.min(pathRows.length, maxDays) - 1]!.close;
  const netReturn = exitPrice / signal.entry_open - 1 - COST_BPS / 10_000;
  return {
    id: signal.id,
    signal: signal.signal,
    exit,
    signal_date: signal.signal_date,
    exit_date: exitDate,
    holding_days: holdingDays,
    return_pct: netReturn,
    realized_r: netReturn * signal.entry_open / signal.risk,
    mfe_r: (peakHigh - signal.entry_open) / signal.risk,
    mae_r: (minLow - signal.entry_open) / signal.risk,
    hit_1r: peakHigh >= signal.entry_open + signal.risk,
    hit_2r: peakHigh >= signal.entry_open + 2 * signal.risk,
    hit_3r: peakHigh >= signal.entry_open + 3 * signal.risk,
    reason,
    risk_pct: signal.risk_pct,
  };
}

async function loadPaths(client: pg.PoolClient, ids: number[]): Promise<PathRow[]> {
  const result = await client.query<PathRow>(
    `SELECT selected.id,(feature.rn-selected.entry_rn+1)::int AS day_no,feature.bar_date::text AS date,
            feature.open,feature.high,feature.low,feature.close,feature.atr20,feature.prior_low20
       FROM selected_entry_signals selected
       JOIN entry_exit_features feature ON feature.stock_id=selected.stock_id
        AND feature.rn BETWEEN selected.entry_rn AND selected.entry_rn+59
      WHERE selected.id=ANY($1::int[]) ORDER BY selected.id,feature.rn`,
    [ids],
  );
  return result.rows.map(row => ({ ...row, id: Number(row.id), day_no: Number(row.day_no), open: Number(row.open),
    high: Number(row.high), low: Number(row.low), close: Number(row.close),
    atr20: row.atr20 === null ? null : Number(row.atr20), prior_low20: row.prior_low20 === null ? null : Number(row.prior_low20) }));
}

interface ExitSummary {
  count: number;
  avg_return: number | null;
  median_return: number | null;
  win_rate: number | null;
  avg_r: number | null;
  median_r: number | null;
  payoff_ratio: number | null;
  profit_factor: number | null;
  avg_holding_days: number | null;
  hit_1r: number | null;
  hit_2r: number | null;
  hit_3r: number | null;
  avg_mfe_r: number | null;
  avg_mae_r: number | null;
  reasons: Record<string, number>;
}
function summarize(rows: TradeResult[], extraCostBps = 0): ExitSummary {
  const extraCost = extraCostBps / 10_000;
  const adjusted = rows.map(row => ({
    ...row,
    adjusted_return: row.return_pct - extraCost,
    adjusted_r: row.realized_r - extraCost / row.risk_pct,
  }));
  const wins = adjusted.filter(row => row.adjusted_r > 0).map(row => row.adjusted_r);
  const losses = adjusted.filter(row => row.adjusted_r < 0).map(row => row.adjusted_r);
  const reasons: Record<string, number> = {};
  for (const row of rows) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
  return {
    count: adjusted.length,
    avg_return: round(mean(adjusted.map(row => row.adjusted_return))),
    median_return: round(median(adjusted.map(row => row.adjusted_return))),
    win_rate: round(adjusted.length ? wins.length / adjusted.length : null),
    avg_r: round(mean(adjusted.map(row => row.adjusted_r))),
    median_r: round(median(adjusted.map(row => row.adjusted_r))),
    payoff_ratio: round(mean(wins) !== null && mean(losses) !== null ? mean(wins)! / Math.abs(mean(losses)!) : null),
    profit_factor: round(losses.length ? wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : null),
    avg_holding_days: round(mean(adjusted.map(row => row.holding_days)), 2),
    hit_1r: round(adjusted.length ? adjusted.filter(row => row.hit_1r).length / adjusted.length : null),
    hit_2r: round(adjusted.length ? adjusted.filter(row => row.hit_2r).length / adjusted.length : null),
    hit_3r: round(adjusted.length ? adjusted.filter(row => row.hit_3r).length / adjusted.length : null),
    avg_mfe_r: round(mean(adjusted.map(row => row.mfe_r))),
    avg_mae_r: round(mean(adjusted.map(row => row.mae_r))),
    reasons,
  };
}

async function main(): Promise<void> {
  const pool = getPool(loadConfig().databaseUrl);
  const client = await pool.connect();
  try {
    console.time("特征与信号");
    await createFeatures(client);
    const raw = await loadSignals(client);
    const signals = selectSignals(raw);
    await createSelectedTable(client, signals);
    console.timeEnd("特征与信号");
    const exits: Exit[] = ["结构止损40日", "1R保本40日", "2R减半3ATR", "20日低点60日", "时间止损3ATR"];
    const trades: TradeResult[] = [];
    for (let offset = 0; offset < signals.length; offset += 500) {
      const batch = signals.slice(offset, offset + 500);
      const paths = await loadPaths(client, batch.map(row => row.id));
      const byId = new Map<number, PathRow[]>();
      for (const row of paths) byId.set(row.id, [...(byId.get(row.id) ?? []), row]);
      for (const signal of batch) for (const exit of exits) {
        const trade = simulate(signal, byId.get(signal.id) ?? [], exit);
        if (trade) trades.push(trade);
      }
    }
    const signalNames: Signal[] = ["低位波动收缩直接突破", "趋势缩量回踩再启动"];
    const results = Object.fromEntries(signalNames.map(signal => [signal, {
      signal_count: signals.filter(row => row.signal === signal).length,
      risk_pct_median: round(median(signals.filter(row => row.signal === signal).map(row => row.risk_pct))),
      exits: Object.fromEntries(exits.map(exit => [exit, {
        full: summarize(trades.filter(row => row.signal === signal && row.exit === exit)),
        early: summarize(trades.filter(row => row.signal === signal && row.exit === exit && row.signal_date <= "2022-12-30")),
        late: summarize(trades.filter(row => row.signal === signal && row.exit === exit && row.signal_date >= "2023-01-03")),
        stress30: summarize(trades.filter(row => row.signal === signal && row.exit === exit), 20),
        yearly: Object.fromEntries(["2020", "2021", "2022", "2023", "2024", "2025", "2026"].map(year => [
          year,
          summarize(trades.filter(row => row.signal === signal && row.exit === exit && row.signal_date.startsWith(year))),
        ])),
      }])),
    }]));
    console.log("\n信号\t退出\t样本\t均值\t中位\t胜率\t平均R\t中位R\t盈亏比\t利润因子\t1R\t2R\t3R\t持有日");
    for (const signal of signalNames) for (const exit of exits) {
      const row = results[signal]!.exits[exit]!.full;
      console.log(`${signal}\t${exit}\t${row.count}\t${pct(row.avg_return)}\t${pct(row.median_return)}\t${pct(row.win_rate)}\t${row.avg_r}\t${row.median_r}\t${row.payoff_ratio}\t${row.profit_factor}\t${pct(row.hit_1r)}\t${pct(row.hit_2r)}\t${pct(row.hit_3r)}\t${row.avg_holding_days}`);
    }
    const output = path.join(outDir, `${allMarket ? "全市场" : "周期行业"}-结构入场退出-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.json`);
    fs.writeFileSync(output, JSON.stringify({
      evidence: "research_only",
      range: { start: START, end: END },
      universe: allMarket ? "全市场股票" : "当前13个周期行业成员",
      rules: {
        direct_breakout: "20日箱体≤15%，ATR10/ATR40≤0.75，MA20≥MA60且MA60不明显下降，60日收益-20%至+30%，突破20日高点，突破量为MA20量的1.2至2倍，距MA20≤2ATR",
        trend_restart: "MA20>MA60且二者不转弱，60日收益为正，距60日高点≤15%，前10日回撤5%至12%，靠近MA20且未连续破坏，MA5量≤MA20量70%，突破5日高点再启动",
        entry: "信号后下一可用开盘，缺口≤3%，初始风险1%至10%，双边10bp",
        exits,
      },
      caveats: ["前复权价格", "当前ST名称过滤", "周期行业使用当前成分回看", "日线内止损与止盈同日时按止损先发生", "未模拟涨跌停无法成交"],
      raw_signal_count: raw.length,
      selected_signal_count: signals.length,
      results,
    }, null, 2));
    console.log(`\n结果已写入 ${output}`);
  } finally {
    client.release();
    await closePool();
  }
}
await main();
