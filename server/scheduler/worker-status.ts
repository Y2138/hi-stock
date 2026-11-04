// 盘中常驻 worker 的心跳：只更新 job_worker_status，不写 job_run。
import type pg from "pg";

type Db = Pick<pg.Pool | pg.PoolClient, "query">;

export interface WorkerHeartbeat {
  status: "idle" | "running" | "success" | "failed";
  trade_date?: string | null;
  summary?: string | null;
  error?: string | null;
}

export async function writeWorkerHeartbeat(db: Db, code: string, heartbeat: WorkerHeartbeat): Promise<void> {
  await db.query(
    `INSERT INTO job_worker_status (code, status, trade_date, last_tick_at, last_summary, error, updated_at)
     VALUES ($1,$2,$3::date,now(),$4,$5,now())
     ON CONFLICT (code) DO UPDATE SET
       status=EXCLUDED.status, trade_date=EXCLUDED.trade_date, last_tick_at=now(),
       last_summary=EXCLUDED.last_summary, error=EXCLUDED.error, updated_at=now()`,
    [code, heartbeat.status, heartbeat.trade_date ?? null, heartbeat.summary ?? null, heartbeat.error ?? null],
  );
}

/** 任务中心暂停后，worker 下一轮停止工作；不需要重启进程。 */
export async function isWorkerEnabled(db: Db, code: string): Promise<boolean> {
  const row = (await db.query<{ enabled: boolean }>(
    "SELECT enabled FROM job_definition WHERE code=$1 AND job_type='worker'",
    [code],
  )).rows[0];
  return row?.enabled ?? false;
}
