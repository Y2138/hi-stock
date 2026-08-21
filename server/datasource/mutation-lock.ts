// 市场数据流水线协调器：避免目录、板块、日线和市场结构作业交叉改写市场域。
// 与 Agent 业务写锁相互独立，长行情任务不会阻塞策略和持仓写工具。
import type pg from "pg";

const MARKET_MUTATION_LOCK_NAME = "stock.market.database-mutation.v1";

export class MarketDatabaseBusyError extends Error {
  readonly code = "MARKET_DATABASE_BUSY";

  constructor() {
    super("另一市场数据作业正在运行，本次作业未执行；请等待其完成后重试");
    this.name = "MarketDatabaseBusyError";
  }
}

/** 调用方必须已开启事务；锁随事务提交或回滚自动释放。 */
export async function acquireMarketMutationLock(client: pg.PoolClient): Promise<void> {
  const result = await client.query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_xact_lock(
              hashtext(current_database()),
              hashtext($1)
            ) AS acquired`,
    [MARKET_MUTATION_LOCK_NAME],
  );
  if (result.rows[0]?.acquired !== true) throw new MarketDatabaseBusyError();
}

/**
 * 仅用短事务持有事务级 advisory lock；callback 内服务可继续使用自己的短事务，
 * 锁只负责阻止另一条受控市场流水线并发启动。
 */
export async function withMarketMutationLock<T>(
  pool: pg.Pool,
  callback: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await acquireMarketMutationLock(client);
    const result = await callback();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
