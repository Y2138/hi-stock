// 动力煤最小研究：回填沿海六大电厂存煤可用天数；第三方归档，只取得研究资格。
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import { recordCommodityFetchRun, storeMarketFactorObservation, upsertMarketFactorSeries } from "../server/datasource/commodity-service.js";
import { fetchCoastalPowerCoalHistory } from "../server/datasource/jin10.js";

const pool = getPool(loadConfig().databaseUrl);
try {
  const rows = await fetchCoastalPowerCoalHistory();
  await upsertMarketFactorSeries(pool, {
    seriesCode: "jin10.coastal_power.coal_available_days",
    commodityCode: "THERMAL_COAL",
    market: "China Coastal Six Power Plants",
    metricCode: "inventory_days",
    frequency: "daily",
    unit: "天",
    source: "jin10_public_archive",
    revisionPolicy: "none",
  });
  let written = 0;
  const gaps: unknown[] = [];
  for (const [index, row] of rows.entries()) {
    try {
      await storeMarketFactorObservation(pool, {
        seriesCode: "jin10.coastal_power.coal_available_days",
        periodStart: row.date,
        periodEnd: row.date,
        publishedAt: `${row.date}T23:59:59+08:00`,
        value: row.availableDays,
        sourceRef: "https://datacenter.jin10.com/reportType/dc_qihuo_energy_report",
        rawSummary: {
          inventory_ten_thousand_tonnes: row.inventoryTenThousandTonnes,
          daily_consumption_ten_thousand_tonnes: row.dailyConsumptionTenThousandTonnes,
          point_in_time_status: "archive_without_original_publish_time",
        },
      });
      written += 1;
    } catch (error) {
      gaps.push({ date: row.date, reason: (error as Error).message });
    }
    if ((index + 1) % 250 === 0) console.log(`[${index + 1}/${rows.length}] 已写入${written}`);
  }
  const fetchRunId = await recordCommodityFetchRun(pool, {
    channel: "jin10_public_archive",
    scope: { dataset: "coastal_power_coal_available_days", start: rows[0]!.date, end: rows.at(-1)!.date },
    rowsWritten: written,
    gaps,
  });
  console.log(`完成：${rows[0]!.date}~${rows.at(-1)!.date}，写入${written}，缺口${gaps.length}，market_fetch_run #${fetchRunId}`);
} finally {
  await closePool();
}
