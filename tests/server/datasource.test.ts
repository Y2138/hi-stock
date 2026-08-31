// datasource 模块测试：通道选择、降级留痕、限流间隔、退避重试、幂等落库、MA 计算、market_fetch_run 记录
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §五、§十二
// 所有外部 HTTP 均 mock（vi.stubGlobal fetch），不依赖真实网络；DB 用例使用 stock_test 库。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { runMigrations } from "../../server/db/migrate.js";
import { prepareTestDb, resetSchema } from "./helpers.js";
import { RateLimiter, withBackoff } from "../../server/datasource/ratelimit.js";
import { HithinkRequestScheduler } from "../../server/datasource/request-scheduler.js";
import {
  HithinkChannel,
  HithinkEnvelopeError,
  fetchKline,
  fetchSnapshot,
} from "../../server/datasource/hithink.js";
import { fetchAllTickers, fetchTickerPage, fetchTradingDays } from "../../server/datasource/hithink-meta.js";
import { fetchBoardCatalog, fetchBoardConstituents } from "../../server/datasource/hithink-boards.js";
import { fetchDragonTiger, fetchLimitPoolPage } from "../../server/datasource/hithink-special.js";
import {
  HITHINK_DATASET_CAPABILITIES,
  HITHINK_DATASET_SPECS,
  fetchHithinkDataset,
  fetchHithinkDatasetAndStore,
  normalizeHithinkDatasetRequest,
} from "../../server/datasource/hithink-datasets.js";
import { syncAllBoardMemberships, syncBoardMembership, upsertTickerIdentities } from "../../server/datasource/catalog-service.js";
import { syncLimitDataset, syncLimitLadder } from "../../server/datasource/special-service.js";
import { calculateIndicators } from "../../server/indicators/formulas.js";
import { recomputeIndicatorSeries } from "../../server/indicators/service.js";
import { buildOnDemandBars } from "../../server/modules/market/routes.js";
import { queryMarketStructure } from "../../server/modules/market/structure.js";
import indicatorFixture from "../fixtures/指标金样本.json";
import { fetchFundFlow } from "../../server/datasource/akshare.js";
import {
  dailyMarketUpdate,
  ensureInstrument,
  fetchAndStore,
  fetchFinancialAndStore,
  storeBars,
} from "../../server/datasource/service.js";
import type { Bar, Channel, FetchRequest } from "../../server/datasource/types.js";

const noopSleep = async () => {};
const noWait = { limiter: new RateLimiter(0, noopSleep), sleep: noopSleep, apiKey: "test-placeholder" };

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function textResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

/** 构造扶摇 kline 信封：dates 与 closes 等长 */
function klinePayload(dates: string[], closes: number[]): unknown {
  return {
    code: 0,
    message: "success",
    request_id: "test",
    data: {
      item: dates.map((d, i) => ({
        date_ms: Date.parse(`${d}T00:00:00+08:00`),
        open_price: closes[i],
        high_price: closes[i]! + 1,
        low_price: closes[i]! - 1,
        close_price: closes[i],
        volume: 1000 + i,
      })),
    },
  };
}

/** 构造新浪 30 分钟 jsonp 文本（与 2026-08-16 实测格式一致：注释前缀 + var=(...)） */
function sina30mText(times: string[]): string {
  const arr = times.map((t, i) => ({
    day: t,
    open: "10.00",
    high: "11.00",
    low: "9.00",
    close: (10 + i).toFixed(2),
    volume: "1000",
  }));
  return `/*<script>location.href='//sina.com';</script>*/\nvar=(${JSON.stringify(arr)});`;
}

/** 构造新浪期货日线 jsonp 文本 */
function sinaFuturesText(dates: string[]): string {
  const arr = dates.map((d, i) => ({
    d,
    o: "100.0",
    h: "110.0",
    l: "90.0",
    c: (100 + i).toFixed(1),
    v: "5000",
    p: "0",
    s: "0.0",
  }));
  return `/*<script>location.href='//sina.com';</script>*/\nvar=(${JSON.stringify(arr)});`;
}

function snapshotPayload(code: string, date: string, prevClose: number): unknown {
  return {
    code: 0,
    message: "success",
    request_id: "test",
    data: {
      timestamp: Date.parse(`${date}T15:05:00+08:00`),
      item: [
        {
          thscode: code,
          volume: 12345,
          last_price: prevClose + 1,
          open_price: prevClose,
          high_price: prevClose + 2,
          low_price: prevClose - 1,
          prev_price: prevClose,
        },
      ],
    },
  };
}

function makeBars(dates: string[]): Bar[] {
  return dates.map((d, i) => ({
    date: d,
    open: 10 + i,
    high: 11 + i,
    low: 9 + i,
    close: 10 + i,
    volume: 100,
  }));
}

// ---------- 纯单元用例（不需要数据库） ----------

