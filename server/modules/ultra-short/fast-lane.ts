// 05 快速层：5 秒轮询“已买入持仓”，只做离场判定与提醒；不新开仓、不写盘中采样。
// 开板必须由连续两个快照确认（上一快照封板 + 本快照跌破涨停价），分级完全交给 exit.ts，
// 本文件只维护 ExitContext、关注池退出字段和 notification_delivery。
import type pg from "pg";
import { fetchSnapshot, snapshotDate, type SnapshotQuote } from "../../datasource/hithink.js";
import { fetchLimitPoolPage } from "../../datasource/hithink-special.js";
import { isScheduledTradingDay, shanghaiDate } from "../../scheduler/time.js";
import { sha256Json } from "../../agent/hash.js";
import { enqueueBatchAlert } from "../notifications/service.js";
import type { AlertCandidate } from "./alerts.js";
import { isWorkerEnabled, writeWorkerHeartbeat } from "../../scheduler/worker-status.js";
import { countTodayStopLosses, evaluateExit, resolveTradeLine } from "./exit.js";
import { listExitWatchlist, updateWatchlist, type WatchlistPatch } from "./repo.js";
import type {
  Db,
  ExitContext,
  ExitReason,
  UltraShortWatchlistRow,
} from "./types.js";

const DEFAULT_INTERVAL_MS = 5_000;
/** 快速层窗口：上海交易日 09:25（含）–15:00（不含）。 */
const WINDOW_START_MINUTES = 9 * 60 + 25;
const WINDOW_END_MINUTES = 15 * 60;
const LUNCH_START_MINUTES = 11 * 60 + 30;
const LUNCH_END_MINUTES = 13 * 60;
/** 封单层 15–30 秒刷新一次，这里取 30 秒缓存。 */
const POOL_CACHE_MS = 30_000;
/** 5 秒轮询下，90 秒未更新视为数据缺失，不用旧价提醒。 */
const QUOTE_STALE_MS = 90_000;
const QUOTE_FUTURE_MS = 30_000;
const SEALED_TOLERANCE = 0.005;
/** 退出检查覆盖最近 5 个交易日之前的关注池行。 */
const EXIT_WATCHLIST_TRADING_DAYS = 5;
/** 开板量比：最近 5 笔成交量增量的均值作为开板前均量。 */
const VOLUME_DELTA_SAMPLES = 5;

/** 涨停池 / 炸板池原始条目，字段以扶摇返回为准。 */
export interface FastLanePoolData {
  up: Record<string, unknown>[];
  break: Record<string, unknown>[];
}

export type FastLaneFetchQuotes = (codes: string[]) => Promise<SnapshotQuote[]>;
export type FastLaneFetchPools = (tradeDate: string) => Promise<FastLanePoolData>;

export type FastLaneNotifyDigest = (db: Db, content: string, eventKey: string) => Promise<boolean>;

/** 兼容旧测试的单条通知注入；生产不传，走汇总。 */
export type FastLaneAlertCandidate = AlertCandidate & { exit_stage?: number; trade_line?: "board" | "low_buy" | null };
export type FastLaneNotify = (
  db: Db,
  candidate: FastLaneAlertCandidate,
  decision: { action: "sell_half" | "sell_all"; reason: ExitReason; price: number | null; stop_price: number | null; r_multiple: number | null; note: string },
  at: Date,
) => Promise<boolean>;

export interface UltraShortFastLaneOptions {
  intervalMs?: number;
  fetchQuotes?: FastLaneFetchQuotes;
  fetchPools?: FastLaneFetchPools;
  now?: () => Date;
  notifyDigest?: FastLaneNotifyDigest;
  notify?: FastLaneNotify;
}

export interface UltraShortFastLaneSummary {
  trade_date: string;
  /** 本次真正进入判定（有效行情且满足 T+1 可卖）的行数。 */
  checked: number;
  /** 产生新退出动作的行数；同一行同原因同阶段的重复提醒不计入。 */
  exited: number;
  /** 实际入队成功的退出提醒数。 */
  reminded: number;
  /** 连亏熔断只报告，不阻止退出。 */
  circuit_broken: boolean;
  gaps: string[];
}

