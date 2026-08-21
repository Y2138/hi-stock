import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import { BOARD_TYPES } from "../../datasource/hithink-boards.js";
import { listBoardConstituents, listBoards } from "./repo.js";

interface Ctx {
  pool: pg.Pool;
  params: Record<string, string>;
  query: URLSearchParams;
}

export const boardRoutes = {
  async list({ pool, query }: Ctx) {
    const type = query.get("type")?.trim() || undefined;
    if (type && !(BOARD_TYPES as readonly string[]).includes(type)) {
      throw apiErrors.badRequest(`type 必须是 ${BOARD_TYPES.join("/")}`);
    }
    const limit = Number(query.get("limit") ?? 200);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw apiErrors.badRequest("limit 必须为 1..500");
    return { data: await listBoards(pool, { type, q: query.get("q")?.trim() || undefined, limit }) };
  },

  async constituents({ pool, params, query }: Ctx) {
    const asOf = query.get("as_of") ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw apiErrors.badRequest("as_of 必须是 YYYY-MM-DD");
    const result = await listBoardConstituents(pool, params.code!, asOf);
    if (!result) throw apiErrors.notFound(`未知板块：${params.code}`);
    return { data: result };
  },
};
