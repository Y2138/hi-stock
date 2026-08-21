// Agent 数据库写协调器：所有会改变业务数据的对话工具共用同一把数据库级锁。
// 锁由 PostgreSQL 管理，跨会话、跨 Node 进程生效；使用 try-lock 快速失败，避免工具无界等待。
import type pg from "pg";

const MUTATION_LOCK_NAME = "stock.agent.database-mutation.v1";

export class AgentDatabaseBusyError extends Error {
  readonly code = "AGENT_DATABASE_BUSY";

  constructor() {
    super("另一对话正在修改当前数据库，本次写操作未执行；请等待其完成后重新提交");
    this.name = "AgentDatabaseBusyError";
  }
}

/** 调用方必须已开启事务；锁随事务提交/回滚自动释放。 */
export async function acquireAgentMutationLock(client: pg.PoolClient): Promise<void> {
  const result = await client.query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_xact_lock(
              hashtext(current_database()),
              hashtext($1)
            ) AS acquired`,
    [MUTATION_LOCK_NAME],
  );
  if (result.rows[0]?.acquired !== true) throw new AgentDatabaseBusyError();
}

/**
 * 在可序列化事务中持有数据库级 Agent 写锁。callback 可使用传入 client 原子写入，
 * 也可调用既有自管事务 service；无论哪种方式，其他 Agent 写工具都会快速失败。
 */
export async function withAgentMutationLock<T>(
  pool: pg.Pool,
  callback: (lockClient: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await acquireAgentMutationLock(client);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