interface RowState {
  last_volume: number | null;
  volume_deltas: number[];
  /** 上一快照是否封住涨停；开板确认需要它为 true。 */
  last_sealed: boolean;
  last_sealed_at_ms: number | null;
  /** 本轮开板之前是否封过板；开板期间保持 true，供 exit.ts 判分级。 */
  sealed_before: boolean;
  open_confirmed: boolean;
  open_since_ms: number | null;
  open_count: number;
  max_seal_money: number | null;
  open_volume_baseline: number | null;
  open_volume_start: number | null;
  open_volume_ticks: number;
  open_volume_ratio: number | null;
}

function newRowState(): RowState {
  return {
    last_volume: null,
    volume_deltas: [],
    last_sealed: false,
    last_sealed_at_ms: null,
    sealed_before: false,
    open_confirmed: false,
    open_since_ms: null,
    open_count: 0,
    max_seal_money: null,
    open_volume_baseline: null,
    open_volume_start: null,
    open_volume_ticks: 0,
    open_volume_ratio: null,
  };
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function shanghaiMinuteOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(map.hour) * 60 + Number(map.minute);
}

/** 快速层只在上海交易日 09:25–11:30、13:00–15:00 运行；午休不轮询。 */
export function isFastLaneWindow(now: Date): boolean {
  const minutes = shanghaiMinuteOfDay(now);
  if (minutes < WINDOW_START_MINUTES || minutes >= WINDOW_END_MINUTES) return false;
  return minutes < LUNCH_START_MINUTES || minutes >= LUNCH_END_MINUTES;
}

function rowKey(row: Pick<UltraShortWatchlistRow, "target_date" | "code">): string {
  return `${row.target_date}:${row.code}`;
}

function buyDateOf(row: UltraShortWatchlistRow): string {
  const raw = row.position_opened_at?.trim();
  if (raw) {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
    if (match?.[1]) return match[1];
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return shanghaiDate(parsed);
  }
  return row.target_date;
}

function itemCode(item: Record<string, unknown>): string | null {
  for (const key of ["ticker", "code", "thscode"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function indexPool(items: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const code = itemCode(item);
    if (code !== null) index.set(code, item);
  }
  return index;
}

/** 交易日历缺行时按工作日估算持有天数，保证时间止损至少可降级运行。 */
function weekdayCount(from: string, to: string): number {
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime()) || cursor > end) return 1;
  let count = 0;
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day >= 1 && day <= 5) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return Math.max(1, count);
}

async function defaultFetchPools(pool: pg.Pool, tradeDate: string): Promise<FastLanePoolData> {
  const deps = { db: pool, priority: "interactive" as const };
  const [up, breaking] = await Promise.all([
    fetchLimitPoolPage("up", { tradeDate, page: 1, size: 200 }, deps),
    fetchLimitPoolPage("break", { tradeDate, page: 1, size: 200 }, deps),
  ]);
  return { up: up.items, break: breaking.items };
}

interface QuoteRead {
  ok: true;
  quote: SnapshotQuote;
  close: number;
}

interface QuoteRejected {
  ok: false;
  reason: string;
}

/**
 * 05 快速层：每 5 秒检查一次已买入的超短持仓。
 * 只处理已持有（holding/exit_triggered）行；新开仓与盘中触发仍归 01/02/04。
 */
export class UltraShortFastLane {
  private readonly pool: pg.Pool;
  private readonly intervalMs: number;
  private readonly fetchQuotes: FastLaneFetchQuotes;
  private readonly fetchPools: FastLaneFetchPools;
  private readonly clock: () => Date;
  private readonly notifyDigest: FastLaneNotifyDigest;
  private readonly notify: FastLaneNotify | null;
  private readonly states = new Map<string, RowState>();
  private stateTradeDate: string | null = null;
  private poolsCache: { trade_date: string; at: number; data: FastLanePoolData } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = true;

