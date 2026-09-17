import crypto from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const EPHEMERAL_CODE_KEYS = new Set([
  "source_code",
  "code_body",
  "script_body",
  "patch",
]);
const PRIVATE_PATH_KEYS = new Set(["workspace_path", "temporary_path"]);

function sourceSummary(value: unknown): Record<string, unknown> {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return {
    source_code_sha256: crypto.createHash("sha256").update(text).digest("hex"),
    source_size_bytes: Buffer.byteLength(text, "utf8"),
    source_code_persisted: false,
  };
}

/**
 * 回测源码可以由回测领域表受控保存，但不得进入消息、事件、审计和资源元数据。
 */
export function redactEphemeralCode(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[层级截断]";
  if (Array.isArray(value)) return value.map((item) => redactEphemeralCode(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  // pg 会把 timestamptz 返回为 Date。递归 Object.entries(Date) 会得到空对象，
  // 进而破坏初始化包中的时间戳；进入通用对象脱敏前先固定为 ISO 文本。
  if (value instanceof Date) return value.toISOString();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const result: Record<string, unknown> = {};
  let sourceCode: unknown;
  let hasSourceCode = false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (EPHEMERAL_CODE_KEYS.has(key)) {
      if (key === "source_code") {
        sourceCode = child;
        hasSourceCode = true;
      }
      else result[`${key}_persisted`] = false;
      continue;
    }
    if (PRIVATE_PATH_KEYS.has(key)) {
      result[`${key}_persisted`] = false;
      continue;
    }
    result[key] = redactEphemeralCode(child, depth + 1);
  }
  if (hasSourceCode) Object.assign(result, sourceSummary(sourceCode));
  return result;
}

/**
 * pi 会把工具调用参数放进 assistant message。临时结果连同说明文本一并收敛为固定提示，
 * 避免模型把临时数据明细复制进自然语言消息。
 */
export function redactAgentMessage(message: AgentMessage): AgentMessage {
  const ephemeralDataResult = message.role === "toolResult"
    && Boolean((message as AgentMessage & { details?: { ephemeral_data_result?: boolean } }).details?.ephemeral_data_result);
  const copy = redactEphemeralCode(message) as AgentMessage;
  if (ephemeralDataResult && copy.role === "toolResult" && Array.isArray(copy.content)) {
    copy.content = [{ type: "text", text: "已向 Agent 提供扶摇临时查询结果；数据明细不会保存到会话。" }];
    return copy;
  }
  if (copy.role !== "assistant") return copy;
  if (!copy.usage || typeof copy.usage !== "object") {
    copy.usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }
  return copy;
}

export function redactAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map(redactAgentMessage);
}

/** SSE 和低频事件只保留临时工具结果元数据，当前模型仍使用工具返回的原始内容。 */
export function redactEphemeralToolResult(value: unknown): unknown {
  const details = value && typeof value === "object"
    ? (value as { details?: { ephemeral_data_result?: boolean } }).details
    : null;
  if (!details?.ephemeral_data_result) return redactEphemeralCode(value);
  const redacted = redactEphemeralCode(value) as Record<string, unknown>;
  return {
    ...redacted,
    content: [{ type: "text", text: "已向 Agent 提供扶摇临时查询结果；数据明细不会保存到会话。" }],
  };
}
