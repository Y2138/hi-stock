// 每日市场结构同步：分页幂等、部分成功留痕、受限源字段白名单。
import crypto from "node:crypto";
import type pg from "pg";
import { inServiceTransaction, type TransactionDb } from "../db/transaction.js";
import type { HithinkDeps } from "./hithink.js";
import {
  fetchDragonTiger,
  fetchLimitLadder,
  fetchLimitPoolPage,
  type DragonTigerType,
  type LimitDataset,
} from "./hithink-special.js";
import { upsertTickerIdentities } from "./catalog-service.js";

type Db = Pick<pg.Pool, "query">;

const LIMIT_DATASET_NAMES: Record<LimitDataset, string> = {
  up: "limit_up",
  down: "limit_down",
  break: "limit_break",
};

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shanghaiDate(timestampMs: number): string {
  return new Date(timestampMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function normalizeSpecialDate(value: string | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : null;
}

function timeOnDate(tradeDate: string, value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return null;
  return `${tradeDate}T${value}:00+08:00`;
}

const LIMIT_PAYLOAD_KEYS = [
  "ticker", "name", "is_st", "is_new", "price_change_ratio_pct", "continue_day_text",
  "seal_money", "max_seal_money", "turnover_ratio_pct", "turnover",
] as const;

function limitPayload(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    LIMIT_PAYLOAD_KEYS.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]),
  );
}

