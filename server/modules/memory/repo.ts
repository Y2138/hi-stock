import type pg from "pg";
import { inServiceTransaction, type TransactionDb } from "../../db/transaction.js";
import { sameTimestampVersion } from "../../db/timestamp.js";
import { apiErrors } from "../../http/router.js";

export type Db = Pick<pg.Pool | pg.PoolClient, "query">;
export type MemoryCategory = "research_method" | "evaluation_template" | "data_source_knowledge" | "task_playbook" | "incident_resolution" | "user_preference";
export type MemoryStatus = "active" | "review_required" | "superseded" | "deprecated";

export interface MemoryRow {
  id: string;
  title: string;
  category: MemoryCategory;
  summary: string;
  content: string;
  tags: string[];
  scope: string;
  source_session_id: string;
  source_run_type: "job" | "backtest" | "analysis" | "tool" | null;
  source_run_id: string | null;
  evidence: string;
  status: MemoryStatus;
  supersedes_id: string | null;
  last_verified_at: string;
  created_at: string;
  updated_at: string;
}

const SELECT = `id::text, title, category, summary, content, tags, scope,
  source_session_id::text, source_run_type, source_run_id::text, evidence, status,
  supersedes_id::text, last_verified_at, created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`;

export interface MemoryQuery {
  keyword?: string;
  category?: MemoryCategory;
  tags?: string[];
  status?: MemoryStatus;
  limit?: number;
}

export async function queryMemories(db: Db, query: MemoryQuery = {}): Promise<MemoryRow[]> {
  const result = await db.query<MemoryRow>(
    `SELECT ${SELECT} FROM agent_memory_artifact
      WHERE ($1::text IS NULL OR category = $1)
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR title ILIKE '%' || $3 || '%' OR summary ILIKE '%' || $3 || '%' OR content ILIKE '%' || $3 || '%')
        AND (cardinality($4::text[]) = 0 OR tags ?| $4::text[])
      ORDER BY last_verified_at DESC, id DESC LIMIT $5`,
    [query.category ?? null, query.status ?? "active", query.keyword?.trim() || null, query.tags ?? [], Math.min(200, Math.max(1, query.limit ?? 50))],
  );
  return result.rows;
}

