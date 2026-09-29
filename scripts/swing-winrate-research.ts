// 独立事件研究：波段四条件信号的历史胜率/赔率评估原型。
// 只读 PostgreSQL，不接入生产规则、不改任何系统代码；结果写到 支撑/tmp/波段胜率研究/。
// 与线上口径的已知差异（原型可接受，报告已注明）：
//   1. 扫描范围用“当前”行业成分与流动性代表（上线 388 只口径），未按历史逐日重建成分；
//   2. RSI14/ATR14 为脚本内 Wilder 计算，与线上指标表可能有微小数值差；
//   3. 股性护盘收回率历史上不可得，固定按 0.5 档（止损=买入价×0.90 分支）；
//   4. 退出规则实现策略文档主体（观察期灾难止损、箱顶减半、浮盈阶梯、突破后 ATR 追踪、
//      60 日时间退出），100 股取整与日内微观路径用日线近似；
//   5. 交易成本按单边 10bp 计入入场与每次出场。
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import type pg from "pg";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import {
  evaluateSwingSignal,
  SWING_INDUSTRY_CODES,
  SWING_UNIVERSE_MAX_MEMBERS,
  SWING_SUBINDUSTRY_REPRESENTATIVE_LIMIT,
  type SwingSignalBar,
} from "../server/modules/plans/swing-signals.js";

const argValue = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
};
const SINCE = argValue("since", "2020-01-01");
const UNTIL = argValue("until", "");
const DEFENSE = Number(argValue("defense", "0.5"));
const UNIVERSE_LIMIT = Number(argValue("limit", String(SWING_UNIVERSE_MAX_MEMBERS)));
const COST = 0.001; // 单边 10bp
const WARMUP_DAYS = 520; // 日历日回看，保证 2020 年初即有 MA250 与行业动量

const outDir = path.resolve("支撑/tmp/波段胜率研究");
fs.mkdirSync(outDir, { recursive: true });

interface Bar extends SwingSignalBar {
  turnover: number | null;
}
interface UniverseMember {
  code: string;
  name: string;
  industry_code: string;
}
interface TradeRecord {
  code: string;
  name: string;
  signal_date: string;
  entry_date: string;
  entry_price: number;
  risk_unit: number;
  exit_date: string;
  exit_reason: string;
  holding_days: number;
  realized_r: number;
  win: boolean;
  partial_taken: boolean;
  breakout_confirmed: boolean;
  rsi14: number;
  expected_rr: number;
  cluster_size: number;
  regime: string;
  features: SignalFeatures;
  entry_premium: number;
  industry_mom20: number | null;
}
type SkipReason = "no_breakout" | "open_above_cap";

const mean = (values: number[]): number | null =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
const pct = (value: number | null): string => value === null ? "-" : `${(value * 100).toFixed(1)}%`;
const num = (value: number | null, digits = 2): string => value === null ? "-" : value.toFixed(digits);

/** Wilder RSI14 整段增量计算：rsi[i] 为截至第 i 根的值 */
function wilderRsiSeries(closes: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = closes[i]! - closes[i - 1]!;
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const delta = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Wilder ATR14 整段增量计算 */
function wilderAtrSeries(bars: Array<{ high: number; low: number; close: number }>, period = 14): Array<number | null> {
  const out: Array<number | null> = new Array(bars.length).fill(null);
  if (bars.length < period + 1) return out;
  const tr = (i: number) => Math.max(
    bars[i]!.high - bars[i]!.low,
    Math.abs(bars[i]!.high - bars[i - 1]!.close),
    Math.abs(bars[i]!.low - bars[i - 1]!.close),
  );
  let atr = 0;
  for (let i = 1; i <= period; i += 1) atr += tr(i);
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < bars.length; i += 1) {
    atr = (atr * (period - 1) + tr(i)) / period;
    out[i] = atr;
  }
  return out;
}

function sma(values: number[], count: number): number | null {
  if (values.length < count) return null;
  const slice = values.slice(-count);
  return slice.reduce((sum, value) => sum + value, 0) / count;
}

