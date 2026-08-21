// 指标后台工作器：串行领取 dirty，失败短暂退避；stop 会等待当前序列安全收敛。
import type pg from "pg";
import { nextDirtyIndicator, recomputeIndicatorSeries } from "./service.js";

export class IndicatorWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: Promise<void> | null = null;
  private stopped = true;
  private retryAfter = 0;

  constructor(
    private readonly pool: pg.Pool,
    private readonly intervalMs = 2000,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current;
  }

  private schedule(delay = this.intervalMs): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.current = this.tick().finally(() => {
        this.current = null;
        this.schedule();
      });
    }, delay);
  }

  private async tick(): Promise<void> {
    if (Date.now() < this.retryAfter) return;
    const dirty = await nextDirtyIndicator(this.pool);
    if (!dirty) return;
    try {
      await recomputeIndicatorSeries(this.pool, dirty);
      this.retryAfter = 0;
    } catch (error) {
      this.retryAfter = Date.now() + 30_000;
      console.error(`指标重算失败 ${dirty.instrument_id}/${dirty.freq}：${(error as Error).message}`);
    }
  }
}
