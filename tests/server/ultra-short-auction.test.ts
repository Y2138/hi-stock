// 01 竞价判定测试：分支/成交概率/优先级/提醒状态机纯函数，加真实测试库的采样写回与提醒去重。
// 所有外部 HTTP 均 mock（vi.stubGlobal fetch）；DB 用例使用 tests/server/helpers.ts 的 prepareTestDb。
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createPool } from "../../server/db/client.js";
import { runMigrations } from "../../server/db/migrate.js";
import { RateLimiter } from "../../server/datasource/ratelimit.js";
import {
  auctionFillTier,
  auctionPriority,
  judgeAuctionBranch,
  planAuctionReminder,
  runUltraShortAuctionCycle,
  type AuctionMetrics,
  type AuctionReminderInput,
} from "../../server/modules/ultra-short/auction.js";
import { listWatchlist, replaceWatchlist } from "../../server/modules/ultra-short/repo.js";
import type { UltraShortWatchlistRow, WatchlistDraft } from "../../server/modules/ultra-short/types.js";
import { prepareTestDb, resetSchema } from "./helpers.js";

const prepared = await prepareTestDb();
const noopSleep = async () => {};
// 与 datasource.test.ts 同一口径：不限流、不等待，避免测试依赖真实网络与 3 秒间隔。
const deps = { limiter: new RateLimiter(0, noopSleep), sleep: noopSleep, apiKey: "test-placeholder" };

const TRADE_DATE = "2026-10-20";
const DATA_DATE = "2026-10-19";
const CODE = "600001.SH";