async function loadUniverse(pool: pg.Pool, until: string): Promise<UniverseMember[]> {
  const result = await pool.query<UniverseMember>(
    `WITH primary_members AS (
       SELECT DISTINCT ON (stock.id) stock.id AS instrument_id, stock.code, stock.name,
              industry.code AS industry_code,
              COALESCE(secondary.code, industry.code) AS subindustry_code
         FROM market_board_membership relation
         JOIN market_board board ON board.instrument_id = relation.board_instrument_id
         JOIN market_instrument industry ON industry.id = relation.board_instrument_id
         JOIN market_instrument stock ON stock.id = relation.member_instrument_id
         LEFT JOIN LATERAL (
           SELECT child.code
             FROM market_board_membership child_relation
             JOIN market_board child_board ON child_board.instrument_id = child_relation.board_instrument_id
             JOIN market_instrument child ON child.id = child_board.instrument_id
            WHERE child_relation.member_instrument_id = stock.id AND child.code LIKE '884%.TI'
              AND child_board.active = true AND child_board.source = 'hithink'
              AND child_board.board_type = 'industry' AND child_relation.effective_to IS NULL
            ORDER BY child.code LIMIT 1
         ) secondary ON true
        WHERE industry.code = ANY($1::text[]) AND board.active = true
          AND board.source = 'hithink' AND board.board_type = 'industry'
          AND relation.effective_to IS NULL
          AND stock.kind = 'stock' AND stock.lifecycle_status = 'active'
          AND stock.name !~* '^\\*?ST' AND stock.code ~ '^(600|601|603|605|000|001|002|003)'
     ), liquidity AS (
       SELECT member.*,
              (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY bar.turnover::float8)
                 FROM (SELECT b.turnover FROM market_bar b
                        WHERE b.instrument_id = member.instrument_id AND b.freq = 'day'
                          AND b.turnover > 0 AND b.bar_date <= $2::date
                        ORDER BY b.bar_date DESC LIMIT 60) bar) AS median_turnover_60,
              (SELECT count(*) FROM market_bar b
                WHERE b.instrument_id = member.instrument_id AND b.freq = 'day'
                  AND b.bar_date <= $2::date) AS bar_count
         FROM primary_members member
     ), ranked AS (
       SELECT liquidity.*, row_number() OVER (PARTITION BY industry_code, subindustry_code
                ORDER BY median_turnover_60 DESC NULLS LAST, code) AS subindustry_rank
         FROM liquidity WHERE bar_count >= 120
     ), discovery AS (
       SELECT code FROM ranked
        ORDER BY (subindustry_rank <= $3) DESC, median_turnover_60 DESC NULLS LAST, code
        LIMIT $4
     )
     SELECT code, name, industry_code FROM ranked WHERE code IN (SELECT code FROM discovery)
      ORDER BY code`,
    [[...SWING_INDUSTRY_CODES], until, SWING_SUBINDUSTRY_REPRESENTATIVE_LIMIT, UNIVERSE_LIMIT],
  );
  return result.rows;
}

interface SignalFeatures {
  volume_ratio: number;
  shadow_type: "阳线" | "下影假阴";
  box_height: number;
  ret60: number | null;
  ma250_dev: number | null;
  atr_pct: number | null;
  industry_code: string;
}
interface SignalEvidence {
  code: string;
  name: string;
  date: string;
  evidence: NonNullable<ReturnType<typeof evaluateSwingSignal>>["evidence"];
  features: SignalFeatures;
}

