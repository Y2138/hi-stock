// 05 快速层：窗口/交易日门禁、T+1、开板两级确认、A/B/C/F/G/H 分级、打板/低吸离场、
// 提醒去重、缺行情不写、熔断只报告，以及快速层不写盘中采样。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { createPool } from "../../server/db/client.js";
import { runMigrations } from "../../server/db/migrate.js";
import type { SnapshotQuote } from "../../server/datasource/hithink.js";
import { enqueueBatchAlert } from "../../server/modules/notifications/service.js";
import {
  isFastLaneWindow,
  UltraShortFastLane,
  type FastLaneNotify,
  type FastLaneNotifyDigest,
  type FastLanePoolData,
} from "../../server/modules/ultra-short/fast-lane.js";
import {
  getWatchlistRow,
  replaceWatchlist,
  updateWatchlist,
  type WatchlistPatch,
} from "../../server/modules/ultra-short/repo.js";
import type { UltraShortWatchlistRow, WatchlistDraft } from "../../server/modules/ultra-short/types.js";
import { prepareTestDb, resetSchema } from "./helpers.js";

const TRADE_DATE = "2026-10-20";
const DATA_DATE = "2026-10-16";
const TARGET = "2026-10-19";
const CODE = "600000.SH";
/** 2026-10-20 10:00（上海）= 02:00Z */
const NOW = new Date("2026-10-20T02:00:00Z");
const OPEN_DAYS = [
  "2026-10-13",
  "2026-10-14",
  "2026-10-15",
  "2026-10-16",
  "2026-10-19",
  "2026-10-20",
];

function draft(input: Partial<WatchlistDraft> & { code: string; name: string }): WatchlistDraft {
  return {
    sources: ["post_close"],
    tags: ["打板接力"],
    resonance: false,
    priority: "P2",
    priority_reason: "测试",
    stage: "首板",
    streak_count: 2,
    t_facts: {},
    key_levels: { prev_close: 10, limit_up_price: 11, stop_price: 10.56, invalidation_price: 10.56 },
    auction_expect: {},
    intraday_plan: {},
    risk: { stop_pct: 4, position_cap_pct: 30 },
    review_status: "pass",
    risk_level: "unknown",
    risk_flags: [],
    review_note: null,
    ...input,
  };
}

function boardDraft(overrides: Partial<WatchlistDraft> = {}): WatchlistDraft {
  return draft({ code: CODE, name: "打板测试", ...overrides });
}

function oneWordDraft(overrides: Partial<WatchlistDraft> = {}): WatchlistDraft {
  return boardDraft({ tags: ["一字延续"], ...overrides });
}

function lowBuyDraft(overrides: Partial<WatchlistDraft> = {}): WatchlistDraft {
  return draft({
    code: CODE,
    name: "低吸测试",
    tags: ["龙回头"],
    sources: ["low_buy"],
    streak_count: null,
    key_levels: { prev_close: 10, limit_up_price: 11, stop_price: 9.6, invalidation_price: 9.6 },
    risk: { stop_pct: 4, position_cap_pct: 20 },
    ...overrides,
  });
}

function snapshot(code: string, close: number, at: Date, volume = 1_000_000): SnapshotQuote {
  return {
    code,
    timestampMs: at.getTime() - 5_000,
    open: close,
    high: close,
    low: close,
    close,
    prevClose: 10,
    volume,
    turnover: 20_000_000,
  };
}

interface NotifyCall {
  code: string;
  action: string;
  reason: string;
  stage: number;
}

function notifySpy(): { calls: NotifyCall[]; notify: FastLaneNotify } {
  const calls: NotifyCall[] = [];
  const notify: FastLaneNotify = async (_db, candidate, decision) => {
    calls.push({
      code: candidate.code,
      action: decision.action,
      reason: decision.reason,
      stage: candidate.exit_stage ?? 0,
    });
    return true;
  };
  return { calls, notify };
}

const BOARD_PATCH: WatchlistPatch = { entry_price: 11, position_opened_at: "2026-10-19" };
const LOW_BUY_PATCH: WatchlistPatch = { entry_price: 10, position_opened_at: "2026-10-19" };

