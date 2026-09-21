// 铜左侧启动策略宏观因子同步：免费来源、点时落库、修订显式保留。
import http2 from "node:http2";
import type pg from "pg";
import { recordCommodityFetchRun, storeMarketFactorObservation, upsertMarketFactorSeries } from "./commodity-service.js";

const OECD_URL = "https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_CLI,4.1/.M.LI...AA...H?startPeriod=2014-01&dimensionAtObservation=AllDimensions";
const SERIES = {
  g7: "oecd.g7.cli",
  china: "oecd.chn.cli",
} as const;

type FetchLike = typeof fetch;
type Db = pg.Pool;
export interface CopperMacroSyncResult {
  targetDate: string;
  rowsWritten: number;
  seriesUpdated: string[];
  fetchRunId: string;
  gaps: Array<{ code: string; reason: string }>;
}

function monthBounds(month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`月份格式非法：${month}`);
  const [year, value] = month.split("-").map(Number);
  const start = `${month}-01`;
  const end = new Date(Date.UTC(year!, value!, 0)).toISOString().slice(0, 10);
  return { start, end };
}
function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function csvLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { values.push(value); value = ""; }
    else value += char;
  }
  values.push(value);
  return values;
}
function csvRows(raw: string): Record<string, string>[] {
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  const headers = csvLine(lines.shift() ?? "");
  return lines.map((line) => Object.fromEntries(headers.map((header, index) => [header, csvLine(line)[index] ?? ""])));
}
async function fetchText(url: string, fetchImpl?: FetchLike) {
  if (fetchImpl) {
    const response = await fetchImpl(url, { headers: { accept: "text/csv", "user-agent": "hi-stock/1.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }
  const parsed = new URL(url);
  return new Promise<string>((resolve, reject) => {
    const client = http2.connect(parsed.origin);
    const request = client.request({ ":path": `${parsed.pathname}${parsed.search}`, accept: "text/csv", "user-agent": "hi-stock/1.0" });
    let status = 0; let body = "";
    request.setEncoding("utf8");
    request.on("response", (headers) => { status = Number(headers[":status"] ?? 0); });
    request.on("data", (chunk) => { body += chunk; });
    request.on("error", (error) => { client.close(); reject(error); });
    request.on("end", () => { client.close(); status >= 200 && status < 300 ? resolve(body) : reject(new Error(`HTTP ${status}`)); });
    request.end();
  });
}
async function storePoint(db: Db, input: {
  seriesCode: string; month: string; value: number; initialPublishedDate: string; sourceRef: string;
  now: Date; rawSummary: Record<string, unknown>;
}) {
  const bounds = monthBounds(input.month);
  const latest = (await db.query<{ value: number; revision_no: number }>(
    `SELECT observation.value::float8,observation.revision_no
       FROM market_factor_observation observation JOIN market_factor_series series ON series.id=observation.series_id
      WHERE series.series_code=$1 AND observation.period_start=$2 AND observation.period_end=$3
      ORDER BY observation.published_at DESC,observation.revision_no DESC LIMIT 1`,
    [input.seriesCode, bounds.start, bounds.end],
  )).rows[0];
  if (latest && latest.value === input.value) return false;
  const revisionNo = latest ? latest.revision_no + 1 : 0;
  const publishedAt = latest
    ? input.now.toISOString()
    : `${input.initialPublishedDate}T09:00:00+08:00`;
  await storeMarketFactorObservation(db, {
    seriesCode: input.seriesCode,
    periodStart: bounds.start,
    periodEnd: bounds.end,
    publishedAt,
    revisionNo,
    value: input.value,
    sourceRef: input.sourceRef,
    rawSummary: { ...input.rawSummary, latest_vintage: true, synthetic_initial_published_at: !latest },
  });
  return true;
}

export async function syncCopperMacroFactors(
  db: Db,
  targetDate: string,
  deps: { fetchImpl?: FetchLike; now?: Date; jobRunId?: string } = {},
): Promise<CopperMacroSyncResult> {
  const now = deps.now ?? new Date();
  const gaps: Array<{ code: string; reason: string }> = [];
  const updated = new Set<string>();
  let rowsWritten = 0;
  await upsertMarketFactorSeries(db, { seriesCode: SERIES.g7, market: "GLOBAL", metricCode: "leading_indicator", frequency: "monthly", unit: "index", source: "oecd_sdmx", sourceTimezone: "Asia/Shanghai", revisionPolicy: "revisable" });
  await upsertMarketFactorSeries(db, { seriesCode: SERIES.china, market: "CN", metricCode: "leading_indicator", frequency: "monthly", unit: "index", source: "oecd_sdmx", sourceTimezone: "Asia/Shanghai", revisionPolicy: "revisable" });
  try {
    const raw = await fetchText(OECD_URL, deps.fetchImpl);
    const rows = csvRows(raw).filter((row) => ["G7", "CHN"].includes(row.REF_AREA ?? "") && /^\d{4}-\d{2}$/.test(row.TIME_PERIOD ?? "") && Number.isFinite(Number(row.OBS_VALUE)));
    for (const row of rows) {
      const bounds = monthBounds(row.TIME_PERIOD!);
      const available = addDays(bounds.end, 45);
      if (available > targetDate) continue;
      const seriesCode = row.REF_AREA === "G7" ? SERIES.g7 : SERIES.china;
      if (await storePoint(db, { seriesCode, month: row.TIME_PERIOD!, value: Number(row.OBS_VALUE), initialPublishedDate: available, sourceRef: OECD_URL, now, rawSummary: { area: row.REF_AREA, observation_status: row.OBS_STATUS ?? null, availability_lag_days: 45 } })) {
        rowsWritten++;
        updated.add(seriesCode);
      }
    }
  } catch (error) {
    gaps.push({ code: "oecd_cli", reason: (error as Error).message });
  }
  const fetchRunId = await recordCommodityFetchRun(db, {
    channel: "public_macro",
    scope: { dataset: "copper_macro", target_date: targetDate },
    rowsWritten,
    gaps,
    jobRunId: deps.jobRunId,
  });
  return { targetDate, rowsWritten, seriesUpdated: [...updated], fetchRunId, gaps };
}
