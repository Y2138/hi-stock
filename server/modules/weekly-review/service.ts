// 每周交易复盘的服务端确定性事实快照：只读 PostgreSQL，不联网、不调用 LLM。
// 复盘窗口固定为“目标日之前最近开市日所在自然周”的开市日；所有统计都标注样本与缺口，
// 信号是否计入本周按“信号生效日（actionable date）”判断，不使用事后挑选的标的。
import type pg from "pg";

type Db = Pick<pg.Pool, "query">;

export const WEEKLY_REVIEW_JOB = "weekly_trading_review";
export const WEEKLY_REVIEW_VERSION = "weekly-review-v1";

/** 大盘参照指数：上证、深证成指、创业板指、沪深300、中证500、中证1000。 */
export const WEEKLY_REVIEW_INDEXES = [
  { code: "000001.SH", name: "上证指数" },
  { code: "399001.SZ", name: "深证成指" },
  { code: "399006.SZ", name: "创业板指" },
  { code: "000300.SH", name: "沪深300" },
  { code: "000905.SH", name: "中证500" },
  { code: "000852.SH", name: "中证1000" },
] as const;

export type WeeklyReviewGap = { scope: string; reason: string };

export interface WeeklyReviewAccountWeek {
  account_id: string;
  account_name: string;
  equity_start: number | null;
  equity_end: number | null;
  equity_change_pct: number | null;
  cash_end: number | null;
  market_value_end: number | null;
}

export interface WeeklyReviewPosition {
  account_id: string;
  account_name: string;
  code: string;
  name: string;
  kind: string;
  quantity: number;
  cost_price: number;
  close: number | null;
  close_date: string | null;
  market_value: number | null;
  pnl_amount: number | null;
  pnl_ratio_pct: number | null;
  week_start_close: number | null;
  week_start_bar_date: string | null;
  week_pct: number | null;
  week_pnl_amount: number | null;
  opened_at: string | null;
  strategy_code: string | null;
  strategy_name: string | null;
}

export interface WeeklyReviewTrade {
  account_id: string;
  account_name: string;
  change_date: string;
  kind: string;
  code: string;
  name: string;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  realized_pnl: number | null;
  reason: string | null;
  strategy_code: string | null;
  decision_origin: string | null;
  execution_compliance: string | null;
  plan_target_date: string | null;
}

export interface WeeklyReviewRealized {
  account_id: string;
  account_name: string;
  realized_pnl: number;
  sell_count: number;
  missing_pnl_count: number;
}

export type OpportunitySource = "daily_plan" | "strategy_shortlist" | "selection" | "ultra_short" | "pool_attention";

export const OPPORTUNITY_SOURCE_LABELS: Record<OpportunitySource, string> = {
  daily_plan: "收盘打板机会",
  strategy_shortlist: "盘后策略初筛",
  selection: "盘后统一精选推荐",
  ultra_short: "超短 T+1 关注池",
  pool_attention: "策略关注条目",
};

export interface OpportunityPerformance {
  /** evaluated=已用信号日开盘至窗口末收盘计算；pending=信号日在最后交易日之后；missing_data=缺少行情。 */
  status: "evaluated" | "pending" | "missing_data";
  entry_date: string | null;
  entry_price: number | null;
  last_bar_date: string | null;
  window_close: number | null;
  return_pct: number | null;
  max_gain_pct: number | null;
  max_drawdown_pct: number | null;
  bar_count: number;
  limit_up_days: number;
}

export interface WeeklyReviewOpportunity {
  source: OpportunitySource;
  source_label: string;
  produced_date: string;
  signal_date: string | null;
  code: string;
  name: string;
  industry: string | null;
  strategy_codes: string[];
  status: string | null;
  note: string | null;
  performance: OpportunityPerformance;
}

export interface OpportunitySummary {
  source: OpportunitySource;
  source_label: string;
  count: number;
  evaluated: number;
  wins: number;
  losses: number;
  flat: number;
  win_rate_pct: number | null;
  avg_return_pct: number | null;
  median_return_pct: number | null;
  best: { code: string; name: string; return_pct: number } | null;
  worst: { code: string; name: string; return_pct: number } | null;
  pending: number;
  missing_data: number;
}

export interface WeeklyReviewIndex {
  code: string;
  name: string;
  pct_week: number | null;
  pct_last_week: number | null;
  pct_4w: number | null;
  turnover_week: number | null;
  turnover_change_pct: number | null;
  days: Array<{ date: string; close: number; pct: number | null }>;
}

export interface WeeklyReviewSector {
  code: string;
  name: string;
  pct_week: number | null;
  pct_last_week: number | null;
  pct_4w: number | null;
  rank: number | null;
}

export interface WeeklyReviewBreadthDay {
  date: string;
  limit_up: number | null;
  limit_down: number | null;
  break_count: number | null;
  max_streak: number | null;
  advancing: number | null;
  declining: number | null;
  stock_sample: number | null;
  median_pct: number | null;
}

export interface WeeklyReviewMarket {
  indices: WeeklyReviewIndex[];
  sectors: WeeklyReviewSector[];
  sector_summary: {
    active_board_count: number;
    covered_board_count: number;
    up_count: number;
    down_count: number;
    median_pct_week: number | null;
    top: WeeklyReviewSector[];
    bottom: WeeklyReviewSector[];
  };
  breadth: WeeklyReviewBreadthDay[];
}

export interface WeeklyReviewSummary {
  account_count: number;
  position_count: number;
  position_market_value: number | null;
  position_unrealized_pnl: number | null;
  position_week_pnl: number | null;
  week_realized_pnl: number;
  trade_count: number;
  opportunity_count: number;
  evaluated_opportunity_count: number;
  win_rate_pct: number | null;
}

export interface WeeklyReviewSnapshot {
  version: string;
  target_date: string;
  week_start: string | null;
  week_end: string | null;
  previous_week_end: string | null;
  trading_days: string[];
  status: "success" | "partial";
  summary: WeeklyReviewSummary;
  accounts: WeeklyReviewAccountWeek[];
  positions: WeeklyReviewPosition[];
  trades: WeeklyReviewTrade[];
  realized: WeeklyReviewRealized[];
  opportunities: WeeklyReviewOpportunity[];
  opportunity_summary: OpportunitySummary[];
  market: WeeklyReviewMarket;
  gaps: WeeklyReviewGap[];
  built_at: string;
}

export interface WeeklyReviewSnapshotRow {
  run_id: string;
  version: string;
  target_date: string;
  week_start: string | null;
  week_end: string | null;
  status: "success" | "partial";
  payload: WeeklyReviewSnapshot;
  gaps: WeeklyReviewGap[];
  built_at: string;
}

const MAX_TRADES = 300;
const MAX_PLAYBOOK_OPPORTUNITIES = 60;
const MAX_ULTRA_SHORT_OPPORTUNITIES = 60;
const MAX_ATTENTION_OPPORTUNITIES = 60;
const MAX_SHORTLIST_PER_SOURCE_DAY = 8;
const MAX_OPPORTUNITIES = 160;
const MAX_SECTOR_LIST = 10;

function round2(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Math.round(value * 100) / 100;
}

function pctChange(value: number | null, base: number | null): number | null {
  if (value === null || base === null || base === 0) return null;
  return round2((value / base - 1) * 100);
}

function addDays(date: string, delta: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + delta);
  return parsed.toISOString().slice(0, 10);
}

/** 自然周周一（UTC 日期运算，不受服务器时区影响）。 */
function mondayOf(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  const weekday = parsed.getUTCDay();
  parsed.setUTCDate(parsed.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday));
  return parsed.toISOString().slice(0, 10);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return round2(sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2);
}

