// 超短关注池与竞价采样的唯一读写入口；业务写入必须经过这里，避免各节点各写一套 SQL。
import { inServiceTransaction, type TransactionDb } from "../../db/transaction.js";
import type {
  AuctionJudgement,
  AuctionSampleInput,
  Db,
  IntradayStatus,
  ReviewStatus,
  RiskLevel,
  UltraShortPriority,
  UltraShortWatchlistRow,
  WatchlistDraft,
} from "./types.js";

const WATCHLIST_COLUMNS = `
  id::text, target_date::text, data_date::text, code, name, sources, tags, resonance,
  priority, priority_reason, stage, streak_count, t_facts, key_levels, auction_expect,
  intraday_plan, risk, review_status, risk_level, risk_flags, review_note, review_sources,
  auction_branch, auction_fill_tier, auction_priority, auction_metrics, queue_window,
  auction_note, auction_status, intraday_status, trigger_type, trigger_at::text,
  trigger_price::float8 AS trigger_price, trigger_reason, intraday_note, reminder_at::text,
  reminder_type, reminder_status, reminder_note, data_status, gaps,
  entry_price::float8 AS entry_price, position_opened_at::text, exit_status, exit_stage,
  exit_reason, exit_price::float8 AS exit_price, exit_at::text, realized_r::float8 AS realized_r,
  exit_reminder_at::text, exit_reminder_type, updated_at::text`;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeRow(row: Record<string, unknown>): UltraShortWatchlistRow {
  return {
    id: String(row.id),
    target_date: String(row.target_date),
    data_date: String(row.data_date),
    code: String(row.code),
    name: String(row.name),
    sources: Array.isArray(row.sources) ? row.sources.map(String) : [],
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    resonance: Boolean(row.resonance),
    priority: row.priority as UltraShortPriority,
    priority_reason: String(row.priority_reason ?? ""),
    stage: row.stage === null || row.stage === undefined ? null : String(row.stage),
    streak_count: row.streak_count === null || row.streak_count === undefined ? null : Number(row.streak_count),
    t_facts: asRecord(row.t_facts),
    key_levels: asRecord(row.key_levels),
    auction_expect: asRecord(row.auction_expect),
    intraday_plan: asRecord(row.intraday_plan),
    risk: asRecord(row.risk),
    review_status: row.review_status as ReviewStatus,
    risk_level: row.risk_level as RiskLevel,
    risk_flags: Array.isArray(row.risk_flags) ? row.risk_flags.map(String) : [],
    review_note: row.review_note === null || row.review_note === undefined ? null : String(row.review_note),
    review_sources: Array.isArray(row.review_sources) ? row.review_sources : [],
    auction_branch: (row.auction_branch as UltraShortWatchlistRow["auction_branch"]) ?? null,
    auction_fill_tier: (row.auction_fill_tier as UltraShortWatchlistRow["auction_fill_tier"]) ?? null,
    auction_priority: (row.auction_priority as UltraShortPriority | null) ?? null,
    auction_metrics: asRecord(row.auction_metrics),
    queue_window: asRecord(row.queue_window),
    auction_note: row.auction_note === null || row.auction_note === undefined ? null : String(row.auction_note),
    auction_status: String(row.auction_status ?? "pending"),
    intraday_status: row.intraday_status as IntradayStatus,
    trigger_type: (row.trigger_type as UltraShortWatchlistRow["trigger_type"]) ?? null,
    trigger_at: row.trigger_at === null || row.trigger_at === undefined ? null : String(row.trigger_at),
    trigger_price: row.trigger_price === null || row.trigger_price === undefined ? null : Number(row.trigger_price),
    trigger_reason: row.trigger_reason === null || row.trigger_reason === undefined ? null : String(row.trigger_reason),
    intraday_note: row.intraday_note === null || row.intraday_note === undefined ? null : String(row.intraday_note),
    reminder_at: row.reminder_at === null || row.reminder_at === undefined ? null : String(row.reminder_at),
    reminder_type: row.reminder_type === null || row.reminder_type === undefined ? null : String(row.reminder_type),
    reminder_status: row.reminder_status === null || row.reminder_status === undefined ? null : String(row.reminder_status),
    reminder_note: row.reminder_note === null || row.reminder_note === undefined ? null : String(row.reminder_note),
    gaps: Array.isArray(row.gaps) ? row.gaps : [],
    data_status: row.data_status as UltraShortWatchlistRow["data_status"],
    entry_price: row.entry_price === null || row.entry_price === undefined ? null : Number(row.entry_price),
    position_opened_at: row.position_opened_at === null || row.position_opened_at === undefined ? null : String(row.position_opened_at),
    exit_status: (row.exit_status as UltraShortWatchlistRow["exit_status"]) ?? "none",
    exit_stage: row.exit_stage === null || row.exit_stage === undefined ? 0 : Number(row.exit_stage),
    exit_reason: (row.exit_reason as UltraShortWatchlistRow["exit_reason"]) ?? null,
    exit_price: row.exit_price === null || row.exit_price === undefined ? null : Number(row.exit_price),
    exit_at: row.exit_at === null || row.exit_at === undefined ? null : String(row.exit_at),
    realized_r: row.realized_r === null || row.realized_r === undefined ? null : Number(row.realized_r),
    exit_reminder_at: row.exit_reminder_at === null || row.exit_reminder_at === undefined ? null : String(row.exit_reminder_at),
    exit_reminder_type: row.exit_reminder_type === null || row.exit_reminder_type === undefined ? null : String(row.exit_reminder_type),
    updated_at: String(row.updated_at),
  };
}

