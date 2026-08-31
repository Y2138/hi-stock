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
  source_session_id: string | null;
  attribution_note: string | null;
  deviation_reason: string | null;
  created_at: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 当前持仓：join instrument 与 market_bar day 最新一行收盘价，计算市值与盈亏 */
export async function listPositions(db: Db): Promise<PositionRow[]> {
  const r = await db.query<PositionRow>(
    `SELECT p.instrument_id::text, i.code, i.name, i.kind,
            p.quantity::float, p.cost_price::float, p.cost_basis,
            p.opened_at::text, p.updated_at,
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
export async function listPositionChanges(db: Db, limit = 100): Promise<PositionChangeRow[]> {
  const r = await db.query<PositionChangeRow>(
    `SELECT c.id::text, c.instrument_id::text, i.code, i.name,
            c.change_date::text, c.kind, c.quantity::float, c.price::float, c.amount::float,
            c.cost_price_before::float, c.realized_pnl::float,
            c.reason, c.source, c.decision_origin, c.execution_compliance,
            c.strategy_change_seq::text, c.strategy_snapshot_hash,
            c.plan_output_id::text, plan.output_type AS plan_output_type,
            plan.target_date::text AS plan_target_date,
            c.source_session_id::text, c.attribution_note, c.deviation_reason, c.created_at
       FROM portfolio_position_change c
       JOIN market_instrument i ON i.id = c.instrument_id
       LEFT JOIN job_run_output plan ON plan.id = c.plan_output_id
      ORDER BY c.change_date DESC, c.id DESC
      LIMIT $1`,
    [limit],
  );
  return r.rows;
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
  plan_output_id?: string | null;
  attribution_note?: string | null;
  deviation_reason?: string | null;
}

interface PositionState {
  quantity: number;
  cost_price: number;
  opened_at: string | null;
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
          plan_output_id, source_session_id, attribution_note, deviation_reason,
          cost_price_before, realized_pnl)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING id::text, instrument_id::text, change_date::text, kind,
                 quantity::float, price::float, amount::float,
                 cost_price_before::float, realized_pnl::float, reason, source,
                 decision_origin, execution_compliance, strategy_change_seq::text,
                 strategy_snapshot_hash, plan_output_id::text, NULL::text AS plan_output_type,
                 NULL::text AS plan_target_date, source_session_id::text,
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
        input.plan_output_id ?? null, input.source_session_id ?? null,
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
               (instrument_id, quantity, cost_price, opened_at, updated_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (instrument_id) DO UPDATE SET
               quantity = EXCLUDED.quantity, cost_price = EXCLUDED.cost_price,
               opened_at = EXCLUDED.opened_at, updated_at = now()`,
            [instrumentId, qty, price, input.change_date],
          );
        } else {
          const oldQty = Number(existing.quantity);
          const oldCost = Number(existing.cost_price);
          const newQty = oldQty + qty;
          const newCost = (oldQty * oldCost + qty * price) / newQty;
          await client.query(
            "UPDATE portfolio_position SET quantity = $2, cost_price = $3, updated_at = now() WHERE instrument_id = $1",
            [instrumentId, newQty, newCost],
          );
        }
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

    return { change: { ...change.rows[0]!, code: input.code, name: inst.rows[0].name }, position };
  });
}
