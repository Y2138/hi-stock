import { getLatestDailyPlanBoard, getLatestAuctionScopeAssessments, getLatestLimitUpOpportunities } from "./repo.js";

interface Ctx {
  pool: import("pg").Pool;
  query: URLSearchParams;
}

export const plansRoutes = {
  async latest({ pool, query }: Ctx) {
    return { data: await getLatestDailyPlanBoard(pool, query.get("account_id") ?? "1") };
  },
  async latestLimitUp({ pool }: Ctx) {
    return { data: await getLatestLimitUpOpportunities(pool) };
  },
  async latestAuction({ pool, query }: Ctx) {
    return { data: await getLatestAuctionScopeAssessments(pool, query.get("scope") === "global" ? null : query.get("account_id") ?? "1") };
  },
};
