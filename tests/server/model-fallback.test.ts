// 模型降级兜底（specs/模型降级与首token兜底/状态.md 第九节 8 条验收）。
// 全部用 faux provider 脚本化响应，不调用真实模型；数据库为 stock_test 真实库。
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../server/db/migrate.js";
import { setAiRuntimeForTests } from "../../server/agent/ai/runtime.js";
import { createSession } from "../../server/agent/repo.js";
import {
  isModelFallbackAllowed,
  isWithinFallbackWindow,
  renderModelDegradationNotice,
  runAgentSessionTurn,
} from "../../server/agent/session-runner.js";
import { prepareTestDb, resetSchema, seedTestStrategy } from "./helpers.js";

const prepared = await prepareTestDb();

type Faux = ReturnType<typeof fauxProvider>;

describe.skipIf(!prepared)("模型降级兜底", () => {
  let pool: pg.Pool;
  let sessionId: string;
  let primary: Faux;
  let fallback: Faux;

  function runtimeOf(faux: Faux, provider: string) {
    const models = createModels();
    models.setProvider(faux.provider);
    const model = models.getModels(provider)[0]!;
    return { models, model, provider, providerName: provider, modelId: model.id };
  }

  function useFaux(): void {
    setAiRuntimeForTests(runtimeOf(primary, "faux-primary"), runtimeOf(fallback, "faux-fallback"));
  }

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
    await seedTestStrategy(pool);
    primary = fauxProvider({ provider: "faux-primary", models: [{ id: "faux-primary" }] });
    fallback = fauxProvider({ provider: "faux-fallback", models: [{ id: "faux-fallback" }] });
    sessionId = (await createSession(pool, { title: "模型降级测试", session_type: "job",
      session_status: "idle", source: "cron" })).id;
  });

  beforeEach(async () => {
    primary.setResponses([]);
    fallback.setResponses([]);
    primary.state.callCount = 0;
    fallback.state.callCount = 0;
    sessionId = (await createSession(pool, { title: "模型降级测试", session_type: "job",
      session_status: "idle", source: "cron" })).id;
  });

  afterAll(async () => {
    setAiRuntimeForTests(null);
    await pool.end();
  });

  async function turn(jobCode: string | null, extra: { watchdogMs?: number } = {}) {
    useFaux();
    return runAgentSessionTurn({
      pool,
      sessionId,
      text: "输出本次板块机会筛选结论",
      historyMode: "empty",
      systemPrompt: "你是测试助手，只输出结论。",
      manageSessionStatus: false,
      toolScope: jobCode ? { kind: "job", jobCode } : undefined,
      modelWatchdogMs: extra.watchdogMs,
    });
  }

  async function lastMetric() {
    return (await pool.query<{
      fallback_from_model_key: string | null;
      fallback_target_model_key: string | null;
      fallback_reason: string | null;
      status: string;
    }>(`SELECT fallback_from_model_key, fallback_target_model_key, fallback_reason, status
          FROM agent_run_metric WHERE session_id=$1 ORDER BY id DESC LIMIT 1`, [sessionId])).rows[0]!;
  }

  it("零 token 终止：立即切 fallback，不等待重试", async () => {
    primary.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })]);
    fallback.setResponses([fauxAssistantMessage("降级后的完整结论")]);
    const startedAt = Date.now();
    const result = await turn("nightly_sector_opportunity_scan");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result.modelFailure).toBeNull();
    expect(result.degradation).toMatchObject({
      from: "faux-primary", to: "faux-fallback", kind: "zero_token",
    });
    expect(result.degradation!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const metric = await lastMetric();
    expect(metric).toMatchObject({
      fallback_from_model_key: "faux-primary",
      fallback_target_model_key: "faux-fallback",
      fallback_reason: "zero_token",
      status: "complete",
    });
  });

  it("已出字但流中断：直接走 fallback，不重试同模型", async () => {
    primary.setResponses([fauxAssistantMessage("写了一半的结论", { stopReason: "error", errorMessage: "terminated" })]);
    fallback.setResponses([fauxAssistantMessage("降级后的完整结论")]);
    const result = await turn("nightly_sector_opportunity_scan");
    expect(result.degradation).toMatchObject({ kind: "stream_interrupted", to: "faux-fallback" });
    expect(primary.state.callCount).toBe(1);
  });

  it("看门狗：长时间无文本增量判卡死并切 fallback", async () => {
    primary.setResponses([(_context, options) => new Promise<never>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted by watchdog")));
    })]);
    fallback.setResponses([fauxAssistantMessage("看门狗触发后的结论")]);
    const result = await turn("nightly_sector_opportunity_scan", { watchdogMs: 120 });
    expect(result.degradation).toMatchObject({ kind: "watchdog" });
  });

  it("fallback 也失败时不再级联第三个模型，任务判失败", async () => {
    primary.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })]);
    fallback.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })]);
    const result = await turn("nightly_sector_opportunity_scan");
    expect(result.degradation).toMatchObject({ kind: "zero_token" });
    expect(result.modelFailure).toBe("zero_token");
    expect(result.llmError).toContain("terminated");
    expect(fallback.state.callCount).toBe(1);
    expect((await lastMetric()).status).toBe("failed");
  });

  it("降级标注含原模型、目标模型、触发类别与时间", async () => {
    const notice = renderModelDegradationNotice({
      from: "deepseek-v4-pro", to: "glm-5.3", kind: "zero_token", at: "2026-11-05T10:40:13.454Z",
    });
    expect(notice).toContain("降级运行：deepseek-v4-pro → glm-5.3");
    expect(notice).toContain("零 token 终止");
    expect(notice).toContain("2026-11-05 18:40");
  });

  it("非白名单任务（盘中观察）遇到同样错误不走降级", async () => {
    primary.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })]);
    fallback.setResponses([fauxAssistantMessage("不该被调用")]);
    const result = await turn("position_intraday_watch");
    expect(result.degradation).toBeNull();
    expect(result.modelFailure).toBe("zero_token");
    expect(fallback.state.callCount).toBe(0);
  });

  it("盘前任务 09:15 之后不降级，窗口内允许", () => {
    const before = new Date("2026-11-05T01:00:00Z"); // 上海 09:00
    const after = new Date("2026-11-05T01:20:00Z"); // 上海 09:20
    expect(isWithinFallbackWindow("pre_market_news_scan", before)).toBe(true);
    expect(isWithinFallbackWindow("pre_market_news_scan", after)).toBe(false);
    expect(isWithinFallbackWindow("nightly_sector_opportunity_scan", after)).toBe(true);
    expect(isModelFallbackAllowed("pre_market_news_scan", after)).toBe(false);
    expect(isModelFallbackAllowed("position_intraday_watch", before)).toBe(false);
  });

  it("2026-11-05 run 1075 形态回放：零 token 终止立即判定并切换", async () => {
    // 真实形态：首次调用 104.9 秒后 terminated、从未收到文本增量；重试请求 input/output 全 0。
    primary.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })]);
    fallback.setResponses([fauxAssistantMessage("替代模型产出的板块机会筛选报告")]);
    const result = await turn("nightly_sector_opportunity_scan");
    expect(result.degradation?.kind).toBe("zero_token");
    expect(result.degradation?.from).toBe("faux-primary");
    expect(result.degradation?.to).toBe("faux-fallback");
    expect(result.lastAssistant?.role).toBe("assistant");
  });
});
