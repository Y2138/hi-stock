import type pg from "pg";
import { inServiceTransaction, type TransactionDb } from "../../db/transaction.js";
import { apiErrors } from "../../http/router.js";

export type Db = Pick<pg.Pool | pg.PoolClient, "query">;

export interface AccountRow {
  id: string;
  name: string;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
}

const ACCOUNT_COLS = `id::text, name, status,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`;

function accountName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) {
    throw apiErrors.badRequest("账户名称必须是 1–100 字符的非空字符串");
  }
  return value.trim();
}

export async function listAccounts(db: Db): Promise<AccountRow[]> {
  const result = await db.query<AccountRow>(
    `SELECT ${ACCOUNT_COLS} FROM portfolio_account ORDER BY status = 'active' DESC, id`,
  );
  return result.rows;
}

export async function getAccount(db: Db, id: string): Promise<AccountRow | null> {
  if (!/^[1-9]\d*$/.test(id)) throw apiErrors.badRequest("账户 ID 必须是正整数");
  const result = await db.query<AccountRow>(
    `SELECT ${ACCOUNT_COLS} FROM portfolio_account WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}

export async function requireAccount(db: Db, id = "1"): Promise<AccountRow> {
  const account = await getAccount(db, id);
  if (!account) throw apiErrors.notFound(`账户不存在：${id}`);
  return account;
}

export async function createAccount(db: TransactionDb, name: unknown): Promise<AccountRow> {
  return inServiceTransaction(db, async (client) => {
    const result = await client.query<AccountRow>(
      `INSERT INTO portfolio_account (name) VALUES ($1) RETURNING ${ACCOUNT_COLS}`,
      [accountName(name)],
    );
    await client.query(`INSERT INTO portfolio_realized_pnl_baseline(account_id,amount,through_created_at,source)
      VALUES($1,0,'-infinity','empty')`, [result.rows[0]!.id]);
    return result.rows[0]!;
  });
}

export async function updateAccount(db: Db, id: string, name: unknown): Promise<AccountRow> {
  await requireAccount(db,id);
  const result = await db.query<AccountRow>(
    `UPDATE portfolio_account SET name = $2, updated_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING ${ACCOUNT_COLS}`,
    [id, accountName(name)],
  );
  if (!result.rows[0]) throw apiErrors.notFound(`可修改的账户不存在：${id}`);
  return result.rows[0];
}

export async function archiveAccount(db: TransactionDb, id: string): Promise<AccountRow> {
  return inServiceTransaction(db, async (db) => {
    await db.query("SELECT id FROM portfolio_account ORDER BY id FOR UPDATE");
    const account = await requireAccount(db, id);
    if (account.status === "archived") return account;
    if (id === "1") throw apiErrors.conflict("默认账户不能归档");
    const running = await db.query("SELECT id FROM job_run WHERE account_id=$1 AND status IN ('queued','running')", [id]);
    if (running.rows.length) throw apiErrors.conflict("账户仍有待执行或运行中任务，不能归档");
    const positions = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM portfolio_position WHERE account_id = $1 AND quantity > 0", [id],
    );
    if (Number(positions.rows[0]?.count ?? 0) > 0) {
      throw apiErrors.conflict("账户仍有持仓，不能归档");
    }
    const result = await db.query<AccountRow>(
      `UPDATE portfolio_account SET status = 'archived', updated_at = now()
        WHERE id = $1 RETURNING ${ACCOUNT_COLS}`,
      [id],
    );
    return result.rows[0]!;
  });
}
