// 宏观因子只读路由：验证 /api/macro/factors 的点时口径与参数校验。
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../server/db/migrate.js";
import { storeMarketFactorObservation, upsertMarketFactorSeries } from "../../server/datasource/commodity-service.js";
import { api, prepareTestDb, resetSchema, startTestServer, type TestServer } from "./helpers.js";

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("宏观因子路由（stock_test）", () => {
  let pool: pg.Pool;
  let server: TestServer;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
    await upsertMarketFactorSeries(pool, {
      seriesCode: "oecd.chn.cli", market: "CN", metricCode: "leading_indicator",
      frequency: "monthly", unit: "index", source: "oecd_sdmx", revisionPolicy: "revisable",
    });
    const base = {
      seriesCode: "oecd.chn.cli", periodStart: "2026-08-01", periodEnd: "2026-08-31",
      sourceRef: "test://oecd", rawSummary: { synthetic_initial_published_at: false },
    };
    await storeMarketFactorObservation(pool, { ...base, publishedAt: "2026-10-15T01:00:00Z", revisionNo: 0, value: 97.636 });
    await storeMarketFactorObservation(pool, { ...base, publishedAt: "2026-11-09T01:00:00Z", revisionNo: 1, value: 97.663 });
    server = await startTestServer(pool);
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  it("同一期按 as_of 返回当时可见的修订版本", async () => {
    const first = await api(server.baseUrl, "GET", "/api/macro/factors?series=oecd.chn.cli&as_of=2026-10-20");
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      as_of: "2026-10-20",
      series: [{
        series_code: "oecd.chn.cli",
        observations: [{ period_end: "2026-08-31", value: 97.636, revision_no: 0 }],
      }],
    });

    const revised = await api(server.baseUrl, "GET", "/api/macro/factors?series=oecd.chn.cli&as_of=2026-11-10");
    expect(revised.status).toBe(200);
    expect(revised.json).toMatchObject({
      series: [{ observations: [{ period_end: "2026-08-31", value: 97.663, revision_no: 1 }] }],
    });

    const beforePublish = await api(server.baseUrl, "GET", "/api/macro/factors?series=oecd.chn.cli&as_of=2026-10-14");
    expect(beforePublish.status).toBe(200);
    expect(beforePublish.json).toMatchObject({ series: [{ observations: [] }] });
  });

  it("非法日期与倒置区间返回 400", async () => {
    expect((await api(server.baseUrl, "GET", "/api/macro/factors?as_of=2026-13-01")).status).toBe(400);
    expect((await api(
      server.baseUrl, "GET", "/api/macro/factors?start_date=2026-09-01&end_date=2026-08-01",
    )).status).toBe(400);
  });
});
