// hithink 通道：TypeScript 直连扶摇 HTTP API（base https://fuyao.aicubes.cn）
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §5.2
// 端点路径、参数、信封与错误码语义按扶摇官方接口逐端点验证。
// 认证头沿用参照实现的 X-api-key；Key 只从 PostgreSQL system_setting 读取，
// 不入日志、URL、API 响应或任何审计输出。

import { RateLimiter, withBackoff, type SleepFn } from "./ratelimit.js";
import {
  sharedHithinkRequestScheduler,
  type HithinkPriority,
  type HithinkRequestScheduler,
} from "./request-scheduler.js";
import type { Bar, Channel, FetchRequest } from "./types.js";
import { getHithinkApiKey, type SystemSettingsDb } from "../system-settings.js";

const BASE_URL = "https://fuyao.aicubes.cn";
const A_SHARE_CODE_RE = /^\d{6}\.(?:SH|SZ|BJ)$/;
const PRICE_CODE_RE = /^\d{6}\.(?:SH|SZ|BJ|TI)$/;
/** CST（UTC+8）固定偏移，A 股无夏令时 */
const CST_OFFSET_MS = 8 * 3600 * 1000;

/** HTTP 层错误（含网关层限流 429） */
export class HithinkHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs: number | null,
    detail: string,
  ) {
    super(`扶摇 HTTP ${status}: ${detail}`);
    this.name = "HithinkHttpError";
  }
}

/** 信封业务错误（code != 0），携带业务码供降级/重试判断 */
export class HithinkEnvelopeError extends Error {
  constructor(
    public readonly code: number,
    message: unknown,
    public readonly requestId?: unknown,
  ) {
    super(`扶摇业务错误: code=${code} message=${String(message)}`);
    this.name = "HithinkEnvelopeError";
  }
}

/** 限流判定：HTTP 429（网关层）或信封 code=4001（业务层） */
export function isHithinkRateLimited(err: unknown): boolean {
  return (
    (err instanceof HithinkHttpError && err.status === 429) ||
    (err instanceof HithinkEnvelopeError && err.code === 4001)
  );
}

export interface HithinkDeps {
  limiter?: RateLimiter;
  scheduler?: HithinkRequestScheduler;
  priority?: HithinkPriority;
  sleep?: SleepFn;
  timeoutMs?: number;
  /** 生产由业务 service 传数据库；apiKey 仅供无数据库的纯 HTTP 单测注入。 */
  db?: SystemSettingsDb;
  apiKey?: string;
}

/** 读取数据库 API Key；缺失时报错，绝不输出 Key 本体。 */
async function resolveApiKey(deps: HithinkDeps): Promise<string> {
  const key = deps.apiKey?.trim() || (deps.db ? await getHithinkApiKey(deps.db) : null);
  if (!key) {
    throw new Error(
      "扶摇 API Key 未配置：请在设置 → 数据源凭据中填写",
    );
  }
  return key;
}

/** 单次请求（不限流不重试）：信封 code==0 才返回 data */
async function requestOnce(
  path: string,
  params: Record<string, string | number>,
  timeoutMs: number,
  apiKey: string,
): Promise<unknown> {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: {
      "X-api-key": apiKey,
      Accept: "application/json",
      "User-Agent": "stock-workspace/1.0",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429) {
    const ra = res.headers.get("Retry-After");
    const parsed = ra ? Number(ra) : NaN;
    throw new HithinkHttpError(429, Number.isFinite(parsed) ? parsed * 1000 : null, "request limit exceeded");
  }
  if (!res.ok) {
    throw new HithinkHttpError(res.status, null, (await res.text()).slice(0, 200));
  }
  const raw = (await res.json()) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || !("code" in raw)) {
    throw new HithinkEnvelopeError(-1, "响应信封格式异常（缺少 code 字段）");
  }
  if (raw.code === 0) return raw.data;
  throw new HithinkEnvelopeError(Number(raw.code), raw.message, raw.request_id);
}

/** 限流 + 退避后的 API GET：每次尝试都先取令牌，429/4001 指数退避最多重试 2 次 */
export async function hithinkGet(
  path: string,
  params: Record<string, string | number>,
  deps: HithinkDeps = {},
): Promise<unknown> {
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const apiKey = await resolveApiKey(deps);
  return withBackoff(
    async () => {
      if (deps.limiter) {
        await deps.limiter.acquire();
        return requestOnce(path, params, timeoutMs, apiKey);
      }
      return (deps.scheduler ?? sharedHithinkRequestScheduler).schedule(
        deps.priority ?? "scheduled-medium",
        () => requestOnce(path, params, timeoutMs, apiKey),
      );
    },
    {
      maxRetries: 2,
      sleep: deps.sleep,
      shouldRetry: isHithinkRateLimited,
      retryAfterMs: (err) => (err instanceof HithinkHttpError ? err.retryAfterMs : null),
    },
  );
}

