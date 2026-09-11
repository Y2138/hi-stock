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
import { redactAgentMessages } from "./redaction.js";
import { buildChatTools, JOB_FLOW_TOOL_BUNDLES, type ToolScope } from "./tools.js";
import { createOnDemandToolSet, loadedToolNamesFromMessages } from "./tool-catalog.js";

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
  /** 工具装配范围：缺省按交互会话裁剪任务流程工具；agent_flow 按 jobCode 裁剪领域工具并保留永久 Web 能力。 */
  toolScope?: ToolScope;
  historyMode?: "session" | "empty";
  systemPrompt?: string;
  systemPromptSuffix?: string;
  manageSessionStatus?: boolean;
  titleFromText?: boolean;
  onFrame?: (frame: AgentCoreFrame) => void;
  /** 缺省以非空普通 stop 为完成；自动作业可额外要求结果横幅等业务完成标记。 */
  isCompleteAssistantText?: (text: string) => boolean;
  continuationPrompt?: string | (() => string);
  maxContinuationTurns?: number;
}

export interface AgentSessionTurnResult extends AgentTurnResult {
  freshMessages: AgentMessage[];
}

const INTERRUPTED_SESSION_ERROR = "服务重启：上一进程中的 Agent 运行已中断";
const DEFAULT_CONTINUATION_PROMPT =
  "上一执行段因输出上限或尚未形成完整最终答复而结束。请基于本对话已有结果继续完成当前用户请求；已成功的工具不要重复调用，只补齐必要缺口并给出完整最终答复。";
export const DEFAULT_MAX_AGENT_CONTINUATION_TURNS = 3;

