import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { runMigrations } from "../../server/db/migrate.js";
import { queryDailyPlanStrategyContext } from "../../server/modules/strategy-runtime/daily-plan.js";
import { limitUpOpportunityItems } from "../../server/modules/strategy-runtime/limit-up-opportunities.js";
import { classifyIntradayLadderRole } from "../../server/modules/market/first-board-advance.js";
import { fetchBatchIsolated } from "../../server/datasource/batch-isolation.js";
import { validateDailyPlanWriteInput } from "../../server/agent/tool-validation.js";
import { prepareTestDb, resetSchema } from "./helpers.js";

const prepared = await prepareTestDb();

describe("收盘打板候选独立映射", () => {
  it("只从评估结果生成最多四条结构化候选，并保留缺口与风险", () => {
    const signals = Array.from({ length: 5 }, (_, i) => ({ code: `99000${i}.SZ`, name: `样本${i}`,
      signal_grade: i === 0 ? "A" : "B-抱团", main_theme: "题材", risk_flags: ["高位分歧"], missing_inputs: ["竞价待确认"] }));
    const evaluation = { strategy: { code: "limit_up", runtime_version: 3 },
      ensured: { run: { id: "42", status: "success", data_date: "2026-09-17", gaps: [] }, result: { signals } } };
    const items = limitUpOpportunityItems(evaluation as unknown as Parameters<typeof limitUpOpportunityItems>[0]);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ item_kind: "off_pool_opportunity", code: "990000.SZ", grade: "A",
      priority: 1, primary_evaluation_run_id: "42", strategy_code: "limit_up", risk_md: "高位分歧", missing_md: "竞价待确认" });
    expect(items[1]).toMatchObject({ grade: "B", priority: 2 });
    const empty = { ...evaluation, ensured: { ...evaluation.ensured, result: { signals: [] } } };
    expect(limitUpOpportunityItems(empty as unknown as Parameters<typeof limitUpOpportunityItems>[0])).toEqual([]);
  });
});

describe("盘中批量取数隔离", () => {
  it("批次中的一只标的失败时二分后只跳过该标的", async () => {
    const requested: string[][] = [];
    const result = await fetchBatchIsolated(["A", "BAD", "B"], async (codes) => {
      requested.push(codes);
      if (codes.includes("BAD")) throw new Error("源接口单标的异常");
      return codes.map((code) => ({ code }));
    });
    expect(result).toEqual({ rows: [{ code: "A" }, { code: "B" }], skipped: ["BAD"] });
    expect(requested.some((codes) => codes.length === 1 && codes[0] === "BAD")).toBe(true);
    let rateLimitCalls = 0;
    await expect(fetchBatchIsolated(["A", "B"], async () => {
      rateLimitCalls++;
      throw new Error("HTTP 429 throttled");
    })).rejects.toThrow("429");
    expect(rateLimitCalls).toBe(1); // 全局限流不能二分放大请求。
  });
});

describe("盘中涨停梯队角色", () => {
  it("区分高位核心、被带动首板和高位断板后的切换", () => {
    expect(classifyIntradayLadderRole({ streakCount: 4, themeMaxStreak: 4, themeTierCount: 3, brokenMaxStreak: 0 }))
      .toEqual({ role: "theme_leader", highBoardState: "active" });
    expect(classifyIntradayLadderRole({ streakCount: 1, themeMaxStreak: 2, themeTierCount: 2, brokenMaxStreak: 0 }))
      .toEqual({ role: "high_board_follower", highBoardState: "active" });
    expect(classifyIntradayLadderRole({ streakCount: 1, themeMaxStreak: 2, themeTierCount: 2, brokenMaxStreak: 4 }))
      .toEqual({ role: "leadership_switch", highBoardState: "leader_broken" });
  });
});

