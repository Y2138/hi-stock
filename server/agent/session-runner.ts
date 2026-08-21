// 交互对话与 agent_flow 共用的 Agent session 执行边界。
// core loop 不感知数据库；本层保证每条完成消息和低频事件先持久化，再交给 SSE/调度器。
import crypto from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import { resolveActiveChatModel } from "./ai/runtime.js";
import { compactSessionContext } from "./context-compaction.js";
import { runAgentTurn, type AgentCoreFrame, type AgentTurnResult } from "./core/loop.js";
import { persistAndPublishSessionEvent } from "./events.js";
import { AgentRunMetricRecorder } from "./metrics.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  appendMessage,
  getSession,
  listMessages,
  nextMessageSeq,
  saveContextSummary,
  touchSession,
  updateSessionStatus,
} from "./repo.js";
import { getAgentSettings } from "./settings.js";
import { buildChatTools } from "./tools.js";

const sessionQueues = new Map<string, Promise<void>>();
const MAX_PERSISTED_FRAME_BYTES = 64 * 1024;
const FORBIDDEN_EVENT_KEYS = /^(api_?key|access_?token|secret|source_code|code_body|script_body|patch|workspace_path|temporary_path)$/i;

function sanitizeEventValue(value: unknown, key = "", depth = 0): unknown {
  if (FORBIDDEN_EVENT_KEYS.test(key)) return "[不持久化]";
  if (depth > 8) return "[层级截断]";
  if (typeof value === "string") return value.length > 8_000 ? `${value.slice(0, 8_000)}…[截断]` : value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeEventValue(item, "", depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        sanitizeEventValue(childValue, childKey, depth + 1),
      ]),
    );
  }
  return value;
}

function persistedFrameData(frame: AgentCoreFrame): Record<string, unknown> {
  const sanitized = sanitizeEventValue(frame.data) as Record<string, unknown>;
  const json = JSON.stringify(sanitized);
  if (Buffer.byteLength(json, "utf8") <= MAX_PERSISTED_FRAME_BYTES) return sanitized;
  return {
    toolCallId: frame.data.toolCallId,
    name: frame.data.name,
    isError: frame.data.isError,
    truncated: true,
    payload_sha256: crypto.createHash("sha256").update(json).digest("hex"),
  };
}

async function serializeSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => gate);
  sessionQueues.set(sessionId, queued);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (sessionQueues.get(sessionId) === queued) sessionQueues.delete(sessionId);
  }
}

export interface AgentSessionTurnInput {
  pool: pg.Pool;
  sessionId: string;
  text: string;
  images?: ImageContent[];
  tools?: AgentTool[];
  historyMode?: "session" | "empty";
  systemPrompt?: string;
  systemPromptSuffix?: string;
  manageSessionStatus?: boolean;
  titleFromText?: boolean;
  onFrame?: (frame: AgentCoreFrame) => void;
}

export interface AgentSessionTurnResult extends AgentTurnResult {
  freshMessages: AgentMessage[];
}

const INTERRUPTED_SESSION_ERROR = "服务重启：上一进程中的 Agent 运行已中断";

/** 服务重启后，非调度器接管的 running 会话不可能仍有进程内 Agent。 */
export async function recoverInterruptedAgentSessions(
  pool: pg.Pool,
  at = new Date(),
): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `UPDATE chat_session AS session
        SET session_status = 'failed', finished_at = $1, last_error_summary = $2, updated_at = $1
      WHERE session.session_status = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM job_run
           WHERE job_run.session_id = session.id AND job_run.status = 'running'
        )
      RETURNING session.id::text`,
    [at, INTERRUPTED_SESSION_ERROR],
  );
  for (const row of result.rows) {
    await persistAndPublishSessionEvent(pool, {
      session_id: row.id,
      event_type: "session_error",
      data: { code: "AGENT_INTERRUPTED", message: INTERRUPTED_SESSION_ERROR },
    });
    await persistAndPublishSessionEvent(pool, {
      session_id: row.id,
      event_type: "session_status",
      data: { status: "failed" },
    });
  }
  return result.rowCount ?? 0;
}

