// 确认制（T5）：提案写入 / approve（执行真实写入 + 回填 result + 审计）/ reject / 超时 expired
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §6.3
// - 领域写工具 execute 不直接写库，只写 confirmation(status='pending') 返回提案；
// - approve 在事务内锁定提案行，再取得数据库级 Agent 写锁；领域 service 的业务变更、
//   result 回填与审计同事务提交，旧提案目标状态已变化时拒绝执行；reject 只留审计；
// - pending 超 24h 惰性标 expired（list/approve/reject 入口先跑 expireStale），不自动执行；
import type pg from "pg";
import { apiErrors } from "../http/router.js";
import {
  DomainWriteConflictError,
  executeDomainWriteInTransaction,
  type DomainWriteToolName,
} from "./domain-write-tools.js";
import { insertToolAudit } from "./repo.js";
import { persistAndPublishSessionEvent } from "./events.js";
import { acquireAgentMutationLock, AgentDatabaseBusyError } from "./mutation-lock.js";
import { sha256Json } from "./hash.js";

export type Db = Pick<pg.Pool | pg.PoolClient, "query">;

/** pending 提案的有效期（超时惰性标 expired） */
export const CONFIRMATION_TTL_HOURS = 24;

export const DOMAIN_WRITE_TOOLS = new Set<DomainWriteToolName>([
  "portfolio_write",
  "pool_write",
  "job_write",
]);

export interface ConfirmationRow {
  id: string;
  session_id: string | null;
  tool_name: string;
  payload: unknown;
  status: "pending" | "approved" | "rejected" | "expired";
  decided_at: string | null;
  result: unknown;
  created_at: string;
  /** 仅服务端执行时使用；API payload 已解包，不向 UI 混入内部元数据。 */
  expected_state_hash: string | null;
}

const ENVELOPE_KEY = "__stock_agent_confirmation_v1";
const CONFIRMATION_COLS = `id::text, session_id::text, tool_name,
  CASE WHEN payload ? '${ENVELOPE_KEY}'
       THEN payload #> '{${ENVELOPE_KEY},request}'
       ELSE payload END AS payload,
  CASE WHEN payload ? '${ENVELOPE_KEY}'
       THEN payload #>> '{${ENVELOPE_KEY},expected_state_hash}'
       ELSE NULL END AS expected_state_hash,
  status, decided_at, result, created_at`;

function storedPayload(payload: unknown, expectedStateHash?: string | null): unknown {
  if (!expectedStateHash) return payload;
  return {
    [ENVELOPE_KEY]: {
      request: payload,
      expected_state_hash: expectedStateHash,
    },
  };
}

export async function createConfirmation(
  db: Db,
  input: {
    session_id: string | null;
    tool_name: string;
    payload: unknown;
    status?: "pending" | "approved";
    result?: unknown;
    expected_state_hash?: string | null;
  },
): Promise<ConfirmationRow> {
  const status = input.status ?? "pending";
  const r = await db.query<ConfirmationRow>(
    `INSERT INTO agent_confirmation (session_id, tool_name, payload, status, decided_at, result)
     VALUES ($1, $2, $3, $4, ${status === "approved" ? "now()" : "NULL"}, $5)
     RETURNING ${CONFIRMATION_COLS}`,
    [
      input.session_id,
      input.tool_name,
      JSON.stringify(storedPayload(input.payload, input.expected_state_hash)),
      status,
      input.result === undefined ? null : JSON.stringify(input.result),
    ],
  );
  return r.rows[0]!;
}

