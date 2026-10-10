// 迁移运行器测试：幂等、篡改检测（设计契约 §10.1）
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { MigrationConflictError, runMigrations, loadMigrations } from "../../server/db/migrate.js";
import { prepareTestDb, resetSchema } from "./helpers.js";

const migrationVersions = (await loadMigrations(path.join(import.meta.dirname,"../../server/migrations"))).map(row=>row.version);
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
    expect(first.applied).toEqual(migrationVersions);
    const second = await runMigrations(pool);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(migrationVersions);
    // 表结构真实存在，0005 已按领域重命名非前缀表
    const tables = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect(tables.rows.map((r: { tablename: string }) => r.tablename)).toEqual([
      "agent_confirmation",
      "agent_memory_artifact",
      "agent_run_metric",
      "agent_setting",
      "agent_tool_audit",
      "agent_tool_metric",
      "analysis_run",
      "auction_scope_assessment",
      "chat_attachment",
      "chat_message",
      "chat_session",
      "chat_session_event",
      "company_commodity_metric",
      "company_commodity_profile",
      "daily_plan_auction_assessment",
      "daily_plan_market_context",
      "daily_plan_playbook",
      "daily_plan_scenario",      "first_board_intraday_snapshot",
      "fundamental_snapshot",
      "hithink_dataset_snapshot",
      "intraday_market_sample",
      "intraday_position_risk",
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
      "market_corporate_action",
      "market_corporate_action_sync_state",
      "market_dragon_tiger_entry",
      "market_factor_observation",
      "market_factor_series",
      "market_fetch_run",
      "market_futures_contract",
      "market_futures_daily_detail",
      "market_futures_roll",
      "market_indicator_dirty",
      "market_indicator_run",
      "market_indicator_value",
      "market_instrument",
      "market_instrument_alias",
      "market_limit_event",
      "market_limit_ladder_snapshot",
      "market_news_item",
      "market_news_item_instrument",
      "market_news_snapshot",
      "market_special_sync_run",
      "market_stock_character_metric",
      "market_trading_day",
      "notification_delivery",
      "notification_setting",
      "pool_attention_entry",
      "pool_board_preference",
      "pool_membership",
      "portfolio_account",
      "portfolio_account_state",
      "portfolio_equity_daily",
      "portfolio_position",
      "portfolio_position_change",
      "portfolio_realized_pnl_baseline",
      "schema_migrations",
      "strategy_definition",
      "strategy_document",
      "strategy_entry_signal",
      "strategy_evaluation_run",
      "strategy_position_evaluation",
      "strategy_score_benchmark",
      "strategy_state",
      "system_setting",
      "valuation_snapshot",
      "value_rank_snapshot",
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

    const ladder = await pool.query<{ content: string }>(
      "SELECT content FROM strategy_document WHERE code='first_board_advance_strategy'",
    );
    expect(ladder.rows[0]?.content).toContain("一字板、10:30后至扫描时间封板的标的均不作硬排除");
    expect(ladder.rows[0]?.content).not.toContain("排除09:25后仍未打开的一字板");
    expect(ladder.rows[0]?.content).toContain("## 唯一首选排队标的");

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
        WHERE prompt.code IN ('daily_plan_flow', 'nightly_sector_opportunity_scan')
        ORDER BY prompt.code`,
    );
    const promptByCode = new Map(prompts.rows.map((row) => [row.code, row.content]));
    const dailyPlan = promptByCode.get("daily_plan_flow")!;
    expect(dailyPlan).toContain("daily_plan_strategy_query(date=目标日)");
    expect(dailyPlan).toContain("只负责持仓");
    expect(dailyPlan).toContain("playbook_write.replaced");
    expect(dailyPlan).toContain("不得调用 `daily_plan_write`");
    expect(dailyPlan).toContain("不扫描或推荐新的策略机会");
    expect(dailyPlan).toContain("专属与兜底退出评估");
    expect(dailyPlan).toContain("daily_plan_scenario_write");
    expect(dailyPlan).toContain("不以冷却期、止盈核对期等为由拒绝给点位");
    expect(dailyPlan).toContain("板块当日排行");
    // 0155：任务移至盘前消息面之后，情景与开盘预案结合当日快照。
    expect(dailyPlan).toContain("盘前消息面");
    expect(dailyPlan).toContain("当日开盘预案");
    expect((await pool.query<{ cron: string }>(
      "SELECT cron FROM job_definition WHERE code='daily_plan_flow'",
    )).rows[0]!.cron).toBe("5 9 * * 1-5");
    const dailyStrategy = (await pool.query<{ content: string }>(
      "SELECT content FROM strategy_document WHERE code='daily_plan_strategy'",
    )).rows[0]!.content;
    expect(dailyStrategy).toContain("MACD柱由正转负且收盘跌破MA10");
    expect(dailyStrategy).toContain("初始止损取");
    expect(dailyStrategy).not.toContain("## 五、打板观察");
    expect(dailyStrategy).toContain("不依赖持仓的初始策略归因");
    expect(dailyStrategy).toContain("不免除点位输出");
    expect(dailyStrategy).toContain("当日盘前消息面");
    expect(dailyPlan).toContain("个人消息");
    expect(dailyPlan).not.toContain("daily_plan_context_query(date=目标日)");
    expect(dailyPlan).not.toContain("pool_attention_write");
    expect(dailyPlan.length).toBeLessThan(4_000);
    expect(dailyPlan).not.toContain("本节替代前文");
    expect(dailyPlan).not.toContain("database_schema");
    expect(dailyPlan).not.toContain("database_query");
    expect(dailyPlan).not.toContain("## 策略模拟账户信号");
    expect(dailyPlan).not.toContain("paper_trade_signal_write");
    expect(dailyPlan).not.toContain("预期校对");
    const retiredJobs = await pool.query<{ code: string }>(
      `SELECT code FROM job_definition
        WHERE code IN ('weekly_review', 'midweek_check', 'left_reversal_opportunity_scan')`,
    );
    expect(retiredJobs.rows).toEqual([]);
    const nightly = promptByCode.get("nightly_sector_opportunity_scan")!;
    expect(nightly).toContain('"analysis_type":"sector_trend_structure"');
    expect(nightly).toContain("不得传 `codes`");
    expect(nightly).toContain("每个板块最多保留 2 只个股");
    expect(nightly).toContain("止跌修复确认");
    expect(nightly).toContain("自动初始化到关注池");
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
      cron: "26 9 * * 1-5",
      job_type: "agent_flow",
      config: {},
    });
    expect(auction.content).toContain("auction_short_term_benchmark");
    expect(auction.content).toContain("auction_snapshot");
    expect(auction.content).toContain("limit_up_close_scan");
    expect(auction.content).toContain("auction_context_query");
    expect(auction.content).toContain("前一开市日收盘打板独立任务");
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
    const leftPromptGone = (await pool.query<{ code: string }>(
      `SELECT code FROM job_prompt WHERE code='left_reversal_opportunity_scan'`,
    )).rows[0];
    expect(leftPromptGone).toBeUndefined();
    const retiredTables = await pool.query<{ name: string | null }>(
      `SELECT to_regclass(name)::text AS name
         FROM unnest(ARRAY[
           'strategy_paper_account', 'strategy_paper_position',
           'strategy_paper_signal', 'strategy_paper_trade'
         ]) AS name`,
    );
    expect(retiredTables.rows.every((row) => row.name === null)).toBe(true);
  }, 15_000);

  it("策略运行时约束固定策略、任务角色和评估结果归属", async () => {
    const definitions = await pool.query<{ code: string }>("SELECT code FROM strategy_definition ORDER BY code");
    expect(definitions.rows.map((row) => row.code)).toEqual(expect.arrayContaining([
      "swing", "two_year_reversal", "legacy_right_side", "portfolio_fallback_exit",
    ]));
    await pool.query("BEGIN");
    try {
      await expect(pool.query(
        "UPDATE strategy_definition SET fallback_strategy_code = code WHERE code = 'legacy_right_side'",
      )).rejects.toThrow();
      await pool.query("ROLLBACK");
      await pool.query("BEGIN");
      await expect(pool.query(
        "UPDATE job_definition SET strategy_code = 'swing' WHERE code = 'daily_plan_flow'",
      )).rejects.toThrow();
      await pool.query("ROLLBACK");
      await pool.query("BEGIN");
      const instrument = await pool.query<{ id: string }>(
        "INSERT INTO market_instrument (code, name, kind) VALUES ('999116.SZ', '运行时约束样本', 'stock') RETURNING id::text",
      );
      const run = await pool.query<{ id: string }>(
        `INSERT INTO strategy_evaluation_run
           (strategy_code, phase, target_date, evaluator_code, evaluator_version,
            strategy_runtime_version, strategy_snapshot_hash, input_fingerprint, status)
         VALUES ('swing', 'entry', '2026-09-17', 'swing_entry_v1', 1, 1, $1, $2, 'success')
         RETURNING id::text`,
        ["0".repeat(64), "1".repeat(64)],
      );
      await expect(pool.query(
        `INSERT INTO strategy_entry_signal
           (run_id, strategy_code, instrument_id, signal_status, reason, valid_from)
         VALUES ($1, 'two_year_reversal', $2, 'qualified', '策略归属不一致', '2026-09-17')`,
        [run.rows[0]!.id, instrument.rows[0]!.id],
      )).rejects.toThrow();
    } finally {
      await pool.query("ROLLBACK");
    }
  });

  it("关注条目按策略唯一：approaching 必须携带缺口，人工来源独立", async () => {
    await pool.query("INSERT INTO market_instrument (code, name, kind) VALUES ('990081.SZ', '条目测试标的', 'stock')");
    const id = (await pool.query<{ id: string }>("SELECT id::text FROM market_instrument WHERE code = '990081.SZ'")).rows[0]!.id;
    await pool.query(
      `INSERT INTO pool_membership (instrument_id, pool, role, effective_from) VALUES ($1, 'watch', '关注', '2026-09-09')`, [id],
    );
    await expect(pool.query(
      `INSERT INTO pool_attention_entry (instrument_id, source_type, strategy_code, source_job, status, reason, missing_signals, valid_from)
       VALUES ($1, 'strategy', 'swing', 'daily_plan_flow', 'approaching', '等待确认', '[]'::jsonb, '2026-09-09')`, [id],
    )).rejects.toThrow(/check|missing_signals/i);
    await pool.query(
      `INSERT INTO pool_attention_entry (instrument_id, source_type, strategy_code, source_job, status, reason, missing_signals, valid_from)
       VALUES ($1, 'strategy', 'swing', 'daily_plan_flow', 'approaching', '等待确认', '["波段：缩量确认"]'::jsonb, '2026-09-09')`, [id],
    );
    await expect(pool.query(
      `INSERT INTO pool_attention_entry (instrument_id, source_type, strategy_code, source_job, status, reason, missing_signals, valid_from)
       VALUES ($1, 'strategy', 'swing', 'nightly_sector_opportunity_scan', 'qualified', '重复策略来源', '[]'::jsonb, '2026-09-09')`, [id],
    )).rejects.toThrow(/unique|duplicate/i);
    await pool.query(
      `INSERT INTO pool_attention_entry (instrument_id, source_type, strategy_code, source_job, status, reason, missing_signals, valid_from)
       VALUES ($1, 'manual', NULL, 'manual', 'manual', '人工关注', '[]'::jsonb, '2026-09-09')`, [id],
    );
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM pool_attention_entry WHERE instrument_id = $1", [id],
    )).rows[0]!.count).toBe(2);
  });

  it("清理无来源关注池成员并删除废弃表", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-cleanup-migrations-"));
    try {
      const sourceDir = path.join(import.meta.dirname, "../../server/migrations");
      const files = (await fs.readdir(sourceDir)).filter((file) => /^\d{4}_.+\.sql$/.test(file));
      for (const file of files.filter((file) => Number(file.slice(0, 4)) <= 112)) {
        await fs.copyFile(path.join(sourceDir, file), path.join(tmpDir, file));
      }
      await resetSchema(pool);
      await runMigrations(pool, tmpDir);
      await pool.query(
        `INSERT INTO market_instrument (code, name, kind) VALUES
          ('990091.SZ', '有来源标的', 'stock'),
          ('990092.SZ', '无来源标的', 'stock'),
          ('990093.SZ', '过期来源标的', 'stock')`,
      );
      await pool.query(
        `INSERT INTO pool_membership (instrument_id, pool, role, effective_from)
         SELECT id, 'watch', '关注', CURRENT_DATE FROM market_instrument WHERE code LIKE '99009_.SZ'`,
      );
      await pool.query(
        `INSERT INTO pool_attention_entry
          (instrument_id, source_job, status, reason, missing_signals, valid_from, valid_until)
         SELECT id, 'daily_plan_flow', 'qualified', '当前有效来源', '[]'::jsonb, CURRENT_DATE, CURRENT_DATE
           FROM market_instrument WHERE code = '990091.SZ'`,
      );
      await pool.query(
        `INSERT INTO pool_attention_entry
          (instrument_id, source_job, status, reason, missing_signals, valid_from, valid_until)
         SELECT id, 'daily_plan_flow', 'qualified', '已过期来源', '[]'::jsonb,
                CURRENT_DATE - 2, CURRENT_DATE - 1
           FROM market_instrument WHERE code = '990093.SZ'`,
      );

      const cleanupFile = files.find((file) => file.startsWith('0113_'))!;
      await fs.copyFile(path.join(sourceDir, cleanupFile), path.join(tmpDir, cleanupFile));
      expect((await runMigrations(pool, tmpDir)).applied).toEqual([113]);
      expect((await pool.query<{ code: string }>(
        `SELECT instrument.code FROM pool_membership membership
           JOIN market_instrument instrument ON instrument.id = membership.instrument_id
          ORDER BY instrument.code`,
      )).rows).toEqual([{ code: '990091.SZ' }]);
      const removed = await pool.query<{ name: string | null }>(
        `SELECT to_regclass(name)::text AS name FROM unnest(ARRAY[
          'agent_evaluation_run','agent_external_cli_run','content_document','content_legacy_import',
          'content_revision','market_system_tracking','portfolio_account_snapshot',
          'portfolio_position_snapshot_daily','script_registry','script_version','strategy_doc',
          'strategy_version','task_definition','task_run'
        ]) AS name`,
      );
      expect(removed.rows.every((row) => row.name === null)).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("存量持仓买入预案前滚后保留历史动作", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-legacy-playbook-"));
    try {
      const sourceDir = path.join(import.meta.dirname, "../../server/migrations");
      const files = (await fs.readdir(sourceDir)).filter((file) => /^\d{4}_.+\.sql$/.test(file));
      for (const file of files.filter((file) => Number(file.slice(0, 4)) <= 119)) {
        await fs.copyFile(path.join(sourceDir, file), path.join(tmpDir, file));
      }
      await resetSchema(pool);
      await runMigrations(pool, tmpDir);
      await pool.query("INSERT INTO market_instrument (code,name,kind) VALUES ('990099.SZ','存量买入预案','stock')");
      const run = await pool.query<{ id: string }>(
        `INSERT INTO job_run (job_id,target_date,trigger_kind)
         SELECT id,'2026-09-16','manual' FROM job_definition WHERE code='daily_plan_flow' RETURNING id::text`,
      );
      await pool.query(
        `INSERT INTO daily_plan_playbook (source_job_run_id,target_date,item_kind,instrument_id,code,name,action,trigger_kind,headline)
         SELECT $1,'2026-09-16','position_action',id,code,name,'buy','condition','历史增仓预案'
           FROM market_instrument WHERE code='990099.SZ'`, [run.rows[0]!.id],
      );
      for (const file of files.filter((file) => Number(file.slice(0, 4)) >= 120)) {
        await fs.copyFile(path.join(sourceDir, file), path.join(tmpDir, file));
      }
      expect((await runMigrations(pool, tmpDir)).applied).toEqual(migrationVersions.filter((version) => version >= 120));
      expect((await pool.query<{ action: string; effective_action: string; strategy_code: string | null }>(
        "SELECT action,effective_action,strategy_code FROM daily_plan_playbook WHERE code='990099.SZ'",
      )).rows).toEqual([{ action: "buy", effective_action: "buy", strategy_code: null }]);
      expect((await pool.query<{ content: string }>(
        "SELECT content FROM strategy_document WHERE code='swing_strategy'",
      )).rows[0]!.content).toContain("3. RSI14 < 30；");
      expect((await pool.query<{ content: string }>(
        "SELECT content FROM strategy_document WHERE code='swing_strategy'",
      )).rows[0]!.content).toContain("深度评分 0-5 分");
      expect((await pool.query<{ content: string }>(
        "SELECT content FROM strategy_document WHERE code='swing_strategy'",
      )).rows[0]!.content).toContain("1. 成交量 < 5 日均量 × 0.70；相对 MA250 偏离 ≤ -35% 的深度标的豁免缩量要求；");
      expect((await pool.query<{ content: string }>(
        "SELECT content FROM strategy_document WHERE code='swing_strategy'",
      )).rows[0]!.content).toContain("仅列为行业逆风复核；行业动量缺数时不降级");
      expect((await pool.query<{ content: string }>(
        `SELECT revision.content FROM job_prompt prompt
           JOIN job_prompt_revision revision ON revision.id=prompt.current_revision_id
          WHERE prompt.code='swing_signal_scan'`,
      )).rows[0]!.content).toContain("深度评分构成（MA250 偏离、60 日跌幅、行业 20 日动量）");
      expect((await pool.query<{ content: string }>(
        `SELECT revision.content FROM job_prompt prompt
           JOIN job_prompt_revision revision ON revision.id=prompt.current_revision_id
          WHERE prompt.code='swing_signal_scan'`,
      )).rows[0]!.content).toContain("行业逆风降级复核标的");
      expect((await pool.query<{ column_default: string | null; is_nullable: string }>(
        "SELECT column_default,is_nullable FROM information_schema.columns WHERE table_name='pool_membership' AND column_name='special_attention'",
      )).rows[0]).toEqual({ column_default: "false", is_nullable: "NO" });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
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
  it("存量单账户持仓、事件、资金基线和任务会话无损归入默认账户", async () => {
    const srcDir=path.join(import.meta.dirname,"../../server/migrations");
    const tmpDir=await fs.mkdtemp(path.join(import.meta.dirname,".账户迁移-"));
    try {
      const migrations=await loadMigrations(srcDir);
      for (const migration of migrations.filter(row=>row.version<164)) {
        await fs.copyFile(migration.filePath,path.join(tmpDir,path.basename(migration.filePath)));
      }
      await resetSchema(pool);
      await runMigrations(pool,tmpDir);
      const instrument=(await pool.query<{id:string}>(`INSERT INTO market_instrument(code,name,kind)
        VALUES('990997.SZ','存量账户样本','stock') RETURNING id::text`)).rows[0]!.id;
      await pool.query("INSERT INTO portfolio_position(instrument_id,quantity,cost_price,opened_at) VALUES($1,123,45.67,'2026-09-28')",[instrument]);
      await pool.query("INSERT INTO portfolio_position_change(instrument_id,change_date,kind,quantity,price,source) VALUES($1,'2026-09-28','buy',123,45.67,'ingest')",[instrument]);
      const session=(await pool.query<{id:string}>("INSERT INTO chat_session(title,session_type) VALUES('存量计划','job') RETURNING id::text")).rows[0]!.id;
      await pool.query("INSERT INTO job_run(job_id,target_date,trigger_kind,session_id) SELECT id,'2026-09-29','manual',$1 FROM job_definition WHERE code='daily_plan_flow'",[session]);
      await pool.query("UPDATE portfolio_realized_pnl_baseline SET amount=888");
      expect((await runMigrations(pool)).applied).toContain(164);
      expect((await pool.query("SELECT account_id::text,quantity::int,cost_price::float FROM portfolio_position")).rows).toEqual([{account_id:"1",quantity:123,cost_price:45.67}]);
      expect((await pool.query("SELECT account_id::text FROM portfolio_position_change")).rows).toEqual([{account_id:"1"}]);
      expect((await pool.query("SELECT account_id::text,amount::int FROM portfolio_realized_pnl_baseline")).rows).toEqual([{account_id:"1",amount:888}]);
      expect((await pool.query("SELECT account_id::text FROM chat_session WHERE id=$1",[session])).rows).toEqual([{account_id:"1"}]);
    } finally { await fs.rm(tmpDir,{recursive:true,force:true}); }
  });

});
