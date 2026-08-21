import type http from "node:http";
import type pg from "pg";
import { apiErrors } from "../http/router.js";
import { getAgentMetricSummary } from "./metrics.js";

interface Ctx {
  pool: pg.Pool;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}

function timestamp(value: string | null, name: string): string | null {
  if (value === null || value === "") return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw apiErrors.badRequest(`${name} 必须是合法时间`);
  return parsed.toISOString();
}

export const agentMetricRoutes = {
  async summary({ pool, query }: Ctx) {
    const from = timestamp(query.get("from"), "from");
    const to = timestamp(query.get("to"), "to");
    if (from && to && from > to) throw apiErrors.badRequest("from 不得晚于 to");
    const modelId = query.get("model_id") || null;
    if (modelId && !/^\d+$/.test(modelId)) throw apiErrors.badRequest("model_id 必须是正整数");
    return { data: await getAgentMetricSummary(pool, { from, to, modelId }) };
  },
};
