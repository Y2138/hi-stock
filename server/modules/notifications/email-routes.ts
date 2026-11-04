import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import {
  getEmailDelivery,
  getEmailNotificationSettings,
  listEmailDeliveries,
  queueTestEmail,
  retryEmailDelivery,
  updateEmailNotificationSettings,
} from "./email.js";

interface Ctx { pool: pg.Pool; body: unknown; params: Record<string, string>; query: URLSearchParams }

const STATUSES = ["pending", "sending", "sent", "failed", "cancelled"];

function deliveryId(value: string): string {
  if (!/^[1-9][0-9]{0,17}$/.test(value)) throw apiErrors.badRequest("邮件投递编号不合法");
  return value;
}

export const emailNotificationRoutes = {
  async settings({ pool }: Ctx) {
    const settings = await getEmailNotificationSettings(pool);
    if (!settings) throw apiErrors.badRequest("邮件设置尚未初始化，请先运行数据库迁移");
    return { data: settings };
  },
  async update({ pool, body }: Ctx) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw apiErrors.badRequest("请求体必须是对象");
    return { data: await updateEmailNotificationSettings(pool, body as Record<string, unknown>) };
  },
  async test({ pool }: Ctx) {
    return { status: 202, data: await queueTestEmail(pool) };
  },
  async deliveries({ pool, query }: Ctx) {
    const status = query.get("status") ?? undefined;
    if (status !== undefined && !STATUSES.includes(status))
      throw apiErrors.badRequest("邮件投递状态不合法");
    const before = query.has("before") ? deliveryId(query.get("before")!) : undefined;
    const rawLimit = query.get("limit");
    const limit = rawLimit === null ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw apiErrors.badRequest("邮件投递数量必须是 1–50 的整数");
    return { data: await listEmailDeliveries(pool, { before, status, limit }) };
  },
  async delivery({ pool, params }: Ctx) {
    return { data: await getEmailDelivery(pool, deliveryId(params.id ?? "")) };
  },
  async retry({ pool, params }: Ctx) {
    return { status: 202, data: await retryEmailDelivery(pool, deliveryId(params.id ?? "")) };
  },
};