/** YYYY-MM-DD → CST 当日 00:00 的毫秒戳；endOfDay 取次日 00:00 减 1ms */
function toMs(day: string, endOfDay = false): number {
  const [y, m, d] = day.split("-").map(Number);
  const base = Date.UTC(y!, m! - 1, d!) - CST_OFFSET_MS;
  return endOfDay ? base + 24 * 3600 * 1000 - 1 : base;
}

/** 毫秒戳 → CST 日期 YYYY-MM-DD */
function msToDate(ms: number): string {
  return new Date(ms + CST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 校验 kline 请求：单标的、代码带 .SH/.SZ、范围 ≤3 年（与参照实现口径一致） */
export function validateKlineRequest(req: FetchRequest): void {
  if (!PRICE_CODE_RE.test(req.code)) {
    throw new Error(`行情代码必须为6位数字并带.SH/.SZ/.BJ/.TI后缀: ${req.code}`);
  }
  const start = new Date(req.start);
  const end = new Date(req.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    throw new Error(`日期范围非法: ${req.start} ~ ${req.end}`);
  }
  const limit = new Date(start);
  limit.setFullYear(limit.getFullYear() + 3);
  if (end > limit) {
    throw new Error("日期范围不能超过3年（接口上限10年，仓库口径取3年）");
  }
}

interface KlineItem {
  date_ms?: number;
  open_price?: number;
  high_price?: number;
  low_price?: number;
  close_price?: number;
  volume?: number;
}

/**
 * K 线端点自动路由：股票（支持复权）→ 指数 → 场内基金 ETF。
 * 路由未命中形态（与参照实现一致）：业务码 1002/3001/3002/3004，或 code=0 但空序列。
 */
const KLINE_ROUTES = [
  { path: "/api/a-share/prices/historical", supportsAdjust: true },
  { path: "/api/a-share-index/prices/historical", supportsAdjust: false },
  { path: "/api/fund/market/historical", supportsAdjust: false },
] as const;
const KLINE_FALLBACK_CODES = new Set([1002, 3001, 3002, 3004]);

/** 单标的日线 kline：股票默认前复权，指数/ETF 路由无复权语义 */
export async function fetchKline(req: FetchRequest, deps: HithinkDeps = {}): Promise<Bar[]> {
  validateKlineRequest(req);
  const failures: string[] = [];
  for (const route of KLINE_ROUTES) {
    const params: Record<string, string | number> = {
      thscode: req.code,
      interval: "1d",
      start: toMs(req.start),
      end: toMs(req.end, true),
    };
    if (route.supportsAdjust) params.adjust = "forward";
    let data: unknown;
    try {
      data = await hithinkGet(route.path, params, deps);
    } catch (err) {
      if (err instanceof HithinkEnvelopeError && KLINE_FALLBACK_CODES.has(err.code)) {
        failures.push(`${route.path}: code=${err.code}`);
        continue;
      }
      throw err;
    }
    const items = (data as { item?: unknown })?.item;
    if (!Array.isArray(items)) throw new Error("调用成功但响应中的 item 格式异常");
    if (items.length === 0) {
      failures.push(`${route.path}: 0根K线`);
      continue;
    }
    const rows = (items as KlineItem[])
      .filter((r) => typeof r?.date_ms === "number")
      .sort((a, b) => a.date_ms! - b.date_ms!);
    if (rows.length === 0) throw new Error("kline 响应缺少 date_ms 字段");
    const adjustment = route.supportsAdjust ? ("forward" as const) : ("none" as const);
    return rows.map((r) => ({
      date: msToDate(r.date_ms!),
      open: Number(r.open_price),
      high: Number(r.high_price),
      low: Number(r.low_price),
      close: Number(r.close_price),
      volume: r.volume == null ? undefined : Number(r.volume),
      adjustment,
    }));
  }
  throw new Error(
    `股票/指数/基金三个K线端点均未取到 ${req.code} 数据：${failures.join("；")}。检查代码、日期范围和停牌状态`,
  );
}

/** 批量快照条目（字段以实测响应为准，2026-08-16 探测） */
export interface SnapshotQuote {
  code: string;
  /** 快照时间毫秒戳（信封 data.timestamp） */
  timestampMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  prevClose?: number;
}

/** 快照日期的 CST 交易日 */
export function snapshotDate(quote: SnapshotQuote): string {
  return msToDate(quote.timestampMs);
}

export type SnapshotKind = "stock" | "index" | "etf";

const SNAPSHOT_PATHS: Record<SnapshotKind, string> = {
  stock: "/api/a-share/prices/snapshot",
  index: "/api/a-share-index/prices/snapshot",
  etf: "/api/fund/market/snapshot",
};
const SNAPSHOT_BATCH_SIZE = 200;

/** 同类型行情快照：股票/指数支持批量 thscodes，ETF 端点只接受单只 thscode。 */
export async function fetchSnapshot(
  codes: string[],
  deps: HithinkDeps = {},
  kind: SnapshotKind = "stock",
): Promise<SnapshotQuote[]> {
  const codePattern = kind === "index" ? PRICE_CODE_RE : A_SHARE_CODE_RE;
  const invalid = codes.filter((code) => !codePattern.test(code));
  if (codes.length === 0 || invalid.length > 0) {
    throw new Error(`快照代码与资产类型不匹配: ${invalid.join(",") || "空列表"}`);
  }
  const requests = kind === "etf"
    ? codes.map((code) => ({ thscode: code }))
    : Array.from({ length: Math.ceil(codes.length / SNAPSHOT_BATCH_SIZE) }, (_, index) => ({
        thscodes: codes.slice(index * SNAPSHOT_BATCH_SIZE, (index + 1) * SNAPSHOT_BATCH_SIZE).join(","),
      }));
  const quotes: SnapshotQuote[] = [];
  for (const params of requests) {
    const data = (await hithinkGet(SNAPSHOT_PATHS[kind], params, deps)) as {
      timestamp?: number;
      item?: unknown;
    };
    if (!Array.isArray(data?.item)) throw new Error("调用成功但响应中的 item 格式异常");
    const ts = Number(data.timestamp ?? Date.now());
    quotes.push(...(data.item as Record<string, unknown>[]).map((row) => ({
      code: String(row.thscode),
      timestampMs: ts,
      open: Number(row.open_price),
      high: Number(row.high_price),
      low: Number(row.low_price),
      close: Number(row.last_price),
      volume: row.volume == null ? undefined : Number(row.volume),
      prevClose: row.prev_price == null ? undefined : Number(row.prev_price),
    })));
  }
  return quotes;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface ValuationQuote {
  code: string;
  name: string | null;
  asOfDate: string;
  peTtm: number | null;
  pb: number | null;
  psTtm: number | null;
  rawSummary: Record<string, unknown>;
}

/** 扶摇仅提供最新估值快照；timestamp 为空时以本次抓取的上海自然日留痕。 */
export async function fetchValuationSnapshots(
  codes: string[],
  deps: HithinkDeps = {},
): Promise<ValuationQuote[]> {
  const invalid = codes.filter((code) => !A_SHARE_CODE_RE.test(code));
  if (codes.length === 0 || codes.length > 100 || invalid.length > 0) {
    throw new Error(`估值代码必须为 1–100 个 A 股完整代码：${invalid.join(",") || "空列表"}`);
  }
  const data = (await hithinkGet(
    "/api/a-share/valuations/snapshot",
    { thscodes: [...new Set(codes)].join(",") },
    deps,
  )) as { timestamp?: number | null; item?: unknown };
  if (!Array.isArray(data?.item)) throw new Error("估值快照响应中的 item 格式异常");
  const timestamp = nullableNumber(data.timestamp);
  const asOfDate = msToDate(timestamp ?? Date.now());
  return (data.item as Record<string, unknown>[]).map((row) => ({
    code: String(row.thscode),
    name: typeof row.name === "string" ? row.name : null,
    asOfDate,
    peTtm: nullableNumber(row.pe_ttm),
    pb: nullableNumber(row.pb_mrq),
    psTtm: nullableNumber(row.ps_ttm),
    rawSummary: {
      timestamp_ms: timestamp,
      pe_mrq: nullableNumber(row.pe_mrq),
      pcf_ttm: nullableNumber(row.pcf_ttm),
    },
  }));
}

interface FinancialStatementItem extends Record<string, unknown> {
  period_end_ms?: number;
  report_date_ms?: number;
}

export interface FundamentalQuote {
  code: string;
  asOfDate: string;
  reportPeriod: string;
  revenue: number | null;
  netProfit: number | null;
  operatingCashflow: number | null;
  roe: number | null;
  grossMargin: number | null;
  debtRatio: number | null;
  rawSummary: Record<string, unknown>;
}

async function fetchStatements(
  path: string,
  code: string,
  deps: HithinkDeps,
): Promise<FinancialStatementItem[]> {
  const data = (await hithinkGet(path, { thscode: code, period: "quarterly", limit: 4 }, deps)) as {
    item?: unknown;
  };
  if (!Array.isArray(data?.item)) throw new Error(`${path} 响应中的 item 格式异常`);
  return (data.item as FinancialStatementItem[]).filter((row) => Number.isFinite(Number(row.period_end_ms)));
}

/**
 * 抓取最近四期三张财务报表，并只选择三表共同存在的最新报告期。
 * ROE、毛利率、资产负债率由同一报告期原始报表推导，推导口径写入 raw_summary。
 */
export async function fetchLatestFundamental(
  code: string,
  deps: HithinkDeps = {},
): Promise<FundamentalQuote> {
  if (!A_SHARE_CODE_RE.test(code)) throw new Error(`基本面代码必须是 A 股完整代码：${code}`);
  const income = await fetchStatements("/api/a-share/financials/income-statements", code, deps);
  const balance = await fetchStatements("/api/a-share/financials/balance-sheets", code, deps);
  const cashflow = await fetchStatements("/api/a-share/financials/cash-flow-statements", code, deps);
  const balancePeriods = new Set(balance.map((row) => Number(row.period_end_ms)));
  const cashflowPeriods = new Set(cashflow.map((row) => Number(row.period_end_ms)));
  const periodMs = income
    .map((row) => Number(row.period_end_ms))
    .filter((period) => balancePeriods.has(period) && cashflowPeriods.has(period))
    .sort((left, right) => right - left)[0];
  if (!periodMs) throw new Error(`扶摇最近四期财务报表没有共同报告期：${code}`);
  const incomeRow = income.find((row) => Number(row.period_end_ms) === periodMs)!;
  const balanceRow = balance.find((row) => Number(row.period_end_ms) === periodMs)!;
  const cashflowRow = cashflow.find((row) => Number(row.period_end_ms) === periodMs)!;
  const revenue = nullableNumber(incomeRow.operating_income);
  const operatingCosts = nullableNumber(incomeRow.operating_costs);
  const netProfit = nullableNumber(incomeRow.net_profit);
  const assets = nullableNumber(balanceRow.assets_total);
  const debt = nullableNumber(balanceRow.total_debt);
  const equity = nullableNumber(balanceRow.holder_equity_total);
  const reportDateMs = Math.max(
    ...[incomeRow, balanceRow, cashflowRow]
      .map((row) => nullableNumber(row.report_date_ms))
      .filter((value): value is number => value !== null),
    periodMs,
  );
  return {
    code,
    asOfDate: msToDate(reportDateMs),
    reportPeriod: msToDate(periodMs),
    revenue,
    netProfit,
    operatingCashflow: nullableNumber(cashflowRow.act_cash_flow_net),
    roe: netProfit !== null && equity && equity !== 0 ? (netProfit / equity) * 100 : null,
    grossMargin: revenue !== null && revenue !== 0 && operatingCosts !== null
      ? ((revenue - operatingCosts) / revenue) * 100
      : null,
    debtRatio: assets && assets !== 0 && debt !== null ? (debt / assets) * 100 : null,
    rawSummary: {
      period: incomeRow.period,
      fiscal_year: incomeRow.fiscal_year,
      fiscal_period: incomeRow.fiscal_period,
      report_date_ms: reportDateMs,
      period_end_ms: periodMs,
      operating_costs: operatingCosts,
      assets_total: assets,
      total_debt: debt,
      holder_equity_total: equity,
      ratio_basis: "同一报告期报表推导：净利润/股东权益、(营收-成本)/营收、负债/资产",
    },
  };
}

/** hithink 通道：支持日线（kline）；快照经 fetchSnapshot 走同一限流器 */
export class HithinkChannel implements Channel {
  readonly name = "hithink";

  constructor(private readonly deps: HithinkDeps = {}) {}

  supports(req: FetchRequest): boolean {
    return req.freq === "day" && PRICE_CODE_RE.test(req.code);
  }

  fetch(req: FetchRequest): Promise<Bar[]> {
    return fetchKline(req, this.deps);
  }
}
