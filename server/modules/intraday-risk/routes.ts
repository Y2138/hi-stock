import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import { getIntradayRisk } from "./service.js";

interface Ctx { pool: pg.Pool; query: URLSearchParams; }

export const intradayRiskRoutes = {
  async latest({ pool, query }: Ctx) {
    const code = query.get("code")?.trim().toUpperCase() || undefined;
    if (code && !/^\d{6}\.(SH|SZ|BJ)$/u.test(code)) throw apiErrors.badRequest("code 必须是完整 A 股代码");
    const date = query.get("date") || undefined;
    if (date && !/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw apiErrors.badRequest("date 必须是 YYYY-MM-DD");
    const accountId = query.get("account_id") || "1";
    if (!/^\d+$/.test(accountId) || accountId === "0") throw apiErrors.badRequest("account_id 必须是正整数");
    return { data: await getIntradayRisk(pool, date, code, accountId) };
  },
};
