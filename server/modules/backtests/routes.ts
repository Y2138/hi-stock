// 回测台账 HTTP 路由处理
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v1.0.md §五
import pg from "pg";
import { apiErrors } from "../../http/router.js";
import {
  getBacktestRunWithArtifacts,
  listBacktestRuns,
} from "./repo.js";

interface Ctx {
  pool: pg.Pool;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export const backtestRoutes = {
  /** GET /api/backtests：Agent 回测结论与历史兼容记录，只读。 */
  async listRuns({ pool }: Ctx) {
    return { data: await listBacktestRuns(pool) };
  },

  /** GET /api/backtests/:id：运行 + artifacts（join dataset） */
  async getRun({ pool, params }: Ctx) {
    const run = await getBacktestRunWithArtifacts(pool, params.id!);
    if (!run) throw apiErrors.notFound(`回测运行不存在：${params.id}`);
    return { data: run };
  },
};
