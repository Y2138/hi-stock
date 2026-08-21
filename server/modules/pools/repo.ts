// 短线池/长线池领域：当前角色、研究属性、板块投影与展示偏好。
import type pg from "pg";
import { inServiceTransaction, type TransactionDb } from "../../db/transaction.js";

export type Db = Pick<pg.Pool | pg.PoolClient, "query">;
export type PoolKind = "short" | "long";

export interface PoolMemberRow {
  id: string;
  pool: PoolKind;
  role: string;
  grade: string | null;
  score: number | null;
  tags: string[];
  stock_character: string | null;
  stage: string | null;
  evaluation_summary: string | null;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  attention_reason: string | null;
  attention_from: string | null;
  attention_until: string | null;
  code: string;
  name: string;
  kind: string;
  last: number | null;
  prev_close: number | null;
  change_pct: number | null;
  quote_time: string | null;
  price_source: "close" | null;
  boards: Array<{ code: string; name: string; board_type: string; level: "primary" | "secondary" }>;
}

export interface PoolBoardRow {
  code: string;
  name: string;
  board_type: string;
  source_updated_at: string | null;
  sort: number | null;
  member_count: number;
  last: number | null;
  prev_close: number | null;
  change_pct: number | null;
  quote_time: string | null;
  level: "primary";
}

export interface PoolViewData {
  pool: PoolKind;
  members: PoolMemberRow[];
  boards: PoolBoardRow[];
  attention_count: number;
  unclassified_count: number;
}

const MEMBER_SELECT = `SELECT membership.id::text, membership.pool, membership.role,
  membership.grade, membership.score::float8, membership.tags,
  membership.stock_character, membership.stage, membership.evaluation_summary,
  membership.effective_from::text, membership.effective_to::text, membership.note,
  membership.attention_reason, membership.attention_from::text, membership.attention_until::text,
  instrument.code, instrument.name, instrument.kind,
  latest_close.close::float8 AS last,
  latest_close.prev_close::float8,
  CASE WHEN latest_close.close IS NOT NULL AND latest_close.prev_close > 0
       THEN latest_close.close / latest_close.prev_close - 1 ELSE NULL END::float8 AS change_pct,
  latest_close.bar_date::text AS quote_time,
  CASE WHEN latest_close.close IS NOT NULL THEN 'close' ELSE NULL END AS price_source,
  COALESCE(board_list.boards, '[]'::jsonb) AS boards
FROM pool_membership membership
JOIN market_instrument instrument ON instrument.id = membership.instrument_id
LEFT JOIN LATERAL (
  SELECT bar.close, bar.bar_date,
         (SELECT previous.close FROM market_bar previous
           WHERE previous.instrument_id = instrument.id AND previous.freq = 'day'
           ORDER BY previous.bar_date DESC, previous.bar_time DESC OFFSET 1 LIMIT 1) AS prev_close
    FROM market_bar bar
   WHERE bar.instrument_id = instrument.id AND bar.freq = 'day'
   ORDER BY bar.bar_date DESC, bar.bar_time DESC LIMIT 1
) latest_close ON true
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object(
           'code', board_instrument.code, 'name', board_instrument.name, 'board_type', board.board_type,
           'level', CASE WHEN board_instrument.code LIKE '881%.TI' THEN 'primary' ELSE 'secondary' END
         ) ORDER BY CASE WHEN board_instrument.code LIKE '881%.TI' THEN 0 ELSE 1 END, board_instrument.name) AS boards
    FROM market_board_membership board_membership
    JOIN market_instrument board_instrument ON board_instrument.id = board_membership.board_instrument_id
    JOIN market_board board ON board.instrument_id = board_membership.board_instrument_id
      AND board.active = true AND board.source = 'hithink' AND board.board_type = 'industry'
   WHERE board_membership.member_instrument_id = membership.instrument_id
     AND board_membership.effective_to IS NULL
     AND (board_instrument.code LIKE '881%.TI' OR board_instrument.code LIKE '884%.TI')
) board_list ON true`;