function makeRow(overrides: Partial<UltraShortWatchlistRow> = {}): UltraShortWatchlistRow {
  return {
    id: "1",
    target_date: TRADE_DATE,
    data_date: DATA_DATE,
    code: CODE,
    name: "测试股",
    sources: ["post_close"],
    tags: ["一字延续"],
    resonance: true,
    priority: "P1",
    priority_reason: "测试",
    stage: "2进3",
    streak_count: 2,
    t_facts: {},
    key_levels: { prev_close: 10, limit_up_price: 11, stop_price: 9.5 },
    auction_expect: {},
    intraday_plan: {},
    risk: { stop_pct: 5, position_cap_pct: 30 },
    review_status: "pass",
    risk_level: "low",
    risk_flags: [],
    review_note: null,
    review_sources: [],
    auction_branch: null,
    auction_fill_tier: null,
    auction_priority: null,
    auction_metrics: {},
    queue_window: {},
    auction_note: null,
    auction_status: "pending",
    intraday_status: "waiting",
    trigger_type: null,
    trigger_at: null,
    trigger_price: null,
    trigger_reason: null,
    intraday_note: null,
    reminder_at: null,
    reminder_type: null,
    reminder_status: null,
    reminder_note: null,
    gaps: [],
    data_status: "ready",
    entry_price: null,
    position_opened_at: null,
    exit_status: "none",
    exit_stage: 0,
    exit_reason: null,
    exit_price: null,
    exit_at: null,
    realized_r: null,
    exit_reminder_at: null,
    exit_reminder_type: null,
    updated_at: "2026-10-20T09:00:00+08:00",
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<AuctionMetrics> = {}): AuctionMetrics {
  return {
    auction_price: 11,
    auction_pct: 10,
    auction_unmatched: 300000,
    auction_volume: 600000,
    auction_amount: 6_600_000,
    auction_turnover_pct: 2,
    auction_volume_ratio: 3,
    auction_yesterday_ratio_pct: 20,
    float_market_cap: 5_000_000_000,
    unmatched_ratio: 0.5,
    data_status: "ready",
    data_gaps: [],
    ...overrides,
  };
}

function reminderInput(overrides: Partial<AuctionReminderInput> = {}): AuctionReminderInput {
  return {
    branch: "one_word",
    fill_tier: "high",
    status: "ready",
    review_status: "pass",
    risk_level: "low",
    auction_unmatched: 300000,
    auction_turnover_pct: 2,
    minute_of_day: 9 * 60 + 21,
    reminder_type: null,
    reminder_note: null,
    ...overrides,
  };
}

describe("01 竞价分支纯判定", () => {
  it("一字延续：达涨停、未匹配为正、换手≤10% → one_word 高概率 P1", () => {
    const judgement = judgeAuctionBranch(makeRow(), makeMetrics(), null, { same_height_best_pct: null });
    expect(judgement.branch).toBe("one_word");
    expect(judgement.fill_tier).toBe("high");
    expect(judgement.priority).toBe("P1");
    expect(judgement.status).toBe("ready");
    expect(judgement.queue_window).toMatchObject({ window: "09:20-09:24", price: 11 });
  });


  it("换手晋级：0–5%、未匹配为正 → turnover_advance；强于同高度才 P1", () => {
    const metrics = makeMetrics({
      auction_price: 10.3,
      auction_pct: 3,
      auction_unmatched: 100000,
      unmatched_ratio: 0.2,
      auction_turnover_pct: 3,
    });
    const stronger = judgeAuctionBranch(makeRow(), metrics, null, { same_height_best_pct: 2 });
    expect(stronger.branch).toBe("turnover_advance");
    expect(stronger.fill_tier).toBe("none");
    expect(stronger.priority).toBe("P1");
    expect(stronger.queue_window).toEqual({});
    const weaker = judgeAuctionBranch(makeRow(), metrics, null, { same_height_best_pct: 4 });
    expect(weaker.priority).toBe("P2");
  });

  it("高开过度：非一字、涨幅>5% → high_open P3", () => {
    const judgement = judgeAuctionBranch(makeRow(), makeMetrics({
      auction_price: 10.7,
      auction_pct: 7,
      auction_unmatched: 10000,
      unmatched_ratio: 0.1,
      auction_turnover_pct: 5,
    }), null, {});
    expect(judgement.branch).toBe("high_open");
    expect(judgement.priority).toBe("P3");
    expect(judgement.queue_window).toEqual({});
  });

  it("低开分歧：低于前收但买方未匹配为正 → low_open P3", () => {
    const judgement = judgeAuctionBranch(makeRow(), makeMetrics({
      auction_price: 9.8,
      auction_pct: -2,
      auction_unmatched: 50000,
      unmatched_ratio: 0.3,
      auction_turnover_pct: 4,
    }), null, {});
    expect(judgement.branch).toBe("low_open");
    expect(judgement.priority).toBe("P3");
  });

  it("走弱：未匹配转负、换手超限、跌停都判 weak", () => {
    const negative = judgeAuctionBranch(makeRow(), makeMetrics({
      auction_unmatched: -1000,
      unmatched_ratio: -0.2,
    }), null, {});
    expect(negative.branch).toBe("weak");
    const turnover = judgeAuctionBranch(makeRow(), makeMetrics({
      auction_price: 10.5,
      auction_pct: 5,
      auction_turnover_pct: 12,
      unmatched_ratio: 0.4,
    }), null, {});
    expect(turnover.branch).toBe("weak");
    const limitDown = judgeAuctionBranch(makeRow(), makeMetrics({
      auction_price: 9,
      auction_pct: -10,
      auction_unmatched: 100,
      unmatched_ratio: 0.1,
    }), null, {});
    expect(limitDown.branch).toBe("weak");
  });

  it("数据不足：关键字段缺失 → insufficient，不猜", () => {
    const judgement = judgeAuctionBranch(makeRow(), makeMetrics({
      auction_price: null,
      auction_pct: null,
      data_status: "insufficient",
      data_gaps: ["竞价快照缺失"],
    }), null, {});
    expect(judgement.branch).toBe("insufficient");
    expect(judgement.fill_tier).toBe("none");
    expect(judgement.priority).toBe("P3");
    expect(judgement.status).toBe("insufficient");
    expect(String(judgement.note)).toContain("数据不足");
  });


});

describe("01 成交概率与优先级纯函数", () => {
  it("成交概率三档：高/中/低/无", () => {
    expect(auctionFillTier({
      auction_unmatched: 100, auction_turnover_pct: 1.5, unmatched_ratio: 1.5, auction_volume: 1000,
    })).toBe("high");
    expect(auctionFillTier({
      auction_unmatched: 100, auction_turnover_pct: 1, unmatched_ratio: 3, auction_volume: 1000,
    })).toBe("medium");
    expect(auctionFillTier({
      auction_unmatched: 100, auction_turnover_pct: 0.5, unmatched_ratio: 8, auction_volume: 1000,
    })).toBe("low");
    expect(auctionFillTier({
      auction_unmatched: -100, auction_turnover_pct: 1, unmatched_ratio: 1, auction_volume: 1000,
    })).toBe("none");
  });

  it("优先级：一字按成交概率分 P1/P2/P3，换手晋级按同高度强弱分 P1/P2", () => {
    expect(auctionPriority({ branch: "one_word", fill_tier: "high", auction_pct: 10, auction_unmatched: 100 })).toBe("P1");
    expect(auctionPriority({ branch: "one_word", fill_tier: "medium", auction_pct: 10, auction_unmatched: 100 })).toBe("P2");
    expect(auctionPriority({ branch: "one_word", fill_tier: "low", auction_pct: 10, auction_unmatched: 100 })).toBe("P3");
    expect(auctionPriority({
      branch: "turnover_advance", fill_tier: "none", auction_pct: 3, auction_unmatched: 100, same_height_best_pct: 2,
    })).toBe("P1");
    expect(auctionPriority({
      branch: "turnover_advance", fill_tier: "none", auction_pct: 3, auction_unmatched: 100, same_height_best_pct: null,
    })).toBe("P2");
    expect(auctionPriority({
      branch: "turnover_advance", fill_tier: "none", auction_pct: 3, auction_unmatched: -100, same_height_best_pct: 2,
    })).toBe("P2");
    expect(auctionPriority({ branch: "weak", fill_tier: "none", auction_pct: 3, auction_unmatched: -100 })).toBe("P3");
  });
});

describe("01 一字提醒状态机", () => {
  it("只在 09:20–09:24 发买入提醒，09:18/09:19/09:25 不发", () => {
    expect(planAuctionReminder(reminderInput({ minute_of_day: 9 * 60 + 18 })).action).toBe("none");
    expect(planAuctionReminder(reminderInput({ minute_of_day: 9 * 60 + 19 })).action).toBe("none");
    expect(planAuctionReminder(reminderInput({ minute_of_day: 9 * 60 + 20 })).action).toBe("buy");
    expect(planAuctionReminder(reminderInput({ minute_of_day: 9 * 60 + 24 })).action).toBe("buy");
    expect(planAuctionReminder(reminderInput({ minute_of_day: 9 * 60 + 25 })).action).toBe("none");
  });


  it("复核 invalid 或风险 high 不发买入提醒", () => {
    expect(planAuctionReminder(reminderInput({ review_status: "invalid" })).action).toBe("none");
    expect(planAuctionReminder(reminderInput({ risk_level: "high" })).action).toBe("none");
    expect(planAuctionReminder(reminderInput({ branch: "turnover_advance", fill_tier: "none" })).action).toBe("none");
    expect(planAuctionReminder(reminderInput({ status: "insufficient" })).action).toBe("none");
  });


  it("成交概率档升级最多再发一次升级提醒", () => {
    const baseline = JSON.stringify({ fill_tier: "low", turnover_pct: 0.5, auction_unmatched: 100000 });
    const upgrade = planAuctionReminder(reminderInput({
      reminder_type: "auction_buy",
      reminder_note: baseline,
      fill_tier: "high",
      auction_turnover_pct: 2,
    }));
    expect(upgrade.action).toBe("upgrade");
    const again = planAuctionReminder(reminderInput({
      reminder_type: "auction_upgrade",
      reminder_note: JSON.stringify({ fill_tier: "high", turnover_pct: 2, auction_unmatched: 300000 }),
      fill_tier: "high",
      auction_turnover_pct: 3,
    }));
    expect(again.action).toBe("none");
  });


  it("提醒后条件恶化发撤单提醒；已撤单不再重复", () => {
    expect(planAuctionReminder(reminderInput({ reminder_type: "auction_buy", branch: "weak" })).action).toBe("cancel");
    expect(planAuctionReminder(reminderInput({ reminder_type: "auction_buy", risk_level: "high" })).action).toBe("cancel");
    expect(planAuctionReminder(reminderInput({ reminder_type: "auction_buy", review_status: "invalid" })).action).toBe("cancel");
    expect(planAuctionReminder(reminderInput({ reminder_type: "auction_buy", status: "insufficient" })).action).toBe("cancel");
    expect(planAuctionReminder(reminderInput({ reminder_type: "auction_cancel" })).action).toBe("none");
  });
});

interface SnapshotRowInput {
  code?: string;
  price?: number | null;
  pct?: number | null;
  unmatched?: number | null;
  volume?: number | null;
  amount?: number | null;
  turnover?: number | null;
  volumeRatio?: number | null;
  yesterdayRatio?: number | null;
  floatCap?: number | null;
}

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ code: 0, message: "success", data }),
    text: async () => "",
  } as unknown as Response;
}

