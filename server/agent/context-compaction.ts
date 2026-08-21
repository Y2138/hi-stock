// Agent 上下文压缩：保留原始 chat_message，仅用持久摘要替换模型可见的旧前缀。
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { ResolvedChatModel } from "./ai/runtime.js";
import type { ChatMessageRow, ChatSessionRow } from "./repo.js";
import { redactAgentMessage } from "./redaction.js";

const TRIGGER_RATIO = 0.8;
const RECENT_RATIO = 0.18;
const MAX_TOOL_RESULT_CHARS = 12_000;
const MAX_SUMMARY_CHARS = 16_000;

export interface CompactedContext {
  messages: AgentMessage[];
  systemPrompt: string;
  compacted: boolean;
  summary: string | null;
  throughSeq: number;
  estimatedTokens: number;
}

/** 中日韩字符按一字符一 token，其余按约四字符一 token，宁可略高估。 */
export function estimateContextTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / 4) + wide;
}

function assistantHasToolCall(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { role?: string; content?: unknown };
  return (
    candidate.role === "assistant" &&
    Array.isArray(candidate.content) &&
    candidate.content.some(
      (part) => part && typeof part === "object" && (part as { type?: string }).type === "toolCall",
    )
  );
}

function messageRole(message: unknown): string {
  return message && typeof message === "object"
    ? String((message as { role?: unknown }).role ?? "")
    : "";
}

/** assistant toolCall 与紧随其后的 toolResult 必须作为一个不可拆单元。 */
function atomicUnits(rows: ChatMessageRow[]): ChatMessageRow[][] {
  const units: ChatMessageRow[][] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const unit = [rows[index]!];
    if (assistantHasToolCall(rows[index]!.content)) {
      while (
        index + 1 < rows.length &&
        messageRole(rows[index + 1]!.content) === "toolResult"
      ) {
        unit.push(rows[index + 1]!);
        index += 1;
      }
    }
    units.push(unit);
  }
  return units;
}

function truncateToolResults(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== "toolResult") return message;
    const copy = structuredClone(message) as AgentMessage;
    if (copy.role !== "toolResult" || !Array.isArray(copy.content)) return copy;
    copy.content = copy.content.map((part) => {
      if (part.type !== "text" || part.text.length <= MAX_TOOL_RESULT_CHARS) return part;
      return {
        ...part,
        text: `${part.text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[旧工具结果已为上下文裁剪；原文仍保存在会话历史]`,
      };
    });
    return copy;
  });
}

function textParts(message: unknown): string {
  if (!message || typeof message !== "object") return String(message ?? "");
  const candidate = message as { content?: unknown };
  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return JSON.stringify(candidate.content ?? "");
  return candidate.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as Record<string, unknown>;
      if (item.type === "text") return String(item.text ?? "");
      if (item.type === "toolCall") {
        return `[调用工具 ${String(item.name ?? "unknown")}] ${JSON.stringify(item.arguments ?? {})}`;
      }
      return JSON.stringify(item);
    })
    .filter(Boolean)
    .join("\n");
}

function readableTranscript(rows: ChatMessageRow[]): string {
  return rows
    .map((row) => {
      const role = messageRole(row.content);
      const label = role === "user" ? "用户" : role === "assistant" ? "助手" : "工具结果";
      const text = textParts(row.content);
      const clipped = text.length > MAX_TOOL_RESULT_CHARS
        ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…[已裁剪]`
        : text;
      return `#${row.seq} ${label}：\n${clipped}`;
    })
    .join("\n\n");
}

