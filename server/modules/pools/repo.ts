// 关注池领域：当前成员、股性画像、板块投影、多来源近期关注与展示偏好。
import type pg from "pg";
import { inServiceTransaction, type TransactionDb } from "../../db/transaction.js";
import { closeUnwatchedAutoMembers } from "./attention-lifecycle.js";
import { STOCK_CHARACTER_CALCULATION_VERSION } from "../../indicators/formulas.js";
import { getLatestMarketNews, instrumentNews } from "../market-news/repo.js";

export type Db = Pick<pg.Pool | pg.PoolClient, "query">;
export type PoolKind = "watch";
export const WATCH_POOL: PoolKind = "watch";
export const WATCH_POOL_ROLE = "关注";
export const MANUAL_ATTENTION_SOURCE = "manual";

export interface PoolAttentionSignal {
  status: "qualified" | "approaching";
  missing_signals: string[];
}

export interface PoolAttentionEntry {
  id: string;
  source_type: "manual" | "strategy";
  strategy_code: string | null;
  strategy_name: string | null;
  source_job: string;
  source_evaluation_run_id: string | null;
  last_evaluated_at: string | null;
  data_date: string | null;
  stale_reason: string | null;
  status: "qualified" | "approaching" | "manual";
  reason: string;
  missing_signals: string[];
  valid_from: string;
  valid_until: string | null;
}

export interface PoolMemberRow {
  id: string;
  instrument_id: string;
  pool: PoolKind;
  role: string;
  management_mode: "manual" | "strategy";
  special_attention: boolean;
  tags: string[];
  stock_character: string | null;
  stock_character_profile: Record<string, unknown>;
  stage: string | null;
  evaluation_summary: string | null;
  profile_as_of: string | null;
  profile_calculation_version: string | null;
  profile_input_sha256: string | null;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  attention_entries: PoolAttentionEntry[];
  news: ReturnType<typeof instrumentNews>;
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
  special_count: number;
  unclassified_count: number;
}

/** 只读取当前关注所引用的标的评估快照，不以最新扫描替代来源记录。 */
export async function listPoolResearch(db: Db, code: string, asOf = new Date().toISOString().slice(0, 10)) {
  const result = await db.query(
    `SELECT entry.id::text AS attention_id, entry.strategy_code, strategy.name AS strategy_name,
            entry.reason, entry.status, entry.missing_signals, entry.stale_reason,
            run.id::text AS run_id, run.target_date::text, run.data_date::text,
            run.status AS run_status, run.strategy_runtime_version,
            signal.evidence, signal.trigger_price_lower::float8, signal.trigger_price_upper::float8,
            signal.invalidation
       FROM pool_attention_entry entry
       JOIN market_instrument instrument ON instrument.id=entry.instrument_id
       LEFT JOIN strategy_definition strategy ON strategy.code=entry.strategy_code
       LEFT JOIN strategy_entry_signal signal
         ON signal.run_id=entry.source_evaluation_run_id AND signal.instrument_id=entry.instrument_id
        AND signal.strategy_code=entry.strategy_code
       LEFT JOIN strategy_evaluation_run run ON run.id=signal.run_id AND run.strategy_code=signal.strategy_code
      WHERE instrument.code=$1 AND entry.valid_from <= $2::date
        AND (entry.valid_until IS NULL OR entry.valid_until >= $2::date)
        AND EXISTS (SELECT 1 FROM pool_membership membership
                     WHERE membership.instrument_id=entry.instrument_id AND membership.effective_to IS NULL)
      ORDER BY strategy.name NULLS LAST, entry.id`,
    [code, asOf],
  );
  return result.rows;
}

