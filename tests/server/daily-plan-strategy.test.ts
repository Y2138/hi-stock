import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { runMigrations } from "../../server/db/migrate.js";
import { queryDailyPlanStrategyContext } from "../../server/modules/strategy-runtime/daily-plan.js";
import { replaceDraftPlaybook } from "../../server/modules/plans/repo.js";
import { validateDailyPlanWriteInput } from "../../server/agent/tool-validation.js";
import { prepareTestDb, resetSchema } from "./helpers.js";

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("每日计划策略统一编排", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
  });

  afterAll(async () => pool.end());

  it("自动发现入场、观察与组合策略并复用评估运行", async () => {
    const first = await queryDailyPlanStrategyContext(pool, { date: "2026-09-17" });
    expect(first.strategy_coverage).toMatchObject({
      expected_evaluations: 2,
      position_count: 0,
      attributed_position_count: 0,
      executed_evaluations: 2,
    });
    expect(first.required_strategy_documents).toEqual(expect.arrayContaining([
      "daily_plan_strategy", "two_year_reversal_strategy", "limit_up_board",

    ]));
    expect(first.playbook_items).toEqual([]);
    const second = await queryDailyPlanStrategyContext(pool, { date: "2026-09-17" });
    expect(second.strategy_coverage.reused_evaluations).toBeGreaterThanOrEqual(1);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM strategy_evaluation_run WHERE target_date='2026-09-17'",
    )).rows[0]!.count).toBeGreaterThanOrEqual(2);
  });

  it("持仓自动调用兜底策略并生成可原样写入的结构化预案", async () => {
    const instrument = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('510120.SH','统筹持仓样本','etf') RETURNING id::text",
    );
    await pool.query(
      `INSERT INTO portfolio_position
         (instrument_id,quantity,cost_price,opened_at,entry_signal_type,strategy_code,strategy_runtime_version,
          fallback_strategy_code,exit_policy_mode)
       VALUES ($1,100,10,'2026-09-01','discretionary','discretionary',1,'portfolio_fallback_exit','fallback_only')`,
      [instrument.rows[0]!.id],
    );
    const context = await queryDailyPlanStrategyContext(pool, { date: "2026-09-17" });
    expect(context.position_evaluations).toEqual([
      expect.objectContaining({
        code: "510120.SH", strategy_code: "discretionary", exit_policy_mode: "fallback_only",
        primary: null, fallback: expect.objectContaining({ evaluation_role: "fallback", action: "hold" }),
        effective_action: "hold", effective_source: "fallback",
      }),
    ]);
    expect(context.strategy_coverage).toMatchObject({
      position_count: 1, attributed_position_count: 1, fallback_position_count: 1,
    });
    const items = validateDailyPlanWriteInput({ items: context.playbook_items }).items;
    expect(items).toEqual([
      expect.objectContaining({
        item_kind: "position_action", code: "510120.SH", action: "hold",
        strategy_code: "discretionary", fallback_action: "hold", effective_action: "hold",
        fallback_evaluation_run_id: expect.any(String),
      }),
    ]);
    const run = await pool.query<{ id: string }>(
      `INSERT INTO job_run(job_id,target_date,trigger_kind,status)
       SELECT id,'2026-09-17','manual','running' FROM job_definition WHERE code='daily_plan_flow'
       RETURNING id::text`,
    );
    await expect(replaceDraftPlaybook(pool, { source_job_run_id: run.rows[0]!.id, items })).resolves.toEqual({ replaced: 1 });
    expect((await pool.query(
      `SELECT strategy_code,strategy_runtime_version,primary_action,fallback_action,effective_action,
              fallback_evaluation_run_id::text,evaluation_status,evaluation_missing
         FROM daily_plan_playbook WHERE source_job_run_id=$1`, [run.rows[0]!.id],
    )).rows[0]).toMatchObject({
      strategy_code: "discretionary", strategy_runtime_version: 1, primary_action: null,
      fallback_action: "hold", effective_action: "hold", fallback_evaluation_run_id: expect.any(String),
    });
  });
});
