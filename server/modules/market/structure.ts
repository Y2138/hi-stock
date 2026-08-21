import type pg from "pg";

type Db = Pick<pg.Pool, "query">;

export const MARKET_STRUCTURE_DATASETS = [
  "limit_up",
  "limit_down",
  "limit_break",
  "limit_ladder",
  "dragon_tiger_all",
  "dragon_tiger_org",
  "dragon_tiger_hot_money",
] as const;
export type MarketStructureDataset = (typeof MARKET_STRUCTURE_DATASETS)[number];

export async function queryMarketStructure(
  db: Db,
  input: { date: string; dataset: MarketStructureDataset; page: number; size: number },
): Promise<unknown> {
  const countResult = await db.query<{ dataset: MarketStructureDataset; row_count: number }>(
    `SELECT DISTINCT ON (dataset) dataset, row_count
       FROM market_special_sync_run
      WHERE target_date = $1
      ORDER BY dataset, id DESC`,
    [input.date],
  );
  const sync = await db.query<{
    status: string;
    completed_pages: number;
    total_pages: number | null;
    row_count: number;
    gaps: unknown[];
    source_time: string | null;
    finished_at: string | null;
  }>(
    `SELECT status, completed_pages, total_pages, row_count, gaps,
            source_time::text, finished_at::text
       FROM market_special_sync_run
      WHERE target_date = $1 AND dataset = $2
      ORDER BY id DESC LIMIT 1`,
    [input.date, input.dataset],
  );
  const coverage = sync.rows[0] ?? {
    status: "missing",
    completed_pages: 0,
    total_pages: null,
    row_count: 0,
    gaps: [],
    source_time: null,
    finished_at: null,
  };
  let items: unknown[];
  if (input.dataset.startsWith("limit_") && input.dataset !== "limit_ladder") {
    const eventType = input.dataset === "limit_up" ? "up" : input.dataset === "limit_down" ? "down" : "break";
    const result = await db.query(
      `SELECT instrument.code, instrument.name, event.event_price::float8,
              event.streak_count, event.open_count, event.first_event_time::text,
              event.last_event_time::text,
              COALESCE(event.industry_name, industry.name) AS industry_name,
              industry.code AS industry_code, event.reason,
              event.fetched_at::text
         FROM market_limit_event event
         JOIN market_instrument instrument ON instrument.id = event.instrument_id
         LEFT JOIN LATERAL (
           SELECT board_instrument.code, board_instrument.name
             FROM market_board_membership membership
             JOIN market_board board ON board.instrument_id = membership.board_instrument_id
             JOIN market_instrument board_instrument ON board_instrument.id = board.instrument_id
            WHERE membership.member_instrument_id = instrument.id
              AND board.board_type = 'industry'
              AND membership.effective_from <= $1
              AND (membership.effective_to IS NULL OR membership.effective_to > $1)
            ORDER BY membership.effective_from DESC LIMIT 1
         ) industry ON true
        WHERE event.trade_date = $1 AND event.event_type = $2
        ORDER BY event.streak_count DESC NULLS LAST, instrument.code
        LIMIT $3 OFFSET $4`,
      [input.date, eventType, input.size, (input.page - 1) * input.size],
    );
    items = result.rows;
  } else if (input.dataset === "limit_ladder") {
    const result = await db.query(
      `SELECT id::text, target_date::text, coverage_start::text, coverage_end::text,
              ladder, fetched_at::text
         FROM market_limit_ladder_snapshot WHERE target_date = $1
        ORDER BY id DESC LIMIT 1`,
      [input.date],
    );
    items = result.rows;
  } else {
    const datasetType = input.dataset.replace("dragon_tiger_", "");
    const result = await db.query(
      `SELECT entry.id::text, instrument.code, instrument.name, entry.range_days,
              industry.name AS industry_name, industry.code AS industry_code,
              entry.reason, entry.buy_amount::float8, entry.sell_amount::float8,
              entry.net_amount::float8, entry.fetched_at::text
         FROM market_dragon_tiger_entry entry
         LEFT JOIN market_instrument instrument ON instrument.id = entry.instrument_id
         LEFT JOIN LATERAL (
           SELECT board_instrument.code, board_instrument.name
             FROM market_board_membership membership
             JOIN market_board board ON board.instrument_id = membership.board_instrument_id
             JOIN market_instrument board_instrument ON board_instrument.id = board.instrument_id
            WHERE membership.member_instrument_id = instrument.id
              AND board.board_type = 'industry'
              AND membership.effective_from <= $1
              AND (membership.effective_to IS NULL OR membership.effective_to > $1)
            ORDER BY membership.effective_from DESC LIMIT 1
         ) industry ON true
        WHERE entry.trade_date = $1 AND entry.dataset_type = $2
        ORDER BY abs(entry.net_amount) DESC NULLS LAST, entry.id
        LIMIT $3 OFFSET $4`,
      [input.date, datasetType, input.size, (input.page - 1) * input.size],
    );
    items = result.rows;
  }
  return {
    date: input.date,
    dataset: input.dataset,
    status: coverage.status,
    coverage: {
      completed_pages: coverage.completed_pages,
      total_pages: coverage.total_pages,
      row_count: coverage.row_count,
      source_time: coverage.source_time,
      finished_at: coverage.finished_at,
    },
    gaps: coverage.gaps,
    page: input.page,
    size: input.size,
    items,
    counts: Object.fromEntries(countResult.rows.map((row) => [row.dataset, row.row_count])),
  };
}
