// 扶摇竞价、热榜/异动与基金研究数据的受控白名单适配和 PostgreSQL 快照缓存。
import { createHash } from "node:crypto";
import type pg from "pg";
import { inServiceTransaction, type TransactionDb } from "../db/transaction.js";
import { hithinkGet, type HithinkDeps } from "./hithink.js";
import { insertFetchRun } from "./service.js";

export const HITHINK_DATASET_CAPABILITIES = [
  "auction_snapshot",
  "auction_short_term_benchmark",
  "anomaly_list",
  "anomaly_stock",
  "skyrocket_list",
  "hot_stock_list",
  "hot_stock_history",
  "hot_stock_rank_trend",
  "fund_profile",
  "fund_holdings",
  "fund_nav",
  "fund_returns",
  "fund_holders",
  "fund_company",
  "fund_industry_allocation",
  "fund_performance_indicators",
  "fund_drawdowns",
  "fund_top_holders",
  "fund_dividends",
  "fund_diagnostics",
  "fund_financial_indicators",
  "fund_income_statements",
  "fund_balance_sheets",
  "fund_manager_style",
  "fund_manager_performance",
  "fund_manager_experience",
  "fund_manager_detail",
  "fund_news",
  "fund_offerings",
  "fund_stock_history",
  "fund_stock_report_dates",
  "fund_bond_history",
  "fund_bond_report_dates",
  "fund_asset_allocation",
] as const;

export type HithinkDatasetCapability = (typeof HITHINK_DATASET_CAPABILITIES)[number];
export type FundType = "otc" | "exchange" | "reits";
export type AnomalyTag =
  | "LIMIT_UP"
  | "LIMIT_DOWN"
  | "SHARP_RISE"
  | "SHARP_FALL"
  | "RAPID_RALLY"
  | "RAPID_DECLINE";

export interface HithinkDatasetRequest {
  capability: HithinkDatasetCapability;
  code?: string;
  codes?: string[];
  fund_type?: FundType;
  stage?: "live" | "final";
  date?: string;
  period?: "day" | "hour";
  tags?: AnomalyTag[];
  start?: string;
  end?: string;
  range?: "week" | "month" | "tmonth" | "hyear" | "year" | "twoyear" | "tyear" | "fyear" | "nowyear" | "now";
  nav_type?: "unit" | "adj" | "unit,adj";
  merge_scope?: "all" | "merged" | "separate";
  manager_id?: string;
  company_id?: string;
  subscribe?: "active" | "upcoming";
  limit?: number;
  cursor?: string;
  report_type?: string;
  end_date?: string;
}

type RequestField = Exclude<keyof HithinkDatasetRequest, "capability">;

interface DatasetSpec {
  path: string;
  params: Partial<Record<RequestField, string>>;
  required?: readonly RequestField[];
}

const fundCode = (path: string, extra: DatasetSpec["params"] = {}, required: readonly RequestField[] = []): DatasetSpec => ({
  path,
  params: { fund_type: "fund_type", code: "thscode", ...extra },
  required: ["fund_type", "code", ...required],
});

const manager = (path: string, extra: DatasetSpec["params"] = {}, required: readonly RequestField[] = []): DatasetSpec => ({
  path,
  params: { manager_id: "manager_id", ...extra },
  required: ["manager_id", ...required],
});

