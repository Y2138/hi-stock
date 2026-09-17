// 上海期货交易所官方日行情适配：只解析公开JSON，不写数据库。
import { defaultSleep, type SleepFn } from "./ratelimit.js";
import type { Bar } from "./types.js";

const SHFE_BASE = "https://www.shfe.com.cn/data/tradedata/future/dailydata";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRODUCT_RE = /^[A-Za-z]{1,3}$/;

export class ShfeNotFoundError extends Error {
  constructor(public readonly tradeDate: string) {
    super(`上期所 ${tradeDate} 没有日行情文件`);
    this.name = "ShfeNotFoundError";
  }
}

export interface ShfeDeps {
  sleep?: SleepFn;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface ShfeContractDaily {
  code: string;
  name: string;
  productCode: string;
  contractMonth: string;
  bar: Bar;
  settlement: number;
  prevSettlement: number;
  openInterest: number;
  rawSummary: Record<string, unknown>;
}

interface ShfeDailyRow extends Record<string, unknown> {
  PRODUCTGROUPID?: unknown;
  PRODUCTNAME?: unknown;
  DELIVERYMONTH?: unknown;
  OPENPRICE?: unknown;
  HIGHESTPRICE?: unknown;
  LOWESTPRICE?: unknown;
  CLOSEPRICE?: unknown;
  SETTLEMENTPRICE?: unknown;
  PRESETTLEMENTPRICE?: unknown;
  VOLUME?: unknown;
  OPENINTEREST?: unknown;
  OPENINTERESTCHG?: unknown;
  TURNOVER?: unknown;
  PRODUCTID?: unknown;
}

function compactDate(value: string): string {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error("tradeDate 必须为YYYY-MM-DD");
  return value.replaceAll("-", "");
}

function numberOf(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`上期所字段 ${field} 不是有限数值`);
  return parsed;
}

