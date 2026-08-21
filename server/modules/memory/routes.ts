import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import { getMemory, queryMemories, type MemoryCategory, type MemoryStatus } from "./repo.js";

interface Ctx { pool: pg.Pool; params: Record<string, string>; query: URLSearchParams }
const CATEGORIES = new Set(["research_method","evaluation_template","data_source_knowledge","task_playbook","incident_resolution","user_preference"]);
const STATUSES = new Set(["active","review_required","superseded","deprecated"]);

export const memoryRoutes = {
  async list({ pool, query }: Ctx) {
    const category = query.get("category") || undefined;
    const status = query.get("status") || undefined;
    if (category && !CATEGORIES.has(category)) throw apiErrors.badRequest("未知记忆类型");
    if (status && !STATUSES.has(status)) throw apiErrors.badRequest("未知记忆状态");
    const limit = Number(query.get("limit") ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw apiErrors.badRequest("limit 必须为 1..200");
    return { data: await queryMemories(pool, {
      keyword: query.get("q") || undefined,
      category: category as MemoryCategory | undefined,
      status: status as MemoryStatus | undefined,
      tags: (query.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
      limit,
    }) };
  },
  async get({ pool, params }: Ctx) {
    const row = await getMemory(pool, params.id!);
    if (!row) throw apiErrors.notFound(`Agent 记忆不存在：${params.id}`);
    return { data: row };
  },
};
