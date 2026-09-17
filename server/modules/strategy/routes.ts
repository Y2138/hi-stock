import type pg from "pg";
import { getCurrentStrategy } from "./repo.js";

interface Ctx {
  pool: pg.Pool;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export const strategyRoutes = {
  async current({ pool }: Ctx) {
    return { data: await getCurrentStrategy(pool) };
  },
};
