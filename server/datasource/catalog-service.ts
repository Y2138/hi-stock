// 完整标的目录、板块目录/成分和交易日历的数据库同步服务。
import type pg from "pg";
import { inServiceTransaction, type TransactionDb } from "../db/transaction.js";
import { fetchBoardCatalog, fetchBoardConstituents, BOARD_TYPES, type BoardType } from "./hithink-boards.js";
import {
  fetchAllTickers,
  fetchTradingDays,
  searchRemoteTickers,
  TICKER_ASSET_TYPES,
  type TickerIdentity,
} from "./hithink-meta.js";
import type { HithinkDeps } from "./hithink.js";
import { insertFetchRun } from "./service.js";

type Db = Pick<pg.Pool, "query">;

export type InstrumentKind = "stock" | "etf" | "index" | "board" | "fund" | "futures";

function identityKind(identity: TickerIdentity, boardCodes: ReadonlySet<string>): InstrumentKind {
  if (identity.assetType === "a-share") return "stock";
  if (identity.assetType === "fund-etf") return "etf";
  if (["fund-lof", "fund-otc", "fund-reits"].includes(identity.assetType)) return "fund";
  return boardCodes.has(identity.code) ? "board" : "index";
}

function capabilities(kind: InstrumentKind): Record<string, boolean> {
  if (kind === "stock") return { snapshot: true, daily_bar: true, financial: true };
  if (kind === "etf" || kind === "index") return { snapshot: true, daily_bar: true };
  if (kind === "board") return { snapshot: true, daily_bar: true, board_constituents: true };
  if (kind === "futures") return { snapshot: false, daily_bar: true };
  return { snapshot: false, daily_bar: false };
}

export async function upsertTickerIdentities(
  db: Db,
  identities: TickerIdentity[],
  boardCodes: ReadonlySet<string> = new Set(),
): Promise<number> {
  if (identities.length === 0) return 0;
  const rows = identities.map((identity) => {
    const kind = identityKind(identity, boardCodes);
    return {
      code: identity.code,
      ticker: identity.ticker,
      name: identity.name,
      kind,
      exchange: identity.exchange,
      source_asset_type: identity.assetType,
      currency: identity.currency,
      capabilities: capabilities(kind),
      source_updated_at: identity.sourceUpdatedAt,
    };
  });
  await db.query(
    `WITH incoming AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
         code text, ticker text, name text, kind text, exchange text,
         source_asset_type text, currency text, capabilities jsonb, source_updated_at timestamptz
       )
     )
     INSERT INTO market_instrument_alias (instrument_id, alias)
     SELECT existing.id, existing.name
       FROM incoming JOIN market_instrument existing ON existing.code = incoming.code
      WHERE existing.name <> incoming.name
     ON CONFLICT (instrument_id, alias) DO NOTHING`,
    [JSON.stringify(rows)],
  );
  await db.query(
    `WITH incoming AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
         code text, ticker text, name text, kind text, exchange text,
         source_asset_type text, currency text, capabilities jsonb, source_updated_at timestamptz
       )
     )
     INSERT INTO market_instrument
       (code, ticker, name, kind, exchange, source_asset_type, currency,
        lifecycle_status, capabilities, source_updated_at, updated_at)
     SELECT code, ticker, name, kind, exchange, source_asset_type, currency,
            'active', capabilities, source_updated_at, now()
       FROM incoming
     ON CONFLICT (code) DO UPDATE SET
       ticker = EXCLUDED.ticker,
       name = EXCLUDED.name,
       kind = EXCLUDED.kind,
       exchange = EXCLUDED.exchange,
       source_asset_type = EXCLUDED.source_asset_type,
       currency = EXCLUDED.currency,
       lifecycle_status = 'active',
       capabilities = EXCLUDED.capabilities,
       source_updated_at = EXCLUDED.source_updated_at,
       updated_at = now()`,
    [JSON.stringify(rows)],
  );
  return rows.length;
}