async function startRun(
  db: Db,
  input: { jobRunId?: string; dataset: string; targetDate: string },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO market_special_sync_run (job_run_id, dataset, target_date, status)
     VALUES ($1, $2, $3, 'running')
     ON CONFLICT (job_run_id, dataset) WHERE job_run_id IS NOT NULL DO UPDATE SET
       target_date = EXCLUDED.target_date,
       status = 'running',
       completed_pages = 0,
       total_pages = NULL,
       row_count = 0,
       gaps = '[]',
       source_time = NULL,
       started_at = now(),
       finished_at = NULL
     RETURNING id::text`,
    [input.jobRunId ?? null, input.dataset, input.targetDate],
  );
  return result.rows[0]!.id;
}

async function finishRun(
  db: Db,
  id: string,
  input: {
    status: "success" | "partial" | "failed";
    completedPages: number;
    totalPages: number | null;
    rowCount: number;
    gaps: unknown[];
    sourceTime?: string;
  },
): Promise<void> {
  await db.query(
    `UPDATE market_special_sync_run SET
       status = $2, completed_pages = $3, total_pages = $4, row_count = $5,
       gaps = $6, source_time = $7, finished_at = now()
     WHERE id = $1`,
    [
      id,
      input.status,
      input.completedPages,
      input.totalPages,
      input.rowCount,
      JSON.stringify(input.gaps),
      input.sourceTime ?? null,
    ],
  );
}

async function ensureStockFromRow(
  db: Db,
  row: Record<string, unknown>,
  sourceTimestampMs: number,
): Promise<string> {
  const code = String(row.thscode ?? "").trim().toUpperCase();
  const name = String(row.name ?? code).trim();
  if (!/^\d{6}\.(?:SH|SZ|BJ)$/.test(code)) throw new Error(`特色数据包含非法股票代码：${code}`);
  await upsertTickerIdentities(db, [{
    code,
    ticker: code.split(".")[0]!,
    name,
    exchange: code.endsWith(".SH") ? "SH" : code.endsWith(".SZ") ? "SZ" : "BJ",
    assetType: "a-share",
    currency: "CNY",
    sourceUpdatedAt: new Date(sourceTimestampMs).toISOString(),
  }]);
  const instrument = await db.query<{ id: string }>(
    "SELECT id::text FROM market_instrument WHERE code = $1",
    [code],
  );
  return instrument.rows[0]!.id;
}

export interface SpecialSyncSummary {
  dataset: string;
  targetDate: string;
  status: "success" | "partial" | "failed";
  rows: number;
  completedPages: number;
  totalPages: number | null;
  gaps: Array<{ page?: number; reason: string }>;
  runId: string;
}

export async function syncLimitDataset(
  db: TransactionDb,
  dataset: LimitDataset,
  targetDate: string,
  deps: HithinkDeps & { jobRunId?: string } = {},
): Promise<SpecialSyncSummary> {
  deps = { ...deps, db: deps.db ?? db };
  const datasetName = LIMIT_DATASET_NAMES[dataset];
  const runId = await startRun(db, { jobRunId: deps.jobRunId, dataset: datasetName, targetDate });
  let page = 1;
  let totalPages: number | null = null;
  let rows = 0;
  let sourceTime: string | undefined;
  const gaps: Array<{ page?: number; reason: string }> = [];
  try {
    for (;;) {
      let result;
      try {
        result = await fetchLimitPoolPage(dataset, { tradeDate: targetDate, page, size: 200 }, deps);
      } catch (error) {
        gaps.push({ page, reason: (error as Error).message });
        break;
      }
      if (shanghaiDate(result.timestampMs) !== targetDate) {
        gaps.push({ page, reason: `供应商数据日 ${shanghaiDate(result.timestampMs)} 与目标日 ${targetDate} 不一致` });
        break;
      }
      totalPages = result.pages;
      sourceTime = new Date(result.timestampMs).toISOString();
      await inServiceTransaction(db, async (client) => {
        for (const item of result.items) {
          const instrumentId = await ensureStockFromRow(client, item, result.timestampMs);
          const payload = limitPayload(item);
          const first = dataset === "up"
            ? timeOnDate(targetDate, item.limit_up_time)
            : dataset === "down"
              ? timeOnDate(targetDate, item.first_limit_time)
              : null;
          const last = dataset === "up"
            ? timeOnDate(targetDate, item.limit_up_time)
            : dataset === "down"
              ? timeOnDate(targetDate, item.last_limit_time)
              : null;
          await client.query(
            `INSERT INTO market_limit_event
               (trade_date, event_type, instrument_id, event_price, streak_count, open_count,
                first_event_time, last_event_time, industry_name, reason,
                source_payload, source_row_sha256, fetched_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
             ON CONFLICT (trade_date, event_type, instrument_id) DO UPDATE SET
               event_price = EXCLUDED.event_price,
               streak_count = EXCLUDED.streak_count,
               open_count = EXCLUDED.open_count,
               first_event_time = EXCLUDED.first_event_time,
               last_event_time = EXCLUDED.last_event_time,
               industry_name = EXCLUDED.industry_name,
               reason = EXCLUDED.reason,
               source_payload = EXCLUDED.source_payload,
               source_row_sha256 = EXCLUDED.source_row_sha256,
               fetched_at = now()`,
            [
              targetDate,
              dataset,
              instrumentId,
              nullableNumber(item.last_price),
              nullableNumber(item.continue_day_cnt),
              nullableNumber(item.open_times),
              first,
              last,
              typeof item.industry_name === "string" ? item.industry_name : null,
              typeof item.limit_up_reason === "string" ? item.limit_up_reason : null,
              JSON.stringify(payload),
              sha256(item),
            ],
          );
        }
      });
      rows += result.items.length;
      if (page >= result.pages) break;
      page += 1;
    }
    const completedPages = gaps.length ? page - 1 : totalPages ?? 0;
    const status = gaps.length ? (rows > 0 ? "partial" : "failed") : "success";
    await finishRun(db, runId, {
      status,
      completedPages,
      totalPages,
      rowCount: rows,
      gaps,
      sourceTime,
    });
    return { dataset: datasetName, targetDate, status, rows, completedPages, totalPages, gaps, runId };
  } catch (error) {
    gaps.push({ reason: (error as Error).message });
    await finishRun(db, runId, {
      status: rows > 0 ? "partial" : "failed",
      completedPages: Math.max(0, page - 1),
      totalPages,
      rowCount: rows,
      gaps,
      sourceTime,
    });
    throw error;
  }
}

export async function syncLimitLadder(
  db: Db,
  targetDate: string,
  deps: HithinkDeps & { jobRunId?: string } = {},
): Promise<SpecialSyncSummary> {
  deps = { ...deps, db: deps.db ?? db };
  const runId = await startRun(db, { jobRunId: deps.jobRunId, dataset: "limit_ladder", targetDate });
  try {
    const result = await fetchLimitLadder(deps);
    const dateList = Array.isArray(result.window.date_list)
      ? result.window.date_list.map(String)
      : [];
    const first = dateList.at(-1);
    const last = dateList.at(0);
    const normalizedLast = normalizeSpecialDate(last);
    if (normalizedLast !== targetDate) throw new Error(`连板天梯截止日 ${normalizedLast ?? "未知"} 与目标日 ${targetDate} 不一致`);
    const normalizedFirst = normalizeSpecialDate(first);
    await db.query(
      `INSERT INTO market_limit_ladder_snapshot
         (target_date, coverage_start, coverage_end, ladder, source_sha256, fetched_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (target_date, source_sha256) DO NOTHING`,
      [targetDate, normalizedFirst, normalizedLast, JSON.stringify({ window: result.window, item: result.items }), sha256(result)],
    );
    await finishRun(db, runId, {
      status: "success",
      completedPages: 1,
      totalPages: 1,
      rowCount: result.items.length,
      gaps: [],
      sourceTime: new Date(result.timestampMs).toISOString(),
    });
    return {
      dataset: "limit_ladder",
      targetDate,
      status: "success",
      rows: result.items.length,
      completedPages: 1,
      totalPages: 1,
      gaps: [],
      runId,
    };
  } catch (error) {
    const gaps = [{ reason: (error as Error).message }];
    await finishRun(db, runId, { status: "failed", completedPages: 0, totalPages: 1, rowCount: 0, gaps });
    return { dataset: "limit_ladder", targetDate, status: "failed", rows: 0, completedPages: 0, totalPages: 1, gaps, runId };
  }
}

function dragonRows(result: Awaited<ReturnType<typeof fetchDragonTiger>>): Record<string, unknown>[] {
  if (result.boardType !== "hot_money") return result.stockItems;
  return result.hotMoneyItems.flatMap((group) => {
    const name = typeof group.name === "string" ? group.name : null;
    const rows = Array.isArray(group.rows) ? group.rows : [];
    return rows.map((row) => ({ ...(row as Record<string, unknown>), hot_money_name: name }));
  });
}

export async function syncDragonTiger(
  db: TransactionDb,
  boardType: DragonTigerType,
  targetDate: string,
  deps: HithinkDeps & { jobRunId?: string } = {},
): Promise<SpecialSyncSummary> {
  deps = { ...deps, db: deps.db ?? db };
  const dataset = `dragon_tiger_${boardType}`;
  const runId = await startRun(db, { jobRunId: deps.jobRunId, dataset, targetDate });
  try {
    const result = await fetchDragonTiger(boardType, targetDate, deps);
    const items = dragonRows(result);
    await inServiceTransaction(db, async (client) => {
      for (const item of items) {
        const code = String(item.thscode ?? "").trim().toUpperCase();
        const instrumentId = /^\d{6}\.(?:SH|SZ|BJ)$/.test(code)
          ? await ensureStockFromRow(client, item, result.timestampMs)
          : null;
        const payload = Object.fromEntries(Object.entries(item).filter(([key]) => [
          "ticker", "name", "change", "net_rate", "hot_rank", "org_net_value",
          "org_net_rate", "org_buy_num", "org_sell_num", "amount", "hot_money_name",
        ].includes(key)));
        const rowHash = sha256({ boardType, item });
        await client.query(
          `INSERT INTO market_dragon_tiger_entry
             (trade_date, dataset_type, instrument_id, range_days, reason,
              buy_amount, sell_amount, net_amount, source_payload, source_row_sha256, fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
           ON CONFLICT (trade_date, dataset_type, source_row_sha256) DO UPDATE SET
             instrument_id = EXCLUDED.instrument_id,
             range_days = EXCLUDED.range_days,
             reason = EXCLUDED.reason,
             buy_amount = EXCLUDED.buy_amount,
             sell_amount = EXCLUDED.sell_amount,
             net_amount = EXCLUDED.net_amount,
             source_payload = EXCLUDED.source_payload,
             fetched_at = now()`,
          [
            targetDate,
            boardType,
            instrumentId,
            nullableNumber(item.range_days),
            typeof item.limit_reason === "string" ? item.limit_reason : null,
            nullableNumber(item.buy_value ?? item.buying),
            nullableNumber(item.sell_value),
            nullableNumber(item.net_value ?? item.hot_money_item_net_value),
            JSON.stringify(payload),
            rowHash,
          ],
        );
      }
    });
    await finishRun(db, runId, {
      status: "success",
      completedPages: 1,
      totalPages: 1,
      rowCount: items.length,
      gaps: [],
      sourceTime: new Date(result.timestampMs).toISOString(),
    });
    return { dataset, targetDate, status: "success", rows: items.length, completedPages: 1, totalPages: 1, gaps: [], runId };
  } catch (error) {
    const gaps = [{ reason: (error as Error).message }];
    await finishRun(db, runId, { status: "failed", completedPages: 0, totalPages: 1, rowCount: 0, gaps });
    return { dataset, targetDate, status: "failed", rows: 0, completedPages: 0, totalPages: 1, gaps, runId };
  }
}

export async function syncDailyMarketStructure(
  db: TransactionDb,
  targetDate: string,
  deps: HithinkDeps & { jobRunId?: string } = {},
): Promise<{ datasets: SpecialSyncSummary[]; gaps: unknown[] }> {
  deps = { ...deps, db: deps.db ?? db };
  const datasets: SpecialSyncSummary[] = [];
  for (const dataset of ["up", "down", "break"] as const) {
    datasets.push(await syncLimitDataset(db, dataset, targetDate, deps));
  }
  datasets.push(await syncLimitLadder(db, targetDate, deps));
  for (const boardType of ["all", "org", "hot_money"] as const) {
    datasets.push(await syncDragonTiger(db, boardType, targetDate, deps));
  }
  return {
    datasets,
    gaps: datasets.flatMap((dataset) => dataset.gaps.map((gap) => ({ dataset: dataset.dataset, ...gap }))),
  };
}