export async function getConfirmation(db: Db, id: string): Promise<ConfirmationRow | null> {
  const r = await db.query<ConfirmationRow>(
    `SELECT ${CONFIRMATION_COLS} FROM agent_confirmation WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function getConfirmationForUpdate(
  client: pg.PoolClient,
  id: string,
): Promise<ConfirmationRow | null> {
  const result = await client.query<ConfirmationRow>(
    `SELECT ${CONFIRMATION_COLS} FROM agent_confirmation WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** 惰性过期：pending 超 TTL 标 expired（不自动执行） */
export async function expireStaleConfirmations(db: Db): Promise<number> {
  const r = await db.query(
    `UPDATE agent_confirmation SET status = 'expired', decided_at = now()
      WHERE status = 'pending'
        AND created_at < now() - make_interval(hours => $1)`,
    [CONFIRMATION_TTL_HOURS],
  );
  return r.rowCount ?? 0;
}

export async function listConfirmations(
  db: Db,
  opts: { status?: string; session_id?: string; limit: number },
): Promise<ConfirmationRow[]> {
  await expireStaleConfirmations(db);
  const conds: string[] = [];
  const args: unknown[] = [];
  if (opts.status) {
    args.push(opts.status);
    conds.push(`status = $${args.length}`);
  }
  if (opts.session_id) {
    args.push(opts.session_id);
    conds.push(`session_id = $${args.length}`);
  }
  args.push(opts.limit);
  const r = await db.query<ConfirmationRow>(
    `SELECT ${CONFIRMATION_COLS} FROM agent_confirmation
      ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
      ORDER BY id DESC LIMIT $${args.length}`,
    args,
  );
  return r.rows;
}

/**
 * approve：校验 pending 未过期 → 执行真实写入（executor，自有事务）→
 * 确认侧事务回填 result + 写审计 + 推送会话事件。
 */
export async function approveConfirmation(pool: pg.Pool, id: string): Promise<ConfirmationRow> {
  await expireStaleConfirmations(pool);
  const client = await pool.connect();
  let row: ConfirmationRow;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const current = await getConfirmationForUpdate(client, id);
    if (!current) throw apiErrors.notFound(`提案不存在：${id}`);
    if (current.status !== "pending") {
      throw apiErrors.conflict(`提案当前状态为 ${current.status}，不能批准`);
    }
    if (!DOMAIN_WRITE_TOOLS.has(current.tool_name as DomainWriteToolName)) {
      throw apiErrors.badRequest(`工具 ${current.tool_name} 没有注册领域提案执行器`);
    }

    // 行锁防止同一提案重复执行；数据库级 advisory lock 防止不同会话同时写业务库。
    await acquireAgentMutationLock(client);
    const result = await executeDomainWriteInTransaction(
      client,
      current.tool_name as DomainWriteToolName,
      current.payload,
      { expectedStateHash: current.expected_state_hash, sessionId: current.session_id },
    );

    const updated = await client.query<ConfirmationRow>(
      `UPDATE agent_confirmation SET status = 'approved', decided_at = now(), result = $2
        WHERE id = $1 AND status = 'pending'
        RETURNING ${CONFIRMATION_COLS}`,
      [id, JSON.stringify(result ?? null)],
    );
    if (!updated.rows[0]) throw apiErrors.conflict("提案状态已变化，请刷新后重试");
    row = updated.rows[0];
    await insertToolAudit(client, {
      session_id: current.session_id,
      tool_name: current.tool_name,
      args: current.payload,
      result_sha256: sha256Json(result),
      status: "ok",
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (
      err instanceof AgentDatabaseBusyError ||
      err instanceof DomainWriteConflictError ||
      (err as { code?: string }).code === "40001" ||
      (err as { code?: string }).code === "55P03"
    ) {
      throw apiErrors.conflict((err as Error).message);
    }
    throw err;
  } finally {
    client.release();
  }

  if (row.session_id) {
    await persistAndPublishSessionEvent(pool, {
      session_id: row.session_id,
      event_type: "confirmation_result",
      data: { confirmation_id: row.id, tool_name: row.tool_name, status: "approved", result: row.result },
    });
    const targets: Record<string, string[]> = {
      portfolio_write: ["positions", "dashboard", "status"],
      pool_write: ["pools", "dashboard"],
      job_write: ["jobs", "dashboard", "status"],
      finalize_backtest: ["backtests"],
      memory_write: ["memories"],
    };
    const refreshTargets = targets[row.tool_name];
    if (refreshTargets) {
      await persistAndPublishSessionEvent(pool, {
        session_id: row.session_id,
        event_type: "ui_refresh",
        data: {
          targets: refreshTargets,
          reason: `${row.tool_name} 提案已由用户批准并执行`,
          requested_at: new Date().toISOString(),
        },
      });
    }
  }
  return row;
}

/** reject：只留审计，不执行任何写入 */
export async function rejectConfirmation(pool: pg.Pool, id: string): Promise<ConfirmationRow> {
  await expireStaleConfirmations(pool);
  const client = await pool.connect();
  let row: ConfirmationRow;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const current = await getConfirmationForUpdate(client, id);
    if (!current) throw apiErrors.notFound(`提案不存在：${id}`);
    if (current.status !== "pending") {
      throw apiErrors.conflict(`提案当前状态为 ${current.status}，不能拒绝`);
    }
    const updated = await client.query<ConfirmationRow>(
      `UPDATE agent_confirmation SET status = 'rejected', decided_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING ${CONFIRMATION_COLS}`,
      [id],
    );
    if (!updated.rows[0]) throw apiErrors.conflict("提案状态已变化，请刷新后重试");
    row = updated.rows[0];
    await insertToolAudit(client, {
      session_id: current.session_id,
      tool_name: current.tool_name,
      args: current.payload,
      result_sha256: null,
      status: "blocked",
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (row.session_id) {
    await persistAndPublishSessionEvent(pool, {
      session_id: row.session_id,
      event_type: "confirmation_result",
      data: { confirmation_id: row.id, tool_name: row.tool_name, status: "rejected" },
    });
  }
  return row;
}
