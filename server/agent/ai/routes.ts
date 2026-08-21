import type http from "node:http";
import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import {
  activateLlmModel,
  createLlmModel,
  createLlmProvider,
  deleteLlmModel,
  deleteLlmProvider,
  getActiveModelId,
  listLlmProviders,
  updateLlmModel,
  updateLlmProvider,
} from "./repo.js";
import { LLM_API_PROTOCOLS, type LlmApiProtocol } from "./types.js";

interface Ctx {
  pool: pg.Pool;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}

function bodyOf(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw apiErrors.badRequest("请求体必须是对象");
  }
  return body as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw apiErrors.badRequest(`${key} 必须是非空字符串`);
  }
  return value.trim();
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw apiErrors.badRequest(`${key} 必须是非空字符串`);
  }
  return value.trim();
}

function protocolOf(value: unknown): LlmApiProtocol {
  if (typeof value !== "string" || !(LLM_API_PROTOCOLS as readonly string[]).includes(value)) {
    throw apiErrors.badRequest(`api_protocol 必须是 ${LLM_API_PROTOCOLS.join(" / ")}`);
  }
  return value as LlmApiProtocol;
}

function baseUrlOf(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw apiErrors.badRequest("base_url 必须是完整 URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw apiErrors.badRequest("base_url 只支持 http/https");
  }
  return value.replace(/\/+$/, "");
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw apiErrors.badRequest(`${key} 必须是布尔值`);
  return value;
}

function positiveInt(body: Record<string, unknown>, key: string, fallback?: number): number {
  const value = body[key] ?? fallback;
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw apiErrors.badRequest(`${key} 必须是正整数`);
  }
  return Number(value);
}

function modalitiesOf(value: unknown): ("text" | "image")[] {
  const list = value === undefined ? ["text"] : value;
  if (
    !Array.isArray(list) ||
    !list.includes("text") ||
    list.some((item) => item !== "text" && item !== "image")
  ) {
    throw apiErrors.badRequest("input_modalities 必须是包含 text 的 text/image 数组");
  }
  return [...new Set(list)] as ("text" | "image")[];
}

async function currentList(pool: pg.Pool) {
  return {
    providers: await listLlmProviders(pool),
    active_model_id: await getActiveModelId(pool),
    protocols: LLM_API_PROTOCOLS,
  };
}

export const llmConfigRoutes = {
  async list({ pool }: Ctx) {
    return { data: await currentList(pool) };
  },

  async createProvider({ pool, body }: Ctx) {
    const b = bodyOf(body);
    const providerKey = requiredString(b, "provider_key").toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerKey)) {
      throw apiErrors.badRequest("provider_key 只允许小写字母、数字、点、下划线与连字符");
    }
    const id = await createLlmProvider(pool, {
      provider_key: providerKey,
      name: requiredString(b, "name"),
      api_protocol: protocolOf(b.api_protocol),
      base_url: baseUrlOf(requiredString(b, "base_url")),
      api_key: typeof b.api_key === "string" && b.api_key.trim() ? b.api_key.trim() : null,
    });
    return { status: 201, data: { id, ...(await currentList(pool)) } };
  },

  async updateProvider({ pool, params, body }: Ctx) {
    const b = bodyOf(body);
    const patch: Parameters<typeof updateLlmProvider>[2] = {};
    const name = optionalString(b, "name");
    if (name !== undefined) patch.name = name;
    if (b.api_protocol !== undefined) patch.api_protocol = protocolOf(b.api_protocol);
    const baseUrl = optionalString(b, "base_url");
    if (baseUrl !== undefined) patch.base_url = baseUrlOf(baseUrl);
    if (b.api_key !== undefined) {
      if (typeof b.api_key !== "string") throw apiErrors.badRequest("api_key 必须是字符串");
      patch.api_key = b.api_key.trim() || null;
    }
    const enabled = optionalBoolean(b, "enabled");
    if (enabled !== undefined) patch.enabled = enabled;
    if (Object.keys(patch).length === 0) throw apiErrors.badRequest("缺少可更新字段");
    if (!(await updateLlmProvider(pool, params.id!, patch))) {
      throw apiErrors.notFound(`模型厂商不存在：${params.id}`);
    }
    return { data: await currentList(pool) };
  },

  async deleteProvider({ pool, params }: Ctx) {
    const deleted = await deleteLlmProvider(pool, params.id!);
    if (!deleted) {
      const providers = await listLlmProviders(pool);
      if (providers.some((provider) => provider.id === params.id)) {
        throw apiErrors.conflict("当前启用模型属于该厂商，请先切换模型再删除");
      }
      throw apiErrors.notFound(`模型厂商不存在：${params.id}`);
    }
    return { data: await currentList(pool) };
  },

  async createModel({ pool, params, body }: Ctx) {
    const b = bodyOf(body);
    const id = await createLlmModel(pool, params.id!, {
      model_key: requiredString(b, "model_key"),
      name: requiredString(b, "name"),
      input_modalities: modalitiesOf(b.input_modalities),
      reasoning: optionalBoolean(b, "reasoning") ?? false,
      context_window: positiveInt(b, "context_window", 128000),
      max_tokens: positiveInt(b, "max_tokens", 8192),
    });
    if (!id) throw apiErrors.notFound(`模型厂商不存在：${params.id}`);
    return { status: 201, data: { id, ...(await currentList(pool)) } };
  },

  async updateModel({ pool, params, body }: Ctx) {
    const b = bodyOf(body);
    const patch: Parameters<typeof updateLlmModel>[2] = {};
    for (const key of ["model_key", "name"] as const) {
      const value = optionalString(b, key);
      if (value !== undefined) patch[key] = value;
    }
    if (b.input_modalities !== undefined) patch.input_modalities = modalitiesOf(b.input_modalities);
    for (const key of ["reasoning", "enabled"] as const) {
      const value = optionalBoolean(b, key);
      if (value !== undefined) patch[key] = value;
    }
    for (const key of ["context_window", "max_tokens"] as const) {
      if (b[key] !== undefined) patch[key] = positiveInt(b, key);
    }
    if (Object.keys(patch).length === 0) throw apiErrors.badRequest("缺少可更新字段");
    if (!(await updateLlmModel(pool, params.id!, patch))) {
      throw apiErrors.notFound(`模型不存在：${params.id}`);
    }
    return { data: await currentList(pool) };
  },

  async deleteModel({ pool, params }: Ctx) {
    const result = await deleteLlmModel(pool, params.id!);
    if (result === "active") throw apiErrors.conflict("不能删除当前启用模型，请先切换");
    if (result === "missing") throw apiErrors.notFound(`模型不存在：${params.id}`);
    return { data: await currentList(pool) };
  },

  async activateModel({ pool, params }: Ctx) {
    if (!(await activateLlmModel(pool, params.id!))) {
      throw apiErrors.notFound(`模型不存在、已停用或所属厂商已停用：${params.id}`);
    }
    return { data: await currentList(pool) };
  },
};

