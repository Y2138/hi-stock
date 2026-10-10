// 冻结行业左侧信号，只研究板块内选股增益。PostgreSQL一致性只读；当前成分回看，research_only。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import { computeOfficialPrevCloses, type AdjustmentEvent } from "../server/datasource/adjustment.js";

const NEXT = process.argv.includes("--next");
const ROOT = path.resolve(NEXT ? "支撑/tmp/夜间板块个股深化研究" : "支撑/tmp/夜间板块个股选择研究");
const SOURCE = path.resolve("支撑/tmp/夜间板块双线趋势回测/独立结论复核-2026-10-10-786a4c73ec92.json");
const BUDGET = 50_000;
const TOP = 2;
const MIN_ADV = 20_000_000;
const VERSION = 5;
const average = (values: number[]) => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2 : null;
};
function stats(values: number[]) {
  const gains = values.filter((v) => v > 0), losses = values.filter((v) => v <= 0);
  const sum = (items: number[]) => items.reduce((a, b) => a + b, 0);
  return { count: values.length, mean: average(values), median: median(values), win_rate: average(values.map((v) => v > 0 ? 1 : 0)),
    profit_factor: sum(losses) < 0 ? sum(gains) / -sum(losses) : null, worst: values.length ? Math.min(...values) : null };
}
function interval(rows: Array<{ date: string; value: number }>) {
  const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))];
  const blocks = months.map((m) => rows.filter((r) => r.date.startsWith(m)).map((r) => r.value));
  if (!blocks.length) return null;
  let seed = 20261010;
  const draws: number[] = [];
  for (let trial = 0; trial < 4000; trial += 1) {
    let sum = 0, count = 0;
    for (let i = 0; i < blocks.length; i += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const block = blocks[Math.floor(seed / 2 ** 32 * blocks.length)]!;
      sum += block.reduce((a, b) => a + b, 0); count += block.length;
    }
    draws.push(sum / count);
  }
  draws.sort((a, b) => a - b);
  return { months: months.length, low: draws[100], high: draws[3899] };
}
interface RawBar {
  date: string; open: number | null; high: number | null; low: number | null; close: number | null;
  prev: number | null; volume: number | null; amount: number | null; unit: string | null; channel: string;
}
interface Member { id: string; code: string; name: string; board: string; from: string }
interface Fundamental { id: string; date: string; period: string; profit: number | null; cash: number | null; roe: number | null; report_ms: number | null }
interface Signal { board: string; date: string; anchor: number; end: string; boardReturn: number }
type Exit = "固定20日" | "结构保护20日";
interface Trade { value: number | null; mae: number | null; holding: number; reason: string; entry: string | null; exit: string | null; filled: boolean; deferred: number }
interface Candidate {
  code: string; name: string; r5: number; r20: number; momentum: number; beta: number; residual5: number;
  adv: number; volume_ratio: number; extension: number; repaired: boolean; quality: boolean; roe: number | null;
  fundamental_date: string | null; current_st: boolean;
  trades: Record<Exit, Record<string, Trade>>;
}
interface Cohort { signal: Signal; expected_members: number; point_in_time_members: number; candidates: Candidate[]; gaps: Record<string, number> }
const BASE_RULES = ["成交额领先", "20日跌幅靠前", "5日修复领先", "中期强度领先", "行业弹性领先", "独立修复领先", "止跌修复确认", "盈利现金流质量"] as const;
const NEXT_RULES = ["修复后按跌幅选股", "补涨修复各一只"] as const;
const RULES = [...BASE_RULES, ...(NEXT ? NEXT_RULES : [])];
type Rule = typeof RULES[number];

