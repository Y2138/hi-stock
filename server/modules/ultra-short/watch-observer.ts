// 超短未持仓盘中观察 worker（120 秒）：只观察 exit_status='none' 的关注池行，已持仓由 05 快速层负责。
// 代码只做输入组装、JSON 校验、字段回写、汇总提醒与内容哈希去重；观察/接近触发/触发/放弃全部交给 LLM，
// 这里不设确定性触发阈值、不自动下单、不写 exit_* 字段、不新增表或 job_run。
import type pg from "pg";
import { fetchSnapshot, snapshotDate, type SnapshotQuote } from "../../datasource/hithink.js";
import { getLlmConfigByModelKey } from "../../agent/ai/repo.js";
import { resolveActiveChatModel } from "../../agent/ai/runtime.js";
import { sha256Json } from "../../agent/hash.js";
import { isScheduledTradingDay, shanghaiDate } from "../../scheduler/time.js";
import { enqueueBatchAlert } from "../notifications/service.js";
import { readIntradaySentiment } from "../intraday-risk/sentiment.js";
import { isWorkerEnabled, writeWorkerHeartbeat, type WorkerHeartbeat } from "../../scheduler/worker-status.js";
import { isIntradayWindow, writeWatchSample } from "./sampling.js";
import { listWatchlist, updateWatchlist, type WatchlistPatch } from "./repo.js";
import type { Db, IntradayStatus, UltraShortWatchlistRow } from "./types.js";

export const ULTRA_SHORT_WATCH_WORKER_CODE = "ultra_short_watch_observe";
export const ULTRA_SHORT_WATCH_INTERVAL_MS = 120_000;
const MODEL_KEY = "GLM-5.3-Flash";
/** 观察窗口与 04 一致：上海 09:30（含）–10:30（不含）。 */
export const isWatchWindow = isIntradayWindow;
/** 快照迟到 90 秒只作上下文，不当作最新价；未来 30 秒视为数据异常。 */
const QUOTE_STALE_MS = 90_000;
const QUOTE_FUTURE_MS = 30_000;

const WATCH_ACTIONS = ["观察", "接近触发", "触发", "放弃"] as const;
export type WatchAction = (typeof WATCH_ACTIONS)[number];

/** LLM 动作到关注池 intraday_status 的映射；接近触发仍保持 waiting。 */
const ACTION_STATUS: Record<WatchAction, IntradayStatus> = {
  观察: "waiting",
  接近触发: "waiting",
  触发: "triggered",
  放弃: "invalidated",
};

export const WATCH_OBSERVER_SYSTEM_PROMPT = [
  "你是超短策略“未持仓关注池”的盘中观察器，只输出观察结论；不执行交易，不修改关注池成员、仓位或策略。",
  "你只负责 exit_status='none' 的未持仓候选；已持仓标的由离场 worker 负责，不在本轮输入内。",
  "输入给每只候选的当日量价（现价、开高低、涨跌幅、量、额、前收）、涨停价、MA5/MA10/MA20、突破/止损/失效位、竞价分支与优先级、标签、风险标记、盘中情绪摘要与当前时间；缺失字段为 null 或 data_status 标注，不得补造。",
  "判断完全交给你，没有固定阈值：综合分时量价承接、现价相对关键位/均线/涨停价的位置、竞价分支、板块与情绪，给出 观察 / 接近触发 / 触发 / 放弃。",
  "只有条件已经出现在本轮输入中（价格、量能、承接同时成立）才用“触发”；条件在靠拢但尚未确认用“接近触发”；结构被破坏或明显不成立用“放弃”；其余用“观察”。",
  "只根据输入事实判断，不预测后续走势，不引用输入之外的价格或消息。",
  '只返回一个 JSON 对象，每个候选必须且只能一行：{"items":[{"code":"标的代码","action":"观察|接近触发|触发|放弃","price":10.2,"reason":"40字以内的一句走势分析","invalidation":"失效条件"}]}。price 必须是本轮现价。只返回 JSON，不要 Markdown，不要额外文字。',
].join("\n");

