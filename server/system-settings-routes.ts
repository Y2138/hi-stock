import type http from "node:http";
import type pg from "pg";
import { apiErrors } from "./http/router.js";
import { getSystemSettings, updateHithinkApiKey } from "./system-settings.js";

interface Ctx {
  pool: pg.Pool;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}

export const systemSettingsRoutes = {
  async get({ pool }: Ctx) {
    return { data: await getSystemSettings(pool) };
  },

  async update({ pool, body }: Ctx) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw apiErrors.badRequest("请求体必须是对象");
    }
    const value = body as Record<string, unknown>;
    const unknown = Object.keys(value).filter((key) => key !== "hithink_api_key");
    if (unknown.length > 0) throw apiErrors.badRequest(`包含未知字段：${unknown.join(",")}`);
    if (!("hithink_api_key" in value) || typeof value.hithink_api_key !== "string") {
      throw apiErrors.badRequest("hithink_api_key 必须是字符串");
    }
    const apiKey = value.hithink_api_key.trim();
    if (apiKey.length > 4096) throw apiErrors.badRequest("hithink_api_key 过长");
    return { data: await updateHithinkApiKey(pool, apiKey || null) };
  },
};
