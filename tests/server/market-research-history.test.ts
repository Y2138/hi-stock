import { afterAll, describe, expect, it } from "vitest";
import { prepareTestDb } from "./helpers.js";
import { queryStockResearch } from "../../server/modules/market/research.js";
const prepared = await prepareTestDb();
describe.skipIf(!prepared)("研究历史的日期与数值口径（独立库）", () => {
  afterAll(async () => { await prepared?.pool.end(); });
  it("披露日/报告期双重过滤、报告期去重、负基数累计同比和缺失", async () => {
    const db = prepared!.pool;
    const id = (await db.query("INSERT INTO market_instrument(code,name,kind) VALUES('990001.SH','合成财务测试','stock') RETURNING id")).rows[0].id;
    const put = async (period: string, disclosed: string, revenue: number | null, profit: number | null, cash: number | null, proof = true) => {
      await db.query(`INSERT INTO fundamental_snapshot(instrument_id,report_period,as_of_date,revenue,net_profit,operating_cashflow,source,raw_summary)
        VALUES($1,$2,$3,$4,$5,$6,'test',$7)`, [id, period, disclosed, revenue, profit, cash, JSON.stringify(proof ? { disclosure_date_basis: "reported", report_date_ms: Date.parse(`${disclosed}T00:00:00+08:00`) } : {})]);
    };
    await put('2024-09-30', '2024-10-28', 100, -20, 0);
    await put('2025-09-30', '2025-10-28', 120, -10, 3);
    await put('2025-09-30', '2025-11-03', 150, -5, 4);
    await put('2025-09-30', '2026-04-28', 999, 999, 999); // 未来披露的重述不可见
    await put('2026-03-31', '2026-02-28', 999, 999, 999); // 报告期在目标日之后
    await put('2025-06-30', '2025-06-30', 888, 888, 888, false); // 无披露日凭据
    const result = await queryStockResearch(db, ['990001.SH'], '2026-03-02');
    const item = result.items[0]!;
    expect(result.data_source).toBe('stored');
    expect(item.fundamental_periods).toHaveLength(2);
    expect(item.fundamental_periods![0]).toMatchObject({ report_period: '2025-09-30', as_of_date: '2025-11-03', revenue: 150, revenue_yoy_pct: 50, net_profit_yoy_pct: 75, operating_cashflow_yoy_pct: null });
    expect(item.fundamental_periods![1]!.revenue_yoy_pct).toBeNull();
    expect(item.fundamental_periods![0]!.as_of_date_basis).toContain('不是首次披露日');
    expect(result.instruction).toContain('不是首次披露日');
    expect(item.valuation_history!.observations).toEqual([]);
    expect(item.valuation_history!.pe_ttm.percentile).toBeNull();
    expect((await queryStockResearch(db, ['990001.SH'], '2025-10-27')).items[0]!.fundamental_periods).toHaveLength(1);
    expect((await queryStockResearch(db, ['990999.SH'], '2026-03-02')).items[0]!.status).toBe('missing');
  });
  it("估值只用已有历史，逐指标60个有效正值才出分位，负值不丢弃", async () => {
    const db = prepared!.pool;
    const id = (await db.query("INSERT INTO market_instrument(code,name,kind) VALUES('990002.SH','合成估值测试','stock') RETURNING id")).rows[0].id;
    await db.query(`INSERT INTO valuation_snapshot(instrument_id,as_of_date,pe_ttm,pb,source)
      SELECT $1, '2025-01-01'::date+n, n+1, CASE WHEN n=0 THEN NULL ELSE n+1 END,'test' FROM generate_series(0,59) n`, [id]);
    const before = (await queryStockResearch(db, ['990002.SH'], '2025-02-28')).items[0]!.valuation_history!;
    expect(before.observations).toHaveLength(59);
    expect(before.pe_ttm.percentile).toBeNull();
    const after = (await queryStockResearch(db, ['990002.SH'], '2025-03-01')).items[0]!.valuation_history!;
    expect(after.pe_ttm).toMatchObject({ sample_count: 60, value: 60, percentile: 100 });
    expect(after.pb).toMatchObject({ sample_count: 59, percentile: null });
    await db.query("INSERT INTO valuation_snapshot(instrument_id,as_of_date,pe_ttm,pb,source) VALUES($1,'2025-03-02',-3,0,'test')", [id]);
    const negative = (await queryStockResearch(db, ['990002.SH'], '2025-03-02')).items[0]!;
    expect(negative.valuation_history!.pe_ttm).toMatchObject({ sample_count: 60, value: -3, percentile: null });
    expect(negative.valuation_history!.observations.at(-1)).toMatchObject({ pe_ttm: -3, pb: 0 });
    expect(negative.valuation).toMatchObject({ pe_ttm: -3 }); // 原字段保留
  });
});
