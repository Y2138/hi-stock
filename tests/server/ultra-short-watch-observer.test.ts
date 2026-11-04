// 超短未持仓 LLM 盘中观察 worker：窗口门禁、空池、非法项过滤、四种动作映射、
// 汇总提醒与内容去重、已持仓排除、role='watch' 采样、心跳与模型失败降级。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { createPool } from "../../server/db/client.js";
import type { SnapshotQuote } from "../../server/datasource/hithink.js";
import {
  getWatchlistRow,
  replaceWatchlist,
  updateWatchlist,
  type WatchlistPatch,
} from "../../server/modules/ultra-short/repo.js";
import type { WatchlistDraft } from "../../server/modules/ultra-short/types.js";
import {
  isWatchWindow,
  parseWatchObserverReply,
  UltraShortWatchObserver,
  type WatchObserverComplete,
  type WatchObserverLlmInput,
  type WatchObserverNotify,
} from "../../server/modules/ultra-short/watch-observer.js";
import { prepareTestDb } from "./helpers.js";

const TRADE_DATE = "2026-10-20";
const DATA_DATE = "2026-10-19";
/** 2026-10-20 10:00（上海）= 02:00Z */
const NOW = new Date("2026-10-20T02:00:00Z");

function draft(code: string, name: string, overrides: Partial<WatchlistDraft> = {}): WatchlistDraft {
  return {
    code,
    name,
    sources: ["post_close"],
    tags: ["换手晋级"],
    resonance: false,
    priority: "P2",
    priority_reason: "测试",
    stage: "首板",
    streak_count: 1,
    t_facts: {},
    key_levels: { prev_close: 10, limit_up_price: 11, ma5: 10.2, ma10: 10.1, ma20: 9.9, stop_price: 9.6 },
    auction_expect: {},
    intraday_plan: { trigger: "turnover_advance", trigger_price: 10.4, invalidation_price: 9.6 },
    risk: { stop_pct: 4, position_cap_pct: 30 },
    review_status: "pass",
    risk_level: "unknown",
    risk_flags: [],
    review_note: null,
    ...overrides,
  };
}

function quote(code: string, last: number, at = NOW): SnapshotQuote {
  return {
    code,
    timestampMs: at.getTime() - 5_000,
    open: Number((last * 0.99).toFixed(2)),
    high: Number((last * 1.01).toFixed(2)),
    low: Number((last * 0.98).toFixed(2)),
    close: last,
    prevClose: 10,
    volume: 5_000_000,
    turnover: 50_000_000,
  };
}

function completeOf(items: unknown[]): WatchObserverComplete {
  return async () => JSON.stringify({ items });
}

interface NotifyCall {
  event_key: string;
  content: string;
}

function notifySpy(): { calls: NotifyCall[]; notify: WatchObserverNotify } {
  const calls: NotifyCall[] = [];
  const notify: WatchObserverNotify = async (_db, input) => {
    calls.push(input);
    return true;
  };
  return { calls, notify };
}

describe("未持仓观察窗口（上海时区）", () => {
  it("09:30 开始、10:30 截止，窗口外不运行", () => {
    expect(isWatchWindow(new Date("2026-10-20T01:29:59Z"))).toBe(false);
    expect(isWatchWindow(new Date("2026-10-20T01:30:00Z"))).toBe(true);
    expect(isWatchWindow(new Date("2026-10-20T02:29:59Z"))).toBe(true);
    expect(isWatchWindow(new Date("2026-10-20T02:30:00Z"))).toBe(false);
    expect(isWatchWindow(new Date("2026-10-20T05:00:00Z"))).toBe(false);
  });
});

