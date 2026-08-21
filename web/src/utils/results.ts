export type ResultType =
  | "job-output"
  | "backtest-result"
  | "memory"
  | "strategy-proposal"
  | "position-change"
  | "pool-member"
  | "job-definition";

export interface ResultRef {
  type: ResultType;
  id: string;
}

export const RESULT_OPEN_EVENT = "stock:open-result";

const RESULT_TYPES = new Set<ResultType>([
  "job-output",
  "backtest-result",
  "memory",
  "strategy-proposal",
  "position-change",
  "pool-member",
  "job-definition",
]);

const PREVIEW_TYPES = new Set<ResultType>(["job-output", "backtest-result", "memory"]);

export function serializeResultRef(result: ResultRef): string {
  return `${result.type}:${result.id}`;
}

export function parseResultRef(value: unknown): ResultRef | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const separator = raw.indexOf(":");
  if (separator < 1) return null;
  const type = raw.slice(0, separator) as ResultType;
  const id = raw.slice(separator + 1).trim();
  return RESULT_TYPES.has(type) && id ? { type, id } : null;
}

export function resultRefFromHref(href: string, base = window.location.origin): ResultRef | null {
  try {
    const url = new URL(href, base);
    if (url.origin !== new URL(base).origin) return null;
    const result = parseResultRef(url.searchParams.get("result"));
    if (result) return result;
    const legacyOutput = url.pathname === "/jobs" ? url.searchParams.get("output") : null;
    return legacyOutput ? { type: "job-output", id: legacyOutput } : null;
  } catch {
    return null;
  }
}

export function openResult(result: ResultRef): void {
  window.dispatchEvent(new CustomEvent<ResultRef>(RESULT_OPEN_EVENT, { detail: result }));
}

export function isPreviewResult(result: ResultRef): boolean {
  return PREVIEW_TYPES.has(result.type);
}

export function resultRoute(result: ResultRef): { path: string; query: Record<string, string> } | null {
  switch (result.type) {
    case "strategy-proposal":
      return { path: "/strategies", query: { proposal: result.id } };
    case "position-change":
      return { path: "/positions", query: { change: result.id } };
    case "pool-member": {
      const separator = result.id.indexOf(":");
      const pool = separator > 0 ? result.id.slice(0, separator) : "short";
      const member = separator > 0 ? result.id.slice(separator + 1) : result.id;
      return { path: pool === "long" ? "/long-pool" : "/short-pool", query: { member } };
    }
    case "job-definition":
      return { path: "/jobs", query: { job: result.id } };
    default:
      return null;
  }
}

export function resultLabel(result: ResultRef): string {
  switch (result.type) {
    case "job-output": return `查看任务结果 #${result.id}`;
    case "backtest-result": return `查看回测结论 #${result.id}`;
    case "memory": return `查看 Agent 记忆 #${result.id}`;
    case "strategy-proposal": return `查看策略提案 #${result.id}`;
    case "position-change": return `定位持仓变化 #${result.id}`;
    case "pool-member": return "定位标的池结果";
    case "job-definition": return `查看任务 ${result.id}`;
  }
}

interface ToolResultLike {
  name: string;
  status?: string;
  args?: Record<string, unknown> | null;
  resultText?: string | null;
  confirmation?: { status: string; result?: unknown } | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsedToolResult(tool: ToolResultLike): Record<string, unknown> | null {
  if (tool.confirmation) {
    return tool.confirmation.status === "approved" ? record(tool.confirmation.result) : null;
  }
  if (!tool.resultText) return null;
  try {
    const parsed = record(JSON.parse(tool.resultText));
    return parsed?.mode === "yolo" ? record(parsed.result) : parsed;
  } catch {
    return null;
  }
}

/** 只为已经成功落库、且页面有稳定落点的工具结果生成入口。 */
export function resultRefsOfTool(tool: ToolResultLike): ResultRef[] {
  if (tool.status === "error") return [];
  const result = parsedToolResult(tool);
  if (!result) return [];

  if (tool.name === "finalize_backtest" && typeof result.id === "string") {
    return [{ type: "backtest-result", id: result.id }];
  }
  if (tool.name === "memory_write" && typeof result.id === "string") {
    return [{ type: "memory", id: result.id }];
  }
  if (tool.name === "strategy_publish_request" && typeof result.proposal_id === "string") {
    return [{ type: "strategy-proposal", id: result.proposal_id }];
  }
  if (tool.name === "portfolio_write") {
    const change = record(result.change);
    if (typeof change?.id === "string") return [{ type: "position-change", id: change.id }];
  }
  if (tool.name === "pool_write") {
    const member = record(result.after) ?? record(result.before);
    if (typeof member?.pool === "string" && typeof member.code === "string") {
      return [{ type: "pool-member", id: `${member.pool}:${member.code}` }];
    }
  }
  if (
    tool.name === "job_write"
    && ["create_job", "update_job"].includes(String(tool.args?.action ?? ""))
    && typeof result.code === "string"
  ) {
    return [{ type: "job-definition", id: result.code }];
  }
  return [];
}
