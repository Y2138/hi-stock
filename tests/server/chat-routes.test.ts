// 对话 HTTP/SSE 路由测试（M2）：faux provider 全链路
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §6.1/§6.4/§十二
// - POST /api/chat/:sessionId/messages：SSE 帧 text/tool_*/confirmation_pending/done
// - 会话/消息持久化往返（chat_message.content 纯 JSON 恢复）
// - 未配置降级：数据库未选当前模型 / 当前厂商无 key → 503 LLM_NOT_CONFIGURED
// - 附件上传（multipart）与确认结果事件通道（GET .../events 长连 SSE）
// 无 LLM 真实调用：pi-ai fauxProvider 脚本化响应（设计 §十二）。
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import fs from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../server/db/migrate.js";
import { setAiRuntimeForTests } from "../../server/agent/ai/runtime.js";
import { createConfirmation } from "../../server/agent/confirmations.js";
import {
  appendChatSessionEvent,
  listChatSessionEvents,
  persistAndPublishSessionEvent,
} from "../../server/agent/events.js";
import { appendMessage, createSession, getSession } from "../../server/agent/repo.js";
import { getActiveAgentRun } from "../../server/agent/run-control.js";
import { recoverInterruptedAgentSessions } from "../../server/agent/session-runner.js";
import { UPLOADS_DIR } from "../../server/agent/routes.js";
import { groupMessagesIntoTurns, rowsToMessages } from "../../web/src/utils/chat.js";
import { parseResultRef, resultRefFromHref, resultRefsOfTool } from "../../web/src/utils/results.js";
import { api, prepareTestDb, resetSchema, seedTestStrategy, startTestServer, type TestServer } from "./helpers.js";

const prepared = await prepareTestDb();

describe("落库结果引用", () => {
  it("解析新旧任务结果链接，并且只暴露已完成写入的工具结果", () => {
    expect(parseResultRef("job-output:21")).toEqual({ type: "job-output", id: "21" });
    expect(resultRefFromHref("/jobs?output=21", "http://stock.local")).toEqual({ type: "job-output", id: "21" });
    expect(resultRefsOfTool({
      name: "memory_write",
      status: "done",
      confirmation: { status: "approved", result: { id: "8" } },
    })).toEqual([{ type: "memory", id: "8" }]);
    expect(resultRefsOfTool({
      name: "finalize_backtest",
      status: "done",
      confirmation: { status: "pending", result: null },
    })).toEqual([]);
    expect(resultRefsOfTool({
      name: "portfolio_write",
      status: "done",
      resultText: JSON.stringify({ mode: "yolo", result: { change: { id: "12" } } }),
    })).toEqual([{ type: "position-change", id: "12" }]);
  });
});

