import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../server/agent/prompt.js";
import { createSession } from "../../server/agent/repo.js";
import { buildChatTools } from "../../server/agent/tools.js";
import { runMigrations } from "../../server/db/migrate.js";
import {
  findStrategyEvaluatorBindingGaps,
  getStrategyEvaluatorDefinition,
  listStrategyEvaluatorDefinitions,
} from "../../server/modules/strategy-runtime/registry.js";
import { api, prepareTestDb, resetSchema, startTestServer, type TestServer } from "./helpers.js";

const prepared = await prepareTestDb();

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

describe.skipIf(!prepared)("当前策略、演进摘要与真人发布门禁", () => {
  let pool: pg.Pool;
  let server: TestServer;
  let migrationDir: string;
  let sessionId: string;

  async function insertLegacyContent(input: {
    code: string;
    title: string;
    contentType: "strategy" | "guidance" | "trading_plan";
    legacyPath: string;
    content: string;
  }): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const document = await client.query<{ id: string }>(
        `INSERT INTO content_document (code, title, content_type, status, legacy_path)
         VALUES ($1, $2, $3, 'published', $4) RETURNING id::text`,
        [input.code, input.title, input.contentType, input.legacyPath],
      );
      const revision = await client.query<{ id: string }>(
        `INSERT INTO content_revision
           (document_id, revision_no, content, sha256, source)
         VALUES ($1, 1, $2, $3, 'legacy_import') RETURNING id::text`,
        [document.rows[0]!.id, input.content, sha256(input.content)],
      );
      await client.query(
        "UPDATE content_document SET current_revision_id = $2 WHERE id = $1",
        [document.rows[0]!.id, revision.rows[0]!.id],
      );
      await client.query("COMMIT");
      return document.rows[0]!.id;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    migrationDir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-strategy-migrations-"));
    const sourceDir = path.join(import.meta.dirname, "../../server/migrations");
    const files = (await fs.readdir(sourceDir)).filter((file) => /^\d{4}_.+\.sql$/.test(file));
    for (const file of files.filter((file) => Number(file.slice(0, 4)) <= 16)) {
      await fs.copyFile(path.join(sourceDir, file), path.join(migrationDir, file));
    }
    await runMigrations(pool, migrationDir);

    await insertLegacyContent({
      code: "investment_strategy",
      title: "投资总策略",
      contentType: "strategy",
      legacyPath: "投资总策略.md",
      content: "# 投资总策略\n\n初始最终正文",
    });
    await insertLegacyContent({
      code: "daily_plan_2026_08_18",
      title: "明日交易计划_2026-08-18",
      contentType: "trading_plan",
      legacyPath: "交易计划/明日交易计划_2026-08-18.md",
      content: "# 历史计划\n\n迁入任务结果",
    });
    await insertLegacyContent({
      code: "retired_expectation_review",
      title: "预期校对",
      contentType: "guidance",
      legacyPath: "预期校对.md",
      content: "# 预期校对\n\n不应进入当前策略或 Agent 上下文",
    });
    await insertLegacyContent({
      code: "retired_data_rules",
      title: "数据获取规范",
      contentType: "guidance",
      legacyPath: "数据获取规范.md",
      content: "# 数据获取规范\n\n不应进入当前策略或 Agent 上下文",
    });
    await pool.query(
      `INSERT INTO job_run (job_id, target_date, trigger_kind, status, result_md, finished_at)
       SELECT id, '2026-08-17', 'manual', 'success', '# 既有运行结果', now()
         FROM job_definition WHERE code = 'daily_plan_flow'`,
    );

    const migration17 = files.find((file) => file.startsWith("0017_"))!;
    await fs.copyFile(path.join(sourceDir, migration17), path.join(migrationDir, migration17));
    expect((await runMigrations(pool, migrationDir)).applied).toEqual([17]);
    for (const file of files.filter((file) => {
      const version = Number(file.slice(0, 4));
      return version >= 18 && version <= 21;
    })) {
      await fs.copyFile(path.join(sourceDir, file), path.join(migrationDir, file));
    }
    expect((await runMigrations(pool, migrationDir)).applied).toEqual([18, 19, 20, 21]);
    const migration64 = files.find((file) => file.startsWith("0064_"))!;
    await fs.copyFile(path.join(sourceDir, migration64), path.join(migrationDir, migration64));
    expect((await runMigrations(pool, migrationDir)).applied).toEqual([64]);
    // 运行时的策略读取依赖当前 schema（含 0088 策略正文内联）；补齐其余迁移后再起服务。
    for (const file of files.filter((file) => Number(file.slice(0, 4)) >= 18)) {
      await fs.copyFile(path.join(sourceDir, file), path.join(migrationDir, file));
    }
    const remaining = await runMigrations(pool, migrationDir);
    expect(remaining.applied).not.toContain(17);
    server = await startTestServer(pool);
    sessionId = (await createSession(pool, "策略演进测试")).id;
  });

  afterAll(async () => {
    await server.close();
    await fs.rm(migrationDir, { recursive: true, force: true });
    await pool.end();
  });

  it("0017 只迁当前策略并计算整体哈希，交易计划和既有运行结果归具体任务", async () => {
    const current = await api(server.baseUrl, "GET", "/api/strategy/current");
    expect(current.status).toBe(200);
    const bundle = current.json as unknown as {
      state: { change_seq: string; current_hash: string };
      documents: Array<{ code: string; sha256: string; content: string }>;
    };
    expect(bundle.documents.map((document) => document.code)).toContain("investment_strategy");
    // 0109 已把总策略正文重写为组合统筹版；迁移链不再保留 0017 的初始正文。
    expect(bundle.documents.find((document) => document.code === "investment_strategy")!.content)
      .toContain("# 投资总策略：组合统筹");
    const currentDocuments = await pool.query<{ code: string; sha256: string }>(
      `SELECT code, sha256 FROM strategy_document ORDER BY injection_order, id`,
    );
    expect(currentDocuments.rows.map((row) => row.code)).toEqual(bundle.documents.map((document) => document.code));
    const baseSeq = (await pool.query<{ change_seq: string }>("SELECT change_seq::text FROM strategy_state")).rows[0]!.change_seq;
    expect(bundle.state).toMatchObject({
      change_seq: baseSeq,
      current_hash: sha256(currentDocuments.rows.map((row) => `${row.code}:${row.sha256}`).join("\n")),
    });
    // 旧内容库已由 0112 整体退役：content_* 表不再存在，策略正文只来自 strategy_document。
    expect((await pool.query(
      "SELECT to_regclass('content_document')::text AS name",
    )).rows[0]!.name).toBeNull();
    const systemPrompt = await buildSystemPrompt(pool);
    expect(systemPrompt).not.toContain("# 预期校对");
    expect(systemPrompt).not.toContain("# 数据获取规范");
    // 策略演进摘要与提案审核流程已退役。
    expect((await pool.query("SELECT to_regclass('strategy_evolution_log')::text AS name")).rows[0]!.name).toBeNull();
    expect((await pool.query("SELECT to_regclass('strategy_publish_proposal')::text AS name")).rows[0]!.name).toBeNull();

    const outputs = await api(server.baseUrl, "GET", "/api/jobs/daily_plan_flow/outputs?limit=20");
    expect(outputs.status).toBe(200);
    expect(outputs.json).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "historical_import", output_type: "daily_plan", markdown: expect.stringContaining("历史计划") }),
      expect.objectContaining({ source: "agent_flow", output_type: "daily_plan", markdown: "# 既有运行结果" }),
    ]));
    const prompts = await pool.query<{ content: string }>(
      `SELECT revision.content FROM job_prompt prompt
       JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id`,
    );
    // 0017 起流程提示词改读任务结果域，且任何提示词都不得再读取冻结的 content_*。
    expect(prompts.rows.every((row) => !row.content.includes("content_document"))).toBe(true);
    const planPrompt = await pool.query<{ content: string }>(
      `SELECT revision.content FROM job_prompt prompt
       JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
      WHERE prompt.code = 'daily_plan_flow'`,
    );
    expect(planPrompt.rows[0]!.content).toContain("job_run_output");
  });

  it("策略正文只读：发布提案与审核入口全部退役，Agent 无发布工具", async () => {
    const bundle = (await api(server.baseUrl, "GET", "/api/strategy/current")).json as unknown as {
      state: { change_seq: string; current_hash: string };
      documents: Array<{ code: string; role: string; job_code: string | null }>;
    };
    expect(bundle.documents.some((document) => document.role === "task")).toBe(true);
    expect(bundle.documents.filter((document) => document.role === "task")
      .every((document) => typeof document.job_code === "string")).toBe(true);
    expect((await api(server.baseUrl, "GET", "/api/strategy/proposals")).status).toBe(404);
    expect((await api(server.baseUrl, "GET", "/api/strategy/evolutions")).status).toBe(404);
    expect((await api(server.baseUrl, "POST", "/api/strategy/proposals/1/approve", {})).status).toBe(404);
    const toolNames = buildChatTools({ pool, sessionId }).map((tool) => tool.name);
    expect(toolNames).not.toContain("strategy_publish_request");
    expect(toolNames).not.toContain("finalize_backtest");
    expect(toolNames).not.toContain("run_backtest");
    // 策略 id 与哈希即使被 Agent 知晓也无法通过任何工具改写正文。
    const before = (await pool.query<{ sha256: string }>(
      "SELECT sha256 FROM strategy_document ORDER BY injection_order, id",
    )).rows.map((row) => row.sha256);
    expect((await api(server.baseUrl, "GET", "/api/strategy/current")).json).toMatchObject({ state: bundle.state });
    expect((await pool.query<{ sha256: string }>(
      "SELECT sha256 FROM strategy_document ORDER BY injection_order, id",
    )).rows.map((row) => row.sha256)).toEqual(before);
  });

  it("评估器注册表覆盖全部策略绑定并拒绝未接入执行链路的评估器", async () => {
    const evaluators = listStrategyEvaluatorDefinitions();
    expect(new Set(evaluators.map((item) => item.code)).size).toBe(evaluators.length);
    expect(getStrategyEvaluatorDefinition("swing_entry_v1")).toMatchObject({ phase: "entry", status: "ready", version: 1 });
    expect(getStrategyEvaluatorDefinition("fallback_exit_v1")).toMatchObject({ phase: "exit", status: "ready", version: 1 });
    expect(await findStrategyEvaluatorBindingGaps(pool)).toEqual([]);
    await pool.query("BEGIN");
    try {
      await pool.query("UPDATE strategy_definition SET entry_evaluator_code = 'missing_entry_v1' WHERE code = 'swing'");
      expect(await findStrategyEvaluatorBindingGaps(pool)).toEqual([
        expect.objectContaining({
          strategy_code: "swing",
          field: "entry_evaluator_code",
          evaluator_code: "missing_entry_v1",
          reason: "unregistered",
        }),
      ]);
    } finally {
      await pool.query("ROLLBACK");
    }
  });

  it("策略运行时定义通过只读接口展示评估器、兜底和单策略任务关系", async () => {
    const listed = await api(server.baseUrl, "GET", "/api/strategies/runtime");
    expect(listed.status).toBe(200);
    const definitions = listed.json as unknown as Array<{
      code: string;
      status: string;
      daily_plan_scope: string[];
      tasks: Array<{ code: string; agent_role: string }>;
    }>;
    expect(definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "swing", status: "active", daily_plan_scope: ["entry", "exit", "attention"] }),
      expect.objectContaining({ code: "legacy_left_reversal", status: "exit_only" }),
      expect.objectContaining({ code: "portfolio_fallback_exit", status: "active" }),
    ]));

    const right = await api(server.baseUrl, "GET", "/api/strategies/runtime/legacy_right_side");
    expect(right.status).toBe(200);
    expect(right.json).toMatchObject({
      code: "legacy_right_side",
      exit_evaluator_code: "legacy_right_side_exit_v1",
      fallback_strategy_code: "portfolio_fallback_exit",
      exit_policy_mode: "dedicated_plus_fallback",
    });

    const reversal = await api(server.baseUrl, "GET", "/api/strategies/runtime/two_year_reversal");
    expect(reversal.status).toBe(200);
    expect(reversal.json.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "two_year_reversal_scan", agent_role: "strategy_entry_report" }),
    ]));

    const evaluations = await api(server.baseUrl, "GET", "/api/strategies/runtime/swing/evaluations?limit=10");
    expect(evaluations).toEqual({ status: 200, json: [] });
    expect((await api(server.baseUrl, "GET", "/api/strategies/runtime/swing/evaluations?limit=0")).status).toBe(400);
    expect((await api(server.baseUrl, "GET", "/api/strategies/runtime/not_exists")).status).toBe(404);
  });

});
