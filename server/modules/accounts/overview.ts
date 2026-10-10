import type pg from "pg";
import { ApiError } from "../../http/router.js";
import { listAccounts } from "./repo.js";
import { listPositions } from "../positions/repo.js";
import { getLatestDailyPlanBoard } from "../plans/repo.js";
import { listJobDefinitions } from "../../scheduler/repo.js";

/** 全账户只读总览，复用领域事实；查询失败不降级成空持仓。 */
export async function getAccountOverview(pool: pg.Pool) {
  const accounts = await listAccounts(pool);
  const [globalJobs, portfolios] = await Promise.all([
    listJobDefinitions(pool).then(jobs => jobs.filter(job => job.execution_scope === "global")),
    Promise.all(accounts.map(async account => {
      const [positions, plan, jobs] = await Promise.all([
        listPositions(pool, account.id),
        getLatestDailyPlanBoard(pool, account.id).catch(error => {
          if (error instanceof ApiError && error.httpStatus === 404) return null;
          throw error;
        }),
        listJobDefinitions(pool, account.id).then(jobs => jobs.filter(job => job.execution_scope === "account")),
      ]);
      return { account, positions, plan, jobs };
    })),
  ]);
  return { accounts: portfolios, global_jobs: globalJobs };
}