describe("datasource 限流与重试", () => {
  it("临时第三方日线在响应内补齐均线和 MACD 且不依赖落库", () => {
    const bars = buildOnDemandBars(Array.from({ length: 60 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
      open: index + 1, high: index + 2, low: index, close: index + 1,
    })));
    expect(bars[4]).toMatchObject({ ma5: 3, ma10: null, channel: "hithink_on_demand" });
    expect(bars[59]).toMatchObject({ ma5: 58, ma60: 30.5 });
    expect(bars[59]!.macd_hist).toBeTypeOf("number");
  });

  it("正式日线指标一版与 pandas/ta 金样本在混合容差内一致", () => {
    const actual = calculateIndicators(indicatorFixture.input);
    for (const expected of indicatorFixture.expected) {
      const point = actual[expected.index]!;
      for (const key of ["ma5", "ma10", "ma20", "ma60", "dif", "dea"] as const) {
        const reference = expected[key];
        if (reference === null) expect(point[key]).toBeNull();
        else expect(Math.abs(point[key]! - reference)).toBeLessThanOrEqual(1e-10 + 1e-9 * Math.abs(reference));
      }
      const referenceHist = expected.macd_hist;
      if (referenceHist === null) expect(point.macdHist).toBeNull();
      else expect(Math.abs(point.macdHist! - referenceHist)).toBeLessThanOrEqual(1e-10 + 1e-9 * Math.abs(referenceHist));
    }
  });

  it("统一请求队列遵守优先级，连续五个高优先请求后放行低优先请求", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const scheduler = new HithinkRequestScheduler(0, noopSleep);
    const tasks: Promise<unknown>[] = [
      scheduler.schedule("interactive", async () => {
        await firstGate;
        order.push("first");
      }),
    ];
    for (let index = 1; index <= 5; index += 1) {
      tasks.push(scheduler.schedule("interactive", async () => void order.push(`high-${index}`)));
    }
    tasks.push(scheduler.schedule("scheduled-low", async () => void order.push("low")));
    releaseFirst();
    await Promise.all(tasks);
    expect(order).toEqual(["first", "high-1", "high-2", "high-3", "high-4", "low", "high-5"]);
    expect(scheduler.snapshot()).toMatchObject({ running: false, completed: 7, failed: 0 });
  });

  it("限流器相邻放行间隔 ≥3 秒（注入 sleep 记录等待时长）", async () => {
    const waits: number[] = [];
    const limiter = new RateLimiter(3000, async (ms) => {
      waits.push(ms);
    });
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    // 首次放行不等待；后两次都必须等满 ~3000ms（注入 sleep 不真实流逝时间）
    expect(waits.length).toBe(2);
    for (const w of waits) expect(w).toBeGreaterThanOrEqual(2990);
  });

  it("withBackoff 指数退避：2s、4s 后成功", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("boom");
        return "ok";
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(waits).toEqual([2000, 4000]);
  });

  it("扶摇信封 code=4001 退避重试最多 2 次", async () => {
    const rateLimited = () =>
      jsonResponse({ code: 4001, message: "频率超限", request_id: "t", data: null });
    const dates = ["2026-08-13", "2026-08-14"];

    // 先 4001 一次后成功：共 2 次调用
    let seq = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        seq += 1;
        return seq === 1 ? rateLimited() : jsonResponse(klinePayload(dates, [10, 11]));
      }),
    );
    const req: FetchRequest = {
      code: "000636.SZ",
      freq: "day",
      start: "2026-08-13",
      end: "2026-08-14",
    };
    const bars = await fetchKline(req, noWait);
    expect(bars.length).toBe(2);
    expect(seq).toBe(2);

    // 持续 4001：首次 + 2 次重试后抛出信封错误
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return rateLimited();
      }),
    );
    await expect(fetchKline(req, noWait)).rejects.toBeInstanceOf(HithinkEnvelopeError);
    expect(calls).toBe(3);
    vi.unstubAllGlobals();
  });

  it("指数和板块快照按 200 个代码分批并校验完整覆盖", async () => {
    const codes = Array.from({ length: 201 }, (_, index) => `${String(880000 + index).padStart(6, "0")}.TI`);
    const batchSizes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const batch = new URL(String(url)).searchParams.get("thscodes")!.split(",");
      batchSizes.push(batch.length);
      return jsonResponse({
        code: 0,
        data: {
          timestamp: Date.parse("2026-08-20T15:00:00+08:00"),
          item: batch.map((code) => ({
            thscode: code,
            open_price: 10,
            high_price: 11,
            low_price: 9,
            last_price: 10.5,
            prev_price: 10,
          })),
        },
      });
    }));
    expect(await fetchSnapshot(codes, noWait, "index")).toHaveLength(201);
    expect(batchSizes).toEqual([200, 1]);
    vi.unstubAllGlobals();
  });

  it("东财资金流解析（mock 实测响应格式）", async () => {
    const mock = vi.fn(async (url: unknown) => {
      const u = String(url);
      expect(u).toContain("push2delay.eastmoney.com");
      expect(u).toContain("secid=0.000636");
      expect(u).toContain("klt=101");
      return jsonResponse({
        rc: 0,
        data: {
          code: "000636",
          klines: ["2026-08-14,265564624.0,-48662960.0,-216901648.0,116529008.0,149035616.0"],
        },
      });
    });
    vi.stubGlobal("fetch", mock);
    const rows = await fetchFundFlow("000636.SZ", 101, { sleep: noopSleep });
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ date: "2026-08-14", main: 265564624, xlarge: 149035616 });
    vi.unstubAllGlobals();
  });

  it("扶摇目录过滤扩展指数后仍按原始页大小继续翻页", async () => {
    const timestamp = Date.parse("2026-08-18T15:40:00+08:00");
    const mock = vi.fn(async (url: unknown) => {
      const offset = Number(new URL(String(url)).searchParams.get("offset"));
      const item = offset === 0
        ? [
            { thscode: "159516.SZ", ticker: "159516", name: "半导体设备ETF国泰", asset_type: "fund-etf", exchange: "SZ" },
            { thscode: "H11077.SH", ticker: "H11077", name: "10年国债", asset_type: "a-share-index", exchange: "SH" },
          ]
        : offset === 2
          ? [
              { thscode: "159516.SZ", ticker: "159516", name: "半导体设备ETF国泰", asset_type: "fund-otc", exchange: "SZ" },
              { thscode: "399001.SZ", ticker: "399001", name: "深证成指", asset_type: "a-share-index", exchange: "SZ" },
            ]
          : [];
      return jsonResponse({ code: 0, message: "success", data: { timestamp, item } });
    });
    vi.stubGlobal("fetch", mock);
    expect(await fetchAllTickers({ assetTypes: ["a-share-index", "fund-etf", "fund-otc"], pageSize: 2 }, noWait)).toMatchObject([
      { code: "159516.SZ", assetType: "fund-etf" },
      { code: "399001.SZ" },
    ]);
    expect(mock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it("扶摇目录、板块、交易日、涨停分页和龙虎榜响应按官方字段解析", async () => {
    const timestamp = Date.parse("2026-08-18T15:40:00+08:00");
    const mock = vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      const envelope = (data: unknown) => jsonResponse({ code: 0, message: "success", data });
      if (parsed.pathname === "/api/meta/tickers/list") {
        expect(parsed.searchParams.get("asset_type")).toBe("a-share,fund-etf");
        return envelope({ timestamp, item: [
          { thscode: "600000.SH", ticker: "600000", name: "浦发银行", asset_type: "a-share", exchange: "SH", currency: "CNY" },
          { thscode: "510300.SH", ticker: "510300", name: "沪深300ETF", asset_type: "fund-etf", exchange: "SH", currency: "CNY" },
          { thscode: "000974.SH", ticker: "1B0974", name: "800金融", asset_type: "a-share-index", exchange: "SH", currency: "CNY" },
          { thscode: "H11077.SH", ticker: "H11077", name: "10年国债", asset_type: "a-share-index", exchange: "SH", currency: "CNY" },
        ] });
      }
      if (parsed.pathname === "/api/a-share/calendar/trading-days") {
        return envelope({ timestamp, item: [{ date: "20260818" }] });
      }
      if (parsed.pathname === "/api/a-share-index/catalog/ths-index-list") {
        expect(parsed.searchParams.get("tag")).toBe("cn_concept");
        return envelope({ timestamp, item: [{ thscode: "885001.TI", name: "测试概念" }] });
      }
      if (parsed.pathname === "/api/a-share-index/constituents/ths-stock-list") {
        expect(parsed.searchParams.get("thscode")).toBe("885001.TI");
        return envelope({ timestamp, item: [{ thscode: "600000.SH", ticker: "600000", name: "浦发银行" }] });
      }
      if (parsed.pathname === "/api/a-share/special-data/limit-up-pool") {
        expect(parsed.searchParams.get("page")).toBe("1");
        return envelope({ timestamp, pagination: { page: 1, pages: 1, total: 1 }, item: [{ thscode: "600000.SH" }] });
      }
      if (parsed.pathname === "/api/a-share/special-data/dragon-tiger-list") {
        expect(parsed.searchParams.get("board_type")).toBe("all");
        return envelope({ timestamp, board_type: "all", trade_date: "2026-08-18", stock_items: [], hot_money_items: [] });
      }
      throw new Error(`未预期的 URL: ${parsed}`);
    });
    vi.stubGlobal("fetch", mock);
    expect(await fetchTickerPage({ assetTypes: ["a-share", "fund-etf"] }, noWait)).toMatchObject([
      { code: "600000.SH", ticker: "600000" },
      { code: "510300.SH", ticker: "510300" },
      { code: "000974.SH", ticker: "000974" },
    ]);
    expect(await fetchTradingDays(noWait)).toEqual([{ date: "2026-08-18", sourceUpdatedAt: new Date(timestamp).toISOString() }]);
    expect(await fetchBoardCatalog("concept", noWait)).toMatchObject([{ code: "885001.TI", boardType: "concept" }]);
    expect(await fetchBoardConstituents("885001.TI", noWait)).toMatchObject([{ code: "600000.SH" }]);
    expect(await fetchLimitPoolPage("up", { tradeDate: "2026-08-18", page: 1 }, noWait)).toMatchObject({ page: 1, pages: 1, total: 1 });
    expect(await fetchDragonTiger("all", "2026-08-18", noWait)).toMatchObject({ boardType: "all", tradeDate: "2026-08-18" });
    vi.unstubAllGlobals();
  });

  it("扶摇扩展能力白名单覆盖竞价、热榜/异动和基金研究端点并严格转换参数", async () => {
    expect(HITHINK_DATASET_CAPABILITIES).toHaveLength(34);
    expect(new Set(Object.values(HITHINK_DATASET_SPECS).map((spec) => spec.path)).size).toBe(34);
    const timestamp = Date.parse("2026-08-20T09:25:00+08:00");
    const mock = vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/a-share/auction/snapshot") {
        expect(parsed.searchParams.get("thscodes")).toBe("600519.SH,000001.SZ");
        expect(parsed.searchParams.get("stage")).toBe("final");
        return jsonResponse({
          code: 0,
          message: "success",
          data: {
            timestamp,
            auction_phase: "final",
            data_status: "ready",
            item: [{ thscode: "600519.SH", auction_price: 1500 }],
          },
        });
      }
      if (parsed.pathname === "/api/fund/performance/indicators-historical") {
        expect(parsed.searchParams.get("fund_type")).toBe("exchange");
        expect(parsed.searchParams.get("thscode")).toBe("510300.SH");
        expect(parsed.searchParams.get("start")).toBe(String(Date.parse("2026-01-01T00:00:00+08:00")));
        expect(parsed.searchParams.get("end")).toBe(String(Date.parse("2026-08-20T23:59:59.999+08:00")));
        return jsonResponse({
          code: 0,
          message: "success",
          data: { timestamp, item: [{ date_ms: timestamp, rsi_pct: 52.1 }] },
        });
      }
      throw new Error(`未预期的 URL: ${parsed}`);
    });
    vi.stubGlobal("fetch", mock);
    const auction = await fetchHithinkDataset({
      capability: "auction_snapshot",
      codes: ["600519.sh", "000001.SZ", "600519.SH"],
      stage: "final",
    }, noWait);
    expect(auction).toMatchObject({
      capability: "auction_snapshot",
      asOfDate: "2026-08-20",
      dataStatus: "ready",
      rowCount: 1,
      request: { codes: ["600519.SH", "000001.SZ"] },
    });
    const fund = await fetchHithinkDataset({
      capability: "fund_performance_indicators",
      fund_type: "exchange",
      code: "510300.sh",
      start: "2026-01-01",
      end: "2026-08-20",
    }, noWait);
    expect(fund).toMatchObject({ capability: "fund_performance_indicators", rowCount: 1 });
    expect(() => normalizeHithinkDatasetRequest({
      capability: "fund_profile",
      fund_type: "exchange",
      code: "510300.SH",
      period: "day",
    })).toThrow("不接受参数 period");
    expect(() => normalizeHithinkDatasetRequest({
      capability: "hot_stock_rank_trend",
      code: "600519.SH",
      start: "2025-01-01",
      end: "2026-01-02",
    })).toThrow("不能超过 1 年");
    vi.unstubAllGlobals();
  });

  it("扶摇标的目录识别公募 REITs", async () => {
    const timestamp = Date.parse("2026-08-20T07:00:00+08:00");
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get("asset_type")).toBe("fund-reits");
      return jsonResponse({
        code: 0,
        message: "success",
        data: {
          timestamp,
          item: [{
            thscode: "180101.SZ",
            ticker: "180101",
            name: "测试公募REIT",
            asset_type: "fund-reits",
            exchange: "SZ",
          }],
        },
      });
    }));
    expect(await fetchTickerPage({ assetTypes: ["fund-reits"] }, noWait)).toMatchObject([
      { code: "180101.SZ", assetType: "fund-reits" },
    ]);
    vi.unstubAllGlobals();
  });
});

