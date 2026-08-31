// 行情、短线/长线池与成交级归因 API 契约；旧自选、页面成交和持久化画线必须退役。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { runMigrations } from "../../server/db/migrate.js";
import { createPool } from "../../server/db/client.js";
import { applyPoolChange, setPoolBoardOrder } from "../../server/modules/pools/repo.js";
import { recordPositionChange } from "../../server/modules/positions/repo.js";
import { marketRoutes } from "../../server/modules/market/routes.js";
import { api, prepareTestDb, resetSchema, seedTestStrategy, startTestServer, type TestServer } from "./helpers.js";

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("行情、策略池与成交归因（stock_test 真实库）", () => {
  let pool: pg.Pool;
  let server: TestServer | undefined;
  let sessionId: string;

  beforeAll(async () => {
    pool = createPool(prepared!.url);
    await resetSchema(pool);
    await runMigrations(pool);
    await seedTestStrategy(pool);
    await pool.query("UPDATE system_setting SET hithink_api_key = 'test-placeholder' WHERE singleton = true");
    await pool.query(
      `INSERT INTO market_instrument (code, name, kind) VALUES
         ('600487.SH', '亨通光电', 'stock'),
         ('000021.SZ', '深科技', 'stock'),
         ('510500.SH', '中证500ETF南方', 'etf'),
         ('885999.TI', '测试行情板块', 'board'),
         ('000001.SH', '上证指数', 'index')`,
    );
    const id = (await pool.query<{ id: string }>("SELECT id::text FROM market_instrument WHERE code = '600487.SH'")).rows[0]!.id;
    for (const [date, close] of [["2026-08-12", 55], ["2026-08-13", 57.2], ["2026-08-14", 62.98]] as const) {
      await pool.query(
        `INSERT INTO market_bar (instrument_id, freq, bar_date, bar_time, open, high, low, close, volume, ma5, channel)
         VALUES ($1, 'day', $2, $3, $4, $5, $6, $7, 1000000, 58, 'migrate')`,
        [id, date, `${date}T00:00:00Z`, close - 1, close + 1, close - 2, close],
      );
    }
    await pool.query(
      `INSERT INTO market_bar (instrument_id, freq, bar_date, bar_time, open, high, low, close, channel)
       SELECT id, 'day', '2026-08-14', '2026-08-14T00:00:00Z', 10, 11, 9, 10, 'test'
         FROM market_instrument WHERE code IN ('510500.SH', '885999.TI', '000001.SH')`,
    );
    sessionId = (await pool.query<{ id: string }>("INSERT INTO chat_session (title) VALUES ('成交归因测试') RETURNING id::text")).rows[0]!.id;
    server = await startTestServer(pool);
  });

  afterAll(async () => {
    await server?.close();
    await pool?.end();
  });

  it("标的检索、历史行情和覆盖统计仍可从下钻入口查询", async () => {
    const search = await api(server!.baseUrl, "GET", "/api/instruments?q=光电");
    expect(search).toMatchObject({ status: 200, json: [{ code: "600487.SH" }] });
    const bars = await api(server!.baseUrl, "GET", "/api/market/bars?code=600487.SH&freq=day&start=2026-08-13&end=2026-08-14");
    expect(bars.status).toBe(200);
    expect((bars.json as unknown as { bars: Array<{ close: number }> }).bars.map((bar) => bar.close)).toEqual([57.2, 62.98]);
    const coverage = await api(server!.baseUrl, "GET", "/api/market/coverage");
    expect(coverage.json).toMatchObject([{
      freq: "day",
      instrument_count: 4,
      stock_count: 1,
      board_count: 1,
      etf_count: 1,
      index_count: 1,
      row_count: 6,
    }]);
  });

  it("无本地日线时临时读取第三方行情且不写入数据库", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        code: 0,
        message: "success",
        data: { item: [
          { date_ms: Date.parse("2026-08-13T00:00:00+08:00"), open_price: 10, high_price: 11, low_price: 9, close_price: 10.5, volume: 1000 },
          { date_ms: Date.parse("2026-08-14T00:00:00+08:00"), open_price: 10.5, high_price: 12, low_price: 10, close_price: 11.5, volume: 1200 },
        ] },
      }),
    })));
    try {
      const result = await marketRoutes.bars({
        pool,
        params: {},
        body: {},
        query: new URLSearchParams("code=000021.SZ&freq=day&start=2026-08-13&end=2026-08-14&include=ma,macd"),
      });
      expect(result.data).toMatchObject({ data_source: "remote_on_demand", bars: [{ close: 10.5 }, { close: 11.5 }] });
      const stored = await pool.query<{ count: string }>(
        `SELECT count(*) FROM market_bar bar JOIN market_instrument instrument ON instrument.id = bar.instrument_id
          WHERE instrument.code = '000021.SZ'`,
      );
      expect(Number(stored.rows[0]!.count)).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("板块查看时将第三方日线持久化，而不是作为普通池外标的临时返回", async () => {
    await pool.query(
      `INSERT INTO market_instrument (code,name,kind,lifecycle_status)
       VALUES ('889998.TI','测试持久化板块','board','active')`,
    );
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/api/a-share/prices/historical") {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 1002, message: "not stock" }) };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          code: 0,
          data: { item: [
            { date_ms: Date.parse("2026-08-13T00:00:00+08:00"), open_price: 10, high_price: 11, low_price: 9, close_price: 10.5, volume: 1000 },
            { date_ms: Date.parse("2026-08-14T00:00:00+08:00"), open_price: 10.5, high_price: 12, low_price: 10, close_price: 11.5, volume: 1200 },
          ] },
        }),
      };
    }));
    try {
      const result = await marketRoutes.bars({
        pool,
        params: {},
        body: {},
        query: new URLSearchParams("code=889998.TI&freq=day&start=2026-08-13&end=2026-08-14&include=ma,macd"),
      });
      expect(result.data).toMatchObject({ data_source: "stored", bars: [{ close: 10.5 }, { close: 11.5 }] });
      const stored = await pool.query<{ count: string; adjustments: string[] }>(
        `SELECT count(*)::text AS count, array_agg(DISTINCT bar.adjustment) AS adjustments
           FROM market_bar bar JOIN market_instrument instrument ON instrument.id = bar.instrument_id
          WHERE instrument.code = '889998.TI'`,
      );
      expect(stored.rows[0]).toEqual({ count: "2", adjustments: ["none"] });
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);

  it("自选、页面成交和服务端画线接口全部退役", async () => {
    expect((await api(server!.baseUrl, "GET", "/api/watchlist")).status).toBe(404);
    expect((await api(server!.baseUrl, "POST", "/api/positions/record", {})).status).toBe(404);
    expect((await api(server!.baseUrl, "POST", "/api/chart-annotations", {})).status).toBe(404);
  });

  it("持仓事件固化归因和每笔卖出收益，累计已实现盈亏不联动退役资金状态", async () => {
    await pool.query(
      `INSERT INTO portfolio_account_state (id, cash, closed_pnl, anchor_date)
       VALUES (true, 0, 123, '2026-08-13')`,
    );
    await recordPositionChange(pool, {
      code: "600487.SH", kind: "buy", quantity: 600, price: 60, change_date: "2026-08-14",
      source: "chat", source_session_id: sessionId, decision_origin: "strategy_signal",
      execution_compliance: "matched", attribution_note: "按当日已确认信号记录",
    });
    const partialSell = await recordPositionChange(pool, {
      code: "600487.SH", kind: "sell", quantity: 200, price: 65, change_date: "2026-08-15",
      source: "chat", source_session_id: sessionId, decision_origin: "planned_discretionary",
      execution_compliance: "matched", attribution_note: "部分卖出",
    });
    expect(partialSell.change).toMatchObject({ cost_price_before: 60, realized_pnl: 1000 });
    const positions = await api(server!.baseUrl, "GET", "/api/positions");
    expect(positions.json).toMatchObject([{ code: "600487.SH", quantity: 400, attribution_breakdown: {
      strategy_signal: 1, planned_discretionary: 1,
    } }]);
    await recordPositionChange(pool, {
      code: "600487.SH", kind: "sell", quantity: 400, price: 55, change_date: "2026-08-16",
      source: "chat", source_session_id: sessionId, decision_origin: "planned_discretionary",
      execution_compliance: "matched", attribution_note: "最终卖出",
    });
    const changes = await api(server!.baseUrl, "GET", "/api/positions/changes");
    expect(changes.status).toBe(200);
    expect(changes.json).toMatchObject([
      { code: "600487.SH", kind: "sell", cost_price_before: 60, realized_pnl: -2000 },
      { code: "600487.SH", kind: "sell", cost_price_before: 60, realized_pnl: 1000 },
      {
        code: "600487.SH", kind: "buy", source: "chat", decision_origin: "strategy_signal",
        execution_compliance: "matched", source_session_id: sessionId,
        strategy_change_seq: "0", attribution_note: "按当日已确认信号记录",
      },
    ]);
    expect((changes.json as unknown as Array<{ strategy_snapshot_hash: string }>)[0]!.strategy_snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    const summary = await api(server!.baseUrl, "GET", "/api/positions/realized-pnl");
    expect(summary).toMatchObject({ status: 200, json: {
      baseline_pnl: 0, event_pnl: -1000, realized_pnl: -1000,
      sell_count: 2, missing_sell_count: 0, fee_status: "excluded",
    } });
    expect((await api(server!.baseUrl, "GET", "/api/positions")).json).toEqual([]);
    expect((await pool.query(
      "SELECT cash::float, closed_pnl::float FROM portfolio_account_state WHERE id = true",
    )).rows[0]).toEqual({ cash: 0, closed_pnl: 123 });
  });

  it("计划外例外或执行偏离缺少原因时整笔回滚", async () => {
    await expect(recordPositionChange(pool, {
      code: "000021.SZ", kind: "buy", quantity: 100, price: 40, change_date: "2026-08-14",
      source: "chat", source_session_id: sessionId, decision_origin: "unplanned_exception",
      execution_compliance: "deviated",
    })).rejects.toThrow("deviation_reason");
    expect(Number((await pool.query("SELECT count(*) FROM portfolio_position_change WHERE decision_origin = 'unplanned_exception'")).rows[0]!.count)).toBe(0);
  });

  it("短线池/长线池只按官方行业投影完整研究属性", async () => {
    const boardId = (await pool.query<{ id: string }>(
      `INSERT INTO market_instrument (code, name, kind) VALUES ('885001.TI', '测试概念', 'board') RETURNING id::text`,
    )).rows[0]!.id;
    await pool.query("INSERT INTO market_board (instrument_id, board_type, active) VALUES ($1, 'concept', true)", [boardId]);
    const industryId = (await pool.query<{ id: string }>(
      `INSERT INTO market_instrument (code, name, kind) VALUES ('881001.TI', '通信网络设备', 'board') RETURNING id::text`,
    )).rows[0]!.id;
    await pool.query("INSERT INTO market_board (instrument_id, board_type, active) VALUES ($1, 'industry', true)", [industryId]);
    const secondaryIndustryId = (await pool.query<{ id: string }>(
      `INSERT INTO market_instrument (code, name, kind) VALUES ('884001.TI', '光通信设备', 'board') RETURNING id::text`,
    )).rows[0]!.id;
    await pool.query("INSERT INTO market_board (instrument_id, board_type, active) VALUES ($1, 'industry', true)", [secondaryIndustryId]);
    await pool.query(
      `INSERT INTO market_board_membership (board_instrument_id, member_instrument_id, effective_from)
       SELECT $1, id, '2026-08-18' FROM market_instrument WHERE code IN ('600487.SH','510500.SH')`,
      [boardId],
    );
    await pool.query(
      `INSERT INTO market_board_membership (board_instrument_id, member_instrument_id, effective_from)
       SELECT $1, id, '2026-08-18' FROM market_instrument WHERE code = '600487.SH'`,
      [industryId],
    );
    await pool.query(
      `INSERT INTO market_board_membership (board_instrument_id, member_instrument_id, effective_from)
       SELECT $1, id, '2026-08-18' FROM market_instrument WHERE code = '600487.SH'`,
      [secondaryIndustryId],
    );
    await pool.query(
      `INSERT INTO pool_membership
         (instrument_id, pool, role, grade, score, tags, stock_character, stage, evaluation_summary, effective_from)
       SELECT id, 'short', '短线', 'A', 5.5, '["CPO"]', '高波动', '右侧确认', '完整短线评估', '2026-08-18'
         FROM market_instrument WHERE code = '600487.SH'`,
    );
    await pool.query(
      `INSERT INTO pool_membership
         (instrument_id, pool, role, grade, score, tags, stock_character, stage, evaluation_summary, effective_from)
       SELECT id, 'long', '波段', 'B', 4.2, '["ETF"]', '中波动', '观察', '完整长线评估', '2026-08-18'
         FROM market_instrument WHERE code = '510500.SH'`,
    );
    await expect(applyPoolChange(pool, {
      action: "update", code: "600487.SH", pool: "short", tags: ["板块：测试"], effective_from: "2026-08-18",
    })).rejects.toThrow("所属行业只读取同花顺官方关系");
    const short = await api(server!.baseUrl, "GET", "/api/pools/short");
    expect(short.json).toMatchObject({ pool: "short", members: [{ code: "600487.SH", stock_character: "高波动" }] });
    const shortView = short.json as unknown as {
      members: Array<{ boards: Array<{ code: string; name: string; board_type: string; level: string }> }>;
      boards: Array<{ code: string; member_count: number; level: string }>;
    };
    expect(shortView.boards).toEqual([expect.objectContaining({ code: "881001.TI", member_count: 1, level: "primary" })]);
    expect(shortView.members[0]!.boards).toEqual([
      { name: "通信网络设备", board_type: "industry", code: "881001.TI", level: "primary" },
      { name: "光通信设备", board_type: "industry", code: "884001.TI", level: "secondary" },
    ]);
    await expect(setPoolBoardOrder(pool, "short", ["884001.TI"])).rejects.toThrow("大行业");
    const long = await api(server!.baseUrl, "GET", "/api/pools/long");
    expect(long.json).toMatchObject({ pool: "long", members: [{ code: "510500.SH" }] });
    const boards = await api(server!.baseUrl, "GET", "/api/boards?type=concept");
    expect(boards.json).toMatchObject([{ code: "885001.TI", pool_intersection: 2 }]);
  });

  it("近期关注只更新当前角色状态并由标的池查询返回", async () => {
    const before = Number((await pool.query("SELECT count(*) FROM pool_membership WHERE effective_to IS NULL")).rows[0]!.count);
    await applyPoolChange(pool, {
      action: "update",
      code: "600487.SH",
      pool: "short",
      effective_from: "2026-08-18",
      attention_reason: "等待右侧量价确认",
      attention_from: "2026-08-18",
      attention_until: "2026-08-25",
    });
    const after = Number((await pool.query("SELECT count(*) FROM pool_membership WHERE effective_to IS NULL")).rows[0]!.count);
    expect(after).toBe(before);
    const short = await api(server!.baseUrl, "GET", "/api/pools/short");
    expect(short.json).toMatchObject({ members: [{
      code: "600487.SH", attention_reason: "等待右侧量价确认",
      attention_from: "2026-08-18", attention_until: "2026-08-25",
    }] });
  });

  it("旧账户快照和资金摘要 API 已退役", async () => {
    expect((await api(server!.baseUrl, "GET", "/api/account/snapshots")).status).toBe(404);
    expect((await api(server!.baseUrl, "GET", "/api/account/summary")).status).toBe(404);
  });
});
