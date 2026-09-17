import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { runMigrations } from "../../server/db/migrate.js";
import { ensureStrategyEvaluation } from "../../server/modules/strategy-runtime/service.js";
import { prepareTestDb, resetSchema } from "./helpers.js";

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("策略评估运行幂等复用", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
  });

  afterAll(async () => pool.end());

  it("成功结果复用、失败重试、运行中等待且输入推进生成新运行", async () => {
    const input = { strategy_code: "swing", phase: "entry" as const, target_date: "2026-09-17" };
    const first = await ensureStrategyEvaluation(pool, input);
    expect(first).toMatchObject({ execution: "executed", run: { status: "success", attempt_count: 1 } });
    expect(first.result).toMatchObject({ status: "success", signal_count: 0 });

    const reused = await ensureStrategyEvaluation(pool, input);
    expect(reused).toMatchObject({ execution: "reused", run: { id: first.run.id, attempt_count: 1 } });
    expect(reused.result).toEqual(first.result);

    await pool.query("UPDATE strategy_evaluation_run SET status='failed',result=NULL WHERE id=$1", [first.run.id]);
    const retried = await ensureStrategyEvaluation(pool, input);
    expect(retried).toMatchObject({ execution: "executed", run: { id: first.run.id, status: "success", attempt_count: 2 } });

    await pool.query("UPDATE strategy_evaluation_run SET status='running',finished_at=NULL WHERE id=$1", [first.run.id]);
    const waiting = await ensureStrategyEvaluation(pool, input);
    expect(waiting).toMatchObject({ execution: "waiting", run: { id: first.run.id, status: "running" }, result: null });
    await pool.query("UPDATE strategy_evaluation_run SET started_at=now()-interval '31 minutes' WHERE id=$1", [first.run.id]);
    const recovered = await ensureStrategyEvaluation(pool, input);
    expect(recovered).toMatchObject({ execution: "executed", run: { id: first.run.id, status: "success", attempt_count: 3 } });

    const concurrentInput = { strategy_code: "swing", phase: "entry" as const, target_date: "2026-09-18" };
    const concurrent = await Promise.all([
      ensureStrategyEvaluation(pool, concurrentInput),
      ensureStrategyEvaluation(pool, concurrentInput),
    ]);
    expect(concurrent.map((item) => item.execution)).toContain("executed");
    expect(concurrent.every((item) => item.run.id === concurrent[0]!.run.id)).toBe(true);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM strategy_evaluation_run WHERE strategy_code='swing' AND target_date='2026-09-18'",
    )).rows[0]!.count).toBe(1);

    const instrument = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('990119.SZ','指纹推进样本','stock') RETURNING id::text",
    );
    await pool.query(
      "INSERT INTO pool_membership(instrument_id,pool,role,effective_from) VALUES ($1,'watch','关注','2026-09-17')",
      [instrument.rows[0]!.id],
    );
    const changed = await ensureStrategyEvaluation(pool, input);
    expect(changed.execution).toBe("executed");
    expect(changed.run.id).not.toBe(first.run.id);
    expect(changed.run.input_fingerprint).not.toBe(first.run.input_fingerprint);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM strategy_evaluation_run WHERE strategy_code='swing' AND target_date='2026-09-17'",
    )).rows[0]!.count).toBe(2);
  });

  it("出场评估持久化结构化持仓动作", async () => {
    const instrument = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('510119.SH','兜底评估样本','etf') RETURNING id::text",
    );
    await pool.query(
      `INSERT INTO portfolio_position
         (instrument_id,quantity,cost_price,opened_at,entry_signal_type,strategy_code,strategy_runtime_version,
          fallback_strategy_code,exit_policy_mode)
       VALUES ($1,100,10,'2026-09-01','discretionary','discretionary',1,'portfolio_fallback_exit','fallback_only')`,
      [instrument.rows[0]!.id],
    );
    const evaluation = await ensureStrategyEvaluation(pool, {
      strategy_code: "portfolio_fallback_exit", phase: "exit", target_date: "2026-09-17",
    });
    expect(evaluation.execution).toBe("executed");
    expect(evaluation.run.status).toBe("partial");
    expect((await pool.query(
      "SELECT strategy_code,evaluation_role,action FROM strategy_position_evaluation WHERE run_id=$1",
      [evaluation.run.id],
    )).rows).toEqual([
      { strategy_code: "portfolio_fallback_exit", evaluation_role: "fallback", action: "hold" },
    ]);
  });
});
