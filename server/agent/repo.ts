// 对话 repo：chat_session / chat_message / chat_attachment / agent_tool_audit 读写
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §4.2、§6.1
// chat_message.content 存 pi AgentMessage 纯 JSON；role 列只做检索映射（toolResult→tool）。
import type pg from "pg";
import { redactAgentMessage, redactEphemeralCode } from "./redaction.js";

export type Db = Pick<pg.Pool, "query">;

export type ChatSessionType = "interactive" | "job" | "backtest" | "strategy_evolution";
export type ChatSessionStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting_confirmation"
  | "success"
  | "partial"
  | "failed"
  | "cancelled";
export type ChatSessionSource = "user" | "cron" | "manual_job" | "agent";

export interface ChatSessionRow {
  id: string;
  title: string;
  archived: boolean;
  model_id: string | null;
  session_type: ChatSessionType;
  session_status: ChatSessionStatus;
  source: ChatSessionSource;
  parent_session_id: string | null;
  strategy_state_revision: string | null;
  strategy_state_sha256: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_error_summary: string | null;
  context_summary: string | null;
  context_summary_through_seq: number;
  context_summary_estimated_tokens: number;
  context_compacted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: "user" | "assistant" | "tool";
  content: unknown;
  created_at: string;
}

export interface ChatAttachmentRow {
  id: string;
  session_id: string;
  path: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

export interface ToolAuditRow {
  id: string;
  session_id: string | null;
  tool_name: string;
  args: unknown;
  result_sha256: string | null;
  status: string;
  created_at: string;
}

const SESSION_COLS = `id::text, title, archived, model_id::text,
  session_type, session_status, source, parent_session_id::text,
  strategy_state_revision::text, strategy_state_sha256,
  started_at, finished_at, last_error_summary,
  context_summary, context_summary_through_seq,
  context_summary_estimated_tokens, context_compacted_at,
  created_at, updated_at`;
// 0017 分段迁移测试仍需创建会话；压缩列在 0018 前以空检查点返回。
const SESSION_CREATE_COLS = `id::text, title, archived, model_id::text,
  session_type, session_status, source, parent_session_id::text,
  strategy_state_revision::text, strategy_state_sha256,
  started_at, finished_at, last_error_summary,
  NULL::text AS context_summary, 0::int AS context_summary_through_seq,
  0::int AS context_summary_estimated_tokens,
  NULL::timestamptz AS context_compacted_at,
  created_at, updated_at`;
const MESSAGE_COLS = "id::text, session_id::text, seq, role, content, created_at";
const ATTACHMENT_COLS =
  "id::text, session_id::text, path, mime_type, size_bytes, sha256, created_at";

/** pi 消息 role → 库内 role（DDL 只允许 user/assistant/tool） */
export function toDbRole(role: string): "user" | "assistant" | "tool" {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "tool";
}

/** 会话列表：任务与普通对话共用列表；类型只作为来源和展示元数据。 */
export async function listSessions(
  db: Db,
  opts: { archivedOnly?: boolean } = {},
): Promise<ChatSessionRow[]> {
  const r = await db.query<ChatSessionRow>(
    `SELECT ${SESSION_COLS} FROM chat_session
      WHERE archived = $1
      ORDER BY updated_at DESC`,
    [opts.archivedOnly ?? false],
  );
  return r.rows;
}

/** 重命名/归档（缺省字段不变）；会话不存在返回 null */
export async function updateSession(
  db: Db,
  id: string,
  patch: { title?: string; archived?: boolean; model_id?: string },
): Promise<ChatSessionRow | null> {
  const r = await db.query<ChatSessionRow>(
    `UPDATE chat_session SET
       title = COALESCE($2, title),
       archived = COALESCE($3, archived),
       model_id = CASE WHEN $4::boolean THEN $5::bigint ELSE model_id END,
       updated_at = now()
     WHERE id = $1 RETURNING ${SESSION_COLS}`,
    [
      id,
      patch.title ?? null,
      patch.archived ?? null,
      patch.model_id !== undefined,
      patch.model_id ?? null,
    ],
  );
  return r.rows[0] ?? null;
}

export async function getSession(db: Db, id: string): Promise<ChatSessionRow | null> {
  const r = await db.query<ChatSessionRow>(
    `SELECT ${SESSION_COLS} FROM chat_session WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export interface CreateSessionInput {
  title?: string;
  session_type?: ChatSessionType;
  session_status?: ChatSessionStatus;
  source?: ChatSessionSource;
  parent_session_id?: string | null;
  strategy_state_revision?: string | null;
  strategy_state_sha256?: string | null;
}

export async function createSession(
  db: Db,
  value?: string | CreateSessionInput,
): Promise<ChatSessionRow> {
  const input = typeof value === "string" ? { title: value } : value ?? {};
  const r = await db.query<ChatSessionRow>(
    `INSERT INTO chat_session
       (title, model_id, session_type, session_status, source, parent_session_id,
        strategy_state_revision, strategy_state_sha256)
     VALUES ($1, (SELECT active_model_id FROM llm_setting WHERE singleton = true),
             $2, $3, $4, $5, $6, $7)
     RETURNING ${SESSION_CREATE_COLS}`,
    [
      input.title?.trim() || "新会话",
      input.session_type ?? "interactive",
      input.session_status ?? "idle",
      input.source ?? "user",
      input.parent_session_id ?? null,
      input.strategy_state_revision ?? null,
      input.strategy_state_sha256 ?? null,
    ],
  );
  return r.rows[0]!;
}

export async function updateSessionStatus(
  db: Db,
  sessionId: string,
  input: { status: ChatSessionStatus; at?: Date; error_summary?: string | null },
): Promise<ChatSessionRow | null> {
  const at = input.at ?? new Date();
  const terminal = ["success", "partial", "failed", "cancelled"].includes(input.status);
  const result = await db.query<ChatSessionRow>(
    `UPDATE chat_session SET
       session_status = $2,
       started_at = CASE WHEN $2 = 'running' THEN COALESCE(started_at, $3) ELSE started_at END,
       finished_at = CASE WHEN $4 THEN $3 WHEN $2 IN ('queued', 'running', 'waiting_confirmation') THEN NULL ELSE finished_at END,
       last_error_summary = $5,
       updated_at = now()
     WHERE id = $1
     RETURNING ${SESSION_COLS}`,
    [sessionId, input.status, at, terminal, input.error_summary ?? null],
  );
  return result.rows[0] ?? null;
}

export async function touchSession(db: Db, id: string, title?: string): Promise<void> {
  await db.query(
    `UPDATE chat_session SET updated_at = now(), title = COALESCE($2, title) WHERE id = $1`,
    [id, title ?? null],
  );
}

/** 会话消息（seq 升序）；content 即 pi AgentMessage JSON，可直接回填 initialState.messages */
export async function listMessages(db: Db, sessionId: string): Promise<ChatMessageRow[]> {
  const r = await db.query<ChatMessageRow>(
    `SELECT ${MESSAGE_COLS} FROM chat_message WHERE session_id = $1 ORDER BY seq`,
    [sessionId],
  );
  return r.rows;
}

/** 追加一批消息：seq 从 fromSeq 开始自增；返回写入行数 */
export async function appendMessages(
  db: Db,
  sessionId: string,
  fromSeq: number,
  messages: { role: string; json: unknown }[],
): Promise<number> {
  let seq = fromSeq;
  for (const msg of messages) {
    await db.query(
      `INSERT INTO chat_message (session_id, seq, role, content)
       VALUES ($1, $2, $3, $4)`,
      [
        sessionId,
        seq,
        toDbRole(msg.role),
        JSON.stringify(redactAgentMessage(msg.json as import("@earendil-works/pi-agent-core").AgentMessage)),
      ],
    );
    seq += 1;
  }
  return messages.length;
}

/** 追加单条完成消息并返回其稳定 id，供可重放 message_completed 事件引用。 */
export async function appendMessage(
  db: Db,
  input: {
    session_id: string;
    seq: number;
    role: string;
    json: unknown;
  },
): Promise<ChatMessageRow> {
  const result = await db.query<ChatMessageRow>(
    `INSERT INTO chat_message (session_id, seq, role, content)
     VALUES ($1, $2, $3, $4)
     RETURNING ${MESSAGE_COLS}`,
    [
      input.session_id,
      input.seq,
      toDbRole(input.role),
      JSON.stringify(redactAgentMessage(input.json as import("@earendil-works/pi-agent-core").AgentMessage)),
    ],
  );
  return result.rows[0]!;
}

export async function nextMessageSeq(db: Db, sessionId: string): Promise<number> {
  const r = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(seq) + 1, 1)::int AS next FROM chat_message WHERE session_id = $1`,
    [sessionId],
  );
  return r.rows[0]!.next;
}

/**
 * 保存模型上下文摘要检查点。原始 chat_message 不更新、不删除；throughSeq 只前进。
 */
export async function saveContextSummary(
  db: Db,
  input: {
    session_id: string;
    summary: string;
    through_seq: number;
    estimated_tokens: number;
  },
): Promise<void> {
  await db.query(
    `UPDATE chat_session SET
       context_summary = $2,
       context_summary_through_seq = $3,
       context_summary_estimated_tokens = $4,
       context_compacted_at = now(),
       updated_at = now()
     WHERE id = $1 AND context_summary_through_seq < $3`,
    [
      input.session_id,
      input.summary,
      input.through_seq,
      Math.max(0, Math.round(input.estimated_tokens)),
    ],
  );
}

export async function insertAttachment(
  db: Db,
  input: { session_id: string; path: string; mime_type: string; size_bytes: number; sha256: string },
): Promise<ChatAttachmentRow> {
  const r = await db.query<ChatAttachmentRow>(
    `INSERT INTO chat_attachment (session_id, path, mime_type, size_bytes, sha256)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${ATTACHMENT_COLS}`,
    [input.session_id, input.path, input.mime_type, input.size_bytes, input.sha256],
  );
  return r.rows[0]!;
}

export async function getAttachment(db: Db, id: string): Promise<ChatAttachmentRow | null> {
  const r = await db.query<ChatAttachmentRow>(
    `SELECT ${ATTACHMENT_COLS} FROM chat_attachment WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function listAttachments(db: Db, sessionId: string): Promise<ChatAttachmentRow[]> {
  const r = await db.query<ChatAttachmentRow>(
    `SELECT ${ATTACHMENT_COLS} FROM chat_attachment WHERE session_id = $1 ORDER BY id`,
    [sessionId],
  );
  return r.rows;
}

export async function insertToolAudit(
  db: Db,
  input: {
    session_id: string | null;
    tool_name: string;
    args: unknown;
    result_sha256: string | null;
    status: "ok" | "error" | "blocked" | "pending";
  },
): Promise<void> {
  await db.query(
    `INSERT INTO agent_tool_audit (session_id, tool_name, args, result_sha256, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.session_id,
      input.tool_name,
      JSON.stringify(redactEphemeralCode(input.args ?? {})),
      input.result_sha256,
      input.status,
    ],
  );
}

export async function listToolAudits(db: Db, limit: number): Promise<ToolAuditRow[]> {
  const r = await db.query<ToolAuditRow>(
    `SELECT id::text, session_id::text, tool_name, args, result_sha256, status, created_at
       FROM agent_tool_audit ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return r.rows;
}

/** M4 占位：agent_external_cli_run 只建表不接逻辑，此处仅提供空表读取供审计端点使用 */
export async function listCliRuns(db: Db, limit: number): Promise<unknown[]> {
  const r = await db.query(
    `SELECT id::text, session_id::text, agent, prompt, exit_code, output_sha256,
            timed_out, started_at, finished_at
       FROM agent_external_cli_run ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return r.rows;
}
