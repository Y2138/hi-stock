// 对话界面展示模型：pi AgentMessage JSON（chat_message.content）→ 渲染用 UiMessage
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §6.1（content 纯 JSON 持久化）
import type { ChatMessageRow, Confirmation, ConfirmationStatus } from "../api/types";

export interface UiConfirmation {
  id: string;
  payload: unknown;
  status: ConfirmationStatus;
  result: unknown;
  /** approve/reject 请求进行中 */
  acting: boolean;
  error: string | null;
}

export interface UiToolCall {
  /** toolCallId */
  id: string;
  name: string;
  args: Record<string, unknown> | null;
  status: "running" | "done" | "error";
  resultText: string | null;
  confirmation: UiConfirmation | null;
  /** 结果摘要展开态 */
  expanded: boolean;
}

export interface UiMessage {
  key: string;
  role: "user" | "assistant";
  createdAt: string;
  text: string;
  /** data: URL 缩略图（pi ImageContent base64 / 本地上传 object URL） */
  images: string[];
  tools: UiToolCall[];
  streaming?: boolean;
  /** 本轮错误条（中断/LLM 错误时保留已产出部分） */
  errorText?: string | null;
}

export interface UiUserTurn {
  key: string;
  role: "user";
  message: UiMessage;
}

export interface UiAgentTurn {
  key: string;
  role: "agent";
  /** 同一用户轮次内，模型可能因工具调用产生多条连续 assistant 消息。 */
  messages: UiMessage[];
}

export type UiConversationTurn = UiUserTurn | UiAgentTurn;

export interface UiToolGroup {
  key: string;
  name: string;
  tools: UiToolCall[];
}

/** 连续同名且无需确认的调用折叠成一组；确认卡始终独立展示，不能被隐藏。 */
export function groupToolCalls(tools: UiToolCall[]): UiToolGroup[] {
  const groups: UiToolGroup[] = [];
  for (const tool of tools) {
    const previous = groups[groups.length - 1];
    if (
      !tool.confirmation &&
      previous &&
      previous.name === tool.name &&
      previous.tools.every((item) => !item.confirmation)
    ) {
      previous.tools.push(tool);
    } else {
      groups.push({ key: tool.id, name: tool.name, tools: [tool] });
    }
  }
  return groups;
}

/**
 * 把连续 assistant 消息聚合成一轮连续 Agent 回复流。
 * toolResult 不会生成 UiMessage，因此历史恢复与实时流都以用户消息作为稳定轮次边界。
 */
export function groupMessagesIntoTurns(
  messages: UiMessage[],
  pendingAssistantKey?: string,
  pendingAssistantCreatedAt?: string,
): UiConversationTurn[] {
  const turns: UiConversationTurn[] = [];
  const renderedMessages = pendingAssistantKey && !messages.some((message) => message.streaming)
    ? [
        ...messages,
        {
          key: pendingAssistantKey,
          role: "assistant" as const,
          createdAt: pendingAssistantCreatedAt ?? new Date().toISOString(),
          text: "",
          images: [],
          tools: [],
          streaming: true,
          errorText: null,
        },
      ]
    : messages;
  for (const message of renderedMessages) {
    if (message.role === "user") {
      turns.push({ key: message.key, role: "user", message });
      continue;
    }
    const previous = turns[turns.length - 1];
    if (previous?.role === "agent") {
      previous.messages.push(message);
    } else {
      turns.push({ key: `agent-${message.key}`, role: "agent", messages: [message] });
    }
  }
  return turns;
}

// ---- pi 消息 JSON 的最小结构（与 @earendil-works/pi-ai types 对齐，前端不直接依赖该包） ----

interface PiTextBlock {
  type: "text";
  text: string;
}
interface PiImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}
interface PiToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
type PiBlock = PiTextBlock | PiImageBlock | PiToolCallBlock | { type: string };

interface PiUserMessage {
  role: "user";
  content: string | PiBlock[];
}
interface PiAssistantMessage {
  role: "assistant";
  content: PiBlock[];
  stopReason?: string;
  errorMessage?: string;
}
interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  content: PiBlock[];
  details?: { confirmation_id?: string; payload?: unknown; auto_approved?: boolean };
  isError: boolean;
}
type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

/** 工具结果对象（{content:[{type:'text',text}],details}）→ 纯文本摘要 */
export function resultTextOf(result: unknown): string | null {
  if (result === null || result === undefined) return null;
  const content = (result as { content?: PiBlock[] }).content;
  if (Array.isArray(content)) {
    const text = content
      .filter((b): b is PiTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 1);
  } catch {
    return String(result);
  }
}

/**
 * 历史消息行 → 渲染模型：user（文本/图片）、assistant（文本 + 工具卡占位）、
 * toolResult 回填工具卡状态与结果摘要；确认卡状态以 confirmation 表查询结果为准。
 */
export function rowsToMessages(rows: ChatMessageRow[], confirmations: Confirmation[]): UiMessage[] {
  const confById = new Map(confirmations.map((c) => [c.id, c]));
  const toolByCallId = new Map<string, UiToolCall>();
  const out: UiMessage[] = [];

  for (const row of rows) {
    const msg = row.content as PiMessage;
    if (!msg || typeof msg !== "object") continue;

    if (msg.role === "user") {
      const ui: UiMessage = {
        key: row.id,
        role: "user",
        createdAt: row.created_at,
        text: "",
        images: [],
        tools: [],
      };
      if (typeof msg.content === "string") {
        ui.text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === "text") ui.text += (ui.text ? "\n" : "") + (b as PiTextBlock).text;
          else if (b.type === "image") {
            const img = b as PiImageBlock;
            ui.images.push(`data:${img.mimeType};base64,${img.data}`);
          }
        }
      }
      out.push(ui);
    } else if (msg.role === "assistant") {
      const ui: UiMessage = {
        key: row.id,
        role: "assistant",
        createdAt: row.created_at,
        text: "",
        images: [],
        tools: [],
      };
      for (const b of msg.content ?? []) {
        if (b.type === "text") ui.text += (b as PiTextBlock).text;
        else if (b.type === "toolCall") {
          const call = b as PiToolCallBlock;
          const tool: UiToolCall = {
            id: call.id,
            name: call.name,
            args: call.arguments ?? null,
            status: "running",
            resultText: null,
            confirmation: null,
            expanded: false,
          };
          ui.tools.push(tool);
          toolByCallId.set(call.id, tool);
        }
      }
      if (msg.stopReason === "aborted") {
        // OpenAI Responses 在主动中断时可能附带“未收到终态事件”的底层错误；
        // 这是中断结果，不是重新打开会话时应展示的 LLM 故障。
        ui.errorText = "已中断";
      } else if (msg.stopReason === "error" || msg.errorMessage) {
        ui.errorText = msg.errorMessage ?? "LLM 调用失败";
      }
      out.push(ui);
    } else if (msg.role === "toolResult") {
      const tool = toolByCallId.get(msg.toolCallId);
      if (!tool) continue;
      tool.status = msg.isError ? "error" : "done";
      tool.resultText = resultTextOf({ content: msg.content });
      const details = msg.details;
      if (details?.confirmation_id) {
        const conf = confById.get(details.confirmation_id);
        tool.confirmation = {
          id: details.confirmation_id,
          payload: details.payload ?? conf?.payload ?? null,
          status: conf?.status ?? (details.auto_approved ? "approved" : "pending"),
          result: conf?.result ?? null,
          acting: false,
          error: null,
        };
      }
    }
  }
  return out;
}
