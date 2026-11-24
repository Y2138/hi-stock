import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { industryFreshness, queryIndustryCoverage } from "../../server/modules/market/industry-coverage.js";
import { marketRoutes } from "../../server/modules/market/routes.js";

describe("行业指数 freshness", () => {
  it("未调度、缺数据、过期、上游失败分别返回；成功目标日优先于旧失败", () => {
    expect(industryFreshness(false, "2026-11-17", "2026-11-17", null)).toBe("not_scheduled");
    expect(industryFreshness(true, null, "2026-11-17", null)).toBe("missing");
    expect(industryFreshness(true, "2026-08-24", "2026-11-17", null)).toBe("stale");
    expect(industryFreshness(true, "2026-08-24", "2026-11-17", "HTTP 503")).toBe("upstream_failed");
    expect(industryFreshness(true, "2026-11-17", "2026-11-17", "HTTP 503")).toBe("ok");
  });
  it("返回逐代码覆盖与日历未知状态，不把未来日历缺失猜为开市", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ code: "881112.TI", scheduled: true, latest_bar_date: "2026-11-17", history_count: 1252, upstream_error: null }] }).mockResolvedValueOnce({ rows: [] });
    const result = await queryIndustryCoverage({ query } as unknown as pg.Pool, ["881112.TI"], "2026-11-18");
    expect(result).toMatchObject({ target_date: "2026-11-18", calendar_status: "unknown", allowed_lag_trading_days: 0, items: [{ code: "881112.TI", freshness_status: "stale" }] });
    expect(query.mock.calls.every(([sql]) => /^\s*SELECT/.test(sql))).toBe(true);
  });
  it("HTTP 参数必须提供行业 codes 和严格有效目标日", async () => {
    for (const params of ["codes=881112.TI", "target_date=2026-11-18", "codes=881112.TI&target_date=2026-02-30", "codes=000819.SH&target_date=2026-11-18"]) {
      await expect(marketRoutes.coverage({ pool: {} as pg.Pool, params: {}, body: null, query: new URLSearchParams(params) })).rejects.toMatchObject({ httpStatus: 400 });
    }
  });
});
