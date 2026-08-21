// 持仓 repo：当前持仓（join 最新收盘）、变更事件流、账户快照、手工记录成交（事务）
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §4.1、§十；产品方案 §6.6
// 盈亏口径：pnl_amount = 数量 × (最新收盘 − 成本)；历史账户快照不计算收益率
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

export interface AccountSnapshotRow {
  snap_date: string;
  total_asset: number | null;
  market_value: number | null;
  cash: number | null;
  closed_pnl: number | null;
  raw_text: string | null;
  precision: "exact" | "approx";
  source: string;
}

/** 单行资金台账（0020）：自 anchor_date 快照起由成交连续维护的实时现金口径 */
export interface AccountStateRow {
  cash: number;
  closed_pnl: number;
  anchor_date: string;
  updated_at: string;
}

/** 实时资金摘要：台账现金 + 持仓×最新收盘派生的市值/总资金 */
export interface AccountSummaryRow {
  tracked: boolean;
  anchor_date: string | null;
  cash: number | null;
  closed_pnl: number | null;
  market_value: number;
  total_asset: number | null;
  missing_quote: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
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

/** 账户快照序列（snap_date 升序，收益曲线数据源；历史只有离散记录点） */
export async function listAccountSnapshots(db: Db): Promise<AccountSnapshotRow[]> {
  const r = await db.query<AccountSnapshotRow>(
    `SELECT snap_date::text, total_asset::float, market_value::float, cash::float, closed_pnl::float,
            raw_text, precision, source
       FROM portfolio_account_snapshot ORDER BY snap_date`,
  );
  return r.rows;
}

export interface UpsertAccountSnapshotInput {
  snap_date: string;
  total_asset: number;
  cash: number;
  closed_pnl: number;
  market_value?: number;
  precision?: "exact" | "approx";
  source: "chat" | "form" | "job";
  reason?: string;
}

/**
 * 新增或更新某日资金摘要。证券市值未显式提供时按总资产－可用资金确定；
 * 返回值中始终显式展示最终市值，避免将服务端计算伪装成用户原始输入。
 */
export async function upsertAccountSnapshot(
  db: TransactionDb,
  input: UpsertAccountSnapshotInput,
): Promise<AccountSnapshotRow & { market_value_derived: boolean }> {
  return inServiceTransaction(db, async (client) => {
    if ([input.total_asset, input.cash, input.closed_pnl, input.market_value]
      .some((value) => value !== undefined && !Number.isFinite(value))) throw apiErrors.badRequest("资金摘要金额必须是有限数值");
    if (!isRealDate(input.snap_date)) throw apiErrors.badRequest("snap_date 必须是有效的 YYYY-MM-DD 日期");
    const derived = input.market_value === undefined;
    const marketValue = round2(input.market_value ?? input.total_asset - input.cash);
    if (input.total_asset <= 0) throw apiErrors.badRequest("total_asset 必须大于 0");
    if (input.cash < 0) throw apiErrors.badRequest("cash 不得小于 0");
    if (marketValue < 0) throw apiErrors.badRequest("可用资金不得大于总资产");
    if (input.precision !== "approx" && Math.abs(input.total_asset - input.cash - marketValue) > 0.01) {
      throw apiErrors.badRequest("精确资金摘要必须满足：总资产 = 证券市值 + 可用资金");
    }
    const precision = input.precision ?? "exact";
    const rawText = [
      `总资产 ${input.total_asset}`,
      `证券市值 ${marketValue}${derived ? "（总资产-可用资金）" : ""}`,
      `可用资金 ${input.cash}`,
      `清仓收益 ${input.closed_pnl}`,
      input.reason?.trim() ? `原因：${input.reason.trim()}` : null,
    ].filter(Boolean).join("；");
    const result = await client.query<AccountSnapshotRow>(
      `INSERT INTO portfolio_account_snapshot
         (snap_date, total_asset, market_value, cash, closed_pnl, raw_text, precision, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (snap_date) DO UPDATE SET
         total_asset = EXCLUDED.total_asset,
         market_value = EXCLUDED.market_value,
         cash = EXCLUDED.cash,
         closed_pnl = EXCLUDED.closed_pnl,
         raw_text = EXCLUDED.raw_text,
         precision = EXCLUDED.precision,
         source = EXCLUDED.source
       RETURNING snap_date::text, total_asset::float, market_value::float, cash::float,
                 closed_pnl::float, raw_text, precision, source`,
      [
        input.snap_date,
        input.total_asset,
        marketValue,
        input.cash,
        input.closed_pnl,
        rawText,
        precision,
        input.source,
      ],
    );
    // 资金台账重锚（0020）：快照日期不早于当前锚点时，以券商口径快照重置台账；
    // 早于锚点的历史快照只入离散序列，不动台账（其时之后的成交已反映在当前台账中）。
    await client.query(
      `INSERT INTO portfolio_account_state (id, cash, closed_pnl, anchor_date, updated_at)
       VALUES (true, $1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET
         cash = EXCLUDED.cash,
         closed_pnl = EXCLUDED.closed_pnl,
         anchor_date = EXCLUDED.anchor_date,
         updated_at = now()
       WHERE portfolio_account_state.anchor_date <= EXCLUDED.anchor_date`,
      [input.cash, input.closed_pnl, input.snap_date],
    );
    return { ...result.rows[0]!, market_value_derived: derived };
  });
}

/** 读取台账（事务内调用，FOR UPDATE 保证与成交写入串行） */
async function lockAccountState(client: TransactionDb): Promise<AccountStateRow | null> {
  const r = await client.query<AccountStateRow>(
    `SELECT cash::float, closed_pnl::float, anchor_date::text, updated_at
       FROM portfolio_account_state WHERE id = true FOR UPDATE`,
  );
  const row = r.rows[0];
  return row ? { ...row, cash: Number(row.cash), closed_pnl: Number(row.closed_pnl) } : null;
}

/**
 * 实时资金摘要：台账（快照锚点 + 其后成交）给出可用资金/清仓收益，
 * 证券市值由持仓×最新收盘派生，总资金 = 可用资金 + 证券市值。
 * 从未同步快照时 tracked=false，现金相关字段为 null（不猜测）。
 */
export async function getAccountSummary(db: Db): Promise<AccountSummaryRow> {
  const positions = await listPositions(db);
  let marketValue = 0;
  let missingQuote = 0;
  for (const p of positions) {
    if (Number(p.quantity) === 0) continue;
    if (p.market_value === null) missingQuote += 1;
    else marketValue += p.market_value;
  }
  marketValue = round2(marketValue);
  const r = await db.query<AccountStateRow>(
    `SELECT cash::float, closed_pnl::float, anchor_date::text, updated_at
       FROM portfolio_account_state WHERE id = true`,
  );
  const state = r.rows[0] ?? null;
  if (!state) {
    return {
      tracked: false,
      anchor_date: null,
      cash: null,
      closed_pnl: null,
      market_value: marketValue,
      total_asset: null,
      missing_quote: missingQuote,
    };
  }
  const cash = Number(state.cash);
  return {
    tracked: true,
    anchor_date: state.anchor_date,
    cash,
    closed_pnl: Number(state.closed_pnl),
    market_value: marketValue,
    total_asset: round2(cash + marketValue),
    missing_quote: missingQuote,
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
  pending_realized_pnl: number;
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

    const amount =
      input.quantity !== undefined && input.price !== undefined
        ? round2(input.quantity * input.price)
        : null;
    const change = await client.query<PositionChangeRow>(
      `INSERT INTO portfolio_position_change
         (instrument_id, change_date, kind, quantity, price, amount, reason, source,
          decision_origin, execution_compliance, strategy_change_seq, strategy_snapshot_hash,
          plan_output_id, source_session_id, attribution_note, deviation_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id::text, instrument_id::text, change_date::text, kind,
                 quantity::float, price::float, amount::float, reason, source,
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
      ],
    );

    let position: PositionRow | null = null;
    /** 全清时转入台账的本轮完整收益（此前部分卖出累计 + 最后一笔卖出收益）。 */
    let sellRealized: number | null = null;
    if (input.kind !== "note") {
      const cur = await client.query<PositionState>(
        `SELECT quantity::float, cost_price::float, pending_realized_pnl::float, opened_at::text
           FROM portfolio_position WHERE instrument_id = $1 FOR UPDATE`,
        [instrumentId],
      );
      const existing = cur.rows[0] ?? null;

      if (input.kind === "buy") {
        const qty = input.quantity!;
        const price = input.price!;
        if (!existing || Number(existing.quantity) === 0) {
          // 无持仓或已清零：按本次成交重新建仓
          await client.query(
            `INSERT INTO portfolio_position
               (instrument_id, quantity, cost_price, pending_realized_pnl, opened_at, updated_at)
             VALUES ($1, $2, $3, 0, $4, now())
             ON CONFLICT (instrument_id) DO UPDATE SET
               quantity = EXCLUDED.quantity, cost_price = EXCLUDED.cost_price,
               pending_realized_pnl = 0, opened_at = EXCLUDED.opened_at, updated_at = now()`,
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
        if (!existing) throw apiErrors.badRequest(`标的 ${input.code} 当前无持仓，不能卖出`);
        const oldQty = Number(existing.quantity);
        const qty = input.quantity!;
        const newQty = oldQty - qty;
        if (newQty < 0) {
          throw apiErrors.badRequest(`卖出数量 ${qty} 超过当前持仓 ${oldQty}`);
        }
        const realized = round2(qty * (input.price! - Number(existing.cost_price)));
        if (newQty === 0) {
          sellRealized = round2(Number(existing.pending_realized_pnl) + realized);
          await client.query(
            "DELETE FROM portfolio_position WHERE instrument_id = $1",
            [instrumentId],
          );
        } else {
          await client.query(
            `UPDATE portfolio_position
                SET quantity = $2, pending_realized_pnl = $3, updated_at = now()
              WHERE instrument_id = $1`,
            [instrumentId, newQty, round2(Number(existing.pending_realized_pnl) + realized)],
          );
        }
      } else {
        // adjust：直接修正数量/成本
        if (!existing) throw apiErrors.badRequest(`标的 ${input.code} 当前无持仓，不能调整`);
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

    // 资金台账联动（0020）：锚点之后的买/卖连续维护可用资金；
    // change_date <= anchor_date 的成交视为已被快照吸收，不动台账；无台账（从未同步快照）不阻塞成交。
    if ((input.kind === "buy" || input.kind === "sell") && amount !== null) {
      const state = await lockAccountState(client);
      if (state && input.change_date > state.anchor_date) {
        if (input.kind === "buy") {
          const nextCash = round2(state.cash - amount);
          if (nextCash < 0) {
            throw apiErrors.badRequest(
              `可用资金不足：当前 ${state.cash} 元（锚定 ${state.anchor_date} 快照），本次买入需要 ${amount} 元`,
            );
          }
          await client.query(
            "UPDATE portfolio_account_state SET cash = $1, updated_at = now() WHERE id = true",
            [nextCash],
          );
        } else {
          const nextCash = round2(state.cash + amount);
          const nextClosed =
            sellRealized === null ? state.closed_pnl : round2(state.closed_pnl + sellRealized);
          await client.query(
            "UPDATE portfolio_account_state SET cash = $1, closed_pnl = $2, updated_at = now() WHERE id = true",
            [nextCash, nextClosed],
          );
        }
      }
    }

    return { change: { ...change.rows[0]!, code: input.code, name: inst.rows[0].name }, position };
  });
}