export interface WatchObserverLlmInput {
  system_prompt: string;
  payload: Record<string, unknown>;
}

export type WatchObserverComplete = (input: WatchObserverLlmInput) => Promise<string>;

export type WatchObserverNotify = (
  db: Db,
  input: { event_key: string; content: string },
) => Promise<boolean>;

export type WatchObserverFetchQuotes = (codes: string[]) => Promise<SnapshotQuote[]>;

export interface UltraShortWatchObserverOptions {
  intervalMs?: number;
  now?: () => Date;
  fetchQuotes?: WatchObserverFetchQuotes;
  complete?: WatchObserverComplete;
  notify?: WatchObserverNotify;
}

export interface UltraShortWatchObserverSummary {
  trade_date: string;
  /** 本轮送入模型的未持仓候选行数。 */
  rows: number;
  observed: number;
  approaching: number;
  triggered: number;
  gaps: string[];
}

export interface WatchObserverItem {
  code: string;
  action: WatchAction;
  price: number;
  reason: string;
  invalidation: string | null;
}

export interface WatchObserverQuoteView {
  data_status: "ready" | "stale";
  data_time: string | null;
  last: number;
  open: number;
  high: number;
  low: number;
  prev_close: number;
  pct_change: number | null;
  volume: number | null;
  turnover: number | null;
}

export interface WatchObserverCandidateInput {
  code: string;
  name: string;
  priority: string;
  auction: { branch: string | null; priority: string | null; fill_tier: string | null };
  tags: string[];
  stage: string | null;
  streak_count: number | null;
  risk: { level: string; flags: string[]; template: Record<string, unknown> };
  levels: {
    prev_close: number | null;
    limit_up_price: number | null;
    ma5: number | null;
    ma10: number | null;
    ma20: number | null;
    breakout_price: number | null;
    stop_price: number | null;
    invalidation_price: number | null;
  };
  plan: Record<string, unknown>;
  quote: WatchObserverQuoteView;
  previous_status: string;
  previous_note: string | null;
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

function roundPrice(value: number): number {
  return Math.round(value * 100) / 100;
}

function priceText(value: number): string {
  return value.toFixed(2);
}

/** 快照质量：当日、未迟到、非未来数据且价格自洽才算 ready；其余降级为 stale。 */
function quoteStatus(
  quote: SnapshotQuote | null,
  now: Date,
  tradeDate: string,
): "ready" | "stale" | "missing" {
  if (!quote || !Number.isFinite(quote.timestampMs)) return "missing";
  if (![quote.open, quote.high, quote.low, quote.close].every((price) => Number.isFinite(price) && price > 0)) {
    return "missing";
  }
  if (snapshotDate(quote) !== tradeDate) return "stale";
  if (quote.timestampMs > now.getTime() + QUOTE_FUTURE_MS) return "stale";
  if (quote.timestampMs < now.getTime() - QUOTE_STALE_MS) return "stale";
  return "ready";
}

function quoteView(
  row: UltraShortWatchlistRow,
  quote: SnapshotQuote,
  dataStatus: "ready" | "stale",
): WatchObserverQuoteView {
  const last = positiveNumber(quote.close) ?? 0;
  const prevClose = positiveNumber(row.key_levels.prev_close) ?? positiveNumber(quote.prevClose);
  return {
    data_status: dataStatus,
    data_time: Number.isFinite(quote.timestampMs) ? new Date(quote.timestampMs).toISOString() : null,
    last,
    open: positiveNumber(quote.open) ?? 0,
    high: positiveNumber(quote.high) ?? 0,
    low: positiveNumber(quote.low) ?? 0,
    prev_close: prevClose ?? 0,
    pct_change: prevClose !== null && prevClose > 0
      ? Number(((last / prevClose - 1) * 100).toFixed(2))
      : null,
    volume: finiteNumber(quote.volume),
    turnover: finiteNumber(quote.turnover),
  };
}

function level(levels: Record<string, unknown>, key: string): number | null {
  return positiveNumber(levels[key]);
}

/** 输入只做事实组装：所有指标原样交给模型，不在代码里判断是否触发。 */
export function buildWatchObserverCandidate(
  row: UltraShortWatchlistRow,
  quote: SnapshotQuote,
  dataStatus: "ready" | "stale",
): WatchObserverCandidateInput {
  const keyLevels = row.key_levels as Record<string, unknown>;
  const plan = row.intraday_plan as Record<string, unknown>;
  const prevClose = level(keyLevels, "prev_close") ?? positiveNumber(quote.prevClose);
  return {
    code: row.code,
    name: row.name,
    priority: row.priority,
    auction: {
      branch: row.auction_branch,
      priority: row.auction_priority,
      fill_tier: row.auction_fill_tier,
    },
    tags: row.tags,
    stage: row.stage,
    streak_count: row.streak_count,
    risk: {
      level: row.risk_level,
      flags: row.risk_flags,
      template: row.risk as Record<string, unknown>,
    },
    levels: {
      prev_close: prevClose,
      limit_up_price: level(keyLevels, "limit_up_price")
        ?? (prevClose !== null ? roundPrice(prevClose * 1.1) : null),
      ma5: level(keyLevels, "ma5"),
      ma10: level(keyLevels, "ma10"),
      ma20: level(keyLevels, "ma20"),
      breakout_price: level(keyLevels, "breakout_price"),
      stop_price: level(keyLevels, "stop_price"),
      invalidation_price: positiveNumber(plan.invalidation_price) ?? level(keyLevels, "invalidation_price"),
    },
    plan,
    quote: quoteView(row, quote, dataStatus),
    previous_status: row.intraday_status,
    previous_note: row.intraday_note,
  };
}

function extractJson(raw: string): unknown {
  if (!raw || raw.trim() === "") throw new Error("超短观察模型返回空正文");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("超短观察模型未返回 JSON");
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    throw new Error("超短观察模型返回的 JSON 格式无效");
  }
}