async function upsertBoardCatalog(
  db: Db,
  boards: Array<{ code: string; name: string; boardType: BoardType; sourceUpdatedAt: string }>,
): Promise<void> {
  if (!boards.length) return;
  const identities: TickerIdentity[] = boards.map((board) => ({
    code: board.code,
    ticker: board.code.split(".")[0]!,
    name: board.name,
    exchange: null,
    assetType: "a-share-index",
    currency: "CNY",
    sourceUpdatedAt: board.sourceUpdatedAt,
  }));
  const boardCodes = new Set(boards.map((board) => board.code));
  await upsertTickerIdentities(db, identities, boardCodes);
  await db.query(
    `WITH incoming AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
         code text, board_type text, source_updated_at timestamptz
       )
     )
     INSERT INTO market_board (instrument_id, board_type, source_updated_at, active, updated_at)
     SELECT instrument.id, incoming.board_type, incoming.source_updated_at, true, now()
       FROM incoming JOIN market_instrument instrument ON instrument.code = incoming.code
     ON CONFLICT (instrument_id) DO UPDATE SET
       board_type = EXCLUDED.board_type,
       source_updated_at = EXCLUDED.source_updated_at,
       active = true,
       updated_at = now()`,
    [JSON.stringify(boards.map((board) => ({
      code: board.code,
      board_type: board.boardType,
      source_updated_at: board.sourceUpdatedAt,
    })))],
  );
}

export interface CatalogSyncSummary {
  tickerCount: number;
  boardCount: number;
  tradingDayCount: number;
  fetchRunIds: string[];
}

export async function syncMarketCatalog(
  db: TransactionDb,
  deps: HithinkDeps & { jobRunId?: string } = {},
): Promise<CatalogSyncSummary> {
  deps = { ...deps, db: deps.db ?? db };
  const boards = [] as Awaited<ReturnType<typeof fetchBoardCatalog>>;
  for (const boardType of BOARD_TYPES) boards.push(...await fetchBoardCatalog(boardType, deps));
  const boardCodes = new Set(boards.map((board) => board.code));
  const tickers = await fetchAllTickers({ assetTypes: [...TICKER_ASSET_TYPES] }, deps);
  const tradingDays = await fetchTradingDays(deps);
  return inServiceTransaction(db, async (client) => {
    await upsertBoardCatalog(client, boards);
    await upsertTickerIdentities(client, tickers, boardCodes);
    const activeCodes = [...new Set([...tickers.map((ticker) => ticker.code), ...boardCodes])];
    await client.query(
      `UPDATE market_instrument SET lifecycle_status = 'inactive', updated_at = now()
        WHERE source_asset_type IN ('a-share','a-share-index','fund-etf','fund-lof','fund-otc','fund-reits')
          AND NOT (code = ANY($1::text[]))`,
      [activeCodes],
    );
    await client.query(
      `WITH incoming AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(trade_date date, source text)
       )
       INSERT INTO market_trading_day (trade_date, is_open, source, fetched_at)
       SELECT trade_date, true, source, now() FROM incoming
       ON CONFLICT (trade_date) DO UPDATE SET is_open = true, source = EXCLUDED.source, fetched_at = now()`,
      [JSON.stringify(tradingDays.map((day) => ({ trade_date: day.date, source: "hithink" })))],
    );
    const fetchRunId = await insertFetchRun(client, {
      jobRunId: deps.jobRunId,
      channel: "hithink",
      scope: { pipeline: "market_catalog_sync", boards: boards.length, tickers: tickers.length },
      rowsWritten: boards.length + tickers.length + tradingDays.length,
    });
    return {
      tickerCount: tickers.length,
      boardCount: boards.length,
      tradingDayCount: tradingDays.length,
      fetchRunIds: [fetchRunId],
    };
  });
}

export async function resolveRemoteTicker(
  query: string,
  deps: HithinkDeps = {},
): Promise<TickerIdentity[]> {
  return searchRemoteTickers({ q: query, limit: 20 }, deps);
}

export interface BoardMembershipSyncResult {
  boardCode: string;
  memberCount: number;
  opened: number;
  closed: number;
  fetchRunId: string;
}

