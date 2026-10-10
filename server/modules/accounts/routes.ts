import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import { archiveAccount, createAccount, listAccounts, requireAccount, updateAccount } from "./repo.js";

interface Ctx {
  pool: pg.Pool;
  params: Record<string, string>;
  body: unknown;
}

function bodyName(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw apiErrors.badRequest("请求体必须是 JSON 对象");
  }
  if (Object.keys(body).some(key => key !== "name")) throw apiErrors.badRequest("仅允许修改账户名称");
  return (body as Record<string, unknown>).name;
}

export const accountRoutes = {
  async list({ pool }: Ctx) {
    return { data: await listAccounts(pool) };
  },
  async create({ pool, body }: Ctx) {
    return { status: 201, data: await createAccount(pool, bodyName(body)) };
  },
  async update({ pool, params, body }: Ctx) {
    return { data: await updateAccount(pool, params.id!, bodyName(body)) };
  },
  async archive({ pool, params }: Ctx) {
    return { data: await archiveAccount(pool, params.id!) };
  },
  async get({ pool, params }: Ctx) {
    return { data: await requireAccount(pool, params.id!) };
  },
};
