import type pg from "pg";
import { fetchLimitPoolPage } from "../../datasource/hithink-special.js";

type Db = Pick<pg.Pool, "query">;
const MAX_AGE_MS = 5 * 60_000;

export async function refreshIntradaySentiment(db: Db, date: string, at: Date): Promise<void> {
  const latest = (await db.query<{ captured_at: string }>(
    "SELECT captured_at::text FROM intraday_market_sentiment WHERE trade_date=$1 ORDER BY captured_at DESC LIMIT 1", [date],
  )).rows[0];
  if (latest && at.getTime() - new Date(latest.captured_at).getTime() < MAX_AGE_MS) return;
  const datasets = ["up", "down", "break"] as const;
  const results = await Promise.allSettled(datasets.map((dataset) => fetchLimitPoolPage(dataset, { tradeDate: date, page: 1, size: 1 }, { db, priority: "interactive" })));
  const counts: Record<string, number | null> = {};
  const sourceTimes: Record<string, string | null> = {};
  const gaps: string[] = [];
  results.forEach((result, index) => {
    const dataset = datasets[index]!;
    const valid = result.status === "fulfilled" && Number.isInteger(result.value.total) && result.value.total >= 0
      && Number.isFinite(result.value.timestampMs) && result.value.timestampMs <= at.getTime() + 30_000
      && at.getTime() - result.value.timestampMs <= MAX_AGE_MS
      && new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(result.value.timestampMs)) === date;
    counts[dataset] = valid && result.status === "fulfilled" ? result.value.total : null;
    sourceTimes[dataset] = valid && result.status === "fulfilled" ? new Date(result.value.timestampMs).toISOString() : null;
    if (!valid) gaps.push(`${dataset} 点时总数不可用或过期`);
  });
  await db.query(`INSERT INTO intraday_market_sentiment(trade_date,captured_at,status,payload) VALUES($1,$2,$3,$4::jsonb)`,
    [date, at, gaps.length === 0 ? "ready" : gaps.length === 3 ? "unavailable" : "partial", JSON.stringify({ counts, source_times: sourceTimes, gaps })]);
}

export async function readIntradaySentiment(db: Db, date: string, at: Date) {
  const rows = (await db.query<{ captured_at: string; status: string; payload: Record<string, unknown> }>(
    "SELECT captured_at::text,status,payload FROM intraday_market_sentiment WHERE trade_date=$1 AND captured_at<=$2 ORDER BY captured_at DESC LIMIT 6", [date, at],
  )).rows;
  const sourceTimes = rows[0]?.payload.source_times as Record<string, string | null> | undefined;
  return { ready: Boolean(rows[0] && rows[0].status === "ready" && at.getTime() - new Date(rows[0].captured_at).getTime() <= MAX_AGE_MS
    && ["up", "down", "break"].every((key) => sourceTimes?.[key] && at.getTime() - new Date(sourceTimes[key]!).getTime() <= MAX_AGE_MS && new Date(sourceTimes[key]!).getTime() <= at.getTime() + 30_000)),
    samples: rows.reverse(), note: "涨跌停与炸板为全市场点时总数；仅判断当日情绪，缺数或过期不得判定冰点" };
}
