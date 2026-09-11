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
    expect(first.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89]);
    const second = await runMigrations(pool);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89]);
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
      "market_stock_character_metric",
      "market_system_tracking",
      "market_trading_day",
      "notification_delivery",
      "notification_setting",
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
      "strategy_evolution_backtest",
      "strategy_evolution_log",
      "strategy_publish_proposal",
      "strategy_score_benchmark",
      "strategy_state",
      "strategy_version",
      "system_setting",
      "task_definition",
      "task_run",
      "valuation_snapshot",
      "volume_snapshot",
    ]);
    const undocumented = await pool.query<{ object_name: string }>(
      `SELECT current_database() AS object_name
         WHERE NULLIF(btrim(shobj_description(
           (SELECT oid FROM pg_database WHERE datname = current_database()),
           'pg_database'
         )), '') IS NULL
       UNION ALL
       SELECT relation.relname
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p')
          AND NULLIF(btrim(obj_description(relation.oid, 'pg_class')), '') IS NULL
       UNION ALL
       SELECT relation.relname || '.' || attribute.attname
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         JOIN pg_attribute attribute
           ON attribute.attrelid = relation.oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p')
          AND NULLIF(btrim(col_description(relation.oid, attribute.attnum)), '') IS NULL`,
    );
    expect(undocumented.rows).toEqual([]);

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
    const prompts = await pool.query<{ code: string; content: string }>(
      `SELECT prompt.code, revision.content
         FROM job_prompt prompt
         JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
        WHERE prompt.code IN ('daily_plan_flow', 'midweek_check', 'weekly_review', 'nightly_sector_opportunity_scan')
        ORDER BY prompt.code`,
    );
    const promptByCode = new Map(prompts.rows.map((row) => [row.code, row.content]));
    const dailyPlan = promptByCode.get("daily_plan_flow")!;
    expect(dailyPlan).toContain("用 `tool_catalog` 一次加载");
    expect(dailyPlan).toContain("daily_plan_context_query(date=目标日)");
    expect(dailyPlan).toContain("swing_signal_query(date=目标日)");
    expect(dailyPlan).toContain("limit_up_signal_query(date=实际市场结构数据日)");
    expect(dailyPlan).toContain("每日最多 4 只");
    expect(dailyPlan).toContain("右侧 > 左侧 > 试盘");
    expect(dailyPlan).toContain("当日无新增波段信号");
    expect(dailyPlan).toContain("无候选也提交空数组");
    expect(dailyPlan).toContain("不得加入持仓、池外标的或覆盖人工关注");
    expect(dailyPlan).toContain("全部 `position_action`");
    expect(dailyPlan).toContain("系统保存到 `job_run_output`");
    expect(dailyPlan).toContain("## 预案文案纪律");
    expect(dailyPlan).toContain("只写可观测且该持仓特有的改判条件");
    expect(dailyPlan).toContain("停牌、跌停无法成交属于必然情形");
    expect(dailyPlan).toContain("没有当日新增信息的字段直接省略");
    expect(dailyPlan.length).toBeLessThan(4_000);
    expect(dailyPlan).not.toContain("本节替代前文");
    expect(dailyPlan).not.toContain("database_schema");
    expect(dailyPlan).not.toContain("database_query");
    expect(dailyPlan).not.toContain("## 策略模拟账户信号");
    expect(dailyPlan).not.toContain("paper_trade_signal_write");
    expect(dailyPlan).not.toContain("预期校对");
    const midweek = promptByCode.get("midweek_check")!;
    expect(midweek).toContain("pool_context_query(pools=[\"short\"])");
    expect(midweek).toContain("daily_plan_context_query(date=目标日)");
    expect(midweek).toContain("最近一份成功的 `job_run_output`");
    expect(midweek.length).toBeLessThan(1_200);
    expect(midweek).not.toContain("indicator_query");
    expect(midweek).not.toContain("database_query");
    const weekly = promptByCode.get("weekly_review")!;
    expect(weekly).toContain("portfolio_context_query");
    expect(weekly).toContain("swing_signal_query(date=目标日)");
    expect(weekly).toContain("analysis_run(long_valuation)");
    expect(weekly.length).toBeLessThan(1_200);
    expect(weekly).not.toContain("database_query");
    const nightly = promptByCode.get("nightly_sector_opportunity_scan")!;
    expect(nightly).toContain('"analysis_type":"sector_temperature"');
    expect(nightly).toContain("不得传 `codes`");
    expect(nightly).toContain("1–3 个板块");
    expect(nightly).toContain("每个板块最多保留 2 只标的");
    expect(nightly).toContain("## 结论摘要");
    expect(nightly).toContain("不超过 600 个中文字符");
    expect(nightly.length).toBeLessThan(4_000);
    expect(prompts.rows.every((row) => !row.content.includes("本节替代前文"))).toBe(true);
    expect(prompts.rows.every((row) => !row.content.includes("数据获取规范"))).toBe(true);
    const benchmark = (await pool.query<{
      benchmark_code: string;
      training_start: string;
      training_end: string;
      seal_samples: number;
      sha256: string;
    }>(
      `SELECT benchmark.benchmark_code, benchmark.training_start::text, benchmark.training_end::text,
              (benchmark.sample_counts ->> 'seal_turnover_ratio')::int AS seal_samples, benchmark.sha256
         FROM strategy_score_benchmark benchmark
         JOIN strategy_document document
           ON document.id = benchmark.document_id
        WHERE document.code = 'limit_up_board'`,
    )).rows[0]!;
    expect(benchmark).toEqual({
      benchmark_code: "daban_v1_4_fixed_20250901_20260122",
      training_start: "2025-09-01",
      training_end: "2026-01-22",
      seal_samples: 5177,
      sha256: "b3a53d2308bf56e977fd5a89c7f2305b32db352ac760521e9988bfc2a34de3f1",
    });
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
    expect(auction.content).toContain("tool_catalog");
    expect(auction.content).toContain("auction_context_query");
    expect(auction.content).toContain("signal_passed");
    expect(auction.content).not.toContain("本节替代前文");
    expect(auction.content).not.toContain("worth_entering");
    expect(auction.content).not.toContain("## 交易日历缺行降级口径");
    expect(auction.content.length).toBeLessThan(4_000);
    expect(auction.content).not.toContain("今日池外机会");
    expect(auction.content).not.toContain("S 日一字");
    expect(auction.content).not.toContain("E 日候选");
    const nightlyJob = (await pool.query<{
      code: string;
      cron: string;
      model_key: string;
      provider_key: string;
      context_window: number;
      max_tokens: number;
    }>(
      `SELECT definition.code, definition.cron, model.model_key, provider.provider_key,
              model.context_window, model.max_tokens
         FROM job_definition definition
         JOIN llm_model model ON model.id = definition.model_id
         JOIN llm_provider provider ON provider.id = model.provider_id
        WHERE definition.code = 'nightly_sector_opportunity_scan'`,
    )).rows[0]!;
    expect(nightlyJob).toEqual({
      code: "nightly_sector_opportunity_scan",
      cron: "0 23 * * 1-5",
      model_key: "deepseek-v4-pro",
      provider_key: "deepseek",
      context_window: 1_000_000,
      max_tokens: 128_000,
    });
    const retiredTables = await pool.query<{ name: string | null }>(
      `SELECT to_regclass(name)::text AS name
         FROM unnest(ARRAY[
           'strategy_paper_account', 'strategy_paper_position',
           'strategy_paper_signal', 'strategy_paper_trade'
         ]) AS name`,
    );
    expect(retiredTables.rows.every((row) => row.name === null)).toBe(true);
  });

  it("近期关注迁移保留历史状态，不猜测缺口或人工关注信号", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE pool_membership DROP COLUMN attention_signal");
      for (const [code, reason] of [
        ["990081.SZ", "每日计划·已符合：已确认"],
        ["990082.SZ", "每日计划·即将符合：等待放量"],
        ["990083.SZ", "人工持续跟踪"],
      ]) {
        await client.query("INSERT INTO market_instrument (code, name, kind) VALUES ($1, '迁移测试标的', 'stock')", [code]);
        await client.query(
          `INSERT INTO pool_membership (instrument_id, pool, role, effective_from, attention_reason)
           SELECT id, 'short', '短线', '2026-09-09', $2 FROM market_instrument WHERE code = $1`, [code, reason],
        );
      }
      const sql = await fs.readFile(path.join(import.meta.dirname, "../../server/migrations/0084_近期关注信号状态与缺口.sql"), "utf8");
      await client.query(sql);
      expect((await client.query(
        `SELECT instrument.code, membership.attention_signal
         FROM pool_membership membership JOIN market_instrument instrument ON instrument.id = membership.instrument_id
         WHERE instrument.code IN ('990081.SZ', '990082.SZ', '990083.SZ') ORDER BY instrument.code`,
      )).rows).toEqual([
        { code: "990081.SZ", attention_signal: { status: "qualified", missing_signals: [] } },
        { code: "990082.SZ", attention_signal: { status: "approaching", missing_signals: [] } },
        { code: "990083.SZ", attention_signal: null },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
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
