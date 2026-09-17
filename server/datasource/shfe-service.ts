// 上期所官方期货日行情同步：真实合约写统一K线，专属字段和换月映射写商品研究表。
import type pg from "pg";
import { storeBars } from "./service.js";
import {
  recordCommodityFetchRun,
  storeFuturesDailyDetail,
  storeFuturesRoll,
  storeMarketFactorObservation,
  upsertFuturesContract,
  upsertMarketFactorSeries,
} from "./commodity-service.js";
import { fetchShfeCopperWeeklyInventory, fetchShfeDailyContracts, type ShfeDeps } from "./shfe.js";

export interface ShfeDailySyncResult {
  tradeDate: string;
  productCode: string;
  contractCount: number;
  mainContractCode: string | null;
  rowsWritten: number;
  fetchRunId: string;
  gaps: Array<{ code: string; reason: string }>;
}

/** 同步单日单品种全部真实合约；主力映射按当日收盘持仓量、成交量、合约月依次排序。 */
export async function syncShfeFuturesDaily(
  db: pg.Pool,
  tradeDate: string,
  productCode = "CU",
  deps: ShfeDeps & { jobRunId?: string } = {},
): Promise<ShfeDailySyncResult> {
  const product = productCode.trim().toUpperCase();
  const contracts = await fetchShfeDailyContracts(tradeDate, product, deps);
  const gaps: Array<{ code: string; reason: string }> = [];
  let rowsWritten = 0;
  const stored: typeof contracts = [];
  for (const contract of contracts) {
    try {
      const instrumentId = await upsertFuturesContract(db, {
        code: contract.code,
        name: contract.name,
        exchange: "SHFE",
        commodityCode: product,
        contractKind: "listed",
        contractMonth: contract.contractMonth,
        source: "shfe_official",
        rawSummary: { product_code: product },
      });
      rowsWritten += await storeBars(db, instrumentId, "futures_day", [contract.bar], "shfe_official", { markIndicator: false });
      await storeFuturesDailyDetail(db, {
        code: contract.code,
        tradeDate,
        settlement: contract.settlement,
        prevSettlement: contract.prevSettlement,
        openInterest: contract.openInterest,
        source: "shfe_official",
        rawSummary: contract.rawSummary,
      });
      rowsWritten += 1;
      stored.push(contract);
    } catch (error) {
      gaps.push({ code: contract.code, reason: (error as Error).message });
    }
  }
  const main = [...stored].sort((left, right) =>
    right.openInterest - left.openInterest || (right.bar.volume ?? 0) - (left.bar.volume ?? 0) ||
    left.contractMonth.localeCompare(right.contractMonth),
  )[0] ?? null;
  if (main) {
    try {
      await upsertFuturesContract(db, {
        code: `${product}0`, name: `${product}主力连续`, exchange: "SHFE", commodityCode: product,
        contractKind: "main_continuous", source: "shfe_official",
      });
      await storeFuturesRoll(db, {
        continuousCode: `${product}0`, underlyingCode: main.code, tradeDate,
        rollReason: "当日收盘持仓量最大；并列时按成交量和合约月排序",
        methodCode: "open_interest_v1", source: "shfe_official",
        rawSummary: { open_interest: main.openInterest, volume: main.bar.volume ?? null },
      });
      rowsWritten += 1;
    } catch (error) {
      gaps.push({ code: `${product}0`, reason: (error as Error).message });
    }
  }
  const fetchRunId = await recordCommodityFetchRun(db, {
    channel: "shfe_official",
    scope: { dataset: "futures_daily", product, trade_date: tradeDate },
    rowsWritten,
    gaps,
    jobRunId: deps.jobRunId,
  });
  return {
    tradeDate,
    productCode: product,
    contractCount: stored.length,
    mainContractCode: main?.code ?? null,
    rowsWritten,
    fetchRunId,
    gaps,
  };
}

export interface ShfeInventorySyncResult {
  reportDate: string;
  inventory: number;
  previousInventory: number;
  publishedAt: string;
  rowsWritten: number;
  fetchRunId: string;
  gaps: Array<{ code: string; reason: string }>;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** 同步SHFE铜总库存周报；首期只保存总库存，不扩充仓单等额外因子。 */
export async function syncShfeCopperWeeklyInventory(
  db: pg.Pool,
  reportDate: string,
  deps: ShfeDeps & { jobRunId?: string } = {},
): Promise<ShfeInventorySyncResult> {
  const inventory = await fetchShfeCopperWeeklyInventory(reportDate, deps);
  await upsertMarketFactorSeries(db, {
    seriesCode: "shfe.cu.inventory.total",
    commodityCode: "CU",
    market: "SHFE",
    metricCode: "inventory",
    frequency: "weekly",
    unit: inventory.unit,
    source: "shfe_official",
    revisionPolicy: "revisable",
  });
  await storeMarketFactorObservation(db, {
    seriesCode: "shfe.cu.inventory.total",
    periodStart: addDays(reportDate, -6),
    periodEnd: reportDate,
    publishedAt: inventory.publishedAt,
    value: inventory.inventory,
    sourceRef: inventory.sourceUrl,
    rawSummary: {
      previous_inventory: inventory.previousInventory,
      warehouse_warrant: inventory.warehouseWarrant,
      previous_warehouse_warrant: inventory.previousWarehouseWarrant,
      ...inventory.rawSummary,
    },
  });
  const fetchRunId = await recordCommodityFetchRun(db, {
    channel: "shfe_official",
    scope: { dataset: "weekly_inventory", product: "CU", report_date: reportDate },
    rowsWritten: 1,
    gaps: [],
    jobRunId: deps.jobRunId,
  });
  return {
    reportDate,
    inventory: inventory.inventory,
    previousInventory: inventory.previousInventory,
    publishedAt: inventory.publishedAt,
    rowsWritten: 1,
    fetchRunId,
    gaps: [],
  };
}