// ---------- 数据库用例（stock_test；无库时整体 skip） ----------

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("datasource 服务（stock_test）", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await pool.end();
  });

  it("扶摇扩展数据按规范化请求幂等缓存并记录 fetch run", async () => {
    let unitNav = 1.1;
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/api/fund/profile/detail");
      expect(parsed.searchParams.get("fund_type")).toBe("reits");
      expect(parsed.searchParams.get("thscode")).toBe("180101.SZ");
      return jsonResponse({
        code: 0,
        message: "success",
        data: {
          timestamp: Date.parse("2026-08-20T15:00:00+08:00"),
          item: [{ thscode: "180101.SZ", fund_name: "测试公募REIT", unit_nav: unitNav }],
        },
      });
    }));
    const request = { capability: "fund_profile", fund_type: "reits", code: "180101.SZ" } as const;
    const first = await fetchHithinkDatasetAndStore(pool, request, noWait);
    unitNav = 1.2;
    const second = await fetchHithinkDatasetAndStore(pool, request, noWait);
    expect(second.snapshotId).toBe(first.snapshotId);
    const stored = await pool.query<{ count: number; unit_nav: number }>(
      `SELECT count(*)::int AS count,
              max((payload->'item'->0->>'unit_nav')::numeric)::float8 AS unit_nav
         FROM hithink_dataset_snapshot WHERE capability = 'fund_profile'`,
    );
    expect(stored.rows[0]).toEqual({ count: 1, unit_nav: 1.2 });
    const runs = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM market_fetch_run
        WHERE scope->>'pipeline' = 'hithink_dataset' AND scope->>'capability' = 'fund_profile'`,
    );
    expect(runs.rows[0]!.count).toBe(2);
    vi.unstubAllGlobals();
  });

  it("通道选择：日线请求路由到 hithink（fuyao 域名）", async () => {
    const dates = ["2026-08-12", "2026-08-13", "2026-08-14"];
    const mock = vi.fn(async (url: unknown) => {
      const u = String(url);
      expect(u).toContain("fuyao.aicubes.cn/api/a-share/prices/historical");
      return jsonResponse(klinePayload(dates, [10, 11, 12]));
    });
    vi.stubGlobal("fetch", mock);
    const outcome = await fetchAndStore(
      pool,
      { code: "000636.SZ", freq: "day", start: "2026-08-12", end: "2026-08-14" },
      { channels: [new HithinkChannel(noWait)] },
    );
    expect(outcome.channel).toBe("hithink");
    expect(outcome.degradedFrom).toBeUndefined();
    expect(outcome.rowsWritten).toBe(3);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("幂等 upsert：同一窗口重复拉取不重复建行", async () => {
    const dates = ["2026-08-12", "2026-08-13", "2026-08-14"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(klinePayload(dates, [10, 11, 12]))),
    );
    const req: FetchRequest = {
      code: "000636.SZ",
      freq: "day",
      start: "2026-08-12",
      end: "2026-08-14",
    };
    await fetchAndStore(pool, req, { channels: [new HithinkChannel(noWait)] });
    await fetchAndStore(pool, req, { channels: [new HithinkChannel(noWait)] });
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM market_bar mb
       JOIN market_instrument i ON i.id = mb.instrument_id
       WHERE i.code = '000636.SZ' AND mb.freq = 'day'`,
    );
    expect(r.rows[0]!.n).toBe(3);
  });

  it("财务与估值直连扶摇并按共同报告期幂等落库", async () => {
    const reportPeriodMs = Date.parse("2025-12-31T00:00:00+08:00");
    const reportDateMs = Date.parse("2026-03-31T00:00:00+08:00");
    const valuationDateMs = Date.parse("2026-08-18T15:00:00+08:00");
    const mock = vi.fn(async (url: unknown) => {
      const value = String(url);
      const common = {
        thscode: "600519.SH",
        period: "quarterly",
        fiscal_year: 2025,
        fiscal_period: "Q4",
        report_date_ms: reportDateMs,
        period_end_ms: reportPeriodMs,
      };
      if (value.includes("/valuations/snapshot")) {
        return jsonResponse({
          code: 0,
          data: {
            timestamp: valuationDateMs,
            item: [{ thscode: "600519.SH", name: "贵州茅台", pe_ttm: 20, pb_mrq: 7, ps_ttm: 10, pcf_ttm: 18 }],
          },
        });
      }
      if (value.includes("/income-statements")) {
        return jsonResponse({ code: 0, data: { item: [{ ...common, operating_income: 1000, operating_costs: 400, net_profit: 200 }] } });
      }
      if (value.includes("/balance-sheets")) {
        return jsonResponse({ code: 0, data: { item: [{ ...common, assets_total: 2000, total_debt: 500, holder_equity_total: 1000 }] } });
      }
      if (value.includes("/cash-flow-statements")) {
        return jsonResponse({ code: 0, data: { item: [{ ...common, act_cash_flow_net: 180 }] } });
      }
      throw new Error(`未预期的扶摇 URL：${value}`);
    });
    vi.stubGlobal("fetch", mock);
    const first = await fetchFinancialAndStore(pool, { code: "600519.SH" }, { hithinkDeps: noWait });
    const second = await fetchFinancialAndStore(pool, { code: "600519.SH" }, { hithinkDeps: noWait });
    expect(first).toMatchObject({ status: "success", valuationRows: 1, fundamentalRows: 1, rowsWritten: 2 });
    expect(second).toMatchObject({ status: "success", rowsWritten: 2 });
    const valuation = await pool.query(
      `SELECT pe_ttm::float, pb::float, ps_ttm::float, as_of_date::text
         FROM valuation_snapshot v JOIN market_instrument i ON i.id = v.instrument_id
        WHERE i.code = '600519.SH'`,
    );
    expect(valuation.rows).toEqual([{ pe_ttm: 20, pb: 7, ps_ttm: 10, as_of_date: "2026-08-18" }]);
    const fundamental = await pool.query(
      `SELECT revenue::float, net_profit::float, operating_cashflow::float,
              roe::float, gross_margin::float, debt_ratio::float, report_period::text
         FROM fundamental_snapshot f JOIN market_instrument i ON i.id = f.instrument_id
        WHERE i.code = '600519.SH'`,
    );
    expect(fundamental.rows).toEqual([{
      revenue: 1000,
      net_profit: 200,
      operating_cashflow: 180,
      roe: 20,
      gross_margin: 60,
      debt_ratio: 25,
      report_period: "2025-12-31",
    }]);
    expect(mock).toHaveBeenCalledTimes(8);
  });

  it("MA5/10/20/60 补算：构造 61 根等差收盘价验证数值，窗口不足留空", async () => {
    // 61 个连续自然日（测试不关心是否真实交易日），收盘价 1..61
    const dates: string[] = [];
    const closes: number[] = [];
    for (let i = 60; i >= 0; i--) {
      const t = Date.parse("2026-08-14T00:00:00Z") - i * 86400_000;
      dates.push(new Date(t).toISOString().slice(0, 10));
      closes.push(61 - i);
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(klinePayload(dates, closes))),
    );
    await fetchAndStore(
      pool,
      { code: "000001.SH", freq: "day", start: dates[0]!, end: dates[60]! },
      { channels: [new HithinkChannel(noWait)] },
    );
    const last = await pool.query<Record<string, string | null>>(
      `SELECT ma5::float8 AS ma5, ma10::float8 AS ma10, ma20::float8 AS ma20, ma60::float8 AS ma60
       FROM market_bar mb JOIN market_instrument i ON i.id = mb.instrument_id
       WHERE i.code = '000001.SH' AND mb.freq = 'day' AND mb.bar_date = $1`,
      [dates[60]],
    );
    // 收盘 1..61：MA5=(57+58+59+60+61)/5=59，MA10=56.5，MA20=51.5，MA60=31.5
    expect(Number(last.rows[0]!.ma5)).toBeCloseTo(59, 9);
    expect(Number(last.rows[0]!.ma10)).toBeCloseTo(56.5, 9);
    expect(Number(last.rows[0]!.ma20)).toBeCloseTo(51.5, 9);
    expect(Number(last.rows[0]!.ma60)).toBeCloseTo(31.5, 9);
    const first = await pool.query<Record<string, string | null>>(
      `SELECT ma5, ma20 FROM market_bar mb JOIN market_instrument i ON i.id = mb.instrument_id
       WHERE i.code = '000001.SH' AND mb.freq = 'day' AND mb.bar_date = $1`,
      [dates[0]],
    );
    expect(first.rows[0]!.ma5).toBeNull();
    expect(first.rows[0]!.ma20).toBeNull();
  });

  it("降级留痕：高优先级通道失败后降级并写 market_fetch_run.degraded_from", async () => {
    const failing: Channel = {
      name: "fake-primary",
      supports: () => true,
      fetch: async () => {
        throw new Error("模拟主通道失败");
      },
    };
    const backup: Channel = {
      name: "fake-secondary",
      supports: () => true,
      fetch: async () => makeBars(["2026-08-14"]),
    };
    const outcome = await fetchAndStore(
      pool,
      { code: "600000.SH", freq: "day", start: "2026-08-14", end: "2026-08-14" },
      { channels: [failing, backup] },
    );
    expect(outcome.channel).toBe("fake-secondary");
    expect(outcome.degradedFrom).toBe("fake-primary");
    const run = await pool.query<{ degraded_from: string | null; rows_written: number }>(
      "SELECT degraded_from, rows_written FROM market_fetch_run WHERE id = $1",
      [outcome.fetchRunId],
    );
    expect(run.rows[0]!.degraded_from).toBe("fake-primary");
    expect(run.rows[0]!.rows_written).toBe(1);
  });

  it("全部通道失败：写 market_fetch_run（gaps 留痕、0 行）后抛错", async () => {
    const failing: Channel = {
      name: "fake-only",
      supports: () => true,
      fetch: async () => {
        throw new Error("模拟失败");
      },
    };
    await expect(
      fetchAndStore(
        pool,
        { code: "000063.SZ", freq: "day", start: "2026-08-14", end: "2026-08-14" },
        { channels: [failing] },
      ),
    ).rejects.toThrow("全部通道失败");
    const run = await pool.query<{ rows_written: number; gaps: unknown[]; scope: { instruments: string[] } }>(
      `SELECT rows_written, gaps, scope FROM market_fetch_run
       WHERE scope->'instruments' = '["000063.SZ"]'::jsonb ORDER BY id DESC LIMIT 1`,
    );
    expect(run.rows[0]!.rows_written).toBe(0);
    expect(run.rows[0]!.gaps.length).toBe(1);
  });

  it("market_fetch_run 记录：scope/rows_written/channel 与请求一致", async () => {
    const dates = ["2026-08-14"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(klinePayload(dates, [10]))),
    );
    const outcome = await fetchAndStore(
      pool,
      { code: "399001.SZ", freq: "day", start: "2026-08-14", end: "2026-08-14" },
      { channels: [new HithinkChannel(noWait)] },
    );
    const run = await pool.query<{
      channel: string;
      rows_written: number;
      scope: { instruments: string[]; freq: string; range: { start: string; end: string } };
      gaps: unknown[];
      finished_at: string | null;
    }>("SELECT channel, rows_written, scope, gaps, finished_at FROM market_fetch_run WHERE id = $1", [
      outcome.fetchRunId,
    ]);
    const row = run.rows[0]!;
    expect(row.channel).toBe("hithink");
    expect(row.rows_written).toBe(1);
    expect(row.scope.instruments).toEqual(["399001.SZ"]);
    expect(row.scope.freq).toBe("day");
    expect(row.scope.range).toEqual({ start: "2026-08-14", end: "2026-08-14" });
    expect(row.gaps).toEqual([]);
    expect(row.finished_at).not.toBeNull();
  });

  it("30m 与期货请求路由到 sina 通道，30m 落库存实际时刻", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes("quotes.sina.cn")) {
          expect(u).toContain("symbol=sz000636");
          expect(u).toContain("scale=30");
          return textResponse(sina30mText(["2026-08-14 14:30:00", "2026-08-14 15:00:00"]));
        }
        if (u.includes("stock2.finance.sina.com.cn")) {
          expect(u).toContain("symbol=CU0");
          return textResponse(sinaFuturesText(["2026-08-13", "2026-08-14"]));
        }
        throw new Error(`未预期的 URL: ${u}`);
      }),
    );
    const deps = { akshareDeps: { sleep: noopSleep } };
    const m30 = await fetchAndStore(
      pool,
      { code: "000636.SZ", freq: "30m", start: "2026-08-14", end: "2026-08-14" },
      deps,
    );
    expect(m30.channel).toBe("sina");
    expect(m30.rowsWritten).toBe(2);
    const t = await pool.query<{ bt: string }>(
      `SELECT to_char(bar_time AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS bt
       FROM market_bar mb JOIN market_instrument i ON i.id = mb.instrument_id
       WHERE i.code = '000636.SZ' AND mb.freq = '30m' ORDER BY bar_time DESC LIMIT 1`,
    );
    // 15:00 CST = 07:00 UTC
    expect(t.rows[0]!.bt).toBe("2026-08-14 07:00:00");

    const fut = await fetchAndStore(
      pool,
      { code: "CU0", freq: "futures_day", start: "2026-08-13", end: "2026-08-14" },
      deps,
    );
    expect(fut.channel).toBe("sina");
    expect(fut.rowsWritten).toBe(2);
    const ft = await pool.query<{ bt: string }>(
      `SELECT to_char(bar_time AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS bt
       FROM market_bar mb JOIN market_instrument i ON i.id = mb.instrument_id
       WHERE i.code = 'CU0' AND mb.freq = 'futures_day' AND mb.bar_date = '2026-08-14'`,
    );
    // futures_day 的 bar_time 存当日 00:00:00Z（T6）
    expect(ft.rows[0]!.bt).toBe("2026-08-14 00:00:00");
  });

  it("dailyMarketUpdate 链路：快照追加（无历史→kline 重拉）→ MA → 期货 → 30 分钟", async () => {
    const klineDates = [
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes("/api/a-share/prices/snapshot")) {
          return jsonResponse(snapshotPayload("002594.SZ", "2026-08-14", 13));
        }
        if (u.includes("/api/a-share/prices/historical")) {
          return jsonResponse(klinePayload(klineDates, [10, 11, 12, 13, 14]));
        }
        if (u.includes("quotes.sina.cn")) {
          return textResponse(sina30mText(["2026-08-14 15:00:00"]));
        }
        if (u.includes("stock2.finance.sina.com.cn")) {
          return textResponse(sinaFuturesText(["2026-08-14"]));
        }
        throw new Error(`未预期的 URL: ${u}`);
      }),
    );
    const summary = await dailyMarketUpdate(
      pool,
      {
        codes: ["002594.SZ"],
        futures: ["CU1"],
        minute30: ["002594.SZ"],
        date: "2026-08-14",
      },
      { hithinkDeps: noWait, akshareDeps: { sleep: noopSleep } },
    );
    expect(summary.gaps).toEqual([]);
    expect(summary.refetched).toEqual(["002594.SZ"]); // 无既有日线触发初始化重拉
    expect(summary.snapshotRows).toBe(5);
    expect(summary.futuresRows).toBe(1);
    expect(summary.minute30Rows).toBe(1);
    expect(summary.fetchRunIds.length).toBeGreaterThanOrEqual(4); // 快照/重拉/期货/30m 各留痕
    const day = await pool.query<{ n: number; ma5: string | null }>(
      `SELECT count(*)::int AS n,
              (SELECT ma5::float8 FROM market_bar mb2 JOIN market_instrument i2 ON i2.id = mb2.instrument_id
               WHERE i2.code = '002594.SZ' AND mb2.freq = 'day' AND mb2.bar_date = '2026-08-14') AS ma5
       FROM market_bar mb JOIN market_instrument i ON i.id = mb.instrument_id
       WHERE i.code = '002594.SZ' AND mb.freq = 'day'`,
    );
    expect(day.rows[0]!.n).toBe(5);
    // 收盘 10..14 → MA5 = 12
    expect(Number(day.rows[0]!.ma5)).toBeCloseTo(12, 9);
  });

  it("dailyMarketUpdate 历史目标日跳过快照并只补目标日缺口", async () => {
    const targetDate = "2026-08-20";
    const fetchMock = vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/snapshot")) throw new Error("历史模式不应请求快照");
      if (parsed.pathname === "/api/a-share/prices/historical") {
        return jsonResponse(klinePayload([targetDate], [10]));
      }
      throw new Error(`未预期的 URL: ${parsed}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await dailyMarketUpdate(
      pool,
      { codes: ["000636.SZ"], date: targetDate, dayMode: "historical" },
      { hithinkDeps: noWait },
    );

    expect(summary.gaps).toEqual([]);
    expect(summary.refetched).toEqual(["000636.SZ"]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/snapshot"))).toBe(false);
    expect(Number((await pool.query(
      `SELECT count(*) FROM market_bar b JOIN market_instrument i ON i.id = b.instrument_id
        WHERE i.code = '000636.SZ' AND b.freq = 'day' AND b.bar_date = $1 AND b.close > 0`,
      [targetDate],
    )).rows[0]!.count)).toBe(1);
  });

  it("dailyMarketUpdate 快照日期错配时记缺口并跳过，不放大为历史请求", async () => {
    const targetDate = "2026-08-20";
    const observedDate = "2026-08-21";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === "/api/a-share/prices/snapshot") {
          return jsonResponse(snapshotPayload("000333.SZ", observedDate, 11));
        }
        throw new Error(`未预期的 URL: ${parsed}`);
      }),
    );

    const summary = await dailyMarketUpdate(
      pool,
      { codes: ["000333.SZ"], date: targetDate },
      { hithinkDeps: noWait },
    );

    expect(summary.gaps).toEqual([
      { code: "000333.SZ", freq: "day", reason: `快照交易日 ${observedDate} 与目标日 ${targetDate} 不一致` },
    ]);
    expect(summary.refetched).toEqual([]);
    const stored = await pool.query<{ bar_date: string }>(
      `SELECT bar_date::text FROM market_bar b JOIN market_instrument i ON i.id = b.instrument_id
        WHERE i.code = '000333.SZ' AND b.freq = 'day' ORDER BY bar_date`,
    );
    expect(stored.rows).toEqual([]);
  });

  it("dailyMarketUpdate 将板块与指数同组持久化，坏标的单独跳过", async () => {
    const targetDate = "2026-08-18";
    const previousDate = "2026-08-17";
    const assets = [
      { code: "600000.SH", name: "测试股票", kind: "stock" },
      { code: "000300.SH", name: "测试指数", kind: "index" },
      { code: "889999.TI", name: "测试板块", kind: "board" },
      { code: "159516.SZ", name: "测试ETF", kind: "etf" },
    ] as const;
    for (const asset of assets) {
      const instrument = await pool.query<{ id: string }>(
        `INSERT INTO market_instrument (code, name, kind) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind
         RETURNING id::text`,
        [asset.code, asset.name, asset.kind],
      );
      await pool.query(
        `INSERT INTO market_bar
           (instrument_id, freq, bar_date, bar_time, open, high, low, close, volume, channel)
         VALUES ($1, 'day', $2, $3, 10, 11, 9, 10, 1000, 'test')
         ON CONFLICT (instrument_id, freq, bar_date, bar_time) DO UPDATE SET close = 10`,
        [instrument.rows[0]!.id, previousDate, `${previousDate}T00:00:00Z`],
      );
    }

    const fetchMock = vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/a-share/prices/snapshot") {
        expect(parsed.searchParams.get("thscodes")).toBe("600000.SH");
        return jsonResponse(snapshotPayload("600000.SH", targetDate, 10));
      }
      if (parsed.pathname === "/api/a-share-index/prices/snapshot") {
        expect(parsed.searchParams.get("thscodes")).toBe("000300.SH,889999.TI");
        return jsonResponse({
          code: 0,
          message: "success",
          data: {
            timestamp: Date.parse(`${targetDate}T15:05:00+08:00`),
            item: [
              { thscode: "000300.SH", open_price: 10, high_price: 12, low_price: 9, last_price: 11, prev_price: 10 },
              { thscode: "889999.TI", open_price: 0, high_price: 0, low_price: 0, last_price: 0, prev_price: 10 },
            ],
          },
        });
      }
      if (parsed.pathname === "/api/fund/market/snapshot") {
        expect(parsed.searchParams.get("thscode")).toBe("159516.SZ");
        return jsonResponse(snapshotPayload("159516.SZ", targetDate, 10));
      }
      throw new Error(`未预期的 URL: ${parsed}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await dailyMarketUpdate(
      pool,
      { codes: assets.map((asset) => asset.code), date: targetDate },
      { hithinkDeps: noWait },
    );
    expect(summary.gaps).toEqual([
      { code: "889999.TI", freq: "day", reason: "快照存在非正或非有限 OHLC" },
    ]);
    expect(summary.refetched).toEqual([]);
    expect(summary.snapshotRows).toBe(3);
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname).filter((path) => path.endsWith("/snapshot")))
      .toEqual([
        "/api/a-share/prices/snapshot",
        "/api/a-share-index/prices/snapshot",
        "/api/fund/market/snapshot",
      ]);
    const stored = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM market_bar b JOIN market_instrument i ON i.id = b.instrument_id
        WHERE i.code = ANY($1::text[]) AND b.freq = 'day' AND b.bar_date = $2`,
      [assets.map((asset) => asset.code), targetDate],
    );
    expect(stored.rows[0]!.count).toBe(3);
    const degraded = await pool.query<{ gaps: unknown[] }>(
      `SELECT gaps FROM market_fetch_run
        WHERE scope->>'op' = 'snapshot' AND scope->>'kind' = 'index'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(degraded.rows[0]!.gaps).toHaveLength(1);
  });

  it("dailyMarketUpdate ETF 组内单只基金不支持行情只记该标的缺口，不拖垮同组", async () => {
    const targetDate = "2026-08-14";
    for (const [code, name] of [["159516.SZ", "好ETF"], ["560450.SH", "坏基金"]] as const) {
      const instrument = await pool.query<{ id: string }>(
        `INSERT INTO market_instrument (code, name, kind) VALUES ($1, $2, 'etf')
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id::text`,
        [code, name],
      );
      await pool.query(
        `INSERT INTO market_bar
           (instrument_id, freq, bar_date, bar_time, open, high, low, close, volume, channel)
         VALUES ($1, 'day', '2026-08-13', '2026-08-13T00:00:00Z', 10, 11, 9, 10, 1000, 'test')`,
        [instrument.rows[0]!.id],
      );
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === "/api/fund/market/snapshot") {
          const code = parsed.searchParams.get("thscode");
          if (code === "560450.SH") {
            return jsonResponse({ code: 3004, message: "This fund does not support market data" });
          }
          return jsonResponse(snapshotPayload(code!, targetDate, 10));
        }
        throw new Error(`未预期的 URL: ${parsed}`);
      }),
    );

    const summary = await dailyMarketUpdate(
      pool,
      { codes: ["159516.SZ", "560450.SH"], date: targetDate },
      { hithinkDeps: noWait },
    );
    expect(summary.gaps).toEqual([
      { code: "560450.SH", freq: "day", reason: expect.stringContaining("ETF 快照不可用") },
    ]);
    expect(summary.snapshotRows).toBe(1);
    const stored = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM market_bar b JOIN market_instrument i ON i.id = b.instrument_id
        WHERE i.code = ANY($1::text[]) AND b.freq = 'day' AND b.bar_date = $2`,
      [["159516.SZ", "560450.SH"], targetDate],
    );
    expect(stored.rows[0]!.n).toBe(1);
  });

  it("单板块成分请求失败时保留上一版有效关系", async () => {
    await upsertTickerIdentities(pool, [
      {
        code: "881001.TI",
        ticker: "881001",
        name: "测试行业",
        exchange: null,
        assetType: "a-share-index",
        currency: "CNY",
        sourceUpdatedAt: "2026-08-17T07:00:00.000Z",
      },
      {
        code: "600000.SH",
        ticker: "600000",
        name: "浦发银行",
        exchange: "SH",
        assetType: "a-share",
        currency: "CNY",
        sourceUpdatedAt: "2026-08-17T07:00:00.000Z",
      },
    ], new Set(["881001.TI"]));
    await pool.query(
      `INSERT INTO market_board (instrument_id, board_type, active)
       SELECT id, 'industry', true FROM market_instrument WHERE code = '881001.TI'
       ON CONFLICT (instrument_id) DO UPDATE SET active = true`,
    );
    await pool.query(
      `INSERT INTO market_board_membership (board_instrument_id, member_instrument_id, effective_from)
       SELECT board.id, member.id, '2026-08-17'
         FROM market_instrument board, market_instrument member
        WHERE board.code = '881001.TI' AND member.code = '600000.SH'`,
    );
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: 2003, message: "无板块成分权限", data: null })));
    await expect(syncBoardMembership(pool, "881001.TI", "2026-08-18", noWait)).rejects.toThrow("code=2003");
    const all = await syncAllBoardMemberships(pool, "2026-08-18", noWait);
    expect(all.completed).toHaveLength(0);
    expect(all.gaps).toMatchObject([{ code: "881001.TI" }]);
    const current = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM market_board_membership WHERE effective_to IS NULL",
    );
    expect(current.rows[0]!.n).toBe(1);
  });

  it("涨停分页中途失败保留成功页并记 partial，补跑保持幂等", async () => {
    const targetDate = "2026-08-18";
    const timestamp = Date.parse(`${targetDate}T15:40:00+08:00`);
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      const page = Number(parsed.searchParams.get("page"));
      if (page === 1) {
        return jsonResponse({
          code: 0,
          message: "success",
          data: {
            timestamp,
            pagination: { page: 1, pages: 2, total: 2 },
            item: [{
              thscode: "600000.SH",
              ticker: "600000",
              name: "浦发银行",
              last_price: 12.34,
              continue_day_cnt: 1,
              open_times: 0,
              limit_up_time: "09:31",
              industry_name: "银行",
              limit_up_reason: "测试",
            }],
          },
        });
      }
      return jsonResponse({ code: 5000, message: "测试分页失败", data: null });
    }));
    const first = await syncLimitDataset(pool, "up", targetDate, noWait);
    const second = await syncLimitDataset(pool, "up", targetDate, noWait);
    expect(first).toMatchObject({ status: "partial", rows: 1, completedPages: 1, totalPages: 2 });
    expect(second).toMatchObject({ status: "partial", rows: 1, completedPages: 1, totalPages: 2 });
    const events = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM market_limit_event WHERE trade_date = $1 AND event_type = 'up'",
      [targetDate],
    );
    expect(events.rows[0]!.n).toBe(1);
    const runs = await pool.query<{ n: number; partial: number }>(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE status = 'partial')::int AS partial
         FROM market_special_sync_run WHERE dataset = 'limit_up' AND target_date = $1`,
      [targetDate],
    );
    expect(runs.rows[0]).toEqual({ n: 2, partial: 2 });
  });

  it("连板天梯兼容两种供应商日期格式且仍严格校验目标日", async () => {
    const timestamp = Date.parse("2026-08-20T15:40:00+08:00");
    let dateList = ["2026-08-20", "2026-08-19"];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      code: 0,
      message: "success",
      data: {
        timestamp,
        window: { length: 2, date_list: dateList, board_caps: {} },
        item: [{
          date: dateList[0],
          boards: {
            two_board: [{ name: "测试二板", thscode: "000001.SZ", board_num: 2 }],
            three_board: [{ name: "测试三板", thscode: "600001.SH", board_num: 3 }],
          },
        }],
      },
    })));

    expect(await syncLimitLadder(pool, "2026-08-20", noWait)).toMatchObject({ status: "success", rows: 1 });
    dateList = ["20260820", "20260819"];
    expect(await syncLimitLadder(pool, "2026-08-20", noWait)).toMatchObject({ status: "success", rows: 1 });

    const snapshots = await pool.query<{ coverage_start: string; coverage_end: string }>(
      `SELECT coverage_start::text, coverage_end::text
         FROM market_limit_ladder_snapshot WHERE target_date = '2026-08-20'`,
    );
    expect(snapshots.rows).toHaveLength(2);
    expect(snapshots.rows).toEqual(expect.arrayContaining([
      { coverage_start: "2026-08-19", coverage_end: "2026-08-20" },
    ]));
    expect(await queryMarketStructure(pool, {
      date: "2026-08-20", dataset: "limit_ladder", page: 1, size: 200,
    })).toMatchObject({
      coverage: { row_count: 2 },
      items: [
        { name: "测试二板", thscode: "000001.SZ", tier: "2板" },
        { name: "测试三板", thscode: "600001.SH", tier: "3板" },
      ],
      counts: { limit_ladder: 2 },
    });

    const mismatch = await syncLimitLadder(pool, "2026-08-21", noWait);
    expect(mismatch).toMatchObject({
      status: "failed",
      gaps: [{ reason: "连板天梯截止日 2026-08-20 与目标日 2026-08-21 不一致" }],
    });
  });

  it("行情 upsert 与指标 dirty 原子提交，generation 递增后全历史重算", async () => {
    const instrumentId = await ensureInstrument(pool, "601999.SH", "指标测试股票", "day");
    const bars = indicatorFixture.input.map((close, index) => {
      const date = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
      return { date, open: close, high: close + 1, low: close - 1, close, volume: 1000, adjustment: "forward" as const };
    });
    await storeBars(pool, instrumentId, "day", bars, "test");
    const firstDirty = await pool.query<{ generation: string; earliest_date: string }>(
      "SELECT generation::text, earliest_date::text FROM market_indicator_dirty WHERE instrument_id = $1 AND freq = 'day'",
      [instrumentId],
    );
    expect(firstDirty.rows[0]).toEqual({ generation: "1", earliest_date: bars[0]!.date });
    await storeBars(pool, instrumentId, "day", [{ ...bars[10]!, close: bars[10]!.close + 0.01 }], "revision");
    const dirty = await pool.query<{ instrument_id: string; freq: "day"; generation: string }>(
      "SELECT instrument_id::text, freq, generation::text FROM market_indicator_dirty WHERE instrument_id = $1 AND freq = 'day'",
      [instrumentId],
    );
    expect(dirty.rows[0]!.generation).toBe("2");
    const run = await recomputeIndicatorSeries(pool, dirty.rows[0]!);
    expect(run).toMatchObject({ status: "success", rowCount: indicatorFixture.input.length });
    expect(Number((await pool.query(
      "SELECT count(*) FROM market_indicator_value WHERE instrument_id = $1 AND freq = 'day'",
      [instrumentId],
    )).rows[0]!.count)).toBe(indicatorFixture.input.length);
    expect(Number((await pool.query(
      "SELECT count(*) FROM market_indicator_dirty WHERE instrument_id = $1 AND freq = 'day'",
      [instrumentId],
    )).rows[0]!.count)).toBe(0);
  });

});
