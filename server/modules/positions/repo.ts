// 持仓 repo：当前持仓（join 最新收盘）、变更事件流、受控记录持仓变化（事务）
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §4.1、§十；产品方案 §6.6
// 盈亏口径：pnl_amount = 数量 × (最新收盘 − 成本)
import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import { inServiceTransaction, type TransactionDb } from "../../db/transaction.js";

export type Db = Pick<pg.Pool | pg.PoolClient, "query">;

export const POSITION_CHANGE_KINDS = ["buy", "sell", "adjust", "note"] as const;
export type PositionChangeKind = (typeof POSITION_CHANGE_KINDS)[number];

export interface PositionRow {
  instrument_id: string;
  code: string;
  name: string;
  kind: string;
  quantity: number;
  cost_price: number;
  cost_basis: string | null;
  opened_at: string | null;
  entry_signal_type: EntrySignalType | null;
  updated_at: string;
  close: number | null;
  close_date: string | null;
  market_value: number | null;
  pnl_amount: number | null;
  pnl_ratio: number | null;
  attribution_breakdown: Record<string, number>;
}

export const DECISION_ORIGINS = ["strategy_signal", "planned_discretionary", "unplanned_exception", "fact_correction", "unknown"] as const;
export type DecisionOrigin = (typeof DECISION_ORIGINS)[number];
export const EXECUTION_COMPLIANCE = ["matched", "deviated", "not_applicable", "unknown"] as const;
export type ExecutionCompliance = (typeof EXECUTION_COMPLIANCE)[number];
export const ENTRY_SIGNAL_TYPES = ["right_side", "left_reversal", "trial_start", "swing", "limit_up", "discretionary"] as const;
export type EntrySignalType = (typeof ENTRY_SIGNAL_TYPES)[number];

export interface PositionChangeRow {
  id: string;
  instrument_id: string;
  code: string;
  name: string;
  change_date: string;
  kind: PositionChangeKind;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  cost_price_before: number | null;
  realized_pnl: number | null;
  reason: string | null;
  source: string;
  decision_origin: DecisionOrigin;
  execution_compliance: ExecutionCompliance;
  strategy_change_seq: string | null;
  strategy_snapshot_hash: string | null;
  plan_output_id: string | null;
  plan_output_type: string | null;
  plan_target_date: string | null;
  entry_auction_assessment_id: string | null;
  entry_signal_type: EntrySignalType | null;
  entry_signal_date: string | null;
  entry_assessment_date: string | null;
  entry_signal_review_type: string | null;
  entry_signal_grade: string | null;
  entry_signal_headline: string | null;
  source_session_id: string | null;
  attribution_note: string | null;
  deviation_reason: string | null;
  created_at: string;
}

