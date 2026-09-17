// 金十公开归档适配：仅用于扶摇和官方连续历史缺失时的研究级降级数据。
export interface Jin10Deps { fetch?: typeof fetch; timeoutMs?: number }
export interface CoastalPowerCoalPoint {
  date: string;
  inventoryTenThousandTonnes: number;
  dailyConsumptionTenThousandTonnes: number;
  availableDays: number;
}

const ENERGY_URL = "https://cdn.jin10.com/dc/reports/dc_qihuo_energy_report_all.js";

function finite(value: unknown, field: string): number {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`沿海六大电厂字段${field}非法`);
  return parsed;
}

/** 沿海六大电厂库存、日耗与可用天数；当前公开归档覆盖2016-01-01至2019-06-21。 */
export async function fetchCoastalPowerCoalHistory(deps: Jin10Deps = {}): Promise<CoastalPowerCoalPoint[]> {
  const request = deps.fetch ?? fetch;
  const now = Date.now();
  const response = await request(`${ENERGY_URL}?v=${now}&_=${now + 90}`, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/javascript,text/plain,*/*" },
    signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
  });
  if (!response.ok) throw new Error(`沿海六大电厂归档 HTTP ${response.status}`);
  const text = await response.text();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("沿海六大电厂归档不是预期JS对象");
  const payload = JSON.parse(text.slice(start, end + 1)) as {
    kinds?: unknown;
    list?: Array<{ date?: unknown; datas?: Record<string, unknown> }>;
  };
  if (!Array.isArray(payload.kinds) || !Array.isArray(payload.list)) throw new Error("沿海六大电厂归档结构异常");
  const rows: CoastalPowerCoalPoint[] = [];
  for (const item of payload.list) {
    const compact = String(item.date ?? "");
    const values = item.datas?.["沿海六大电厂库存动态报告"];
    if (!/^\d{8}$/.test(compact) || !Array.isArray(values) || values.length < 3) continue;
    rows.push({
      date: `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`,
      inventoryTenThousandTonnes: finite(values[0], "库存"),
      dailyConsumptionTenThousandTonnes: finite(values[1], "日耗"),
      availableDays: finite(values[2], "可用天数"),
    });
  }
  rows.sort((left, right) => left.date.localeCompare(right.date));
  if (rows.length < 100) throw new Error("沿海六大电厂归档有效记录不足");
  return rows;
}
