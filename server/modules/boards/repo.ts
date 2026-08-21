import type pg from "pg";

type Db = Pick<pg.Pool, "query">;

export async function listBoards(db: Db, opts: { type?: string; q?: string; limit: number }): Promise<unknown[]> {
  const result = await db.query(
    `SELECT instrument.code, instrument.name, board.board_type, board.source_updated_at,
            latest_close.close::float8 AS last, latest_close.bar_date::text AS quote_time,
            count(DISTINCT membership.member_instrument_id)::int AS constituent_count,
            count(DISTINCT pool_role.instrument_id)::int AS pool_intersection
       FROM market_board board
       JOIN market_instrument instrument ON instrument.id = board.instrument_id
       LEFT JOIN LATERAL (
         SELECT bar.close, bar.bar_date
           FROM market_bar bar
          WHERE bar.instrument_id = instrument.id AND bar.freq = 'day'
          ORDER BY bar.bar_date DESC, bar.bar_time DESC LIMIT 1
       ) latest_close ON true
       LEFT JOIN market_board_membership membership
         ON membership.board_instrument_id = board.instrument_id AND membership.effective_to IS NULL
       LEFT JOIN pool_membership pool_role
         ON pool_role.instrument_id = membership.member_instrument_id AND pool_role.effective_to IS NULL
      WHERE board.active = true
        AND ($1::text IS NULL OR board.board_type = $1)
        AND ($2::text IS NULL OR instrument.code ILIKE '%' || $2 || '%' OR instrument.name ILIKE '%' || $2 || '%')
      GROUP BY instrument.id, board.instrument_id, latest_close.close, latest_close.bar_date
      ORDER BY board.board_type, instrument.code LIMIT $3`,
    [opts.type ?? null, opts.q ?? null, opts.limit],
  );
  return result.rows;
}

export async function listBoardConstituents(db: Db, code: string, asOf: string): Promise<unknown | null> {
  const board = await db.query<{ id: string; first_date: string | null }>(
    `SELECT instrument.id::text,
            (SELECT min(effective_from)::text FROM market_board_membership WHERE board_instrument_id = instrument.id) AS first_date
       FROM market_board JOIN market_instrument instrument ON instrument.id = market_board.instrument_id
      WHERE instrument.code = $1 AND market_board.active = true`,
    [code],
  );
  if (!board.rows[0]) return null;
  if (board.rows[0].first_date && asOf < board.rows[0].first_date) {
    return { code, as_of: asOf, status: "unavailable", first_available_date: board.rows[0].first_date, constituents: [] };
  }
  const members = await db.query(
    `SELECT member.code, member.name, member.kind, membership.effective_from::text, membership.effective_to::text,
            pool_role.pool, pool_role.role
       FROM market_board_membership membership
       JOIN market_instrument member ON member.id = membership.member_instrument_id
       LEFT JOIN pool_membership pool_role
         ON pool_role.instrument_id = member.id AND pool_role.effective_to IS NULL
      WHERE membership.board_instrument_id = $1
        AND membership.effective_from <= $2
        AND (membership.effective_to IS NULL OR membership.effective_to > $2)
      ORDER BY member.code`,
    [board.rows[0].id, asOf],
  );
  const latestRun = await db.query<{ finished_at: string; gaps: unknown[] }>(
    `SELECT finished_at::text, gaps FROM market_fetch_run
      WHERE scope->>'pipeline' = 'board_membership_sync' AND scope->>'board_code' = $1
      ORDER BY id DESC LIMIT 1`,
    [code],
  );
  return {
    code,
    as_of: asOf,
    status: latestRun.rows[0]?.gaps.length ? "partial" : "complete",
    synced_at: latestRun.rows[0]?.finished_at ?? null,
    gaps: latestRun.rows[0]?.gaps ?? [],
    constituents: members.rows,
  };
}
