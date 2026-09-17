// 广州期货交易所官方仓单日报适配；HTTP端点为交易所当前公开接口。
export interface GfexDeps { fetch?: typeof fetch; timeoutMs?: number }
export interface GfexLithiumWarehouseReceipt {
  date: string;
  previousQuantity: number;
  quantity: number;
  change: number;
  sourceUrl: string;
}
const URL = "http://www.gfex.com.cn/u/interfacesWebTdWbillWeeklyQuotes/loadList";
function compactDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error("date必须为YYYY-MM-DD");
  return value.replaceAll("-", "");
}
function finite(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`广期所${field}非法`);
  return parsed;
}
/** 读取指定交易日碳酸锂小计仓单；未上市或无仓单时返回null。 */
export async function fetchGfexLithiumWarehouseReceipt(date: string, deps: GfexDeps = {}): Promise<GfexLithiumWarehouseReceipt | null> {
  const compact = compactDate(date);
  const request = deps.fetch ?? fetch;
  const response = await request(URL, {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: "http://www.gfex.com.cn/gfex/cdrb/hqsj_tjsj.shtml",
    },
    body: new URLSearchParams({ gen_date: compact }),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
  });
  if (!response.ok) throw new Error(`广期所仓单日报 HTTP ${response.status}`);
  const payload = await response.json() as { code?: unknown; data?: unknown };
  if (String(payload.code) !== "0" || !Array.isArray(payload.data)) throw new Error("广期所仓单日报响应结构异常");
  const row = (payload.data as Record<string, unknown>[]).find(item =>
    String(item.varietyOrder ?? "").trim().toLowerCase() === "lc"
    && String(item.variety ?? "").includes("小计"));
  if (!row) return null;
  const quantity = finite(row.wbillQty, "今日仓单量");
  const previousQuantity = finite(row.lastWbillQty, "昨日仓单量");
  const change = Number(row.diff ?? quantity - previousQuantity);
  if (!Number.isFinite(change)) throw new Error("广期所仓单增减非法");
  return { date, previousQuantity, quantity, change, sourceUrl: URL };
}