function assistantText(message: AgentMessage | undefined): string {
  if (!message || message.role !== "assistant") return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

async function summarize(
  runtime: ResolvedChatModel,
  previousSummary: string | null,
  rows: ChatMessageRow[],
): Promise<string> {
  const transcript = readableTranscript(rows);
  const fallback = [
    previousSummary ? `已有摘要：\n${previousSummary}` : "",
    `新增旧对话记录：\n${transcript}`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_SUMMARY_CHARS);
  const model = {
    ...runtime.model,
    maxTokens: Math.min(runtime.model.maxTokens, 2_048),
  };
  const agent = new Agent({
    initialState: {
      systemPrompt: [
        "你是会话上下文压缩器。请用中文生成可供后续 Agent 继续工作的事实摘要。",
        "必须保留：用户目标与偏好、已确认决定、关键事实与数值、已完成动作及结果、未完成事项、错误与风险。",
        "不要补充原文没有的信息，不要输出寒暄或说明，只输出结构紧凑的摘要。",
      ].join("\n"),
      model,
      thinkingLevel: "low",
      tools: [],
      messages: [],
    },
    streamFn: runtime.models.streamSimple.bind(runtime.models),
  });
  try {
    await agent.prompt(fallback);
    const last = [...agent.state.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const result = assistantText(last).slice(0, MAX_SUMMARY_CHARS);
    return result || fallback;
  } catch {
    return fallback;
  }
}

function withSummary(systemPrompt: string, summary: string | null, throughSeq: number): string {
  if (!summary) return systemPrompt;
  return `${systemPrompt}\n\n## 历史会话压缩摘要（截至消息 #${throughSeq}）\n${summary}\n\n以上摘要只替代模型上下文中的旧消息；数据库仍保留完整原始历史。`;
}

export async function compactSessionContext(input: {
  session: ChatSessionRow;
  historyRows: ChatMessageRow[];
  runtime: ResolvedChatModel;
  systemPrompt: string;
}): Promise<CompactedContext> {
  const previousThrough = input.session.context_summary_through_seq ?? 0;
  const visibleRows = input.historyRows.filter((row) => row.seq > previousThrough);
  const visibleMessages = truncateToolResults(
    visibleRows.map((row) => redactAgentMessage(row.content as AgentMessage)),
  );
  const currentPrompt = withSummary(
    input.systemPrompt,
    input.session.context_summary,
    previousThrough,
  );
  const inputBudget = Math.max(
    512,
    input.runtime.model.contextWindow -
      Math.min(input.runtime.model.maxTokens, Math.floor(input.runtime.model.contextWindow * 0.25)),
  );
  const estimatedTokens =
    estimateContextTokens(currentPrompt) + estimateContextTokens(visibleMessages);
  if (estimatedTokens <= Math.floor(inputBudget * TRIGGER_RATIO) || visibleRows.length < 3) {
    return {
      messages: visibleMessages,
      systemPrompt: currentPrompt,
      compacted: false,
      summary: input.session.context_summary,
      throughSeq: previousThrough,
      estimatedTokens,
    };
  }

  const units = atomicUnits(visibleRows);
  const keepTarget = Math.max(256, Math.floor(inputBudget * RECENT_RATIO));
  let keepFrom = units.length - 1;
  let keptTokens = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unitTokens = estimateContextTokens(units[index]!.map((row) => row.content));
    if (keptTokens > 0 && keptTokens + unitTokens > keepTarget) break;
    keptTokens += unitTokens;
    keepFrom = index;
  }
  if (keepFrom <= 0) {
    return {
      messages: visibleMessages,
      systemPrompt: currentPrompt,
      compacted: false,
      summary: input.session.context_summary,
      throughSeq: previousThrough,
      estimatedTokens,
    };
  }

  const compactedRows = units.slice(0, keepFrom).flat();
  const recentRows = units.slice(keepFrom).flat();
  const throughSeq = compactedRows.at(-1)!.seq;
  const summary = await summarize(input.runtime, input.session.context_summary, compactedRows);
  const systemPrompt = withSummary(input.systemPrompt, summary, throughSeq);
  const messages = truncateToolResults(
    recentRows.map((row) => redactAgentMessage(row.content as AgentMessage)),
  );
  return {
    messages,
    systemPrompt,
    compacted: true,
    summary,
    throughSeq,
    estimatedTokens: estimateContextTokens(systemPrompt) + estimateContextTokens(messages),
  };
}
