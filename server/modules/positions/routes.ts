// 持仓 HTTP 路由处理：持仓查询、事件流、账户快照、手工记录成交
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §十；产品方案 §6.6
import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import {
  getAccountSummary,
  listAccountSnapshots,
  listPositionChanges,
  listPositions,
} from "./repo.js";

interface Ctx {
  pool: pg.Pool;
  params: Record<string, string>;
  query: URLSearchParams;
}

export const positionRoutes = {
  /** GET /api/positions：持仓 join 最新收盘/市值/盈亏（pnl_amount = 数量×(收盘−成本)） */
  async list({ pool }: Ctx) {
    return { data: await listPositions(pool) };
  },

  /** GET /api/positions/changes?limit=100：变更事件流 */
  async changes({ pool, query }: Ctx) {
    const limitRaw = query.get("limit");
    const limit = limitRaw ? Number(limitRaw) : 100;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
      throw apiErrors.badRequest(`limit 非法：${limitRaw}`);
    }
    return { data: await listPositionChanges(pool, limit) };
  },

  /** GET /api/account/snapshots：账户快照序列（snap_date 升序） */
  async accountSnapshots({ pool }: Ctx) {
    return { data: await listAccountSnapshots(pool) };
  },

  /** GET /api/account/summary：实时资金摘要（台账现金 + 持仓×最新收盘派生市值/总资金） */
  async accountSummary({ pool }: Ctx) {
    return { data: await getAccountSummary(pool) };
  },
};