function sumOrNull(values: Array<number | null>): number | null {
  const usable = values.filter((value): value is number => value !== null);
  return usable.length ? round2(usable.reduce((total, value) => total + value, 0)) : null;
}

interface Window {
  weekStart: string | null;
  weekEnd: string | null;
  previousWeekEnd: string | null;
  priorWeekEnd: string | null;
  tradingDays: string[];
  openDays: string[];
  nextOpen: (date: string) => string | null;
  gaps: WeeklyReviewGap[];
}

async function resolveWindow(db: Db, targetDate: string): Promise<Window> {
  const gaps: WeeklyReviewGap[] = [];
  const from = addDays(targetDate, -45);
  const to = addDays(targetDate, 20);
  const openDays = (await db.query<{ date: string }>(
    `SELECT trade_date::text AS date FROM market_trading_day
      WHERE is_open AND trade_date BETWEEN $1::date AND $2::date
      ORDER BY trade_date`,
    [from, to],
  )).rows.map((row) => row.date);
  const pastOpen = openDays.filter((date) => date <= targetDate);
  let weekEnd = pastOpen.at(-1) ?? null;
  if (!weekEnd) {
    const fallback = (await db.query<{ date: string | null }>(
      `SELECT max(bar_date)::text AS date FROM market_bar WHERE freq = 'day' AND bar_date <= $1::date`,
      [targetDate],
    )).rows[0]?.date ?? null;
    if (!fallback) {
      gaps.push({ scope: "calendar", reason: "交易日历与日线均无目标日之前的数据，无法确定复盘窗口" });
      return {
        weekStart: null, weekEnd: null, previousWeekEnd: null, priorWeekEnd: null,
        tradingDays: [], openDays: [], nextOpen: () => null, gaps,
      };
    }
    weekEnd = fallback;
    gaps.push({ scope: "calendar", reason: "交易日历缺数，按行情最大日期降级确定复盘周" });
  }
  const weekStart = mondayOf(weekEnd);
  const tradingDays = openDays.filter((date) => date >= weekStart && date <= weekEnd);
  if (!tradingDays.length) {
    tradingDays.push(weekEnd);
    gaps.push({ scope: "calendar", reason: "复盘窗口内交易日历缺行，仅按最后开市日统计" });
  }
  const before = openDays.filter((date) => date < weekStart);
  const previousWeekEnd = before.at(-1) ?? null;
  const priorWeekEnd = before.at(-2) ?? null;
  return {
    weekStart, weekEnd, previousWeekEnd, priorWeekEnd, tradingDays, openDays,
    nextOpen: (date: string) => openDays.find((day) => day > date) ?? null,
    gaps,
  };
}

function safeLabel(value: unknown, limit = 120): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

interface PositionRow {
  account_id: string;
  account_name: string;
  code: string;
  name: string;
  kind: string;
  quantity: number;
  cost_price: number;
  close: number | null;
  close_date: string | null;
  week_start_close: number | null;
  week_start_bar_date: string | null;
  opened_at: string | null;
  strategy_code: string | null;
  strategy_name: string | null;
}

async function loadPositions(db: Db, window: Window, gaps: WeeklyReviewGap[]): Promise<WeeklyReviewPosition[]> {
  if (!window.weekEnd) return [];
  const rows = (await db.query<PositionRow>(
    `SELECT p.account_id::text, account.name AS account_name,
            instrument.code, instrument.name, instrument.kind,
            p.quantity::float, p.cost_price::float, p.opened_at::text,
            p.strategy_code, strategy.name AS strategy_name,
            endbar.close::float AS close, endbar.bar_date::text AS close_date,
            startbar.close::float AS week_start_close, startbar.bar_date::text AS week_start_bar_date
       FROM portfolio_position p
       JOIN portfolio_account account ON account.id = p.account_id
       JOIN market_instrument instrument ON instrument.id = p.instrument_id
       LEFT JOIN strategy_definition strategy ON strategy.code = p.strategy_code
       LEFT JOIN LATERAL (
         SELECT close, bar_date FROM market_bar
          WHERE instrument_id = p.instrument_id AND freq = 'day' AND bar_date <= $1::date
          ORDER BY bar_date DESC LIMIT 1
       ) endbar ON true
       LEFT JOIN LATERAL (
         SELECT close, bar_date FROM market_bar
          WHERE instrument_id = p.instrument_id AND freq = 'day' AND bar_date <= $2::date
          ORDER BY bar_date DESC LIMIT 1
       ) startbar ON true
      WHERE account.status = 'active'
      ORDER BY p.account_id, instrument.code`,
    [window.weekEnd, window.previousWeekEnd],
  )).rows;
  if (!rows.length) return [];
  const missingQuote = rows.filter((row) => row.close === null).length;
  if (missingQuote) {
    gaps.push({ scope: "positions", reason: `${missingQuote} 只持仓缺少收盘价，浮动盈亏与本周涨跌按空值处理` });
  }
  const staleBaseline = rows.filter((row) =>
    row.week_start_close !== null && window.previousWeekEnd !== null
    && row.week_start_bar_date !== null && row.week_start_bar_date < window.previousWeekEnd).length;
  if (staleBaseline) {
    gaps.push({ scope: "positions", reason: `${staleBaseline} 只持仓在上周末之前已无成交，本周涨跌以停牌前最近收盘为基准` });
  }
  return rows.map((row) => {
    const close = row.close === null ? null : Number(row.close);
    const cost = Number(row.cost_price);
    const quantity = Number(row.quantity);
    const start = row.week_start_close === null ? null : Number(row.week_start_close);
    return {
      account_id: row.account_id,
      account_name: row.account_name,
      code: row.code,
      name: row.name,
      kind: row.kind,
      quantity,
      cost_price: round2(cost) ?? cost,
      close: round2(close),
      close_date: row.close_date,
      market_value: close === null ? null : round2(quantity * close),
      pnl_amount: close === null ? null : round2(quantity * (close - cost)),
      pnl_ratio_pct: close === null || cost === 0 ? null : round2(((close - cost) / cost) * 100),
      week_start_close: round2(start),
      week_start_bar_date: row.week_start_bar_date,
      week_pct: pctChange(close, start),
      week_pnl_amount: close === null || start === null ? null : round2(quantity * (close - start)),
      opened_at: row.opened_at,
      strategy_code: row.strategy_code,
      strategy_name: row.strategy_name,
    };
  });
}