export async function listWatchlist(db: Db, targetDate: string): Promise<UltraShortWatchlistRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${WATCHLIST_COLUMNS} FROM ultra_short_watchlist
      WHERE target_date = $1::date
      ORDER BY CASE priority WHEN 'P1' THEN 0 WHEN 'P2' THEN 1 ELSE 2 END,
               code`,
    [targetDate],
  );
  return rows.rows.map(normalizeRow);
}

export async function getWatchlistRow(
  db: Db,
  targetDate: string,
  code: string,
): Promise<UltraShortWatchlistRow | null> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${WATCHLIST_COLUMNS} FROM ultra_short_watchlist WHERE target_date = $1::date AND code = $2`,
    [targetDate, code],
  );
  return rows.rows[0] ? normalizeRow(rows.rows[0]) : null;
}

/**
 * 03 重建关注池：同一 target_date 的旧行被覆盖，未再入选的代码删除。
 * 竞价与盘中字段一并重置，避免旧判定残留到新一天。
 */
export async function replaceWatchlist(
  db: TransactionDb,
  targetDate: string,
  dataDate: string,
  rows: WatchlistDraft[],
): Promise<number> {
  return inServiceTransaction(db, async (client) => {
    for (const row of rows) {
      await client.query(
        `INSERT INTO ultra_short_watchlist
          (target_date, data_date, code, name, sources, tags, resonance, priority, priority_reason,
           stage, streak_count, t_facts, key_levels, auction_expect, intraday_plan, risk,
           review_status, risk_level, risk_flags, review_note, data_status, gaps)
         VALUES ($1::date,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,
                 $15::jsonb,$16::jsonb,$17,$18,$19,$20,$21,$22::jsonb)
         ON CONFLICT (target_date, code) DO UPDATE SET
           data_date = EXCLUDED.data_date,
           name = EXCLUDED.name,
           sources = EXCLUDED.sources,
           tags = EXCLUDED.tags,
           resonance = EXCLUDED.resonance,
           priority = EXCLUDED.priority,
           priority_reason = EXCLUDED.priority_reason,
           stage = EXCLUDED.stage,
           streak_count = EXCLUDED.streak_count,
           t_facts = EXCLUDED.t_facts,
           key_levels = EXCLUDED.key_levels,
           auction_expect = EXCLUDED.auction_expect,
           intraday_plan = EXCLUDED.intraday_plan,
           risk = EXCLUDED.risk,
           review_status = EXCLUDED.review_status,
           risk_level = EXCLUDED.risk_level,
           risk_flags = EXCLUDED.risk_flags,
           review_note = EXCLUDED.review_note,
           data_status = EXCLUDED.data_status,
           gaps = EXCLUDED.gaps,
           auction_branch = NULL, auction_fill_tier = NULL, auction_priority = NULL,
           auction_metrics = '{}'::jsonb, queue_window = '{}'::jsonb, auction_note = NULL,
           auction_status = 'pending', intraday_status = 'waiting', trigger_type = NULL,
           trigger_at = NULL, trigger_price = NULL, trigger_reason = NULL, intraday_note = NULL,
           reminder_at = NULL, reminder_type = NULL, reminder_status = NULL, reminder_note = NULL,
           entry_price = NULL, position_opened_at = NULL, exit_status = 'none', exit_stage = 0,
           exit_reason = NULL, exit_price = NULL, exit_at = NULL, realized_r = NULL,
           exit_reminder_at = NULL, exit_reminder_type = NULL,
           updated_at = now()`,
        [
          targetDate,
          dataDate,
          row.code,
          row.name,
          row.sources,
          row.tags,
          row.resonance,
          row.priority,
          row.priority_reason,
          row.stage,
          row.streak_count,
          JSON.stringify(row.t_facts),
          JSON.stringify(row.key_levels),
          JSON.stringify(row.auction_expect),
          JSON.stringify(row.intraday_plan),
          JSON.stringify(row.risk),
          row.review_status,
          row.risk_level,
          row.risk_flags,
          row.review_note,
          row.data_status ?? "ready",
          JSON.stringify(row.gaps ?? []),
        ],
      );
    }
    await client.query(
      "DELETE FROM ultra_short_watchlist WHERE target_date = $1::date AND NOT (code = ANY($2::text[]))",
      [targetDate, rows.map((row) => row.code)],
    );
    return rows.length;
  });
}