export async function listPoolView(db: Db, pool: PoolKind): Promise<PoolViewData> {
  const members = await db.query<PoolMemberRow>(
    `${MEMBER_SELECT}
      WHERE membership.pool = $1 AND membership.effective_to IS NULL
      ORDER BY membership.score DESC NULLS LAST, instrument.code`,
    [pool],
  );
  const boards = await db.query<PoolBoardRow>(
    `SELECT board_instrument.code, board_instrument.name, board.board_type, 'primary'::text AS level,
            board.source_updated_at::text, preference.sort,
            count(DISTINCT membership.id)::int AS member_count,
            latest_close.close::float8 AS last, latest_close.prev_close::float8,
            CASE WHEN latest_close.close IS NOT NULL AND latest_close.prev_close > 0
                 THEN latest_close.close / latest_close.prev_close - 1 ELSE NULL END::float8 AS change_pct,
            latest_close.bar_date::text AS quote_time
       FROM pool_membership membership
       JOIN market_board_membership relation
         ON relation.member_instrument_id = membership.instrument_id AND relation.effective_to IS NULL
       JOIN market_board board
         ON board.instrument_id = relation.board_instrument_id
        AND board.active = true AND board.source = 'hithink' AND board.board_type = 'industry'
       JOIN market_instrument board_instrument ON board_instrument.id = board.instrument_id
       LEFT JOIN pool_board_preference preference
         ON preference.pool = membership.pool AND preference.board_instrument_id = board.instrument_id
       LEFT JOIN LATERAL (
         SELECT bar.close, bar.bar_date,
                (SELECT previous.close FROM market_bar previous
                  WHERE previous.instrument_id = board.instrument_id AND previous.freq = 'day'
                  ORDER BY previous.bar_date DESC, previous.bar_time DESC OFFSET 1 LIMIT 1) AS prev_close
           FROM market_bar bar
          WHERE bar.instrument_id = board.instrument_id AND bar.freq = 'day'
          ORDER BY bar.bar_date DESC, bar.bar_time DESC LIMIT 1
       ) latest_close ON true
      WHERE membership.pool = $1 AND membership.effective_to IS NULL
        AND board_instrument.code LIKE '881%.TI'
      GROUP BY board_instrument.id, board.instrument_id, preference.sort,
               latest_close.close, latest_close.prev_close, latest_close.bar_date
      ORDER BY preference.sort NULLS LAST, count(DISTINCT membership.id) DESC, board_instrument.name`,
    [pool],
  );
  const today = new Date().toISOString().slice(0, 10);
  return {
    pool,
    members: members.rows,
    boards: boards.rows,
    attention_count: members.rows.filter((row) =>
      row.attention_reason && (!row.attention_from || row.attention_from <= today) && (!row.attention_until || row.attention_until >= today),
    ).length,
    unclassified_count: members.rows.filter((row) => row.kind === "stock" && row.boards.length === 0).length,
  };
}

export interface PoolChangeInput {
  action: "add" | "update" | "remove";
  code: string;
  pool: PoolKind;
  role?: string;
  grade?: string;
  score?: number;
  tags?: string[];
  stock_character?: string;
  stage?: string;
  evaluation_summary?: string;
  attention_reason?: string | null;
  attention_from?: string | null;
  attention_until?: string | null;
  effective_from: string;
  note?: string;
  evaluation_session_id?: string | null;
}

export interface PoolAttentionInput {
  code: string;
  pool: PoolKind;
  attention_reason: string | null;
  attention_from: string | null;
  attention_until: string | null;
}

function validDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function requiredText(value: string | undefined | null, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} 不能为空；未完成完整评估的标的不允许入池`);
  return normalized;
}

/** 近期关注是当前角色上的短期状态，不生成新的角色历史行。 */
export async function setPoolAttention(
  db: TransactionDb,
  input: PoolAttentionInput,
): Promise<{ before: PoolMemberRow; after: PoolMemberRow }> {
  return inServiceTransaction(db, async (client) => {
    const current = await client.query<PoolMemberRow>(
      `${MEMBER_SELECT}
        WHERE instrument.code = $1 AND membership.pool = $2 AND membership.effective_to IS NULL
        ORDER BY membership.id DESC LIMIT 1 FOR UPDATE OF membership`,
      [input.code, input.pool],
    );
    const before = current.rows[0];
    if (!before) throw new Error(`标的 ${input.code} 不在当前${input.pool === "short" ? "短线" : "长线"}池中`);
    const reason = input.attention_reason?.trim() || null;
    if (input.attention_from && !validDate(input.attention_from)) throw new Error("attention_from 必须是有效日期");
    if (input.attention_until && !validDate(input.attention_until)) throw new Error("attention_until 必须是有效日期");
    if (input.attention_from && input.attention_until && input.attention_until < input.attention_from) {
      throw new Error("attention_until 不得早于 attention_from");
    }
    if (!reason && (input.attention_from || input.attention_until)) throw new Error("清除近期关注时必须同时清除起止日期");
    await client.query(
      `UPDATE pool_membership
          SET attention_reason = $2, attention_from = $3, attention_until = $4
        WHERE id = $1`,
      [before.id, reason, input.attention_from, input.attention_until],
    );
    const after = await client.query<PoolMemberRow>(`${MEMBER_SELECT} WHERE membership.id = $1`, [before.id]);
    return { before, after: after.rows[0]! };
  });
}

/** add/update 均生成完整新角色行；update 可原子完成短线池与长线池之间的角色迁移。 */
export async function applyPoolChange(
  db: TransactionDb,
  input: PoolChangeInput,
): Promise<{ before: PoolMemberRow | null; after: PoolMemberRow | null }> {
  if (!validDate(input.effective_from)) throw new Error("effective_from 必须是有效的 YYYY-MM-DD 日期");
  return inServiceTransaction(db, async (client) => {
    const instrument = await client.query<{ id: string; kind: string }>(
      "SELECT id::text, kind FROM market_instrument WHERE code = $1 FOR UPDATE",
      [input.code],
    );
    if (!instrument.rows[0]) throw new Error(`未知标的代码：${input.code}`);
    const instrumentId = instrument.rows[0].id;
    const current = await client.query<PoolMemberRow>(
      `${MEMBER_SELECT}
        WHERE membership.instrument_id = $1 AND membership.effective_to IS NULL
        ORDER BY membership.id DESC LIMIT 1 FOR UPDATE OF membership`,
      [instrumentId],
    );
    const before = current.rows[0] ?? null;

    if (input.action === "add" && before) throw new Error(`标的 ${input.code} 已有当前角色 ${before.pool}/${before.role}，请用 update`);
    if ((input.action === "update" || input.action === "remove") && !before) throw new Error(`标的 ${input.code} 没有当前策略角色`);
    if (input.action === "remove") {
      await client.query("UPDATE pool_membership SET effective_to = $2 WHERE id = $1", [before!.id, input.effective_from]);
      return { before, after: null };
    }

    const attentionOnly = input.action === "update" && before?.pool === input.pool &&
      [input.role, input.grade, input.score, input.tags, input.stock_character, input.stage,
       input.evaluation_summary, input.note].every((value) => value === undefined) &&
      [input.attention_reason, input.attention_from, input.attention_until].some((value) => value !== undefined);
    if (attentionOnly) {
      return setPoolAttention(client, {
        code: input.code,
        pool: input.pool,
        attention_reason: input.attention_reason === undefined ? before.attention_reason : input.attention_reason,
        attention_from: input.attention_from === undefined ? before.attention_from : input.attention_from,
        attention_until: input.attention_until === undefined ? before.attention_until : input.attention_until,
      });
    }

    const role = requiredText(input.role ?? before?.role, "role");
    const grade = requiredText(input.grade ?? before?.grade, "grade");
    const stockCharacter = requiredText(input.stock_character ?? before?.stock_character, "stock_character");
    const stage = requiredText(input.stage ?? before?.stage, "stage");
    const evaluationSummary = requiredText(input.evaluation_summary ?? before?.evaluation_summary, "evaluation_summary");
    const score = input.score ?? before?.score;
    if (score === null || score === undefined || !Number.isFinite(score)) throw new Error("score 必须是有限数值");
    const tags = (input.tags ?? before?.tags)?.map((tag) => String(tag).trim());
    if (!tags || tags.length === 0 || tags.some((tag) => !tag)) throw new Error("tags 至少包含一个非空标签");
    if (tags.some((tag) => tag.startsWith("板块："))) {
      throw new Error("tags 不再接受“板块：”本地标签；所属行业只读取同花顺官方关系");
    }
    if (instrument.rows[0].kind === "stock") {
      const industry = await client.query(
        `SELECT 1
           FROM market_board_membership relation
           JOIN market_board board ON board.instrument_id = relation.board_instrument_id
          WHERE relation.member_instrument_id = $1 AND relation.effective_to IS NULL
            AND board.active = true AND board.source = 'hithink' AND board.board_type = 'industry'
          LIMIT 1`,
        [instrumentId],
      );
      if (!industry.rows[0]) throw new Error("同花顺官方行业关系尚未同步；当前标的不允许入池");
    }

    const attentionFrom = input.attention_from === undefined ? before?.attention_from ?? null : input.attention_from;
    const attentionUntil = input.attention_until === undefined ? before?.attention_until ?? null : input.attention_until;
    if (attentionFrom && !validDate(attentionFrom)) throw new Error("attention_from 必须是有效日期");
    if (attentionUntil && !validDate(attentionUntil)) throw new Error("attention_until 必须是有效日期");
    if (attentionFrom && attentionUntil && attentionUntil < attentionFrom) throw new Error("attention_until 不得早于 attention_from");

    if (before) await client.query("UPDATE pool_membership SET effective_to = $2 WHERE id = $1", [before.id, input.effective_from]);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO pool_membership
         (instrument_id, pool, role, grade, score, tags, stock_character, stage,
          evaluation_summary, attention_reason,
          attention_from, attention_until, evaluation_session_id, effective_from, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id::text`,
      [
        instrumentId, input.pool, role, grade, score, JSON.stringify(tags), stockCharacter, stage,
        evaluationSummary,
        input.attention_reason === undefined ? before?.attention_reason ?? null : input.attention_reason,
        attentionFrom, attentionUntil, input.evaluation_session_id ?? null,
        input.effective_from, input.note ?? before?.note ?? null,
      ],
    );
    const afterRows = await client.query<PoolMemberRow>(
      `${MEMBER_SELECT} WHERE membership.id = $1`,
      [inserted.rows[0]!.id],
    );
    return { before, after: afterRows.rows[0]! };
  });
}

