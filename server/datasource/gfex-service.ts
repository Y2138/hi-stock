
import type pg from "pg";
import { fetchGfexLithiumWarehouseReceipt } from "./gfex.js";
import { recordCommodityFetchRun, storeMarketFactorObservation, upsertMarketFactorSeries } from "./commodity-service.js";

export interface GfexLithiumWarehouseSyncResult {
  reportDate: string; quantity: number | null; previousQuantity: number | null; rowsWritten: number; fetchRunId: string;
  gaps: Array<{ code: string; reason: string }>;
}

export async function syncGfexLithiumWarehouse(db: pg.Pool, reportDate: string, deps: { jobRunId?: string } = {}): Promise<GfexLithiumWarehouseSyncResult> {
  const row = await fetchGfexLithiumWarehouseReceipt(reportDate);
  if (!row) {
    const fetchRunId = await recordCommodityFetchRun(db, { channel: "gfex_official", scope: { dataset: "lithium_warehouse_receipt", report_date: reportDate }, rowsWritten: 0, gaps: [{ code: "LC", reason: "目标日没有碳酸锂仓单小计" }], jobRunId: deps.jobRunId });
    return { reportDate, quantity: null, previousQuantity: null, rowsWritten: 0, fetchRunId, gaps: [{ code: "LC", reason: "目标日没有碳酸锂仓单小计" }] };
  }
  await upsertMarketFactorSeries(db, { seriesCode: "gfex.lc.warehouse_receipt.total", commodityCode: "LITHIUM_CARBONATE", market: "GFEX", metricCode: "warehouse_warrant", frequency: "daily", unit: "张", source: "gfex_official", revisionPolicy: "none" });
  await storeMarketFactorObservation(db, { seriesCode: "gfex.lc.warehouse_receipt.total", periodStart: reportDate, periodEnd: reportDate, publishedAt: `${reportDate}T23:59:59+08:00`, value: row.quantity, sourceRef: row.sourceUrl, rawSummary: { previous_quantity: row.previousQuantity, change: row.change, point_in_time_status: "official_daily_archive_without_exact_publish_time" } });
  const fetchRunId = await recordCommodityFetchRun(db, { channel: "gfex_official", scope: { dataset: "lithium_warehouse_receipt", report_date: reportDate }, rowsWritten: 1, gaps: [], jobRunId: deps.jobRunId });
  return { reportDate, quantity: row.quantity, previousQuantity: row.previousQuantity, rowsWritten: 1, fetchRunId, gaps: [] };
}
