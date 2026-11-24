import { beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
const mocks = vi.hoisted(() => ({ research: vi.fn(), fetch: vi.fn(), financial: vi.fn(), history: vi.fn() }));
vi.mock("../../server/modules/market/research.js", () => ({ queryStockResearch: mocks.research }));
vi.mock("../../server/datasource/service.js", () => ({ fetchAndStore: mocks.fetch, fetchFinancialAndStore: mocks.financial, fetchFundamentalHistoryAndStore: mocks.history }));
import { marketRoutes } from "../../server/modules/market/routes.js";
const ctx = (params: string) => ({ pool: {} as pg.Pool, params: {}, body: undefined, query: new URLSearchParams(params) });
beforeEach(() => { vi.clearAllMocks(); });
describe("研究接口只读参数边界", () => {
  it("日期与代码透传、去重，不调用抓取函数", async () => {
    const context = ctx("codes=600001.SH,000001.SZ,600001.SH&date=2026-03-02");
    mocks.research.mockResolvedValue({ data_source: "stored", items: [] });
    expect(await marketRoutes.research(context)).toEqual({ data: { data_source: "stored", items: [] } });
    expect(mocks.research).toHaveBeenCalledWith(context.pool, ["600001.SH", "000001.SZ"], "2026-03-02");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.financial).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
  });
  for (const params of ["", "codes=600001.SH", "codes=600001&date=2026-03-02", "codes=881112.TI&date=2026-03-02", "codes=600001.SH,&date=2026-03-02", "codes=600001.SH&date=2026-02-30", "codes=600001.SH&date=x", `codes=${Array(51).fill("600001.SH").join(",")}&date=2026-03-02`]) {
    it(`拒绝非法参数 ${params.slice(0, 65)}`, async () => {
      await expect(marketRoutes.research(ctx(params))).rejects.toMatchObject({ httpStatus: 400 });
      expect(mocks.research).not.toHaveBeenCalled();
    });
  }
  it("接受50个代码边界", async () => {
    await marketRoutes.research(ctx(`codes=${Array(50).fill("600001.SH").join(",")}&date=2026-03-02`));
    expect(mocks.research).toHaveBeenCalled();
  });
});