export const HITHINK_DATASET_SPECS: Record<HithinkDatasetCapability, DatasetSpec> = {
  auction_snapshot: {
    path: "/api/a-share/auction/snapshot",
    params: { codes: "thscodes", stage: "stage" },
    required: ["codes"],
  },
  auction_short_term_benchmark: {
    path: "/api/a-share/auction/short-term-benchmark",
    params: { date: "date" },
  },
  anomaly_list: {
    path: "/api/a-share/special-data/anomaly-analysis-list",
    params: { tags: "tag_codes" },
  },
  anomaly_stock: {
    path: "/api/a-share/special-data/anomaly-analysis-stock",
    params: { codes: "thscodes" },
    required: ["codes"],
  },
  skyrocket_list: {
    path: "/api/a-share/special-data/skyrocket-list",
    params: { period: "period" },
  },
  hot_stock_list: {
    path: "/api/a-share/special-data/hot-stock-list",
    params: { period: "period" },
  },
  hot_stock_history: {
    path: "/api/a-share/special-data/hot-stock-list-history",
    params: { date: "date" },
    required: ["date"],
  },
  hot_stock_rank_trend: {
    path: "/api/a-share/special-data/hot-stock-rank-trend",
    params: { code: "thscode", start: "start_date", end: "end_date" },
    required: ["code", "start", "end"],
  },
  fund_profile: fundCode("/api/fund/profile/detail"),
  fund_holdings: fundCode("/api/fund/portfolio/holdings"),
  fund_nav: fundCode("/api/fund/performance/nav", { range: "range", nav_type: "nav_type" }),
  fund_returns: fundCode("/api/fund/performance/returns"),
  fund_holders: fundCode("/api/fund/holders/detail", { merge_scope: "merge_scope" }),
  fund_company: {
    path: "/api/fund/companies/detail",
    params: { company_id: "company_id" },
    required: ["company_id"],
  },
  fund_industry_allocation: fundCode("/api/fund/portfolio/industry-allocation"),
  fund_performance_indicators: fundCode(
    "/api/fund/performance/indicators-historical",
    { start: "start", end: "end" },
    ["start", "end"],
  ),
  fund_drawdowns: fundCode("/api/fund/performance/drawdowns"),
  fund_top_holders: fundCode("/api/fund/holders/top", { limit: "limit" }),
  fund_dividends: fundCode("/api/fund/corporate-actions/dividends"),
  fund_diagnostics: fundCode("/api/fund/diagnostics/detail"),
  fund_financial_indicators: fundCode("/api/fund/financials/indicators"),
  fund_income_statements: fundCode("/api/fund/financials/income-statements"),
  fund_balance_sheets: fundCode("/api/fund/financials/balance-sheets"),
  fund_manager_style: manager("/api/fund/managers/investment-style"),
  fund_manager_performance: manager("/api/fund/managers/performance", { range: "range" }, ["range"]),
  fund_manager_experience: manager("/api/fund/managers/experience"),
  fund_manager_detail: manager("/api/fund/managers/detail"),
  fund_news: fundCode("/api/fund/news/article-list", { limit: "limit", cursor: "offset" }),
  fund_offerings: {
    path: "/api/fund/offerings/list",
    params: { subscribe: "subscribe" },
    required: ["subscribe"],
  },
  fund_stock_history: fundCode(
    "/api/fund/portfolio/stock-history",
    { report_type: "report_type", end_date: "end_date" },
    ["report_type", "end_date"],
  ),
  fund_stock_report_dates: fundCode(
    "/api/fund/portfolio/stock-report-dates",
    { report_type: "report_type" },
  ),
  fund_bond_history: fundCode(
    "/api/fund/portfolio/bond-history",
    { report_type: "report_type", end_date: "end_date" },
    ["report_type", "end_date"],
  ),
  fund_bond_report_dates: fundCode(
    "/api/fund/portfolio/bond-report-dates",
    { report_type: "report_type" },
  ),
  fund_asset_allocation: fundCode("/api/fund/portfolio/asset-allocation"),
};

const STOCK_CODE_RE = /^\d{6}\.(?:SH|SZ|BJ)$/;
const FUND_CODE_RE = /^\d{6}\.(?:SH|SZ|BJ|OF)$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const FUND_TYPES = ["otc", "exchange", "reits"] as const;
const ANOMALY_TAGS = [
  "LIMIT_UP", "LIMIT_DOWN", "SHARP_RISE", "SHARP_FALL", "RAPID_RALLY", "RAPID_DECLINE",
] as const;
const NAV_RANGES = ["week", "month", "tmonth", "hyear", "year", "twoyear", "tyear", "fyear"] as const;
const MANAGER_RANGES = ["month", "tmonth", "year", "nowyear", "now"] as const;

