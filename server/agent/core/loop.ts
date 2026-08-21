import crypto from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import type { ResolvedChatModel } from "../ai/runtime.js";
import { registerAgentRun } from "../run-control.js";
import { buildChatTools } from "../tools.js";
import { redactAgentMessages, redactEphemeralCode } from "../redaction.js";

export interface AgentCoreFrame {
  type:
    | "run_started"
    | "assistant_start"
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
  aborted: boolean;
}

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
  onFrame: (frame: AgentCoreFrame) => void;
  onMessageCompleted?: (message: AgentMessage) => Promise<void> | void;
}): Promise<AgentTurnResult> {
  const runId = deps.runId ?? crypto.randomUUID();
  const agent = new Agent({
    initialState: {
      systemPrompt: deps.systemPrompt,
      model: deps.runtime.model,
      thinkingLevel: "medium",
      tools: deps.tools ?? buildChatTools({ pool: deps.pool, sessionId: deps.sessionId }),
      messages: deps.messages,
    },
    streamFn: deps.runtime.models.streamSimple.bind(deps.runtime.models),
    sessionId: `chat-${deps.sessionId}`,
  });

  let llmError: string | null = null;
  const unsubscribe = agent.subscribe(async (event) => {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          deps.onFrame({
            type: "assistant_start",
            data: { timestamp: event.message.timestamp },
          });
        }
        break;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          deps.onFrame({ type: "text", data: { delta: update.delta } });
        } else if (update.type === "error" && update.error.stopReason !== "aborted") {
          llmError = update.error.errorMessage ?? "LLM 调用失败";
        }
        break;
      }
      case "message_end":
        await deps.onMessageCompleted?.(event.message);
        break;
      case "tool_execution_start":
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
        deps.onFrame({
          type: "tool_update",
          data: {
            toolCallId: event.toolCallId,
            name: event.toolName,
            result: event.partialResult,
          },
        });
        break;
      case "tool_execution_end": {
        deps.onFrame({
          type: "tool_end",
          data: {
            toolCallId: event.toolCallId,
            name: event.toolName,
            result: event.result,
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
  const unregister = registerAgentRun({
    sessionId: deps.sessionId,
    runId,
    agent,
    startedAt: new Date(),
  });
  deps.onFrame({ type: "run_started", data: { run_id: runId } });

  try {
    await agent.prompt(deps.text, deps.images?.length ? deps.images : undefined);
    const messages = redactAgentMessages([...agent.state.messages]);
    const lastAssistant =
      [...messages].reverse().find((message) => message.role === "assistant") ?? null;
    return {
      runId,
      messages,
      lastAssistant,
      llmError,
      aborted:
        lastAssistant?.role === "assistant" && lastAssistant.stopReason === "aborted",
    };
  } finally {
    unregister();
    unsubscribe();
  }
}