async function fetchText(url: string, deps: ShfeDeps): Promise<{ status: number; body: string }> {
  const request = deps.fetch ?? fetch;
  const response = await request(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json,text/plain,*/*" },
    signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
  });
  return { status: response.status, body: await response.text() };
}

/** 获取指定交易日和品种的所有真实合约日行情；小计行与缺失OHLC行显式过滤。 */
export async function fetchShfeDailyContracts(
  tradeDate: string,
  productCode: string,
  deps: ShfeDeps = {},
): Promise<ShfeContractDaily[]> {
  const compact = compactDate(tradeDate);
  const product = productCode.trim().toLowerCase();
  if (!PRODUCT_RE.test(product)) throw new Error("productCode 必须为1-3位英文字母");
  const url = `${SHFE_BASE}/kx${compact}.dat`;
  const sleep = deps.sleep ?? defaultSleep;
  let response = await fetchText(url, deps);
  if (response.status >= 500) {
    await sleep(1000);
    response = await fetchText(url, deps);
  }
  if (response.status === 404) throw new ShfeNotFoundError(tradeDate);
  if (response.status !== 200) throw new Error(`上期所日行情 HTTP ${response.status}`);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    throw new Error("上期所日行情响应不是JSON");
  }
  const reportDate = String(payload.report_date ?? payload.o_date ?? "").replaceAll("-", "");
  if (reportDate !== compact) throw new Error(`上期所日行情日期回显不一致：${reportDate || "空"}`);
  const rawRows = payload.o_curinstrument;
  if (!Array.isArray(rawRows)) throw new Error("上期所日行情缺少o_curinstrument数组");
  const rows: ShfeContractDaily[] = [];
  for (const raw of rawRows as ShfeDailyRow[]) {
    const rowProduct = String(raw.PRODUCTGROUPID ?? raw.PRODUCTID ?? "").trim().toLowerCase().split("_")[0];
    if (rowProduct !== product) continue;
    const delivery = String(raw.DELIVERYMONTH ?? "").trim();
    if (!/^\d{4}$/.test(delivery)) continue;
    let open: number;
    let high: number;
    let low: number;
    let close: number;
    let settlement: number;
    let prevSettlement: number;
    let volume: number;
    let openInterest: number;
    try {
      open = numberOf(raw.OPENPRICE, "OPENPRICE");
      high = numberOf(raw.HIGHESTPRICE, "HIGHESTPRICE");
      low = numberOf(raw.LOWESTPRICE, "LOWESTPRICE");
      close = numberOf(raw.CLOSEPRICE, "CLOSEPRICE");
      settlement = numberOf(raw.SETTLEMENTPRICE, "SETTLEMENTPRICE");
      prevSettlement = numberOf(raw.PRESETTLEMENTPRICE, "PRESETTLEMENTPRICE");
      volume = numberOf(raw.VOLUME, "VOLUME");
      openInterest = numberOf(raw.OPENINTEREST, "OPENINTEREST");
    } catch {
      continue;
    }
    if ([open, high, low, close, settlement, prevSettlement].some(value => value <= 0) ||
        volume < 0 || openInterest < 0 || low > Math.min(open, close) || high < Math.max(open, close)) continue;
    const code = `${product.toUpperCase()}${delivery}`;
    rows.push({
      code,
      name: `${String(raw.PRODUCTNAME ?? product.toUpperCase()).trim()}${delivery}`,
      productCode: product.toUpperCase(),
      contractMonth: `20${delivery}`,
      bar: { date: tradeDate, open, high, low, close, volume, adjustment: "none" },
      settlement,
      prevSettlement,
      openInterest,
      rawSummary: {
        product_id: raw.PRODUCTID ?? null,
        open_interest_change: raw.OPENINTERESTCHG ?? null,
        turnover_reported: raw.TURNOVER ?? null,
      },
    });
  }
  if (!rows.length) throw new Error(`上期所 ${tradeDate} 未返回 ${product.toUpperCase()} 真实合约`);
  return rows.sort((left, right) => left.contractMonth.localeCompare(right.contractMonth));
}


export interface ShfeWeeklyInventory {
  reportDate: string;
  publishedAt: string;
  inventory: number;
  previousInventory: number;
  warehouseWarrant: number;
  previousWarehouseWarrant: number;
  unit: "吨";
  sourceUrl: string;
  rawSummary: Record<string, unknown>;
}

function plainText(html: string): string {
  return html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim();
}

function htmlCells(row: string): string[] {
  return [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => plainText(match[1] ?? ""));
}

function inventoryNumber(value: unknown, field: string): number {
  const parsed = Number(String(value ?? "").replaceAll(",", "").trim());
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`上期所库存字段 ${field} 非法`);
  return parsed;
}

function publishedAtOf(reportDate: string, updateDate: unknown): string {
  const value = String(updateDate ?? "").trim();
  const match = /^(\d{8})\s+(\d{2}:\d{2}:\d{2})$/.exec(value);
  if (match) {
    const day = `${match[1]!.slice(0, 4)}-${match[1]!.slice(4, 6)}-${match[1]!.slice(6, 8)}`;
    return `${day}T${match[2]}+08:00`;
  }
  return `${reportDate}T23:59:59+08:00`;
}

function parseWeeklyInventoryJson(body: string, reportDate: string, sourceUrl: string, productCode: string, productName: string): ShfeWeeklyInventory {
  const payload = JSON.parse(body) as Record<string, unknown>;
  const echoed = String(payload.o_tradingday ?? payload.report_date ?? "").replaceAll("-", "").slice(0, 8);
  if (echoed !== reportDate.replaceAll("-", "")) throw new Error(`上期所库存周报日期回显不一致：${echoed || "空"}`);
  const rows = payload.o_cursor;
  if (!Array.isArray(rows)) throw new Error("上期所库存周报缺少o_cursor数组");
  const total = (rows as Record<string, unknown>[]).find(row => {
    const product = String(row.VARID ?? row.VARNAME ?? "").trim().toLowerCase();
    const warehouse = String(row.WHABBRNAME ?? "").trim();
    return (product === productCode.toLowerCase() || product.startsWith(`${productName.toLowerCase()}$$`)) && warehouse.startsWith("总计$$Total");
  });
  if (!total) throw new Error(`上期所库存周报缺少${productName}总计行`);
  return {
    reportDate,
    publishedAt: publishedAtOf(reportDate, payload.update_date),
    inventory: inventoryNumber(total.SPOTWGHTS, "SPOTWGHTS"),
    previousInventory: inventoryNumber(total.PRESPOTWGHTS, "PRESPOTWGHTS"),
    warehouseWarrant: inventoryNumber(total.WRTWGHTS, "WRTWGHTS"),
    previousWarehouseWarrant: inventoryNumber(total.PREWRTWGHTS, "PREWRTWGHTS"),
    unit: "吨",
    sourceUrl,
    rawSummary: { issue_no: payload.o_issueno ?? null, total_issue_no: payload.o_totalissueno ?? null },
  };
}

