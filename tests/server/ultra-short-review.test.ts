// 03 复核写工具：只允许下调优先级、补充风险；不能新增候选或上调优先级。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { prepareTestDb } from "./helpers.js";
import { buildUltraShortReviewTool } from "../../server/agent/ultra-short-tools.js";
import { listWatchlist, replaceWatchlist } from "../../server/modules/ultra-short/repo.js";
import type { WatchlistDraft } from "../../server/modules/ultra-short/types.js";

const prepared = await prepareTestDb();

const TARGET = "2026-10-21";
const DATA = "2026-10-20";

function draft(code: string, name: string, priority: WatchlistDraft["priority"]): WatchlistDraft {
  return {
    code,
    name,
    sources: ["post_close"],
    tags: ["打板接力"],
    resonance: false,
    priority,
    priority_reason: "测试",
    stage: "首板",
    streak_count: 1,
    t_facts: {},
    key_levels: { prev_close: 10, limit_up_price: 11, stop_price: 10.5 },
    auction_expect: { branch: "unknown" },
    intraday_plan: { trigger: "none" },
    risk: { stop_pct: 4, position_cap_pct: 30, template: "打板" },
    review_status: "pass",
    risk_level: "unknown",
    risk_flags: [],
    review_note: null,
    gaps: [],
    data_status: "ready",
  };
}

describe.skipIf(!prepared)("超短关注池复核写入", () => {
  let pool: pg.Pool;
  const tool = () => buildUltraShortReviewTool({ pool, sessionId: null, jobCode: "limit_up_close_scan" });

  beforeAll(() => { pool = prepared!.pool; });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query("DELETE FROM ultra_short_watchlist WHERE target_date=$1::date", [TARGET]);
    await replaceWatchlist(pool, TARGET, DATA, [
      draft("600001.SH", "甲", "P1"),
      draft("600002.SH", "乙", "P2"),
    ]);
  });

  it("允许下调优先级并写入风险标签与来源", async () => {
    const result = await tool().execute("t1", {
      date: TARGET,
      reviews: [{
        code: "600001.SH",
        priority: "P3",
        risk_level: "high",
        review_status: "flag",
        risk_flags: ["监管问询"],
        review_note: "公告待核",
        review_sources: [{ title: "交易所公告", url: "https://example.com/a", kind: "announcement" }],
      }],
    }, undefined, undefined);
    expect((result.details as { rejected: unknown[] }).rejected).toHaveLength(0);
    const row = (await listWatchlist(pool, TARGET)).find((item) => item.code === "600001.SH")!;
    expect(row.priority).toBe("P3");
    expect(row.risk_level).toBe("high");
    expect(row.review_status).toBe("flag");
    expect(row.risk_flags).toEqual(["监管问询"]);
    expect(row.review_sources).toHaveLength(1);
  });

  it("拒绝上调优先级、未知代码，并保持原行不变", async () => {
    const result = await tool().execute("t2", {
      date: TARGET,
      reviews: [
        { code: "600002.SH", priority: "P1" },
        { code: "999999.SH", priority: "P2" },
      ],
    }, undefined, undefined);
    const details = result.details as { updated: unknown[]; rejected: Array<{ code: string; reason: string }> };
    expect(details.updated).toHaveLength(0);
    expect(details.rejected.map((item) => item.code)).toEqual(["600002.SH", "999999.SH"]);
    const row = (await listWatchlist(pool, TARGET)).find((item) => item.code === "600002.SH")!;
    expect(row.priority).toBe("P2");
  });

  it("传错数据日时按最近一次关注池的关注日写入，不写历史池", async () => {
    const later = "2026-10-22";
    await pool.query("DELETE FROM ultra_short_watchlist WHERE target_date IN ($1::date,$2::date)", [TARGET, later]);
    await replaceWatchlist(pool, TARGET, DATA, [draft("600001.SH", "旧池", "P1")]);
    await replaceWatchlist(pool, later, TARGET, [draft("600002.SH", "新池", "P1")]);
    const result = await tool().execute("t-date", {
      date: TARGET,
      reviews: [{ code: "600002.SH", priority: "P2", review_note: "应按最新关注日写入" }],
    }, undefined, undefined);
    expect((result.details as { date: string }).date).toBe(later);
    expect((result.details as { requested_date?: string }).requested_date).toBe(TARGET);
    expect((await listWatchlist(pool, later))[0]).toMatchObject({ priority: "P2", review_note: "应按最新关注日写入" });
    expect((await listWatchlist(pool, TARGET))[0]).toMatchObject({ priority: "P1", review_note: null });
  });

  it("只允许收盘打板任务调用", async () => {
    const wrongJob = buildUltraShortReviewTool({ pool, sessionId: null, jobCode: "first_board_intraday_scan" });
    await expect(wrongJob.execute("t3", { date: TARGET, reviews: [] }, undefined, undefined))
      .rejects.toThrow("只允许收盘打板任务");
  });

  it("空数组是有效复核，不报错", async () => {
    const result = await tool().execute("t4", { date: TARGET, reviews: [] }, undefined, undefined);
    expect((result.details as { updated: unknown[] }).updated).toHaveLength(0);
  });
});