/** 按策略文档主体模拟一笔确认后的波段交易；skip 说明 T+1 未成交的原因。 */
function simulateTrade(
  bars: Bar[],
  atrAt: (index: number) => number | null,
  signalIndex: number,
  fact: SignalEvidence,
): { trade: Omit<TradeRecord, "cluster_size" | "regime" | "features" | "industry_mom20"> } | { skip: SkipReason } | null {
  const evidence = fact.evidence;
  const entryIndex = signalIndex + 1;
  const entryBar = bars[entryIndex];
  if (!entryBar) return null;
  const cap = evidence.confirmation_price_cap;
  const mustExceed = evidence.confirmation_must_exceed;
  if (entryBar.open > cap) return { skip: "open_above_cap" };
  if (entryBar.high <= mustExceed) return { skip: "no_breakout" };
  const entry = Math.max(entryBar.open, mustExceed);
  const riskUnit = entry - evidence.initial_stop;
  if (riskUnit <= 0) return null;

  let stop = entry * 0.75; // 观察期（前 10 个交易日）灾难止损
  let partialTaken = false;
  let partialProceeds = 0;
  let breakoutDay: number | null = null;
  let highestClose = entryBar.close;
  const closes: number[] = [];
  const volumes: number[] = [];
  for (let i = entryIndex; i < Math.min(bars.length, entryIndex + 400); i += 1) {
    const bar = bars[i]!;
    const holding = i - entryIndex;
    // 第 11 个交易日起恢复初始止损，此后只上移
    if (holding === 10) stop = Math.max(stop, evidence.initial_stop);
    // 1) 止损优先：跳空低开按开盘价，否则按止损价
    if (bar.open <= stop || bar.low <= stop) {
      const fill = bar.open <= stop ? bar.open : stop;
      const reason = stop > evidence.initial_stop * 1.001
        ? (breakoutDay !== null ? "突破后追踪止损" : "浮盈阶梯止损")
        : holding <= 10 ? "观察期灾难止损" : "初始止损";
      return { trade: finish(i, fill, holding, reason) };
    }
    // 2) 箱顶×0.95 减仓一半（跳空高开按开盘价成交）
    if (!partialTaken && bar.high >= evidence.target_price) {
      const fill = bar.open >= evidence.target_price ? bar.open : evidence.target_price;
      partialTaken = true;
      partialProceeds = 0.5 * fill * (1 - COST);
    }
    closes.push(bar.close);
    volumes.push(bar.volume ?? 0);
    highestClose = Math.max(highestClose, bar.close);
    const profit = bar.close / entry - 1;
    if (partialTaken) {
      if (profit >= 0.15) stop = Math.max(stop, entry * 1.05);
      else if (profit >= 0.08) stop = Math.max(stop, entry);
      const ma20 = sma(closes, 20);
      if (profit > 0.05 && ma20 !== null) stop = Math.max(stop, ma20 * 0.98);
    }
    // 3) 突破认定：收盘过箱顶且量能放大；缓冲 3 个交易日后启用 ATR 追踪
    const volMa20 = sma(volumes, 20);
    if (breakoutDay === null && bar.close > evidence.box_top_40d
        && volMa20 !== null && volMa20 > 0 && (bar.volume ?? 0) > volMa20 * 1.2) {
      breakoutDay = holding;
    }
    if (breakoutDay !== null && holding - breakoutDay >= 3) {
      const atr = atrAt(i);
      const ma10 = sma(closes, 10);
      if (atr !== null) stop = Math.max(stop, highestClose - 2.8 * atr);
      if (ma10 !== null) stop = Math.max(stop, ma10 * 0.98);
    }
    // 4) 未形成有效突破：持有满 60 个交易日后次日开盘退出
    if (breakoutDay === null && holding >= 60) {
      const next = bars[i + 1];
      const fill = next ? next.open : bar.close;
      return { trade: finish(next ? i + 1 : i, fill, holding + 1, "60日时间退出") };
    }
  }
  const last = bars[Math.min(bars.length, entryIndex + 400) - 1]!;
  return { trade: finish(bars.length - 1, last.close, 400, "数据终点强平") };

  function finish(exitIndex: number, fill: number, holdingDays: number, reason: string): Omit<TradeRecord, "cluster_size" | "regime" | "features" | "industry_mom20"> {
    const proceeds = partialTaken
      ? partialProceeds + 0.5 * fill * (1 - COST)
      : fill * (1 - COST);
    const realizedR = (proceeds - entry * (1 + COST)) / riskUnit;
    return {
      code: fact.code,
      name: fact.name.replace(/,/g, "、"),
      signal_date: bars[signalIndex]!.bar_date,
      entry_date: bars[entryIndex]!.bar_date,
      entry_price: Number(entry.toFixed(3)),
      risk_unit: Number(riskUnit.toFixed(3)),
      exit_date: bars[exitIndex]!.bar_date,
      exit_reason: reason,
      holding_days: holdingDays,
      realized_r: Number(realizedR.toFixed(4)),
      win: realizedR > 0,
      partial_taken: partialTaken,
      breakout_confirmed: breakoutDay !== null,
      rsi14: evidence.rsi14,
      expected_rr: evidence.expected_reward_risk ?? 0,
      entry_premium: Number((entry / evidence.close - 1).toFixed(4)),
    };
  }
}

