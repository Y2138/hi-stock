// 扶摇同花顺板块目录与当前成分适配。
import { hithinkGet, type HithinkDeps } from "./hithink.js";

export const BOARD_TYPES = ["industry", "concept", "region", "special"] as const;
export type BoardType = (typeof BOARD_TYPES)[number];

const BOARD_TAGS: Record<BoardType, string> = {
  industry: "industry",
  concept: "cn_concept",
  region: "region",
  special: "tszs",
};

export interface BoardIdentity {
  code: string;
  name: string;
  boardType: BoardType;
  sourceUpdatedAt: string;
}

export async function fetchBoardCatalog(
  boardType: BoardType,
  deps: HithinkDeps = {},
): Promise<BoardIdentity[]> {
  const data = (await hithinkGet(
    "/api/a-share-index/catalog/ths-index-list",
    { tag: BOARD_TAGS[boardType] },
    { ...deps, priority: deps.priority ?? "scheduled-medium" },
  )) as { timestamp?: unknown; item?: unknown };
  if (!Array.isArray(data.item)) throw new Error("扶摇板块目录 item 格式异常");
  const timestamp = Number(data.timestamp);
  if (!Number.isFinite(timestamp)) throw new Error("扶摇板块目录 timestamp 格式异常");
  return data.item.map((raw) => {
    const row = raw as Record<string, unknown>;
    const code = String(row.thscode ?? "").trim().toUpperCase();
    const name = String(row.name ?? "").trim();
    if (!/^\d{6}\.TI$/.test(code) || !name) throw new Error(`扶摇返回非法板块：${code}`);
    return { code, name, boardType, sourceUpdatedAt: new Date(timestamp).toISOString() };
  });
}

export interface BoardConstituent {
  code: string;
  ticker: string;
  name: string;
  sourceUpdatedAt: string;
}

export async function fetchBoardConstituents(
  code: string,
  deps: HithinkDeps = {},
): Promise<BoardConstituent[]> {
  const normalized = code.trim().toUpperCase();
  if (!/^\d{6}\.(?:TI|SH|SZ)$/.test(normalized)) throw new Error(`板块/指数代码非法：${code}`);
  const data = (await hithinkGet(
    "/api/a-share-index/constituents/ths-stock-list",
    { thscode: normalized },
    { ...deps, priority: deps.priority ?? "scheduled-low" },
  )) as { timestamp?: unknown; item?: unknown };
  if (!Array.isArray(data.item)) throw new Error("扶摇板块成分 item 格式异常");
  const timestamp = Number(data.timestamp);
  if (!Number.isFinite(timestamp)) throw new Error("扶摇板块成分 timestamp 格式异常");
  return data.item.map((raw) => {
    const row = raw as Record<string, unknown>;
    const memberCode = String(row.thscode ?? "").trim().toUpperCase();
    const ticker = String(row.ticker ?? "").trim();
    const name = String(row.name ?? "").trim();
    if (!/^\d{6}\.(?:SH|SZ|BJ)$/.test(memberCode) || !/^\d{6}$/.test(ticker) || !name) {
      throw new Error(`扶摇返回非法板块成分：${memberCode}`);
    }
    return { code: memberCode, ticker, name, sourceUpdatedAt: new Date(timestamp).toISOString() };
  });
}

