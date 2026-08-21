import type pg from "pg";
import { cronOccurrences } from "./time.js";
import {
  insertScheduledJobRun,
  latestScheduledFor,
  listJobDefinitions,
} from "./repo.js";
import { executeJobRun, recoverInterruptedJobRuns, type RunnerDeps } from "./runner.js";

export const DEFAULT_TICK_MS = 30_000;
// ponytail: 本机固定 3 个 worker；只有实测资源不足或长期空闲时再做可配置并发。
const MAX_PARALLEL_RUNS = 3;

const runtimes = new WeakMap<pg.Pool, JobScheduler>();

/** API/Agent 排队后唤醒同进程调度器；无运行时（测试/CLI）则保留 queued 等下次 tick。 */
export function wakeScheduler(pool: pg.Pool): void {
  runtimes.get(pool)?.wake();
}

export interface SchedulerDeps extends RunnerDeps {
  tickMs?: number;
}

export class JobScheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt: Date | null = null;
  private active: Promise<void> | null = null;
  private stopping = false;
  private started = false;

  constructor(private readonly deps: SchedulerDeps) {}

  /** 启动先把停机区间记为 missed，再执行已有 queued/retry；不会自动补跑 missed。 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    const now = this.deps.now?.() ?? new Date();
    await recoverInterruptedJobRuns(this.deps, now);
    await this.recoverMissed(now);
    if (this.stopping) return;
    this.lastTickAt = new Date(now.getTime() - 1);
    runtimes.set(this.deps.pool, this);
    await this.runTick(now);
    if (this.stopping) return;
    this.timer = setInterval(() => this.wake(), this.deps.tickMs ?? DEFAULT_TICK_MS);
    this.timer.unref?.();
  }

  wake(): void {
    if (this.stopping) return;
    void this.runTick(this.deps.now?.() ?? new Date()).catch((error) => {
      console.error(`[scheduler] tick 失败：${(error as Error).message}`);
    });
  }

  private async runTick(now: Date): Promise<void> {
    if (this.active) return this.active;
    this.active = (async () => {
      const after = this.lastTickAt ?? new Date(now.getTime() - (this.deps.tickMs ?? DEFAULT_TICK_MS));
      const jobs = (await listJobDefinitions(this.deps.pool)).filter((job) => job.enabled);
      for (const job of jobs) {
        for (const occurrence of cronOccurrences(job.cron, after, now)) {
          await insertScheduledJobRun(this.deps.pool, job.id, occurrence, "queued");
        }
      }
      this.lastTickAt = now;
      await this.drainQueued(now);
    })();
    try {
      await this.active;
    } finally {
      this.active = null;
    }
  }

  private async drainQueued(now: Date): Promise<void> {
    await Promise.all(
      Array.from({ length: MAX_PARALLEL_RUNS }, () => this.drainWorker(now)),
    );
  }

  private async drainWorker(now: Date): Promise<void> {
    for (let batch = 0; batch < 100 && !this.stopping; batch += 1) {
      const queued = await this.deps.pool.query<{ id: string }>(
        `SELECT r.id::text
           FROM job_run r JOIN job_definition d ON d.id = r.job_id
          WHERE r.status = 'queued' AND (r.next_retry_at IS NULL OR r.next_retry_at <= $1)
            AND (d.job_type <> 'datasource' OR NOT EXISTS (
              SELECT 1 FROM job_run active
              JOIN job_definition active_definition ON active_definition.id = active.job_id
              WHERE active.status = 'running' AND active_definition.job_type = 'datasource'
            ))
          ORDER BY COALESCE(r.next_retry_at, r.created_at), r.id LIMIT 1`,
        [now],
      );
      const id = queued.rows[0]?.id;
      if (!id) break;
      await executeJobRun(this.deps, id);
    }
  }

  async recoverMissed(now: Date): Promise<number> {
    const through = new Date(now.getTime() - 1);
    const jobs = (await listJobDefinitions(this.deps.pool)).filter((job) => job.enabled);
    let inserted = 0;
    for (const job of jobs) {
      const latest = await latestScheduledFor(this.deps.pool, job.id);
      // 作业被编辑/重新启用前的停用区间不追记；初次迁移不会倒扫历史。
      const definitionBoundary = new Date(job.updated_at ?? job.created_at);
      const after = latest && latest > definitionBoundary ? latest : definitionBoundary;
      for (const occurrence of cronOccurrences(job.cron, after, through)) {
        if (await insertScheduledJobRun(this.deps.pool, job.id, occurrence, "missed")) inserted += 1;
      }
    }
    return inserted;
  }

  /** 停止新 tick，并等待当前 Runner 安全落终态/重试态后返回。 */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (runtimes.get(this.deps.pool) === this) runtimes.delete(this.deps.pool);
    await this.active;
    this.started = false;
  }
}