  constructor(pool: pg.Pool, options: UltraShortFastLaneOptions = {}) {
    this.pool = pool;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.fetchQuotes = options.fetchQuotes
      ?? ((codes) => fetchSnapshot(codes, { db: pool, priority: "interactive" }, "stock"));
    this.fetchPools = options.fetchPools ?? ((tradeDate) => defaultFetchPools(pool, tradeDate));
    this.clock = options.now ?? (() => new Date());
    this.notifyDigest = options.notifyDigest
      ?? ((db, content, eventKey) => enqueueBatchAlert(db, { kind: "ultra_short", event_key: eventKey, content }));
    this.notify = options.notify ?? null;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  /** 单次 tick：窗口/交易日门禁失败返回 null；busy 防重入同样返回 null。 */
  async tick(): Promise<UltraShortFastLaneSummary | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const now = this.clock();
      if (!isFastLaneWindow(now)) return null;
      const tradeDate = shanghaiDate(now);
      if (!(await isScheduledTradingDay(this.pool, tradeDate))) return null;
      if (!(await isWorkerEnabled(this.pool, "ultra_short_exit_watch"))) return null;
      await writeWorkerHeartbeat(this.pool, "ultra_short_exit_watch", { status: "running", trade_date: tradeDate });
      if (this.stateTradeDate !== tradeDate) {
        this.states.clear();
        this.stateTradeDate = tradeDate;
      }
      return await this.runTick(now, tradeDate);
    } finally {
      this.busy = false;
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.runScheduled(), delay);
    this.timer.unref?.();
  }

  private async runScheduled(): Promise<void> {
    try {
      const summary = await this.tick();
      if (summary) {
        await writeWorkerHeartbeat(this.pool, "ultra_short_exit_watch", {
          status: "success", trade_date: summary.trade_date,
          summary: `检查 ${summary.checked} 只；退出 ${summary.exited} 只`,
        }).catch(() => {});
      }
    } catch (error) {
      await writeWorkerHeartbeat(this.pool, "ultra_short_exit_watch", {
        status: "failed", error: (error as Error).message,
      }).catch(() => {});
      console.error(`[ultra-short-fast-lane] ${(error as Error).message}`);
    }
    this.schedule(this.intervalMs);
  }

  private async runTick(now: Date, tradeDate: string): Promise<UltraShortFastLaneSummary> {
    const gaps: string[] = [];
    const circuitBroken = await this.countCircuit(tradeDate, gaps);
    const fromDate = await this.exitWatchFromDate(tradeDate, now, gaps);
    const rows = await listExitWatchlist(this.pool, fromDate, tradeDate);
    if (rows.length === 0) {
      return { trade_date: tradeDate, checked: 0, exited: 0, reminded: 0, circuit_broken: circuitBroken, gaps: [...new Set(gaps)] };
    }

    const quotes = await this.loadQuotes(rows, gaps);
    const holdingDays = await this.holdingDaysMap(rows, tradeDate, gaps);
    let pools = await this.getPools(tradeDate, now, false, gaps);
    let poolIndex = { up: indexPool(pools.up), break: indexPool(pools.break) };

    let checked = 0;
    let exited = 0;
    let reminded = 0;
    let refreshedOnOpen = false;
    const lines: string[] = [];

    for (const row of rows) {
      const key = rowKey(row);
      const days = holdingDays.get(key) ?? 1;
      // T+1 硬约束：买入当日只做次日计划，不发出离场提醒。
      if (days < 2) continue;
      const read = this.readQuote(quotes.get(row.code) ?? null, now, tradeDate);
      if (!read.ok) {
        gaps.push(`${row.code}：${read.reason}`);
        continue;
      }
      checked += 1;

      const state = this.rowState(key);
      const limitUpPrice = positiveNumber(row.key_levels.limit_up_price);
      const sealedNow = limitUpPrice === null
        ? null
        : read.close >= limitUpPrice - SEALED_TOLERANCE;
      const justOpened = this.applyQuoteState(state, read.quote, sealedNow);

      // 首次检测到开板立即刷新一次封单池，避免 30 秒缓存给出开板前旧封单。
      if (justOpened && !refreshedOnOpen) {
        refreshedOnOpen = true;
        pools = await this.getPools(tradeDate, now, true, gaps);
        poolIndex = { up: indexPool(pools.up), break: indexPool(pools.break) };
      }
      const upItem = poolIndex.up.get(row.code) ?? null;
      const breakItem = poolIndex.break.get(row.code) ?? null;

      const context = this.buildContext({
        row,
        state,
        tradeDate,
        now,
        holdingDays: days,
        limitUpPrice,
        upItem,
        breakItem,
        breakPool: pools.break,
        upCount: pools.up.length,
        quote: read.quote,
      });
      const decision = evaluateExit(row, { close: read.close }, context);
      if (decision.data_status === "insufficient") continue;
      const priceText = decision.price === null ? "—" : decision.price.toFixed(2);
      const actionLabel = decision.action === "sell_all" ? "清仓" : decision.action === "sell_half" ? "减仓" : "持有";
      lines.push(`${row.name} ${row.code} ${priceText} ${actionLabel}｜${decision.note}`);
      if (decision.action === "hold" || decision.reason === null) continue;

      const exitReason: ExitReason = decision.reason;
      const reminderType = `${exitReason}:${decision.next_stage}`;
      // 同一行同一原因同一阶段不再重复提醒；汇总消息内还有内容哈希兜底。
      if (row.exit_reminder_type === reminderType && row.exit_stage === decision.next_stage) continue;

      exited += 1;
      const patch: WatchlistPatch = {
        exit_status: "exit_triggered",
        exit_reason: exitReason,
        exit_stage: decision.next_stage,
        exit_reminder_at: now,
        exit_reminder_type: reminderType,
      };
      try {
        await updateWatchlist(this.pool, row.target_date, row.code, patch);
      } catch (error) {
        gaps.push(`${row.code}：退出字段回写失败（${(error as Error).message}）`);
      }
      if (this.notify) {
        const queued = await this.queueLegacyExit(row, { ...decision, action: decision.action as "sell_half" | "sell_all", reason: decision.reason as ExitReason }, now, gaps);
        if (queued) reminded += 1;
      }
    }

    if (!this.notify && exited > 0 && lines.length > 0) {
      const content = [
        `Stock｜超短持仓离场观察｜${now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`,
        "",
        ...lines,
      ].join("\n");
      const queued = await this.notifyDigest(this.pool, content, `ultra:exit_digest:${tradeDate}:${sha256Json(content)}`)
        .catch((error) => {
          gaps.push(`退出汇总入队失败：${(error as Error).message}`);
          return false;
        });
      if (queued) reminded = 1;
    }
    return {
      trade_date: tradeDate,
      checked,
      exited,
      reminded,
      circuit_broken: circuitBroken,
      gaps: [...new Set(gaps)],
    };
  }

  private rowState(key: string): RowState {
    const existing = this.states.get(key);
    if (existing) return existing;
    const created = newRowState();
    this.states.set(key, created);
    return created;
  }

  private async countCircuit(tradeDate: string, gaps: string[]): Promise<boolean> {
    try {
      return (await countTodayStopLosses(this.pool, tradeDate)) >= 2;
    } catch (error) {
      gaps.push(`连亏熔断统计：${(error as Error).message}`);
      return false;
    }
  }

  private async exitWatchFromDate(tradeDate: string, now: Date, gaps: string[]): Promise<string> {
    try {
      const result = await this.pool.query<{ trade_date: string | null }>(
        `SELECT trade_date::text AS trade_date FROM market_trading_day
          WHERE is_open AND trade_date <= $1::date
          ORDER BY trade_date DESC OFFSET $2 LIMIT 1`,
        [tradeDate, EXIT_WATCHLIST_TRADING_DAYS],
      );
      const fromDate = result.rows[0]?.trade_date;
      if (fromDate) return fromDate;
    } catch (error) {
      gaps.push(`交易日历：${(error as Error).message}`);
    }
    gaps.push("交易日历不足 6 个交易日，退出检查范围按自然日回退");
    return shanghaiDate(new Date(now.getTime() - 9 * 86_400_000));
  }

  private async loadQuotes(
    rows: UltraShortWatchlistRow[],
    gaps: string[],
  ): Promise<Map<string, SnapshotQuote>> {
    const codes = [...new Set(rows.map((row) => row.code))];
    if (codes.length === 0) return new Map();
    try {
      const quotes = await this.fetchQuotes(codes);
      return new Map(quotes.map((quote) => [quote.code, quote]));
    } catch (error) {
      gaps.push(`关注池快照：${(error as Error).message}`);
      return new Map();
    }
  }

  /** 持有天数：按 market_trading_day 计交易日，含买入日 D=1。 */
  private async holdingDaysMap(
    rows: UltraShortWatchlistRow[],
    tradeDate: string,
    gaps: string[],
  ): Promise<Map<string, number>> {
    const buyDates = new Map<string, string>();
    for (const row of rows) buyDates.set(rowKey(row), buyDateOf(row));
    const dates = [...buyDates.values()].sort();
    const minDate = dates[0];
    let openDates: string[] = [];
    if (minDate !== undefined) {
      try {
        const result = await this.pool.query<{ trade_date: string }>(
          `SELECT trade_date::text AS trade_date FROM market_trading_day
            WHERE is_open AND trade_date BETWEEN $1::date AND $2::date
            ORDER BY trade_date`,
          [minDate, tradeDate],
        );
        openDates = result.rows.map((item) => item.trade_date);
      } catch (error) {
        gaps.push(`交易日历：${(error as Error).message}`);
      }
    }
    if (openDates.length === 0) gaps.push("交易日历缺失，持有天数按工作日估算");
    const result = new Map<string, number>();
    for (const [key, buyDate] of buyDates) {
      const calendarDays = openDates.filter((date) => date >= buyDate).length;
      result.set(key, calendarDays > 0 ? calendarDays : weekdayCount(buyDate, tradeDate));
    }
    return result;
  }

  private async getPools(
    tradeDate: string,
    now: Date,
    force: boolean,
    gaps: string[],
  ): Promise<FastLanePoolData> {
    const cache = this.poolsCache;
    if (!force && cache !== null && cache.trade_date === tradeDate
      && now.getTime() - cache.at < POOL_CACHE_MS) {
      return cache.data;
    }
    try {
      const data = await this.fetchPools(tradeDate);
      this.poolsCache = { trade_date: tradeDate, at: now.getTime(), data };
      return data;
    } catch (error) {
      gaps.push(`涨停/炸板池：${(error as Error).message}`);
      return cache !== null && cache.trade_date === tradeDate ? cache.data : { up: [], break: [] };
    }
  }

  private readQuote(quote: SnapshotQuote | null, now: Date, tradeDate: string): QuoteRead | QuoteRejected {
    if (!quote) return { ok: false, reason: "缺行情快照" };
    if (!Number.isFinite(quote.timestampMs)) return { ok: false, reason: "快照缺时间戳" };
    if (quote.timestampMs > now.getTime() + QUOTE_FUTURE_MS) {
      return { ok: false, reason: "快照时间晚于当前，不使用未来数据" };
    }
    if (quote.timestampMs < now.getTime() - QUOTE_STALE_MS) {
      return { ok: false, reason: "快照超过 90 秒未更新" };
    }
    if (snapshotDate(quote) !== tradeDate) return { ok: false, reason: "快照不是当日行情" };
    const close = positiveNumber(quote.close);
    if (close === null) return { ok: false, reason: "快照价格无效" };
    return { ok: true, quote, close };
  }

  /**
   * 更新单行开板状态，返回本次是否首次确认开板。
   * 开板确认 = 上一快照封板（last_sealed）且本快照跌破涨停价，避免单次毛刺。
   */
  private applyQuoteState(state: RowState, quote: SnapshotQuote, sealedNow: boolean | null): boolean {
    const volume = finiteNumber(quote.volume);
    const preDeltas = state.volume_deltas.slice();
    const lastVolume = state.last_volume;
    if (volume !== null && lastVolume !== null && volume > lastVolume) {
      state.volume_deltas.push(volume - lastVolume);
      if (state.volume_deltas.length > VOLUME_DELTA_SAMPLES) state.volume_deltas.shift();
    }

    let justOpened = false;
    if (sealedNow === null) {
      // 缺涨停价无法判断是否开板，清掉上一笔封板标记，避免下一笔误判。
      state.last_sealed = false;
    } else if (state.open_confirmed) {
      if (sealedNow) {
        // 回封：结束本轮开板；开板次数保留，供下一次开板分级。
        state.open_confirmed = false;
        state.open_since_ms = null;
        state.open_volume_baseline = null;
        state.open_volume_start = null;
        state.open_volume_ticks = 0;
        state.open_volume_ratio = null;
        state.last_sealed = true;
        state.last_sealed_at_ms = quote.timestampMs;
      }
    } else if (sealedNow) {
      state.last_sealed = true;
      state.last_sealed_at_ms = quote.timestampMs;
      state.sealed_before = true;
    } else if (state.last_sealed) {
      state.open_confirmed = true;
      state.sealed_before = true;
      state.open_since_ms = state.last_sealed_at_ms ?? quote.timestampMs;
      state.open_count += 1;
      state.last_sealed = false;
      state.open_volume_baseline = mean(preDeltas);
      state.open_volume_start = lastVolume;
      state.open_volume_ticks = 0;
      state.open_volume_ratio = null;
      justOpened = true;
    } else {
      state.last_sealed = false;
    }

    if (state.open_confirmed) {
      state.open_volume_ticks += 1;
      const baseline = state.open_volume_baseline;
      if (baseline !== null && baseline > 0 && volume !== null && state.open_volume_start !== null) {
        const openedVolume = volume - state.open_volume_start;
        if (openedVolume >= 0) {
          state.open_volume_ratio = Number(
            ((openedVolume / state.open_volume_ticks) / baseline).toFixed(2),
          );
        }
      }
    }

    if (volume !== null && (state.last_volume === null || volume > state.last_volume)) {
      state.last_volume = volume;
    }
    return justOpened;
  }

  private async queueLegacyExit(
    row: UltraShortWatchlistRow,
    decision: { action: "sell_half" | "sell_all"; reason: ExitReason; price: number | null; stop_price: number | null; r_multiple: number | null; note: string; next_stage: number },
    now: Date,
    gaps: string[],
  ): Promise<boolean> {
    try {
      return await this.notify!(this.pool, {
        code: row.code, name: row.name, target_date: row.target_date,
        priority: row.priority, auction_priority: row.auction_priority,
        auction_branch: row.auction_branch, auction_fill_tier: row.auction_fill_tier,
        tags: row.tags, key_levels: row.key_levels as unknown as Record<string, unknown>,
        risk: row.risk as unknown as Record<string, unknown>,
        auction_metrics: row.auction_metrics, queue_window: row.queue_window,
        exit_stage: decision.next_stage, trade_line: resolveTradeLine(row),
      }, {
        action: decision.action, reason: decision.reason, price: decision.price,
        stop_price: decision.stop_price, r_multiple: decision.r_multiple, note: decision.note,
      }, now);
    } catch (error) {
      gaps.push(`${row.code}：退出提醒入队失败（${(error as Error).message}）`);
      return false;
    }
  }

  private buildContext(input: {
    row: UltraShortWatchlistRow;
    state: RowState;
    tradeDate: string;
    now: Date;
    holdingDays: number;
    limitUpPrice: number | null;
    upItem: Record<string, unknown> | null;
    breakItem: Record<string, unknown> | null;
    breakPool: Record<string, unknown>[];
    upCount: number;
    quote: SnapshotQuote;
  }): ExitContext {
    const { row, state, upItem, breakItem } = input;
    const line = resolveTradeLine(row);
    const poolSealMoney = finiteNumber(upItem?.seal_money);
    const poolMaxSealMoney = finiteNumber(upItem?.max_seal_money);
    if (poolSealMoney !== null) {
      state.max_seal_money = Math.max(state.max_seal_money ?? 0, poolSealMoney);
    }
    if (poolMaxSealMoney !== null) {
      state.max_seal_money = Math.max(state.max_seal_money ?? 0, poolMaxSealMoney);
    }
    const poolOpenCount = finiteNumber(upItem?.open_times) ?? finiteNumber(breakItem?.open_times);
    if (poolOpenCount !== null) state.open_count = Math.max(state.open_count, poolOpenCount);

    const currentStreak = finiteNumber(upItem?.continue_day_cnt)
      ?? finiteNumber(breakItem?.continue_day_cnt)
      ?? (row.streak_count === null
        ? null
        : line === "board" ? row.streak_count + 1 : row.streak_count);
    const sameHeightOpen = currentStreak !== null && input.breakPool.some((item) => (
      itemCode(item) !== row.code && finiteNumber(item.continue_day_cnt) === currentStreak
    ));
    const poolTotal = input.upCount + input.breakPool.length;

    return {
      trade_date: input.tradeDate,
      now: input.now,
      holding_days: input.holdingDays,
      sealed_before: state.sealed_before,
      open_since_ms: state.open_confirmed ? state.open_since_ms : null,
      open_count: state.open_count,
      seal_money: poolSealMoney,
      max_seal_money: finiteNumber(upItem?.max_seal_money) ?? state.max_seal_money,
      open_volume_ratio: state.open_confirmed ? state.open_volume_ratio : null,
      same_height_open: sameHeightOpen,
      market_break_rate: poolTotal > 0 ? input.breakPool.length / poolTotal : null,
      limit_up_price: input.limitUpPrice,
      open_pct: input.quote.prevClose && input.quote.prevClose > 0 && input.quote.open > 0
        ? Number((input.quote.open / input.quote.prevClose - 1) * 100)
        : null,
    };
  }
}