async function loadEquity(
  db: Db, window: Window, accounts: Array<{ id: string; name: string }>, gaps: WeeklyReviewGap[],
): Promise<WeeklyReviewAccountWeek[]> {
  if (!window.weekEnd) {
    return accounts.map((account) => ({
      account_id: account.id, account_name: account.name,
      equity_start: null, equity_end: null, equity_change_pct: null, cash_end: null, market_value_end: null,
    }));
  }
  const dates = [window.weekEnd, window.previousWeekEnd].filter((date): date is string => date !== null);
  const rows = dates.length
    ? (await db.query<{ account_id: string; snap_date: string; equity: number; cash: number; market_value: number }>(
      `SELECT account_id::text, snap_date::text, equity::float, cash::float, market_value::float
         FROM portfolio_equity_daily WHERE snap_date = ANY($1::date[])`,
      [dates],
    )).rows
    : [];
  const byAccount = new Map<string, { start?: typeof rows[number]; end?: typeof rows[number] }>();
  for (const row of rows) {
    const entry = byAccount.get(row.account_id) ?? {};
    if (row.snap_date === window.weekEnd) entry.end = row;
    if (row.snap_date === window.previousWeekEnd) entry.start = row;
    byAccount.set(row.account_id, entry);
  }
  const missingEnd: string[] = [];
  const missingStart: string[] = [];
  const weeks = accounts.map((account) => {
    const entry = byAccount.get(account.id) ?? {};
    if (!entry.end) missingEnd.push(account.name);
    if (!entry.start) missingStart.push(account.name);
    const equityStart = entry.start?.equity ?? null;
    const equityEnd = entry.end?.equity ?? null;
    return {
      account_id: account.id,
      account_name: account.name,
      equity_start: round2(equityStart),
      equity_end: round2(equityEnd),
      equity_change_pct: pctChange(equityEnd, equityStart),
      cash_end: round2(entry.end?.cash ?? null),
      market_value_end: round2(entry.end?.market_value ?? null),
    };
  });
  if (missingEnd.length) {
    gaps.push({ scope: "equity", reason: `账户缺少本周末净值快照：${missingEnd.slice(0, 5).join("、")}${missingEnd.length > 5 ? " 等" : ""}` });
  }
  if (missingStart.length) {
    gaps.push({ scope: "equity", reason: `账户缺少上周末净值快照：${missingStart.slice(0, 5).join("、")}${missingStart.length > 5 ? " 等" : ""}；本周净值变化只能为 null` });
  }
  return weeks;
}

async function loadTrades(
  db: Db, window: Window, gaps: WeeklyReviewGap[],
): Promise<{ trades: WeeklyReviewTrade[]; realized: WeeklyReviewRealized[] }> {
  if (!window.weekStart || !window.weekEnd) return { trades: [], realized: [] };
  const trades = (await db.query<WeeklyReviewTrade>(
    `SELECT change.account_id::text, account.name AS account_name, change.change_date::text,
            change.kind, instrument.code, instrument.name,
            change.quantity::float, change.price::float, change.amount::float,
            change.realized_pnl::float, change.reason, change.strategy_code,
            change.decision_origin, change.execution_compliance,
            plan.target_date::text AS plan_target_date
       FROM portfolio_position_change change
       JOIN portfolio_account account ON account.id = change.account_id
       JOIN market_instrument instrument ON instrument.id = change.instrument_id
       LEFT JOIN job_run_output plan ON plan.id = change.plan_output_id
      WHERE account.status = 'active' AND change.change_date BETWEEN $1::date AND $2::date
      ORDER BY change.change_date, change.id
      LIMIT $3`,
    [window.weekStart, window.weekEnd, MAX_TRADES],
  )).rows.map((row) => ({
    ...row,
    quantity: row.quantity === null ? null : Number(row.quantity),
    price: row.price === null ? null : Number(row.price),
    amount: row.amount === null ? null : Number(row.amount),
    realized_pnl: row.realized_pnl === null ? null : Number(row.realized_pnl),
  }));
  if (trades.length >= MAX_TRADES) {
    gaps.push({ scope: "trades", reason: `本周成交事件超过 ${MAX_TRADES} 笔，按日期只保留前 ${MAX_TRADES} 笔` });
  }
  const realized = (await db.query<{
    account_id: string; account_name: string; realized_pnl: number; sell_count: number; missing_pnl_count: number;
  }>(
    `SELECT change.account_id::text, account.name AS account_name,
            COALESCE(sum(change.realized_pnl), 0)::float AS realized_pnl,
            count(*)::int AS sell_count,
            count(*) FILTER (WHERE change.realized_pnl IS NULL)::int AS missing_pnl_count
       FROM portfolio_position_change change
       JOIN portfolio_account account ON account.id = change.account_id
      WHERE account.status = 'active' AND change.kind = 'sell'
        AND change.change_date BETWEEN $1::date AND $2::date
      GROUP BY change.account_id, account.name
      ORDER BY change.account_id`,
    [window.weekStart, window.weekEnd],
  )).rows.map((row) => ({
    ...row,
    realized_pnl: Number(row.realized_pnl),
    sell_count: Number(row.sell_count),
    missing_pnl_count: Number(row.missing_pnl_count),
  }));
  const missing = realized.reduce((total, row) => total + row.missing_pnl_count, 0);
  if (missing) gaps.push({ scope: "realized_pnl", reason: `${missing} 笔卖出缺少已实现盈亏，本周已实现盈亏只统计可计算部分` });
  return { trades, realized };
}

interface OpportunitySeed {
  source: OpportunitySource;
  producedDate: string;
  signalDate: string | null;
  code: string;
  name: string;
  status: string | null;
  note: string | null;
  strategyCode: string | null;
}

function shortlistSeeds(
  rows: Array<{ strategy_code: string; target_date: string; payload: unknown }>,
  nextOpen: (date: string) => string | null,
): OpportunitySeed[] {
  const seeds: OpportunitySeed[] = [];
  for (const row of rows) {
    const candidates = Array.isArray(record(row.payload).candidates) ? record(row.payload).candidates as unknown[] : [];
    const signalDate = nextOpen(row.target_date);
    let kept = 0;
    for (const item of candidates) {
      const candidate = record(item);
      if (typeof candidate.code !== "string" || !candidate.code) continue;
      if (kept >= MAX_SHORTLIST_PER_SOURCE_DAY) break;
      kept += 1;
      seeds.push({
        source: "strategy_shortlist",
        producedDate: row.target_date,
        signalDate,
        code: candidate.code,
        name: safeLabel(candidate.name, 60) ?? candidate.code,
        status: safeLabel(candidate.status, 20),
        note: safeLabel(candidate.industry, 60),
        strategyCode: row.strategy_code,
      });
    }
  }
  return seeds;
}

