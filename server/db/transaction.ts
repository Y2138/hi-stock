import type pg from "pg";

export type TransactionDb = pg.Pool | pg.PoolClient;

function isPool(db: TransactionDb): db is pg.Pool {
  // pg 会把部分 Pool 属性代理到已借出的 client；仅凭 connect/totalCount
  // 会把 PoolClient 误判成 Pool，随后再次 connect() 并破坏外层事务。
  // release 是 PoolClient 的稳定边界，Pool 本身不提供该方法。
  return typeof (db as pg.PoolClient).release !== "function";
}

/**
 * HTTP/CLI 入口传 Pool 时由 service 自建事务；Agent 已持有事务和 advisory lock 时
 * 传 PoolClient，service 直接复用同一事务，避免领域写入逃逸到另一条连接。
 */
export async function inServiceTransaction<T>(
  db: TransactionDb,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!isPool(db)) return operation(db);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