function rank(candidates: Candidate[], rule: Rule): Candidate[] {
  if (rule === "补涨修复各一只") {
    const rebound = rank(candidates, "20日跌幅靠前")[0];
    const repair = rank(candidates.filter((c) => c !== rebound), "止跌修复确认")[0];
    return [rebound, repair].filter((c): c is Candidate => c !== undefined);
  }
  const eligible = candidates.filter((c) => rule === "止跌修复确认" || rule === "修复后按跌幅选股" ? c.repaired : rule === "盈利现金流质量" ? c.quality : true);
  const score = (c: Candidate) => {
    switch (rule) {
      case "成交额领先": return c.adv;
      case "20日跌幅靠前": return -c.r20;
      case "修复后按跌幅选股": return -c.r20;
      case "5日修复领先": return c.r5;
      case "中期强度领先": return c.momentum;
      case "行业弹性领先": return c.beta;
      case "独立修复领先": return c.residual5;
      case "止跌修复确认": return c.residual5;
      case "盈利现金流质量": return c.roe!;
    }
  };
  return [...eligible].sort((a, b) => score(b) - score(a) || a.code.localeCompare(b.code)).slice(0, TOP);
}
function charges(gross: number, side: "buy" | "sell", date: string) {
  return Math.max(5, gross * 0.00025) + (side === "sell" ? gross * (date < "2023-08-28" ? 0.001 : 0.0005) : 0);
}
function simulate(
  rows: Map<string, RawBar>, actions: AdjustmentEvent[], dates: string[], anchor: number,
  priorLow: number, shares20: number, exit: Exit, slip: number, limit = 0.10,
): Trade {
  const result: Trade = { value: 0, mae: 0, holding: 0, reason: "未成交", entry: null, exit: null, filled: false, deferred: 0 };
  const signal = rows.get(dates[anchor]!), entry = rows.get(dates[anchor + 1]!);
  if (!signal?.close || !entry?.open || !entry.volume || !entry.prev) return result;
  if (entry.open > entry.prev * 1.03 || entry.open >= Math.round(entry.prev * (1 + limit) * 100) / 100 - 0.001) return result;
  if (entry.open < Math.round(entry.prev * (1 - limit) * 100) / 100 - 0.011) return { ...result, value: limit === 0.05 ? 0 : null,
    reason: limit === 0.05 ? "保守5%开盘边界未成交" : "制度或原始前收异常" };
  const price = entry.open * (1 + slip / 10000);
  const quantity = Math.min(Math.floor((BUDGET - 5) / (price * (1 + 0.00025)) / 100) * 100, Math.floor(shares20 * 0.02 / 100) * 100);
  if (quantity < 100) return result;
  let shares = quantity, cash = BUDGET - price * shares - charges(price * shares, "buy", entry.date);
  const entryActions = actions.filter((a) => a.ex_date === entry.date);
  if (entryActions.some((a) => a.rights_ratio > 0)) return { ...result, value: null, reason: "配股入场结算未建模" };
  const adjustedPriorLow = entryActions.reduce((low, a) => (low - a.dividend) / (1 + a.bonus), priorLow);
  let stop = Math.max(adjustedPriorLow, price * 0.92), pending = false, minEquity = BUDGET, deferred = 0;
  result.filled = true; result.entry = entry.date;
  for (let offset = 1; offset <= 31; offset += 1) {
    const date = dates[anchor + offset];
    if (!date) break;
    const bar = rows.get(date);
    if (offset > 1) {
      for (const action of actions.filter((a) => a.ex_date === date)) {
        if (action.rights_ratio > 0) return { ...result, value: null, reason: "配股结算未建模" };
        cash += shares * action.dividend * 0.8; // 短持仓按20%股息税保守计提，不将现金再投资。
        shares *= 1 + action.bonus;
        stop = (stop - action.dividend) / (1 + action.bonus);
      }
    }
    if (pending) {
      if (bar?.open && bar.prev && bar.volume && bar.open > Math.round(bar.prev * (1 - limit) * 100) / 100 + 0.001) {
        const proceeds = bar.open * (1 - slip / 10000) * shares;
        return { ...result, value: (cash + proceeds - charges(proceeds, "sell", date)) / BUDGET - 1,
          mae: minEquity / BUDGET - 1, holding: offset - 1, reason: result.reason, exit: date, deferred };
      }
      deferred += 1;
    }
    if (bar?.low && bar.close) {
      minEquity = Math.min(minEquity, cash + shares * bar.low);
      if (exit === "结构保护20日" && bar.close <= stop && !pending) { pending = true; result.reason = "结构止损"; }
    }
    if (offset >= 20 && !pending) { pending = true; result.reason = "时间退出"; }
  }
  return { ...result, value: null, mae: minEquity / BUDGET - 1, reason: "退出缺数或连续不可卖", deferred };
}

function selfCheck() {
  assert.equal(charges(100_000, "sell", "2022-01-01"), 125);
  assert.equal(charges(100_000, "sell", "2024-01-01"), 75);
  const dates = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10));
  const rows = new Map(dates.map((date) => [date, { date, open: 10, high: 10, low: 10, close: 10, prev: 10, volume: 1e7, amount: 1e8, unit: "股", channel: "测试" } as RawBar]));
  const baseline = simulate(rows, [], dates, 0, 8, 1e7, "固定20日", 0);
  assert.equal(baseline.exit, dates[21]); assert(baseline.value! < 0);
  rows.get(dates[1]!)!.open = 11; assert.equal(simulate(rows, [], dates, 0, 8, 1e7, "固定20日", 0).filled, false);
  rows.get(dates[1]!)!.open = 10;
  rows.get(dates[3]!)!.close = 8; rows.get(dates[3]!)!.low = 8;
  rows.get(dates[4]!)!.open = 9; rows.get(dates[4]!)!.prev = 10;
  const stopped = simulate(rows, [], dates, 0, 9, 1e7, "结构保护20日", 0);
  assert.equal(stopped.exit, dates[5]); assert.equal(stopped.deferred, 1);
  const before = JSON.stringify([...rows.values()]); simulate(rows, [], dates, 0, 9, 1e7, "结构保护20日", 0); assert.equal(JSON.stringify([...rows.values()]), before);
  const splitRows = new Map(dates.map((date, i) => [date, { date, open: i < 3 ? 10 : 5, high: i < 3 ? 10 : 5,
    low: i < 3 ? 10 : 5, close: i < 3 ? 10 : 5, prev: i < 3 ? 10 : 5, volume: 1e7, amount: 1e8, unit: "股", channel: "测试" } as RawBar]));
  const split = simulate(splitRows, [{ ex_date: dates[3]!, dividend: 0, bonus: 1, rights_ratio: 0, rights_price: 0 }], dates, 0, 8, 1e7, "固定20日", 0);
  assert.equal(split.value, baseline.value, "送股后的数量与价格必须共同结算");
  const exEntryRows = new Map([...splitRows].map(([d, b]) => [d, { ...b }]));
  exEntryRows.get(dates[1]!)!.open = 9.8; exEntryRows.get(dates[1]!)!.prev = 9;
  assert.equal(simulate(exEntryRows, [{ ex_date: dates[1]!, dividend: 1, bonus: 0, rights_ratio: 0, rights_price: 0 }], dates, 0, 8, 1e7, "固定20日", 0).filled, false, "除息日跳空必须相对除权参考价判断");
  assert.equal(simulate(splitRows, [{ ex_date: dates[1]!, dividend: 0, bonus: 0, rights_ratio: 0.3, rights_price: 2 }], dates, 0, 8, 1e7, "固定20日", 0).value, null, "不支持的配股入场不能冒充正常结算");
  const candidates = [{ code: "甲", r20: -0.2, r5: 0.1, adv: 10, repaired: false, quality: false },
    { code: "乙", r20: -0.1, r5: 0.2, adv: 20, repaired: false, quality: false },
    { code: "丙", r20: 0, r5: 0.3, adv: 30, repaired: false, quality: false }] as Candidate[];
  assert.deepEqual(rank(candidates, "20日跌幅靠前").map((c) => c.code), ["甲", "乙"]);
  assert.deepEqual(rank(candidates, "5日修复领先").map((c) => c.code), ["丙", "乙"]);
  assert.equal(rank(candidates, "盈利现金流质量").length, 0);
  candidates[0]!.repaired = true; candidates[1]!.repaired = true;
  candidates[0]!.residual5 = 0.2; candidates[1]!.residual5 = 0.3;
  assert.deepEqual(rank(candidates, "修复后按跌幅选股").map((c) => c.code), ["甲", "乙"]);
  assert.deepEqual(rank(candidates, "补涨修复各一只").map((c) => c.code), ["甲", "乙"]);
  assert(Math.abs(interval([{ date: "2022-01-01", value: 0.1 }])!.low! - 0.1) < 1e-12);
  console.log("个股研究自检通过：历史印花税、开盘限价、不成交留现金、次日退出、跌停顺延、输入不修改。");
}

