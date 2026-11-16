// 宏观与研究因子只读路由：与 Agent 工具共用 modules/macro/service.ts 的点时口径。
import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import { queryMacroFactors } from "./service.js";

interface Ctx {
  pool: pg.Pool;
  params: Record<string, string>;
  query: URLSearchParams;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SERIES_RE = /^[a-z0-9][a-z0-9._-]{2,119}$/;

function dateParam(query: URLSearchParams, name: string): string | undefined {
  const raw = query.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = raw.trim();
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw apiErrors.badRequest(`${name} 必须为 YYYY-MM-DD：${value}`);
  }
  return value;
}

export const macroRoutes = {
  /** GET /api/macro/factors?series=oecd.g7.cli,oecd.chn.cli&start_date=&end_date=&as_of= */
  async factors({ pool, query }: Ctx) {
    const rawSeries = (query.get("series") ?? query.get("series_codes") ?? "").trim();
    const seriesCodes = rawSeries
      ? rawSeries.split(",").map((code) => code.trim()).filter(Boolean)
      : undefined;
    for (const code of seriesCodes ?? []) {
      if (!SERIES_RE.test(code)) throw apiErrors.badRequest(`series 代码非法：${code}`);
    }
    if (seriesCodes && seriesCodes.length > 20) throw apiErrors.badRequest("series 最多 20 个");
    try {
      return {
        data: await queryMacroFactors(pool, {
          seriesCodes,
          start: dateParam(query, "start_date"),
          end: dateParam(query, "end_date"),
          asOf: dateParam(query, "as_of"),
        }),
      };
    } catch (error) {
      throw apiErrors.badRequest((error as Error).message);
    }
  },
};
