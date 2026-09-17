import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import {
  getStrategyRuntimeDefinition,
  listStrategyEvaluationRuns,
  listStrategyRuntimeDefinitions,
} from "./repo.js";

interface Ctx {
  pool: pg.Pool;
  params: Record<string, string>;
  query: URLSearchParams;
}

function limitOf(query: URLSearchParams): number {
  const raw = query.get("limit") ?? "50";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw apiErrors.badRequest("limit 必须是 1-200 的整数");
  }
  return value;
}

export const strategyRuntimeRoutes = {
  async list({ pool }: Ctx) {
    return { data: await listStrategyRuntimeDefinitions(pool) };
  },
  async get({ pool, params }: Ctx) {
    return { data: await getStrategyRuntimeDefinition(pool, params.code!) };
  },
  async evaluations({ pool, params, query }: Ctx) {
    return { data: await listStrategyEvaluationRuns(pool, params.code!, limitOf(query)) };
  },
};
