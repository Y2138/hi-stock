import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { runMigrations } from "../../server/db/migrate.js";
import { reconcileStrategyAttention } from "../../server/modules/strategy-runtime/attention.js";
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

  it("已移除的商品仓位策略不可再触发结构化评估", async () => {
    for (const code of ["copper_inventory", "lithium_warehouse"]) {
      await expect(ensureStrategyEvaluation(pool, { strategy_code: code, phase: "context", target_date: "2026-09-17" }))
        .rejects.toThrow("策略运行时不存在");
    }
  });

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

  it("策略信号自动入池时补齐已有五维画像", async () => {
    const instrument = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('990120.SZ','自动画像样本','stock') RETURNING id::text",
    );
    const indicator = await pool.query<{ id: string }>(
      `INSERT INTO market_indicator_run
         (instrument_id,freq,calculation_version,input_sha256,input_row_count,input_start_date,input_end_date,status,finished_at)
       VALUES ($1,'day','标的入池五维画像一版',$2,252,'2025-09-18','2026-09-18','success',now()) RETURNING id::text`,
      [instrument.rows[0]!.id, "1".repeat(64)],
    );
    await pool.query(
      `INSERT INTO market_stock_character_metric
         (instrument_id,as_of_date,calculation_version,indicator_run_id,input_row_count,defense_break_count,
          defense_recovered_count,stock_character_profile,stage,stock_character,tags)
       VALUES ($1,'2026-09-18','标的入池五维画像一版',$2,252,10,6,$3::jsonb,'调整','护盘中·波动高',$4::jsonb)`,
      [instrument.rows[0]!.id, indicator.rows[0]!.id, JSON.stringify({ dimensions: {} }), JSON.stringify(["阶段：调整"])],
    );
    const membership = await pool.query<{ id: string }>(
      `INSERT INTO pool_membership(instrument_id,pool,role,tags,stage,evaluation_summary,effective_from)
       VALUES ($1,'watch','关注','["策略自动关注"]'::jsonb,'策略信号','旧自动关注','2026-09-18') RETURNING id::text`,
      [instrument.rows[0]!.id],
    );
    const run = await pool.query<{ id: string }>(
      `INSERT INTO strategy_evaluation_run
         (strategy_code,phase,target_date,data_date,evaluator_code,evaluator_version,strategy_runtime_version,
          strategy_snapshot_hash,input_fingerprint,status,coverage,gaps,started_at,finished_at,result)
       VALUES ('two_year_reversal','entry','2026-09-18','2026-09-18','two_year_reversal_entry_v1',1,1,
               $1,$2,'success','{}'::jsonb,'[]'::jsonb,now(),now(),'{}'::jsonb) RETURNING id::text`,
      ["2".repeat(64), "3".repeat(64)],
    );
    await pool.query(
      `INSERT INTO strategy_entry_signal
         (run_id,strategy_code,instrument_id,signal_status,reason,missing_signals,valid_from)
       VALUES ($1,'two_year_reversal',$2,'approaching','接近候选','["尚缺确认"]'::jsonb,'2026-09-18')`,
      [run.rows[0]!.id, instrument.rows[0]!.id],
    );
    await reconcileStrategyAttention(pool, {
      source_job: "daily_plan_flow",
      run: {
        id: run.rows[0]!.id, strategy_code: "two_year_reversal", phase: "entry", target_date: "2026-09-18",
        data_date: "2026-09-18", evaluator_code: "two_year_reversal_entry_v1", evaluator_version: 1,
        strategy_runtime_version: 1, strategy_snapshot_hash: "2".repeat(64), input_fingerprint: "3".repeat(64),
        status: "success", requested_by_job_run_id: null, reused_from_run_id: null, coverage: {}, gaps: [],
        started_at: null, finished_at: null, created_at: new Date().toISOString(), result: {},
        attempt_count: 1, last_requested_at: new Date().toISOString(),
      },
    });
    expect((await pool.query(
      `SELECT id::text,stock_character,stage,profile_as_of::text,profile_calculation_version,profile_input_sha256,tags
         FROM pool_membership WHERE instrument_id=$1 AND effective_to IS NULL`,
      [instrument.rows[0]!.id],
    )).rows[0]).toEqual({
      id: membership.rows[0]!.id,
      stock_character: "护盘中·波动高",
      stage: "调整",
      profile_as_of: "2026-09-18",
      profile_calculation_version: "标的入池五维画像一版",
      profile_input_sha256: "1".repeat(64),
      tags: ["阶段：调整", "策略自动关注"],
    });
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
