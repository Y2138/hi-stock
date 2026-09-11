import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import { getNotificationSettings, updateNotificationSettings, previewJobConclusion, queueTestNotification, listNotifications, getNotification, retryNotification } from "./service.js";
interface Ctx { pool: pg.Pool; body: unknown; params: Record<string, string>; query: URLSearchParams }
function id(value: string): string {
  if (!/^[1-9][0-9]{0,17}$/.test(value)) throw apiErrors.badRequest("通知编号不合法");
  return value;
}
function jobCode(query: URLSearchParams): string | undefined {
  const value = query.get("job_code");
  if (value !== null && !/^[a-z][a-z0-9_]{0,99}$/.test(value)) throw apiErrors.badRequest("任务编码不合法");
  return value ?? undefined;
}
export const notificationRoutes = {
  async settings({ pool }: Ctx) { return { data: await getNotificationSettings(pool) }; },
  async update({ pool, body }: Ctx) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw apiErrors.badRequest("请求体必须是对象");
    return { data: await updateNotificationSettings(pool, body as Record<string, unknown>) };
  },
  async preview({ pool, query }: Ctx) { return { data: await previewJobConclusion(pool, undefined, jobCode(query)) }; },
  async test({ pool }: Ctx) { return { status: 202, data: await queueTestNotification(pool) }; },
  async list({ pool, query }: Ctx) {
    const status = query.get("status") ?? undefined;
    if (status !== undefined && !["pending", "sending", "sent", "failed", "cancelled"].includes(status)) throw apiErrors.badRequest("通知状态不合法");
    const before = query.has("before") ? id(query.get("before")!) : undefined;
    return { data: await listNotifications(pool, { before, status, jobCode: jobCode(query) }) };
  },
  async detail({ pool, params }: Ctx) { return { data: await getNotification(pool, id(params.id ?? "")) }; },
  async retry({ pool, params }: Ctx) { return { status: 202, data: await retryNotification(pool, id(params.id ?? "")) }; },
};
