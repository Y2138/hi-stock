/** 页面快捷入口与全局 AI 侧栏之间的轻量事件桥。 */
export const ASK_AI_EVENT = "stock:ask-ai";

export interface AskAiRequest {
  id: string;
  kind: "new_prefilled" | "open_session";
  prompt?: string;
  contextLabel?: string;
  sessionId?: string;
  sessionType?: "interactive" | "backtest" | "strategy_evolution";
  parentSessionId?: string | null;
  title?: string;
}

export interface AskAiOptions {
  sessionType?: "interactive" | "backtest" | "strategy_evolution";
  parentSessionId?: string | null;
  title?: string;
  confirmation?: string;
}

let requestSequence = 0;

/** 二次确认后新建独立会话并预填问题；是否发送仍由用户在输入框中决定。 */
export function askAi(prompt: string, contextLabel: string, options: AskAiOptions = {}): void {
  const confirmation = options.confirmation ?? `确认新建 Agent 会话并带入“${contextLabel}”上下文？\n\n会话创建后不会自动发送，请在输入框中检查后发送。`;
  if (!window.confirm(confirmation)) return;
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++requestSequence}`;
  window.dispatchEvent(
    new CustomEvent<AskAiRequest>(ASK_AI_EVENT, {
      detail: {
        id,
        kind: "new_prefilled",
        prompt,
        contextLabel,
        sessionType: options.sessionType ?? "interactive",
        parentSessionId: options.parentSessionId ?? null,
        title: options.title ?? contextLabel,
      },
    }),
  );
}

/** 打开侧边栏中的已有普通会话；用于任务触发、任务历史和领域记录回跳。 */
export function openAgentSession(sessionId: string): void {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++requestSequence}`;
  window.dispatchEvent(
    new CustomEvent<AskAiRequest>(ASK_AI_EVENT, {
      detail: { id, kind: "open_session", sessionId },
    }),
  );
}