export async function getMemory(db: Db, id: string): Promise<MemoryRow | null> {
  const result = await db.query<MemoryRow>(`SELECT ${SELECT} FROM agent_memory_artifact WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

const FORBIDDEN_MEMORY_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i, "私钥"],
  [/\b(?:api[_ -]?key|access[_ -]?token|secret[_ -]?key)\b\s*[:=]/i, "密钥或令牌"],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/, "疑似密钥"],
  [/\bsource_code\b/i, "临时代码"],
  [/(?:当前持仓|portfolio_position)\s*[:：].*(?:数量|成本|quantity|cost)/i, "当前持仓副本"],
  [/(?:当前策略正文|strategy_document)\s*[:：][\s\S]{200,}/i, "策略正文副本"],
];

export function assertReusableMemoryText(value: string): void {
  for (const [pattern, label] of FORBIDDEN_MEMORY_PATTERNS) {
    if (pattern.test(value)) throw apiErrors.badRequest(`Agent 记忆不得保存${label}`);
  }
}

export interface MemoryContentInput {
  title: string;
  category: MemoryCategory;
  summary: string;
  content: string;
  tags: string[];
  scope: string;
  source_run_type?: "job" | "backtest" | "analysis" | "tool" | null;
  source_run_id?: string | null;
  evidence: string;
  last_verified_at: string;
}

export type MemoryChangeInput =
  | ({ action: "create"; source_session_id: string } & MemoryContentInput)
  | ({ action: "update"; source_session_id: string; memory_id: string; base_updated_at: string } & Partial<MemoryContentInput>)
  | ({ action: "supersede"; source_session_id: string; memory_id: string; base_updated_at: string } & MemoryContentInput)
  | { action: "deprecate"; source_session_id: string; memory_id: string; base_updated_at: string; evidence: string };

function normalizeContent(input: MemoryContentInput): MemoryContentInput {
  const normalized = {
    ...input,
    title: input.title.trim(), summary: input.summary.trim(), content: input.content.trim(),
    tags: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))],
    scope: input.scope.trim(), evidence: input.evidence.trim(),
  };
  assertReusableMemoryText([normalized.title, normalized.summary, normalized.content, normalized.evidence].join("\n"));
  if (normalized.source_run_id && !normalized.source_run_type) throw apiErrors.badRequest("source_run_id 必须同时提供 source_run_type");
  return normalized;
}

export async function applyMemoryChange(db: TransactionDb, input: MemoryChangeInput): Promise<MemoryRow> {
  return inServiceTransaction(db, async (client) => {
    if (input.action === "create") {
      const value = normalizeContent(input);
      const result = await client.query<MemoryRow>(
        `INSERT INTO agent_memory_artifact
           (title, category, summary, content, tags, scope, source_session_id,
            source_run_type, source_run_id, evidence, last_verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${SELECT}`,
        [value.title, value.category, value.summary, value.content, JSON.stringify(value.tags), value.scope,
         input.source_session_id, value.source_run_type ?? null, value.source_run_id ?? null, value.evidence, value.last_verified_at],
      );
      return result.rows[0]!;
    }

    const current = await client.query<MemoryRow>(
      `SELECT ${SELECT} FROM agent_memory_artifact WHERE id = $1 FOR UPDATE`,
      [input.memory_id],
    );
    const row = current.rows[0];
    if (!row) throw apiErrors.notFound(`Agent 记忆不存在：${input.memory_id}`);
    if (!sameTimestampVersion(row.updated_at, input.base_updated_at)) {
      throw apiErrors.conflict("Agent 记忆基线已变化，请重新读取后再修改");
    }
    if (!['active','review_required'].includes(row.status)) throw apiErrors.conflict(`状态为 ${row.status} 的记忆不可再修改`);

    if (input.action === "deprecate") {
      assertReusableMemoryText(input.evidence);
      const result = await client.query<MemoryRow>(
        `UPDATE agent_memory_artifact
            SET status = 'deprecated', evidence = $2, updated_at = now()
          WHERE id = $1 RETURNING ${SELECT}`,
        [input.memory_id, input.evidence.trim()],
      );
      return result.rows[0]!;
    }

    if (input.action === "supersede") {
      const value = normalizeContent(input);
      await client.query("UPDATE agent_memory_artifact SET status = 'superseded', updated_at = now() WHERE id = $1", [input.memory_id]);
      const result = await client.query<MemoryRow>(
        `INSERT INTO agent_memory_artifact
           (title, category, summary, content, tags, scope, source_session_id,
            source_run_type, source_run_id, evidence, supersedes_id, last_verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${SELECT}`,
        [value.title, value.category, value.summary, value.content, JSON.stringify(value.tags), value.scope,
         input.source_session_id, value.source_run_type ?? null, value.source_run_id ?? null,
         value.evidence, input.memory_id, value.last_verified_at],
      );
      return result.rows[0]!;
    }

    const value = normalizeContent({
      title: input.title ?? row.title,
      category: input.category ?? row.category,
      summary: input.summary ?? row.summary,
      content: input.content ?? row.content,
      tags: input.tags ?? row.tags,
      scope: input.scope ?? row.scope,
      source_run_type: input.source_run_type === undefined ? row.source_run_type : input.source_run_type,
      source_run_id: input.source_run_id === undefined ? row.source_run_id : input.source_run_id,
      evidence: input.evidence ?? row.evidence,
      last_verified_at: input.last_verified_at ?? row.last_verified_at,
    });
    const result = await client.query<MemoryRow>(
      `UPDATE agent_memory_artifact SET
         title=$2, category=$3, summary=$4, content=$5, tags=$6, scope=$7,
         source_session_id=$8, source_run_type=$9, source_run_id=$10,
         evidence=$11, last_verified_at=$12, updated_at=now()
       WHERE id=$1 RETURNING ${SELECT}`,
      [input.memory_id, value.title, value.category, value.summary, value.content, JSON.stringify(value.tags),
       value.scope, input.source_session_id, value.source_run_type ?? null, value.source_run_id ?? null,
       value.evidence, value.last_verified_at],
    );
    return result.rows[0]!;
  });
}