export type WatchlistPatch = Partial<{
  priority: UltraShortPriority;
  review_status: ReviewStatus;
  risk_level: RiskLevel;
  risk_flags: string[];
  review_note: string | null;
  review_sources: unknown[];
  auction_branch: UltraShortWatchlistRow["auction_branch"];
  auction_fill_tier: UltraShortWatchlistRow["auction_fill_tier"];
  auction_priority: UltraShortPriority | null;
  auction_metrics: Record<string, unknown>;
  queue_window: Record<string, unknown>;
  auction_note: string | null;
  auction_status: string;
  intraday_status: IntradayStatus;
  trigger_type: string | null;
  trigger_at: Date | string | null;
  trigger_price: number | null;
  trigger_reason: string | null;
  intraday_note: string | null;
  reminder_at: Date | string | null;
  reminder_type: string | null;
  reminder_status: string | null;
  reminder_note: string | null;
  data_status: UltraShortWatchlistRow["data_status"];
  gaps: unknown[];
  entry_price: number | null;
  position_opened_at: Date | string | null;
  exit_status: UltraShortWatchlistRow["exit_status"];
  exit_stage: number;
  exit_reason: UltraShortWatchlistRow["exit_reason"];
  exit_price: number | null;
  exit_at: Date | string | null;
  realized_r: number | null;
  exit_reminder_at: Date | string | null;
  exit_reminder_type: string | null;
}>;

const PATCH_COLUMNS: Record<keyof WatchlistPatch, string> = {
  priority: "priority",
  review_status: "review_status",
  risk_level: "risk_level",
  risk_flags: "risk_flags",
  review_note: "review_note",
  review_sources: "review_sources",
  auction_branch: "auction_branch",
  auction_fill_tier: "auction_fill_tier",
  auction_priority: "auction_priority",
  auction_metrics: "auction_metrics",
  queue_window: "queue_window",
  auction_note: "auction_note",
  auction_status: "auction_status",
  intraday_status: "intraday_status",
  trigger_type: "trigger_type",
  trigger_at: "trigger_at",
  trigger_price: "trigger_price",
  trigger_reason: "trigger_reason",
  intraday_note: "intraday_note",
  reminder_at: "reminder_at",
  reminder_type: "reminder_type",
  reminder_status: "reminder_status",
  reminder_note: "reminder_note",
  data_status: "data_status",
  gaps: "gaps",
  entry_price: "entry_price",
  position_opened_at: "position_opened_at",
  exit_status: "exit_status",
  exit_stage: "exit_stage",
  exit_reason: "exit_reason",
  exit_price: "exit_price",
  exit_at: "exit_at",
  realized_r: "realized_r",
  exit_reminder_at: "exit_reminder_at",
  exit_reminder_type: "exit_reminder_type",
};

const JSON_COLUMNS = new Set(["review_sources", "auction_metrics", "queue_window", "gaps"]);
const ARRAY_COLUMNS = new Set(["risk_flags"]);

