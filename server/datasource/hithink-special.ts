// 扶摇涨跌停、炸板、连板天梯与龙虎榜适配。
import { hithinkGet, type HithinkDeps } from "./hithink.js";

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

function shanghaiMidnightMs(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`目标交易日非法：${day}`);
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year!, month! - 1, date!) - CST_OFFSET_MS;
}

export type LimitDataset = "up" | "down" | "break";
const LIMIT_PATHS: Record<LimitDataset, string> = {
  up: "/api/a-share/special-data/limit-up-pool",
  down: "/api/a-share/special-data/limit-down-pool",
  break: "/api/a-share/special-data/limit-break-pool",
};

export interface LimitPoolPage {
  timestampMs: number;
  page: number;
  pages: number;
  total: number;
  items: Record<string, unknown>[];
}

export async function fetchLimitPoolPage(
  dataset: LimitDataset,
  input: { tradeDate: string; page: number; size?: number },
  deps: HithinkDeps = {},
): Promise<LimitPoolPage> {
  const size = input.size ?? 200;
  if (!Number.isInteger(input.page) || input.page < 1) throw new Error("页码必须从 1 开始");
  if (!Number.isInteger(size) || size < 1 || size > 200) throw new Error("分页大小必须为 1..200");
  const data = (await hithinkGet(
    LIMIT_PATHS[dataset],
    { date_ms: shanghaiMidnightMs(input.tradeDate), page: input.page, size },
    { ...deps, priority: deps.priority ?? "scheduled-medium" },
  )) as { timestamp?: unknown; pagination?: unknown; item?: unknown };
  const pagination = data.pagination as Record<string, unknown> | undefined;
  if (!pagination || !Array.isArray(data.item)) throw new Error("扶摇涨跌停分页格式异常");
  const result = {
    timestampMs: Number(data.timestamp),
    page: Number(pagination.page),
    pages: Number(pagination.pages),
    total: Number(pagination.total),
    items: data.item as Record<string, unknown>[],
  };
  if (![result.timestampMs, result.page, result.pages, result.total].every(Number.isFinite)) {
    throw new Error("扶摇涨跌停分页字段异常");
  }
  if (result.page !== input.page || result.pages < result.page || result.total < result.items.length) {
    throw new Error("扶摇涨跌停分页回显不一致");
  }
  return result;
}

export async function fetchLimitLadder(deps: HithinkDeps = {}): Promise<{
  timestampMs: number;
  window: Record<string, unknown>;
  items: Record<string, unknown>[];
}> {
  const data = (await hithinkGet(
    "/api/a-share/special-data/limit-up-ladder",
    {},
    { ...deps, priority: deps.priority ?? "scheduled-medium" },
  )) as { timestamp?: unknown; window?: unknown; item?: unknown };
  if (!Array.isArray(data.item) || !data.window || typeof data.window !== "object") {
    throw new Error("扶摇连板天梯格式异常");
  }
  return {
    timestampMs: Number(data.timestamp),
    window: data.window as Record<string, unknown>,
    items: data.item as Record<string, unknown>[],
  };
}

export type DragonTigerType = "all" | "org" | "hot_money";

export interface DragonTigerResult {
  timestampMs: number;
  boardType: DragonTigerType;
  tradeDate: string;
  stockItems: Record<string, unknown>[];
  hotMoneyItems: Record<string, unknown>[];
}

export async function fetchDragonTiger(
  boardType: DragonTigerType,
  tradeDate: string,
  deps: HithinkDeps = {},
): Promise<DragonTigerResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error(`目标交易日非法：${tradeDate}`);
  const data = (await hithinkGet(
    "/api/a-share/special-data/dragon-tiger-list",
    { board_type: boardType, date: tradeDate },
    { ...deps, priority: deps.priority ?? "scheduled-medium" },
  )) as Record<string, unknown>;
  if (!Array.isArray(data.stock_items) || !Array.isArray(data.hot_money_items)) {
    throw new Error("扶摇龙虎榜格式异常");
  }
  if (data.board_type !== boardType || data.trade_date !== tradeDate) {
    throw new Error("扶摇龙虎榜目标日或榜单类型回显不一致");
  }
  return {
    timestampMs: Number(data.timestamp),
    boardType,
    tradeDate,
    stockItems: data.stock_items as Record<string, unknown>[],
    hotMoneyItems: data.hot_money_items as Record<string, unknown>[],
  };
}
