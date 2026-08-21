// LLM 数据库配置回归：供应商/模型 CRUD、当前模型切换、凭据不回显、pi-ai 状态解析。
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../server/db/migrate.js";
import { api, prepareTestDb, resetSchema, startTestServer, type TestServer } from "./helpers.js";

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("LLM 数据库配置", () => {
  let pool: pg.Pool;
  let server: TestServer;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
    server = await startTestServer(pool);
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  it("迁移提供可编辑模板，API Key 永不回显", async () => {
    const listed = await api(server.baseUrl, "GET", "/api/llm/providers");
    expect(listed.status).toBe(200);
    const data = listed.json as unknown as {
      providers: { provider_key: string; api_key_configured: boolean }[];
      active_model_id: string;
      protocols: string[];
    };
    expect(data.providers.map((provider) => provider.provider_key)).toEqual(
      expect.arrayContaining(["deepseek", "xiaomi", "openai", "anthropic"]),
    );
    expect(data.providers.every((provider) => !provider.api_key_configured)).toBe(true);
    expect(data.active_model_id).toBeTruthy();
    expect(JSON.stringify(listed.json)).not.toContain("api_key\"");
  });

  it("配置数据库 API Key 后，当前模型可由 pi-ai AI 层解析", async () => {
    const providers = await api(server.baseUrl, "GET", "/api/llm/providers");
    const deepseek = (
      providers.json as unknown as { providers: { id: string; provider_key: string }[] }
    ).providers.find((provider) => provider.provider_key === "deepseek")!;
    const secret = "sk-database-only-test";
    const updated = await api(
      server.baseUrl,
      "PATCH",
      `/api/llm/providers/${deepseek.id}`,
      { api_key: secret },
    );
    expect(updated.status).toBe(200);
    expect(JSON.stringify(updated.json)).not.toContain(secret);

    const status = await api(server.baseUrl, "GET", "/api/llm/status");
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({
      configured: true,
      provider: "deepseek",
      provider_name: "DeepSeek",
      model: "deepseek-v4-flash",
      vision: false,
    });
  });

  it("用户可新增自定义厂商和模型、切换当前模型并修改能力", async () => {
    const createdProvider = await api(server.baseUrl, "POST", "/api/llm/providers", {
      provider_key: "local-gateway",
      name: "本地兼容网关",
      api_protocol: "openai-completions",
      base_url: "http://127.0.0.1:11434/v1/",
      api_key: "local-secret",
    });
    expect(createdProvider.status).toBe(201);
    const providerId = (createdProvider.json as unknown as { id: string }).id;

    const createdModel = await api(
      server.baseUrl,
      "POST",
      `/api/llm/providers/${providerId}/models`,
      {
        model_key: "qwen-test",
        name: "Qwen Test",
        input_modalities: ["text"],
        reasoning: true,
        context_window: 65536,
        max_tokens: 8192,
      },
    );
    expect(createdModel.status).toBe(201);
    const modelId = (createdModel.json as unknown as { id: string }).id;

    expect(
      (await api(server.baseUrl, "POST", `/api/llm/models/${modelId}/activate`, {})).status,
    ).toBe(200);
    expect(
      (await api(server.baseUrl, "PATCH", `/api/llm/models/${modelId}`, {
        input_modalities: ["text", "image"],
      })).status,
    ).toBe(200);

    const status = await api(server.baseUrl, "GET", "/api/llm/status");
    expect(status.json).toMatchObject({
      configured: true,
      provider: "local-gateway",
      model: "qwen-test",
      vision: true,
    });
    expect(JSON.stringify(await api(server.baseUrl, "GET", "/api/llm/providers"))).not.toContain(
      "local-secret",
    );

    expect((await api(server.baseUrl, "DELETE", `/api/llm/models/${modelId}`)).status).toBe(409);
    expect((await api(server.baseUrl, "DELETE", `/api/llm/providers/${providerId}`)).status).toBe(
      409,
    );
  });

  it("非法协议、URL 与模型能力被边界校验拒绝", async () => {
    expect(
      (await api(server.baseUrl, "POST", "/api/llm/providers", {
        provider_key: "BAD KEY",
        name: "坏配置",
        api_protocol: "unknown",
        base_url: "file:///tmp/model",
      })).status,
    ).toBe(400);

    const providers = await api(server.baseUrl, "GET", "/api/llm/providers");
    const deepseek = (
      providers.json as unknown as { providers: { id: string; provider_key: string }[] }
    ).providers.find((provider) => provider.provider_key === "deepseek")!;
    expect(
      (await api(server.baseUrl, "POST", `/api/llm/providers/${deepseek.id}/models`, {
        model_key: "bad-model",
        name: "Bad",
        input_modalities: ["image"],
      })).status,
    ).toBe(400);
  });
});