/**
 * 校验 LLM 输出：代码必须在池内、动作必须命中词表、价格为正、理由非空；
 * 非法项只记 gaps，不写关注池。重复代码保留第一条，其余忽略。
 */
export function parseWatchObserverReply(
  raw: string,
  codes: Iterable<string>,
): { items: WatchObserverItem[]; gaps: string[] } {
  const json = extractJson(raw);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("超短观察模型返回的 JSON 不是对象");
  }
  const rawItems = (json as { items?: unknown }).items;
  if (!Array.isArray(rawItems)) throw new Error("超短观察模型返回缺少 items 数组");

  const known = new Set(codes);
  const seen = new Set<string>();
  const gaps: string[] = [];
  const items: WatchObserverItem[] = [];

  rawItems.forEach((rawItem, index) => {
    const label = `第 ${index + 1} 项`;
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      gaps.push(`${label}不是对象，已忽略`);
      return;
    }
    const record = rawItem as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code.trim() : "";
    if (!code) {
      gaps.push(`${label}缺少代码，已忽略`);
      return;
    }
    if (!known.has(code)) {
      gaps.push(`${code}：不在本轮关注池，已忽略`);
      return;
    }
    if (seen.has(code)) {
      gaps.push(`${code}：重复项，已忽略`);
      return;
    }
    const action = typeof record.action === "string" ? record.action.trim() : "";
    if (!WATCH_ACTIONS.includes(action as WatchAction)) {
      gaps.push(`${code}：动作“${action}”不在词表，已忽略`);
      return;
    }
    const price = positiveNumber(record.price);
    if (price === null) {
      gaps.push(`${code}：价格无效，已忽略`);
      return;
    }
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    if (reason === "") {
      gaps.push(`${code}：缺少走势分析，已忽略`);
      return;
    }
    const invalidation = typeof record.invalidation === "string" && record.invalidation.trim() !== ""
      ? record.invalidation.trim()
      : null;
    seen.add(code);
    items.push({ code, action: action as WatchAction, price, reason, invalidation });
  });

  return { items, gaps };
}

