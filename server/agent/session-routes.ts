// 普通对话的数据库游标重放 SSE。
import type http from "node:http";
import type pg from "pg";
import { apiErrors } from "../http/router.js";
import {
  listChatSessionEvents,
  subscribeSessionEvents,
  type ChatSessionEventRow,
  type SessionEventFrame,
} from "./events.js";
import { getSession } from "./repo.js";

function writeSseHead(res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
    connection: "keep-alive",
  });
  res.flushHeaders();
}

function sendSse(res: http.ServerResponse, type: string, data: Record<string, unknown>): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function parseCursor(query: URLSearchParams): string {
  const raw = query.get("after") ?? "0";
  if (!/^\d+$/.test(raw)) throw apiErrors.badRequest("after 必须是非负整数游标");
  return raw.replace(/^0+(?=\d)/, "");
}

function emitRow(res: http.ServerResponse, row: ChatSessionEventRow): void {
  sendSse(res, row.event_type, {
    ...row.data,
    cursor: row.id,
    created_at: row.created_at,
  });
}

function emitFrame(res: http.ServerResponse, frame: SessionEventFrame): void {
  sendSse(res, frame.type, {
    ...frame.data,
    cursor: frame.cursor,
    created_at: frame.created_at,
  });
}

export async function streamChatSessionEvents(input: {
  pool: pg.Pool;
  sessionId: string;
  after: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}): Promise<void> {
  const session = await getSession(input.pool, input.sessionId);
  if (!session) throw apiErrors.notFound(`会话不存在：${input.sessionId}`);

  let phase: "replay" | "flush" | "live" = "replay";
  let buffered: SessionEventFrame[] = [];
  let closed = false;
  const unsubscribe = subscribeSessionEvents(input.sessionId, (frame) => {
    if (closed) return;
    if (phase !== "live") {
      buffered.push(frame);
      return;
    }
    try {
      emitFrame(input.res, frame);
    } catch {
      /* close 事件负责释放 */
    }
  });
  writeSseHead(input.res);
  sendSse(input.res, "ready", { session_id: input.sessionId, after: input.after });

  let last = BigInt(input.after);
  try {
    for (;;) {
      const rows = await listChatSessionEvents(input.pool, input.sessionId, last.toString(), 500);
      for (const row of rows) {
        const cursor = BigInt(row.id);
        if (cursor <= last) continue;
        emitRow(input.res, row);
        last = cursor;
      }
      if (rows.length < 500) break;
    }

    phase = "flush";
    buffered.sort((left, right) => (BigInt(left.cursor) < BigInt(right.cursor) ? -1 : 1));
    for (const frame of buffered) {
      const cursor = BigInt(frame.cursor);
      if (cursor <= last) continue;
      emitFrame(input.res, frame);
      last = cursor;
    }
    buffered = [];
    phase = "live";
    sendSse(input.res, "replay_complete", {
      session_id: input.sessionId,
      cursor: last.toString(),
    });
  } catch (error) {
    sendSse(input.res, "error", {
      code: "EVENT_REPLAY_FAILED",
      message: (error as Error).message,
    });
    closed = true;
    unsubscribe();
    input.res.end();
    return;
  }

  const heartbeat = setInterval(() => input.res.write(": ping\n\n"), 25_000);
  input.req.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  });
}

export function streamCursor(query: URLSearchParams): string {
  return parseCursor(query);
}