describe("LLM 输出校验（纯函数）", () => {
  it("只保留池内、词表内、正价格、非空理由的项，其余记 gaps", () => {
    const codes = new Set(["600000.SH", "600001.SH"]);
    const reply = JSON.stringify({
      items: [
        { code: "600000.SH", action: "接近触发", price: 10.5, reason: "放量逼近涨停", invalidation: "跌破10.2" },
        { code: "999999.SH", action: "触发", price: 10, reason: "池外" },
        { code: "600001.SH", action: "买入", price: 10, reason: "词表外" },
        { code: "600001.SH", action: "观察", price: 0, reason: "零价格" },
        { code: "600001.SH", action: "观察", price: 10, reason: "   " },
        { code: "600000.SH", action: "触发", price: 10.6, reason: "重复项" },
      ],
    });
    const parsed = parseWatchObserverReply(reply, codes);
    expect(parsed.items).toEqual([
      { code: "600000.SH", action: "接近触发", price: 10.5, reason: "放量逼近涨停", invalidation: "跌破10.2" },
    ]);
    expect(parsed.gaps).toHaveLength(5);
    expect(parsed.gaps.join("；")).toContain("不在本轮关注池");
    expect(parsed.gaps.join("；")).toContain("不在词表");
    expect(parsed.gaps.join("；")).toContain("价格无效");
    expect(parsed.gaps.join("；")).toContain("缺少走势分析");
    expect(parsed.gaps.join("；")).toContain("重复项");

    expect(() => parseWatchObserverReply("模型没有返回 JSON", codes)).toThrow();
    expect(() => parseWatchObserverReply("", codes)).toThrow();
    expect(() => parseWatchObserverReply(JSON.stringify({ result: [] }), codes)).toThrow();
  });
});

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("未持仓观察 worker（真实测试库）", () => {
  let pool: pg.Pool;

  function makeWorker(input: {
    quotes?: Map<string, SnapshotQuote> | (() => Map<string, SnapshotQuote>);
    complete: WatchObserverComplete;
    notify?: WatchObserverNotify;
    now?: () => Date;
    onQuoteCodes?: (codes: string[]) => void;
  }): UltraShortWatchObserver {
    return new UltraShortWatchObserver(pool, {
      now: input.now ?? (() => NOW),
      fetchQuotes: async (codes) => {
        input.onQuoteCodes?.(codes);
        const map = typeof input.quotes === "function" ? input.quotes() : input.quotes;
        return codes
          .map((code) => map?.get(code))
          .filter((item): item is SnapshotQuote => item !== undefined);
      },
      complete: input.complete,
      notify: input.notify,
    });
  }

  async function seed(
    drafts: WatchlistDraft[],
    patches: Record<string, WatchlistPatch> = {},
  ): Promise<void> {
    await replaceWatchlist(pool, TRADE_DATE, DATA_DATE, drafts);
    for (const [code, patch] of Object.entries(patches)) {
      await updateWatchlist(pool, TRADE_DATE, code, patch);
    }
  }

  async function loadRow(code: string) {
    const row = await getWatchlistRow(pool, TRADE_DATE, code);
    if (!row) throw new Error(`关注池行不存在：${code}`);
    return row;
  }

  async function heartbeatRow(): Promise<{
    status: string;
    trade_date: string | null;
    last_summary: string | null;
    error: string | null;
  } | null> {
    const result = await pool.query<{
      status: string;
      trade_date: string | null;
      last_summary: string | null;
      error: string | null;
    }>(
      `SELECT status, trade_date::text AS trade_date, last_summary, error
         FROM job_worker_status WHERE code = 'ultra_short_watch_observe'`,
    );
    return result.rows[0] ?? null;
  }

  async function samples(): Promise<Array<{ code: string; role: string; data_status: string; last_price: number | null }>> {
    const result = await pool.query<{ code: string; role: string; data_status: string; last_price: number | null }>(
      `SELECT code, role, data_status, last_price::float8 AS last_price
         FROM intraday_market_sample WHERE trade_date = $1 ORDER BY code`,
      [TRADE_DATE],
    );
    return result.rows;
  }

  async function deliveryCount(): Promise<number> {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM notification_delivery WHERE kind = 'ultra_short'",
    );
    return result.rows[0]?.count ?? 0;
  }

  beforeAll(async () => {
    // prepareTestDb 已清空 schema 并完成迁移；这里不再重复迁移，避免拖慢用例。
    pool = createPool(prepared!.url);
    // 只验证入队与内容哈希去重，不发真实请求；webhook 用不可解析占位地址。
    await pool.query(
      "UPDATE notification_setting SET enabled = true, webhook = 'https://example.invalid/hook', sign_secret = 'test-secret' WHERE singleton",
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM ultra_short_watchlist");
    await pool.query("DELETE FROM notification_delivery");
    await pool.query("DELETE FROM intraday_market_sample");
    await pool.query("DELETE FROM job_worker_status");
    await pool.query(
      "UPDATE job_definition SET enabled = true WHERE code = 'ultra_short_watch_observe'",
    );
  });

  it("窗口外返回 null：不取行情、不写关注池、不写心跳", async () => {
    await seed([draft("600000.SH", "测试股份")]);
    let quoteCalls = 0;
    const worker = makeWorker({
      now: () => new Date("2026-10-20T01:29:00Z"), // 09:29 上海
      quotes: new Map(),
      complete: completeOf([]),
      onQuoteCodes: () => { quoteCalls += 1; },
    });
    expect(await worker.tick()).toBeNull();
    expect(quoteCalls).toBe(0);
    expect(await heartbeatRow()).toBeNull();
    expect(await samples()).toHaveLength(0);
    expect((await loadRow("600000.SH")).intraday_note).toBeNull();
  });

  it("非交易日返回 null：不写库", async () => {
    await seed([draft("600000.SH", "测试股份")]);
    let quoteCalls = 0;
    const worker = makeWorker({
      now: () => new Date("2026-10-17T02:00:00Z"), // 周六 10:00 上海
      quotes: new Map(),
      complete: completeOf([]),
      onQuoteCodes: () => { quoteCalls += 1; },
    });
    expect(await worker.tick()).toBeNull();
    expect(quoteCalls).toBe(0);
    expect(await heartbeatRow()).toBeNull();
  });

  it("暂停开关关闭时跳过并写 idle 心跳", async () => {
    await seed([draft("600000.SH", "测试股份")]);
    await pool.query("UPDATE job_definition SET enabled = false WHERE code = 'ultra_short_watch_observe'");
    let quoteCalls = 0;
    const worker = makeWorker({
      quotes: new Map(),
      complete: completeOf([]),
      onQuoteCodes: () => { quoteCalls += 1; },
    });
    expect(await worker.tick()).toBeNull();
    expect(quoteCalls).toBe(0);
    expect(await heartbeatRow()).toMatchObject({
      status: "idle",
      trade_date: TRADE_DATE,
      last_summary: "任务已暂停，本轮跳过",
    });
  });

  it("空关注池：返回 0 行并写 success 心跳，不发提醒", async () => {
    const spy = notifySpy();
    const worker = makeWorker({
      quotes: new Map(),
      complete: completeOf([{ code: "600000.SH", action: "触发", price: 10.5, reason: "无池" }]),
      notify: spy.notify,
    });
    expect(await worker.tick()).toMatchObject({ trade_date: TRADE_DATE, rows: 0, observed: 0, approaching: 0, triggered: 0 });
    expect(spy.calls).toHaveLength(0);
    expect(await heartbeatRow()).toMatchObject({ status: "success", last_summary: "关注池无未持仓候选" });
    expect(await samples()).toHaveLength(0);
  });

  it("LLM 非法项只记 gaps，不写关注池", async () => {
    await seed([draft("600000.SH", "测试股份"), draft("600001.SH", "测试二")]);
    const quotes = new Map<string, SnapshotQuote>([
      ["600000.SH", quote("600000.SH", 10.5)],
      ["600001.SH", quote("600001.SH", 10.3)],
    ]);
    const worker = makeWorker({
      quotes,
      complete: completeOf([
        { code: "600000.SH", action: "观察", price: 10.5, reason: "缩量横盘" },
        { code: "999999.SH", action: "触发", price: 10.5, reason: "池外" },
        { code: "600001.SH", action: "买入", price: 10.3, reason: "词表外" },
        { code: "600001.SH", action: "观察", price: 0, reason: "零价" },
        { code: "600001.SH", action: "观察", price: 10.3, reason: "  " },
      ]),
      notify: notifySpy().notify,
    });

    const summary = (await worker.tick())!;
    expect(summary).toMatchObject({ rows: 2, observed: 1, approaching: 0, triggered: 0 });
    expect(summary.gaps.join("；")).toContain("不在本轮关注池");
    expect(summary.gaps.join("；")).toContain("不在词表");
    expect(summary.gaps.join("；")).toContain("价格无效");
    expect(summary.gaps.join("；")).toContain("缺少走势分析");

    expect(await loadRow("600000.SH")).toMatchObject({
      intraday_status: "waiting",
      intraday_note: "缩量横盘",
      trigger_price: 10.5,
    });
    // 非法项不写：600001 保持原状。
    expect(await loadRow("600001.SH")).toMatchObject({
      intraday_status: "waiting",
      intraday_note: null,
      trigger_price: null,
    });
  });

  it("观察/接近触发/触发/放弃映射到关注池状态，且输入组装包含关键位", async () => {
    await seed([
      draft("600000.SH", "测试观察"),
      draft("600001.SH", "测试接近"),
      draft("600002.SH", "测试触发"),
      draft("600003.SH", "测试放弃"),
    ]);
    const quotes = new Map<string, SnapshotQuote>([
      ["600000.SH", quote("600000.SH", 10.1)],
      ["600001.SH", quote("600001.SH", 10.5)],
      ["600002.SH", quote("600002.SH", 10.9)],
      ["600003.SH", quote("600003.SH", 9.7)],
    ]);
    let captured: WatchObserverLlmInput | null = null;
    const worker = makeWorker({
      quotes,
      complete: async (input) => {
        captured = input;
        return JSON.stringify({
          items: [
            { code: "600000.SH", action: "观察", price: 10.1, reason: "缩量横盘" },
            { code: "600001.SH", action: "接近触发", price: 10.5, reason: "逼近涨停", invalidation: "跌破10.2" },
            { code: "600002.SH", action: "触发", price: 10.9, reason: "放量站上关键位", invalidation: "跌破10.6" },
            { code: "600003.SH", action: "放弃", price: 9.7, reason: "跌破失效位" },
          ],
        });
      },
      notify: notifySpy().notify,
    });

    const summary = (await worker.tick())!;
    expect(summary).toMatchObject({ rows: 4, observed: 1, approaching: 1, triggered: 1 });

    expect(await loadRow("600000.SH")).toMatchObject({ intraday_status: "waiting", intraday_note: "缩量横盘" });
    expect(await loadRow("600001.SH")).toMatchObject({
      intraday_status: "waiting",
      trigger_price: 10.5,
      trigger_reason: "逼近涨停",
      intraday_note: "逼近涨停；失效：跌破10.2",
      data_status: "ready",
    });
    expect(await loadRow("600002.SH")).toMatchObject({
      intraday_status: "triggered",
      trigger_price: 10.9,
      trigger_reason: "放量站上关键位",
      intraday_note: "放量站上关键位；失效：跌破10.6",
    });
    const abandoned = await loadRow("600003.SH");
    expect(abandoned).toMatchObject({ intraday_status: "invalidated", intraday_note: "跌破失效位" });
    // 回写不碰 exit_* 字段。
    for (const code of ["600000.SH", "600001.SH", "600002.SH", "600003.SH"]) {
      expect(await loadRow(code)).toMatchObject({
        exit_status: "none",
        exit_reason: null,
        exit_price: null,
        exit_at: null,
        entry_price: null,
      });
    }

    // 输入组装：现价、涨跌幅、关键位、竞价与情绪上下文都交给模型。
    const payload = captured!.payload as {
      trade_date: string;
      candidates: Array<{
        code: string;
        levels: { ma5: number | null; ma10: number | null; ma20: number | null; limit_up_price: number | null; stop_price: number | null; invalidation_price: number | null };
        quote: { last: number; pct_change: number | null; data_status: string };
        auction: { branch: string | null; priority: string | null };
        risk: { level: string };
      }>;
      market_context: { sentiment: unknown };
    };
    expect(payload.trade_date).toBe(TRADE_DATE);
    const candidate = payload.candidates.find((item) => item.code === "600002.SH")!;
    expect(candidate.levels).toMatchObject({
      ma5: 10.2,
      ma10: 10.1,
      ma20: 9.9,
      limit_up_price: 11,
      stop_price: 9.6,
      invalidation_price: 9.6,
    });
    expect(candidate.quote).toMatchObject({ last: 10.9, data_status: "ready" });
    expect(candidate.quote.pct_change).toBeCloseTo(9, 5);
    expect(candidate.auction).toMatchObject({ branch: null, priority: null });
    expect(captured!.system_prompt).toContain("观察");
    expect(payload.market_context).toHaveProperty("sentiment");
  });

  it("只有出现接近触发/触发才发一条汇总，观察行也列出", async () => {
    await seed([draft("600000.SH", "测试股份"), draft("600001.SH", "测试二")]);
    const quotes = new Map<string, SnapshotQuote>([
      ["600000.SH", quote("600000.SH", 10.5)],
      ["600001.SH", quote("600001.SH", 10.8)],
    ]);
    const spy = notifySpy();
    const worker = makeWorker({
      quotes,
      complete: completeOf([
        { code: "600000.SH", action: "观察", price: 10.5, reason: "缩量整理" },
        { code: "600001.SH", action: "触发", price: 10.8, reason: "放量站上MA5" },
      ]),
      notify: spy.notify,
    });

    expect(await worker.tick()).toMatchObject({ observed: 1, approaching: 0, triggered: 1 });
    expect(spy.calls).toHaveLength(1);
    const digest = spy.calls[0]!;
    expect(digest.event_key).toMatch(/^ultra:watch_digest:2026-10-20:[0-9a-f]{64}$/);
    expect(digest.content).toContain("Stock｜超短未持仓盘中观察｜");
    expect(digest.content).toContain("测试股份 600000.SH 10.50 观察｜缩量整理");
    expect(digest.content).toContain("测试二 600001.SH 10.80 触发｜放量站上MA5");
    expect(await heartbeatRow()).toMatchObject({ status: "success", trade_date: TRADE_DATE });
    expect((await heartbeatRow())!.last_summary).toContain("触发 1 只");
  });

  it("只有观察/放弃时不发提醒", async () => {
    await seed([draft("600000.SH", "测试股份")]);
    const spy = notifySpy();
    const worker = makeWorker({
      quotes: new Map([["600000.SH", quote("600000.SH", 10.5)]]),
      complete: completeOf([{ code: "600000.SH", action: "观察", price: 10.5, reason: "横盘" }]),
      notify: spy.notify,
    });
    await worker.tick();
    expect(spy.calls).toHaveLength(0);
    expect(await deliveryCount()).toBe(0);
  });

  it("相同内容不重复：同一 worker 两轮只入队一次，跨 worker 由 event_key 去重", async () => {
    await seed([draft("600000.SH", "测试股份")]);
    const quotes = new Map([["600000.SH", quote("600000.SH", 10.8)]]);
    const complete = completeOf([{ code: "600000.SH", action: "触发", price: 10.8, reason: "放量突破" }]);
    const spy = notifySpy();
    const worker = makeWorker({ quotes, complete, notify: spy.notify });

    await worker.tick();
    await worker.tick();
    expect(spy.calls).toHaveLength(1);
    expect(await deliveryCount()).toBe(0); // 注入 spy 不写库

    // 新 worker（没有内存去重）连续两轮走真实入队：内容哈希 event_key 兜底。
    await makeWorker({ quotes, complete }).tick();
    await makeWorker({ quotes, complete }).tick();
    expect(await deliveryCount()).toBe(1);
  });

  it("已持仓与复核无效的行不送模型、不写采样", async () => {
    await seed(
      [
        draft("600000.SH", "测试未持仓"),
        draft("600001.SH", "测试已持仓"),
        draft("600002.SH", "测试无效"),
      ],
      {
        "600001.SH": { exit_status: "holding", entry_price: 10.2 },
        "600002.SH": { review_status: "invalid" },
      },
    );
    const quotes = new Map<string, SnapshotQuote>([
      ["600000.SH", quote("600000.SH", 10.5)],
      ["600001.SH", quote("600001.SH", 10.6)],
      ["600002.SH", quote("600002.SH", 10.7)],
    ]);
    const spy = notifySpy();
    let quoteCodes: string[] = [];
    const worker = makeWorker({
      quotes,
      complete: completeOf([{ code: "600000.SH", action: "触发", price: 10.5, reason: "放量" }]),
      notify: spy.notify,
      onQuoteCodes: (codes) => { quoteCodes = codes; },
    });

    const summary = (await worker.tick())!;
    expect(summary.rows).toBe(1);
    expect(summary.gaps.join("；")).toContain("跳过 2 只已持仓/复核无效标的");
    expect(quoteCodes).toEqual(["600000.SH"]);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.content).not.toContain("测试已持仓");
    expect(spy.calls[0]!.content).not.toContain("测试无效");

    const sampleRows = await samples();
    expect(sampleRows).toEqual([
      { code: "600000.SH", role: "watch", data_status: "ready", last_price: 10.5 },
    ]);
    expect(await loadRow("600001.SH")).toMatchObject({ intraday_note: null, exit_status: "holding" });
    expect(await loadRow("600002.SH")).toMatchObject({ intraday_note: null, review_status: "invalid" });
  });

  it("每只写 role='watch' 的 30 秒采样，数据缺失时标 missing", async () => {
    await seed([draft("600000.SH", "测试股份"), draft("600001.SH", "测试二")]);
    const quotes = new Map([["600000.SH", quote("600000.SH", 10.5)]]);
    const worker = makeWorker({
      quotes,
      complete: completeOf([
        { code: "600000.SH", action: "观察", price: 10.5, reason: "横盘" },
      ]),
      notify: notifySpy().notify,
    });

    const summary = (await worker.tick())!;
    expect(summary.gaps.join("；")).toContain("600001.SH：缺少当日快照");
    expect(summary.rows).toBe(1);

    const sampleRows = await samples();
    expect(sampleRows).toHaveLength(2);
    expect(sampleRows[0]).toMatchObject({ code: "600000.SH", role: "watch", data_status: "ready", last_price: 10.5 });
    expect(sampleRows[1]).toMatchObject({ code: "600001.SH", role: "watch", data_status: "missing", last_price: null });
  });

  it("模型失败只记 gaps 并写 failed 心跳，不抛穿 worker", async () => {
    await seed([draft("600000.SH", "测试股份")]);
    const worker = makeWorker({
      quotes: new Map([["600000.SH", quote("600000.SH", 10.5)]]),
      complete: async () => { throw new Error("模型超时"); },
      notify: notifySpy().notify,
    });

    const summary = (await worker.tick())!;
    expect(summary).toMatchObject({ rows: 1, observed: 0, approaching: 0, triggered: 0 });
    expect(summary.gaps.join("；")).toContain("模型超时");
    expect(await heartbeatRow()).toMatchObject({ status: "failed", trade_date: TRADE_DATE });
    expect((await heartbeatRow())!.error).toContain("模型超时");
    expect(await loadRow("600000.SH")).toMatchObject({ intraday_note: null, trigger_price: null });
    expect(await deliveryCount()).toBe(0);
  });
});
