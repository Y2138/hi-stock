// pg Pool 单例：服务端与 CLI/摄取脚本共用
import pg from "pg";

let pool: pg.Pool | null = null;

/** 获取（或创建）共享连接池 */
export function getPool(databaseUrl: string): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  }
  return pool;
}

/** 关闭共享连接池（脚本退出前调用） */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** 为测试等场景创建独立连接池（不走单例） */
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 5 });
}