export async function setPoolBoardOrder(
  db: TransactionDb,
  pool: PoolKind,
  boardCodes: string[],
): Promise<{ pool: PoolKind; board_codes: string[] }> {
  return inServiceTransaction(db, async (client) => {
    const unique = [...new Set(boardCodes)];
    if (unique.length !== boardCodes.length) throw new Error("board_codes 不得重复");
    const boards = unique.length
      ? await client.query<{ id: string; code: string }>(
          `SELECT instrument.id::text, instrument.code FROM market_board board
            JOIN market_instrument instrument ON instrument.id = board.instrument_id
           WHERE board.active = true AND board.source = 'hithink' AND board.board_type = 'industry'
             AND instrument.code LIKE '881%.TI'
             AND instrument.code = ANY($1::text[])`,
          [unique],
        )
      : { rows: [] as Array<{ id: string; code: string }> };
    if (boards.rows.length !== unique.length) throw new Error("board_codes 只能包含已同步的同花顺官方大行业");
    const byCode = new Map(boards.rows.map((row) => [row.code, row.id]));
    await client.query("DELETE FROM pool_board_preference WHERE pool = $1", [pool]);
    for (let index = 0; index < unique.length; index += 1) {
      await client.query(
        "INSERT INTO pool_board_preference (pool, board_instrument_id, sort) VALUES ($1,$2,$3)",
        [pool, byCode.get(unique[index]!)!, index],
      );
    }
    return { pool, board_codes: unique };
  });
}