const MEMBER_SELECT = `SELECT membership.id::text, instrument.id::text AS instrument_id, membership.pool, membership.role, membership.management_mode,
  membership.special_attention,
  membership.tags,
  membership.stock_character, membership.stock_character_profile, membership.stage, membership.evaluation_summary,
  membership.profile_as_of::text, membership.profile_calculation_version, membership.profile_input_sha256,
  membership.effective_from::text, membership.effective_to::text, membership.note,
  COALESCE(attention_list.entries, '[]'::jsonb) AS attention_entries,
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
           'id', entry.id::text, 'source_type', entry.source_type,
           'strategy_code', entry.strategy_code, 'strategy_name', strategy.name,
           'source_job', entry.source_job, 'source_evaluation_run_id', entry.source_evaluation_run_id::text,
           'status', entry.status, 'reason', entry.reason, 'missing_signals', entry.missing_signals,
           'valid_from', entry.valid_from::text, 'valid_until', entry.valid_until::text,
           'last_evaluated_at', entry.last_evaluated_at::text, 'data_date', entry.data_date::text,
           'stale_reason', entry.stale_reason
         ) ORDER BY entry.source_type, COALESCE(strategy.name, entry.source_job)) AS entries
    FROM pool_attention_entry entry
    LEFT JOIN strategy_definition strategy ON strategy.code = entry.strategy_code
   WHERE entry.instrument_id = membership.instrument_id
     AND entry.valid_from <= $2::date
     AND (entry.valid_until IS NULL OR entry.valid_until >= $2::date)
) attention_list ON true
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

/**
 * 当前有效池成员的可见条件：人工管理、特别关注或仍有未过期关注来源。
 * 列表、行业投影和按需行情必须共用同一口径，避免页面展示与实时取数范围不一致。
 * 参数固定为 $1=池、$2=基准日。
 */
export const POOL_MEMBER_VISIBLE_SQL = `membership.pool = $1 AND membership.effective_to IS NULL
      AND (membership.management_mode='manual' OR membership.special_attention OR EXISTS (
        SELECT 1 FROM pool_attention_entry active WHERE active.instrument_id=membership.instrument_id
          AND (active.source_type='manual' OR (active.valid_from<=$2::date
            AND (active.valid_until IS NULL OR active.valid_until>=$2::date)))))`;

export async function listPoolView(db: Db, asOf?: string): Promise<PoolViewData> {
  const asOfDate = asOf ?? new Date().toISOString().slice(0, 10);
  const members = await db.query<PoolMemberRow>(
    `${MEMBER_SELECT}
      WHERE ${POOL_MEMBER_VISIBLE_SQL}
      ORDER BY instrument.code`,
    [WATCH_POOL, asOfDate],
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
      WHERE ${POOL_MEMBER_VISIBLE_SQL}
        AND board_instrument.code LIKE '881%.TI'
      GROUP BY board_instrument.id, board.instrument_id, preference.sort,
               latest_close.close, latest_close.prev_close, latest_close.bar_date
      ORDER BY preference.sort NULLS LAST, count(DISTINCT membership.id) DESC, board_instrument.name`,
    [WATCH_POOL, asOfDate],
  );
  const news = await getLatestMarketNews(db, asOf);
  const enrichedMembers = members.rows.map((row) => ({ ...row, news: instrumentNews(news, row.code) }));
  return {
    pool: WATCH_POOL,
    members: enrichedMembers,
    boards: boards.rows,
    attention_count: enrichedMembers.filter((row) => row.attention_entries.length > 0).length,
    special_count: enrichedMembers.filter((row) => row.special_attention).length,
    unclassified_count: enrichedMembers.filter((row) => row.kind === "stock" && row.boards.length === 0).length,
  };
}

/** 特别关注由用户在池页面逐只标记：不随每日计划对账清退，仅用户手动取消。 */
export async function setPoolSpecialAttention(
  db: TransactionDb,
  input: { code: string; special: boolean },
): Promise<{ code: string; special_attention: boolean }> {
  return inServiceTransaction(db, async (client) => {
    const instrument = await client.query<{ id: string }>(
      "SELECT id::text FROM market_instrument WHERE code = $1",
      [input.code],
    );
    if (!instrument.rows[0]) throw new Error(`未知标的代码：${input.code}`);
    const membership = await client.query<{ id: string }>(
      `SELECT id::text FROM pool_membership
        WHERE instrument_id = $1 AND pool = $2 AND effective_to IS NULL FOR UPDATE`,
      [instrument.rows[0].id, WATCH_POOL],
    );
    if (!membership.rows[0]) throw new Error(`标的 ${input.code} 不在关注池中`);
    await client.query(
      "UPDATE pool_membership SET special_attention=$2 WHERE id=$1",
      [membership.rows[0].id, input.special],
    );
    return { code: input.code, special_attention: input.special };
  });
}