interface GroupStat {
  count: number;
  winRate: number;
  avgR: number | null;
  medianR: number | null;
  avgHold: number | null;
}

function groupStat(records: TradeRecord[]): GroupStat {
  const rs = records.map((record) => record.realized_r);
  return {
    count: records.length,
    winRate: records.length ? records.filter((record) => record.win).length / records.length : 0,
    avgR: mean(rs),
    medianR: median(rs),
    avgHold: mean(records.map((record) => record.holding_days)),
  };
}

function renderTable(title: string, rows: Array<[string, GroupStat]>): string {
  return [
    `### ${title}`,
    "",
    "| 分层 | 笔数 | 胜率 | 平均R | 中位R | 平均持有日 |",
    "|------|------|------|-------|-------|-----------|",
    ...rows.map(([label, stat]) =>
      `| ${label} | ${stat.count} | ${pct(stat.winRate)} | ${num(stat.avgR)} | ${num(stat.medianR)} | ${num(stat.avgHold, 1)} |`),
  ].join("\n");
}

async function main(): Promise<void> {
  const pool = getPool(loadConfig().databaseUrl);
  try {
    const untilRow = await pool.query<{ max: string }>(
      `SELECT max(bar.bar_date)::text AS max FROM market_bar bar
        JOIN market_instrument i ON i.id = bar.instrument_id
       WHERE i.code = '000300.SH' AND bar.freq = 'day'`,
    );
    const until = UNTIL || untilRow.rows[0]!.max;
    const universe = await loadUniverse(pool, until);
    console.log(`扫描范围 ${universe.length} 只（上限 ${UNIVERSE_LIMIT}），窗口 ${SINCE} → ${until}，护盘档位 ${DEFENSE}`);

    const indexBars = await pool.query<{ bar_date: string; close: number }>(
      `SELECT bar.bar_date::text, bar.close::float8 FROM market_bar bar
        JOIN market_instrument i ON i.id = bar.instrument_id
       WHERE i.code = '000300.SH' AND bar.freq = 'day' AND bar.bar_date >= $1 ORDER BY bar.bar_date`,
      [new Date(Date.parse(`${SINCE}T00:00:00Z`) - WARMUP_DAYS * 86400000).toISOString().slice(0, 10)],
    );
    const indexCloses = indexBars.rows.map((row) => row.close);
    const regimeOf = (date: string): string => {
      const position = indexBars.rows.findIndex((row) => row.bar_date === date);
      if (position < 59) return "未知";
      const close = indexCloses[position]!;
      const ma20 = sma(indexCloses.slice(position - 19, position + 1), 20);
      const ma60 = sma(indexCloses.slice(position - 59, position + 1), 60);
      if (ma20 !== null && close >= ma20) return "指数在MA20上方";
      if (ma60 !== null && close >= ma60) return "MA20与MA60之间";
      return "指数跌破MA60";
    };

    // 16 个一级行业指数的 20 日动量：信号日按所属行业取值
    const industryMomentum = new Map<string, number>();
    {
      const boards = await pool.query<{ code: string; bar_date: string; close: number }>(
        `SELECT i.code, bar.bar_date::text, bar.close::float8
           FROM market_bar bar JOIN market_instrument i ON i.id = bar.instrument_id
          WHERE i.code = ANY($1::text[]) AND bar.freq = 'day' AND bar.bar_date >= $2
          ORDER BY i.code, bar.bar_date`,
        [[...SWING_INDUSTRY_CODES], new Date(Date.parse(`${SINCE}T00:00:00Z`) - WARMUP_DAYS * 86400000).toISOString().slice(0, 10)],
      );
      const byBoard = new Map<string, Array<{ date: string; close: number }>>();
      for (const row of boards.rows) {
        const list = byBoard.get(row.code) ?? [];
        list.push({ date: row.bar_date, close: row.close });
        byBoard.set(row.code, list);
      }
      for (const [code, list] of byBoard) {
        for (let i = 20; i < list.length; i += 1) {
          if (list[i]!.date >= SINCE) industryMomentum.set(`${code}:${list[i]!.date}`, list[i]!.close / list[i - 20]!.close - 1);
        }
      }
    }

    const barsSince = new Date(Date.parse(`${SINCE}T00:00:00Z`) - WARMUP_DAYS * 86400000).toISOString().slice(0, 10);
    const barsCache = new Map<string, Bar[]>();
    const facts: SignalEvidence[] = [];
    const factsBySignalDate = new Map<string, number>();
    for (const member of universe) {
      const bars = (await pool.query(
        `SELECT bar.bar_date::text, bar.open::float8, bar.high::float8, bar.low::float8, bar.close::float8,
                bar.volume::float8, bar.turnover::float8
           FROM market_bar bar JOIN market_instrument i ON i.id = bar.instrument_id
          WHERE i.code = $1 AND bar.freq = 'day' AND bar.bar_date >= $2 AND bar.bar_date <= $3
          ORDER BY bar.bar_date`,
        [member.code, barsSince, until],
      )).rows as Bar[];
      barsCache.set(member.code, bars);
      if (bars.length < 120) continue;
      const closes = bars.map((bar) => bar.close);
      const rsiSeries = wilderRsiSeries(closes);
      const atrSeries = wilderAtrSeries(bars);
      for (let i = 40; i < bars.length - 1; i += 1) {
        const bar = bars[i]!;
        if (bar.bar_date < SINCE) continue;
        const rsi = rsiSeries[i];
        if (rsi == null) continue;
        const rows: SwingSignalBar[] = bars.slice(i - 39, i + 1).map((item, index) => ({
          bar_date: item.bar_date,
          open: item.open,
          high: item.high,
          low: item.low,
          close: item.close,
          volume: item.volume,
          rsi14: index === 39 ? rsi : 0, // 评估器只校验最后一行的 RSI
          indicator_status: "ready",
        }));
        const evaluation = evaluateSwingSignal(rows, "stock", DEFENSE);
        if (!evaluation?.price_signal || !evaluation.evidence.confirmation_window_available) continue;
        const ma250 = i >= 249 ? sma(closes.slice(i - 249, i + 1), 250) : null;
        facts.push({
          code: member.code,
          name: member.name,
          date: bar.bar_date,
          evidence: evaluation.evidence,
          features: {
            volume_ratio: evaluation.evidence.volume_ratio_5,
            shadow_type: bar.close > bar.open ? "阳线" : "下影假阴",
            box_height: (evaluation.evidence.box_top_40d - evaluation.evidence.box_floor_20d) / evaluation.evidence.close,
            ret60: i >= 60 ? bar.close / closes[i - 60]! - 1 : null,
            ma250_dev: ma250 !== null && ma250 > 0 ? bar.close / ma250 - 1 : null,
            atr_pct: atrSeries[i] != null ? atrSeries[i]! / bar.close : null,
            industry_code: member.industry_code,
          },
        });
        factsBySignalDate.set(bar.bar_date, (factsBySignalDate.get(bar.bar_date) ?? 0) + 1);
      }
    }
    console.log(`T 日正式信号 ${facts.length} 条，覆盖 ${factsBySignalDate.size} 个交易日`);

    const trades: TradeRecord[] = [];
    const skipCount = { no_breakout: 0, open_above_cap: 0 };
    for (const fact of facts) {
      const bars = barsCache.get(fact.code)!;
      const atrSeries = wilderAtrSeries(bars);
      const signalIndex = bars.findIndex((bar) => bar.bar_date === fact.date);
      if (signalIndex < 0) continue;
      const outcome = simulateTrade(bars, (i) => atrSeries[i] ?? null, signalIndex, fact);
      if (!outcome) continue;
      if ("skip" in outcome) {
        skipCount[outcome.skip] += 1;
        continue;
      }
      trades.push({
        ...outcome.trade,
        cluster_size: factsBySignalDate.get(fact.date) ?? 1,
        regime: regimeOf(fact.date),
        features: fact.features,
        industry_mom20: industryMomentum.get(`${fact.features.industry_code}:${fact.date}`) ?? null,
      });
    }
    console.log(`T+1 确认成交 ${trades.length} 笔；放弃 ${skipCount.no_breakout + skipCount.open_above_cap} 条（未突破 ${skipCount.no_breakout}、开盘超上限 ${skipCount.open_above_cap}）`);

    const overall = groupStat(trades);
    const stratify = (label: string, predicate: (trade: TradeRecord) => boolean): [string, TradeRecord[]] =>
      [label, trades.filter(predicate)];
    const byCluster = [
      stratify("簇发≥10只/日", (t) => t.cluster_size >= 10),
      stratify("中频3-9只/日", (t) => t.cluster_size >= 3 && t.cluster_size < 10),
      stratify("孤立1-2只/日", (t) => t.cluster_size < 3),
    ];
    const byRegime = ["指数在MA20上方", "MA20与MA60之间", "指数跌破MA60", "未知"]
      .map((label) => stratify(label, (t) => t.regime === label));
    const byRsi = [
      stratify("RSI14 < 25", (t) => t.rsi14 < 25),
      stratify("RSI14 25–32", (t) => t.rsi14 >= 25 && t.rsi14 < 32),
      stratify("RSI14 32–40", (t) => t.rsi14 >= 32),
    ];
    const byRr = [
      stratify("事前盈亏比 1.8–2.2", (t) => t.expected_rr < 2.2),
      stratify("事前盈亏比 2.2–3.0", (t) => t.expected_rr >= 2.2 && t.expected_rr < 3),
      stratify("事前盈亏比 ≥3.0", (t) => t.expected_rr >= 3),
    ];
    const byYear = [...new Set(trades.map((t) => t.signal_date.slice(0, 4)))].sort()
      .map((year) => stratify(year, (t) => t.signal_date.startsWith(year)));
    const byExit = [...new Set(trades.map((t) => t.exit_reason))].sort()
      .map((reason) => stratify(reason, (t) => t.exit_reason === reason));
    const byVolumeRatio = [
      stratify("缩量<0.55", (t) => t.features.volume_ratio < 0.55),
      stratify("缩量0.55–0.70", (t) => t.features.volume_ratio >= 0.55 && t.features.volume_ratio < 0.7),
      stratify("缩量0.70–0.85", (t) => t.features.volume_ratio >= 0.7),
    ];
    const byShadow = ["阳线", "下影假阴"].map((label) => stratify(label, (t) => t.features.shadow_type === label));
    const byBoxHeight = [
      stratify("箱体高度<10%", (t) => t.features.box_height < 0.1),
      stratify("箱体高度10–18%", (t) => t.features.box_height >= 0.1 && t.features.box_height < 0.18),
      stratify("箱体高度≥18%", (t) => t.features.box_height >= 0.18),
    ];
    const byRet60 = [
      stratify("60日跌幅≥25%", (t) => t.features.ret60 != null && t.features.ret60 <= -0.25),
      stratify("60日跌幅12–25%", (t) => t.features.ret60 != null && t.features.ret60 > -0.25 && t.features.ret60 <= -0.12),
      stratify("60日跌幅<12%", (t) => t.features.ret60 != null && t.features.ret60 > -0.12),
      stratify("数据不足", (t) => t.features.ret60 == null),
    ];
    const byMa250 = [
      stratify("低于MA250≥35%", (t) => t.features.ma250_dev != null && t.features.ma250_dev <= -0.35),
      stratify("低于MA250 15–35%", (t) => t.features.ma250_dev != null && t.features.ma250_dev > -0.35 && t.features.ma250_dev <= -0.15),
      stratify("接近/高于MA250", (t) => t.features.ma250_dev != null && t.features.ma250_dev > -0.15),
      stratify("数据不足", (t) => t.features.ma250_dev == null),
    ];
    const byAtr = [
      stratify("ATR14/价<3.5%", (t) => t.features.atr_pct != null && t.features.atr_pct < 0.035),
      stratify("ATR14/价3.5–5.5%", (t) => t.features.atr_pct != null && t.features.atr_pct >= 0.035 && t.features.atr_pct < 0.055),
      stratify("ATR14/价≥5.5%", (t) => t.features.atr_pct != null && t.features.atr_pct >= 0.055),
    ];
    const byIndustryMom = [
      stratify("行业20日跌≥6%", (t) => t.industry_mom20 != null && t.industry_mom20 <= -0.06),
      stratify("行业20日跌0–6%", (t) => t.industry_mom20 != null && t.industry_mom20 > -0.06 && t.industry_mom20 < 0),
      stratify("行业20日非跌", (t) => t.industry_mom20 != null && t.industry_mom20 >= 0),
      stratify("数据不足", (t) => t.industry_mom20 == null),
    ];
    const byEntryPremium = [
      stratify("入场溢价<1%", (t) => t.entry_premium < 0.01),
      stratify("入场溢价1–3%", (t) => t.entry_premium >= 0.01 && t.entry_premium < 0.03),
      stratify("入场溢价3–5%", (t) => t.entry_premium >= 0.03),
    ];
    const rsiBuckets = ["RSI<25", "RSI25–32", "RSI32–40"];
    const rsiBucketOf = (t: TradeRecord): string =>
      t.rsi14 < 25 ? "RSI<25" : t.rsi14 < 32 ? "RSI25–32" : "RSI32–40";
    const years = [...new Set(trades.map((t) => t.signal_date.slice(0, 4)))].sort();
    const crossRows = rsiBuckets.map((bucket) => {
      const cells = years.map((year) => {
        const cell = trades.filter((t) => t.signal_date.startsWith(year) && rsiBucketOf(t) === bucket);
        return cell.length ? `${pct(cell.filter((t) => t.win).length / cell.length)}(${cell.length})` : "-";
      });
      return `| ${bucket} | ${cells.join(" | ")} |`;
    });
    // 特征有效性：各分层最好与最差桶的胜率差与平均R差（样本<100 的桶不计）
    const featureSets: Array<[string, Array<[string, TradeRecord[]]>]> = [
      ["RSI14 深度", byRsi],
      ["缩量程度", byVolumeRatio],
      ["K线形态", byShadow],
      ["箱体高度", byBoxHeight],
      ["60日跌幅", byRet60],
      ["MA250 位置", byMa250],
      ["ATR 波动", byAtr],
      ["行业20日动量", byIndustryMom],
      ["事前盈亏比", byRr],
      ["同日簇发", byCluster],
      ["入场溢价", byEntryPremium],
      ["指数状态", byRegime],
    ];
    const effectiveness = featureSets.map(([label, groups]) => {
      const valid = groups.map(([name, rows]) => ({ name, stat: groupStat(rows) })).filter((item) => item.stat.count >= 100);
      const winRates = valid.map((item) => item.stat.winRate);
      const avgRs = valid.map((item) => item.stat.avgR ?? 0);
      return {
        label,
        spread: winRates.length >= 2 ? Math.max(...winRates) - Math.min(...winRates) : 0,
        best: valid.slice().sort((a, b) => (b.stat.avgR ?? 0) - (a.stat.avgR ?? 0))[0]?.name ?? "-",
        worst: valid.slice().sort((a, b) => (a.stat.avgR ?? 0) - (b.stat.avgR ?? 0))[0]?.name ?? "-",
        rSpread: avgRs.length >= 2 ? Math.max(...avgRs) - Math.min(...avgRs) : 0,
      };
    }).sort((a, b) => b.rSpread - a.rSpread);

    // 日度独立化：先算同日平均 R，再对日求均值，缓解簇发相关
    const dailyMeanR = [...new Set(trades.map((t) => t.signal_date))].map((date) =>
      mean(trades.filter((t) => t.signal_date === date).map((t) => t.realized_r))!);

    const report = [
      "# 波段信号胜率/赔率事件研究（原型）",
      "",
      `窗口 ${SINCE} → ${until}；范围 ${universe.length} 只（当前成分近似）；护盘档位固定 ${DEFENSE}；单边成本 10bp。`,
      "",
      "与线上口径差异：成分未按历史重建、RSI/ATR 脚本内计算、股性止损取 0.5 档近似、退出为日线近似。",
      "",
      "## 总体",
      "",
      `- T 日信号 ${facts.length} 条，T+1 确认成交 ${trades.length} 笔（确认率 ${pct(trades.length / Math.max(1, facts.length))}）`,
      `- 胜率 ${pct(overall.winRate)}；平均 R ${num(overall.avgR)}；中位 R ${num(overall.medianR)}；平均持有 ${num(overall.avgHold, 1)} 个交易日`,
      `- 日度独立化平均 R ${num(mean(dailyMeanR))}（同日信号先平均再按日平均）`,
      "",
      "## 特征有效性排序（按平均R的最好-最差档差值；样本<100的档不计）",
      "",
      "| 特征 | 胜率极差 | 平均R极差 | 最好档 | 最差档 |",
      "|------|---------|----------|--------|--------|",
      ...effectiveness.map((item) =>
        `| ${item.label} | ${pct(item.spread)} | ${num(item.rSpread)} | ${item.best} | ${item.worst} |`),
      "",
      "## RSI14 深度 × 年度胜率（括号为笔数）",
      "",
      `| RSI档 | ${years.join(" | ")} |`,
      `|--------| ${years.map(() => "------").join(" | ")} |`,
      ...crossRows,
      "",
      renderTable("按同日簇发规模", byCluster.map(([label, rows]) => [label, groupStat(rows)])),
      "",
      renderTable("按指数状态（信号日沪深300）", byRegime.map(([label, rows]) => [label, groupStat(rows)])),
      "",
      renderTable("按 RSI14 深度", byRsi.map(([label, rows]) => [label, groupStat(rows)])),
      "",
      renderTable("按缩量程度（量/5日均量）", byVolumeRatio.map(([label, rows]) => [label, groupStat(rows)])),
      "",
      renderTable("按K线形态", byShadow.map(([label, rows]) => [label, groupStat(rows)])),
      "",
      renderTable("按箱体高度（40日顶-20日底）/价", byBoxHeight.map(([label, rows]) => [label, groupStat(rows)])),
      "",
      renderTable("按信号前60日跌幅", byRet60.map(([label, rows]) => [label, groupStat(rows)])),
      "",
      renderTable("按相对MA250位置", byMa250.map(([label, rows]) => [label, groupStat(rows)])),
      "",
      renderTable("按ATR14/价格", byAtr.map(([label, rows]) => [label, groupStat(rows)])),
      "",
      renderTable("按所属行业20日动量", byIndustryMom.map(([label, rows]) => [label, groupStat(rows)])),
      "",
      renderTable("按事前盈亏比", byRr.map(([label, rows]) => [label, groupStat(rows)])),
      "",
      renderTable("按T+1入场溢价（相对T日收盘）", byEntryPremium.map(([label, rows]) => [label, groupStat(rows)])),
      "",
      renderTable("按年度", byYear.map(([label, rows]) => [label, groupStat(rows)])),
      "",
      renderTable("按出场原因", byExit.map(([label, rows]) => [label, groupStat(rows)])),
      "",
    ].join("\n");
    fs.writeFileSync(path.join(outDir, "report.md"), report, "utf8");
    fs.writeFileSync(path.join(outDir, "trades.csv"), [
      "code,name,signal_date,entry_date,entry_price,entry_premium,risk_unit,exit_date,exit_reason,holding_days,realized_r,win,partial_taken,breakout_confirmed,rsi14,expected_rr,cluster_size,regime,volume_ratio,shadow_type,box_height,ret60,ma250_dev,atr_pct,industry_code,industry_mom20",
      ...trades.map((t) => [t.code, t.name, t.signal_date, t.entry_date, t.entry_price, t.entry_premium, t.risk_unit, t.exit_date, t.exit_reason, t.holding_days, t.realized_r, t.win, t.partial_taken, t.breakout_confirmed, t.rsi14.toFixed(1), t.expected_rr.toFixed(2), t.cluster_size, t.regime, t.features.volume_ratio.toFixed(3), t.features.shadow_type, t.features.box_height.toFixed(3), t.features.ret60?.toFixed(3) ?? "", t.features.ma250_dev?.toFixed(3) ?? "", t.features.atr_pct?.toFixed(4) ?? "", t.features.industry_code, t.industry_mom20?.toFixed(4) ?? ""].join(",")),
    ].join("\n"), "utf8");
    console.log(report);
    console.log(`明细已写入 ${path.join(outDir, "trades.csv")}`);
  } finally {
    await closePool();
  }
}

void main();