describe("05 快速层窗口（上海时区）", () => {
  it("09:25 开始、15:00 结束，窗口外不运行", () => {
    expect(isFastLaneWindow(new Date("2026-10-20T01:24:59Z"))).toBe(false);
    expect(isFastLaneWindow(new Date("2026-10-20T01:25:00Z"))).toBe(true);
    expect(isFastLaneWindow(new Date("2026-10-20T06:59:59Z"))).toBe(true);
    expect(isFastLaneWindow(new Date("2026-10-20T03:29:00Z"))).toBe(true);
    // 午休 11:30–13:00 不轮询。
    expect(isFastLaneWindow(new Date("2026-10-20T03:30:00Z"))).toBe(false);
    expect(isFastLaneWindow(new Date("2026-10-20T04:59:00Z"))).toBe(false);
    expect(isFastLaneWindow(new Date("2026-10-20T05:00:00Z"))).toBe(true);
    expect(isFastLaneWindow(new Date("2026-10-20T07:00:00Z"))).toBe(false);
  });
});

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("05 快速层（真实测试库）", () => {
  let pool: pg.Pool;

  async function seedTradingDays(): Promise<void> {
    for (const day of OPEN_DAYS) {
      await pool.query(
        `INSERT INTO market_trading_day (trade_date, is_open, source) VALUES ($1::date, true, 'test')
         ON CONFLICT (trade_date) DO UPDATE SET is_open = true`,
        [day],
      );
    }
  }

  async function resetAll(): Promise<void> {
    await pool.query("DELETE FROM ultra_short_watchlist");
    await pool.query("DELETE FROM notification_delivery");
    await pool.query("DELETE FROM portfolio_position_change");
    await pool.query("DELETE FROM market_instrument");
    await pool.query("DELETE FROM market_trading_day");
    await seedTradingDays();
  }

  async function seedRows(rows: Array<{ draft: WatchlistDraft; patch?: WatchlistPatch }>): Promise<void> {
    await replaceWatchlist(pool, TARGET, DATA_DATE, rows.map((item) => item.draft));
    for (const row of rows) {
      await updateWatchlist(pool, TARGET, row.draft.code, {
        exit_status: "holding",
        ...row.patch,
      });
    }
  }

  async function loadRow(code = CODE): Promise<UltraShortWatchlistRow> {
    const row = await getWatchlistRow(pool, TARGET, code);
    if (!row) throw new Error(`关注池行不存在：${code}`);
    return row;
  }

  function makeLane(input: {
    quotes: () => Map<string, SnapshotQuote>;
    now?: () => Date;
    pools?: () => FastLanePoolData;
    notify?: FastLaneNotify;
    notifyDigest?: FastLaneNotifyDigest;
  }): UltraShortFastLane {
    return new UltraShortFastLane(pool, {
      fetchQuotes: async (codes) => {
        const quotes = input.quotes();
        return codes
          .map((code) => quotes.get(code))
          .filter((quote): quote is SnapshotQuote => quote !== undefined);
      },
      fetchPools: async () => input.pools?.() ?? { up: [], break: [] },
      now: input.now,
      notify: input.notify,
      notifyDigest: input.notifyDigest,
    });
  }

  async function deliveryCount(): Promise<number> {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM notification_delivery WHERE kind = 'ultra_short'",
    );
    return result.rows[0]?.count ?? 0;
  }

  async function seedStopLoss(): Promise<void> {
    const instrument = await pool.query<{ id: string }>(
      `INSERT INTO market_instrument (code, name, kind) VALUES ($1, '测试股', 'stock')
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [CODE],
    );
    await pool.query(
      `INSERT INTO portfolio_position_change
        (account_id, instrument_id, change_date, kind, quantity, price, amount, source,
         realized_pnl, strategy_code, strategy_runtime_version, exit_policy_mode)
       VALUES (1, $1, $2::date, 'sell', 100, 9, 900, 'form', -100, 'limit_up', 1, 'fallback_only')`,
      [instrument.rows[0]!.id, TRADE_DATE],
    );
  }

  beforeAll(async () => {
    pool = createPool(prepared!.url);
    await resetSchema(pool);
    await runMigrations(pool);
    // 只验证入队与去重，不发真实请求；webhook 用不可解析占位地址。
    await pool.query(
      "UPDATE notification_setting SET enabled = true, webhook = 'https://example.invalid/hook', sign_secret = 'test-secret' WHERE singleton",
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await resetAll();
  });

  it("窗口外返回 null：不取行情、不取池、不改关注池", async () => {
    await seedRows([{ draft: boardDraft(), patch: BOARD_PATCH }]);
    let externalCalls = 0;
    const lane = new UltraShortFastLane(pool, {
      now: () => new Date("2026-10-20T00:00:00Z"), // 08:00 上海
      fetchQuotes: async () => {
        externalCalls += 1;
        return [];
      },
      fetchPools: async () => {
        externalCalls += 1;
        return { up: [], break: [] };
      },
    });
    expect(await lane.tick()).toBeNull();
    expect(externalCalls).toBe(0);
    expect(await loadRow()).toMatchObject({
      exit_status: "holding",
      exit_reason: null,
      exit_reminder_type: null,
    });
  });


  it("一字板开板不足 60 秒按 A 强回封持有：不写退出字段、不提醒", async () => {
    await seedRows([{ draft: oneWordDraft(), patch: BOARD_PATCH }]);
    const spy = notifySpy();
    let at = NOW;
    const quotes = new Map<string, SnapshotQuote>([[CODE, snapshot(CODE, 11, at)]]);
    const lane = makeLane({
      quotes: () => quotes,
      now: () => at,
      notify: spy.notify,
      pools: () => ({ up: [{ ticker: CODE, seal_money: 900, max_seal_money: 1000 }], break: [] }),
    });

    expect(await lane.tick()).toMatchObject({ checked: 1, exited: 0, reminded: 0 });
    at = new Date(NOW.getTime() + 5_000);
    quotes.set(CODE, snapshot(CODE, 10.95, at));
    expect(await lane.tick()).toMatchObject({ checked: 1, exited: 0, reminded: 0 });

    expect(spy.calls).toHaveLength(0);
    expect(await loadRow()).toMatchObject({
      exit_status: "holding",
      exit_reason: null,
      exit_stage: 0,
      exit_reminder_type: null,
    });
  });

  it("打板开板 1–3 分钟封单未恢复按 B 弱回封卖一半", async () => {
    await seedRows([{ draft: boardDraft(), patch: BOARD_PATCH }]);
    const spy = notifySpy();
    let at = NOW;
    const quotes = new Map<string, SnapshotQuote>([[CODE, snapshot(CODE, 11, at)]]);
    const lane = makeLane({
      quotes: () => quotes, now: () => at, notify: spy.notify,
      pools: () => ({
        up: [{ ticker: CODE, seal_money: at.getTime() < NOW.getTime() + 10_000 ? 900 : 500, max_seal_money: 1000 }],
        break: [],
      }),
    });

    await lane.tick(); // 封板
    at = new Date(NOW.getTime() + 5_000);
    quotes.set(CODE, snapshot(CODE, 10.95, at));
    await lane.tick(); // 第一次确认开板，60 秒内先持有
    at = new Date(NOW.getTime() + 70_000);
    quotes.set(CODE, snapshot(CODE, 10.9, at));
    const decided = await lane.tick();

    expect(decided).toMatchObject({ exited: 1, reminded: 1 });
    expect(spy.calls).toEqual([{ code: CODE, action: "sell_half", reason: "board_open_weak", stage: 1 }]);
    expect(await loadRow()).toMatchObject({
      exit_status: "exit_triggered",
      exit_reason: "board_open_weak",
      exit_stage: 1,
      exit_reminder_type: "board_open_weak:1",
    });
  });

  it("打板开板超过 3 分钟按 C 弱转跌清仓", async () => {
    await seedRows([{ draft: boardDraft(), patch: BOARD_PATCH }]);
    const spy = notifySpy();
    let at = NOW;
    const quotes = new Map<string, SnapshotQuote>([[CODE, snapshot(CODE, 11, at)]]);
    const lane = makeLane({
      quotes: () => quotes, now: () => at, notify: spy.notify,
      pools: () => ({
        up: [{
          ticker: CODE,
          seal_money: at.getTime() < NOW.getTime() + 10_000 ? 900
            : at.getTime() < NOW.getTime() + 100_000 ? 500 : 350,
          max_seal_money: 1000,
        }],
        break: [],
      }),
    });

    await lane.tick();
    at = new Date(NOW.getTime() + 5_000);
    quotes.set(CODE, snapshot(CODE, 10.95, at));
    await lane.tick();
    at = new Date(NOW.getTime() + 70_000);
    quotes.set(CODE, snapshot(CODE, 10.9, at));
    await lane.tick();
    at = new Date(NOW.getTime() + 200_000);
    quotes.set(CODE, snapshot(CODE, 10.8, at));
    const decided = await lane.tick();

    expect(decided).toMatchObject({ exited: 1, reminded: 1 });
    expect(spy.calls.map((call) => call.action)).toEqual(["sell_half", "sell_all"]);
    expect(spy.calls.at(-1)).toMatchObject({ reason: "board_break", stage: 2 });
    expect(await loadRow()).toMatchObject({
      exit_status: "exit_triggered",
      exit_reason: "board_break",
      exit_stage: 2,
      exit_reminder_type: "board_break:2",
    });
  });




  it("打板硬止损：跌破止损位立即清仓，且快速层不写盘中采样", async () => {
    await seedRows([{ draft: boardDraft(), patch: BOARD_PATCH }]);
    const spy = notifySpy();
    const at = NOW;
    const quotes = new Map<string, SnapshotQuote>([[CODE, snapshot(CODE, 10.5, at)]]);
    const lane = makeLane({ quotes: () => quotes, now: () => at, notify: spy.notify });

    const summary = await lane.tick();
    expect(summary).toMatchObject({ checked: 1, exited: 1, reminded: 1 });
    expect(spy.calls[0]).toMatchObject({ action: "sell_all", reason: "hard_stop", stage: 2 });
    expect(await loadRow()).toMatchObject({
      exit_status: "exit_triggered",
      exit_reason: "hard_stop",
      exit_stage: 2,
      exit_reminder_type: "hard_stop:2",
    });
    const samples = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM intraday_market_sample",
    );
    expect(samples.rows[0]?.count).toBe(0);
  });

  it("打板 D+1 14:50 仍未封板：时间止损清仓", async () => {
    await seedRows([{ draft: boardDraft(), patch: BOARD_PATCH }]);
    const spy = notifySpy();
    const at = new Date("2026-10-20T06:51:00Z"); // 14:51 上海
    const quotes = new Map<string, SnapshotQuote>([[CODE, snapshot(CODE, 10.8, at)]]);
    const lane = makeLane({ quotes: () => quotes, now: () => at, notify: spy.notify });

    expect(await lane.tick()).toMatchObject({ exited: 1, reminded: 1 });
    expect(spy.calls[0]).toMatchObject({ action: "sell_all", reason: "time_stop", stage: 2 });
    expect(await loadRow()).toMatchObject({ exit_status: "exit_triggered", exit_reason: "time_stop", exit_stage: 2 });
  });

  it("低吸第一止盈 +1.5R 卖一半", async () => {
    await seedRows([{ draft: lowBuyDraft(), patch: LOW_BUY_PATCH }]);
    const spy = notifySpy();
    const at = NOW;
    const quotes = new Map<string, SnapshotQuote>([[CODE, snapshot(CODE, 10.65, at)]]);
    const lane = makeLane({ quotes: () => quotes, now: () => at, notify: spy.notify });

    expect(await lane.tick()).toMatchObject({ exited: 1, reminded: 1 });
    expect(spy.calls[0]).toMatchObject({ action: "sell_half", reason: "target_1", stage: 1 });
    expect(await loadRow()).toMatchObject({ exit_status: "exit_triggered", exit_reason: "target_1", exit_stage: 1 });
  });




  it("同一行同原因同阶段只提醒一次，第二次 tick 不再入队", async () => {
    await seedRows([{ draft: boardDraft(), patch: BOARD_PATCH }]);
    let notifyCalls = 0;
    const notify: FastLaneNotify = async (db, candidate, decision) => {
      notifyCalls += 1;
      return enqueueBatchAlert(db, {
        kind: "ultra_short",
        event_key: `legacy-test:${candidate.code}:${decision.reason}:${candidate.exit_stage ?? 0}`,
        content: `${candidate.code} ${decision.action} ${decision.reason}`,
      });
    };
    let at = NOW;
    const quotes = new Map<string, SnapshotQuote>([[CODE, snapshot(CODE, 10.5, at)]]);
    const lane = makeLane({ quotes: () => quotes, now: () => at, notify });

    expect(await lane.tick()).toMatchObject({ exited: 1, reminded: 1 });
    const first = await loadRow();
    at = new Date(NOW.getTime() + 5_000);
    quotes.set(CODE, snapshot(CODE, 10.5, at));
    expect(await lane.tick()).toMatchObject({ exited: 0, reminded: 0 });
    const second = await loadRow();

    expect(notifyCalls).toBe(1);
    expect(await deliveryCount()).toBe(1);
    expect(second.exit_reminder_at).toBe(first.exit_reminder_at);
    expect(second.exit_reminder_type).toBe("hard_stop:2");
  });

  it("批量退出：多只持仓只发一条汇总，同一内容不重复", async () => {
    await seedRows([{ draft: boardDraft(), patch: BOARD_PATCH }]);
    const calls: Array<{ content: string; key: string }> = [];
    const at = NOW;
    const quotes = new Map<string, SnapshotQuote>([[CODE, snapshot(CODE, 10.5, at)]]);
    const lane = makeLane({
      quotes: () => quotes,
      now: () => at,
      notifyDigest: async (_db, content, eventKey) => { calls.push({ content, key: eventKey }); return true; },
    });
    expect(await lane.tick()).toMatchObject({ exited: 1, reminded: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.content).toContain("600000.SH");
    expect(calls[0]!.content).toContain("清仓");
    await lane.tick();
    expect(calls).toHaveLength(1);
  });

  it("缺行情、未来数据、非当日行情都不写不提醒", async () => {
    await seedRows([{ draft: boardDraft(), patch: BOARD_PATCH }]);
    const spy = notifySpy();
    const at = NOW;

    const emptyQuotes = new Map<string, SnapshotQuote>();
    const missing = await makeLane({ quotes: () => emptyQuotes, now: () => at, notify: spy.notify }).tick();
    expect(missing).toMatchObject({ checked: 0, exited: 0, reminded: 0 });
    expect(missing!.gaps.join("；")).toContain(CODE);

    const futureQuotes = new Map<string, SnapshotQuote>([[
      CODE,
      { ...snapshot(CODE, 10.5, at), timestampMs: at.getTime() + 120_000 },
    ]]);
    const future = await makeLane({ quotes: () => futureQuotes, now: () => at, notify: spy.notify }).tick();
    expect(future).toMatchObject({ checked: 0, exited: 0 });
    expect(future!.gaps.join("；")).toContain("未来数据");

    const staleQuotes = new Map<string, SnapshotQuote>([[
      CODE,
      { ...snapshot(CODE, 10.5, at), timestampMs: at.getTime() - 10 * 60_000 },
    ]]);
    const stale = await makeLane({ quotes: () => staleQuotes, now: () => at, notify: spy.notify }).tick();
    expect(stale).toMatchObject({ checked: 0, exited: 0 });

    expect(spy.calls).toHaveLength(0);
    expect(await loadRow()).toMatchObject({ exit_status: "holding", exit_reminder_type: null });
  });

  it("连亏熔断只报告：>=2 次止损时 circuit_broken=true，但不阻止已持仓退出", async () => {
    await seedRows([{ draft: boardDraft(), patch: BOARD_PATCH }]);
    const spy = notifySpy();
    let at = NOW;
    const quotes = new Map<string, SnapshotQuote>([[CODE, snapshot(CODE, 10.5, at)]]);
    const lane = makeLane({ quotes: () => quotes, now: () => at, notify: spy.notify });

    await seedStopLoss();
    const oneLoss = await lane.tick();
    expect(oneLoss).toMatchObject({ exited: 1, circuit_broken: false });

    await updateWatchlist(pool, TARGET, CODE, {
      exit_status: "holding",
      exit_reason: null,
      exit_stage: 0,
      exit_reminder_at: null,
      exit_reminder_type: null,
    });
    await seedStopLoss();
    at = new Date(NOW.getTime() + 5_000);
    quotes.set(CODE, snapshot(CODE, 10.5, at));
    const twoLosses = await lane.tick();
    expect(twoLosses).toMatchObject({ exited: 1, circuit_broken: true });
  });

});