function parseWeeklyInventoryHtml(body: string, reportDate: string, sourceUrl: string, productName: string): ShfeWeeklyInventory {
  if (!body.includes(reportDate)) throw new Error("上期所库存周报HTML日期回显不一致");
  const header = /<tr\b[^>]*special_row_type[^>]*>[\s\S]*?<div\b[^>]*class="cell"[^>]*>\s*铜\s*<\/div>[\s\S]*?<\/tr>/i.exec(body);
  if (!header?.index && header?.index !== 0) throw new Error("上期所库存周报HTML缺少铜分区");
  const after = body.slice(header.index + header[0].length);
  const nextHeader = after.search(/<tr\b[^>]*special_row_type[^>]*>/i);
  const tableEnd = after.search(/<\/table>/i);
  const ends = [nextHeader, tableEnd].filter(value => value >= 0);
  const section = after.slice(0, ends.length ? Math.min(...ends) : after.length);
  const totals = [...section.matchAll(/<tr\b[^>]*isTotal[^>]*>[\s\S]*?<\/tr>/gi)]
    .map(match => htmlCells(match[0]))
    .filter(cells => cells[0] === "总计");
  const cells = totals.at(-1);
  if (!cells || cells.length < 5) throw new Error(`上期所库存周报HTML缺少${productName}总计数值`);
  return {
    reportDate,
    publishedAt: `${reportDate}T23:59:59+08:00`,
    previousInventory: inventoryNumber(cells[1], "上周库存小计"),
    previousWarehouseWarrant: inventoryNumber(cells[2], "上周期货库存"),
    inventory: inventoryNumber(cells[3], "本周库存小计"),
    warehouseWarrant: inventoryNumber(cells[4], "本周期货库存"),
    unit: "吨",
    sourceUrl,
    rawSummary: { format: "html" },
  };
}

/** 获取指定上期所品种库存周报；优先历史JSON，站点新格式切换后降级到官方HTML。 */
export async function fetchShfeWeeklyInventory(
  reportDate: string,
  productCode: string,
  productName: string,
  deps: ShfeDeps = {},
): Promise<ShfeWeeklyInventory> {
  const compact = compactDate(reportDate);
  const jsonUrl = `https://www.shfe.com.cn/data/tradedata/future/weeklydata/${compact}weeklystock.dat`;
  const jsonResponse = await fetchText(jsonUrl, deps);
  if (jsonResponse.status === 200) return parseWeeklyInventoryJson(jsonResponse.body, reportDate, jsonUrl, productCode, productName);
  if (jsonResponse.status !== 404) throw new Error(`上期所库存周报 HTTP ${jsonResponse.status}`);
  const htmlUrl = `https://www.shfe.com.cn/data/tradedata/future/stockdata/weeklystock_${compact}/ZH/all.html`;
  const htmlResponse = await fetchText(htmlUrl, deps);
  if (htmlResponse.status === 404) throw new ShfeNotFoundError(reportDate);
  if (htmlResponse.status !== 200) throw new Error(`上期所库存周报 HTTP ${htmlResponse.status}`);
  return parseWeeklyInventoryHtml(htmlResponse.body, reportDate, htmlUrl, productName);
}

/** 铜库存兼容入口。 */
export function fetchShfeCopperWeeklyInventory(reportDate: string, deps: ShfeDeps = {}): Promise<ShfeWeeklyInventory> {
  return fetchShfeWeeklyInventory(reportDate, "CU", "铜", deps);
}
