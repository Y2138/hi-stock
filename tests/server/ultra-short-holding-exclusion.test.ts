// 超短持仓只由 05 离场观察，普通持仓观察任务必须排除，避免三条链路同时评估。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { runIntradayRiskCycle } from "../../server/modules/intraday-risk/service.js";
import { prepareTestDb, seedTestStrategy } from "./helpers.js";
import { recordPositionChange } from "../../server/modules/positions/repo.js";

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("普通持仓观察排除超短持仓", () => {
  let pool: pg.Pool;
  beforeAll(async () => { pool = prepared!.pool; await seedTestStrategy(pool); });
  afterAll(async () => { await pool.end(); });

  it("有超短 holding 行时不再进入普通持仓 LLM 观察", async () => {
    await pool.query("INSERT INTO market_instrument(code,name,kind) VALUES('990099.SZ','超短持仓样本','stock') ON CONFLICT(code) DO NOTHING");
    await pool.query(`INSERT INTO ultra_short_watchlist(target_date,data_date,code,name)
      VALUES('2026-08-17','2026-08-16','990099.SZ','超短持仓样本')`);
    await recordPositionChange(pool, {
      code: "990099.SZ", kind: "buy", quantity: 100, price: 10, change_date: "2026-08-17",
      source: "job", decision_origin: "strategy_signal", execution_compliance: "matched",
      strategy_code: "limit_up", entry_signal_type: "limit_up",
    });
    const snapshot = await runIntradayRiskCycle(
      pool,
      new Date("2026-08-17T02:00:00Z"),
      true,
      "1",
      { at: new Date("2026-08-17T02:00:00Z"), gaps: [], quotes: new Map() },
    );
    expect(snapshot?.positions).toEqual([]);
    const risks = await pool.query("SELECT count(*)::int AS count FROM intraday_position_risk");
    expect(risks.rows[0]!.count).toBe(0);
  });
});