export async function syncBoardMembership(
  db: TransactionDb,
  boardCode: string,
  effectiveDate: string,
  deps: HithinkDeps & { jobRunId?: string } = {},
): Promise<BoardMembershipSyncResult> {
  deps = { ...deps, db: deps.db ?? db };
  const members = await fetchBoardConstituents(boardCode, deps);
  return inServiceTransaction(db, async (client) => {
    const board = await client.query<{ id: string }>(
      `SELECT instrument.id::text
       FROM market_instrument instrument JOIN market_board board ON board.instrument_id = instrument.id
        WHERE instrument.code = $1 AND board.active = true
          AND board.source = 'hithink' AND board.board_type = 'industry' FOR UPDATE`,
      [boardCode],
    );
    if (!board.rows[0]) throw new Error(`未知或未激活板块：${boardCode}`);
    await upsertTickerIdentities(
      client,
      members.map((member) => ({
        code: member.code,
        ticker: member.ticker,
        name: member.name,
        exchange: member.code.endsWith(".SH") ? "SH" : member.code.endsWith(".SZ") ? "SZ" : "BJ",
        assetType: "a-share",
        currency: "CNY",
        sourceUpdatedAt: member.sourceUpdatedAt,
      })),
    );
    const fetchRunId = await insertFetchRun(client, {
      jobRunId: deps.jobRunId,
      channel: "hithink",
      scope: { pipeline: "board_membership_sync", board_code: boardCode, effective_date: effectiveDate },
      rowsWritten: members.length,
    });
    const memberCodes = members.map((member) => member.code);
    const removedSameDay = await client.query(
      `DELETE FROM market_board_membership membership
        USING market_instrument member
        WHERE membership.board_instrument_id = $1
          AND membership.member_instrument_id = member.id
          AND membership.effective_to IS NULL
          AND membership.effective_from = $2
          AND NOT (member.code = ANY($3::text[]))`,
      [board.rows[0].id, effectiveDate, memberCodes],
    );
    const closed = await client.query(
      `UPDATE market_board_membership membership
          SET effective_to = $2, closed_fetch_run_id = $4
         FROM market_instrument member
        WHERE membership.board_instrument_id = $1
          AND membership.member_instrument_id = member.id
          AND membership.effective_to IS NULL
          AND membership.effective_from < $2
          AND NOT (member.code = ANY($3::text[]))`,
      [board.rows[0].id, effectiveDate, memberCodes, fetchRunId],
    );
    const opened = await client.query(
      `INSERT INTO market_board_membership
         (board_instrument_id, member_instrument_id, effective_from, opened_fetch_run_id)
       SELECT $1, member.id, $2, $4
         FROM market_instrument member
        WHERE member.code = ANY($3::text[])
          AND NOT EXISTS (
            SELECT 1 FROM market_board_membership current
             WHERE current.board_instrument_id = $1
               AND current.member_instrument_id = member.id
               AND current.effective_to IS NULL
          )`,
      [board.rows[0].id, effectiveDate, memberCodes, fetchRunId],
    );
    return {
      boardCode,
      memberCount: members.length,
      opened: opened.rowCount ?? 0,
      closed: (closed.rowCount ?? 0) + (removedSameDay.rowCount ?? 0),
      fetchRunId,
    };
  });
}

export async function syncAllBoardMemberships(
  db: TransactionDb,
  effectiveDate: string,
  deps: HithinkDeps & { jobRunId?: string } = {},
): Promise<{ completed: BoardMembershipSyncResult[]; gaps: Array<{ code: string; reason: string }> }> {
  deps = { ...deps, db: deps.db ?? db };
  const boards = await db.query<{ code: string }>(
    `SELECT instrument.code FROM market_board board
      JOIN market_instrument instrument ON instrument.id = board.instrument_id
     WHERE board.active = true AND board.source = 'hithink' AND board.board_type = 'industry'
     ORDER BY instrument.code`,
  );
  const completed: BoardMembershipSyncResult[] = [];
  const gaps: Array<{ code: string; reason: string }> = [];
  for (const board of boards.rows) {
    try {
      completed.push(await syncBoardMembership(db, board.code, effectiveDate, deps));
    } catch (error) {
      gaps.push({ code: board.code, reason: (error as Error).message });
    }
  }
  return { completed, gaps };
}
