import crypto from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Agent, type AgentContext, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import type { ResolvedChatModel } from "../ai/runtime.js";
import { sha256Json } from "../hash.js";
import { registerAgentRun } from "../run-control.js";
import { buildChatTools } from "../tools.js";
import { redactEphemeralCode, redactEphemeralToolResult } from "../redaction.js";

export interface AgentCoreFrame {
  type:
    | "run_started"
    | "assistant_start"
    | "activity"
    | "text"
    | "tool_start"
    | "tool_update"
    | "tool_end"
    | "confirmation_pending"
    | "context_compacted";
  data: Record<string, unknown>;
}

export interface AgentTurnResult {
  runId: string;
  messages: AgentMessage[];
  lastAssistant: AgentMessage | null;
  llmError: string | null;
  toolLoopError: string | null;
  aborted: boolean;
}

const MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS = 3;

/**
 * pi-agent-core 的唯一 loop 边界：恢复历史、注册工具、运行 prompt、映射领域无关事件。
 * HTTP/SSE、数据库消息持久化和前端展示均在此层之外。
 */
export async function runAgentTurn(deps: {
  pool: pg.Pool;
  sessionId: string;
  runtime: ResolvedChatModel;
  systemPrompt: string;
  messages: AgentMessage[];
  text: string;
  images?: ImageContent[];
  runId?: string;
  /** 自动作业等受控场景可覆盖工具集；缺省仍使用完整会话工具。 */
  tools?: AgentTool[];
  /** 工具目录可在当前执行段内按需加载完整 schema。 */
  prepareToolsForNextTurn?: (context: AgentContext) => AgentContext | undefined;
  onFrame: (frame: AgentCoreFrame) => void;
  onMessageCompleted?: (message: AgentMessage) => Promise<void> | void;
}): Promise<AgentTurnResult> {
  const runId = deps.runId ?? crypto.randomUUID();
  let lastToolSignature: string | null = null;
  let consecutiveIdenticalToolCalls = 0;
  let toolLoopError: string | null = null;
  const agent = new Agent({
    initialState: {
      systemPrompt: deps.systemPrompt,
      model: deps.runtime.model,
      thinkingLevel: "medium",
      tools: deps.tools ?? buildChatTools({ pool: deps.pool, sessionId: deps.sessionId }),
      messages: deps.messages,
    },
    streamFn: deps.runtime.models.streamSimple.bind(deps.runtime.models),
    beforeToolCall: async ({ toolCall, args }) => {
      const signature = sha256Json({ name: toolCall.name, args });
      consecutiveIdenticalToolCalls = signature === lastToolSignature
        ? consecutiveIdenticalToolCalls + 1
        : 1;
      lastToolSignature = signature;
      if (consecutiveIdenticalToolCalls < MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS) return undefined;
      toolLoopError =
        `检测到 Agent 连续 ${MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS} 次请求相同工具与参数，` +
        `已熔断本次运行：${toolCall.name}`;
      return { block: true, reason: toolLoopError, terminate: true };
    },
    shouldStopAfterTurn: () => toolLoopError !== null,
    prepareNextTurnWithContext: deps.prepareToolsForNextTurn
      ? ({ context }) => {
          const next = deps.prepareToolsForNextTurn!(context);
          return next ? { context: next } : undefined;
        }
      : undefined,
    sessionId: `chat-${deps.sessionId}`,
  });

  let llmError: string | null = null;
  let lastActivity = "";
  let lastActivityAt = 0;
  let activityStartedAt = 0;
  const activeToolNames = new Map<string, string>();
  const activity = (phase: string, toolName?: string, progress?: { completed: number; total: number }) => {
    const at = Date.now();
    const key = `${phase}:${toolName ?? ""}`;
    if (key === lastActivity && at - lastActivityAt < 1_000) return;
    if (key !== lastActivity) activityStartedAt = at;
    lastActivity = key;
    lastActivityAt = at;
    deps.onFrame({ type: "activity", data: { phase, tool_name: toolName, ...progress, at, started_at: activityStartedAt } });
  };
  const unsubscribe = agent.subscribe(async (event) => {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          activity("thinking");
          deps.onFrame({
            type: "assistant_start",
            data: { timestamp: event.message.timestamp },
          });
        }
        break;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          activity("writing");
          deps.onFrame({ type: "text", data: { delta: update.delta } });
        } else if (update.type === "thinking_delta") {
          activity("thinking");
        } else if (update.type === "toolcall_start" || update.type === "toolcall_delta") {
          const part = update.partial.content[update.contentIndex];
          if (part?.type === "toolCall" && part.name) activity("preparing_tool", part.name);
        } else if (update.type === "error" && update.error.stopReason !== "aborted") {
          llmError = update.error.errorMessage ?? "LLM 调用失败";
        }
        break;
      }
      case "message_end":
        await deps.onMessageCompleted?.(event.message);
        break;
      case "tool_execution_start":
        activeToolNames.set(event.toolCallId, event.toolName);
        activity("executing_tool", event.toolName);
        deps.onFrame({
          type: "tool_start",
          data: {
            toolCallId: event.toolCallId,
            name: event.toolName,
            args: redactEphemeralCode(event.args) as Record<string, unknown>,
          },
        });
        break;
      case "tool_execution_update":
        {
          const details = (event.partialResult as { details?: { summary?: { completed?: unknown; total?: unknown } } })?.details;
          const summary = details?.summary;
          activity("executing_tool", event.toolName,
            typeof summary?.completed === "number" && typeof summary.total === "number"
              ? { completed: summary.completed, total: summary.total } : undefined);
        }
        deps.onFrame({
          type: "tool_update",
          data: {
            toolCallId: event.toolCallId,
            name: event.toolName,
            result: redactEphemeralToolResult(event.partialResult),
          },
        });
        break;
      case "tool_execution_end": {
        activeToolNames.delete(event.toolCallId);
        const remainingTool = activeToolNames.values().next().value;
        activity(remainingTool ? "executing_tool" : event.isError ? "tool_failed" : "tool_finished", remainingTool ?? event.toolName);
        deps.onFrame({
          type: "tool_end",
          data: {
            toolCallId: event.toolCallId,
            name: event.toolName,
            result: redactEphemeralToolResult(event.result),
            isError: event.isError,
          },
        });
        const details = (event.result as { details?: Record<string, unknown> } | null)?.details;
        if (details?.confirmation_id && !details.auto_approved) {
          deps.onFrame({
            type: "confirmation_pending",
            data: {
              confirmation_id: details.confirmation_id,
              tool_name: event.toolName,
              payload: details.payload,
            },
          });
        }
        break;
      }
      default:
        break;
    }
  });
  const activeRun = {
    sessionId: deps.sessionId,
    runId,
    agent,
    startedAt: new Date(),
    abortRequested: false,
  };
  const unregister = registerAgentRun(activeRun);
  deps.onFrame({ type: "run_started", data: { run_id: runId } });

  try {
    await agent.prompt(deps.text, deps.images?.length ? deps.images : undefined);
    const messages = [...agent.state.messages];
    const lastAssistant =
      [...messages].reverse().find((message) => message.role === "assistant") ?? null;
    return {
      runId,
      messages,
      lastAssistant,
      llmError,
      toolLoopError,
      aborted:
        activeRun.abortRequested ||
        (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "aborted"),
    };
  } finally {
    unregister();
    unsubscribe();
  }
}
