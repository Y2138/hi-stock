// 扶摇标的目录、远程检索与交易日历适配。
import { hithinkGet, type HithinkDeps } from "./hithink.js";

export const TICKER_ASSET_TYPES = [
  "a-share",
  "a-share-index",
  "fund-otc",
  "fund-etf",
  "fund-lof",
] as const;
export type TickerAssetType = (typeof TICKER_ASSET_TYPES)[number];

export interface TickerIdentity {
  code: string;
  ticker: string;
  name: string;
  exchange: "SH" | "SZ" | "BJ" | null;
  assetType: TickerAssetType;
  currency: string;
  sourceUpdatedAt: string;
}

interface TickerEnvelopeData {
  timestamp?: unknown;
  item?: unknown;
}

function timestampIso(value: unknown): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("扶摇目录缺少有效 timestamp");
  return new Date(parsed).toISOString();
}

function parseTickerItems(data: TickerEnvelopeData): TickerIdentity[] {
  if (!Array.isArray(data.item)) throw new Error("扶摇标的目录 item 格式异常");
  const sourceUpdatedAt = timestampIso(data.timestamp);
  return data.item.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const code = String(row.thscode ?? "").trim().toUpperCase();
    const name = String(row.name ?? "").trim();
    const assetType = String(row.asset_type ?? "") as TickerAssetType;
    const exchangeRaw = row.exchange == null ? null : String(row.exchange).toUpperCase();
    // 扶摇目录包含债券/收益指数等扩展代码，当前市场标的模型只接收六位代码。
    if (!/^\d{6}\.(?:SH|SZ|BJ|OF|TI)$/.test(code)) return [];
    if (!name) throw new Error(`扶摇返回标的身份不完整：${code}`);
    if (!(TICKER_ASSET_TYPES as readonly string[]).includes(assetType)) {
      throw new Error(`扶摇返回未知资产类型：${String(row.asset_type)}`);
    }
    if (exchangeRaw !== null && !["SH", "SZ", "BJ"].includes(exchangeRaw)) {
      throw new Error(`扶摇返回未知交易所：${exchangeRaw}`);
    }
    return [{
      code,
      ticker: code.slice(0, 6),
      name,
      exchange: exchangeRaw as "SH" | "SZ" | "BJ" | null,
      assetType,
      currency: String(row.currency ?? "CNY").trim().toUpperCase(),
      sourceUpdatedAt,
    }];
  });
}

async function fetchTickerPageResult(
  input: { assetTypes?: TickerAssetType[]; limit?: number; offset?: number },
  deps: HithinkDeps = {},
): Promise<{ rows: TickerIdentity[]; received: number }> {
  const limit = input.limit ?? 1000;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("目录 limit 必须为 1..10000");
  if (!Number.isInteger(offset) || offset < 0) throw new Error("目录 offset 必须是非负整数");
  const params: Record<string, string | number> = { limit, offset };
  if (input.assetTypes?.length) params.asset_type = [...new Set(input.assetTypes)].join(",");
  const data = (await hithinkGet("/api/meta/tickers/list", params, {
    ...deps,
    priority: deps.priority ?? "scheduled-medium",
  })) as TickerEnvelopeData;
  return { rows: parseTickerItems(data), received: Array.isArray(data.item) ? data.item.length : 0 };
}

export async function fetchTickerPage(
  input: { assetTypes?: TickerAssetType[]; limit?: number; offset?: number },
  deps: HithinkDeps = {},
): Promise<TickerIdentity[]> {
  return (await fetchTickerPageResult(input, deps)).rows;
}

const ASSET_TYPE_PRIORITY: Record<TickerAssetType, number> = {
  "a-share": 5,
  "a-share-index": 4,
  "fund-etf": 3,
  "fund-lof": 2,
  "fund-otc": 1,
};

function deduplicateTickers(rows: TickerIdentity[]): TickerIdentity[] {
  const byCode = new Map<string, TickerIdentity>();
  for (const row of rows) {
    const current = byCode.get(row.code);
    if (!current || ASSET_TYPE_PRIORITY[row.assetType] > ASSET_TYPE_PRIORITY[current.assetType]) {
      byCode.set(row.code, row);
    }
  }
  return [...byCode.values()];
}

export async function fetchAllTickers(
  input: { assetTypes?: TickerAssetType[]; pageSize?: number; maxPages?: number } = {},
  deps: HithinkDeps = {},
): Promise<TickerIdentity[]> {
  const pageSize = input.pageSize ?? 1000;
  const maxPages = input.maxPages ?? 100;
  const result: TickerIdentity[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const { rows, received } = await fetchTickerPageResult(
      { assetTypes: input.assetTypes, limit: pageSize, offset: page * pageSize },
      deps,
    );
    result.push(...rows);
    if (received < pageSize) return deduplicateTickers(result);
  }
  throw new Error(`标的目录超过安全分页上限 ${maxPages} 页`);
}

export async function searchRemoteTickers(
  input: { q: string; assetTypes?: TickerAssetType[]; exchange?: "SH" | "SZ" | "BJ"; limit?: number },
  deps: HithinkDeps = {},
): Promise<TickerIdentity[]> {
  const q = input.q.trim();
  const limit = input.limit ?? 10;
  if (!q || q.length > 80) throw new Error("检索关键词长度必须为 1..80");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("检索 limit 必须为 1..50");
  const params: Record<string, string | number> = { q, limit };
  if (input.assetTypes?.length) params.asset_type = [...new Set(input.assetTypes)].join(",");
  if (input.exchange) params.exchange = input.exchange;
  const data = (await hithinkGet("/api/meta/tickers/search", params, {
    ...deps,
    priority: deps.priority ?? "interactive",
  })) as TickerEnvelopeData;
  return parseTickerItems(data);
}

export interface TradingDayItem {
  date: string;
  sourceUpdatedAt: string;
}

export async function fetchTradingDays(deps: HithinkDeps = {}): Promise<TradingDayItem[]> {
  const data = (await hithinkGet("/api/a-share/calendar/trading-days", {}, {
    ...deps,
    priority: deps.priority ?? "scheduled-medium",
  })) as { timestamp?: unknown; item?: unknown };
  if (!Array.isArray(data.item)) throw new Error("扶摇交易日历 item 格式异常");
  const sourceUpdatedAt = timestampIso(data.timestamp);
  return data.item.map((raw) => {
    const row = raw as Record<string, unknown>;
    const compact = String(row.date ?? "");
    if (!/^\d{8}$/.test(compact)) throw new Error(`扶摇返回非法交易日：${compact}`);
    return {
      date: `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`,
      sourceUpdatedAt,
    };
  });
}