/** 读取 SSE 响应全文并解析为帧数组 */
async function readSse(res: Response): Promise<{ type: string; data: unknown }[]> {
  const text = await res.text();
  const frames: { type: string; data: unknown }[] = [];
  for (const block of text.split("\n\n")) {
    const eventLine = block.split("\n").find((l) => l.startsWith("event: "));
    const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
    if (eventLine && dataLine) {
      frames.push({ type: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
    }
  }
  return frames;
}

describe.skipIf(!prepared)("对话 HTTP/SSE 路由（stock_test 真实库 + faux model）", () => {
  let pool: pg.Pool;
  let server: TestServer;
  let faux: ReturnType<typeof fauxProvider>;

  function useFauxRuntime(): void {
    const models = createModels();
    models.setProvider(faux.provider);
    const model = models.getModels("faux")[0]!;
    setAiRuntimeForTests({
      models,
      model,
      provider: "faux",
      providerName: "Faux",
      modelId: model.id,
    });
  }

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
    await seedTestStrategy(pool);
    await pool.query(
      "INSERT INTO market_instrument (code, name, kind) VALUES ('990003.SZ', '对话测试股份', 'stock')",
    );

    faux = fauxProvider();
    useFauxRuntime();

    server = await startTestServer(pool);
  });

  afterAll(async () => {
    setAiRuntimeForTests(null);
    await server.close();
    await pool.end();
  });

  async function postSse(sessionId: string, body: unknown) {
    const res = await fetch(`${server.baseUrl}/api/chat/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, frames: await readSse(res) };
  }

  async function waitForActiveRun(sessionId: string) {
    for (let index = 0; index < 100; index += 1) {
      const run = getActiveAgentRun(sessionId);
      if (run) return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`等待 Agent 运行超时：${sessionId}`);
  }

  it("会话创建与列表", async () => {
    const created = await api(server.baseUrl, "POST", "/api/chat/sessions", { title: "测试会话" });
    expect(created.status).toBe(201);
    const listed = await api(server.baseUrl, "GET", "/api/chat/sessions");
    expect(listed.status).toBe(200);
    expect((listed.json as unknown as unknown[]).length).toBeGreaterThan(0);
  });

  it("统一对话仓储保存任务状态与可重放事件，任务也进入会话列表", async () => {
    const session = await createSession(pool, {
      title: "任务 session 仓储测试",
      session_type: "job",
      session_status: "queued",
      source: "manual_job",
    });
    const first = await appendChatSessionEvent(pool, {
      session_id: session.id,
      event_type: "session_status",
      data: { status: "running" },
    });
    const second = await appendChatSessionEvent(pool, {
      session_id: session.id,
      event_type: "session_status",
      data: { status: "success" },
    });
    const replay = await listChatSessionEvents(pool, session.id, first.id);
    expect(replay.map((event) => event.id)).toEqual([second.id]);
    expect(await getSession(pool, session.id)).toMatchObject({
      session_type: "job",
      session_status: "queued",
    });

    const listed = await api(server.baseUrl, "GET", "/api/chat/sessions");
    expect(
      (listed.json as unknown as { id: string }[]).some((item) => item.id === session.id),
    ).toBe(true);
  });

  it("服务重启收敛失去进程内 Agent 的运行中会话", async () => {
    const session = await createSession(pool, {
      title: "重启中断会话",
      session_status: "running",
    });
    const at = new Date("2026-08-20T13:00:00.000Z");
    expect(await recoverInterruptedAgentSessions(pool, at)).toBe(1);
    expect(await getSession(pool, session.id)).toMatchObject({
      session_status: "failed",
      finished_at: at,
      last_error_summary: "服务重启：上一进程中的 Agent 运行已中断",
    });
    const events = await listChatSessionEvents(pool, session.id);
    expect(events.slice(-2).map((event) => event.event_type)).toEqual([
      "session_error",
      "session_status",
    ]);
  });

  it("运行控制：run_id 防误投，steering 与 follow-up 在各自边界继续同一会话", async () => {
    faux = fauxProvider({ tokensPerSecond: 80, tokenSize: { min: 1, max: 1 } });
    useFauxRuntime();
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxText("正在处理第一步。".repeat(20))]),
        fauxAssistantMessage([fauxText("已按干预调整当前任务。")]),
        fauxAssistantMessage([fauxText("并已处理排队追问。")]),
      ]);
      const session = await createSession(pool, "运行控制测试");
      const response = await fetch(`${server.baseUrl}/api/chat/${session.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "先执行原任务" }),
      });
      const run = await waitForActiveRun(session.id);
      const mismatch = await api(server.baseUrl, "POST", `/api/chat/${session.id}/control`, {
        action: "steer",
        text: "不要误投",
        run_id: "过期-run-id",
      });
      expect(mismatch.status).toBe(409);
      expect((mismatch.json as { error: { code: string } }).error.code).toBe("AGENT_RUN_MISMATCH");

      const steered = await api(server.baseUrl, "POST", `/api/chat/${session.id}/control`, {
        action: "steer",
        text: "改为先核对风险",
        run_id: run.runId,
      });
      const followed = await api(server.baseUrl, "POST", `/api/chat/${session.id}/control`, {
        action: "follow_up",
        text: "最后给一句总结",
        run_id: run.runId,
      });
      expect(steered.status).toBe(202);
      expect(followed.status).toBe(202);

      const frames = await readSse(response);
      expect(frames.filter((frame) => frame.type === "assistant_start")).toHaveLength(3);
      expect(frames.map((frame) => frame.type)).toContain("done");
      const rows = await pool.query<{ role: string }>(
        "SELECT role FROM chat_message WHERE session_id = $1 ORDER BY seq",
        [session.id],
      );
      expect(rows.rows.map((row) => row.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
    } finally {
      faux = fauxProvider();
      useFauxRuntime();
    }
  }, 15_000);

  it("真正中断服务端 Agent 并持久化 cancelled 状态", async () => {
    faux = fauxProvider({ tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } });
    useFauxRuntime();
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxText("这是一段尚未完成的长回复。".repeat(80))]),
      ]);
      const session = await createSession(pool, "中断测试");
      const response = await fetch(`${server.baseUrl}/api/chat/${session.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "开始长任务" }),
      });
      const run = await waitForActiveRun(session.id);
      const stopped = await api(server.baseUrl, "POST", `/api/chat/${session.id}/control`, {
        action: "abort",
        run_id: run.runId,
      });
      expect(stopped.status).toBe(202);
      const frames = await readSse(response);
      expect(frames.map((frame) => frame.type)).toContain("aborted");
      expect(getActiveAgentRun(session.id)).toBeNull();
      const status = await pool.query<{ session_status: string }>(
        "SELECT session_status FROM chat_session WHERE id = $1",
        [session.id],
      );
      expect(status.rows[0]!.session_status).toBe("cancelled");
    } finally {
      faux = fauxProvider();
      useFauxRuntime();
    }
  }, 15_000);

  it("任务合成消息缺失 usage 时落库补齐，旧消息恢复后仍可继续追问", async () => {
    const session = await createSession(pool, "任务会话继续追问");
    await appendMessage(pool, {
      session_id: session.id,
      seq: 1,
      role: "assistant",
      json: {
        role: "assistant",
        content: [{ type: "text", text: "任务结果已保存" }],
        stopReason: "stop",
        timestamp: Date.now(),
      },
    });
    const stored = await pool.query<{ usage: { totalTokens: number } }>(
      "SELECT content->'usage' AS usage FROM chat_message WHERE session_id=$1 AND seq=1",
      [session.id],
    );
    expect(stored.rows[0]!.usage.totalTokens).toBe(0);

    await pool.query(
      "UPDATE chat_message SET content=content-'usage' WHERE session_id=$1 AND seq=1",
      [session.id],
    );
    faux.setResponses([fauxAssistantMessage([fauxText("历史任务会话可继续追问")])]);
    const result = await postSse(session.id, { text: "继续解读结果" });
    expect(result.frames.some((frame) => frame.type === "error")).toBe(false);
    expect(result.frames.map((frame) => frame.type)).toContain("done");
  });

  it("上下文压缩只替换模型视图，完整原始消息仍保留", async () => {
    faux = fauxProvider({
      models: [{ id: "faux-small", contextWindow: 600, maxTokens: 100 }],
      tokensPerSecond: 10_000,
    });
    useFauxRuntime();
    try {
      const session = await createSession(pool, "压缩测试");
      let seq = 1;
      for (let index = 0; index < 8; index += 1) {
        for (const message of [
          {
            role: "user",
            content: [{ type: "text", text: `第 ${index + 1} 轮用户事实：${"需要保留的上下文。".repeat(24)}` }],
            timestamp: Date.now(),
          },
          fauxAssistantMessage([fauxText(`第 ${index + 1} 轮结论：${"已经确认。".repeat(24)}`)]),
        ]) {
          await appendMessage(pool, {
            session_id: session.id,
            seq,
            role: message.role,
            json: message,
          });
          seq += 1;
        }
      }
      const before = Number(
        (await pool.query("SELECT count(*)::int AS count FROM chat_message WHERE session_id = $1", [session.id])).rows[0]!.count,
      );
      faux.setResponses([
        fauxAssistantMessage([fauxText("用户在前八轮确认了关键事实与结论，后续需要继续沿用。")]),
        fauxAssistantMessage([fauxText("已在压缩上下文后继续回答。")]),
      ]);
      const result = await postSse(session.id, { text: "继续这个任务" });
      expect(result.frames.map((frame) => frame.type)).toContain("context_compacted");
      const checkpoint = await pool.query<{
        context_summary: string | null;
        context_summary_through_seq: number;
      }>(
        "SELECT context_summary, context_summary_through_seq FROM chat_session WHERE id = $1",
        [session.id],
      );
      expect(checkpoint.rows[0]!.context_summary).toContain("关键事实");
      expect(checkpoint.rows[0]!.context_summary_through_seq).toBeGreaterThan(0);
      const after = Number(
        (await pool.query("SELECT count(*)::int AS count FROM chat_message WHERE session_id = $1", [session.id])).rows[0]!.count,
      );
      expect(after).toBe(before + 2);
    } finally {
      faux = fauxProvider();
      useFauxRuntime();
    }
  }, 15_000);

  it("SSE 消息流：text + done 帧，消息持久化往返", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("你好，我是工作台助手")])]);
    const session = await createSession(pool);
    const { status, frames } = await postSse(session.id, { text: "你好" });
    expect(status).toBe(200);
    const types = frames.map((f) => f.type);
    expect(types).toContain("text");
    expect(types).toContain("done");
    const deltas = frames.filter((f) => f.type === "text").map((f) => (f.data as { delta: string }).delta);
    expect(deltas.join("")).toContain("你好");

    // 持久化：user + assistant 两条
    const messages = await api(server.baseUrl, "GET", `/api/chat/sessions/${session.id}/messages`);
    expect(messages.status).toBe(200);
    const rows = messages.json as unknown as {
      seq: number;
      role: string;
      content: { role: string };
    }[];
    expect(rows.length).toBe(2);
    expect(rows[0]!.role).toBe("user");
    expect(rows[1]!.role).toBe("assistant");
    expect(rows[1]!.content.role).toBe("assistant");
    const persistedEvents = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM chat_session_event WHERE session_id = $1 ORDER BY id",
      [session.id],
    );
    expect(persistedEvents.rows.filter((row) => row.event_type === "message_completed")).toHaveLength(2);
    expect(persistedEvents.rows.some((row) => row.event_type === "text")).toBe(false);
    expect((await pool.query("SELECT session_status FROM chat_session WHERE id = $1", [session.id])).rows[0]!.session_status).toBe("idle");

    // 第二轮：历史恢复不冲突，seq 续接
    faux.setResponses([fauxAssistantMessage([fauxText("第二轮")])]);
    const second = await postSse(session.id, { text: "继续" });
    expect(second.frames.map((f) => f.type)).toContain("done");
    const after = await api(server.baseUrl, "GET", `/api/chat/sessions/${session.id}/messages`);
    expect((after.json as unknown as unknown[]).length).toBe(4);
  });

  it("历史恢复把主动中断显示为已中断，不泄露 Responses 缺少终态的适配器错误", () => {
    const rendered = rowsToMessages([
      {
        id: "aborted-assistant",
        session_id: "1",
        seq: 1,
        role: "assistant",
        content: {
          role: "assistant",
          content: [],
          stopReason: "aborted",
          errorMessage: "OpenAI Responses stream ended before a terminal response event",
        },
        created_at: "2026-08-18T00:00:00.000Z",
      },
    ], []);

    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.errorText).toBe("已中断");
  });

  it("连续 assistant 消息按用户轮次聚合为一张 Agent 执行轨迹卡", () => {
    const rendered = rowsToMessages([
      {
        id: "user-1", session_id: "1", seq: 1, role: "user",
        content: { role: "user", content: "检查持仓" }, created_at: "2026-08-19T00:00:00.000Z",
      },
      {
        id: "assistant-1", session_id: "1", seq: 2, role: "assistant",
        content: {
          role: "assistant",
          content: [
            { type: "text", text: "先读取当前持仓。" },
            { type: "toolCall", id: "tool-1", name: "database_query", arguments: { queries: [] } },
          ],
        },
        created_at: "2026-08-19T00:00:01.000Z",
      },
      {
        id: "tool-result-1", session_id: "1", seq: 3, role: "tool",
        content: {
          role: "toolResult", toolCallId: "tool-1", isError: false,
          content: [{ type: "text", text: "查询完成" }],
        },
        created_at: "2026-08-19T00:00:02.000Z",
      },
      {
        id: "assistant-2", session_id: "1", seq: 4, role: "assistant",
        content: { role: "assistant", content: [{ type: "text", text: "当前有 2 只持仓。" }] },
        created_at: "2026-08-19T00:00:03.000Z",
      },
    ], []);

    const turns = groupMessagesIntoTurns(rendered);
    expect(rendered.map((message) => message.createdAt)).toEqual([
      "2026-08-19T00:00:00.000Z",
      "2026-08-19T00:00:01.000Z",
      "2026-08-19T00:00:03.000Z",
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.role).toBe("user");
    expect(turns[1]!.role).toBe("agent");
    if (turns[1]!.role !== "agent") throw new Error("第二项应为 Agent 轮次");
    expect(turns[1]!.messages).toHaveLength(2);
    expect(turns[1]!.messages[0]!.tools[0]).toMatchObject({ status: "done", resultText: "查询完成" });
    expect(turns[1]!.messages[1]!.text).toBe("当前有 2 只持仓。");

    const runningTurns = groupMessagesIntoTurns(rendered, "pending-1");
    expect(runningTurns).toHaveLength(2);
    if (runningTurns[1]!.role !== "agent") throw new Error("第二项应为 Agent 轮次");
    expect(runningTurns[1]!.messages.at(-1)).toMatchObject({
      key: "pending-1",
      streaming: true,
      text: "",
    });
  });

  it("SSE 消息流：工具调用帧 + confirmation_pending（写类工具不直接写库）", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("portfolio_write", {
            reason: "登记用户要求的买入",
            code: "990003.SZ",
            kind: "buy",
            quantity: 10,
            price: 12,
            change_date: "2026-08-17",
            decision_origin: "strategy_signal",
            execution_compliance: "matched",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("已生成提案，请确认")]),
    ]);
    const session = await createSession(pool);
    const { frames } = await postSse(session.id, { text: "帮我登记买入 10 股" });
    const types = frames.map((f) => f.type);
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
    expect(types).toContain("confirmation_pending");
    expect(types).toContain("done");

    const persisted = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM chat_session_event WHERE session_id = $1 ORDER BY id",
      [session.id],
    );
    expect(persisted.rows.map((row) => row.event_type)).toEqual(
      expect.arrayContaining(["tool_start", "tool_end", "confirmation_pending", "message_completed"]),
    );

    const pending = frames.find((f) => f.type === "confirmation_pending")!.data as {
      confirmation_id: string;
      tool_name: string;
    };
    expect(pending.tool_name).toBe("portfolio_write");
    // 未写入业务库
    const positions = await pool.query("SELECT count(*)::int AS n FROM portfolio_position");
    expect(positions.rows[0]!.n).toBe(0);
  });

  it("多轮领域工具只记录 usage、时延、大小和状态，不把提示词或工具正文写入遥测", async () => {
    const promptSentinel = "METRIC_PROMPT_BODY_MUST_NOT_PERSIST";
    const toolSentinel = "METRIC_TOOL_BODY_MUST_NOT_PERSIST";
    await pool.query("UPDATE agent_setting SET market_domain_tools_enabled=true WHERE singleton=true");
    try {
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("instrument_search", { q: toolSentinel, limit: 3 }, { id: "metric-tool-1" })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          [fauxToolCall("market_snapshot_query", { codes: ["990003.SZ"] }, { id: "metric-tool-2" })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxText("遥测测试完成")]),
      ]);
      const session = await createSession(pool, "遥测测试");
      const result = await postSse(session.id, { text: promptSentinel });
      expect(result.frames.filter((frame) => frame.type === "tool_start")).toHaveLength(2);

      const messages = await pool.query<{ content: {
        role?: string;
        usage?: {
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
          reasoning?: number;
          cost: { total: number };
        };
      } }>("SELECT content FROM chat_message WHERE session_id=$1", [session.id]);
      const expected = messages.rows.reduce((sum, row) => {
        const usage = row.content.role === "assistant" ? row.content.usage : undefined;
        if (!usage) return sum;
        sum.input += usage.input;
        sum.output += usage.output;
        sum.cacheRead += usage.cacheRead;
        sum.cacheWrite += usage.cacheWrite;
        sum.reasoning += usage.reasoning ?? 0;
        sum.cost += usage.cost.total;
        return sum;
      }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 });
      const run = await pool.query<{
        id: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        reasoning_tokens: number;
        cost_amount: number;
        first_text_ms: number;
        total_ms: number;
        status: string;
        estimated_system_tokens: number;
        estimated_history_tokens: number;
        estimated_tool_definition_tokens: number;
      }>(
        `SELECT id::text, input_tokens::float8, output_tokens::float8,
                cache_read_tokens::float8, cache_write_tokens::float8,
                reasoning_tokens::float8, cost_amount::float8,
                first_text_ms, total_ms, status,
                estimated_system_tokens::float8, estimated_history_tokens::float8,
                estimated_tool_definition_tokens::float8
           FROM agent_run_metric WHERE session_id=$1 ORDER BY id DESC LIMIT 1`,
        [session.id],
      );
      expect(run.rows[0]).toMatchObject({
        input_tokens: expected.input,
        output_tokens: expected.output,
        cache_read_tokens: expected.cacheRead,
        cache_write_tokens: expected.cacheWrite,
        reasoning_tokens: expected.reasoning,
        cost_amount: expected.cost,
        status: "complete",
      });
      expect(run.rows[0]!.first_text_ms).toBeGreaterThanOrEqual(0);
      expect(run.rows[0]!.total_ms).toBeGreaterThanOrEqual(run.rows[0]!.first_text_ms);
      expect(run.rows[0]!.estimated_system_tokens).toBeGreaterThan(0);
      expect(run.rows[0]!.estimated_history_tokens).toBeGreaterThanOrEqual(0);
      expect(run.rows[0]!.estimated_tool_definition_tokens).toBeGreaterThan(0);

      const tools = await pool.query<{
        tool_call_id: string;
        tool_name: string;
        sequence_no: number;
        args_bytes: number;
        result_bytes: number;
        duration_ms: number;
        status: string;
      }>(
        `SELECT tool_call_id, tool_name, sequence_no, args_bytes, result_bytes, duration_ms, status
           FROM agent_tool_metric WHERE run_metric_id=$1 ORDER BY sequence_no`,
        [run.rows[0]!.id],
      );
      expect(tools.rows).toHaveLength(2);
      expect(tools.rows.map((row) => row.tool_name)).toEqual([
        "instrument_search",
        "market_snapshot_query",
      ]);
      expect(tools.rows.every((row) =>
        row.args_bytes > 0 && row.result_bytes > 0 && row.duration_ms >= 0 && row.status === "ok"
      )).toBe(true);

      const metricStorage = JSON.stringify({ run: run.rows, tools: tools.rows });
      expect(metricStorage).not.toContain(promptSentinel);
      expect(metricStorage).not.toContain(toolSentinel);
      const summary = await api(server.baseUrl, "GET", "/api/agent/metrics/summary");
      expect(summary.status).toBe(200);
      expect((summary.json as unknown as { runs: { total: number }; tools: { total: number } }).runs.total)
        .toBeGreaterThan(0);
      expect(JSON.stringify(summary.json)).not.toContain(promptSentinel);
      expect(JSON.stringify(summary.json)).not.toContain(toolSentinel);
    } finally {
      await pool.query("UPDATE agent_setting SET market_domain_tools_enabled=false WHERE singleton=true");
    }
  });

  it("YOLO SSE：数据库变更直接执行且不发送 confirmation_pending", async () => {
    await pool.query("UPDATE agent_setting SET yolo_mode = true WHERE singleton = true");
    try {
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("memory_write", {
              reason: "YOLO 路由测试",
              action: "create",
              title: "YOLO 路由测试方法",
              category: "research_method",
              summary: "验证 SSE 直接执行",
              content: "以固定输入验证工具结束帧和数据库结果。",
              tags: ["SSE"],
              scope: "路由测试",
              evidence: "永久测试断言",
              last_verified_at: "2026-08-19T08:00:00Z",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxText("已直接执行")]),
      ]);
      const session = await createSession(pool);
      const { frames } = await postSse(session.id, { text: "直接修改名称" });
      const types = frames.map((frame) => frame.type);
      expect(types).toContain("tool_end");
      expect(types).not.toContain("confirmation_pending");
      const item = await pool.query<{ id: string }>(
        "SELECT id::text FROM agent_memory_artifact WHERE title = 'YOLO 路由测试方法'",
      );
      expect(item.rows).toHaveLength(1);
      const memories = await api(server.baseUrl, "GET", "/api/memories?q=YOLO&tags=SSE");
      expect(memories.status).toBe(200);
      expect(memories.json).toMatchObject([{
        id: item.rows[0]!.id,
        category: "research_method",
        status: "active",
      }]);
      const detail = await api(server.baseUrl, "GET", `/api/memories/${item.rows[0]!.id}`);
      expect(detail.status).toBe(200);
      expect(detail.json).toMatchObject({ title: "YOLO 路由测试方法", tags: ["SSE"] });
    } finally {
      await pool.query("UPDATE agent_setting SET yolo_mode = false WHERE singleton = true");
    }
  });

  it("Agent 设置 API：默认关闭、可切换且拒绝非法值", async () => {
    const initial = await api(server.baseUrl, "GET", "/api/agent/settings");
    expect(initial.status).toBe(200);
    expect(initial.json).toMatchObject({
      yolo_mode: false,
      market_domain_tools_enabled: false,
      web_research_enabled: false,
    });

    const enabled = await api(server.baseUrl, "PATCH", "/api/agent/settings", {
      yolo_mode: true,
      market_domain_tools_enabled: true,
      web_research_enabled: true,
    });
    expect(enabled.status).toBe(200);
    expect(enabled.json).toMatchObject({
      yolo_mode: true,
      market_domain_tools_enabled: true,
      web_research_enabled: true,
    });

    expect(
      (await api(server.baseUrl, "PATCH", "/api/agent/settings", { yolo_mode: "yes" })).status,
    ).toBe(400);
    expect(
      (await api(server.baseUrl, "PATCH", "/api/agent/settings", { unknown_switch: true })).status,
    ).toBe(400);
    await api(server.baseUrl, "PATCH", "/api/agent/settings", {
      yolo_mode: false,
      market_domain_tools_enabled: false,
      web_research_enabled: false,
    });
  });

  it("系统设置 API：扶摇密钥入库但只回显配置状态", async () => {
    const initial = await api(server.baseUrl, "GET", "/api/system/settings");
    expect(initial.status).toBe(200);
    expect(initial.json).toMatchObject({ hithink_api_key_configured: false });

    const saved = await api(server.baseUrl, "PATCH", "/api/system/settings", {
      hithink_api_key: "hithink-secret-test",
    });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ hithink_api_key_configured: true });
    expect(JSON.stringify(saved.json)).not.toContain("hithink-secret-test");
    expect((await pool.query(
      "SELECT hithink_api_key FROM system_setting WHERE singleton = true",
    )).rows[0]!.hithink_api_key).toBe("hithink-secret-test");

    expect((await api(server.baseUrl, "PATCH", "/api/system/settings", { unknown: true })).status).toBe(400);
    const cleared = await api(server.baseUrl, "PATCH", "/api/system/settings", { hithink_api_key: "" });
    expect(cleared.json).toMatchObject({ hithink_api_key_configured: false });
  });

  it("GET /api/llm/status：已配置时返回 provider/model/vision", async () => {
    const res = await api(server.baseUrl, "GET", "/api/llm/status");
    expect(res.status).toBe(200);
    const st = res.json as unknown as {
      configured: boolean;
      provider: string;
      model: string;
      vision: boolean;
      yolo_mode: boolean;
    };
    expect(st.configured).toBe(true);
    expect(st.provider).toBe("faux");
    expect(st.model).toBe("faux-1");
    expect(st.vision).toBe(true);
    expect(st.yolo_mode).toBe(false);
  });

  it("GET /api/llm/status：未配置时 configured=false 并附错误码", async () => {
    setAiRuntimeForTests(null);

    const res = await api(server.baseUrl, "GET", "/api/llm/status");
    expect(res.status).toBe(200);
    const st = res.json as unknown as {
      configured: boolean;
      provider: string;
      model: string | null;
      vision: boolean;
      code: string;
    };
    expect(st.configured).toBe(false);
    expect(st.provider).toBeNull();
    expect(st.model).toBeNull();
    expect(st.vision).toBe(false);
    expect(st.code).toBe("LLM_NOT_CONFIGURED");

    useFauxRuntime();
  });

  it("PATCH 会话：会话模型 / 重命名 / 归档 / ?archived=1 / 归档后发送 409 / 参数校验", async () => {
    const created = await api(server.baseUrl, "POST", "/api/chat/sessions", {});
    const createdSession = created.json as unknown as { id: string; model_id: string | null };
    const sessionId = createdSession.id;
    expect(createdSession.model_id).toBeTruthy();

    // 会话模型独立于全局 active_model_id 持久化；选择器只接受已启用且已配密钥的模型。
    const target = await pool.query<{ id: string; provider_id: string }>(
      `SELECT m.id::text, p.id::text AS provider_id
       FROM llm_model m JOIN llm_provider p ON p.id = m.provider_id
       WHERE p.provider_key = 'xiaomi' LIMIT 1`,
    );
    await pool.query("UPDATE llm_provider SET api_key = 'session-model-test' WHERE id = $1", [
      target.rows[0]!.provider_id,
    ]);
    const switched = await api(server.baseUrl, "PATCH", `/api/chat/sessions/${sessionId}`, {
      model_id: target.rows[0]!.id,
    });
    expect(switched.status).toBe(200);
    expect((switched.json as unknown as { model_id: string }).model_id).toBe(target.rows[0]!.id);
    const listedWithModel = await api(server.baseUrl, "GET", "/api/chat/sessions");
    expect(
      (listedWithModel.json as unknown as { id: string; model_id: string | null }[]).find(
        (session) => session.id === sessionId,
      )?.model_id,
    ).toBe(target.rows[0]!.id);
    await pool.query("UPDATE llm_provider SET api_key = NULL WHERE id = $1", [
      target.rows[0]!.provider_id,
    ]);

    // 重命名
    const renamed = await api(server.baseUrl, "PATCH", `/api/chat/sessions/${sessionId}`, {
      title: "改名后的会话",
    });
    expect(renamed.status).toBe(200);
    expect((renamed.json as unknown as { title: string }).title).toBe("改名后的会话");

    // 归档：默认列表消失，?archived=1 可查
    const archived = await api(server.baseUrl, "PATCH", `/api/chat/sessions/${sessionId}`, {
      archived: true,
    });
    expect(archived.status).toBe(200);
    expect((archived.json as unknown as { archived: boolean }).archived).toBe(true);
    const activeList = await api(server.baseUrl, "GET", "/api/chat/sessions");
    expect(
      (activeList.json as unknown as { id: string }[]).some((s) => s.id === sessionId),
    ).toBe(false);
    const archivedList = await api(server.baseUrl, "GET", "/api/chat/sessions?archived=1");
    expect(
      (archivedList.json as unknown as { id: string }[]).some((s) => s.id === sessionId),
    ).toBe(true);

    // 归档后发送消息 → 409 SESSION_ARCHIVED
    const res = await fetch(`${server.baseUrl}/api/chat/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "SESSION_ARCHIVED",
    );

    // 取消归档后可再次发送
    const restored = await api(server.baseUrl, "PATCH", `/api/chat/sessions/${sessionId}`, {
      archived: false,
    });
    expect(restored.status).toBe(200);
    faux.setResponses([fauxAssistantMessage([fauxText("回来了")])]);
    const { frames } = await postSse(sessionId, { text: "继续" });
    expect(frames.map((f) => f.type)).toContain("done");

    // 参数校验
    expect(
      (await api(server.baseUrl, "PATCH", `/api/chat/sessions/${sessionId}`, {})).status,
    ).toBe(400);
    expect(
      (await api(server.baseUrl, "PATCH", `/api/chat/sessions/${sessionId}`, { title: 123 }))
        .status,
    ).toBe(400);
    expect(
      (await api(server.baseUrl, "PATCH", `/api/chat/sessions/${sessionId}`, { title: "  " }))
        .status,
    ).toBe(400);
    expect(
      (await api(server.baseUrl, "PATCH", `/api/chat/sessions/${sessionId}`, { archived: "yes" }))
        .status,
    ).toBe(400);
    expect(
      (await api(server.baseUrl, "PATCH", `/api/chat/sessions/${sessionId}`, { model_id: 1 }))
        .status,
    ).toBe(400);
    expect(
      (await api(server.baseUrl, "PATCH", `/api/chat/sessions/${sessionId}`, { model_id: "99999999" }))
        .status,
    ).toBe(404);
    expect(
      (await api(server.baseUrl, "PATCH", "/api/chat/sessions/99999999", { title: "x" })).status,
    ).toBe(404);
  });

  it("未配置降级：数据库未选择当前模型 → 503 LLM_NOT_CONFIGURED", async () => {
    setAiRuntimeForTests(null);
    const current = await pool.query<{ id: string }>(
      "SELECT active_model_id::text AS id FROM llm_setting WHERE singleton = true",
    );
    await pool.query("UPDATE llm_setting SET active_model_id = NULL WHERE singleton = true");
    const session = await createSession(pool);
    const res = await fetch(`${server.baseUrl}/api/chat/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("LLM_NOT_CONFIGURED");
    await pool.query("UPDATE llm_setting SET active_model_id = $1 WHERE singleton = true", [
      current.rows[0]!.id,
    ]);
    useFauxRuntime();
  });

  it("未配置降级：provider 无任何 key → 503 LLM_NOT_CONFIGURED", async () => {
    setAiRuntimeForTests(null);

    const session = await createSession(pool);
    const res = await fetch(`${server.baseUrl}/api/chat/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("LLM_NOT_CONFIGURED");

    useFauxRuntime();
  });

  it("附件上传：multipart 图片 → 201 并入库登记", async () => {
    const session = await createSession(pool);
    // 最小合法 PNG 头字节
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d494844520000000100000001080600000 01f15c489".replace(/\s/g, ""),
      "hex",
    );
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "pixel.png");
    const res = await fetch(`${server.baseUrl}/api/chat/${session.id}/attachments`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as { id: string; path: string; mime_type: string; sha256: string };
    expect(row.mime_type).toBe("image/png");
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);

    const listed = await api(server.baseUrl, "GET", `/api/chat/sessions/${session.id}/attachments`);
    expect((listed.json as unknown as unknown[]).length).toBe(1);

    // faux 模型支持 image 输入：带附件发消息正常
    faux.setResponses([fauxAssistantMessage([fauxText("看到图片")])]);
    const { frames } = await postSse(session.id, { text: "看图", attachment_ids: [row.id] });
    expect(frames.map((f) => f.type)).toContain("done");

    // 上传文件是测试临时产物；精确清理本用例创建的记录与文件，不触碰其他会话附件。
    await pool.query("DELETE FROM chat_attachment WHERE id = $1", [row.id]);
    await fs.rm(path.join(UPLOADS_DIR, row.path), { force: true });
    await fs.rmdir(path.join(UPLOADS_DIR, session.id)).catch(() => {});
  });

  it("确认结果经 GET .../events 长连推送 confirmation_result", async () => {
    const session = await createSession(pool);
    const controller = new AbortController();
    const res = await fetch(`${server.baseUrl}/api/chat/${session.id}/events`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const seen: string[] = [];
    const readLoop = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const block of buffer.split("\n\n")) {
          const line = block.split("\n").find((l) => l.startsWith("event: "));
          if (line) seen.push(line.slice(7));
        }
      }
    })().catch(() => {});

    // 等到 ready 帧后 approve 一条提案
    for (let i = 0; i < 50 && !seen.includes("ready"); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen).toContain("ready");

    const conf = await createConfirmation(pool, {
      session_id: session.id,
      tool_name: "portfolio_write",
      payload: { reason: "事件通道测试", code: "990003.SZ", kind: "buy", quantity: 1, price: 1, change_date: "2026-08-14", decision_origin: "strategy_signal", execution_compliance: "matched" },
    });
    const approved = await api(
      server.baseUrl,
      "POST",
      `/api/confirmations/${conf.id}/approve`,
      {},
    );
    expect(approved.status).toBe(200);

    for (let i = 0; i < 50 && !seen.includes("confirmation_result"); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen).toContain("confirmation_result");

    controller.abort();
    await readLoop;
  }, 20_000);

  it("任务会话允许完成后追问，统一游标流先补库再续接实时事件", async () => {
    const session = await createSession(pool, {
      title: "游标重放测试",
      session_type: "job",
      session_status: "running",
      source: "cron",
    });
    const first = await persistAndPublishSessionEvent(pool, {
      session_id: session.id,
      event_type: "session_status",
      data: { status: "running" },
    });
    const second = await persistAndPublishSessionEvent(pool, {
      session_id: session.id,
      event_type: "tool_start",
      data: { name: "database_query" },
    });

    faux.setResponses([fauxAssistantMessage([fauxText("可以继续追问本次任务结果")])]);
    const followUp = await postSse(session.id, { text: "解释一下本次任务结果" });
    expect(followUp.status).toBe(200);
    expect(followUp.frames.map((frame) => frame.type)).toContain("done");

    const controller = new AbortController();
    const response = await fetch(
      `${server.baseUrl}/api/chat/${session.id}/events?after=${first.id}`,
      { signal: controller.signal },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const frames: { type: string; data: Record<string, unknown> }[] = [];
    const readLoop = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const eventLine = block.split("\n").find((line) => line.startsWith("event: "));
          const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
          if (eventLine && dataLine) {
            frames.push({ type: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
          }
        }
      }
    })().catch(() => {});

    const waitForFrame = async (type: string) => {
      const deadline = Date.now() + 5_000;
      while (!frames.some((frame) => frame.type === type) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return frames.find((frame) => frame.type === type);
    };

    try {
      const replayedToolStart = await waitForFrame("tool_start");
      expect(replayedToolStart?.data.cursor).toBe(second.id);

      const live = await persistAndPublishSessionEvent(pool, {
        session_id: session.id,
        event_type: "tool_end",
        data: { name: "database_query" },
      });
      expect((await waitForFrame("tool_end"))?.data.cursor).toBe(live.id);
      expect(frames.filter((frame) => frame.type === "tool_start")).toHaveLength(1);
      expect(frames.some((frame) => frame.type === "replay_complete")).toBe(true);
    } finally {
      controller.abort();
      await readLoop;
    }
  }, 20_000);
});