function digestContent(
  now: Date,
  entries: Array<{ name: string; code: string; price: number; action: WatchAction; reason: string }>,
): string {
  const time = now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  return [
    `Stock｜超短未持仓盘中观察｜${time}`,
    "",
    ...entries.map((entry) => `${entry.name} ${entry.code} ${priceText(entry.price)} ${entry.action}｜${entry.reason}`),
  ].join("\n");
}

async function defaultComplete(pool: pg.Pool, input: WatchObserverLlmInput): Promise<string> {
  const config = await getLlmConfigByModelKey(pool, MODEL_KEY);
  if (!config) throw new Error(`未找到可用模型 ${MODEL_KEY}，请先在设置中配置`);
  const runtime = await resolveActiveChatModel(pool, config.model.id);
  const response = await runtime.models.completeSimple(runtime.model, {
    systemPrompt: input.system_prompt,
    messages: [{ role: "user", content: JSON.stringify(input.payload), timestamp: Date.now() }],
  }, { reasoning: "minimal", temperature: 0, sessionId: undefined });
  if (response.stopReason === "error") {
    throw new Error(`超短观察模型调用失败：${response.errorMessage ?? "未知错误"}`);
  }
  if (response.stopReason === "aborted") throw new Error("超短观察模型调用已中断");
  if (response.stopReason === "length") {
    throw new Error(`超短观察模型输出被截断：已用满 ${response.usage.output} 个输出 token`);
  }
  const content = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  if (content === "") throw new Error("超短观察模型返回空正文");
  return content;
}

/**
 * 未持仓观察 worker：每个 120 秒 tick 把关注池未持仓候选交给模型，校验后回写关注池，
 * 仅在出现“接近触发/触发”时发一条汇总提醒（观察/放弃行也列出）。
 */
export class UltraShortWatchObserver {
  private readonly pool: pg.Pool;
  private readonly intervalMs: number;
  private readonly clock: () => Date;
  private readonly fetchQuotes: WatchObserverFetchQuotes;
  private readonly complete: WatchObserverComplete;
  private readonly notify: WatchObserverNotify;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = true;
  /** 相同内容（内容哈希一致）不重复发同一轮提醒。 */
  private lastDigest: { trade_date: string; event_key: string } | null = null;

  constructor(pool: pg.Pool, options: UltraShortWatchObserverOptions = {}) {
    this.pool = pool;
    this.intervalMs = options.intervalMs ?? ULTRA_SHORT_WATCH_INTERVAL_MS;
    this.clock = options.now ?? (() => new Date());
    this.fetchQuotes = options.fetchQuotes
      ?? ((codes) => fetchSnapshot(codes, { db: pool, priority: "interactive" }, "stock"));
    this.complete = options.complete ?? ((input) => defaultComplete(pool, input));
    this.notify = options.notify ?? ((db, input) => enqueueBatchAlert(db, {
      kind: "ultra_short",
      event_key: input.event_key,
      content: input.content,
    }));
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

  /** 单次 tick：窗口外/非交易日/任务暂停返回 null，不写业务数据。 */
  async tick(): Promise<UltraShortWatchObserverSummary | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const now = this.clock();
      if (!isWatchWindow(now)) return null;
      const tradeDate = shanghaiDate(now);
      if (!(await isScheduledTradingDay(this.pool, tradeDate))) return null;
      if (!(await isWorkerEnabled(this.pool, ULTRA_SHORT_WATCH_WORKER_CODE))) {
        await this.heartbeat({
          status: "idle",
          trade_date: tradeDate,
          summary: "任务已暂停，本轮跳过",
        });
        return null;
      }
      return await this.runTick(now, tradeDate);
    } catch (error) {
      await this.heartbeat({ status: "failed", error: (error as Error).message });
      console.error(`[ultra-short-watch-observer] ${(error as Error).message}`);
      return null;
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
    // tick 内部已写 running/success/failed 心跳，这里只负责下一轮排程。
    await this.tick().catch((error) => {
      console.error(`[ultra-short-watch-observer] ${(error as Error).message}`);
    });
    this.schedule(this.intervalMs);
  }