function failedResponse(detail: string): Response {
  return {
    ok: false,
    status: 500,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => detail,
  } as unknown as Response;
}

/** mock 扶摇两个端点；snapshot=null 表示快照请求失败，benchmark=null 表示基准请求失败。 */
function installFetchMock(input: {
  stage: "live" | "final";
  snapshot: SnapshotRowInput[] | null;
  timestampMs?: number | null;
  benchmark?: Record<string, unknown> | null;
}): ReturnType<typeof vi.fn> {
  const timestamp = input.timestampMs === undefined
    ? Date.parse(`${TRADE_DATE}T09:21:30+08:00`)
    : input.timestampMs;
  const mock = vi.fn(async (url: string | URL) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/a-share/auction/snapshot") {
      expect(parsed.searchParams.get("stage")).toBe(input.stage);
      if (input.snapshot === null) return failedResponse("upstream error");
      return jsonResponse({
        timestamp,
        data_status: "ready",
        item: input.snapshot.map((row) => ({
          thscode: row.code ?? CODE,
          auction_price: row.price ?? null,
          auction_pct: row.pct ?? null,
          auction_unmatched: row.unmatched ?? null,
          auction_volume: row.volume ?? null,
          auction_amount: row.amount ?? null,
          auction_turnover_pct: row.turnover ?? null,
          auction_volume_ratio: row.volumeRatio ?? null,
          auction_yesterday_ratio_pct: row.yesterdayRatio ?? null,
          float_market_cap: row.floatCap ?? null,
        })),
      });
    }
    if (parsed.pathname === "/api/a-share/auction/short-term-benchmark") {
      expect(parsed.searchParams.get("date")).toBe(TRADE_DATE);
      if (input.benchmark === null) return failedResponse("benchmark down");
      return jsonResponse({
        date: TRADE_DATE,
        timestamp,
        item: [input.benchmark ?? { benchmark_pct: 1.2 }],
      });
    }
    throw new Error(`未预期 URL: ${parsed}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function draft(overrides: Partial<WatchlistDraft> = {}): WatchlistDraft {
  return {
    code: CODE,
    name: "测试股",
    sources: ["post_close"],
    tags: ["一字延续"],
    resonance: false,
    priority: "P1",
    priority_reason: "测试",
    stage: "2进3",
    streak_count: 2,
    t_facts: {},
    key_levels: { prev_close: 10, limit_up_price: 11, stop_price: 9.5 },
    auction_expect: {},
    intraday_plan: {},
    risk: { stop_pct: 5, position_cap_pct: 30 },
    review_status: "pass",
    risk_level: "low",
    risk_flags: [],
    review_note: null,
    gaps: [],
    data_status: "ready",
    ...overrides,
  };
}

const ONE_WORD_SNAPSHOT: SnapshotRowInput = {
  price: 11,
  pct: 10,
  unmatched: 300000,
  volume: 600000,
  amount: 6_600_000,
  turnover: 2,
  volumeRatio: 3,
  yesterdayRatio: 20,
  floatCap: 5_000_000_000,
};

describe.skipIf(!prepared)("01 竞价判定 DB 写回与提醒（stock_test 真实库）", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createPool(prepared!.url);
    await resetSchema(pool);
    await runMigrations(pool);
    await pool.query(
      `UPDATE notification_setting
          SET personal_enabled = true,
              personal_webhook = 'https://example.invalid/hook',
              personal_sign_secret = 'test-secret'
        WHERE singleton`,
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function seed(rows: WatchlistDraft[]): Promise<void> {
    await pool.query("DELETE FROM auction_intraday_sample");
    await pool.query("DELETE FROM notification_delivery");
    await replaceWatchlist(pool, TRADE_DATE, DATA_DATE, rows);
  }

  async function deliveryKeys(): Promise<string[]> {
    const rows = await pool.query<{ event_key: string | null }>(
      "SELECT event_key FROM notification_delivery WHERE kind = 'ultra_short' ORDER BY event_key",
    );
    return rows.rows.map((row) => String(row.event_key));
  }

  async function onlyWatchlistRow(code = CODE): Promise<UltraShortWatchlistRow> {
    const rows = await listWatchlist(pool, TRADE_DATE);
    return rows.find((row) => row.code === code)!;
  }

  it("09:21 一字延续首次采样立即提醒，写回判定与采样", async () => {
    await seed([draft()]);
    const mock = installFetchMock({ stage: "live", snapshot: [ONE_WORD_SNAPSHOT] });
    const result = await runUltraShortAuctionCycle(pool, new Date(`${TRADE_DATE}T09:21:00+08:00`), { deps });

    expect(result).toMatchObject({
      trade_date: TRADE_DATE,
      stage: "live",
      sampled: 1,
      judged: 1,
      reminders: 1,
      status: "success",
    });
    expect(mock).toHaveBeenCalledTimes(1);
    const row = await onlyWatchlistRow();
    expect(row).toMatchObject({
      auction_branch: "one_word",
      auction_fill_tier: "high",
      auction_priority: "P1",
      auction_status: "ready",
      reminder_type: "auction_buy",
      reminder_status: "sent",
    });
    expect(row.reminder_at).not.toBeNull();
    expect(row.auction_metrics.unmatched_ratio).toBeCloseTo(0.5);

    const sample = (await pool.query<{
      stage: string;
      auction_price: number;
      unmatched_ratio: number;
      source_at: Date | null;
    }>(
      `SELECT stage, auction_price::float8 AS auction_price, unmatched_ratio::float8 AS unmatched_ratio, source_at
         FROM auction_intraday_sample WHERE trade_date = $1 AND code = $2`,
      [TRADE_DATE, CODE],
    )).rows[0]!;
    expect(sample.stage).toBe("live");
    expect(Number(sample.auction_price)).toBe(11);
    expect(Number(sample.unmatched_ratio)).toBeCloseTo(0.5);
    expect(sample.source_at?.getTime()).toBe(Date.parse(`${TRADE_DATE}T09:21:30+08:00`));
    expect(await deliveryKeys()).toEqual([`ultra:auction_buy:${TRADE_DATE}:${CODE}`]);
  });







  it("快照取数失败不抛错，标 insufficient 并返回 gaps", async () => {
    await seed([draft()]);
    installFetchMock({ stage: "live", snapshot: null });
    const result = await runUltraShortAuctionCycle(pool, new Date(`${TRADE_DATE}T09:21:00+08:00`), { deps });
    expect(result.status).toBe("insufficient");
    expect(result.reminders).toBe(0);
    expect(result.gaps.some((gap) => gap.includes("竞价快照获取失败"))).toBe(true);
    const row = await onlyWatchlistRow();
    expect(row).toMatchObject({ auction_branch: "insufficient", auction_status: "insufficient" });
    const sample = (await pool.query<{ data_status: string }>(
      "SELECT data_status FROM auction_intraday_sample WHERE trade_date = $1 AND code = $2",
      [TRADE_DATE, CODE],
    )).rows[0]!;
    expect(sample.data_status).toBe("insufficient");
  });


});