async function collectOpportunities(db: Db, window: Window, gaps: WeeklyReviewGap[]): Promise<OpportunitySeed[]> {
  if (!window.weekStart || !window.weekEnd) return [];
  const [shortlistRows, selectionRows, ultraRows, playbookRows, attentionRows] = await Promise.all([
    db.query<{ strategy_code: string; target_date: string; payload: unknown }>(
      `SELECT strategy_code, target_date::text, payload FROM strategy_candidate_shortlist
        WHERE target_date BETWEEN $1::date AND $2::date
        ORDER BY target_date, strategy_code`,
      [window.weekStart, window.weekEnd],
    ),
    db.query<{ target_date: string; result: unknown }>(
      `SELECT target_date::text, result FROM candidate_selection_result
        WHERE status = 'generated' AND result IS NOT NULL
          AND target_date BETWEEN $1::date AND $2::date
        ORDER BY target_date`,
      [window.weekStart, window.weekEnd],
    ),
    db.query<{ target_date: string; data_date: string; code: string; name: string; priority: string; stage: string | null; review_status: string }>(
      `SELECT target_date::text, data_date::text, code, name, priority, stage, review_status
         FROM ultra_short_watchlist WHERE data_date BETWEEN $1::date AND $2::date
        ORDER BY data_date, priority, code LIMIT $3`,
      [window.weekStart, window.weekEnd, MAX_ULTRA_SHORT_OPPORTUNITIES],
    ),
    db.query<{ target_date: string; code: string; name: string; grade: string | null; action: string; priority: number; headline: string }>(
      `SELECT DISTINCT target_date::text, code, name, grade, action, priority, headline
         FROM daily_plan_playbook
        WHERE item_kind = 'off_pool_opportunity' AND status IN ('active', 'superseded')
          AND target_date BETWEEN $1::date AND $2::date
        ORDER BY target_date, priority, code LIMIT $3`,
      [window.weekStart, window.weekEnd, MAX_PLAYBOOK_OPPORTUNITIES],
    ),
    db.query<{ source_job: string; status: string; valid_from: string; data_date: string | null; code: string; name: string }>(
      `SELECT attention.source_job, attention.status, attention.valid_from::text,
              attention.data_date::text, instrument.code, instrument.name
         FROM pool_attention_entry attention
         JOIN market_instrument instrument ON instrument.id = attention.instrument_id
        WHERE attention.valid_from BETWEEN $1::date AND $2::date
          AND attention.source_type = 'strategy'
          AND attention.status IN ('qualified', 'approaching')
        ORDER BY attention.valid_from, instrument.code LIMIT $3`,
      [window.weekStart, window.weekEnd, MAX_ATTENTION_OPPORTUNITIES],
    ),
  ]);
  const selectionSeeds: OpportunitySeed[] = [];
  for (const row of selectionRows.rows) {
    const recommendations = Array.isArray(record(row.result).recommendations)
      ? record(row.result).recommendations as unknown[]
      : [];
    const signalDate = window.nextOpen(row.target_date);
    for (const item of recommendations.slice(0, 3)) {
      const recommendation = record(item);
      if (typeof recommendation.code !== "string" || !recommendation.code) continue;
      selectionSeeds.push({
        source: "selection",
        producedDate: row.target_date,
        signalDate,
        code: recommendation.code,
        name: safeLabel(recommendation.name, 60) ?? recommendation.code,
        status: "recommended",
        note: safeLabel(recommendation.industry, 60),
        strategyCode: "cross_strategy_selection",
      });
    }
  }
  const seeds: OpportunitySeed[] = [
    ...shortlistSeeds(shortlistRows.rows, window.nextOpen),
    ...selectionSeeds,
    ...ultraRows.rows.map((row) => ({
      source: "ultra_short" as const,
      producedDate: row.data_date,
      signalDate: row.target_date,
      code: row.code,
      name: row.name,
      status: row.priority,
      note: [row.stage, row.review_status].filter(Boolean).join("·") || null,
      strategyCode: "limit_up",
    })),
    ...playbookRows.rows.map((row) => ({
      source: "daily_plan" as const,
      producedDate: row.target_date,
      // 收盘打板任务在盘后生成下一交易日观察候选，信号生效日为下一开市日。
      signalDate: window.nextOpen(row.target_date),
      code: row.code,
      name: row.name,
      status: row.grade ?? row.action,
      note: safeLabel(row.headline, 120),
      strategyCode: null,
    })),
    ...attentionRows.rows.map((row) => ({
      source: "pool_attention" as const,
      producedDate: row.valid_from,
      // 关注条目在盘后写入，统一按评估数据日之后的最近开市日作为可执行起点。
      signalDate: window.nextOpen(row.data_date ?? row.valid_from),
      code: row.code,
      name: row.name,
      status: row.status,
      note: `来源任务：${row.source_job}`,
      strategyCode: row.source_job,
    })),
  ];
  const shortlistTruncated = shortlistRows.rows.reduce((total, row) => {
    const candidates = Array.isArray(record(row.payload).candidates) ? record(row.payload).candidates as unknown[] : [];
    return total + Math.max(0, candidates.length - MAX_SHORTLIST_PER_SOURCE_DAY);
  }, 0);
  if (shortlistTruncated) {
    gaps.push({ scope: "opportunities", reason: `盘后初筛每日每策略最多保留 ${MAX_SHORTLIST_PER_SOURCE_DAY} 只，${shortlistTruncated} 只候选未进入复盘` });
  }
  if (ultraRows.rows.length >= MAX_ULTRA_SHORT_OPPORTUNITIES) {
    gaps.push({ scope: "opportunities", reason: `超短关注池记录超过 ${MAX_ULTRA_SHORT_OPPORTUNITIES} 条，只保留前 ${MAX_ULTRA_SHORT_OPPORTUNITIES} 条` });
  }
  if (playbookRows.rows.length >= MAX_PLAYBOOK_OPPORTUNITIES) {
    gaps.push({ scope: "opportunities", reason: `收盘打板机会超过 ${MAX_PLAYBOOK_OPPORTUNITIES} 条，只保留排序前 ${MAX_PLAYBOOK_OPPORTUNITIES} 条` });
  }
  if (attentionRows.rows.length >= MAX_ATTENTION_OPPORTUNITIES) {
    gaps.push({ scope: "opportunities", reason: `策略关注条目超过 ${MAX_ATTENTION_OPPORTUNITIES} 条，只保留前 ${MAX_ATTENTION_OPPORTUNITIES} 条` });
  }
  if (!seeds.length) {
    // 零候选与“来源任务根本没跑”必须区分：有成功运行记录时，零机会是有效结论。
    const runs = (await db.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM job_run run JOIN job_definition definition ON definition.id = run.job_id
        WHERE run.target_date BETWEEN $1::date AND $2::date AND run.status IN ('success','partial')
          AND definition.code IN ('limit_up_close_scan','cross_strategy_selection','swing_signal_scan',
            'two_year_reversal_scan','value_anchor_opportunity_scan','nightly_sector_opportunity_scan','daily_plan_flow')`,
      [window.weekStart, window.weekEnd],
    )).rows[0]?.count ?? 0;
    if (runs === 0) {
      gaps.push({ scope: "opportunities", reason: "本周机会来源任务没有成功运行记录，无法判断是零机会还是缺数" });
    }
  }
  return seeds;
}

interface OppBar { date: string; open: number; high: number; low: number; close: number }

async function loadOpportunityPerformance(
  db: Db,
  seeds: OpportunitySeed[],
  window: Window,
  gaps: WeeklyReviewGap[],
): Promise<WeeklyReviewOpportunity[]> {
  const limitUpCodes = new Map<string, string[]>();
  const barsByCode = new Map<string, OppBar[]>();
  const codes = [...new Set(seeds.map((seed) => seed.code))];
  if (!codes.length || !window.weekStart || !window.weekEnd) return [];
  const [barRows, limitRows, industryRows] = await Promise.all([
    db.query<{ code: string; bar_date: string; open: number; high: number; low: number; close: number }>(
      `SELECT instrument.code, bar.bar_date::text, bar.open::float, bar.high::float, bar.low::float, bar.close::float
         FROM market_bar bar JOIN market_instrument instrument ON instrument.id = bar.instrument_id
        WHERE instrument.code = ANY($1::text[]) AND bar.freq = 'day'
          AND bar.bar_date BETWEEN $2::date AND $3::date
        ORDER BY instrument.code, bar.bar_date`,
      [codes, window.weekStart, window.weekEnd],
    ),
    db.query<{ code: string; trade_date: string }>(
      `SELECT instrument.code, event.trade_date::text
         FROM market_limit_event event JOIN market_instrument instrument ON instrument.id = event.instrument_id
        WHERE event.event_type = 'up' AND event.trade_date BETWEEN $2::date AND $3::date
          AND instrument.code = ANY($1::text[])
        ORDER BY event.trade_date`,
      [codes, window.weekStart, window.weekEnd],
    ),
    db.query<{ code: string; industry: string }>(
      `SELECT DISTINCT ON (instrument.code) instrument.code, board.name AS industry
         FROM market_instrument instrument
         JOIN market_board_membership membership
           ON membership.member_instrument_id = instrument.id AND membership.effective_to IS NULL
         JOIN market_instrument board ON board.id = membership.board_instrument_id
         JOIN market_board catalog ON catalog.instrument_id = board.id
        WHERE instrument.code = ANY($1::text[]) AND catalog.board_type = 'industry' AND catalog.active
          AND board.code LIKE '881%.TI'
        ORDER BY instrument.code, board.code`,
      [codes],
    ),
  ]);
  for (const row of barRows.rows) {
    const list = barsByCode.get(row.code) ?? [];
    list.push({
      date: row.bar_date,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
    });
    barsByCode.set(row.code, list);
  }
  for (const row of limitRows.rows) {
    const list = limitUpCodes.get(row.code) ?? [];
    list.push(row.trade_date);
    limitUpCodes.set(row.code, list);
  }
  const industries = new Map(industryRows.rows.map((row) => [row.code, row.industry]));

  const merged = new Map<string, WeeklyReviewOpportunity>();
  for (const seed of seeds) {
    const key = `${seed.source}|${seed.signalDate ?? "pending"}|${seed.code}`;
    const existing = merged.get(key);
    if (existing) {
      if (seed.strategyCode && !existing.strategy_codes.includes(seed.strategyCode)) {
        existing.strategy_codes.push(seed.strategyCode);
      }
      continue;
    }
    merged.set(key, {
      source: seed.source,
      source_label: OPPORTUNITY_SOURCE_LABELS[seed.source],
      produced_date: seed.producedDate,
      signal_date: seed.signalDate,
      code: seed.code,
      name: seed.name,
      industry: industries.get(seed.code) ?? null,
      strategy_codes: seed.strategyCode ? [seed.strategyCode] : [],
      status: seed.status,
      note: seed.note,
      performance: {
        status: "pending", entry_date: seed.signalDate, entry_price: null, last_bar_date: null,
        window_close: null, return_pct: null, max_gain_pct: null, max_drawdown_pct: null,
        bar_count: 0, limit_up_days: 0,
      },
    });
  }
  let missingBars = 0;
  if (merged.size > MAX_OPPORTUNITIES) {
    gaps.push({ scope: "opportunities", reason: `本周机会记录 ${merged.size} 条，超过 ${MAX_OPPORTUNITIES} 条上限，按信号日和来源截取` });
  }
  const opportunities = [...merged.values()]
    .sort((left, right) => (left.signal_date ?? "9999").localeCompare(right.signal_date ?? "9999")
      || left.source.localeCompare(right.source) || left.code.localeCompare(right.code))
    .slice(0, MAX_OPPORTUNITIES);
  for (const opportunity of opportunities) {
    const bars = barsByCode.get(opportunity.code) ?? [];
    const signalDate = opportunity.signal_date;
    const limitDates = limitUpCodes.get(opportunity.code) ?? [];
    if (!signalDate) {
      opportunity.performance = { ...opportunity.performance, status: "pending" };
      continue;
    }
    if (signalDate > window.weekEnd) {
      opportunity.performance = { ...opportunity.performance, status: "pending" };
      continue;
    }
    const entryBar = bars.find((bar) => bar.date === signalDate);
    const windowBars = bars.filter((bar) => bar.date >= signalDate);
    if (!entryBar || !windowBars.length) {
      missingBars += 1;
      opportunity.performance = { ...opportunity.performance, status: "missing_data", entry_date: signalDate };
      continue;
    }
    const last = windowBars[windowBars.length - 1]!;
    const highest = Math.max(...windowBars.map((bar) => bar.high));
    const lowest = Math.min(...windowBars.map((bar) => bar.low));
    opportunity.performance = {
      status: "evaluated",
      entry_date: signalDate,
      entry_price: round2(entryBar.open),
      last_bar_date: last.date,
      window_close: round2(last.close),
      return_pct: pctChange(last.close, entryBar.open),
      max_gain_pct: pctChange(highest, entryBar.open),
      max_drawdown_pct: pctChange(lowest, entryBar.open),
      bar_count: windowBars.length,
      limit_up_days: limitDates.filter((date) => date >= signalDate && date <= last.date).length,
    };
  }
  if (missingBars) {
    gaps.push({ scope: "opportunity_bars", reason: `${missingBars} 条机会记录缺少信号日或其后的日线，未计入胜负统计` });
  }
  return opportunities;
}

function summarizeOpportunities(opportunities: WeeklyReviewOpportunity[]): OpportunitySummary[] {
  return (Object.keys(OPPORTUNITY_SOURCE_LABELS) as OpportunitySource[]).map((source) => {
    const rows = opportunities.filter((opportunity) => opportunity.source === source);
    const evaluated = rows.filter((row) => row.performance.status === "evaluated" && row.performance.return_pct !== null);
    const returns = evaluated.map((row) => row.performance.return_pct!);
    const wins = returns.filter((value) => value > 0).length;
    const losses = returns.filter((value) => value < 0).length;
    const flat = returns.filter((value) => value === 0).length;
    const best = evaluated.reduce<WeeklyReviewOpportunity | null>((current, row) =>
      !current || row.performance.return_pct! > current.performance.return_pct! ? row : current, null);
    const worst = evaluated.reduce<WeeklyReviewOpportunity | null>((current, row) =>
      !current || row.performance.return_pct! < current.performance.return_pct! ? row : current, null);
    return {
      source,
      source_label: OPPORTUNITY_SOURCE_LABELS[source],
      count: rows.length,
      evaluated: evaluated.length,
      wins,
      losses,
      flat,
      win_rate_pct: evaluated.length ? round2((wins / evaluated.length) * 100) : null,
      avg_return_pct: returns.length ? round2(returns.reduce((total, value) => total + value, 0) / returns.length) : null,
      median_return_pct: median(returns),
      best: best ? { code: best.code, name: best.name, return_pct: best.performance.return_pct! } : null,
      worst: worst ? { code: worst.code, name: worst.name, return_pct: worst.performance.return_pct! } : null,
      pending: rows.filter((row) => row.performance.status === "pending").length,
      missing_data: rows.filter((row) => row.performance.status === "missing_data").length,
    };
  }).filter((summary) => summary.count > 0);
}

interface BarRow { code: string; date: string; close: number; turnover: number | null }

async function loadBars(db: Db, codes: string[], from: string, to: string): Promise<Map<string, BarRow[]>> {
  const map = new Map<string, BarRow[]>();
  if (!codes.length) return map;
  const rows = (await db.query<{ code: string; bar_date: string; close: number; turnover: number | null }>(
    `SELECT instrument.code, bar.bar_date::text, bar.close::float, bar.turnover::float
       FROM market_bar bar JOIN market_instrument instrument ON instrument.id = bar.instrument_id
      WHERE instrument.code = ANY($1::text[]) AND bar.freq = 'day'
        AND bar.bar_date BETWEEN $2::date AND $3::date
      ORDER BY instrument.code, bar.bar_date`,
    [codes, from, to],
  )).rows;
  for (const row of rows) {
    const list = map.get(row.code) ?? [];
    list.push({ code: row.code, date: row.bar_date, close: Number(row.close), turnover: row.turnover === null ? null : Number(row.turnover) });
    map.set(row.code, list);
  }
  return map;
}

function closeOn(bars: BarRow[], date: string | null): number | null {
  if (!date) return null;
  let found: number | null = null;
  for (const bar of bars) {
    if (bar.date <= date) found = bar.close;
    else break;
  }
  return found;
}

function turnoverBetween(bars: BarRow[], from: string, to: string): number | null {
  return sumOrNull(bars.filter((bar) => bar.date >= from && bar.date <= to).map((bar) => bar.turnover));
}

async function loadMarket(db: Db, window: Window, gaps: WeeklyReviewGap[]): Promise<WeeklyReviewMarket> {
  const empty: WeeklyReviewMarket = {
    indices: [],
    sectors: [],
    sector_summary: { active_board_count: 0, covered_board_count: 0, up_count: 0, down_count: 0, median_pct_week: null, top: [], bottom: [] },
    breadth: [],
  };
  const weekStart = window.weekStart;
  const weekEnd = window.weekEnd;
  if (!weekStart || !weekEnd) return empty;
  const sectorRows = (await db.query<{ code: string; name: string }>(
    `SELECT instrument.code, instrument.name
       FROM market_board catalog JOIN market_instrument instrument ON instrument.id = catalog.instrument_id
      WHERE catalog.board_type = 'industry' AND catalog.active AND instrument.code LIKE '881%.TI'
      ORDER BY instrument.code`,
  )).rows;
  const pastOpen = window.openDays.filter((date) => date <= weekEnd);
  const from = pastOpen[0] ?? addDays(weekStart, -30);
  const codes = [...WEEKLY_REVIEW_INDEXES.map((index) => index.code), ...sectorRows.map((row) => row.code)];
  const barsByCode = await loadBars(db, codes, from, weekEnd);
  const monthBase = pastOpen.length > 20 ? pastOpen[pastOpen.length - 21]! : null;
  const beforeWeek = pastOpen.filter((date) => date < weekStart);
  const previousWeekDays = beforeWeek.slice(-5);
  const previousWeekStart = previousWeekDays[0] ?? null;
  const beforePreviousWeekStart = previousWeekStart
    ? beforeWeek.filter((date) => date < previousWeekStart).at(-1) ?? null
    : null;

  const indices: WeeklyReviewIndex[] = [];
  const missingIndexes: string[] = [];
  for (const index of WEEKLY_REVIEW_INDEXES) {
    const bars = barsByCode.get(index.code) ?? [];
    if (!bars.length) {
      missingIndexes.push(index.code);
      continue;
    }
    const endClose = closeOn(bars, weekEnd);
    const startClose = closeOn(bars, window.previousWeekEnd);
    const days: WeeklyReviewIndex["days"] = [];
    let previous = startClose;
    for (const date of window.tradingDays) {
      const close = closeOn(bars, date);
      if (close === null) continue;
      days.push({ date, close: round2(close)!, pct: pctChange(close, previous) });
      previous = close;
    }
    const turnoverWeek = turnoverBetween(bars, weekStart, weekEnd);
    const turnoverLast = previousWeekStart ? turnoverBetween(bars, previousWeekStart, window.previousWeekEnd ?? previousWeekStart) : null;
    indices.push({
      code: index.code,
      name: index.name,
      pct_week: pctChange(endClose, startClose),
      pct_last_week: pctChange(startClose, closeOn(bars, beforePreviousWeekStart)),
      pct_4w: pctChange(endClose, closeOn(bars, monthBase)),
      turnover_week: turnoverWeek,
      turnover_change_pct: pctChange(turnoverWeek, turnoverLast),
      days,
    });
  }
  if (missingIndexes.length) {
    gaps.push({ scope: "market_index", reason: `指数日线缺口：${missingIndexes.join("、")}` });
  }
  if (indices.length && indices.every((index) => index.turnover_week === null)) {
    gaps.push({ scope: "market_turnover", reason: "指数日线没有成交额字段，本周成交额变化不可用" });
  }

  const sectors: WeeklyReviewSector[] = [];
  for (const sector of sectorRows) {
    const bars = barsByCode.get(sector.code) ?? [];
    if (!bars.length) continue;
    sectors.push({
      code: sector.code,
      name: sector.name,
      pct_week: pctChange(closeOn(bars, weekEnd), closeOn(bars, window.previousWeekEnd)),
      pct_last_week: pctChange(closeOn(bars, window.previousWeekEnd), closeOn(bars, beforePreviousWeekStart)),
      pct_4w: pctChange(closeOn(bars, weekEnd), closeOn(bars, monthBase)),
      rank: null,
    });
  }
  const ranked = [...sectors]
    .filter((sector) => sector.pct_week !== null)
    .sort((left, right) => (right.pct_week ?? 0) - (left.pct_week ?? 0));
  ranked.forEach((sector, position) => { sector.rank = position + 1; });
  const pctWeekly = ranked.map((sector) => sector.pct_week!);
  if (sectorRows.length && sectors.length < Math.ceil(sectorRows.length * 0.8)) {
    gaps.push({ scope: "sector_coverage", reason: `881 一级行业日线覆盖不足：${sectors.length}/${sectorRows.length}` });
  }
  const sectorSummary: WeeklyReviewMarket["sector_summary"] = {
    active_board_count: sectorRows.length,
    covered_board_count: sectors.length,
    up_count: pctWeekly.filter((value) => value > 0).length,
    down_count: pctWeekly.filter((value) => value < 0).length,
    median_pct_week: median(pctWeekly),
    top: ranked.slice(0, MAX_SECTOR_LIST),
    bottom: ranked.slice(-MAX_SECTOR_LIST).reverse(),
  };

  const breadth = await loadBreadth(db, window, gaps);
  return { indices, sectors, sector_summary: sectorSummary, breadth };
}

async function loadBreadth(db: Db, window: Window, gaps: WeeklyReviewGap[]): Promise<WeeklyReviewBreadthDay[]> {
  if (!window.weekStart || !window.weekEnd) return [];
  const lookback = addDays(window.weekStart, -20);
  const [limitRows, flowRows] = await Promise.all([
    db.query<{ trade_date: string; limit_up: number; limit_down: number; break_count: number; max_streak: number | null }>(
      `SELECT trade_date::text,
              count(*) FILTER (WHERE event_type = 'up')::int AS limit_up,
              count(*) FILTER (WHERE event_type = 'down')::int AS limit_down,
              count(*) FILTER (WHERE event_type = 'break')::int AS break_count,
              max(streak_count) FILTER (WHERE event_type = 'up')::int AS max_streak
         FROM market_limit_event WHERE trade_date BETWEEN $1::date AND $2::date
        GROUP BY trade_date ORDER BY trade_date`,
      [window.weekStart, window.weekEnd],
    ),
    db.query<{ date: string; advancing: number; declining: number; stock_sample: number; median_pct: number | null }>(
      `WITH bars AS (
         SELECT bar.instrument_id, bar.bar_date, bar.close::float AS close,
                lag(bar.close) OVER (PARTITION BY bar.instrument_id ORDER BY bar.bar_date)::float AS prev_close
           FROM market_bar bar JOIN market_instrument instrument ON instrument.id = bar.instrument_id
          WHERE bar.freq = 'day' AND instrument.kind = 'stock'
            AND bar.bar_date BETWEEN $1::date AND $2::date
       )
       SELECT bar_date::text AS date,
              count(*) FILTER (WHERE close > prev_close)::int AS advancing,
              count(*) FILTER (WHERE close < prev_close)::int AS declining,
              count(*)::int AS stock_sample,
              (percentile_cont(0.5) WITHIN GROUP (ORDER BY close / NULLIF(prev_close, 0) - 1) * 100)::float AS median_pct
         FROM bars
        WHERE prev_close IS NOT NULL AND bar_date BETWEEN $3::date AND $2::date
        GROUP BY bar_date ORDER BY bar_date`,
      [lookback, window.weekEnd, window.weekStart],
    ),
  ]);
  const limitByDate = new Map(limitRows.rows.map((row) => [row.trade_date, row]));
  const flowByDate = new Map(flowRows.rows.map((row) => [row.date, row]));
  const missingLimit: string[] = [];
  const missingFlow: string[] = [];
  const days = window.tradingDays.map((date) => {
    const limit = limitByDate.get(date);
    const flow = flowByDate.get(date);
    if (!limit) missingLimit.push(date);
    if (!flow) missingFlow.push(date);
    return {
      date,
      limit_up: limit ? Number(limit.limit_up) : null,
      limit_down: limit ? Number(limit.limit_down) : null,
      break_count: limit ? Number(limit.break_count) : null,
      max_streak: limit?.max_streak === null || limit?.max_streak === undefined ? null : Number(limit.max_streak),
      advancing: flow ? Number(flow.advancing) : null,
      declining: flow ? Number(flow.declining) : null,
      stock_sample: flow ? Number(flow.stock_sample) : null,
      median_pct: flow?.median_pct === null || flow?.median_pct === undefined ? null : round2(Number(flow.median_pct)),
    };
  });
  if (missingLimit.length) gaps.push({ scope: "limit_events", reason: `涨跌停事件缺口：${missingLimit.join("、")}` });
  if (missingFlow.length) gaps.push({ scope: "breadth", reason: `全市场涨跌家数缺口：${missingFlow.join("、")}` });
  return days;
}

function buildSummary(input: {
  accounts: WeeklyReviewAccountWeek[];
  positions: WeeklyReviewPosition[];
  trades: WeeklyReviewTrade[];
  realized: WeeklyReviewRealized[];
  opportunities: WeeklyReviewOpportunity[];
}): WeeklyReviewSummary {
  const evaluated = input.opportunities.filter((item) =>
    item.performance.status === "evaluated" && item.performance.return_pct !== null);
  const wins = evaluated.filter((item) => item.performance.return_pct! > 0).length;
  return {
    account_count: input.accounts.length,
    position_count: input.positions.length,
    position_market_value: sumOrNull(input.positions.map((position) => position.market_value)),
    position_unrealized_pnl: sumOrNull(input.positions.map((position) => position.pnl_amount)),
    position_week_pnl: sumOrNull(input.positions.map((position) => position.week_pnl_amount)),
    week_realized_pnl: round2(input.realized.reduce((total, row) => total + row.realized_pnl, 0)) ?? 0,
    trade_count: input.trades.length,
    opportunity_count: input.opportunities.length,
    evaluated_opportunity_count: evaluated.length,
    win_rate_pct: evaluated.length ? round2((wins / evaluated.length) * 100) : null,
  };
}

/** 构建一份周快照；只读数据库，任何缺数写入 gaps，不抛业务错误。 */
export async function buildWeeklyReviewSnapshot(
  db: Db,
  targetDate: string,
  options: { now?: Date } = {},
): Promise<WeeklyReviewSnapshot> {
  const now = options.now ?? new Date();
  const window = await resolveWindow(db, targetDate);
  const gaps: WeeklyReviewGap[] = [...window.gaps];
  const accounts = (await db.query<{ id: string; name: string }>(
    "SELECT id::text, name FROM portfolio_account WHERE status = 'active' ORDER BY id",
  )).rows;
  if (!accounts.length) gaps.push({ scope: "accounts", reason: "没有 active 账户，持仓与成交复盘为空" });
  const [positions, equity, tradeResult, seeds] = await Promise.all([
    loadPositions(db, window, gaps),
    loadEquity(db, window, accounts, gaps),
    loadTrades(db, window, gaps),
    collectOpportunities(db, window, gaps),
  ]);
  const opportunities = await loadOpportunityPerformance(db, seeds, window, gaps);
  const market = await loadMarket(db, window, gaps);
  const opportunitySummary = summarizeOpportunities(opportunities);
  const summary = buildSummary({
    accounts: equity, positions, trades: tradeResult.trades, realized: tradeResult.realized, opportunities,
  });
  return {
    version: WEEKLY_REVIEW_VERSION,
    target_date: targetDate,
    week_start: window.weekStart,
    week_end: window.weekEnd,
    previous_week_end: window.previousWeekEnd,
    trading_days: window.tradingDays,
    status: gaps.length ? "partial" : "success",
    summary,
    accounts: equity,
    positions,
    trades: tradeResult.trades,
    realized: tradeResult.realized,
    opportunities,
    opportunity_summary: opportunitySummary,
    market,
    gaps,
    built_at: now.toISOString(),
  };
}

/** 每个任务运行只保留一份快照；重试覆盖，避免重复口径。 */
export async function saveWeeklyReviewSnapshot(
  db: Db, runId: string, snapshot: WeeklyReviewSnapshot,
): Promise<void> {
  await db.query(
    `INSERT INTO weekly_review_snapshot (run_id, version, target_date, week_start, week_end, status, payload, gaps)
     VALUES ($1, $2, $3::date, $4::date, $5::date, $6, $7::jsonb, $8::jsonb)
     ON CONFLICT (run_id) DO UPDATE SET
       version = EXCLUDED.version, target_date = EXCLUDED.target_date,
       week_start = EXCLUDED.week_start, week_end = EXCLUDED.week_end,
       status = EXCLUDED.status, payload = EXCLUDED.payload, gaps = EXCLUDED.gaps, built_at = now()`,
    [
      runId, snapshot.version, snapshot.target_date, snapshot.week_start, snapshot.week_end,
      snapshot.status, JSON.stringify(snapshot), JSON.stringify(snapshot.gaps),
    ],
  );
}

/** 任务工具读取：按目标日取最近一次快照；不传目标日取最新一份。 */
export async function loadWeeklyReviewSnapshot(
  db: Db, targetDate?: string,
): Promise<WeeklyReviewSnapshotRow | null> {
  const row = (await db.query<WeeklyReviewSnapshotRow>(
    `SELECT run_id::text, version, target_date::text, week_start::text, week_end::text,
            status, payload, gaps, built_at::text
       FROM weekly_review_snapshot
      WHERE ($1::date IS NULL OR target_date = $1::date)
      ORDER BY built_at DESC, run_id DESC LIMIT 1`,
    [targetDate ?? null],
  )).rows[0];
  return row ?? null;
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function signed(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value > 0 ? "+" : ""}${money(value)}`;
}

function positionLine(position: WeeklyReviewPosition): string {
  const pnl = position.pnl_amount === null
    ? "浮盈 —"
    : `浮盈 ${signed(position.pnl_amount)}（${percent(position.pnl_ratio_pct)}）`;
  return `- ${position.name}（${position.code}）｜${position.account_name}｜${money(position.quantity)} 股｜成本 ${money(position.cost_price)}｜收盘 ${money(position.close)}｜本周 ${percent(position.week_pct)}（${signed(position.week_pnl_amount)}）｜${pnl}｜买入日 ${position.opened_at ?? "—"}｜归因 ${position.strategy_name ?? position.strategy_code ?? "未标注"}`;
}

function tradeLine(trade: WeeklyReviewTrade): string {
  const kind = trade.kind === "buy" ? "买入" : trade.kind === "sell" ? "卖出" : trade.kind;
  const realized = trade.realized_pnl === null ? "" : `｜已实现 ${signed(trade.realized_pnl)}`;
  return `- ${trade.change_date}｜${trade.account_name}｜${kind} ${trade.name}（${trade.code}）｜${money(trade.quantity)} 股 @ ${money(trade.price)}｜金额 ${money(trade.amount)}${realized}｜来源 ${trade.decision_origin ?? "—"}｜执行 ${trade.execution_compliance ?? "—"}${trade.reason ? `｜理由：${trade.reason.slice(0, 80)}` : ""}`;
}

function opportunityLine(opportunity: WeeklyReviewOpportunity): string {
  const performance = opportunity.performance;
  const outcome = performance.status === "evaluated"
    ? `信号日 ${performance.entry_date} 开盘 ${money(performance.entry_price)} → ${performance.last_bar_date} 收盘 ${money(performance.window_close)}，收益 ${percent(performance.return_pct)}，最大浮盈 ${percent(performance.max_gain_pct)}，最大回撤 ${percent(performance.max_drawdown_pct)}，涨停 ${performance.limit_up_days} 次`
    : performance.status === "pending"
      ? (performance.entry_date ?? opportunity.signal_date)
        ? `信号生效日 ${performance.entry_date ?? opportunity.signal_date} 在本次复盘窗口之后，本周不计入评价`
        : "无法确定信号生效日（交易日历缺口），本周不计入评价"
      : "缺少信号日之后的日线，未计入统计";
  return `- [${opportunity.source_label}] ${opportunity.produced_date} 产出 → ${opportunity.name}（${opportunity.code}）${opportunity.industry ? `｜${opportunity.industry}` : ""}${opportunity.strategy_codes.length ? `｜策略 ${opportunity.strategy_codes.join("、")}` : ""}${opportunity.status ? `｜状态 ${opportunity.status}` : ""}｜${outcome}`;
}

/** 注入任务提示词的紧凑事实摘要；完整结构由 weekly_review_context_query 返回。 */
export function renderWeeklyReviewContext(snapshot: WeeklyReviewSnapshot): string {
  const windowLine = snapshot.week_start && snapshot.week_end
    ? `复盘窗口 ${snapshot.week_start} 至 ${snapshot.week_end}（目标日 ${snapshot.target_date}，上一周末 ${snapshot.previous_week_end ?? "—"}，开市日 ${snapshot.trading_days.length} 天）`
    : `目标日 ${snapshot.target_date}：无法确定复盘窗口`;
  const accounts = snapshot.accounts.length
    ? snapshot.accounts.map((account) => `${account.account_name}：净值 ${money(account.equity_end)}（本周 ${percent(account.equity_change_pct)}，期初 ${money(account.equity_start)}；含现金变动，不等于收益率），现金 ${money(account.cash_end)}，持仓市值 ${money(account.market_value_end)}`)
    : ["无 active 账户"];
  const positionLines = snapshot.positions.slice(0, 30).map(positionLine);
  if (snapshot.positions.length > 30) positionLines.push(`- 另有 ${snapshot.positions.length - 30} 只持仓，见 weekly_review_context_query`);
  const tradeLines = snapshot.trades.slice(0, 40).map(tradeLine);
  if (snapshot.trades.length > 40) tradeLines.push(`- 另有 ${snapshot.trades.length - 40} 笔本周事件，见 weekly_review_context_query`);
  const opportunityLines = snapshot.opportunities.slice(0, 40).map(opportunityLine);
  if (snapshot.opportunities.length > 40) opportunityLines.push(`- 另有 ${snapshot.opportunities.length - 40} 条机会记录，见 weekly_review_context_query`);
  const indexLines = snapshot.market.indices.map((index) =>
    `- ${index.name}（${index.code}）：本周 ${percent(index.pct_week)}｜上周 ${percent(index.pct_last_week)}｜近20个交易日 ${percent(index.pct_4w)}｜本周成交额 ${money(index.turnover_week)}（较上周 ${percent(index.turnover_change_pct)}）｜逐日 ${index.days.map((day) => `${day.date} ${percent(day.pct)}`).join("，")}`);
  const sector = snapshot.market.sector_summary;
  const sectorLines = [
    `- 881 一级行业覆盖 ${sector.covered_board_count}/${sector.active_board_count}，本周上涨 ${sector.up_count} 个、下跌 ${sector.down_count} 个，中位数 ${percent(sector.median_pct_week)}`,
    `- 领涨：${sector.top.map((item) => `${item.name} ${percent(item.pct_week)}`).join("；") || "—"}`,
    `- 领跌：${sector.bottom.map((item) => `${item.name} ${percent(item.pct_week)}`).join("；") || "—"}`,
  ];
  const breadthLines = snapshot.market.breadth.map((day) =>
    `- ${day.date}：涨停 ${day.limit_up ?? "—"}｜跌停 ${day.limit_down ?? "—"}｜炸板 ${day.break_count ?? "—"}｜最高 ${day.max_streak ?? "—"} 板｜涨跌家数 ${day.advancing ?? "—"}:${day.declining ?? "—"}（样本 ${day.stock_sample ?? "—"}）｜中位涨幅 ${percent(day.median_pct)}`);
  const gapLines = snapshot.gaps.map((gap) => `- [${gap.scope}] ${gap.reason}`);
  return [
    "## 服务端周复盘事实快照（只读，已写入 weekly_review_snapshot）",
    "",
    `- ${windowLine}`,
    `- 汇总：账户 ${snapshot.summary.account_count} 个｜持仓 ${snapshot.summary.position_count} 只｜持仓市值 ${money(snapshot.summary.position_market_value)}｜浮动盈亏 ${signed(snapshot.summary.position_unrealized_pnl)}｜本周持仓盈亏 ${signed(snapshot.summary.position_week_pnl)}｜本周已实现 ${signed(snapshot.summary.week_realized_pnl)}｜本周事件 ${snapshot.summary.trade_count} 笔｜机会标的 ${snapshot.summary.opportunity_count} 条（可评价 ${snapshot.summary.evaluated_opportunity_count}，胜率 ${percent(snapshot.summary.win_rate_pct)}）`,
    "",
    "### 账户净值",
    ...accounts.map((line) => `- ${line}`),
    "- 净值口径：portfolio_equity_daily 由每日计划盘前物化（T 日键使用上一交易日收盘估值），与持仓本周涨跌按收盘价计算存在一日口径差；净值变化还包含现金变动，不等于收益率。",
    "",
    "### 当前持仓",
    ...(positionLines.length ? positionLines : ["- 无持仓"]),
    "",
    "### 本周成交与调整事件",
    ...(tradeLines.length ? tradeLines : ["- 无成交或调整事件"]),
    "",
    "### 本周产出机会标的（评价口径：信号生效日开盘至窗口末收盘）",
    ...(snapshot.opportunity_summary.map((summary) =>
      `- ${summary.source_label}：${summary.count} 条，可评价 ${summary.evaluated}，盈利 ${summary.wins}／亏损 ${summary.losses}／持平 ${summary.flat}，胜率 ${percent(summary.win_rate_pct)}，平均收益 ${percent(summary.avg_return_pct)}，中位 ${percent(summary.median_return_pct)}，未生效 ${summary.pending}，缺数 ${summary.missing_data}${summary.best ? `，最好 ${summary.best.name}(${summary.best.code}) ${percent(summary.best.return_pct)}` : ""}${summary.worst ? `，最差 ${summary.worst.name}(${summary.worst.code}) ${percent(summary.worst.return_pct)}` : ""}`)),
    ...(opportunityLines.length ? opportunityLines : ["- 无机会记录"]),
    "",
    "### 指数",
    ...(indexLines.length ? indexLines : ["- 无指数日线"]),
    "",
    "### 板块",
    ...sectorLines,
    "",
    "### 每日市场宽度",
    ...(breadthLines.length ? breadthLines : ["- 无涨跌停或涨跌家数数据"]),
    "",
    "### 数据缺口",
    ...(gapLines.length ? gapLines : ["- 无"]),
    "",
    "完整逐标的走势、全部成交与板块排名请调用 weekly_review_context_query(date=目标日)，不要重复查询通用数据库表。",
  ].join("\n");
}