  private async heartbeat(heartbeat: WorkerHeartbeat): Promise<void> {
    try {
      await writeWorkerHeartbeat(this.pool, ULTRA_SHORT_WATCH_WORKER_CODE, heartbeat);
    } catch (error) {
      console.error(`[ultra-short-watch-observer] 心跳写入失败：${(error as Error).message}`);
    }
  }

  private async runTick(now: Date, tradeDate: string): Promise<UltraShortWatchObserverSummary> {
    const gaps: string[] = [];
    await this.heartbeat({ status: "running", trade_date: tradeDate });

    const allRows = await listWatchlist(this.pool, tradeDate);
    const rows = allRows.filter((row) => row.exit_status === "none" && row.review_status !== "invalid");
    if (rows.length < allRows.length) {
      gaps.push(`跳过 ${allRows.length - rows.length} 只已持仓/复核无效标的`);
    }
    if (rows.length === 0) {
      await this.heartbeat({
        status: "success",
        trade_date: tradeDate,
        summary: "关注池无未持仓候选",
      });
      return {
        trade_date: tradeDate,
        rows: 0,
        observed: 0,
        approaching: 0,
        triggered: 0,
        gaps: [...new Set(gaps)],
      };
    }

    const quotes = await this.loadQuotes(rows.map((row) => row.code), gaps);
    for (const row of rows) {
      try {
        await writeWatchSample(this.pool, tradeDate, now, row, quotes.get(row.code) ?? null);
      } catch (error) {
        gaps.push(`${row.code}：盘中采样写入失败（${(error as Error).message}）`);
      }
    }

    const candidates: WatchObserverCandidateInput[] = [];
    const rowsByCode = new Map(rows.map((row) => [row.code, row]));
    for (const row of rows) {
      const quote = quotes.get(row.code) ?? null;
      const status = quoteStatus(quote, now, tradeDate);
      if (status === "missing" || quote === null) {
        gaps.push(`${row.code}：缺少当日快照，本轮不送模型`);
        continue;
      }
      candidates.push(buildWatchObserverCandidate(row, quote, status));
    }
    if (candidates.length === 0) {
      await this.heartbeat({
        status: "success",
        trade_date: tradeDate,
        summary: "无可观察行情，本轮跳过",
      });
      return {
        trade_date: tradeDate,
        rows: 0,
        observed: 0,
        approaching: 0,
        triggered: 0,
        gaps: [...new Set(gaps)],
      };
    }

    const sentiment = await this.readSentiment(tradeDate, now, gaps);
    const payload: Record<string, unknown> = {
      trade_date: tradeDate,
      observed_at: now.toISOString(),
      window: "09:30-10:30（上海）",
      candidates,
      market_context: { sentiment },
      data_gaps: gaps,
    };

    let raw: string;
    try {
      raw = await this.complete({ system_prompt: WATCH_OBSERVER_SYSTEM_PROMPT, payload });
    } catch (error) {
      const message = `超短观察模型调用失败：${(error as Error).message}`;
      gaps.push(message);
      await this.heartbeat({ status: "failed", trade_date: tradeDate, error: message });
      return {
        trade_date: tradeDate,
        rows: candidates.length,
        observed: 0,
        approaching: 0,
        triggered: 0,
        gaps: [...new Set(gaps)],
      };
    }

    let parsed: { items: WatchObserverItem[]; gaps: string[] };
    try {
      parsed = parseWatchObserverReply(raw, candidates.map((candidate) => candidate.code));
    } catch (error) {
      const message = (error as Error).message;
      gaps.push(message);
      await this.heartbeat({ status: "failed", trade_date: tradeDate, error: message });
      return {
        trade_date: tradeDate,
        rows: candidates.length,
        observed: 0,
        approaching: 0,
        triggered: 0,
        gaps: [...new Set(gaps)],
      };
    }
    gaps.push(...parsed.gaps);

    const candidatesByCode = new Map(candidates.map((candidate) => [candidate.code, candidate]));
    let observed = 0;
    let approaching = 0;
    let triggered = 0;
    const entries: Array<{ name: string; code: string; price: number; action: WatchAction; reason: string }> = [];

    for (const item of parsed.items) {
      const row = rowsByCode.get(item.code);
      const candidate = candidatesByCode.get(item.code);
      if (!row || !candidate) continue;
      const note = item.invalidation === null
        ? item.reason
        : `${item.reason}；失效：${item.invalidation}`;
      const patch: WatchlistPatch = {
        intraday_status: ACTION_STATUS[item.action],
        intraday_note: note,
        trigger_price: item.price,
        trigger_reason: item.reason,
        data_status: candidate.quote.data_status === "ready" ? "ready" : "partial",
      };
      try {
        await updateWatchlist(this.pool, tradeDate, item.code, patch);
      } catch (error) {
        gaps.push(`${item.code}：关注池回写失败（${(error as Error).message}）`);
        continue;
      }
      if (item.action === "观察") observed += 1;
      else if (item.action === "接近触发") approaching += 1;
      else if (item.action === "触发") triggered += 1;
      entries.push({
        name: row.name,
        code: item.code,
        price: item.price,
        action: item.action,
        reason: item.reason,
      });
    }

    // 只有出现“接近触发/触发”才提醒；每轮一条汇总，观察行也列出。
    if (approaching + triggered > 0 && entries.length > 0) {
      const content = digestContent(now, entries);
      const eventKey = `ultra:watch_digest:${tradeDate}:${sha256Json(content)}`;
      const alreadySent = this.lastDigest?.trade_date === tradeDate && this.lastDigest.event_key === eventKey;
      if (!alreadySent) {
        try {
          if (await this.notify(this.pool, { event_key: eventKey, content })) {
            this.lastDigest = { trade_date: tradeDate, event_key: eventKey };
          }
        } catch (error) {
          gaps.push(`观察汇总入队失败：${(error as Error).message}`);
        }
      }
    }

    const summary = [
      `未持仓候选 ${candidates.length} 只`,
      `观察 ${observed} 只`,
      `接近 ${approaching} 只`,
      `触发 ${triggered} 只`,
    ].join("；");
    await this.heartbeat({ status: "success", trade_date: tradeDate, summary });

    return {
      trade_date: tradeDate,
      rows: candidates.length,
      observed,
      approaching,
      triggered,
      gaps: [...new Set(gaps)],
    };
  }

  private async loadQuotes(codes: string[], gaps: string[]): Promise<Map<string, SnapshotQuote>> {
    if (codes.length === 0) return new Map();
    try {
      const quotes = await this.fetchQuotes(codes);
      return new Map(quotes.map((quote) => [quote.code, quote]));
    } catch (error) {
      gaps.push(`关注池快照：${(error as Error).message}`);
      return new Map();
    }
  }

  private async readSentiment(
    tradeDate: string,
    now: Date,
    gaps: string[],
  ): Promise<{ ready: boolean; note: string; samples: unknown[] } | null> {
    try {
      const sentiment = await readIntradaySentiment(this.pool, tradeDate, now);
      return {
        ready: sentiment.ready,
        note: sentiment.note,
        samples: sentiment.samples.slice(-2),
      };
    } catch (error) {
      gaps.push(`盘中情绪：${(error as Error).message}`);
      return null;
    }
  }
}

/** 默认导出与 05 快速层保持一致的 worker 形状，供 index 直接 new。 */
export default UltraShortWatchObserver;