/** 策略复核包含过期存量，避免界面隐藏后 Agent 无法取全复核集合。 */
export async function listStrategyAttentionReviewEntries(db: Db) {
  return (await db.query(`SELECT instrument.code,instrument.name,entry.strategy_code,entry.status,entry.reason,
      entry.data_date::text,entry.valid_from::text,entry.valid_until::text,entry.missing_signals,entry.stale_reason
    FROM pool_attention_entry entry JOIN market_instrument instrument ON instrument.id=entry.instrument_id
    WHERE entry.source_type='strategy' ORDER BY entry.strategy_code,instrument.code`)).rows;
}

export interface PoolChangeInput {
  action: "add" | "update" | "remove";
  code: string;
  pool: PoolKind;
  role?: string;
  tags?: string[];
  stock_character?: string;
  stock_character_profile?: Record<string, unknown>;
  stage?: string;
  evaluation_summary?: string;
  profile_as_of?: string;
  profile_calculation_version?: string;
  profile_input_sha256?: string;
  effective_from: string;
  note?: string;
  evaluation_session_id?: string | null;
}

export interface PoolAttentionEntryInput {
  code: string;
  source_job: string;
  strategy_code?: string | null;
  source_evaluation_run_id?: string | null;
  data_date?: string | null;
  stale_reason?: string | null;
  status: "qualified" | "approaching" | "manual";
  reason: string | null;
  missing_signals?: string[];
  valid_from?: string;
  valid_until?: string | null;
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

function validateEntryInput(input: PoolAttentionEntryInput): { reason: string; missing: string[]; from: string; until: string | null } {
  const reason = input.reason?.trim() ?? "";
  const missing = input.missing_signals ?? [];
  if (!reason) {
    if (missing.length) throw new Error("清除关注条目时不得携带缺失条件");
    return { reason: "", missing: [], from: "", until: null };
  }
  if (reason.length > 500) throw new Error("关注原因不得超过 500 字");
  if (!["qualified", "approaching", "manual"].includes(input.status)) throw new Error("关注状态无效");
  if (input.status !== "approaching" && missing.length) {
    throw new Error("只有待补信号状态可以携带缺失条件");
  }
  if (input.status === "approaching" && !missing.length) {
    throw new Error("待补信号状态必须逐项列出缺失条件");
  }
  if (missing.length > 20 || missing.some((item) => typeof item !== "string" || !item.trim() || item.length > 200)) {
    throw new Error("缺失条件列表无效");
  }
  const from = input.valid_from ?? new Date().toISOString().slice(0, 10);
  if (!validDate(from)) throw new Error("valid_from 必须是有效日期");
  const until = input.valid_until ?? null;
  if (until && !validDate(until)) throw new Error("valid_until 必须是有效日期");
  if (until && until < from) throw new Error("valid_until 不得早于 valid_from");
  return { reason, missing, from, until };
}

/** 关注条目按人工或策略身份独立维护；任务来源只作审计。 */
export async function setPoolAttentionEntry(
  db: TransactionDb,
  input: PoolAttentionEntryInput,
): Promise<{ before: PoolAttentionEntry | null; after: PoolAttentionEntry | null }> {
  return inServiceTransaction(db, async (client) => {
    const instrument = await client.query<{ id: string }>(
      "SELECT id::text FROM market_instrument WHERE code = $1",
      [input.code],
    );
    if (!instrument.rows[0]) throw new Error(`未知标的代码：${input.code}`);
    const membership = await client.query<{ id: string }>(
      `SELECT id::text FROM pool_membership
        WHERE instrument_id = $1 AND pool = $2 AND effective_to IS NULL FOR UPDATE`,
      [instrument.rows[0].id, WATCH_POOL],
    );
    if (!membership.rows[0]) throw new Error(`标的 ${input.code} 不在关注池中`);
    const manual = input.source_job === MANUAL_ATTENTION_SOURCE || input.status === "manual";
    let strategyCode: string | null = input.strategy_code ?? null;
    if (!manual && !strategyCode) {
      if (input.source_job === "daily_plan_flow") strategyCode = "swing";
      else {
        strategyCode = (await client.query<{ strategy_code: string | null }>(
          "SELECT strategy_code FROM job_definition WHERE code = $1",
          [input.source_job],
        )).rows[0]?.strategy_code ?? null;
      }
    }
    if (!manual && !strategyCode) throw new Error("自动关注必须关联运行时策略");
    const current = await client.query<PoolAttentionEntry>(
      `SELECT entry.id::text, entry.source_type, entry.strategy_code, strategy.name AS strategy_name,
              entry.source_job, entry.source_evaluation_run_id::text, entry.status, entry.reason,
              entry.missing_signals, entry.valid_from::text, entry.valid_until::text,
              entry.last_evaluated_at::text, entry.data_date::text, entry.stale_reason
         FROM pool_attention_entry entry
         LEFT JOIN strategy_definition strategy ON strategy.code = entry.strategy_code
        WHERE entry.instrument_id = $1
          AND (($2::boolean AND entry.source_type = 'manual')
               OR (NOT $2::boolean AND entry.source_type = 'strategy' AND entry.strategy_code = $3))`,
      [instrument.rows[0].id, manual, strategyCode],
    );
    const before = current.rows[0] ?? null;
    const parsed = validateEntryInput(input);
    if (!parsed.reason) {
      if (before) await client.query("DELETE FROM pool_attention_entry WHERE id = $1", [before.id]);
      return { before, after: null };
    }
    if (before) {
      await client.query(
        `UPDATE pool_attention_entry SET source_job=$2, status=$3, reason=$4, missing_signals=$5::jsonb,
                valid_from=$6, valid_until=$7, source_evaluation_run_id=$8, data_date=$9,
                stale_reason=$10, last_evaluated_at=CASE WHEN source_type='strategy' THEN now() ELSE NULL END,
                updated_at=now() WHERE id=$1`,
        [before.id, input.source_job, input.status, parsed.reason, JSON.stringify(parsed.missing), parsed.from,
         parsed.until, input.source_evaluation_run_id ?? null, input.data_date ?? null, input.stale_reason ?? null],
      );
    } else {
      await client.query(
        `INSERT INTO pool_attention_entry
           (instrument_id, source_type, strategy_code, source_job, source_evaluation_run_id, status,
            reason, missing_signals, valid_from, valid_until, last_evaluated_at, data_date, stale_reason, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,CASE WHEN $2='strategy' THEN now() ELSE NULL END,$11,$12,now())`,
        [instrument.rows[0].id, manual ? "manual" : "strategy", manual ? null : strategyCode,
         input.source_job, input.source_evaluation_run_id ?? null, input.status, parsed.reason,
         JSON.stringify(parsed.missing), parsed.from, parsed.until, input.data_date ?? null, input.stale_reason ?? null],
      );
    }
    const afterRows = await client.query<PoolAttentionEntry>(
      `SELECT entry.id::text, entry.source_type, entry.strategy_code, strategy.name AS strategy_name,
              entry.source_job, entry.source_evaluation_run_id::text, entry.status, entry.reason,
              entry.missing_signals, entry.valid_from::text, entry.valid_until::text,
              entry.last_evaluated_at::text, entry.data_date::text, entry.stale_reason
         FROM pool_attention_entry entry LEFT JOIN strategy_definition strategy ON strategy.code=entry.strategy_code
        WHERE entry.instrument_id=$1 AND (($2::boolean AND entry.source_type='manual')
          OR (NOT $2::boolean AND entry.source_type='strategy' AND entry.strategy_code=$3))`,
      [instrument.rows[0].id, manual, strategyCode],
    );
    return { before, after: afterRows.rows[0] ?? null };
  });
}

export async function ensureStrategyPoolMemberProfile(
  db: TransactionDb,
  input: { code: string; effective_from: string; strategy_name: string },
): Promise<"created" | "repaired" | "existing"> {
  if (!validDate(input.effective_from)) throw new Error("effective_from 必须是有效的 YYYY-MM-DD 日期");
  return inServiceTransaction(db, async (client) => {
    const profile = await client.query<{
      instrument_id: string; as_of_date: string; calculation_version: string; input_sha256: string;
      stock_character_profile: Record<string, unknown>; stage: string; stock_character: string; tags: string[];
    }>(
      `SELECT instrument.id::text AS instrument_id,metric.as_of_date::text,metric.calculation_version,run.input_sha256,
              metric.stock_character_profile,metric.stage,metric.stock_character,metric.tags
         FROM market_instrument instrument
         JOIN market_stock_character_metric metric ON metric.instrument_id=instrument.id
         JOIN market_indicator_run run ON run.id=metric.indicator_run_id
        WHERE instrument.code=$1 AND metric.as_of_date <= $2::date
          AND metric.calculation_version=$3 AND metric.input_row_count >= 120 AND run.status='success'
          AND btrim(metric.stage) <> '' AND btrim(metric.stock_character) <> ''
        ORDER BY metric.as_of_date DESC,metric.computed_at DESC LIMIT 1`,
      [input.code, input.effective_from, STOCK_CHARACTER_CALCULATION_VERSION],
    );
    const currentProfile = profile.rows[0];
    if (!currentProfile) throw new Error(`标的 ${input.code} 缺少截至 ${input.effective_from} 的完整五维画像，不能自动入池`);
    const tags = [...new Set([...currentProfile.tags, "策略自动关注"])];
    const summary = `${input.strategy_name}自动关注；画像数据截至${currentProfile.as_of_date}`;
    const current = await client.query<{ id: string; stock_character: string | null; stage: string | null; profile_as_of: string | null }>(
      `SELECT id::text,stock_character,stage,profile_as_of::text
         FROM pool_membership WHERE instrument_id=$1 AND effective_to IS NULL
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [currentProfile.instrument_id],
    );
    if (current.rows[0]) {
      if (current.rows[0].stock_character && current.rows[0].stage && current.rows[0].profile_as_of) return "existing";
      await client.query(
        `UPDATE pool_membership SET tags=CASE WHEN management_mode='strategy' THEN $2::jsonb ELSE $2::jsonb - '策略自动关注' END,stock_character=$3,stock_character_profile=$4::jsonb,stage=$5,
                evaluation_summary=$6,profile_as_of=$7,profile_calculation_version=$8,profile_input_sha256=$9,
                note=CASE WHEN management_mode='strategy' THEN '由策略信号自动入池并采用最新五维画像' ELSE note END
          WHERE id=$1`,
        [current.rows[0].id, JSON.stringify(tags), currentProfile.stock_character,
         JSON.stringify(currentProfile.stock_character_profile), currentProfile.stage, summary, currentProfile.as_of_date,
         currentProfile.calculation_version, currentProfile.input_sha256],
      );
      return "repaired";
    }
    await client.query(
      `INSERT INTO pool_membership
         (instrument_id,pool,role,tags,stock_character,stock_character_profile,stage,evaluation_summary,
          profile_as_of,profile_calculation_version,profile_input_sha256,effective_from,note,management_mode)
       VALUES ($1,'watch','关注',$2::jsonb,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,'由策略信号自动入池并采用最新五维画像','strategy')
       ON CONFLICT (instrument_id,pool,effective_from) DO UPDATE SET
         effective_to=NULL,exit_reason=NULL,tags=EXCLUDED.tags,stock_character=EXCLUDED.stock_character,
         stock_character_profile=EXCLUDED.stock_character_profile,stage=EXCLUDED.stage,
         evaluation_summary=EXCLUDED.evaluation_summary,profile_as_of=EXCLUDED.profile_as_of,
         profile_calculation_version=EXCLUDED.profile_calculation_version,profile_input_sha256=EXCLUDED.profile_input_sha256`,
      [currentProfile.instrument_id, JSON.stringify(tags), currentProfile.stock_character,
       JSON.stringify(currentProfile.stock_character_profile), currentProfile.stage, summary, currentProfile.as_of_date,
       currentProfile.calculation_version, currentProfile.input_sha256, input.effective_from],
    );
    return "created";
  });
}

/** 用户从池页面移除指定策略来源；未指定策略时只清人工关注。 */
export async function clearPoolAttention(
  db: TransactionDb,
  input: { code: string; strategy_code?: string },
): Promise<{ before: PoolAttentionEntry | null; after: PoolAttentionEntry | null } | null> {
  return inServiceTransaction(db, async (client) => {
    const instrument = await client.query<{ id: string }>(
      "SELECT id::text FROM market_instrument WHERE code = $1",
      [input.code],
    );
    if (!instrument.rows[0]) return null;
    const strategyCode = input.strategy_code ?? null;
    const current = await client.query<PoolAttentionEntry>(
      `SELECT entry.id::text, entry.source_type, entry.strategy_code, strategy.name AS strategy_name,
              entry.source_job, entry.source_evaluation_run_id::text, entry.status, entry.reason,
              entry.missing_signals, entry.valid_from::text, entry.valid_until::text,
              entry.last_evaluated_at::text, entry.data_date::text, entry.stale_reason
         FROM pool_attention_entry entry LEFT JOIN strategy_definition strategy ON strategy.code=entry.strategy_code
        WHERE entry.instrument_id=$1 AND (($2::text IS NULL AND entry.source_type='manual')
          OR ($2::text IS NOT NULL AND entry.source_type='strategy' AND entry.strategy_code=$2))`,
      [instrument.rows[0].id, strategyCode],
    );
    if (!current.rows[0]) return null;
    await client.query("DELETE FROM pool_attention_entry WHERE id = $1", [current.rows[0].id]);
    await closeUnwatchedAutoMembers(client, new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }), [input.code]);
    return { before: current.rows[0], after: null };
  });
}

/** 跨日入池变化保留历史；同日重新初始化原地刷新当前行。 */
export async function applyPoolChange(
  db: TransactionDb,
  input: PoolChangeInput,
): Promise<{ before: PoolMemberRow | null; after: PoolMemberRow | null }> {
  if (!validDate(input.effective_from)) throw new Error("effective_from 必须是有效的 YYYY-MM-DD 日期");
  if (input.pool !== WATCH_POOL) throw new Error("系统当前只有单一关注池（watch）");
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
      [instrumentId, input.effective_from],
    );
    const before = current.rows[0] ?? null;

    if (input.action === "add" && before) throw new Error(`标的 ${input.code} 已在关注池中（角色 ${before.role}），请用 update`);
    if ((input.action === "update" || input.action === "remove") && !before) throw new Error(`标的 ${input.code} 没有当前策略角色`);
    if (input.action === "remove") {
      await client.query("UPDATE pool_membership SET effective_to = $2,exit_reason='人工移出关注池' WHERE id = $1", [before!.id, input.effective_from]);
      await client.query("DELETE FROM pool_attention_entry WHERE instrument_id=$1", [instrumentId]);
      return { before, after: null };
    }

    const role = requiredText(input.role ?? before?.role ?? WATCH_POOL_ROLE, "role");
    if (role !== WATCH_POOL_ROLE) throw new Error(`池统一后入池角色固定为“${WATCH_POOL_ROLE}”`);
    const stockCharacter = requiredText(input.stock_character ?? before?.stock_character, "stock_character");
    const stage = requiredText(input.stage ?? before?.stage, "stage");
    const evaluationSummary = requiredText(input.evaluation_summary ?? before?.evaluation_summary, "evaluation_summary");
    const stockCharacterProfile = input.stock_character_profile ?? before?.stock_character_profile ?? {};
    const profileAsOf = input.profile_as_of ?? before?.profile_as_of ?? null;
    const profileCalculationVersion = input.profile_calculation_version ?? before?.profile_calculation_version ?? null;
    const profileInputSha256 = input.profile_input_sha256 ?? before?.profile_input_sha256 ?? null;
    if (profileAsOf && !validDate(profileAsOf)) throw new Error("profile_as_of 必须是有效日期");
    if (profileInputSha256 && !/^[a-f0-9]{64}$/.test(profileInputSha256)) throw new Error("profile_input_sha256 非法");
    const tags = (input.tags ?? before?.tags)?.map((tag) => String(tag).trim());
    if (!tags || tags.length === 0 || tags.some((tag) => !tag)) throw new Error("tags 至少包含一个非空标签");
    if (tags.some((tag) => tag.startsWith("板块："))) {
      throw new Error("tags 不再接受“板块：”本地标签；所属行业只读取同花顺官方关系");
    }
    if (tags.some((tag) => tag.startsWith("评分：") || tag.startsWith("分级："))) {
      throw new Error("标的评分机制已退役，tags 不再接受评分或分级标签");
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

    const values = [
      input.pool, role, JSON.stringify(tags), stockCharacter,
      JSON.stringify(stockCharacterProfile), stage, evaluationSummary,
      profileAsOf, profileCalculationVersion, profileInputSha256,
      input.evaluation_session_id ?? null,
      input.effective_from, input.note ?? before?.note ?? null,
    ];
    // 同一生效日再次初始化属于当日档案刷新，原行更新可避免唯一键冲突和零时长历史。
    if (before?.effective_from === input.effective_from) {
      await client.query(
        `UPDATE pool_membership SET
           pool=$2, role=$3, tags=$4, stock_character=$5,
           stock_character_profile=$6, stage=$7, evaluation_summary=$8, profile_as_of=$9,
           profile_calculation_version=$10, profile_input_sha256=$11, evaluation_session_id=$12,
           note=$13, management_mode='manual'
         WHERE id=$1`,
        // values 中的 effective_from 只用于新建历史行，同日刷新时不在 UPDATE 列中。
        [before.id, ...values.slice(0, 11), values[12]],
      );
      const afterRows = await client.query<PoolMemberRow>(`${MEMBER_SELECT} WHERE membership.id = $1`, [before.id, input.effective_from]);
      return { before, after: afterRows.rows[0]! };
    }

    if (before) await client.query("UPDATE pool_membership SET effective_to = $2 WHERE id = $1", [before.id, input.effective_from]);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO pool_membership
         (instrument_id, pool, role, tags, stock_character, stock_character_profile, stage,
          evaluation_summary, profile_as_of, profile_calculation_version, profile_input_sha256,
          evaluation_session_id, effective_from, note, special_attention)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id::text`,
      [...[instrumentId, ...values], before?.special_attention ?? false],
    );
    const afterRows = await client.query<PoolMemberRow>(
      `${MEMBER_SELECT} WHERE membership.id = $1`,
      [inserted.rows[0]!.id, input.effective_from],
    );
    return { before, after: afterRows.rows[0]! };
  });
}

export async function setPoolBoardOrder(
  db: TransactionDb,
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
    await client.query("DELETE FROM pool_board_preference WHERE pool = $1", [WATCH_POOL]);
    for (let index = 0; index < unique.length; index += 1) {
      await client.query(
        "INSERT INTO pool_board_preference (pool, board_instrument_id, sort) VALUES ($1,$2,$3)",
        [WATCH_POOL, byCode.get(unique[index]!)!, index],
      );
    }
    return { pool: WATCH_POOL, board_codes: unique };
  });
}
