import { afterAll, describe, expect, it } from "vitest";
import { prepareTestDb } from "./helpers.js";
import { queryTwoYearReversalSignals } from "../../server/modules/plans/two-year-reversal-signal.js";
import { evaluateStrategyExit } from "../../server/modules/strategy-runtime/exit-evaluators.js";

const prepared = await prepareTestDb();
describe.skipIf(!prepared)("两年结构反转独立新开仓信号", () => {
  const pool = prepared!.pool;
  afterAll(async () => pool.end());

  it("无已确认共同数据日时拒绝产生信号", async () => {
    const result = await queryTwoYearReversalSignals(pool, "2026-09-17");
    expect(result.status).toBe("unavailable");
    expect(result.qualified).toEqual([]);
  });

  it("只对目标日满足两年行业结构与相对超跌的未持仓股票产生正式信号", async () => {
    const date = "2026-09-17";
    await pool.query("INSERT INTO market_trading_day (trade_date,is_open,source) VALUES ($1,true,'test')", [date]);
    await pool.query(
      `INSERT INTO market_instrument (code,name,kind)
       SELECT '881'||lpad(n::text,3,'0')||'.TI','行业'||n,'board' FROM generate_series(1,80) n`,
    );
    await pool.query("INSERT INTO market_board (instrument_id,board_type) SELECT id,'industry' FROM market_instrument WHERE kind='board'");
    await pool.query(
      `INSERT INTO market_bar (instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,channel)
       SELECT id,'day',$1::date-500+n,($1::date-500+n)::timestamp AT TIME ZONE 'UTC',
              100,101,99,100,1000,'test'
       FROM market_instrument CROSS JOIN generate_series(0,500) n
       WHERE kind='board' AND code <> '881001.TI'`, [date],
    );
    await pool.query(
      `INSERT INTO market_bar (instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,channel)
       SELECT id,'day',$1::date-500+n,($1::date-500+n)::timestamp AT TIME ZONE 'UTC',
              CASE WHEN n=500 THEN 120 WHEN n>=481 THEN 150 ELSE 100 END,
              150,100,CASE WHEN n=500 THEN 120 WHEN n>=481 THEN 150 ELSE 100 END,1000,'test'
       FROM market_instrument CROSS JOIN generate_series(0,500) n WHERE code='881001.TI'`, [date],
    );
    const stocks = [["000001.SZ",85],["000002.SZ",95],["000003.SZ",96],["000004.SZ",98]] as const;
    for (const [code, close] of stocks) {
      const row = await pool.query<{ id: string }>(
        "INSERT INTO market_instrument (code,name,kind,lifecycle_status) VALUES ($1,$1,'stock','active') RETURNING id::text", [code],
      );
      await pool.query(
        `INSERT INTO market_board_membership (board_instrument_id,member_instrument_id,effective_from)
         SELECT board.id,$1,'2024-01-01' FROM market_instrument board WHERE board.code='881001.TI'`, [row.rows[0]!.id],
      );
      await pool.query(
        `INSERT INTO market_bar (instrument_id,freq,bar_date,bar_time,open,high,low,low_raw,close,volume,channel)
         SELECT $1,'day',$2::date-19+n,($2::date-19+n)::timestamp AT TIME ZONE 'UTC',
                CASE WHEN n=19 THEN $3 ELSE 100 END,
                101,CASE WHEN n=19 THEN $3-1 ELSE 99 END,CASE WHEN n=19 THEN $3-1 ELSE 99 END,
                CASE WHEN n=19 THEN $3 ELSE 100 END,1000,'test'
         FROM generate_series(0,19) n`, [row.rows[0]!.id, date, close],
      );
    }
    const result = await queryTwoYearReversalSignals(pool, date);
    expect(result.status).toBe("success");
    expect(result.coverage).toMatchObject({ stocks: 4, boards: 80, complete_boards: 80, qualified_boards: 1 });
    expect(result.eligible_industries?.map((item) => item.code)).toEqual(["881001.TI"]);
    expect(result.qualified.map((item) => item.code)).toEqual(["000001.SZ"]);
    expect(result.qualified[0]).toMatchObject({ reference_fraction: 0.20, already_held: false, signal_low_raw: 84 });
    const stale = await queryTwoYearReversalSignals(pool, "2026-09-18");
    expect(stale.qualified).toEqual([]);
    expect((stale.historical ?? []).map((item) => item.code)).toEqual(["000001.SZ"]);
    await pool.query("INSERT INTO market_trading_day (trade_date,is_open,source) VALUES ('2026-09-18',true,'test')");
    await pool.query(
      `INSERT INTO market_bar (instrument_id,freq,bar_date,bar_time,open,high,low,close,open_raw,high_raw,low_raw,close_raw,volume,channel)
       SELECT id,'day','2026-09-18','2026-09-18'::timestamp AT TIME ZONE 'UTC',85,95,84,90,85,95,84,90,1000,'test'
         FROM market_instrument WHERE code='000001.SZ'`,
    );
    await pool.query(
      `INSERT INTO portfolio_position
         (instrument_id,quantity,cost_price,opened_at,entry_signal_type,strategy_code,strategy_runtime_version,exit_policy_mode)
       SELECT id,100,85,'2026-09-18','two_year_reversal','two_year_reversal',1,'dedicated'
         FROM market_instrument WHERE code='000001.SZ'`,
    );
    const held = await queryTwoYearReversalSignals(pool, date);
    expect(held.qualified).toEqual([]);
    expect((held.held ?? []).map((item) => item.code)).toEqual(["000001.SZ"]);
    const exit = await evaluateStrategyExit({ pool, targetDate: "2026-09-18", strategyCode: "two_year_reversal" });
    expect(exit.items).toEqual([
      expect.objectContaining({
        code: "000001.SZ", strategy_code: "two_year_reversal", evaluation_role: "primary",
        evidence: expect.objectContaining({ signal_low_raw: 84, current_close_raw: 90, ma20_reached: false }),
      }),
    ]);
  });
});
