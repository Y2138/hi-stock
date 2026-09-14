// 回测台账 HTTP 路由处理
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v1.0.md §五
import pg from "pg";
import { getStandardBacktestStatus, getStandardRunPage } from "./runtime.js";
import { apiErrors } from "../../http/router.js";
import {
  getBacktestRunDetail,
  getVersionedBacktestSource,
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
  async listRuns({ pool, query }: Ctx) {
    const scope=query.get("scope")??undefined;
    const limit=query.has("limit")?Number(query.get("limit")):100;
    const before=query.get("before")??undefined;
    if ((scope && !["final","working","all"].includes(scope)) || !Number.isInteger(limit) || limit<1 || limit>200 || (before&&!/^[1-9]\d{0,18}$/.test(before))) throw apiErrors.badRequest("回测列表分页参数非法");
    return { data: await listBacktestRuns(pool,{scope:scope as "final"|"working"|"all"|undefined,limit,before}) };
  },

  /** GET /api/backtests/:id：最终结果与历史比较。 */
  async getRun({ pool, params, query }: Ctx) {
    if(!/^[1-9]\d{0,18}$/.test(params.id??""))throw apiErrors.badRequest("回测编号非法");
    const view=query.get("view");
    if(view){
      if(!["runtime","events","equity"].includes(view))throw apiErrors.badRequest("回测视图非法");
      const status=await getStandardBacktestStatus(pool,params.id!);
      if(!status)throw apiErrors.notFound("标准回测不存在");
      if(view==='runtime')return {data:status};
      try { return {data:await getStandardRunPage(pool,params.id!,view as 'events'|'equity',query.get('after')??undefined,query.has('limit')?Number(query.get('limit')):100)}; }
      catch(error){if(/分页/.test((error as Error).message))throw apiErrors.badRequest("分页参数非法");throw error;}
    }
    const run = await getBacktestRunDetail(pool, params.id!);
    if (!run) throw apiErrors.notFound(`回测运行不存在：${params.id}`);
    return { data: run };
  },

  /** GET /api/backtests/:id/source：只读已最终化的源码版本。 */
  async getSource({ pool, params }: Ctx) {
    const source = await getVersionedBacktestSource(pool, params.id!);
    if (!source) throw apiErrors.notFound(`回测运行没有可查看的固化源码：${params.id}`);
    return { data: source };
  },
};