/** 关注池字段更新：只接受白名单列，jsonb 与数组自动序列化。 */
export async function updateWatchlist(
  db: Db,
  targetDate: string,
  code: string,
  patch: WatchlistPatch,
): Promise<void> {
  const entries = Object.entries(patch).filter(([key]) => key in PATCH_COLUMNS) as Array<[keyof WatchlistPatch, unknown]>;
  if (entries.length === 0) return;
  const values: unknown[] = [targetDate, code];
  const assignments: string[] = [];
  for (const [key, value] of entries) {
    const column = PATCH_COLUMNS[key];
    values.push(JSON_COLUMNS.has(key) && value !== null && value !== undefined
      ? JSON.stringify(value)
      : ARRAY_COLUMNS.has(key) && value !== null && value !== undefined ? value : value);
    const placeholder = `$${values.length}`;
    assignments.push(JSON_COLUMNS.has(key) ? `${column}=${placeholder}::jsonb` : `${column}=${placeholder}`);
  }
  await db.query(
    `UPDATE ultra_short_watchlist SET ${assignments.join(", ")}, updated_at=now()
      WHERE target_date=$1::date AND code=$2`,
    values,
  );
}


/** 竞价判定回写；不改变 03 的 priority。 */
export async function saveAuctionJudgement(
  db: Db,
  targetDate: string,
  code: string,
  judgement: AuctionJudgement,
  extra: WatchlistPatch = {},
): Promise<void> {
  await updateWatchlist(db, targetDate, code, {
    auction_branch: judgement.branch,
    auction_fill_tier: judgement.fill_tier,
    auction_priority: judgement.priority,
    auction_metrics: judgement.metrics,
    queue_window: judgement.queue_window,
    auction_note: judgement.note,
    auction_status: judgement.status,
    ...extra,
  });
}

export async function insertAuctionSamples(
  db: TransactionDb,
  tradeDate: string,
  samples: AuctionSampleInput[],
): Promise<number> {
  if (samples.length === 0) return 0;
  return inServiceTransaction(db, async (client) => {
    for (const sample of samples) {
      await client.query(
        `INSERT INTO auction_intraday_sample
          (trade_date, sample_at, stage, code, auction_price, auction_pct, auction_unmatched,
           auction_volume, auction_amount, auction_turnover_pct, auction_volume_ratio,
           auction_yesterday_ratio_pct, float_market_cap, unmatched_ratio, source_at, data_status)
         VALUES ($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (trade_date, code, stage, sample_at) DO UPDATE SET
           auction_price=EXCLUDED.auction_price, auction_pct=EXCLUDED.auction_pct,
           auction_unmatched=EXCLUDED.auction_unmatched, auction_volume=EXCLUDED.auction_volume,
           auction_amount=EXCLUDED.auction_amount, auction_turnover_pct=EXCLUDED.auction_turnover_pct,
           auction_volume_ratio=EXCLUDED.auction_volume_ratio,
           auction_yesterday_ratio_pct=EXCLUDED.auction_yesterday_ratio_pct,
           float_market_cap=EXCLUDED.float_market_cap, unmatched_ratio=EXCLUDED.unmatched_ratio,
           source_at=EXCLUDED.source_at, data_status=EXCLUDED.data_status`,
        [
          tradeDate,
          sample.sample_at,
          sample.stage,
          sample.code,
          sample.auction_price,
          sample.auction_pct,
          sample.auction_unmatched,
          sample.auction_volume,
          sample.auction_amount,
          sample.auction_turnover_pct,
          sample.auction_volume_ratio,
          sample.auction_yesterday_ratio_pct,
          sample.float_market_cap,
          sample.unmatched_ratio,
          sample.source_at,
          sample.data_status,
        ],
      );
    }
    return samples.length;
  });
}

/** 01 需要 9:20 基线判断未匹配量增减；返回每个代码最早一条 live 采样。 */
export async function firstLiveAuctionSamples(
  db: Db,
  tradeDate: string,
  codes: string[],
): Promise<Map<string, Record<string, unknown>>> {
  if (codes.length === 0) return new Map();
  const rows = await db.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (code) code, sample_at::text, auction_unmatched::float8 AS auction_unmatched,
            auction_turnover_pct::float8 AS auction_turnover_pct
       FROM auction_intraday_sample
      WHERE trade_date=$1::date AND stage='live' AND code = ANY($2::text[])
      ORDER BY code, sample_at ASC`,
    [tradeDate, codes],
  );
  return new Map(rows.rows.map((row) => [String(row.code), row]));
}

/** 05 已持仓代码：普通持仓观察用来排除超短持仓，避免三套逻辑同时评估。 */
export async function listHoldingCodes(db: Db, tradeDate: string): Promise<string[]> {
  const rows = await db.query<{ code: string }>(
    `SELECT DISTINCT code FROM ultra_short_watchlist
      WHERE exit_status IN ('holding','exit_triggered') AND target_date >= $1::date - 10
      ORDER BY code`,
    [tradeDate],
  );
  return rows.rows.map((row) => row.code);
}

/** 退出引擎读取：持有中或已触发退出的近几个交易日关注池行。 */
export async function listExitWatchlist(
  db: Db,
  fromDate: string,
  toDate: string,
): Promise<UltraShortWatchlistRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${WATCHLIST_COLUMNS} FROM ultra_short_watchlist
      WHERE target_date BETWEEN $1::date AND $2::date
        AND exit_status IN ('holding','exit_triggered')
      ORDER BY target_date, code`,
    [fromDate, toDate],
  );
  return rows.rows.map(normalizeRow);
}