export interface PassedLimitUpSignalRow {
  assessment_id: string;
  code: string;
  name: string;
  signal_date: string;
  assessment_date: string;
  review_type: string;
  grade: string | null;
  priority: number;
  headline: string;
  plan_output_id: string;
  assessment_output_id: string | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 当前持仓：join instrument 与 market_bar day 最新一行收盘价，计算市值与盈亏 */
export async function listPositions(db: Db): Promise<PositionRow[]> {
  const r = await db.query<PositionRow>(
    `SELECT p.instrument_id::text, i.code, i.name, i.kind,
            p.quantity::float, p.cost_price::float, p.cost_basis,
            p.opened_at::text, p.entry_signal_type, p.updated_at,
            mb.close::float AS close, mb.bar_date::text AS close_date,
            COALESCE(attribution.breakdown, '{}'::jsonb) AS attribution_breakdown
       FROM portfolio_position p
       JOIN market_instrument i ON i.id = p.instrument_id
       LEFT JOIN LATERAL (
         SELECT close, bar_date FROM market_bar
          WHERE instrument_id = p.instrument_id AND freq = 'day'
          ORDER BY bar_date DESC LIMIT 1
       ) mb ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_object_agg(origin, event_count) AS breakdown
           FROM (
             SELECT change.decision_origin AS origin, count(*)::int AS event_count
               FROM portfolio_position_change change
              WHERE change.instrument_id = p.instrument_id
                AND change.kind <> 'note'
                AND (p.opened_at IS NULL OR change.change_date >= p.opened_at)
              GROUP BY change.decision_origin
           ) grouped
       ) attribution ON true
      ORDER BY i.code`,
  );
  return r.rows.map((row) => {
    const close = row.close === null ? null : Number(row.close);
    const quantity = Number(row.quantity);
    const cost = Number(row.cost_price);
    const marketValue = close === null ? null : round2(quantity * close);
    const pnlAmount = close === null ? null : round2(quantity * (close - cost));
    const pnlRatio =
      close === null || quantity === 0 || cost === 0
        ? null
        : round2(((close - cost) / cost) * 10000) / 10000;
    return { ...row, quantity, cost_price: cost, close, market_value: marketValue, pnl_amount: pnlAmount, pnl_ratio: pnlRatio };
  });
}

/** 变更事件流（join instrument，change_date/id 降序） */
export async function listPositionChanges(db: Db, limit = 100, codes?: string[]): Promise<PositionChangeRow[]> {
  const r = await db.query<PositionChangeRow>(
    `SELECT c.id::text, c.instrument_id::text, i.code, i.name,
            c.change_date::text, c.kind, c.quantity::float, c.price::float, c.amount::float,
            c.cost_price_before::float, c.realized_pnl::float,
            c.reason, c.source, c.decision_origin, c.execution_compliance,
            c.strategy_change_seq::text, c.strategy_snapshot_hash,
            c.plan_output_id::text, plan.output_type AS plan_output_type,
            plan.target_date::text AS plan_target_date,
            c.entry_auction_assessment_id::text,
            c.entry_signal_type,
            entry_item.target_date::text AS entry_signal_date,
            entry_run.target_date::text AS entry_assessment_date,
            entry_assessment.review_type AS entry_signal_review_type,
            entry_item.grade AS entry_signal_grade,
            entry_item.headline AS entry_signal_headline,
            c.source_session_id::text, c.attribution_note, c.deviation_reason, c.created_at
       FROM portfolio_position_change c
       JOIN market_instrument i ON i.id = c.instrument_id
       LEFT JOIN job_run_output plan ON plan.id = c.plan_output_id
       LEFT JOIN daily_plan_auction_assessment entry_assessment
         ON entry_assessment.id = c.entry_auction_assessment_id
       LEFT JOIN daily_plan_playbook entry_item ON entry_item.id = entry_assessment.playbook_item_id
       LEFT JOIN job_run entry_run ON entry_run.id = entry_assessment.source_job_run_id
      WHERE ($2::text[] IS NULL OR i.code = ANY($2::text[]))
      ORDER BY c.change_date DESC, c.id DESC
      LIMIT $1`,
    [limit, codes?.length ? codes : null],
  );
  return r.rows;
}

/** 按标的和可选成交日返回最近“信号通过”的打板复核，供 Agent 录入成交前确定归因。 */
export async function listPassedLimitUpSignals(
  db: Db,
  codes: string[],
  changeDate?: string,
): Promise<PassedLimitUpSignalRow[]> {
  if (codes.length === 0) return [];
  const result = await db.query<PassedLimitUpSignalRow>(
    `SELECT DISTINCT ON (assessment.code, auction_run.target_date)
            assessment.id::text AS assessment_id,
            assessment.code, instrument.name,
            item.target_date::text AS signal_date,
            auction_run.target_date::text AS assessment_date,
            assessment.review_type, item.grade, item.priority,
            item.headline, item.plan_output_id::text,
            assessment.assessment_output_id::text
       FROM daily_plan_auction_assessment assessment
       JOIN daily_plan_playbook item ON item.id = assessment.playbook_item_id
       JOIN job_run auction_run ON auction_run.id = assessment.source_job_run_id
       JOIN market_instrument instrument ON instrument.code = assessment.code
      WHERE assessment.code = ANY($1::text[])
        AND assessment.conclusion = 'signal_passed'
        AND assessment.status IN ('active','superseded')
        AND ($2::date IS NULL OR auction_run.target_date = $2::date)
      ORDER BY assessment.code, auction_run.target_date DESC, assessment.id DESC
      LIMIT 20`,
    [codes, changeDate ?? null],
  );
  return result.rows.map((row) => ({ ...row, priority: Number(row.priority) }));
}

export interface RealizedPnlSummaryRow {
  baseline_pnl: number;
  event_pnl: number;
  realized_pnl: number;
  sell_count: number;
  missing_sell_count: number;
  fee_status: "excluded";
}

/** 累计已实现盈亏：一次性历史基线 + 基线后的可计算卖出事件，未计费用。 */
export async function getRealizedPnlSummary(db: Db): Promise<RealizedPnlSummaryRow> {
  const result = await db.query<{
    baseline_pnl: number;
    event_pnl: number;
    realized_pnl: number;
    sell_count: string;
    missing_sell_count: string;
  }>(
    `SELECT baseline.amount::float AS baseline_pnl,
            COALESCE(SUM(change.realized_pnl) FILTER (WHERE change.realized_pnl IS NOT NULL), 0)::float AS event_pnl,
            (baseline.amount + COALESCE(SUM(change.realized_pnl) FILTER (WHERE change.realized_pnl IS NOT NULL), 0))::float AS realized_pnl,
            COUNT(change.id)::text AS sell_count,
            COUNT(change.id) FILTER (WHERE change.realized_pnl IS NULL)::text AS missing_sell_count
       FROM portfolio_realized_pnl_baseline baseline
       LEFT JOIN portfolio_position_change change
         ON change.kind = 'sell' AND change.created_at > baseline.through_created_at
      WHERE baseline.singleton = true
      GROUP BY baseline.amount`,
  );
  const row = result.rows[0]!;
  return {
    ...row,
    baseline_pnl: Number(row.baseline_pnl),
    event_pnl: Number(row.event_pnl),
    realized_pnl: Number(row.realized_pnl),
    sell_count: Number(row.sell_count),
    missing_sell_count: Number(row.missing_sell_count),
    fee_status: "excluded",
  };
}

export interface RecordChangeInput {
  code: string;
  kind: PositionChangeKind;
  quantity?: number;
  price?: number;
  change_date: string;
  reason?: string;
  source: "chat" | "job" | "ingest";
  source_session_id?: string | null;
  decision_origin: DecisionOrigin;
  execution_compliance: ExecutionCompliance;
  entry_signal_type?: EntrySignalType;
  plan_output_id?: string | null;
  attribution_note?: string | null;
  deviation_reason?: string | null;
}

interface PositionState {
  quantity: number;
  cost_price: number;
  opened_at: string | null;
}

interface EntryAuctionSignal {
  id: string;
  plan_output_id: string;
  assessment_output_id: string | null;
  signal_date: string;
  assessment_date: string;
  review_type: string;
  grade: string | null;
  headline: string;
}

async function resolveEntryAuctionSignal(
  client: pg.PoolClient,
  instrumentId: string,
  code: string,
  input: RecordChangeInput,
  existing: PositionState | null,
): Promise<EntryAuctionSignal | null> {
  if (input.kind === "buy" && input.decision_origin === "strategy_signal") {
    const match = await client.query<EntryAuctionSignal>(
      `SELECT assessment.id::text, item.plan_output_id::text,
              assessment.assessment_output_id::text,
              item.target_date::text AS signal_date,
              auction_run.target_date::text AS assessment_date,
              assessment.review_type, item.grade, item.headline
         FROM daily_plan_auction_assessment assessment
         JOIN daily_plan_playbook item ON item.id = assessment.playbook_item_id
         JOIN job_run auction_run ON auction_run.id = assessment.source_job_run_id
        WHERE assessment.code = $1
          AND auction_run.target_date = $2::date
          AND assessment.conclusion = 'signal_passed'
          AND assessment.status IN ('active','superseded')
        ORDER BY (assessment.status = 'active') DESC, assessment.id DESC
        LIMIT 1`,
      [code, input.change_date],
    );
    return match.rows[0] ?? null;
  }
  if (input.kind !== "sell" || !existing?.opened_at) return null;
  const inherited = await client.query<EntryAuctionSignal>(
    `SELECT min(assessment.id)::text AS id,
            min(item.plan_output_id)::text AS plan_output_id,
            min(assessment.assessment_output_id)::text AS assessment_output_id,
            min(item.target_date)::text AS signal_date,
            min(auction_run.target_date)::text AS assessment_date,
            min(assessment.review_type) AS review_type,
            min(item.grade) AS grade,
            min(item.headline) AS headline
       FROM portfolio_position_change change
       JOIN daily_plan_auction_assessment assessment
         ON assessment.id = change.entry_auction_assessment_id
       JOIN daily_plan_playbook item ON item.id = assessment.playbook_item_id
       JOIN job_run auction_run ON auction_run.id = assessment.source_job_run_id
      WHERE change.instrument_id = $1
        AND change.kind = 'buy'
        AND change.change_date >= $2::date
      HAVING count(DISTINCT assessment.id) = 1`,
    [instrumentId, existing.opened_at],
  );
  return inherited.rows[0]?.id ? inherited.rows[0] : null;
}

/**
 * 记录成交：事务内固化事件级归因和当时策略快照，并重算/更新 position 行。
 * - buy：无持仓则建仓；已有持仓按加权平均成本合并
 * - sell：全清时删除当前持仓行，历史成本与成交由事件流追溯；超卖抛 400
 * - adjust：直接修正数量/成本（至少一项）
 * - note：只写事件，不动 position 行
 */
export async function recordPositionChange(
  db: TransactionDb,
  input: RecordChangeInput,
): Promise<{ change: PositionChangeRow; position: PositionRow | null }> {
  return inServiceTransaction(db, async (client) => {
    const inst = await client.query<{ id: string; name: string }>(
      "SELECT id::text, name FROM market_instrument WHERE code = $1",
      [input.code],
    );
    if (!inst.rows[0]) throw apiErrors.notFound(`未知标的代码：${input.code}`);
    const instrumentId = inst.rows[0].id;
    if (input.source === "chat" && !input.source_session_id) throw apiErrors.badRequest("Agent 成交事件必须绑定来源会话");
    if (input.kind === "buy" && !input.entry_signal_type) {
      throw apiErrors.badRequest("买入事件必须声明 entry_signal_type（买入信号类型）");
    }
    if (input.kind !== "buy" && input.entry_signal_type) {
      throw apiErrors.badRequest("entry_signal_type 仅买入事件可以填写");
    }
    if ((input.decision_origin === "unplanned_exception" || input.execution_compliance === "deviated") && !input.deviation_reason?.trim()) {
      throw apiErrors.badRequest("计划外例外或执行偏离必须填写 deviation_reason");
    }
    if (input.plan_output_id) {
      const plan = await client.query("SELECT id FROM job_run_output WHERE id = $1", [input.plan_output_id]);
      if (!plan.rows[0]) throw apiErrors.badRequest(`关联计划结果不存在：${input.plan_output_id}`);
    }
    const strategy = await client.query<{ change_seq: string; current_hash: string }>(
      "SELECT change_seq::text, current_hash FROM strategy_state WHERE singleton = 1",
    );
    if (!strategy.rows[0]) throw apiErrors.conflict("当前策略状态缺失，无法固化成交归因");

    let existing: PositionState | null = null;
    if (input.kind !== "note") {
      const current = await client.query<PositionState>(
        `SELECT quantity::float, cost_price::float, opened_at::text
           FROM portfolio_position WHERE instrument_id = $1 FOR UPDATE`,
        [instrumentId],
      );
      existing = current.rows[0] ?? null;
      if (input.kind === "sell") {
        if (!existing) throw apiErrors.badRequest(`标的 ${input.code} 当前无持仓，不能卖出`);
        if (input.quantity! > Number(existing.quantity)) {
          throw apiErrors.badRequest(`卖出数量 ${input.quantity} 超过当前持仓 ${existing.quantity}`);
        }
      } else if (input.kind === "adjust" && !existing) {
        throw apiErrors.badRequest(`标的 ${input.code} 当前无持仓，不能调整`);
      }
    }

    const entrySignal = await resolveEntryAuctionSignal(client, instrumentId, input.code, input, existing);
    if (input.kind === "buy" && entrySignal && input.plan_output_id
      && input.plan_output_id !== entrySignal.plan_output_id
      && input.plan_output_id !== entrySignal.assessment_output_id) {
      throw apiErrors.badRequest(`标的 ${input.code} 的关联结果与成交日打板信号不一致`);
    }
    const planOutputId = input.plan_output_id
      ?? (input.kind === "buy" ? entrySignal?.plan_output_id : null)
      ?? null;

    const amount =
      input.quantity !== undefined && input.price !== undefined
        ? round2(input.quantity * input.price)
        : null;
    const costPriceBefore = input.kind === "sell" ? Number(existing!.cost_price) : null;
    const realizedPnl = input.kind === "sell"
      ? round2(input.quantity! * (input.price! - costPriceBefore!))
      : null;
    const change = await client.query<PositionChangeRow>(
      `INSERT INTO portfolio_position_change
         (instrument_id, change_date, kind, quantity, price, amount, reason, source,
          decision_origin, execution_compliance, strategy_change_seq, strategy_snapshot_hash,
          plan_output_id, entry_auction_assessment_id, entry_signal_type, source_session_id,
          attribution_note, deviation_reason, cost_price_before, realized_pnl)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING id::text, instrument_id::text, change_date::text, kind,
                 quantity::float, price::float, amount::float,
                 cost_price_before::float, realized_pnl::float, reason, source,
                 decision_origin, execution_compliance, strategy_change_seq::text,
                 strategy_snapshot_hash, plan_output_id::text, NULL::text AS plan_output_type,
                 NULL::text AS plan_target_date, entry_auction_assessment_id::text,
                 entry_signal_type,
                 NULL::text AS entry_signal_date, NULL::text AS entry_assessment_date,
                 NULL::text AS entry_signal_review_type, NULL::text AS entry_signal_grade,
                 NULL::text AS entry_signal_headline, source_session_id::text,
                 attribution_note, deviation_reason, created_at`,
      [
        instrumentId,
        input.change_date,
        input.kind,
        input.quantity ?? null,
        input.price ?? null,
        amount,
        input.reason ?? null, input.source, input.decision_origin, input.execution_compliance,
        strategy.rows[0].change_seq, strategy.rows[0].current_hash,
        planOutputId, entrySignal?.id ?? null, input.entry_signal_type ?? null,
        input.source_session_id ?? null,
        input.attribution_note?.trim() || null, input.deviation_reason?.trim() || null,
        costPriceBefore, realizedPnl,
      ],
    );

    let position: PositionRow | null = null;
    if (input.kind !== "note") {
      if (input.kind === "buy") {
        const qty = input.quantity!;
        const price = input.price!;
        if (!existing || Number(existing.quantity) === 0) {
          // 无持仓或已清零：按本次成交重新建仓
          await client.query(
            `INSERT INTO portfolio_position
               (instrument_id, quantity, cost_price, opened_at, entry_signal_type, updated_at)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (instrument_id) DO UPDATE SET
               quantity = EXCLUDED.quantity, cost_price = EXCLUDED.cost_price,
               opened_at = EXCLUDED.opened_at, entry_signal_type = EXCLUDED.entry_signal_type,
               updated_at = now()`,
            [instrumentId, qty, price, input.change_date, input.entry_signal_type!],
          );
        } else {
          const oldQty = Number(existing.quantity);
          const oldCost = Number(existing.cost_price);
          const newQty = oldQty + qty;
          const newCost = (oldQty * oldCost + qty * price) / newQty;
          // 加仓使用新信号类型作为当前管理口径
          await client.query(
            `UPDATE portfolio_position SET quantity = $2, cost_price = $3,
                    entry_signal_type = $4, updated_at = now()
              WHERE instrument_id = $1`,
            [instrumentId, newQty, newCost, input.entry_signal_type!],
          );
        }
        // 每日计划自动关注用于等待入场，买入成交后已经完成使命；人工关注继续保留。
        await client.query(
          `UPDATE pool_membership
              SET attention_reason = NULL, attention_from = NULL, attention_until = NULL, attention_signal = NULL
            WHERE instrument_id = $1 AND effective_to IS NULL
              AND attention_reason LIKE '每日计划·%'`,
          [instrumentId],
        );
      } else if (input.kind === "sell") {
        const oldQty = Number(existing!.quantity);
        const qty = input.quantity!;
        const newQty = oldQty - qty;
        if (newQty === 0) {
          await client.query(
            "DELETE FROM portfolio_position WHERE instrument_id = $1",
            [instrumentId],
          );
        } else {
          await client.query(
            "UPDATE portfolio_position SET quantity = $2, updated_at = now() WHERE instrument_id = $1",
            [instrumentId, newQty],
          );
        }
      } else {
        // adjust：直接修正数量/成本
        await client.query(
          `UPDATE portfolio_position SET
             quantity = COALESCE($2, quantity),
             cost_price = COALESCE($3, cost_price),
             updated_at = now()
           WHERE instrument_id = $1`,
          [instrumentId, input.quantity ?? null, input.price ?? null],
        );
      }

      const rows = await listPositions(client);
      position = rows.find((p) => p.instrument_id === instrumentId) ?? null;
    }

    return {
      change: {
        ...change.rows[0]!,
        code: input.code,
        name: inst.rows[0].name,
        entry_signal_date: entrySignal?.signal_date ?? null,
        entry_assessment_date: entrySignal?.assessment_date ?? null,
        entry_signal_review_type: entrySignal?.review_type ?? null,
        entry_signal_grade: entrySignal?.grade ?? null,
        entry_signal_headline: entrySignal?.headline ?? null,
      },
      position,
    };
  });
}

export interface UpdateEntrySignalTypeInput {
  code: string;
  entry_signal_type: EntrySignalType;
  reason: string;
  source: "chat" | "job";
  source_session_id?: string | null;
}

/**
 * 修正当前持仓的买入信号类型（评估口径）：同步覆盖最近一笔买入事件与持仓行，
 * 并插入一条 fact_correction 留痕事件，不动数量与成本。
 */
export async function updatePositionEntrySignalType(
  db: TransactionDb,
  input: UpdateEntrySignalTypeInput,
): Promise<{ position: PositionRow; previous_type: EntrySignalType | null }> {
  return inServiceTransaction(db, async (client) => {
    const inst = await client.query<{ id: string }>(
      "SELECT id::text FROM market_instrument WHERE code = $1",
      [input.code],
    );
    if (!inst.rows[0]) throw apiErrors.notFound(`未知标的代码：${input.code}`);
    const instrumentId = inst.rows[0].id;
    if (input.source === "chat" && !input.source_session_id) throw apiErrors.badRequest("Agent 修正事件必须绑定来源会话");

    const current = await client.query<{ entry_signal_type: EntrySignalType | null; opened_at: string | null }>(
      `SELECT entry_signal_type, opened_at::text
         FROM portfolio_position WHERE instrument_id = $1 AND quantity > 0 FOR UPDATE`,
      [instrumentId],
    );
    if (!current.rows[0]) throw apiErrors.badRequest(`标的 ${input.code} 当前无持仓，不能修正买入信号类型`);
    const previousType = current.rows[0].entry_signal_type ?? null;

    const strategy = await client.query<{ change_seq: string; current_hash: string }>(
      "SELECT change_seq::text, current_hash FROM strategy_state WHERE singleton = 1",
    );
    if (!strategy.rows[0]) throw apiErrors.conflict("当前策略状态缺失，无法固化修正归因");

    await client.query(
      "UPDATE portfolio_position SET entry_signal_type = $2, updated_at = now() WHERE instrument_id = $1",
      [instrumentId, input.entry_signal_type],
    );
    // 持仓周期内最近一笔买入事件同步补正；无买入事件的历史导入持仓只改持仓行。
    await client.query(
      `UPDATE portfolio_position_change change
          SET entry_signal_type = $2
         WHERE change.id = (
           SELECT latest.id
             FROM portfolio_position_change latest
            WHERE latest.instrument_id = $1
              AND latest.kind = 'buy'
              AND $3::date IS NOT NULL
              AND latest.change_date >= $3::date
            ORDER BY latest.change_date DESC, latest.id DESC LIMIT 1
         )`,
      [instrumentId, input.entry_signal_type, current.rows[0].opened_at],
    );
    await client.query(
      `INSERT INTO portfolio_position_change
         (instrument_id, change_date, kind, reason, source, decision_origin, execution_compliance,
          strategy_change_seq, strategy_snapshot_hash, source_session_id, attribution_note)
       VALUES ($1, CURRENT_DATE, 'note', $2, $3, 'fact_correction', 'not_applicable', $4, $5, $6, $7)`,
      [
        instrumentId,
        input.reason.trim(),
        input.source,
        strategy.rows[0].change_seq,
        strategy.rows[0].current_hash,
        input.source_session_id ?? null,
        `修正买入信号类型：${previousType ?? "未记录"} → ${input.entry_signal_type}；依据：${input.reason.trim()}`,
      ],
    );

    const rows = await listPositions(client);
    const position = rows.find((row) => row.instrument_id === instrumentId) ?? null;
    if (!position) throw apiErrors.conflict("修正后持仓行缺失");
    return { position, previous_type: previousType };
  });
}
