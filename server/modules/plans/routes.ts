import { getLatestDailyPlanBoard, getLatestAuctionScopeAssessments } from "./repo.js";

interface Ctx {
  pool: import("pg").Pool;
}

export const plansRoutes = {
  async latest({ pool }: Ctx) {
    return { data: await getLatestDailyPlanBoard(pool) };
  },
  async latestAuction({ pool }: Ctx) {
    return { data: await getLatestAuctionScopeAssessments(pool) };
  },
};
