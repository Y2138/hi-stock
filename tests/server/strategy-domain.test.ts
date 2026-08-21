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
    contentType: "strategy" | "trading_plan";
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
      documents: Array<{ code: string; current_sha256: string; current_content: string }>;
    };
    expect(bundle.documents).toHaveLength(1);
    expect(bundle.documents[0]).toMatchObject({ code: "investment_strategy", current_content: "# 投资总策略\n\n初始最终正文" });
    expect(bundle.state).toMatchObject({
      change_seq: "0",
      current_hash: sha256(`investment_strategy:${bundle.documents[0]!.current_sha256}`),
    });
    expect(Number((await pool.query("SELECT count(*) FROM strategy_evolution_log")).rows[0]!.count)).toBe(0);

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
    expect(prompts.rows.every((row) => row.content.includes("job_run_output"))).toBe(true);
    expect(prompts.rows.every((row) => !row.content.includes("content_document"))).toBe(true);
  });

  it("YOLO 下 Agent 仍只能创建 pending，普通 confirmation 和工具均不能批准", async () => {
    await pool.query("UPDATE agent_setting SET yolo_mode = true WHERE singleton = true");
    const bundle = (await api(server.baseUrl, "GET", "/api/strategy/current")).json as unknown as {
      state: { change_seq: string; current_hash: string };
      documents: Array<{ id: string; current_revision_id: string; current_content: string }>;
    };
    const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === "strategy_publish_request")!;
    const result = await tool.execute("strategy-pending", {
      base_change_seq: bundle.state.change_seq,
      base_strategy_hash: bundle.state.current_hash,
      outline: "验证真人发布门禁",
      conclusion: "拟议正文可进入审核，但不能自动发布",
      adjustments: ["补充一条经验证的边界"],
      summary: "门禁测试提案",
      changes: [{
        document_id: bundle.documents[0]!.id,
        base_revision_id: bundle.documents[0]!.current_revision_id,
        content: `${bundle.documents[0]!.current_content}\n\n新增边界`,
      }],
    });
    const detail = result.details as { proposal_id: string; status: string; requires_human: boolean };
    expect(detail).toMatchObject({ status: "pending", requires_human: true });
    expect(Number((await pool.query("SELECT count(*) FROM agent_confirmation")).rows[0]!.count)).toBe(0);
    expect((await pool.query("SELECT change_seq::text FROM strategy_state")).rows[0]!.change_seq).toBe("0");
    expect(buildChatTools({ pool, sessionId }).some((item) => item.name === "strategy_publish_approve")).toBe(false);
    await pool.query("UPDATE agent_setting SET yolo_mode = false WHERE singleton = true");

    const noToken = await api(server.baseUrl, "POST", `/api/strategy/proposals/${detail.proposal_id}/approve`, {
      actor_type: "user",
      interaction_source: "strategy_page",
      review_token: "x".repeat(20),
    });
    expect(noToken.status).toBe(403);
  });

  it("错误 actor/来源无法审核，页面一次性令牌批准后立即成为 Agent 最新策略", async () => {
    const proposal = (await api(server.baseUrl, "GET", "/api/strategy/proposals?limit=10")).json as unknown as Array<{ id: string }>;
    const proposalId = proposal[0]!.id;
    const review = await api(server.baseUrl, "GET", `/api/strategy/proposals/${proposalId}/review`);
    const token = (review.json.review as { token: string }).token;
    expect((await api(server.baseUrl, "POST", `/api/strategy/proposals/${proposalId}/approve`, {
      actor_type: "agent",
      interaction_source: "strategy_page",
      review_token: token,
    })).status).toBe(403);
    expect((await api(server.baseUrl, "POST", `/api/strategy/proposals/${proposalId}/approve`, {
      actor_type: "user",
      interaction_source: "chat",
      review_token: token,
    })).status).toBe(403);

    const approved = await api(server.baseUrl, "POST", `/api/strategy/proposals/${proposalId}/approve`, {
      actor_type: "user",
      interaction_source: "strategy_page",
      review_token: token,
      decision_note: "测试真人批准",
    });
    expect(approved.status).toBe(200);
    const current = (await api(server.baseUrl, "GET", "/api/strategy/current")).json as unknown as {
      state: { change_seq: string };
      documents: Array<{ current_content: string }>;
    };
    expect(current.state.change_seq).toBe("1");
    expect(current.documents[0]!.current_content).toContain("新增边界");
    expect((await pool.query("SELECT proposed_changes FROM strategy_publish_proposal WHERE id = $1", [proposalId])).rows[0]!.proposed_changes).toBeNull();
    const prompt = await buildSystemPrompt(pool);
    expect(prompt).toContain("change_seq=1");
    expect(prompt).toContain("新增边界");
  });

  it("批准前整体基线变化会标记 conflict 且不改正文；拒绝也会清除拟议全文", async () => {
    const createProposal = async (outline: string) => {
      const current = (await api(server.baseUrl, "GET", "/api/strategy/current")).json as unknown as {
        state: { change_seq: string; current_hash: string };
        documents: Array<{ id: string; current_revision_id: string; current_content: string }>;
      };
      const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === "strategy_publish_request")!;
      const result = await tool.execute(`strategy-${outline}`, {
        base_change_seq: current.state.change_seq,
        base_strategy_hash: current.state.current_hash,
        outline,
        conclusion: "测试结论",
        adjustments: ["测试调整点"],
        summary: outline,
        changes: [{
          document_id: current.documents[0]!.id,
          base_revision_id: current.documents[0]!.current_revision_id,
          content: `${current.documents[0]!.current_content}\n\n${outline}`,
        }],
      });
      return (result.details as { proposal_id: string }).proposal_id;
    };

    const before = (await api(server.baseUrl, "GET", "/api/strategy/current")).json as unknown as {
      documents: Array<{ current_content: string }>;
    };
    const conflictId = await createProposal("冲突提案");
    await pool.query("UPDATE strategy_state SET change_seq = change_seq + 1");
    const conflictToken = (await api(server.baseUrl, "GET", `/api/strategy/proposals/${conflictId}/review`)).json.review as { token: string };
    expect((await api(server.baseUrl, "POST", `/api/strategy/proposals/${conflictId}/approve`, {
      actor_type: "user",
      interaction_source: "strategy_page",
      review_token: conflictToken.token,
    })).status).toBe(409);
    expect((await pool.query("SELECT status, proposed_changes FROM strategy_publish_proposal WHERE id = $1", [conflictId])).rows[0]).toMatchObject({ status: "conflict", proposed_changes: null });
    expect(((await api(server.baseUrl, "GET", "/api/strategy/current")).json as unknown as typeof before).documents[0]!.current_content).toBe(before.documents[0]!.current_content);

    const rejectId = await createProposal("拒绝提案");
    const rejectToken = (await api(server.baseUrl, "GET", `/api/strategy/proposals/${rejectId}/review`)).json.review as { token: string };
    expect((await api(server.baseUrl, "POST", `/api/strategy/proposals/${rejectId}/reject`, {
      actor_type: "user",
      interaction_source: "strategy_page",
      review_token: rejectToken.token,
      decision_note: "验证不采纳",
    })).status).toBe(200);
    expect((await pool.query("SELECT status, proposed_changes FROM strategy_publish_proposal WHERE id = $1", [rejectId])).rows[0]).toMatchObject({ status: "rejected", proposed_changes: null });
  });
});