function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function assertDate(value: string | undefined, field: string): asserts value is string {
  if (!value || !isRealDate(value)) throw new Error(`${field} 必须是有效的 YYYY-MM-DD 日期`);
}

function exceedsYears(start: string, end: string, years: number): boolean {
  const limit = new Date(`${start}T00:00:00Z`);
  limit.setUTCFullYear(limit.getUTCFullYear() + years);
  return end > limit.toISOString().slice(0, 10);
}

function shanghaiTimestamp(day: string, endOfDay = false): number {
  const [year, month, date] = day.split("-").map(Number);
  const start = Date.UTC(year!, month! - 1, date!) - 8 * 60 * 60 * 1000;
  return endOfDay ? start + 24 * 60 * 60 * 1000 - 1 : start;
}

function shanghaiDate(timestampMs: number): string {
  return new Date(timestampMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function normalizeCodes(codes: string[] | undefined, max: number): string[] {
  if (!codes?.length || codes.length > max) throw new Error(`codes 必须包含 1–${max} 个 A 股完整代码`);
  const normalized = codes.map((code) => code.trim().toUpperCase());
  if (normalized.some((code) => !STOCK_CODE_RE.test(code))) throw new Error("codes 只接受带交易所后缀的 A 股代码");
  return [...new Set(normalized)];
}

export function normalizeHithinkDatasetRequest(input: HithinkDatasetRequest): HithinkDatasetRequest {
  if (!(HITHINK_DATASET_CAPABILITIES as readonly string[]).includes(input.capability)) {
    throw new Error(`未知扶摇数据能力：${String(input.capability)}`);
  }
  const spec = HITHINK_DATASET_SPECS[input.capability];
  const allowed = new Set(Object.keys(spec.params));
  for (const [key, value] of Object.entries(input)) {
    if (key !== "capability" && value !== undefined && !allowed.has(key)) {
      throw new Error(`${input.capability} 不接受参数 ${key}`);
    }
  }
  for (const field of spec.required ?? []) {
    const value = input[field];
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
      throw new Error(`${input.capability} 缺少参数 ${field}`);
    }
  }

  const normalized: HithinkDatasetRequest = { capability: input.capability };
  for (const field of Object.keys(spec.params) as RequestField[]) {
    const value = input[field];
    if (value !== undefined) (normalized as unknown as Record<string, unknown>)[field] = value;
  }
  if (normalized.codes !== undefined) {
    if (!Array.isArray(normalized.codes)) throw new Error("codes 必须是数组");
    normalized.codes = normalizeCodes(normalized.codes, input.capability === "anomaly_stock" ? 50 : 100);
  }
  if (normalized.code) {
    if (typeof normalized.code !== "string") throw new Error("code 必须是字符串");
    normalized.code = normalized.code.trim().toUpperCase();
    const pattern = input.capability.startsWith("fund_") ? FUND_CODE_RE : STOCK_CODE_RE;
    if (!pattern.test(normalized.code)) throw new Error(`${input.capability} 的 code 格式非法`);
  }
  if (normalized.fund_type && !(FUND_TYPES as readonly string[]).includes(normalized.fund_type)) {
    throw new Error("fund_type 必须是 otc/exchange/reits");
  }
  if (normalized.stage && !["live", "final"].includes(normalized.stage)) throw new Error("stage 必须是 live/final");
  if (normalized.period && !["day", "hour"].includes(normalized.period)) throw new Error("period 必须是 day/hour");
  if (normalized.tags) {
    if (!Array.isArray(normalized.tags) || normalized.tags.length === 0 || normalized.tags.length > ANOMALY_TAGS.length) {
      throw new Error("tags 必须包含 1–6 个异动标签");
    }
    const tags = normalized.tags.map((tag) => String(tag).toUpperCase() as AnomalyTag);
    if (tags.some((tag) => !(ANOMALY_TAGS as readonly string[]).includes(tag))) throw new Error("tags 包含未知异动标签");
    normalized.tags = [...new Set(tags)];
  }
  if (normalized.nav_type && !["unit", "adj", "unit,adj"].includes(normalized.nav_type)) {
    throw new Error("nav_type 必须是 unit/adj/unit,adj");
  }
  if (normalized.merge_scope && !["all", "merged", "separate"].includes(normalized.merge_scope)) {
    throw new Error("merge_scope 必须是 all/merged/separate");
  }
  if (normalized.subscribe && !["active", "upcoming"].includes(normalized.subscribe)) {
    throw new Error("subscribe 必须是 active/upcoming");
  }
  if (input.capability === "fund_nav" && normalized.range && !(NAV_RANGES as readonly string[]).includes(normalized.range)) {
    throw new Error("基金净值 range 非法");
  }
  if (normalized.manager_id && (typeof normalized.manager_id !== "string" || !ID_RE.test(normalized.manager_id))) {
    throw new Error("manager_id 格式非法");
  }
  if (normalized.company_id && (typeof normalized.company_id !== "string" || !ID_RE.test(normalized.company_id))) {
    throw new Error("company_id 格式非法");
  }
  if (normalized.report_type) {
    if (typeof normalized.report_type !== "string") throw new Error("report_type 格式非法");
    normalized.report_type = normalized.report_type.trim();
    if (!ID_RE.test(normalized.report_type)) throw new Error("report_type 格式非法");
  }
  if (normalized.cursor !== undefined && (
    typeof normalized.cursor !== "string" || normalized.cursor.length === 0 || normalized.cursor.length > 512
  )) {
    throw new Error("cursor 长度必须为 1–512");
  }
  for (const field of ["date", "start", "end", "end_date"] as const) {
    if (normalized[field] !== undefined) {
      if (typeof normalized[field] !== "string") throw new Error(`${field} 必须是有效的 YYYY-MM-DD 日期`);
      assertDate(normalized[field], field);
    }
  }
  if (normalized.start && normalized.end) {
    if (normalized.start > normalized.end) throw new Error("start 不能晚于 end");
    const limitYears = input.capability === "hot_stock_rank_trend" ? 1 : 5;
    if (exceedsYears(normalized.start, normalized.end, limitYears)) {
      throw new Error(`${input.capability} 的日期范围不能超过 ${limitYears} 年`);
    }
  }
  if (input.capability === "fund_manager_performance" && !(MANAGER_RANGES as readonly string[]).includes(String(normalized.range))) {
    throw new Error("基金经理业绩 range 非法");
  }
  if (normalized.limit !== undefined) {
    const maximum = input.capability === "fund_top_holders" ? 10 : 100;
    if (!Number.isInteger(normalized.limit) || normalized.limit < 1 || normalized.limit > maximum) {
      throw new Error(`limit 必须为 1–${maximum}`);
    }
  }
  return normalized;
}

function remoteParams(request: HithinkDatasetRequest): Record<string, string | number> {
  const spec = HITHINK_DATASET_SPECS[request.capability];
  const params: Record<string, string | number> = {};
  for (const [field, remoteName] of Object.entries(spec.params) as Array<[RequestField, string]>) {
    const value = request[field];
    if (value === undefined) continue;
    if (field === "codes" || field === "tags") params[remoteName] = (value as string[]).join(",");
    else if (field === "start") params[remoteName] = request.capability === "hot_stock_rank_trend"
      ? String(value)
      : shanghaiTimestamp(String(value));
    else if (field === "end") params[remoteName] = request.capability === "hot_stock_rank_trend"
      ? String(value)
      : shanghaiTimestamp(String(value), true);
    else params[remoteName] = value as string | number;
  }
  return params;
}

export interface HithinkDatasetResult {
  capability: HithinkDatasetCapability;
  request: HithinkDatasetRequest;
  sourceTimestampMs: number | null;
  asOfDate: string;
  dataStatus: string | null;
  rowCount: number;
  payload: Record<string, unknown>;
}

export async function fetchHithinkDataset(
  input: HithinkDatasetRequest,
  deps: HithinkDeps = {},
): Promise<HithinkDatasetResult> {
  const request = normalizeHithinkDatasetRequest(input);
  const spec = HITHINK_DATASET_SPECS[request.capability];
  const data = await hithinkGet(spec.path, remoteParams(request), {
    ...deps,
    priority: deps.priority ?? "interactive",
  });
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${request.capability} 响应 data 格式异常`);
  }
  const payload = data as Record<string, unknown>;
  if (!Array.isArray(payload.item)) throw new Error(`${request.capability} 响应 item 格式异常`);
  if (request.date && typeof payload.date === "string" && payload.date !== request.date) {
    throw new Error(`${request.capability} 返回日期与请求不一致`);
  }
  const sourceTimestamp = Number(payload.timestamp ?? payload.date_ms);
  const sourceTimestampMs = Number.isFinite(sourceTimestamp) && sourceTimestamp > 0 ? sourceTimestamp : null;
  const payloadDate = typeof payload.date === "string" && isRealDate(payload.date) ? payload.date : null;
  const asOfDate = payloadDate
    ?? request.date
    ?? request.end_date
    ?? request.end
    ?? (sourceTimestampMs ? shanghaiDate(sourceTimestampMs) : shanghaiDate(Date.now()));
  return {
    capability: request.capability,
    request,
    sourceTimestampMs,
    asOfDate,
    dataStatus: typeof payload.data_status === "string" ? payload.data_status : null,
    rowCount: payload.item.length,
    payload,
  };
}

export interface HithinkDatasetStoreOutcome extends HithinkDatasetResult {
  snapshotId: string;
  fetchRunId: string;
  rowsWritten: number;
  fetchedAt: string;
}

type Db = Pick<pg.Pool | pg.PoolClient, "query">;

function requestKey(request: HithinkDatasetRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

export async function fetchHithinkDatasetAndStore(
  db: TransactionDb,
  input: HithinkDatasetRequest,
  deps: HithinkDeps & { jobRunId?: string } = {},
): Promise<HithinkDatasetStoreOutcome> {
  const result = await fetchHithinkDataset(input, { ...deps, db: deps.db ?? db });
  return inServiceTransaction(db, async (client) => {
    const stored = await (client as Db).query<{ id: string; fetched_at: string }>(
      `INSERT INTO hithink_dataset_snapshot
         (capability, request_key, request_params, as_of_date, source_timestamp_ms,
          data_status, row_count, payload, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (capability, request_key) DO UPDATE SET
         request_params = EXCLUDED.request_params,
         as_of_date = EXCLUDED.as_of_date,
         source_timestamp_ms = EXCLUDED.source_timestamp_ms,
         data_status = EXCLUDED.data_status,
         row_count = EXCLUDED.row_count,
         payload = EXCLUDED.payload,
         fetched_at = now()
       RETURNING id::text, fetched_at::text`,
      [
        result.capability,
        requestKey(result.request),
        JSON.stringify(result.request),
        result.asOfDate,
        result.sourceTimestampMs,
        result.dataStatus,
        result.rowCount,
        JSON.stringify(result.payload),
      ],
    );
    const fetchRunId = await insertFetchRun(client, {
      jobRunId: deps.jobRunId,
      channel: "hithink",
      scope: {
        pipeline: "hithink_dataset",
        capability: result.capability,
        request: result.request,
        as_of_date: result.asOfDate,
      },
      rowsWritten: 1,
    });
    return {
      ...result,
      snapshotId: stored.rows[0]!.id,
      fetchRunId,
      rowsWritten: 1,
      fetchedAt: stored.rows[0]!.fetched_at,
    };
  });
}
