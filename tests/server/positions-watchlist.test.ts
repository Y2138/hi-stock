// 行情、短线/长线池与成交级归因 API 契约；旧自选、页面成交和持久化画线必须退役。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { runMigrations } from "../../server/db/migrate.js";
import { createPool } from "../../server/db/client.js";
import { applyPoolChange, setPoolAttentionEntry, setPoolBoardOrder } from "../../server/modules/pools/repo.js";
import { attentionSourceLabel, attentionStatusLabel, compareAttentionQuality } from "../../web/src/utils/poolAttention.js";
import { createAccount, archiveAccount } from "../../server/modules/accounts/repo.js";
import { getRealizedPnlSummary, listPositions, recordPositionChange, updatePositionEntrySignalType } from "../../server/modules/positions/repo.js";
import { marketRoutes } from "../../server/modules/market/routes.js";
import { api, prepareTestDb, resetSchema, seedTestStrategy, startTestServer, type TestServer } from "./helpers.js";

const prepared = await prepareTestDb();

it("近期关注按信号完整度分档：已成立 → 待补信号 → 人工关注", () => {
  const entry = (status: "qualified" | "approaching" | "manual", source_job = "manual") => ({
    source_job, status, reason: "测试", missing_signals: [] as string[], valid_from: "2026-08-18", valid_until: null,
  });
  const members = [
    { code: "000003.SZ", attention_entries: [entry("approaching")] },
    { code: "000001.SZ", attention_entries: [] },
    { code: "000004.SZ", attention_entries: [entry("qualified")] },
    { code: "000002.SZ", attention_entries: [entry("manual")] },
    { code: "000005.SZ", attention_entries: [entry("approaching", "daily_plan_flow")] },
  ];
  expect([...members].sort(compareAttentionQuality).map((member) => member.code))
    .toEqual(["000004.SZ", "000003.SZ", "000005.SZ", "000002.SZ", "000001.SZ"]);
  expect(attentionStatusLabel(entry("approaching"))).toBe("待补信号 · 次日观察");
  expect(attentionStatusLabel(entry("manual"))).toBe("人工关注");
  expect(attentionStatusLabel(entry("qualified"))).toBe("信号已成立");
  expect(attentionSourceLabel(entry("qualified", "daily_plan_flow"))).toBe("每日计划");
  expect(attentionSourceLabel(entry("qualified"))).toBe("人工");
});

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
      execution_compliance: "matched", strategy_code: "swing", entry_signal_type: "swing", attribution_note: "按当日已确认信号记录",
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
      execution_compliance: "deviated", strategy_code: "discretionary", entry_signal_type: "discretionary",
    })).rejects.toThrow("deviation_reason");
    expect(Number((await pool.query("SELECT count(*) FROM portfolio_position_change WHERE decision_origin = 'unplanned_exception'")).rows[0]!.count)).toBe(0);
  });

  it("买入必须声明管理策略，跨策略加仓被拒绝，修正走留痕事件", async () => {
    await expect(recordPositionChange(pool, {
      code: "000021.SZ", kind: "buy", quantity: 100, price: 40, change_date: "2026-08-14",
      source: "chat", source_session_id: sessionId, decision_origin: "unplanned_exception",
      execution_compliance: "matched", deviation_reason: "盘中临时决策",
    })).rejects.toThrow("strategy_code");

    const buy = await recordPositionChange(pool, {
      code: "000021.SZ", kind: "buy", quantity: 100, price: 40, change_date: "2026-08-14",
      source: "chat", source_session_id: sessionId, decision_origin: "unplanned_exception",
      execution_compliance: "matched", deviation_reason: "盘中临时决策",
      strategy_code: "discretionary", entry_signal_type: "discretionary",
    });
    expect(buy.change).toMatchObject({ kind: "buy", entry_signal_type: "discretionary" });
    expect((await pool.query<{ entry_signal_type: string | null }>(
      "SELECT entry_signal_type FROM portfolio_position WHERE instrument_id = $1",
      [buy.change.instrument_id],
    )).rows[0]).toEqual({ entry_signal_type: "discretionary" });

    // 同一持仓禁止跨策略加仓，原管理策略保持不变。
    await expect(recordPositionChange(pool, {
      code: "000021.SZ", kind: "buy", quantity: 100, price: 42, change_date: "2026-08-15",
      source: "chat", source_session_id: sessionId, decision_origin: "strategy_signal",
      execution_compliance: "matched", strategy_code: "swing", entry_signal_type: "swing",
    })).rejects.toThrow("跨策略加仓");
    expect((await pool.query<{ entry_signal_type: string | null; strategy_code: string | null }>(
      "SELECT entry_signal_type, strategy_code FROM portfolio_position WHERE instrument_id = $1",
      [buy.change.instrument_id],
    )).rows[0]).toEqual({ entry_signal_type: "discretionary", strategy_code: "discretionary" });

    // 卖出事件不允许携带信号类型。
    await expect(recordPositionChange(pool, {
      code: "000021.SZ", kind: "sell", quantity: 50, price: 44, change_date: "2026-08-16",
      source: "chat", source_session_id: sessionId, decision_origin: "planned_discretionary",
      execution_compliance: "matched", entry_signal_type: "swing",
    })).rejects.toThrow("entry_signal_type");

    const corrected = await updatePositionEntrySignalType(pool, {
      code: "000021.SZ", entry_signal_type: "swing", reason: "核对当日波段四条件证据后修正",
      source: "chat", source_session_id: sessionId,
    });
    expect(corrected.previous_type).toBe("discretionary");
    expect(corrected.position).toMatchObject({ code: "000021.SZ", entry_signal_type: "swing", strategy_code: "swing" });
    const buys = await pool.query<{ entry_signal_type: string | null }>(
      `SELECT entry_signal_type FROM portfolio_position_change
        WHERE instrument_id = $1 AND kind = 'buy' ORDER BY change_date, id`,
      [buy.change.instrument_id],
    );
    expect(buys.rows.map((row) => row.entry_signal_type)).toEqual(["swing"]);
    const note = await pool.query<{ decision_origin: string; attribution_note: string }>(
      `SELECT decision_origin, attribution_note FROM portfolio_position_change
        WHERE instrument_id = $1 AND kind = 'note'`,
      [buy.change.instrument_id],
    );
    expect(note.rows[0]).toMatchObject({ decision_origin: "fact_correction" });
    expect(note.rows[0]!.attribution_note).toContain("swing");
  });

  it("关注池只按官方行业投影完整研究属性", async () => {
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
         (instrument_id, pool, role, tags, stock_character, stage, evaluation_summary, effective_from)
       SELECT id, 'watch', '关注', '["CPO"]', '高波动', '右侧确认', '完整评估：600487', '2026-08-18'
         FROM market_instrument WHERE code = '600487.SH'`,
    );
    await pool.query(
      `INSERT INTO pool_membership
         (instrument_id, pool, role, tags, stock_character, stage, evaluation_summary, effective_from)
       SELECT id, 'watch', '关注', '["ETF"]', '中波动', '观察', '完整评估：510500', '2026-08-18'
         FROM market_instrument WHERE code = '510500.SH'`,
    );
    await expect(applyPoolChange(pool, {
      action: "update", code: "600487.SH", pool: "watch", tags: ["板块：测试"], effective_from: "2026-08-18",
    })).rejects.toThrow("所属行业只读取同花顺官方关系");
    const watch = await api(server!.baseUrl, "GET", "/api/pools?date=2026-08-18");
    expect(watch.json).toMatchObject({ pool: "watch" });
    expect((watch.json as unknown as { members: Array<{ code: string; stock_character: string | null }> }).members)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "600487.SH", stock_character: "高波动" }),
        expect.objectContaining({ code: "510500.SH" }),
      ]));
    const watchView = watch.json as unknown as {
      members: Array<{ code: string; boards: Array<{ code: string; name: string; board_type: string; level: string }> }>;
      boards: Array<{ code: string; member_count: number; level: string }>;
    };
    // 大行业投影只统计有官方行业关系的成员（ETF 无行业内关系）。
    expect(watchView.boards).toEqual([expect.objectContaining({ code: "881001.TI", member_count: 1, level: "primary" })]);
    expect(watchView.members.find((member) => member.code === "600487.SH")!.boards).toEqual([
      { name: "通信网络设备", board_type: "industry", code: "881001.TI", level: "primary" },
      { name: "光通信设备", board_type: "industry", code: "884001.TI", level: "secondary" },
    ]);
    await expect(setPoolBoardOrder(pool, ["884001.TI"])).rejects.toThrow("大行业");
    const boards = await api(server!.baseUrl, "GET", "/api/boards?type=concept");
    expect(boards.json).toMatchObject([{ code: "885001.TI", pool_intersection: 2 }]);
  });

  /** 扶摇快照响应桩：本地请求放行，按资产类型返回给定 item。 */
  const stubSnapshot = (stockItem: unknown[], etfItem: unknown[]) => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes("fuyao.aicubes.cn")) return realFetch(url as string, init);
      const item = new URL(String(url)).pathname === "/api/a-share/prices/snapshot" ? stockItem : etfItem;
      return new Response(JSON.stringify({
        code: 0,
        message: "success",
        data: { timestamp: Date.parse("2026-08-18T10:05:00+08:00"), item },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
  };

  it("关注池可按需获取全部标的最新涨跌幅，且不写日线", async () => {
    stubSnapshot(
      [{ thscode: "600487.SH", last_price: 66, prev_price: 60, open_price: 61, high_price: 67, low_price: 60 }],
      [{ thscode: "510500.SH", last_price: 6.6, prev_price: 6.5, open_price: 6.5, high_price: 6.7, low_price: 6.4 }],
    );
    try {
      const before = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM market_bar");
      const result = await api(server!.baseUrl, "POST", "/api/pools/quotes");
      expect(result.status).toBe(200);
      const data = result.json as unknown as {
        sampled_at: string;
        gaps: string[];
        items: Array<{ code: string; last: number; change_pct: number | null; quote_time: string; captured_at: string }>;
      };
      expect(data.gaps).toEqual([]);
      expect(data.sampled_at).toBe("2026-08-18T02:05:00.000Z");
      expect(data.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "600487.SH", last: 66, quote_time: "2026-08-18", captured_at: "2026-08-18T02:05:00.000Z" }),
        expect.objectContaining({ code: "510500.SH", last: 6.6, quote_time: "2026-08-18" }),
      ]));
      expect(data.items.find((item) => item.code === "600487.SH")!.change_pct).toBeCloseTo(0.1, 10);
      expect(data.items.find((item) => item.code === "510500.SH")!.change_pct).toBeCloseTo(0.01538, 5);
      // 按需快照只服务页面展示，不能把盘中价写入日线。
      const after = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM market_bar");
      expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 20_000);

  it("关注池实时行情对缺失快照显式给出缺口而不冒充成功", async () => {
    stubSnapshot([{ thscode: "600487.SH", last_price: 66, prev_price: 60 }], []);
    try {
      const result = await api(server!.baseUrl, "POST", "/api/pools/quotes");
      expect(result.status).toBe(200);
      const data = result.json as unknown as { gaps: string[]; items: Array<{ code: string }> };
      expect(data.items.map((item) => item.code)).toEqual(["600487.SH"]);
      expect(data.gaps.join("；")).toContain("510500.SH");
      expect(data.gaps.join("；")).toContain("快照未返回");
    } finally {
      vi.unstubAllGlobals();
    }
  }, 20_000);

  it("关注池实时行情全部失败时返回明确错误而不是空成功", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes("fuyao.aicubes.cn")) return realFetch(url as string, init);
      return new Response(JSON.stringify({ code: 5001, message: "数据源不可用" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }));
    try {
      const result = await api(server!.baseUrl, "POST", "/api/pools/quotes");
      expect(result.status).toBe(502);
      expect(result.json).toMatchObject({ error: { code: "QUOTE_UNAVAILABLE" } });
    } finally {
      vi.unstubAllGlobals();
    }
  }, 20_000);

  it("同一生效日重新初始化时更新原角色行而不制造冲突历史", async () => {
    const before = (await pool.query(
      `SELECT membership.id::text
         FROM pool_membership membership JOIN market_instrument instrument ON instrument.id = membership.instrument_id
        WHERE instrument.code = '510500.SH' AND membership.effective_to IS NULL`,
    )).rows[0]!.id;
    await applyPoolChange(pool, {
      action: "update",
      code: "510500.SH",
      pool: "watch",
      role: "关注",
      tags: ["画像版本：标的入池五维画像一版"],
      stock_character: "洗盘恢复中·拉升中·假突破风险低·护盘中·波动中",
      stock_character_profile: { dimensions: {} },
      stage: "上升",
      evaluation_summary: "同日重新初始化后的确定性档案",
      profile_as_of: "2026-08-18",
      profile_calculation_version: "标的入池五维画像一版",
      profile_input_sha256: "a".repeat(64),
      effective_from: "2026-08-18",
    });
    const after = (await pool.query(
      `SELECT membership.id::text, membership.profile_calculation_version
         FROM pool_membership membership JOIN market_instrument instrument ON instrument.id = membership.instrument_id
        WHERE instrument.code = '510500.SH' AND membership.effective_to IS NULL`,
    )).rows[0];
    expect(after).toEqual({ id: before, profile_calculation_version: "标的入池五维画像一版" });
  });

  it("关注条目按来源独立维护，池接口返回多来源近期关注", async () => {
    await setPoolAttentionEntry(pool, {
      code: "600487.SH", source_job: "daily_plan_flow", status: "approaching",
      reason: "等待右侧量价确认", missing_signals: ["右侧：放量站稳关键位"],
      valid_from: "2026-08-18", valid_until: "2026-08-25",
    });
    await setPoolAttentionEntry(pool, {
      code: "600487.SH", source_job: "manual", status: "manual",
      reason: "人工持续跟踪", valid_from: "2026-08-18",
    });
    const view = await api(server!.baseUrl, "GET", "/api/pools?date=2026-08-18");
    const viewMembers = (view.json as unknown as { members: Array<{ code: string; attention_entries: Array<{ source_job: string; status: string; reason: string; missing_signals: string[] }> }> }).members;
    expect(viewMembers.find((member) => member.code === "600487.SH")!.attention_entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_type: "strategy", strategy_code: "swing", source_job: "daily_plan_flow", status: "approaching", reason: "等待右侧量价确认", missing_signals: ["右侧：放量站稳关键位"] }),
      expect.objectContaining({ source_type: "manual", strategy_code: null, source_job: "manual", status: "manual", reason: "人工持续跟踪", missing_signals: [] }),
    ]));
    // 按来源移除：只清指定来源，另一来源保留。
    const removed = await api(server!.baseUrl, "DELETE", "/api/pools/600487.SH/attention?strategy=swing");
    expect(removed).toMatchObject({ status: 200, json: { code: "600487.SH", removed: { source_job: "daily_plan_flow" } } });
    const afterRemove = await api(server!.baseUrl, "GET", "/api/pools?date=2026-08-18");
    expect((afterRemove.json as unknown as { members: Array<{ code: string; attention_entries: Array<{ source_job: string }> }> })
      .members.find((member) => member.code === "600487.SH")!.attention_entries.map((entry) => entry.source_job))
      .toEqual(["manual"]);
    expect(await api(server!.baseUrl, "DELETE", "/api/pools/999999.SH/attention"))
      .toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
  });

  it("approaching 条目必须携带缺失条件，qualified 不得携带；清除时日期一并清除", async () => {
    await expect(setPoolAttentionEntry(pool, {
      code: "510500.SH", source_job: "daily_plan_flow", status: "approaching",
      reason: "等待确认", missing_signals: [], valid_from: "2026-08-18",
    })).rejects.toThrow("缺失条件");
    await expect(setPoolAttentionEntry(pool, {
      code: "510500.SH", source_job: "daily_plan_flow", status: "qualified",
      reason: "波段信号成立", missing_signals: ["多余缺口"], valid_from: "2026-08-18",
    })).rejects.toThrow("缺失条件");
    const write = await setPoolAttentionEntry(pool, {
      code: "510500.SH", source_job: "daily_plan_flow", status: "qualified",
      reason: "波段信号成立", valid_from: "2026-08-18", valid_until: "2026-08-25",
    });
    expect(write.after).toMatchObject({ status: "qualified", reason: "波段信号成立", valid_until: "2026-08-25" });
    const cleared = await setPoolAttentionEntry(pool, {
      code: "510500.SH", source_job: "daily_plan_flow", status: "qualified", reason: null,
    });
    expect(cleared.before).not.toBeNull();
    expect(cleared.after).toBeNull();
  });

  it("账户买入保留共享策略关注与人工关注", async () => {
    await setPoolAttentionEntry(pool, {
      code: "600487.SH", source_job: "daily_plan_flow", status: "qualified",
      reason: "已符合：等待买入", valid_from: "2026-08-18", valid_until: "2026-08-19",
    });
    await setPoolAttentionEntry(pool, {
      code: "600487.SH", source_job: "daily_plan_flow", strategy_code: "discretionary", status: "qualified",
      reason: "自主决策等待买入", valid_from: "2026-08-18", valid_until: "2026-08-19",
    });
    await setPoolAttentionEntry(pool, {
      code: "600487.SH", source_job: "manual", status: "manual",
      reason: "人工持续跟踪", valid_from: "2026-08-18",
    });
    await recordPositionChange(pool, {
      code: "600487.SH", kind: "buy", quantity: 100, price: 60, change_date: "2026-08-18",
      source: "chat", source_session_id: sessionId, decision_origin: "planned_discretionary",
      execution_compliance: "matched", strategy_code: "discretionary", entry_signal_type: "discretionary",
    });
    const entries = (await pool.query<{ source_job: string }>(
      `SELECT entry.source_job
         FROM pool_attention_entry entry
         JOIN market_instrument instrument ON instrument.id = entry.instrument_id
        WHERE instrument.code = '600487.SH'`,
    )).rows.map((row) => row.source_job);
    expect(entries.sort()).toEqual(["daily_plan_flow", "daily_plan_flow", "manual"]);
  });

  it("旧账户快照和资金摘要 API 已退役", async () => {
    expect((await api(server!.baseUrl, "GET", "/api/account/snapshots")).status).toBe(404);
    expect((await api(server!.baseUrl, "GET", "/api/account/summary")).status).toBe(404);
  });
  it("命名账户的同标的成交、成本、收益和归档彼此隔离", async () => {
    const first = await createAccount(pool, "隔离账户甲");
    const second = await createAccount(pool, "隔离账户乙");
    const buy = { code: "000021.SZ",kind: "buy" as const,quantity: 100,price: 10,change_date: "2026-09-28",
      source: "ingest" as const,decision_origin: "planned_discretionary" as const,
      execution_compliance: "matched" as const,strategy_code: "discretionary" };
    await recordPositionChange(pool, { ...buy, account_id:first.id });
    await recordPositionChange(pool, { ...buy, account_id:second.id, quantity:200, price:20 });
    const overview = await api(server!.baseUrl,"GET","/api/accounts/overview");
    expect(overview.status).toBe(200);
    const portfolios=(overview.json as unknown as {accounts:Array<{account:{id:string};positions:Array<{quantity:number;cost_price:number}>;jobs:Array<{execution_scope:string}>}>;global_jobs:Array<{execution_scope:string}>}).accounts;
    expect(portfolios.find(item=>item.account.id===first.id)?.positions).toMatchObject([{quantity:100,cost_price:10}]);
    expect(portfolios.find(item=>item.account.id===second.id)?.positions).toMatchObject([{quantity:200,cost_price:20}]);
    expect(portfolios.every(item=>item.jobs.every(job=>job.execution_scope==="account"))).toBe(true);
    expect((overview.json as unknown as {global_jobs:Array<{execution_scope:string}>}).global_jobs.every(job=>job.execution_scope==="global")).toBe(true);
    expect(await listPositions(pool,first.id)).toMatchObject([{quantity:100,cost_price:10,account_id:first.id}]);
    expect(await listPositions(pool,second.id)).toMatchObject([{quantity:200,cost_price:20,account_id:second.id}]);
    await expect(archiveAccount(pool,first.id)).rejects.toThrow("仍有持仓");
    await expect(recordPositionChange(pool, {account_id:first.id,code:buy.code,kind:"sell",quantity:101,price:12,
      change_date:"2026-09-29",source:"ingest",decision_origin:"planned_discretionary",execution_compliance:"matched"})).rejects.toThrow("超过");
    await recordPositionChange(pool, {account_id:first.id,code:buy.code,kind:"sell",quantity:100,price:12,
      change_date:"2026-09-29",source:"ingest",decision_origin:"planned_discretionary",execution_compliance:"matched"});
    expect((await getRealizedPnlSummary(pool,first.id)).realized_pnl).toBe(200);
    expect((await getRealizedPnlSummary(pool,second.id)).realized_pnl).toBe(0);
    expect(await listPositions(pool,second.id)).toMatchObject([{quantity:200,cost_price:20}]);
    expect((await api(server!.baseUrl,"GET",`/api/positions?account_id=${second.id}`)).json).toMatchObject([{quantity:200,cost_price:20}]);
    expect((await archiveAccount(pool,first.id)).status).toBe("archived");
    await expect(recordPositionChange(pool,{...buy,account_id:first.id})).rejects.toThrow("已归档");
  });

});