describe.skipIf(!prepared)("每日计划策略统一编排", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
  });

  afterAll(async () => pool.end());

  it("无持仓时不运行入场与打板扫描", async () => {
    const first = await queryDailyPlanStrategyContext(pool, { date: "2026-09-17" });
    expect(first.strategy_coverage).toMatchObject({
      expected_evaluations: 0,
      position_count: 0,
      attributed_position_count: 0,
      executed_evaluations: 0,
    });
    expect(first.required_strategy_documents).toEqual(expect.arrayContaining([
      "daily_plan_strategy",

    ]));
    expect(first.playbook_items).toEqual([]);
    const second = await queryDailyPlanStrategyContext(pool, { date: "2026-09-17" });
    expect(second.strategy_coverage.reused_evaluations).toBe(0);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM strategy_evaluation_run WHERE target_date='2026-09-17'",
    )).rows[0]!.count).toBe(0);
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
    const run = await pool.query<{ id: string }>(
      `INSERT INTO job_run(job_id,target_date,trigger_kind,status)
       SELECT id,'2026-09-17','manual','running' FROM job_definition WHERE code='daily_plan_flow'
       RETURNING id::text`,
    );
    const context = await queryDailyPlanStrategyContext(pool, {
      date: "2026-09-17", requested_by_job_run_id: run.rows[0]!.id,
    });
    expect(context.position_evaluations).toEqual([
      expect.objectContaining({
        code: "510120.SH", strategy_code: "discretionary", exit_policy_mode: "fallback_only",
        primary: null, fallback: expect.objectContaining({ evaluation_role: "fallback", action: "hold" }),
        effective_action: "observe", effective_source: "none", evaluation_status: "partial",
      }),
    ]);
    expect(context.strategy_coverage).toMatchObject({
      position_count: 1, attributed_position_count: 1, fallback_position_count: 1,
    });
    const items = validateDailyPlanWriteInput({ items: context.playbook_items }).items;
    expect(items).toEqual([
      expect.objectContaining({
        item_kind: "position_action", code: "510120.SH", action: "observe",
        strategy_code: "discretionary", fallback_action: "hold", effective_action: "observe",
        fallback_evaluation_run_id: expect.any(String),
      }),
    ]);
    expect(context.playbook_write).toEqual({ replaced: 1 });
    expect((await pool.query(
      `SELECT strategy_code,strategy_runtime_version,primary_action,fallback_action,effective_action,
              fallback_evaluation_run_id::text,evaluation_status,evaluation_missing
         FROM daily_plan_playbook WHERE source_job_run_id=$1`, [run.rows[0]!.id],
    )).rows[0]).toMatchObject({
      strategy_code: "discretionary", strategy_runtime_version: 1, primary_action: null,
      fallback_action: "hold", effective_action: "observe", fallback_evaluation_run_id: expect.any(String),
    });
  });

  it("一个持仓退出评估失败时仍完成其他持仓，异常仓位改为待复核", async () => {
    const inserted = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('600999.SH','缺数持仓','stock') RETURNING id::text",
    );
    await pool.query(`INSERT INTO portfolio_position
      (instrument_id,quantity,cost_price,opened_at,strategy_code,strategy_runtime_version,exit_policy_mode)
      VALUES ($1,100,10,'2026-09-01','two_year_reversal',1,'dedicated')`, [inserted.rows[0]!.id]);
    await pool.query("UPDATE strategy_definition SET exit_evaluator_code='unregistered_exit_v1' WHERE code='two_year_reversal'");
    try {
      const context = await queryDailyPlanStrategyContext(pool, { date: "2026-09-17" });
      expect(context.position_evaluations).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "510120.SH", effective_action: "observe", evaluation_status: "partial" }),
        expect.objectContaining({ code: "600999.SH", effective_action: "observe", evaluation_status: "partial",
          missing_items: expect.arrayContaining(["主策略退出评估不可用"]) }),
      ]));
      expect(context.gaps).toEqual(expect.arrayContaining([
        expect.objectContaining({ strategy_code: "two_year_reversal", phase: "exit" }),
      ]));
    } finally {
      await pool.query("UPDATE strategy_definition SET exit_evaluator_code='two_year_reversal_exit_v1' WHERE code='two_year_reversal'");
      await pool.query("DELETE FROM portfolio_position WHERE instrument_id=$1", [inserted.rows[0]!.id]);
      await pool.query("DELETE FROM market_instrument WHERE id=$1", [inserted.rows[0]!.id]);
    }
  });
});
