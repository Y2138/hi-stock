// 会话事件总线：数据库事件是可重放事实，进程内总线只负责低延迟续流。
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §6.4
// 决定（二选一）：确认结果经独立的 GET /api/chat/:sessionId/events 长连 SSE 推送，
// 不依赖“下一条消息流携带”；消息流自身只携带本轮 text/tool_*/confirmation_pending/done/error 帧。
import type { Db } from "./repo.js";
import { redactEphemeralCode } from "./redaction.js";

export interface ChatSessionEventRow {
  id: string;
  session_id: string;
  event_type: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface SessionEventFrame {
  cursor: string;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}

type Listener = (frame: SessionEventFrame) => void;

const listeners = new Map<string, Set<Listener>>();

/** 仅发布已经持久化且带游标的事件；无订阅者时仍可由数据库补发。 */
export function publishSessionEvent(sessionId: string, frame: SessionEventFrame): void {
  const set = listeners.get(sessionId);
  if (!set) return;
  for (const listener of set) listener(frame);
}

/** 先写数据库再发布，调用方不得自行交换顺序。 */
export async function persistAndPublishSessionEvent(
  db: Db,
  input: {
    session_id: string;
    event_type: string;
    data?: Record<string, unknown>;
  },
): Promise<ChatSessionEventRow> {
  const row = await appendChatSessionEvent(db, input);
  publishSessionEvent(input.session_id, {
    cursor: row.id,
    type: row.event_type,
    data: row.data,
    created_at: row.created_at,
  });
  return row;
}

export async function appendChatSessionEvent(
  db: Db,
  input: { session_id: string; event_type: string; data?: Record<string, unknown> },
): Promise<ChatSessionEventRow> {
  const result = await db.query<ChatSessionEventRow>(
    `INSERT INTO chat_session_event (session_id, event_type, data)
     VALUES ($1, $2, $3)
     RETURNING id::text, session_id::text, event_type, data, created_at`,
    [
      input.session_id,
      input.event_type,
      JSON.stringify(redactEphemeralCode(input.data ?? {})),
    ],
  );
  return result.rows[0]!;
}

export async function listChatSessionEvents(
  db: Db,
  sessionId: string,
  after: string | number = 0,
  limit = 500,
): Promise<ChatSessionEventRow[]> {
  const result = await db.query<ChatSessionEventRow>(
    `SELECT id::text, session_id::text, event_type, data, created_at
       FROM chat_session_event
      WHERE session_id = $1 AND id > $2
      ORDER BY chat_session_event.id LIMIT $3`,
    [sessionId, after, limit],
  );
  return result.rows;
}

/** 订阅会话事件，返回取消函数 */
export function subscribeSessionEvents(sessionId: string, listener: Listener): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(sessionId);
  };
}