export async function runAgentSessionTurn(
  input: AgentSessionTurnInput,
): Promise<AgentSessionTurnResult> {
  return serializeSession(input.sessionId, async () => {
    const session = await getSession(input.pool, input.sessionId);
    if (!session) throw new Error(`Agent session 不存在：${input.sessionId}`);
    const manageStatus = input.manageSessionStatus ?? true;
    const historyRows = input.historyMode === "empty" ? [] : await listMessages(input.pool, session.id);
    const runtime = await resolveActiveChatModel(input.pool, session.model_id);
    const basePrompt = input.systemPrompt ?? (await buildSystemPrompt(input.pool));
    const fullPrompt = input.systemPromptSuffix
      ? `${basePrompt}\n\n${input.systemPromptSuffix}`
      : basePrompt;
    const context = input.historyMode === "empty"
      ? {
          messages: [] as AgentMessage[],
          systemPrompt: fullPrompt,
          compacted: false,
          summary: null,
          throughSeq: 0,
          estimatedTokens: 0,
        }
      : await compactSessionContext({
          session,
          historyRows,
          runtime,
          systemPrompt: fullPrompt,
        });
    if (context.compacted && context.summary) {
      await saveContextSummary(input.pool, {
        session_id: session.id,
        summary: context.summary,
        through_seq: context.throughSeq,
        estimated_tokens: context.estimatedTokens,
      });
      await persistAndPublishSessionEvent(input.pool, {
        session_id: session.id,
        event_type: "context_compacted",
        data: {
          through_seq: context.throughSeq,
          estimated_tokens: context.estimatedTokens,
        },
      });
      input.onFrame?.({
        type: "context_compacted",
        data: {
          through_seq: context.throughSeq,
          estimated_tokens: context.estimatedTokens,
        },
      });
    }

    if (manageStatus) {
      await updateSessionStatus(input.pool, session.id, { status: "running" });
      await persistAndPublishSessionEvent(input.pool, {
        session_id: session.id,
        event_type: "session_status",
        data: { status: "running" },
      });
    }

    const tools = input.tools ?? buildChatTools({
      pool: input.pool,
      sessionId: session.id,
      marketDomainToolsEnabled: (await getAgentSettings(input.pool)).market_domain_tools_enabled,
    });
    const runId = crypto.randomUUID();
    let nextSeq = await nextMessageSeq(input.pool, session.id);
    const metrics = await AgentRunMetricRecorder.start({
      pool: input.pool,
      runKey: runId,
      sessionId: session.id,
      modelId: session.model_id,
      systemPrompt: context.systemPrompt,
      historyMessages: context.messages,
      tools,
      compacted: context.compacted,
    });

    let frameChain = Promise.resolve();
    const pendingToolUpdates = new Map<string, AgentCoreFrame>();
    const enqueueFrame = (frame: AgentCoreFrame): void => {
      frameChain = frameChain.then(async () => {
        if (frame.type !== "text") {
          await persistAndPublishSessionEvent(input.pool, {
            session_id: session.id,
            event_type: frame.type,
            data: persistedFrameData(frame),
          });
        }
        input.onFrame?.(frame);
      });
    };
    const flushToolUpdates = (): void => {
      for (const frame of pendingToolUpdates.values()) enqueueFrame(frame);
      pendingToolUpdates.clear();
    };
    const onCoreFrame = (frame: AgentCoreFrame): void => {
      metrics.observeFrame(frame);
      if (frame.type === "tool_update") {
        const toolCallId = String(frame.data.toolCallId ?? "unknown");
        pendingToolUpdates.set(toolCallId, frame);
        return;
      }
      flushToolUpdates();
      enqueueFrame(frame);
    };
    const onMessageCompleted = async (message: AgentMessage): Promise<void> => {
      flushToolUpdates();
      frameChain = frameChain.then(async () => {
        const row = await appendMessage(input.pool, {
          session_id: session.id,
          seq: nextSeq,
          role: message.role,
          json: message,
        });
        nextSeq += 1;
        await persistAndPublishSessionEvent(input.pool, {
          session_id: session.id,
          event_type: "message_completed",
          data: { message_id: row.id, seq: row.seq, role: row.role },
        });
      });
      await frameChain;
    };

    try {
      const turn = await runAgentTurn({
        pool: input.pool,
        sessionId: session.id,
        runtime,
        systemPrompt: context.systemPrompt,
        messages: context.messages,
        text: input.text,
        images: input.images,
        runId,
        tools,
        onFrame: onCoreFrame,
        onMessageCompleted,
      });
      flushToolUpdates();
      await frameChain;

      const freshMessages = turn.messages.slice(context.messages.length);
      await touchSession(
        input.pool,
        session.id,
        input.titleFromText && session.title === "新会话" ? input.text.slice(0, 30) : undefined,
      );

      if (turn.aborted) {
        await persistAndPublishSessionEvent(input.pool, {
          session_id: session.id,
          event_type: "session_aborted",
          data: { run_id: turn.runId },
        });
        if (manageStatus) {
          await updateSessionStatus(input.pool, session.id, { status: "cancelled" });
          await persistAndPublishSessionEvent(input.pool, {
            session_id: session.id,
            event_type: "session_status",
            data: { status: "cancelled" },
          });
        }
      } else if (turn.llmError) {
        await persistAndPublishSessionEvent(input.pool, {
          session_id: session.id,
          event_type: "session_error",
          data: { code: "LLM_ERROR", message: turn.llmError },
        });
        if (manageStatus) {
          await updateSessionStatus(input.pool, session.id, {
            status: "failed",
            error_summary: turn.llmError,
          });
          await persistAndPublishSessionEvent(input.pool, {
            session_id: session.id,
            event_type: "session_status",
            data: { status: "failed" },
          });
        }
      } else if (manageStatus) {
        await updateSessionStatus(input.pool, session.id, { status: "idle" });
        await persistAndPublishSessionEvent(input.pool, {
          session_id: session.id,
          event_type: "session_status",
          data: { status: "idle" },
        });
      }
      await metrics.finish(
        turn.aborted ? "cancelled" : turn.llmError ? "failed" : "complete",
        freshMessages,
      );
      return { ...turn, freshMessages };
    } catch (error) {
      flushToolUpdates();
      await frameChain.catch(() => {});
      const message = (error as Error).message || String(error);
      await persistAndPublishSessionEvent(input.pool, {
        session_id: session.id,
        event_type: "session_error",
        data: { code: "INTERNAL", message },
      }).catch(() => {});
      if (manageStatus) {
        await updateSessionStatus(input.pool, session.id, {
          status: "failed",
          error_summary: message,
        }).catch(() => {});
        await persistAndPublishSessionEvent(input.pool, {
          session_id: session.id,
          event_type: "session_status",
          data: { status: "failed" },
        }).catch(() => {});
      }
      await metrics.finish("failed");
      throw error;
    }
  });
}
