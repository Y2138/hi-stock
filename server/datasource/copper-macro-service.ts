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
/**
 * OECD CLI 历史回补用的发布滞后假设：月末 + 45 天。
 *
 * 仅用于「首次建库」和「历史缺口」的合成发布时间：上游不公开单期发布日期，
 * 45 天是 OECD 月度 CLI 月末到发布的保守上界，避免回测提前使用当时尚未发布的月份。
 * 已建库后新出现的月份不再用本常量推算，一律以首次观测到的时间作为真实下界。
 */
export const MACRO_HISTORICAL_PUBLICATION_LAG_DAYS = 45;

export interface CopperMacroSyncResult {
  targetDate: string;
  rowsWritten: number;
  seriesUpdated: string[];
  fetchRunId: string;
  gaps: Array<{ code: string; reason: string }>;
  /** 上游本次返回的最新报告期（yyyy-MM），无数据时为 null。 */
  upstreamLatestPeriod: string | null;
  /** 上游有值但未写入的期次及原因，供运行日志解释「写入 0 条」。 */
  skipped: Array<{ period: string; reason: string }>;
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
interface ExistingPoint {
  value: number;
  revision_no: number;
}

/** 读取两条序列每个报告期的最新版本，用于判断新增期次与修订。 */
async function loadExistingPoints(db: Db): Promise<Map<string, ExistingPoint>> {
  const rows = (await db.query<{ series_code: string; period_end: string; value: number; revision_no: number }>(
    `WITH ranked AS (
       SELECT series.series_code,observation.period_end::text period_end,
              observation.value::float8 value,observation.revision_no,
              row_number() OVER(PARTITION BY series.series_code,observation.period_end
                                ORDER BY observation.published_at DESC,observation.revision_no DESC) rn
         FROM market_factor_observation observation
         JOIN market_factor_series series ON series.id=observation.series_id
        WHERE series.series_code=ANY($1::text[]))
     SELECT series_code,period_end,value,revision_no FROM ranked WHERE rn=1`,
    [[SERIES.g7, SERIES.china]],
  )).rows;
  return new Map(rows.map((row) => [`${row.series_code}:${row.period_end}`, { value: row.value, revision_no: row.revision_no }]));
}

async function writePoint(db: Db, input: {
  seriesCode: string; month: string; value: number; publishedAt: string; revisionNo: number;
  synthetic: boolean; sourceRef: string; rawSummary: Record<string, unknown>;
}): Promise<void> {
  const bounds = monthBounds(input.month);
  await storeMarketFactorObservation(db, {
    seriesCode: input.seriesCode,
    periodStart: bounds.start,
    periodEnd: bounds.end,
    publishedAt: input.publishedAt,
    revisionNo: input.revisionNo,
    value: input.value,
    sourceRef: input.sourceRef,
    rawSummary: { ...input.rawSummary, latest_vintage: true, synthetic_initial_published_at: input.synthetic },
  });
}

export async function syncCopperMacroFactors(
  db: Db,
  targetDate: string,
  deps: { fetchImpl?: FetchLike; now?: Date; jobRunId?: string } = {},
): Promise<CopperMacroSyncResult> {
  const now = deps.now ?? new Date();
  const gaps: Array<{ code: string; reason: string }> = [];
  const updated = new Set<string>();
  const skipped: Array<{ period: string; reason: string }> = [];
  let rowsWritten = 0;
  let upstreamLatestPeriod: string | null = null;
  await upsertMarketFactorSeries(db, { seriesCode: SERIES.g7, market: "GLOBAL", metricCode: "leading_indicator", frequency: "monthly", unit: "index", source: "oecd_sdmx", sourceTimezone: "Asia/Shanghai", revisionPolicy: "revisable" });
  await upsertMarketFactorSeries(db, { seriesCode: SERIES.china, market: "CN", metricCode: "leading_indicator", frequency: "monthly", unit: "index", source: "oecd_sdmx", sourceTimezone: "Asia/Shanghai", revisionPolicy: "revisable" });
  const existing = await loadExistingPoints(db);
  const frontier = new Map<string, string>();
  const initialBackfill = new Set<string>();
  for (const seriesCode of [SERIES.g7, SERIES.china]) {
    if (![...existing.keys()].some((key) => key.startsWith(`${seriesCode}:`))) initialBackfill.add(seriesCode);
  }
  for (const key of existing.keys()) {
    const at = key.indexOf(":");
    const seriesCode = key.slice(0, at);
    const period = key.slice(at + 1);
    if ((frontier.get(seriesCode) ?? "") < period) frontier.set(seriesCode, period);
  }
  try {
    const raw = await fetchText(OECD_URL, deps.fetchImpl);
    const rows = csvRows(raw).filter((row) => ["G7", "CHN"].includes(row.REF_AREA ?? "") && /^\d{4}-\d{2}$/.test(row.TIME_PERIOD ?? "") && Number.isFinite(Number(row.OBS_VALUE)));
    if (rows.length === 0) gaps.push({ code: "oecd_cli", reason: "上游未返回 G7/CHN 月度观测" });
    for (const row of rows) {
      const month = row.TIME_PERIOD!;
      const bounds = monthBounds(month);
      const value = Number(row.OBS_VALUE);
      const seriesCode = row.REF_AREA === "G7" ? SERIES.g7 : SERIES.china;
      if (!upstreamLatestPeriod || month > upstreamLatestPeriod) upstreamLatestPeriod = month;
      const existingPoint = existing.get(`${seriesCode}:${bounds.end}`);
      if (existingPoint) {
        if (existingPoint.value === value) {
          skipped.push({ period: month, reason: "上游值未变化" });
          continue;
        }
        // 已有报告期被上游修订：以本次观测时间为新的发布时间，保留历史版本。
        await writePoint(db, {
          seriesCode, month, value, publishedAt: now.toISOString(),
          revisionNo: existingPoint.revision_no + 1, synthetic: false, sourceRef: OECD_URL,
          rawSummary: { area: row.REF_AREA, observation_status: row.OBS_STATUS ?? null, revision_observed_at: now.toISOString() },
        });
        rowsWritten++;
        updated.add(seriesCode);
        continue;
      }
      // 首次建库或补历史缺口：保留文档化的滞后假设，并标记为合成发布时间。
      const isHistoricalBackfill = initialBackfill.has(seriesCode) || (frontier.get(seriesCode) ?? "") > bounds.end;
      const publishedAt = isHistoricalBackfill
        ? `${addDays(bounds.end, MACRO_HISTORICAL_PUBLICATION_LAG_DAYS)}T09:00:00+08:00`
        : now.toISOString();
      await writePoint(db, {
        seriesCode, month, value, publishedAt, revisionNo: 0, synthetic: isHistoricalBackfill, sourceRef: OECD_URL,
        rawSummary: isHistoricalBackfill
          ? { area: row.REF_AREA, observation_status: row.OBS_STATUS ?? null, availability_lag_days: MACRO_HISTORICAL_PUBLICATION_LAG_DAYS }
          : { area: row.REF_AREA, observation_status: row.OBS_STATUS ?? null, first_observed_at: now.toISOString() },
      });
      rowsWritten++;
      updated.add(seriesCode);
    }
  } catch (error) {
    gaps.push({ code: "oecd_cli", reason: (error as Error).message });
  }
  const fetchRunId = await recordCommodityFetchRun(db, {
    channel: "public_macro",
    scope: { dataset: "copper_macro", target_date: targetDate, upstream_latest_period: upstreamLatestPeriod, skipped_periods: skipped.length },
    rowsWritten,
    gaps,
    jobRunId: deps.jobRunId,
  });
  return { targetDate, rowsWritten, seriesUpdated: [...updated], fetchRunId, gaps, upstreamLatestPeriod, skipped };
}
