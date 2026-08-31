import { getLatestDailyPlanBoard } from "./repo.js";

interface Ctx {
  pool: import("pg").Pool;
}

export const plansRoutes = {
  async latest({ pool }: Ctx) {
    return { data: await getLatestDailyPlanBoard(pool) };
  },
};
