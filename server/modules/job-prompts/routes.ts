import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import {
  appendJobPromptRevision,
  createJobPrompt,
  findJobPrompt,
  findJobPromptRevision,
  listJobPromptRevisions,
  listJobPrompts,
  rollbackJobPrompt,
  updateJobPromptStatus,
} from "./repo.js";

interface Ctx { pool: pg.Pool; params: Record<string, string>; body: unknown }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw apiErrors.badRequest("请求体必须是对象");
  return value as Record<string, unknown>;
}
function text(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw apiErrors.badRequest(`${field} 不能为空`);
  return value;
}
async function requirePrompt(pool: pg.Pool, id: string) {
  const prompt = await findJobPrompt(pool, id, true);
  if (!prompt) throw apiErrors.notFound(`作业提示词不存在：${id}`);
  return prompt;
}

export const jobPromptRoutes = {
  async list({ pool }: Ctx) { return { data: await listJobPrompts(pool) }; },
  async get({ pool, params }: Ctx) { return { data: await requirePrompt(pool, params.id!) }; },
  async create({ pool, body }: Ctx) {
    const value = object(body);
    const code = text(value, "code");
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(code)) throw apiErrors.badRequest("code 格式非法");
    return { status: 201, data: await createJobPrompt(pool, {
      code, name: text(value, "name"), content: text(value, "content"), source: "user",
      change_summary: typeof value.change_summary === "string" ? value.change_summary : null,
    }) };
  },
  async revisions({ pool, params }: Ctx) {
    const prompt = await requirePrompt(pool, params.id!);
    return { data: await listJobPromptRevisions(pool, prompt.id) };
  },
  async revision({ pool, params }: Ctx) {
    const prompt = await requirePrompt(pool, params.id!);
    const revision = await findJobPromptRevision(pool, prompt.id, params.revision!);
    if (!revision) throw apiErrors.notFound(`提示词版本不存在：${params.revision}`);
    return { data: revision };
  },
  async append({ pool, params, body }: Ctx) {
    const prompt = await requirePrompt(pool, params.id!);
    const value = object(body);
    return { status: 201, data: await appendJobPromptRevision(pool, prompt.id, {
      base_revision_id: text(value, "base_revision_id"), content: text(value, "content"), source: "user",
      change_summary: typeof value.change_summary === "string" ? value.change_summary : null,
    }) };
  },
  async rollback({ pool, params, body }: Ctx) {
    const prompt = await requirePrompt(pool, params.id!);
    const value = object(body);
    return { status: 201, data: await rollbackJobPrompt(pool, prompt.id, {
      base_revision_id: text(value, "base_revision_id"), target_revision_id: text(value, "target_revision_id"),
      change_summary: typeof value.change_summary === "string" ? value.change_summary : null,
    }) };
  },
  async status({ pool, params, body }: Ctx) {
    const prompt = await requirePrompt(pool, params.id!);
    const value = object(body);
    if (value.status !== "active" && value.status !== "archived") throw apiErrors.badRequest("status 必须是 active/archived");
    return { data: await updateJobPromptStatus(pool, prompt.id, {
      base_revision_id: text(value, "base_revision_id"), status: value.status,
    }) };
  },
};