// 05 离场：真实成交与关注池行的关联。
export interface FillSyncInput {
  account_id: string;
  code: string;
  kind: "buy" | "sell" | "adjust" | "note";
  price: number | null;
  quantity: number | null;
  change_date: string;
  strategy_code: string | null;
  remaining_quantity: number;
}

function fillPositive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 买入：只关联同代码、同一目标日的未持仓关注池行（01/04 的买入日 = target_date）。
 * 02 盘中排队买入发生在 T 日、关注池 T+1 才生成，由 03 构建时 attachQueuedPosition 补关联。
 */
export async function syncUltraShortFill(client: Db, input: FillSyncInput): Promise<void> {
  if (input.kind === "buy" && input.strategy_code === "limit_up" && fillPositive(input.price)) {
    await client.query(
      `UPDATE ultra_short_watchlist
          SET entry_price=$3, position_opened_at=$4::date, exit_status='holding',
              intraday_status='filled', updated_at=now()
        WHERE id = (
          SELECT id FROM ultra_short_watchlist
           WHERE code=$1 AND target_date=$2::date AND exit_status='none'
           ORDER BY target_date DESC LIMIT 1
        )`,
      [input.code, input.change_date, input.price, input.change_date],
    );
    return;
  }
  if (input.kind !== "sell" || input.remaining_quantity > 0) return;
  const row = (await client.query<{
    id: string; entry_price: string | null; stop_price: string | null; exit_status: string;
  }>(
    `SELECT id::text, entry_price::text,
            COALESCE(NULLIF(key_levels->>'stop_price','')::numeric, NULLIF(key_levels->>'invalidation_price','')::numeric)::text AS stop_price,
            exit_status
       FROM ultra_short_watchlist
      WHERE code=$1 AND exit_status IN ('holding','exit_triggered')
        AND target_date BETWEEN $2::date - 10 AND $2::date
      ORDER BY target_date DESC LIMIT 1`,
    [input.code, input.change_date],
  )).rows[0];
  if (!row) return;
  const entry = fillPositive(row.entry_price);
  const stop = fillPositive(row.stop_price);
  const price = fillPositive(input.price);
  const realizedR = entry && stop && stop < entry && price
    ? Number(((price - entry) / (entry - stop)).toFixed(2))
    : null;
  await client.query(
    `UPDATE ultra_short_watchlist
        SET exit_status='closed', exit_price=$2, exit_at=$3::date, realized_r=$4,
            exit_stage=2, updated_at=now()
      WHERE id=$1`,
    [row.id, price, input.change_date, realizedR],
  );
}

/**
 * 03 构建关注池后补关联 T 日已排队成交的 02 持仓：
 * 只认 dataDate 当天、策略归因为 limit_up 的现有持仓，避免把旧仓位误标成新的超短交易。
 */
export async function attachQueuedPosition(
  db: Db,
  targetDate: string,
  dataDate: string,
): Promise<number> {
  const rows = (await db.query<{
    code: string; cost_price: string; opened_at: string;
  }>(
    `SELECT instrument.code, position.cost_price::text, position.opened_at::text
       FROM portfolio_position position
       JOIN market_instrument instrument ON instrument.id=position.instrument_id
      WHERE position.quantity>0 AND position.strategy_code='limit_up'
        AND position.opened_at=$1::date`,
    [dataDate],
  )).rows;
  let attached = 0;
  for (const row of rows) {
    const updated = await db.query(
      `UPDATE ultra_short_watchlist
          SET entry_price=$3, position_opened_at=$4::date, exit_status='holding',
              intraday_status='filled', updated_at=now()
        WHERE target_date=$1::date AND code=$2 AND exit_status='none'`,
      [targetDate, row.code, row.cost_price, row.opened_at],
    );
    attached += updated.rowCount ?? 0;
  }
  return attached;
}
