// 进程内 Agent 运行注册表：把 HTTP 控制请求路由到当前会话真正运行的 pi Agent。
// run_id 是乐观并发令牌，防止迟到的停止/干预请求误伤下一轮。
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";

export type AgentControlAction = "abort" | "steer" | "follow_up";

export interface ActiveAgentRun {
  sessionId: string;
  runId: string;
  agent: Agent;
  startedAt: Date;
}

const activeRuns = new Map<string, ActiveAgentRun>();

function userMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

export function registerAgentRun(run: ActiveAgentRun): () => void {
  const existing = activeRuns.get(run.sessionId);
  if (existing?.agent.state.isStreaming) {
    throw new Error(`会话 ${run.sessionId} 已有运行中的 Agent`);
  }
  activeRuns.set(run.sessionId, run);
  return () => {
    if (activeRuns.get(run.sessionId)?.runId === run.runId) {
      activeRuns.delete(run.sessionId);
    }
  };
}

export function getActiveAgentRun(sessionId: string): ActiveAgentRun | null {
  const run = activeRuns.get(sessionId);
  return run?.agent.state.isStreaming ? run : null;
}

export function controlAgentRun(input: {
  sessionId: string;
  expectedRunId: string;
  action: AgentControlAction;
  text?: string;
}): ActiveAgentRun {
  const run = getActiveAgentRun(input.sessionId);
  if (!run) throw new Error("AGENT_NOT_RUNNING");
  if (run.runId !== input.expectedRunId) throw new Error("AGENT_RUN_MISMATCH");

  if (input.action === "abort") {
    // 用户显式停止时不再执行此前排队的干预与追问。
    run.agent.clearAllQueues();
    run.agent.abort();
    return run;
  }

  const text = input.text?.trim();
  if (!text) throw new Error("AGENT_CONTROL_TEXT_REQUIRED");
  if (input.action === "steer") run.agent.steer(userMessage(text));
  else run.agent.followUp(userMessage(text));
  return run;
}