function assistantText(message: AgentMessage | null): string {
  if (!message || message.role !== "assistant") return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

/**
 * Agent loop 终止契约：aborted/error 立即终止；length/toolUse/空结果/未通过业务门禁均续写；
 * 只有非空普通 stop 且通过门禁才成功，续写超过上限则失败，禁止静默成功或无限循环。
 */
function agentTurnCompleted(turn: AgentTurnResult, isCompleteText: (text: string) => boolean): boolean {
  if (turn.aborted || turn.llmError || turn.toolLoopError || !turn.lastAssistant || turn.lastAssistant.role !== "assistant") return false;
  return turn.lastAssistant.stopReason === "stop" && isCompleteText(assistantText(turn.lastAssistant));
}

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

    const availableTools = input.tools ?? buildChatTools({
      pool: input.pool,
      sessionId: session.id,
    }, input.toolScope);
    const preload = input.toolScope?.kind === "job" && !input.tools && Object.hasOwn(JOB_FLOW_TOOL_BUNDLES, input.toolScope.jobCode)
      ? JOB_FLOW_TOOL_BUNDLES[input.toolScope.jobCode] ?? [] : [];
    const availableToolNames = new Set(availableTools.map((tool) => tool.name));
    const restored = input.historyMode === "empty"
      ? []
      : loadedToolNamesFromMessages(historyRows.map((row) => row.content))
        .filter((name) => availableToolNames.has(name));
    const initialToolNames = [...new Set([...preload, ...restored])];
    const toolSet = createOnDemandToolSet(availableTools, initialToolNames);
    const runId = crypto.randomUUID();
    let nextSeq = await nextMessageSeq(input.pool, session.id);
    const metrics = await AgentRunMetricRecorder.start({
      pool: input.pool,
      runKey: runId,
      sessionId: session.id,
      modelId: session.model_id,
      systemPrompt: context.systemPrompt,
      historyMessages: context.messages,
      tools: toolSet.initialTools,
      compacted: context.compacted,
    });

    let frameChain = Promise.resolve();
    const pendingToolUpdates = new Map<string, AgentCoreFrame>();
    let toolUpdateTimer: ReturnType<typeof setTimeout> | undefined;
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
      clearTimeout(toolUpdateTimer);
      toolUpdateTimer = undefined;
      for (const frame of pendingToolUpdates.values()) enqueueFrame(frame);
      pendingToolUpdates.clear();
    };
    const onCoreFrame = (frame: AgentCoreFrame): void => {
      metrics.observeFrame(frame);
      if (frame.type === "tool_update") {
        const toolCallId = String(frame.data.toolCallId ?? "unknown");
        pendingToolUpdates.set(toolCallId, frame);
        toolUpdateTimer ??= setTimeout(flushToolUpdates, 1_000);
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
      const isCompleteText = input.isCompleteAssistantText ?? ((text: string) => text.length > 0);
      const maxContinuationTurns = Math.min(
        Math.max(input.maxContinuationTurns ?? DEFAULT_MAX_AGENT_CONTINUATION_TURNS, 0),
        DEFAULT_MAX_AGENT_CONTINUATION_TURNS,
      );
      let nextText = input.text;
      let messages = context.messages;
      let continuationTurns = 0;
      let turn: AgentTurnResult;
      while (true) {
        turn = await runAgentTurn({
          pool: input.pool,
          sessionId: session.id,
          runtime,
          systemPrompt: context.systemPrompt,
          messages,
          text: nextText,
          images: continuationTurns === 0 ? input.images : undefined,
          runId,
          tools: toolSet.currentTools(),
          prepareToolsForNextTurn: toolSet.syncContext,
          onFrame: onCoreFrame,
          onMessageCompleted,
        });
        const stopReason = turn.lastAssistant?.role === "assistant"
          ? turn.lastAssistant.stopReason
          : undefined;
        if (turn.aborted || turn.llmError || turn.toolLoopError || stopReason === "aborted" || stopReason === "error" ||
            agentTurnCompleted(turn, isCompleteText)) break;
        if (continuationTurns >= maxContinuationTurns) {
          throw new Error(
            `Agent 未在 ${maxContinuationTurns + 1} 个受控执行段内生成完整最终结果` +
            `（最后 stopReason=${stopReason ?? "missing"}）`,
          );
        }
        continuationTurns += 1;
        messages = turn.messages;
        nextText = typeof input.continuationPrompt === "function"
          ? input.continuationPrompt()
          : input.continuationPrompt ?? DEFAULT_CONTINUATION_PROMPT;
      }
      flushToolUpdates();
      await frameChain;

      const redactedMessages = redactAgentMessages(turn.messages);
      const lastAssistant = [...redactedMessages].reverse().find((message) => message.role === "assistant") ?? null;
      const freshMessages = redactedMessages.slice(context.messages.length);
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
      } else if (turn.toolLoopError) {
        await persistAndPublishSessionEvent(input.pool, {
          session_id: session.id,
          event_type: "session_error",
          data: { code: "AGENT_TOOL_LOOP", message: turn.toolLoopError },
        });
        if (manageStatus) {
          await updateSessionStatus(input.pool, session.id, {
            status: "failed",
            error_summary: turn.toolLoopError,
          });
          await persistAndPublishSessionEvent(input.pool, {
            session_id: session.id,
            event_type: "session_status",
            data: { status: "failed" },
          });
        }
      } else if (turn.llmError || (turn.lastAssistant?.role === "assistant" && turn.lastAssistant.stopReason === "error")) {
        const errorMessage = turn.llmError ||
          (turn.lastAssistant?.role === "assistant" ? turn.lastAssistant.errorMessage : undefined) ||
          "LLM 调用失败";
        await persistAndPublishSessionEvent(input.pool, {
          session_id: session.id,
          event_type: "session_error",
          data: { code: "LLM_ERROR", message: errorMessage },
        });
        if (manageStatus) {
          await updateSessionStatus(input.pool, session.id, {
            status: "failed",
            error_summary: errorMessage,
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
        turn.aborted ? "cancelled" : turn.toolLoopError || turn.llmError ||
          (turn.lastAssistant?.role === "assistant" && turn.lastAssistant.stopReason === "error") ? "failed" : "complete",
        freshMessages,
      );
      return { ...turn, messages: redactedMessages, lastAssistant, freshMessages };
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
