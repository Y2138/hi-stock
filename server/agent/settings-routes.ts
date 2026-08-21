import type http from "node:http";
import type pg from "pg";
import { apiErrors } from "../http/router.js";
import { getAgentSettings, updateAgentSettings } from "./settings.js";

interface Ctx {
  pool: pg.Pool;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}

export const agentSettingsRoutes = {
  async get({ pool }: Ctx) {
    return { data: await getAgentSettings(pool) };
  },

  async update({ pool, body }: Ctx) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw apiErrors.badRequest("请求体必须是对象");
    }
    const value = body as Record<string, unknown>;
    const allowed = ["yolo_mode", "market_domain_tools_enabled", "web_research_enabled"];
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) throw apiErrors.badRequest(`包含未知字段：${unknown.join(",")}`);
    if (Object.keys(value).length === 0) throw apiErrors.badRequest("至少提供一个设置字段");
    for (const key of allowed) {
      if (value[key] !== undefined && typeof value[key] !== "boolean") {
        throw apiErrors.badRequest(`${key} 必须是布尔值`);
      }
    }
    const patch = {
      ...(typeof value.yolo_mode === "boolean" ? { yolo_mode: value.yolo_mode } : {}),
      ...(typeof value.market_domain_tools_enabled === "boolean"
        ? { market_domain_tools_enabled: value.market_domain_tools_enabled }
        : {}),
      ...(typeof value.web_research_enabled === "boolean"
        ? { web_research_enabled: value.web_research_enabled }
        : {}),
    };
    return { data: await updateAgentSettings(pool, patch) };
  },
};