async function main() {
  selfCheck(); if (process.argv.includes("--self-check")) return;
  fs.mkdirSync(ROOT, { recursive: true });
  const evidence = JSON.parse(fs.readFileSync(SOURCE, "utf8")) as { as_of: string; input_hash: string; trades: Array<{ code: string; signal_date: string }> };
  const smoke = process.argv.includes("--smoke");
  const actionsIndex = process.argv.indexOf("--actions");
  const actionsPath = actionsIndex >= 0 ? process.argv[actionsIndex + 1] : undefined;
  assert(actionsIndex < 0 || actionsPath, "--actions需要CSV路径");
  const extraActionsText = actionsPath ? fs.readFileSync(path.resolve(actionsPath), "utf8") : null;
  const extraActionsHash = extraActionsText ? createHash("sha256").update(extraActionsText).digest("hex") : null;
  const suffix = extraActionsHash ? `-${extraActionsHash.slice(0, 12)}` : "";
  const cache = path.join(ROOT, smoke ? `冒烟候选冻结-v${VERSION}${suffix}.json` : `个股候选冻结-v${VERSION}${suffix}.json`);
  let cohorts: Cohort[], provenance: Record<string, unknown>;
  if (fs.existsSync(cache) && !process.argv.includes("--refresh")) {
    const saved = JSON.parse(fs.readFileSync(cache, "utf8"));
    assert.equal(saved.version, VERSION); assert.equal(saved.industry_hash, evidence.input_hash);
    assert.equal(saved.source_hash, createHash("sha256").update(JSON.stringify(evidence.trades)).digest("hex"));
    cohorts = saved.cohorts; provenance = saved.provenance;
  } else {
    const pool = getPool(loadConfig().databaseUrl), client = await pool.connect();
    cohorts = [];
    const inputHash = createHash("sha256");
    const memberSql = `SELECT s.id::text,s.code,s.name,b.code AS board,m.effective_from::text AS from
      FROM market_board_membership m JOIN market_instrument b ON b.id=m.board_instrument_id
      JOIN market_instrument s ON s.id=m.member_instrument_id
      WHERE b.code LIKE '881%.TI' AND m.effective_to IS NULL AND s.kind='stock'
        AND s.code ~ '^(60|00)[0-9]{4}[.](SH|SZ)$' ORDER BY b.code,s.code`;
    const barSql = `SELECT instrument_id::text AS id,bar_date::text AS date,
      open_raw::float8 AS open,high_raw::float8 AS high,low_raw::float8 AS low,close_raw::float8 AS close,
      prev_close::float8 AS prev,volume::float8,turnover::float8 AS amount,volume_unit AS unit,channel
      FROM market_bar WHERE instrument_id=ANY($1::bigint[]) AND freq='day' AND bar_date BETWEEN $2::date AND $3::date
      ORDER BY instrument_id,bar_date,bar_time`;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='90s'");
      const members = (await client.query<Member>(memberSql)).rows;
      const boardRows = (await client.query<{ code: string; date: string; open: number; close: number }>(
        `SELECT i.code,b.bar_date::text AS date,b.open::float8,b.close::float8 FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id
          WHERE i.code LIKE '881%.TI' AND b.freq='day' AND b.bar_date BETWEEN '2021-01-01' AND $1::date ORDER BY i.code,b.bar_date`, [evidence.as_of])).rows;
      const calendarSql = `SELECT trade_date::text AS date FROM market_trading_day WHERE is_open
        AND trade_date BETWEEN '2021-01-01' AND $1::date ORDER BY trade_date`;
      const calendarRows = (await client.query<{ date: string }>(calendarSql, [evidence.as_of])).rows;
      const dates = calendarRows.map((r) => r.date), datesIndex = new Map(dates.map((d, i) => [d, i]));
      const boardMap = new Map<string, Map<string, { open: number; close: number }>>();
      for (const row of boardRows) { const map = boardMap.get(row.code) ?? new Map(); map.set(row.date, row); boardMap.set(row.code, map); }
      const fundamentals = (await client.query<Fundamental>(`SELECT instrument_id::text AS id,as_of_date::text AS date,report_period::text AS period,
        net_profit::float8 AS profit,operating_cashflow::float8 AS cash,roe::float8,
        CASE WHEN raw_summary->>'report_date_ms' ~ '^[0-9]+([.][0-9]+)?$' THEN (raw_summary->>'report_date_ms')::float8 END AS report_ms
        FROM fundamental_snapshot ORDER BY instrument_id,as_of_date,report_period`)).rows;
      let actions = (await client.query<{ id: string; ex_date: string; dividend: number; bonus: number; rights_ratio: number; rights_price: number }>(
        `SELECT instrument_id::text AS id,ex_date::text,dividend_per_share::float8 AS dividend,bonus_per_share::float8 AS bonus,
          rights_ratio::float8,rights_price::float8 FROM market_corporate_action ORDER BY instrument_id,ex_date`)).rows;
      let preservedRights = 0;
      if (extraActionsText) {
        const lines = extraActionsText.trim().split(/\r?\n/);
        assert.equal(lines.shift(), "thscode,ex_date,dividend_per_share,per_share_bonus,rights_ratio,rights_price");
        const ids = new Map(members.map((m) => [m.code, m.id]));
        const merged = new Map<string, typeof actions[number]>();
        for (const line of lines) {
          const cells = line.split(","); assert.equal(cells.length, 6);
          const id = ids.get(cells[0]!); if (!id || cells[1]! > evidence.as_of) continue;
          const [dividend, bonus, rights_ratio, rights_price] = cells.slice(2).map((v) => v === "" ? Number.NaN : Number(v));
          assert([dividend, bonus, rights_ratio, rights_price].every((v) => v !== undefined && Number.isFinite(v) && v >= 0), "公司行动字段缺失或非法");
          const key = `${id}:${cells[1]}`; assert(!merged.has(key), "公司行动CSV主键重复");
          merged.set(key, { id, ex_date: cells[1]!, dividend: dividend!, bonus: bonus!, rights_ratio: rights_ratio!, rights_price: rights_price! });
        }
        // PostgreSQL保存的较新事件优先，研究快照补足其他历史事件；不写业务数据库。
        for (const action of actions) {
          const key = `${action.id}:${action.ex_date}`, exported = merged.get(key);
          // REST未提供配股字段时原表保存0；不能覆盖批量事件流已明确提供的配股权益。
          if (exported && exported.rights_ratio > 0 && action.rights_ratio === 0) {
            merged.set(key, { ...action, rights_ratio: exported.rights_ratio, rights_price: exported.rights_price });
            preservedRights += 1;
          } else merged.set(key, action);
        }
        actions = [...merged.values()].sort((a, b) => Number(a.id) - Number(b.id) || a.ex_date.localeCompare(b.ex_date));
      }
      inputHash.update(JSON.stringify({ members, boardRows, calendarRows, fundamentals, actions }));
      const boardCodes = [...new Set(evidence.trades.map((t) => t.code))].sort();
      const selectedBoards = smoke ? boardCodes.slice(0, 2) : boardCodes;
      let queried = 0, rowsCount = 0, repeated = 0, invalid = 0, correctedReferences = 0;
      for (const board of selectedBoards) {
        const membership = members.filter((m) => m.board === board);
        const signals = evidence.trades.filter((t) => t.code === board).map((t) => {
          const anchor = datesIndex.get(t.signal_date)!; const prices = boardMap.get(board)!;
          assert(Number.isInteger(anchor) && prices.has(dates[anchor + 1]!) && prices.has(dates[anchor + 21]!), "冻结信号与开市日历或行业未来窗口不一致");
          return { board, date: t.signal_date, anchor, end: dates[anchor + 21]!,
            boardReturn: prices.get(dates[anchor + 21]!)!.open * 0.99875 / (prices.get(dates[anchor + 1]!)!.open * 1.00125) - 1 };
        });
        if (!membership.length) { cohorts.push(...signals.map((signal) => ({ signal, expected_members: 0, point_in_time_members: 0, candidates: [], gaps: { 无主板成分: 1 } }))); continue; }
        const earliest = signals[0]!.date;
        const seed = new Date(Date.parse(earliest) - 420 * 86400000).toISOString().slice(0, 10);
        const rawRows = (await client.query<RawBar & { id: string }>(barSql, [membership.map((m) => m.id), seed, evidence.as_of])).rows;
        inputHash.update(JSON.stringify(rawRows)); rowsCount += rawRows.length;
        const byStock = new Map<string, RawBar[]>();
        for (const row of rawRows) { const list = byStock.get(row.id) ?? []; list.push(row); byStock.set(row.id, list); }
        for (const signal of signals) cohorts.push({ signal, expected_members: membership.length,
          point_in_time_members: membership.filter((m) => m.from <= signal.date).length, candidates: [], gaps: {} });
        const boardCohorts = cohorts.filter((c) => c.signal.board === board);
        for (const member of membership) {
          const tape = byStock.get(member.id) ?? [], stockActions = actions.filter((a) => a.id === member.id);
          const official = computeOfficialPrevCloses(tape.filter((b) => b.close !== null).map((b) => ({ date: b.date, close: b.close! })), stockActions);
          const rows = new Map<string, RawBar>(), levels = new Map<string, number>();
          let level = 1, prior: RawBar | undefined;
          for (const bar of tape) {
            assert(!rows.has(bar.date), `${member.code}重复日线`);
            const reference = official.get(bar.date);
            if (reference && reference > 0) {
              if (bar.prev === null || Math.abs(bar.prev - reference) > 0.000001) correctedReferences += 1;
              bar.prev = reference;
            }
            if (![bar.open, bar.high, bar.low, bar.close].every((v) => v !== null && Number.isFinite(v) && v > 0)
              || bar.high! < Math.max(bar.open!, bar.close!, bar.low!) || bar.low! > Math.min(bar.open!, bar.close!)) { invalid += 1; continue; }
            if (prior && ["open", "high", "low", "close", "volume"].every((k) => prior![k as keyof RawBar] === bar[k as keyof RawBar])) repeated += 1;
            if (bar.prev && bar.prev > 0) level *= bar.close! / bar.prev;
            rows.set(bar.date, bar); levels.set(bar.date, level); prior = bar;
          }
          const financials = fundamentals.filter((f) => f.id === member.id);
          for (const cohort of boardCohorts) {
            const { signal } = cohort, anchor = signal.anchor;
            const gap = (key: string) => { cohort.gaps[key] = (cohort.gaps[key] ?? 0) + 1; };
            const current = rows.get(signal.date);
            const featureDates = dates.slice(anchor - 120, anchor + 1);
            if (!current || !current.volume || featureDates.length < 121 || !featureDates.every((date) => rows.has(date))) { gap("缺行情或120日连续预热"); continue; }
            const recent = dates.slice(anchor - 19, anchor + 1).map((d) => rows.get(d)!);
            if (!recent.every((b) => b.volume && ["股", "share", "shares"].includes(b.unit ?? ""))) { gap("停牌或成交量单位缺失"); continue; }
            const adv = average(recent.map((b) => b.amount ?? b.close! * b.volume!))!;
            if (adv < MIN_ADV) { gap("20日成交额不足2000万"); continue; }
            const boardPrices = boardMap.get(board)!;
            if (!dates.slice(anchor - 60, anchor + 1).every((d) => boardPrices.has(d))) { gap("行业60日回归窗口缺数"); continue; }
            const dailyStock: number[] = [], dailyBoard: number[] = [];
            for (let j = anchor - 59; j <= anchor; j += 1) {
              const b = rows.get(dates[j]!)!;
              dailyStock.push(Math.log(levels.get(dates[j]!)! / levels.get(dates[j - 1]!)!));
              dailyBoard.push(Math.log(boardPrices.get(dates[j]!)!.close / boardPrices.get(dates[j - 1]!)!.close));
              assert(b.prev && b.prev > 0, "前收盘缺失");
            }
            const stockMean = average(dailyStock)!, boardMean = average(dailyBoard)!;
            const variance = dailyBoard.reduce((s, r) => s + (r - boardMean) ** 2, 0);
            const beta = variance > 0 ? dailyStock.reduce((s, r, i) => s + (r - stockMean) * (dailyBoard[i]! - boardMean), 0) / variance : 0;
            const at = (offset: number) => levels.get(dates[anchor + offset]!)!;
            const r5 = at(0) / at(-5) - 1, r20 = at(0) / at(-20) - 1;
            const residual5 = Math.log(at(0) / at(-5)) - beta * Math.log(boardPrices.get(signal.date)!.close / boardPrices.get(dates[anchor - 5]!)!.close) - 5 * (stockMean - beta * boardMean);
            const ma10 = average(dates.slice(anchor - 9, anchor + 1).map((d) => levels.get(d)!))!;
            const ma20 = average(recent.map((b) => levels.get(b.date)!))!;
            const priorLow = Math.min(...recent.map((b) => b.low! / b.close! * levels.get(b.date)!)) / at(0) * current.close!;
            const shares20 = average(recent.map((b) => b.volume!))!;
            const fundamental = [...financials].reverse().find((f) => f.date <= signal.date && f.period <= signal.date
              && Date.parse(signal.date) - Date.parse(f.date) <= 400 * 86400000 && f.report_ms !== null
              && new Date(f.report_ms + 8 * 3600000).toISOString().slice(0, 10) === f.date);
            const trades = Object.fromEntries((["固定20日", "结构保护20日"] as const).map((exit) => [exit, Object.fromEntries([
              ...[10, 30].map((slip) => [String(slip), simulate(rows, stockActions, dates, anchor, priorLow, shares20, exit, slip)]),
              ["10_limit5", simulate(rows, stockActions, dates, anchor, priorLow, shares20, exit, 10, 0.05)],
            ])])) as Candidate["trades"];
            cohort.candidates.push({ code: member.code, name: member.name, r5, r20, momentum: at(-20) / at(-120) - 1,
              beta, residual5, adv, volume_ratio: current.volume / average(recent.slice(-5).map((b) => b.volume!))!,
              extension: at(0) / ma20 - 1, repaired: r20 < 0 && r5 > 0 && at(0) > ma10 && at(0) / ma20 - 1 <= 0.10,
              quality: !!fundamental && fundamental.profit! > 0 && fundamental.cash! > 0 && fundamental.roe! >= 8,
              roe: fundamental?.roe ?? null, fundamental_date: fundamental?.date ?? null, current_st: /ST|退/i.test(member.name), trades });
          }
        }
        queried += 1;
        console.log(`行业 ${queried}/${selectedBoards.length} ${board}：${membership.length}只当前主板成分，${rawRows.length}根原始日线，${boardCohorts.reduce((n, c) => n + c.candidates.length, 0)}个候选事件`);
      }
      await client.query("ROLLBACK");
      provenance = { industry_hash: evidence.input_hash, stock_input_hash: inputHash.digest("hex"), source: SOURCE,
        as_of: evidence.as_of, version: VERSION, member_sql: memberSql, bar_sql: barSql, calendar_sql: calendarSql,
        current_main_board_members: members.length, first_membership: members.map((m) => m.from).sort()[0],
        queried_stock_rows: rowsCount, invalid_raw_rows: invalid, repeated_ohlcv_rows: repeated,
        fundamentals: fundamentals.length, corporate_actions: actions.length,
        corporate_action_members: members.filter((m) => actions.some((a) => a.id === m.id)).length,
        corrected_reference_rows: correctedReferences, extra_actions_path: actionsPath ? path.resolve(actionsPath) : null,
        preserved_exported_rights: preservedRights,
        extra_actions_hash: extraActionsHash, smoke };
      fs.writeFileSync(cache, JSON.stringify({ version: VERSION, industry_hash: evidence.input_hash,
        source_hash: createHash("sha256").update(JSON.stringify(evidence.trades)).digest("hex"), provenance, cohorts }));
    } finally { client.release(); await closePool(); }
  }
  const rows: Array<Record<string, unknown>> = [];
  const records: Array<Record<string, unknown>> = [];
  for (const exit of ["固定20日", "结构保护20日"] as const) for (const slip of [10, 30]) for (const rule of RULES) {
    const pairs: Array<{ date: string; board: string; value: number; baseline: number; index: number; mae: number; filled: number; stop: number; count: number; selected: string[]; beta: number; current_st: number; deferred: number; beta_baseline: number; beta_distance: number }> = [];
    let eligible = 0, incomplete = 0, empty = 0, skippedCandidates = 0;
    for (const cohort of cohorts) {
      // 财务组只在有报告日证据的同一子样本内比较，缺财报不补零也不当作差公司。
      const universe = rule === "盈利现金流质量" ? cohort.candidates.filter((c) => c.fundamental_date !== null) : cohort.candidates;
      if (universe.length < 5) continue;
      eligible += 1;
      const selected = rank(universe, rule);
      if (universe.some((c) => c.trades[exit][String(slip)]!.value === null)) { incomplete += 1; skippedCandidates += universe.filter((c) => c.trades[exit][String(slip)]!.value === null).length; continue; }
      if (!selected.length) empty += 1;
      const selectedTrades = selected.map((c) => c.trades[exit][String(slip)]!);
      const value = selectedTrades.reduce((s, t) => s + t.value!, 0) / TOP;
      const baseline = average(universe.map((c) => c.trades[exit][String(slip)]!.value!))!;
      const matched = selected.map((target) => {
        const neighbours = universe.filter((c) => !selected.includes(c))
          .sort((a, b) => Math.abs(a.beta - target.beta) - Math.abs(b.beta - target.beta) || a.code.localeCompare(b.code)).slice(0, 5);
        return { value: average(neighbours.map((c) => c.trades[exit][String(slip)]!.value!))!,
          distance: average(neighbours.map((c) => Math.abs(c.beta - target.beta)))! };
      });
      pairs.push({ date: cohort.signal.date, board: cohort.signal.board, value, baseline, index: cohort.signal.boardReturn,
        mae: selectedTrades.reduce((s, t) => s + (t.mae ?? 0), 0) / TOP, filled: selectedTrades.filter((t) => t.filled).length,
        stop: selectedTrades.filter((t) => t.reason === "结构止损").length, count: universe.length,
        selected: selected.map((c) => c.code), beta: average(selected.map((c) => c.beta)) ?? 0,
        current_st: selected.filter((c) => c.current_st).length, deferred: selectedTrades.reduce((s, t) => s + t.deferred, 0),
        beta_baseline: matched.reduce((s, m) => s + m.value, 0) / TOP, beta_distance: average(matched.map((m) => m.distance)) ?? 0 });
    }
    const paired = pairs.map((p) => ({ date: p.date, value: p.value - p.baseline }));
    const byDate = [...new Set(pairs.map((p) => p.date))].map((date) => { const subset = pairs.filter((p) => p.date === date); return { date,
      value: average(subset.map((p) => p.value))!, baseline: average(subset.map((p) => p.baseline))!, index: average(subset.map((p) => p.index))! }; });
    rows.push({ rule, exit, slip_bps: slip, eligible_cohorts: eligible, incomplete_cohorts: incomplete, unresolved_stock_events: skippedCandidates,
      empty_cohorts: empty, returns: stats(pairs.map((p) => p.value)), peer_baseline: stats(pairs.map((p) => p.baseline)),
      excess: stats(pairs.map((p) => p.value - p.baseline)), index_excess: stats(pairs.map((p) => p.value - p.index)),
      excess_month_ci: interval(paired), mae_mean: average(pairs.map((p) => p.mae)), fills: pairs.reduce((s, p) => s + p.filled, 0),
      fill_rate: pairs.length ? pairs.reduce((s, p) => s + p.filled, 0) / (pairs.length * TOP) : null,
      stop_rate: pairs.length ? pairs.reduce((s, p) => s + p.stop, 0) / (pairs.length * TOP) : null,
      average_selected_beta: average(pairs.map((p) => p.beta)), current_st_selections: pairs.reduce((s, p) => s + p.current_st, 0),
      beta_matched_excess: stats(pairs.map((p) => p.value - p.beta_baseline)), beta_match_distance: average(pairs.map((p) => p.beta_distance)),
      beta_matched_month_ci: interval(pairs.map((p) => ({ date: p.date, value: p.value - p.beta_baseline }))),
      deferred_sell_days: pairs.reduce((s, p) => s + p.deferred, 0),
      unique_date: { returns: stats(byDate.map((p) => p.value)), excess: stats(byDate.map((p) => p.value - p.baseline)),
        index_excess: stats(byDate.map((p) => p.value - p.index)),
        excess_month_ci: interval(byDate.map((p) => ({ date: p.date, value: p.value - p.baseline }))) },
      by_year: Object.fromEntries([...new Set(pairs.map((p) => p.date.slice(0, 4)))].sort().map((year) => { const subset = pairs.filter((p) => p.date.startsWith(year));
        return [year, { returns: stats(subset.map((p) => p.value)), excess: stats(subset.map((p) => p.value - p.baseline)) }]; })),
      sample_windows: { early: stats(pairs.filter((p) => p.date < "2024-01-01").map((p) => p.value - p.baseline)), late: stats(pairs.filter((p) => p.date >= "2024-01-01").map((p) => p.value - p.baseline)) } });
    records.push(...pairs.map((p) => ({ ...p, rule, exit, slip_bps: slip })));
  }
  const gaps: Record<string, number> = {};
  for (const cohort of cohorts) for (const [key, value] of Object.entries(cohort.gaps)) gaps[key] = (gaps[key] ?? 0) + value;
  const primaryRecords = records.filter((r) => r.exit === "固定20日" && r.slip_bps === 10);
  const concentration = Object.fromEntries(RULES.map((rule) => {
    const subset = primaryRecords.filter((r) => r.rule === rule);
    const months = [...new Set(subset.map((r) => String(r.date).slice(0, 7)))].map((month) => ({ month,
      sum_excess: subset.filter((r) => String(r.date).startsWith(month)).reduce((s, r) => s + Number(r.value) - Number(r.baseline), 0) })).sort((a, b) => b.sum_excess - a.sum_excess);
    const excluded = subset.filter((r) => !months.slice(0, 3).some((m) => String(r.date).startsWith(m.month)));
    const total = subset.reduce((s, r) => s + Number(r.value) - Number(r.baseline), 0);
    return [rule, { top_months: months.slice(0, 3), share_of_excess_sum: total > 0 ? months.slice(0, 3).reduce((s, m) => s + m.sum_excess, 0) / total : null,
      excluding_top3: stats(excluded.map((r) => Number(r.value) - Number(r.baseline))) }];
  }));
  const currentRiskDiagnostic = Object.fromEntries(RULES.filter((r) => r !== "盈利现金流质量").map((rule) => {
    const values: number[] = [], excess: number[] = [];
    for (const cohort of cohorts) {
      const pool = cohort.candidates.filter((c) => !c.current_st);
      if (pool.length < 5 || pool.some((c) => c.trades.固定20日["10"]!.value === null)) continue;
      const selected = rank(pool, rule), value = selected.reduce((s, c) => s + c.trades.固定20日["10"]!.value!, 0) / TOP;
      values.push(value); excess.push(value - average(pool.map((c) => c.trades.固定20日["10"]!.value!))!);
    }
    return [rule, { returns: stats(values), excess: stats(excess), evidence: "使用当前风险名称的敏感性检查，存在未来信息，不作为历史可实施规则" }];
  }));
  const timingPath = path.resolve("支撑/tmp/夜间板块双线趋势回测/反弹择时与选板增强复核.json");
  const timing = JSON.parse(fs.readFileSync(timingPath, "utf8")) as { input_hash: string; calendar: Array<{ date: string; pre20: number }> };
  assert.equal(timing.input_hash, evidence.input_hash);
  const marketPre20 = new Map(timing.calendar.map((r) => [r.date, r.pre20]));
  const marketStates = Object.fromEntries(RULES.map((rule) => [rule, Object.fromEntries([true, false].map((deep) => {
    const subset = primaryRecords.filter((r) => r.rule === rule && (marketPre20.get(String(r.date))! <= -0.10) === deep);
    return [deep ? "市场前20日跌幅至少10%" : "其他反弹背景", { dates: new Set(subset.map((r) => r.date)).size,
      returns: stats(subset.map((r) => Number(r.value))), excess: stats(subset.map((r) => Number(r.value) - Number(r.baseline))) }];
  }))]));
  const nextRules: Rule[] = ["20日跌幅靠前", "止跌修复确认", ...NEXT_RULES];
  const strictExecution = Object.fromEntries(nextRules.map((rule) => {
    const pairs: Array<{ date: string; value: number; baseline: number; normal: number; filled: number }> = [];
    let unresolved = 0;
    for (const cohort of cohorts) {
      const pool = cohort.candidates;
      if (pool.length < 5) continue;
      if (pool.some((c) => c.trades.固定20日["10_limit5"]!.value === null || c.trades.固定20日["10"]!.value === null)) { unresolved += 1; continue; }
      const selected = rank(pool, rule);
      pairs.push({ date: cohort.signal.date,
        value: selected.reduce((s, c) => s + c.trades.固定20日["10_limit5"]!.value!, 0) / TOP,
        normal: selected.reduce((s, c) => s + c.trades.固定20日["10"]!.value!, 0) / TOP,
        baseline: average(pool.map((c) => c.trades.固定20日["10_limit5"]!.value!))!,
        filled: selected.filter((c) => c.trades.固定20日["10_limit5"]!.filled).length });
    }
    return [rule, { returns: stats(pairs.map((p) => p.value)), normal_same_cohorts: stats(pairs.map((p) => p.normal)),
      excess: stats(pairs.map((p) => p.value - p.baseline)), unresolved_cohorts: unresolved,
      fill_rate: pairs.length ? pairs.reduce((s, p) => s + p.filled, 0) / (TOP * pairs.length) : null,
      caveat: "全部股票按5%边界的保守执行压力；不是历史ST状态复原" }];
  }));
  const comparisons = Object.fromEntries(NEXT_RULES.map((rule) => {
    const candidate = primaryRecords.filter((r) => r.rule === rule);
    const controls = new Map(primaryRecords.filter((r) => r.rule === "20日跌幅靠前").map((r) => [`${r.board}:${r.date}`, r]));
    const differences = candidate.map((r) => ({ date: String(r.date), value: Number(r.value) - Number(controls.get(`${r.board}:${r.date}`)!.value) }));
    const days = [...new Set(differences.map((r) => r.date))].map((date) => ({ date, value: average(differences.filter((r) => r.date === date).map((r) => r.value))! }));
    return [rule, { vs_rebound: stats(differences.map((r) => r.value)), month_ci: interval(differences),
      by_date: stats(days.map((r) => r.value)), by_date_month_ci: interval(days) }];
  }));
  const output = { evidence: "research_only", provenance, settings: { nominal_capital: BUDGET * TOP, max_stocks_per_board: TOP,
    warmup_market_days: 120, min_adv20_yuan: MIN_ADV, liquidity_participation: 0.02, open_gap_max: 0.03,
    stock_universe: "当前881成分中的沪深主板股票，未使用当前ST标签筛除历史标的", tax: "佣金单边2.5bp最低5元；卖出印花税2023-08-28前10bp、之后5bp；短持股息按20%保守计提",
    prices: "原始OHLC结算；使用合并的公司行动重算前收参考价并连接价格特征；除息日跳空与前低按除权口径调整；不使用当前锚点前复权",
    peer_baseline: "同板块同信号日同资格股的等权候选收益，即随机选两只的期望，不含事后筛掉涨停或未成交股票",
    limitations: ["当前行业归属和生存标的回看，非点时历史全集", "历史ST标记不完整，主板按10%限制近似；当前ST标签只做审计", "已记录公司行动可结算，但公司行动历史未覆盖全部候选，未知分红送转可能影响收益和特征", "缺数不能与停牌完全区分，未成交记现金，退出最多顺延10日", "无报价队列/开盘实际成交量，仅日线可成交近似", "财务按报告日字段对齐但未证明当时原始版本，覆盖子样本不代表全市场", "配股或不可结算标的不补值，对照整组隔离并披露", "无跨事件资金仓位约束，非组合收益", "所有选股规则为历史探索，年度切片和重采样不是样本外", "按弹性找最近五个同板块对照并不等于多因子风险调整，且未校正多重比较"] },
    coverage: { frozen_industry_events: evidence.trades.length, evaluated_cohorts: cohorts.length, stock_events: cohorts.reduce((n, c) => n + c.candidates.length, 0),
      unique_candidate_stocks: new Set(cohorts.flatMap((c) => c.candidates.map((s) => s.code))).size,
      point_in_time_covered_cohorts: cohorts.filter((c) => c.point_in_time_members === c.expected_members && c.expected_members > 0).length,
      events_with_five_candidates: cohorts.filter((c) => c.candidates.length >= 5).length,
      quality_known_stock_events: cohorts.reduce((n, c) => n + c.candidates.filter((s) => s.fundamental_date !== null).length, 0),
      current_st_candidate_events: cohorts.reduce((n, c) => n + c.candidates.filter((s) => s.current_st).length, 0), gaps },
    diagnostics: { concentration, current_risk_name_exclusion: currentRiskDiagnostic, market_states: marketStates,
      strict_5pct_execution: strictExecution, next_comparisons: comparisons,
      caveats: ["三个高贡献月按已知结果选择，仅检查集中度", "当前风险名称排除含未来信息，仅检查风险标签影响", "市场跌幅10%分组为探索性描述，只有5个深跌信号日期，不能确立动态选股门禁"] },
    matrix: rows, cohorts: cohorts.map((c) => ({ board: c.signal.board, date: c.signal.date, expected_members: c.expected_members,
      point_in_time_members: c.point_in_time_members, candidates: c.candidates.length, gaps: c.gaps })), records };
  const file = path.join(ROOT, smoke ? "冒烟选股结果.json" : "板块内个股选择验证.json");
  fs.writeFileSync(file, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ coverage: output.coverage, primary: rows.filter((r) => r.exit === "固定20日" && r.slip_bps === 10) }, null, 2));
  console.log(`证据：${file}`);
}

await main();
