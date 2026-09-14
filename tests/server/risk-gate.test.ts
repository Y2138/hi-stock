// 风控三件套（宽度确认/绝对动量/账户熔断）的每日判定契约：结论依据《研究总结论_终版》采纳层。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import { runMigrations } from "../../server/db/migrate.js";
import { createPool, closePool } from "../../server/db/client.js";
import { queryRiskGate, recordDailyEquity } from "../../server/modules/plans/risk-gate.js";
import { prepareTestDb } from "./helpers.js";

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("风控三件套每日判定（stock_test 真实库）", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createPool(prepared!.url);
    await runMigrations(pool);
  });
  afterAll(async () => {
    await closePool();
  });

  function addDays(date: string, days: number): string {
    return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
  }

  it("宽度确认：多数行业上涨时开闸，少数上涨时关闸；动量按等权累乘判定", async () => {
    // 4 个板块上行、4 个下行 → 占比 0.5 < 0.6 关闸；下行侧 -1.5%/日 → 等权综合 60 日收益为负 → 绝对动量关。
    const endDate = "2026-01-31";
    for (let index = 0; index < 8; index += 1) {
      const code = `8813${String(index).padStart(2, "0")}.TI`;
      const rising = index < 4;
      const instrument = await pool.query<{ id: string }>(
        `INSERT INTO market_instrument (code, name, kind) VALUES ($1, $1, 'board')
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [code]);
      await pool.query(
        `INSERT INTO market_board (instrument_id, board_type, source, active) VALUES ($1, 'industry', 'hithink', true)
         ON CONFLICT (instrument_id) DO NOTHING`, [instrument.rows[0]!.id]);
      let close = rising ? 100 : 200;
      for (let day = 129; day >= 0; day -= 1) {
        close = rising ? close * 1.01 : close * 0.985;
        await pool.query(
          `INSERT INTO market_bar (instrument_id, bar_date, bar_time, open, high, low, close, freq, adjustment, channel, volume)
           VALUES ($1, $2::date, '1970-01-01 00:00:00+00', $3, $3, $3, $3, 'day', 'none', 'test', 0)
           ON CONFLICT (instrument_id, freq, bar_date, bar_time) DO UPDATE SET close = EXCLUDED.close`,
          [instrument.rows[0]!.id, addDays(endDate, -day), Number(close.toFixed(4))]);
      }
    }
    const gate = await queryRiskGate(pool, endDate);
    expect(gate.data_date).toBe(endDate);
    expect(gate.industry_rising_ratio).toBeCloseTo(0.5, 6);
    expect(gate.breadth_open).toBe(false);
    expect(gate.composite_return_60d).not.toBeNull();
    // 等权日收益 = (+1% + -1.5%)/2 = -0.25%/日 → 60 日累乘为负
    expect(gate.composite_return_60d!).toBeLessThan(0);
    expect(gate.absolute_momentum_open).toBe(false);
    expect(gate.stop_loss_streak).toBe(0);
    expect(gate.drawdown_20d).toBeNull();
    expect(gate.equity_circuit_open).toBeNull();
    expect(gate.note).toContain("广域宇宙");
  });

  it("全部行业上涨：宽度与绝对动量双开闸", async () => {
    // 隔离：移除上一用例的 881 板块登记，保证截面只含本用例板块。
    await pool.query(
      `DELETE FROM market_board WHERE instrument_id IN (SELECT id FROM market_instrument WHERE code LIKE '881%')`);
    const endDate = "2026-02-28";
    for (let index = 0; index < 6; index += 1) {
      const code = `8814${String(index).padStart(2, "0")}.TI`;
      const instrument = await pool.query<{ id: string }>(
        `INSERT INTO market_instrument (code, name, kind) VALUES ($1, $1, 'board')
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [code]);
      await pool.query(
        `INSERT INTO market_board (instrument_id, board_type, source, active) VALUES ($1, 'industry', 'hithink', true)
         ON CONFLICT (instrument_id) DO NOTHING`, [instrument.rows[0]!.id]);
      let close = 100;
      for (let day = 129; day >= 0; day -= 1) {
        close *= 1.005;
        await pool.query(
          `INSERT INTO market_bar (instrument_id, bar_date, bar_time, open, high, low, close, freq, adjustment, channel, volume)
           VALUES ($1, $2::date, '1970-01-01 00:00:00+00', $3, $3, $3, $3, 'day', 'none', 'test', 0)
           ON CONFLICT (instrument_id, freq, bar_date, bar_time) DO UPDATE SET close = EXCLUDED.close`,
          [instrument.rows[0]!.id, addDays(endDate, -day), Number(close.toFixed(4))]);
      }
    }
    const gate = await queryRiskGate(pool, endDate);
    expect(gate.industry_rising_ratio).toBe(1);
    expect(gate.breadth_open).toBe(true);
    expect(gate.composite_return_60d!).toBeGreaterThan(0.2);
    expect(gate.absolute_momentum_open).toBe(true);
  });

  it("连损熔断：连续3笔亏损平仓触发；净值快照与回撤熔断按 20 日口径判定", async () => {
    await pool.query(`DELETE FROM portfolio_position_change`);
    await pool.query(`DELETE FROM portfolio_equity_daily`);
    const endDate = "2026-03-31";
    for (let index = 0; index < 3; index += 1) {
      await pool.query(
        `INSERT INTO portfolio_position_change (instrument_id, change_date, kind, quantity, price, amount, reason, source, realized_pnl)
         VALUES ((SELECT id FROM market_instrument WHERE code='881400.TI' LIMIT 1), $1::date, 'sell', 100, 9, 900, '止损', 'form', -120)`,
        [addDays(endDate, -index * 3)]);
    }
    // 净值快照：25 个交易日，前段 100000 后段跌破 94000（回撤 6%）
    for (let day = 24; day >= 0; day -= 1) {
      const equity = day >= 10 ? 100_000 : 94_000;
      await pool.query(
        `INSERT INTO portfolio_equity_daily (snap_date, cash, market_value, equity) VALUES ($1::date, $2, $3, $4)
         ON CONFLICT (snap_date) DO UPDATE SET equity = EXCLUDED.equity`,
        [addDays(endDate, -day), equity, 0, equity]);
    }
    const gate = await queryRiskGate(pool, endDate);
    expect(gate.stop_loss_streak).toBe(3);
    expect(gate.equity_snapshot_days).toBeGreaterThanOrEqual(20);
    expect(gate.drawdown_20d!).toBeGreaterThanOrEqual(0.05);
    expect(gate.equity_circuit_open).toBe(true);
  });

  it("recordDailyEquity：台账+持仓物化当日快照，幂等；无台账时不写", async () => {
    await pool.query(`DELETE FROM portfolio_equity_daily`);
    await pool.query(`DELETE FROM portfolio_account_state`);
    expect(await recordDailyEquity(pool, "2026-04-01")).toBe(false);
    await pool.query(
      `INSERT INTO portfolio_account_state (id, cash, closed_pnl, anchor_date) VALUES (true, 50000, 0, '2026-01-01')`);
    const stock = await pool.query<{ id: string }>(
      `INSERT INTO market_instrument (code, name, kind) VALUES ('600001.SH', '测试股', 'stock')
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
    await pool.query(
      `INSERT INTO portfolio_position (instrument_id, quantity, cost_price, opened_at) VALUES ($1, 1000, 10, '2026-01-05')
       ON CONFLICT (instrument_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [stock.rows[0]!.id]);
    await pool.query(
      `INSERT INTO market_bar (instrument_id, bar_date, bar_time, open, high, low, close, freq, adjustment, channel, volume)
       VALUES ($1, '2026-04-01', '1970-01-01 00:00:00+00', 12, 12, 12, 12, 'day', 'forward', 'test', 1000)`,
      [stock.rows[0]!.id]);
    expect(await recordDailyEquity(pool, "2026-04-01")).toBe(true);
    expect(await recordDailyEquity(pool, "2026-04-01")).toBe(true);
    const row = await pool.query(`SELECT cash::float8 AS cash, market_value::float8 AS mv, equity::float8 AS equity FROM portfolio_equity_daily WHERE snap_date='2026-04-01'`);
    expect(row.rows[0]).toMatchObject({ cash: 50_000, mv: 12_000, equity: 62_000 });
  });
});
