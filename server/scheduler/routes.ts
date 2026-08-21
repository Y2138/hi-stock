import { apiErrors } from "../http/router.js";
import {
  createJobDefinition,
  findJobByCode,
  findJobRunById,
  findJobOutputById,
  listJobDefinitions,
  listJobRuns,
  listJobOutputs,
  listRunOutputs,
  queueManualJob,
  updateJobDefinition,
} from "./repo.js";
import { wakeScheduler } from "./service.js";
import type { Db } from "./types.js";

interface Ctx {
  pool: Db & Parameters<typeof wakeScheduler>[0];
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw apiErrors.badRequest("请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

function assertOnly(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw apiErrors.badRequest(`包含未知字段：${unknown.join(", ")}`);
}

function parseLimit(query: URLSearchParams): number {
  const raw = query.get("limit");
  const limit = raw ? Number(raw) : 50;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    throw apiErrors.badRequest(`limit 非法：${raw}`);
  }
  return limit;
}

export const jobRoutes = {
  async list({ pool }: Ctx) {
    return { data: await listJobDefinitions(pool) };
  },

  async create({ pool, body }: Ctx) {
    const value = bodyObject(body);
    assertOnly(value, ["code", "name", "cron", "job_type", "config", "prompt_id", "enabled"]);
    const row = await createJobDefinition(pool, {
      code: value.code,
      name: value.name,
      cron: value.cron,
      job_type: value.job_type,
      config: value.config,
      prompt_id: value.prompt_id,
      enabled: value.enabled,
    });
    return { status: 201, data: row };
  },

  async update({ pool, params, body }: Ctx) {
    return { data: await updateJobDefinition(pool, params.code!, bodyObject(body)) };
  },

  /** 页面治理入口：只允许启用或暂停，不允许借此修改任务定义。 */
  async control({ pool, params, body }: Ctx) {
    const value = bodyObject(body);
    assertOnly(value, ["enabled", "base_updated_at"]);
    if (typeof value.enabled !== "boolean") throw apiErrors.badRequest("enabled 必须是布尔值");
    if (typeof value.base_updated_at !== "string") throw apiErrors.badRequest("base_updated_at 必须是时间字符串");
    return { data: await updateJobDefinition(pool, params.code!, value) };
  },

  async trigger({ pool, params, body }: Ctx) {
    const value = bodyObject(body);
    assertOnly(value, ["target_date"]);
    if (value.target_date !== undefined && typeof value.target_date !== "string") {
      throw apiErrors.badRequest("target_date 必须是 YYYY-MM-DD");
    }
    const run = await queueManualJob(pool, params.code!, value.target_date as string | undefined);
    wakeScheduler(pool);
    return { status: 202, data: run };
  },

  async runs({ pool, params, query }: Ctx) {
    const job = await findJobByCode(pool, params.code!);
    if (!job) throw apiErrors.notFound(`未知作业 code：${params.code}`);
    return { data: await listJobRuns(pool, job.id, parseLimit(query)) };
  },

  async outputs({ pool, params, query }: Ctx) {
    const job = await findJobByCode(pool, params.code!);
    if (!job) throw apiErrors.notFound(`未知作业 code：${params.code}`);
    return { data: await listJobOutputs(pool, job.id, parseLimit(query)) };
  },

  async runDetail({ pool, params }: Ctx) {
    const run = await findJobRunById(pool, params.id!);
    if (!run) throw apiErrors.notFound(`作业运行不存在：${params.id}`);
    return { data: { ...run, outputs: await listRunOutputs(pool, run.id) } };
  },

  async outputDetail({ pool, params }: Ctx) {
    const output = await findJobOutputById(pool, params.id!);
    if (!output) throw apiErrors.notFound(`任务结果不存在：${params.id}`);
    return { data: output };
  },
};
