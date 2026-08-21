import crypto from "node:crypto";
import type pg from "pg";
import { inServiceTransaction, type TransactionDb } from "../../db/transaction.js";
import { apiErrors } from "../../http/router.js";

type QueryDb = Pick<pg.Pool, "query">;
export type JobPromptSource = "legacy_import" | "user" | "agent" | "rollback";

export interface JobPromptRow {
  id: string;
  code: string;
  name: string;
  status: "active" | "archived";
  legacy_path: string | null;
  current_revision_id: string | null;
  current_revision_no: number | null;
  current_sha256: string | null;
  current_content?: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobPromptRevisionRow {
  id: string;
  prompt_id: string;
  revision_no: number;
  content: string;
  sha256: string;
  source: JobPromptSource;
  base_revision_id: string | null;
  change_summary: string | null;
  created_at: string;
}

const SELECT_PROMPT = `SELECT p.*, r.revision_no AS current_revision_no, r.sha256 AS current_sha256
  FROM job_prompt p LEFT JOIN job_prompt_revision r ON r.id = p.current_revision_id`;

function hash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function assertContent(content: string): void {
  if (!content.trim()) throw apiErrors.badRequest("提示词正文不能为空");
  if (Buffer.byteLength(content, "utf8") > 512 * 1024) throw apiErrors.badRequest("提示词正文不得超过 512 KiB");
}

export async function listJobPrompts(db: QueryDb): Promise<JobPromptRow[]> {
  return (await db.query<JobPromptRow>(`${SELECT_PROMPT} ORDER BY p.status, p.code`)).rows;
}

export async function findJobPrompt(db: QueryDb, idOrCode: string, includeContent = false): Promise<JobPromptRow | null> {
  const result = await db.query<JobPromptRow>(
    `${SELECT_PROMPT.replace(
      "r.sha256 AS current_sha256",
      `r.sha256 AS current_sha256${includeContent ? ", r.content AS current_content" : ""}`,
    )}
     WHERE ${/^\d+$/.test(idOrCode) ? "p.id = $1" : "p.code = $1"}`,
    [idOrCode],
  );
  return result.rows[0] ?? null;
}

export async function listJobPromptRevisions(db: QueryDb, promptId: string): Promise<JobPromptRevisionRow[]> {
  return (await db.query<JobPromptRevisionRow>(
    "SELECT * FROM job_prompt_revision WHERE prompt_id = $1 ORDER BY revision_no DESC",
    [promptId],
  )).rows;
}

export async function findJobPromptRevision(db: QueryDb, promptId: string, revisionId: string): Promise<JobPromptRevisionRow | null> {
  const result = await db.query<JobPromptRevisionRow>(
    "SELECT * FROM job_prompt_revision WHERE prompt_id = $1 AND id = $2",
    [promptId, revisionId],
  );
  return result.rows[0] ?? null;
}

export async function createJobPrompt(
  db: TransactionDb,
  input: { code: string; name: string; content: string; source: Exclude<JobPromptSource, "rollback">; change_summary?: string | null },
): Promise<JobPromptRow> {
  assertContent(input.content);
  return inServiceTransaction(db, async (client) => {
    const prompt = await client.query<{ id: string }>(
      "INSERT INTO job_prompt (code, name) VALUES ($1, $2) RETURNING id",
      [input.code, input.name.trim()],
    );
    const revision = await client.query<{ id: string }>(
      `INSERT INTO job_prompt_revision
         (prompt_id, revision_no, content, sha256, source, change_summary)
       VALUES ($1, 1, $2, $3, $4, $5) RETURNING id`,
      [prompt.rows[0]!.id, input.content, hash(input.content), input.source, input.change_summary ?? null],
    );
    await client.query("UPDATE job_prompt SET current_revision_id = $2, updated_at = now() WHERE id = $1", [prompt.rows[0]!.id, revision.rows[0]!.id]);
    return (await findJobPrompt(client, prompt.rows[0]!.id, true))!;
  });
}

export async function appendJobPromptRevision(
  db: TransactionDb,
  promptId: string,
  input: { base_revision_id: string; content: string; source: Exclude<JobPromptSource, "rollback">; change_summary?: string | null },
): Promise<JobPromptRow> {
  assertContent(input.content);
  return inServiceTransaction(db, async (client) => {
    const locked = await client.query<JobPromptRow>("SELECT * FROM job_prompt WHERE id = $1 FOR UPDATE", [promptId]);
    const prompt = locked.rows[0];
    if (!prompt) throw apiErrors.notFound(`作业提示词不存在：${promptId}`);
    if (prompt.current_revision_id !== input.base_revision_id) {
      throw apiErrors.conflict("提示词已被其他会话更新，请刷新后重试", { current_revision_id: prompt.current_revision_id });
    }
    const next = await client.query<{ revision_no: number }>(
      "SELECT COALESCE(MAX(revision_no), 0) + 1 AS revision_no FROM job_prompt_revision WHERE prompt_id = $1",
      [promptId],
    );
    const revision = await client.query<{ id: string }>(
      `INSERT INTO job_prompt_revision
         (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [promptId, next.rows[0]!.revision_no, input.content, hash(input.content), input.source, input.base_revision_id, input.change_summary ?? null],
    );
    await client.query("UPDATE job_prompt SET current_revision_id = $2, updated_at = now() WHERE id = $1", [promptId, revision.rows[0]!.id]);
    return (await findJobPrompt(client, promptId, true))!;
  });
}

export async function rollbackJobPrompt(
  db: TransactionDb,
  promptId: string,
  input: { base_revision_id: string; target_revision_id: string; change_summary?: string | null },
): Promise<JobPromptRow> {
  const target = await findJobPromptRevision(db, promptId, input.target_revision_id);
  if (!target) throw apiErrors.notFound(`目标提示词版本不存在：${input.target_revision_id}`);
  return inServiceTransaction(db, async (client) => {
    const locked = await client.query<JobPromptRow>("SELECT * FROM job_prompt WHERE id = $1 FOR UPDATE", [promptId]);
    const prompt = locked.rows[0];
    if (!prompt) throw apiErrors.notFound(`作业提示词不存在：${promptId}`);
    if (prompt.current_revision_id !== input.base_revision_id) {
      throw apiErrors.conflict("提示词已被其他会话更新，请刷新后重试", { current_revision_id: prompt.current_revision_id });
    }
    const next = await client.query<{ revision_no: number }>(
      "SELECT COALESCE(MAX(revision_no), 0) + 1 AS revision_no FROM job_prompt_revision WHERE prompt_id = $1",
      [promptId],
    );
    const revision = await client.query<{ id: string }>(
      `INSERT INTO job_prompt_revision
         (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
       VALUES ($1, $2, $3, $4, 'rollback', $5, $6) RETURNING id`,
      [promptId, next.rows[0]!.revision_no, target.content, target.sha256, input.base_revision_id, input.change_summary ?? `回滚到 v${target.revision_no}`],
    );
    await client.query("UPDATE job_prompt SET current_revision_id = $2, updated_at = now() WHERE id = $1", [promptId, revision.rows[0]!.id]);
    return (await findJobPrompt(client, promptId, true))!;
  });
}

export async function updateJobPromptStatus(
  db: TransactionDb,
  promptId: string,
  input: { base_revision_id: string; status: "active" | "archived" },
): Promise<JobPromptRow> {
  return inServiceTransaction(db, async (client) => {
    const updated = await client.query(
      `UPDATE job_prompt SET status = $3, updated_at = now()
        WHERE id = $1 AND current_revision_id = $2 RETURNING id`,
      [promptId, input.base_revision_id, input.status],
    );
    if (!updated.rows[0]) {
      const current = await findJobPrompt(client, promptId);
      if (!current) throw apiErrors.notFound(`作业提示词不存在：${promptId}`);
      throw apiErrors.conflict("提示词已被其他会话更新，请刷新后重试", { current_revision_id: current.current_revision_id });
    }
    return (await findJobPrompt(client, promptId, true))!;
  });
}
