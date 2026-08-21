// 资金台账测试（0020）：快照锚点 + 锚点后成交联动现金/清仓收益。
// stock_test 库真实跑，无库 skip。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { runMigrations } from "../../server/db/migrate.js";
import { createPool } from "../../server/db/client.js";
import { recordPositionChange, upsertAccountSnapshot } from "../../server/modules/positions/repo.js";
import { api, prepareTestDb, resetSchema, seedTestStrategy, startTestServer, type TestServer } from "./helpers.js";

const prepared = await prepareTestDb();

interface SummaryBody {
  tracked: boolean;
  anchor_date: string | null;
  cash: number | null;
  closed_pnl: number | null;
  market_value: number;
  total_asset: number | null;
  missing_quote: number;
}

describe.skipIf(!prepared)("资金台账（stock_test 真实库）", () => {
  let pool: pg.Pool;
  let server: TestServer;
  let sessionId: string;

  async function summary(): Promise<SummaryBody> {
    const { status, json } = await api(server.baseUrl, "GET", "/api/account/summary");
    expect(status).toBe(200);
    return json as unknown as SummaryBody;
  }

  async function record(body: Record<string, unknown>) {
    try {
      const result = await recordPositionChange(pool, {
        code: String(body.code),
        kind: body.kind as "buy" | "sell" | "adjust" | "note",
        quantity: body.quantity as number | undefined,
        price: body.price as number | undefined,
        change_date: String(body.change_date),
        source: "chat",
        source_session_id: sessionId,
        decision_origin: "strategy_signal",
        execution_compliance: "matched",
      });
      return { status: 201, json: result };
    } catch (error) {
      const value = error as { httpStatus?: number; message?: string };
      return { status: value.httpStatus ?? 500, json: { error: { message: value.message } } };
    }
  }

  beforeAll(async () => {
    pool = createPool(prepared!.url);
    await resetSchema(pool);
    await runMigrations(pool);
    await seedTestStrategy(pool);
    await pool.query(
      `INSERT INTO market_instrument (code, name, kind) VALUES
         ('600487.SH', '亨通光电', 'stock'),
         ('000021.SZ', '深科技', 'stock')`,
    );
    const inst = await pool.query<{ id: string }>(
      "SELECT id::text FROM market_instrument WHERE code = '600487.SH'",
    );
    await pool.query(
      `INSERT INTO market_bar (instrument_id, freq, bar_date, bar_time, open, high, low, close, volume, ma5, channel)
       VALUES ($1, 'day', '2026-08-17', '2026-08-17T00:00:00Z', 59, 63, 58, 62.98, 1000000, 60.0, 'migrate')`,
      [inst.rows[0]!.id],
    );
    sessionId = (await pool.query<{ id: string }>("INSERT INTO chat_session (title) VALUES ('资金台账测试') RETURNING id::text")).rows[0]!.id;
    server = await startTestServer(pool);
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  it("无台账：成交不阻塞，summary 现金口径为未知", async () => {
    const r = await record({
      code: "600487.SH",
      kind: "buy",
      quantity: 100,
      price: 60,
      change_date: "2026-08-14",
    });
    expect(r.status).toBe(201);
    const s = await summary();
    expect(s.tracked).toBe(false);
    expect(s.cash).toBeNull();
    expect(s.total_asset).toBeNull();
    expect(s.market_value).toBe(6298); // 100 股 × 62.98
  });

  it("同步快照后建立台账锚点；锚点及之前的成交不动台账", async () => {
    await upsertAccountSnapshot(pool, {
      snap_date: "2026-08-15",
      total_asset: 100000,
      cash: 95000,
      closed_pnl: 0,
      source: "form",
    });
    let s = await summary();
    expect(s.tracked).toBe(true);
    expect(s.anchor_date).toBe("2026-08-15");
    expect(s.cash).toBe(95000);

    // change_date <= anchor_date：视为已被快照吸收，不动现金
    const r = await record({
      code: "600487.SH",
      kind: "buy",
      quantity: 100,
      price: 60,
      change_date: "2026-08-15",
    });
    expect(r.status).toBe(201);
    s = await summary();
    expect(s.cash).toBe(95000);
  });

  it("锚点后买入扣减现金；超出可用资金 400 且整体回滚", async () => {
    const r = await record({
      code: "000021.SZ",
      kind: "buy",
      quantity: 100,
      price: 50,
      change_date: "2026-08-16",
    });
    expect(r.status).toBe(201);
    let s = await summary();
    expect(s.cash).toBe(90000); // 95000 − 5000

    const over = await record({
      code: "000021.SZ",
      kind: "buy",
      quantity: 100000,
      price: 50,
      change_date: "2026-08-16",
    });
    expect(over.status).toBe(400);
    expect(JSON.stringify(over.json)).toContain("可用资金不足");
    // 回滚：持仓与事件流都不留痕
    const pos = await pool.query(
      `SELECT quantity::float FROM portfolio_position p
        JOIN market_instrument i ON i.id = p.instrument_id WHERE i.code = '000021.SZ'`,
    );
    expect(Number(pos.rows[0]!.quantity)).toBe(100);
    s = await summary();
    expect(s.cash).toBe(90000);
  });

  it("部分卖出只回补现金；全清卖出累加清仓收益", async () => {
    // 持仓 600487.SH 共 200 股：无台账期 100 股 @60 + 锚前 100 股 @60，成本 60
    const partial = await record({
      code: "600487.SH",
      kind: "sell",
      quantity: 50,
      price: 70,
      change_date: "2026-08-16",
    });
    expect(partial.status).toBe(201);
    let s = await summary();
    expect(s.cash).toBe(93500); // 90000 + 3500
    expect(s.closed_pnl).toBe(0); // 部分卖出不计（0010 口径）
    expect(Number((await pool.query(
      `SELECT pending_realized_pnl::float FROM portfolio_position p
        JOIN market_instrument i ON i.id = p.instrument_id WHERE i.code = '600487.SH'`,
    )).rows[0]!.pending_realized_pnl)).toBe(500);

    const full = await record({
      code: "600487.SH",
      kind: "sell",
      quantity: 150,
      price: 70,
      change_date: "2026-08-16",
    });
    expect(full.status).toBe(201);
    expect((full.json as unknown as { position: unknown }).position).toBeNull();
    const cleared = await pool.query(
      `SELECT 1 FROM portfolio_position p
        JOIN market_instrument i ON i.id = p.instrument_id WHERE i.code = '600487.SH'`,
    );
    expect(cleared.rowCount).toBe(0);
    s = await summary();
    expect(s.cash).toBe(104000); // 93500 + 10500
    expect(s.closed_pnl).toBe(2000); // 50 × (70 − 60) + 150 × (70 − 60)
    expect(s.market_value).toBe(0); // 600487 已清仓；000021 无行情
    expect(s.missing_quote).toBe(1);
  });

  it("重锚：更早快照不动台账，更晚快照重置台账", async () => {
    await upsertAccountSnapshot(pool, {
      snap_date: "2026-08-14",
      total_asset: 1,
      cash: 1,
      closed_pnl: 0,
      market_value: 0,
      source: "form",
    });
    let s = await summary();
    expect(s.anchor_date).toBe("2026-08-15");
    expect(s.cash).toBe(104000);

    await upsertAccountSnapshot(pool, {
      snap_date: "2026-08-18",
      total_asset: 110500,
      cash: 104500,
      closed_pnl: 1600,
      market_value: 6000,
      source: "form",
    });
    s = await summary();
    expect(s.anchor_date).toBe("2026-08-18");
    expect(s.cash).toBe(104500);
    expect(s.closed_pnl).toBe(1600);
    expect(s.total_asset).toBe(104500); // 现金 + 市值 0（000021 无行情不计入市值）
  });
});
