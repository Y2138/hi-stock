// 迁移运行器测试：幂等、篡改检测（设计契约 §10.1）
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { MigrationConflictError, runMigrations } from "../../server/db/migrate.js";
import { prepareTestDb, resetSchema } from "./helpers.js";

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("迁移运行器", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("连续执行两次幂等：第二次不重复应用", async () => {
    const first = await runMigrations(pool);
    expect(first.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56]);
    const second = await runMigrations(pool);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56]);
    // 表结构真实存在，0005 已按领域重命名非前缀表
    const tables = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect(tables.rows.map((r: { tablename: string }) => r.tablename)).toEqual([
      "agent_confirmation",
      "agent_evaluation_run",
      "agent_external_cli_run",
      "agent_memory_artifact",
      "agent_run_metric",
      "agent_setting",
      "agent_tool_audit",
      "agent_tool_metric",
      "analysis_run",
      "backtest_artifact",
      "backtest_run",
      "backtest_run_comparison",
      "backtest_run_source",
      "chat_attachment",
      "chat_message",
      "chat_session",
      "chat_session_event",
      "content_document",
      "content_legacy_import",
      "content_revision",
      "daily_plan_auction_assessment",
      "daily_plan_playbook",
      "data_dataset",
      "fundamental_snapshot",
      "hithink_dataset_snapshot",
      "job_definition",
      "job_prompt",
      "job_prompt_revision",
      "job_run",
      "job_run_output",
      "llm_model",
      "llm_provider",
      "llm_setting",
      "market_bar",
      "market_board",
      "market_board_membership",
      "market_dragon_tiger_entry",
      "market_fetch_run",
      "market_indicator_dirty",
      "market_indicator_run",
      "market_indicator_value",
      "market_instrument",
      "market_instrument_alias",
      "market_limit_event",
      "market_limit_ladder_snapshot",
      "market_special_sync_run",
      "market_system_tracking",
      "market_trading_day",
      "pool_board_preference",
      "pool_membership",
      "portfolio_account_snapshot",
      "portfolio_account_state",
      "portfolio_position",
      "portfolio_position_change",
      "portfolio_position_snapshot_daily",
      "portfolio_realized_pnl_baseline",
      "schema_migrations",
      "script_registry",
      "script_version",
      "strategy_doc",
      "strategy_document",
      "strategy_document_revision",
      "strategy_evolution_backtest",
      "strategy_evolution_log",
      "strategy_publish_proposal",
      "strategy_state",
      "strategy_version",
      "system_setting",
      "task_definition",
      "task_run",
      "valuation_snapshot",
      "volume_snapshot",
    ]);

    const session = await pool.query<{
      session_type: string;
      session_status: string;
      source: string;
    }>(
      `WITH s AS (
         INSERT INTO chat_session (title) VALUES ('迁移默认值') RETURNING id, session_type, session_status, source
       ), m AS (
         INSERT INTO chat_message (session_id, seq, role, content)
         SELECT id, 1, 'user', '{"role":"user","content":[]}'::jsonb FROM s
         RETURNING id
       )
       SELECT s.session_type, s.session_status, s.source FROM s CROSS JOIN m`,
    );
    expect(session.rows[0]).toEqual({
      session_type: "interactive",
      session_status: "idle",
      source: "user",
    });
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'pool_membership'
          AND column_name = 'primary_board_instrument_id'`,
    )).rows[0]!.count).toBe(0);
    const dailyPlan = (await pool.query<{ content: string }>(
      `SELECT revision.content
         FROM job_prompt prompt
         JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
        WHERE prompt.code = 'daily_plan_flow'`,
    )).rows[0]!.content;
    expect(dailyPlan).toContain("当前持仓读 `portfolio_position`，持仓变化读 `portfolio_position_change`");
    expect(dailyPlan).toContain("组合持仓结构和风险");
    expect(dailyPlan).not.toContain("当前持仓与账户读 `portfolio_*`");
    expect(dailyPlan).not.toContain("资金组合和风险");
    expect(dailyPlan).toContain("## 市场结构与打板机会");
    expect(dailyPlan).toContain("短线候选集合不得局限于当前短线池");
    expect(dailyPlan).toContain("## 打板机会最终输出口径");
    expect(dailyPlan).toContain("每日最多 4 只");
    expect(dailyPlan).not.toContain("市场结构池外机会");
    expect(dailyPlan).not.toContain("## 策略模拟账户信号");
    expect(dailyPlan).not.toContain("paper_trade_signal_write");
    expect(dailyPlan).toContain("## 执行纪律与预案结构化输出");
    expect(dailyPlan).not.toContain("0.2bp 即 0.002%");
    expect(dailyPlan).not.toContain("按本次计划需要，可参考");
    const auction = (await pool.query<{ code: string; cron: string; job_type: string; config: Record<string, unknown>; content: string }>(
      `SELECT definition.code, definition.cron, definition.job_type, definition.config, revision.content
         FROM job_definition definition
         JOIN job_prompt prompt ON prompt.id = definition.prompt_id
         JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
        WHERE definition.code = 'auction_opportunity_assessment'`,
    )).rows[0]!;
    expect(auction).toMatchObject({
      code: "auction_opportunity_assessment",
      cron: "30 9 * * 1-5",
      job_type: "agent_flow",
      config: {},
    });
    expect(auction.content).toContain("auction_short_term_benchmark");
    expect(auction.content).toContain("auction_snapshot");
    expect(auction.content).toContain("延续确认·换手晋级观察");
    expect(auction.content).toContain("不得对打板候选使用 `worth_entering`");
    expect(auction.content).toContain("精确信号等级、抱团分、主升分、两条路线名次");
    expect(auction.content).toContain("## 打板机会页面回写口径");
    expect(auction.content).not.toContain("今日池外机会");
    expect(auction.content).not.toContain("S 日一字");
    expect(auction.content).not.toContain("E 日候选");
    const retiredTables = await pool.query<{ name: string | null }>(
      `SELECT to_regclass(name)::text AS name
         FROM unnest(ARRAY[
           'strategy_paper_account', 'strategy_paper_position',
           'strategy_paper_signal', 'strategy_paper_trade'
         ]) AS name`,
    );
    expect(retiredTables.rows.every((row) => row.name === null)).toBe(true);
  });

  it("篡改已应用迁移文件后报错中止", async () => {
    // 在临时目录复制迁移文件，应用后篡改内容再跑一次
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-migrations-"));
    try {
      const srcDir = path.join(import.meta.dirname, "../../server/migrations");
      const sql = await fs.readFile(path.join(srcDir, "0001_init.sql"));
      const tmpFile = path.join(tmpDir, "0001_init.sql");
      await fs.writeFile(tmpFile, sql);

      await resetSchema(pool);
      const first = await runMigrations(pool, tmpDir);
      expect(first.applied).toEqual([1]);

      await fs.appendFile(tmpFile, "\n-- 篡改：新增一行注释\n");
      await expect(runMigrations(pool, tmpDir)).rejects.toBeInstanceOf(MigrationConflictError);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
