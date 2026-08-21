import type pg from "pg";
import { apiErrors } from "../http/router.js";
import { executeAnalysis, findAnalysisRun, listAnalysisRuns, type AnalysisRequest } from "./service.js";

interface Ctx { pool: pg.Pool; params: Record<string, string>; query: URLSearchParams; body: unknown }
export const analysisRoutes = {
  async list({ pool, query }: Ctx) {
    const limit = Number(query.get("limit") ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw apiErrors.badRequest("limit 必须是 1–500");
    return { data: await listAnalysisRuns(pool, limit) };
  },
  async get({ pool, params }: Ctx) {
    const run = await findAnalysisRun(pool, params.id!);
    if (!run) throw apiErrors.notFound(`分析运行不存在：${params.id}`);
    return { data: run };
  },
  async run({ pool, body }: Ctx) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw apiErrors.badRequest("请求体必须是对象");
    return { status: 201, data: await executeAnalysis(pool, body as AnalysisRequest) };
  },
};
