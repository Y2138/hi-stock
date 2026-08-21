// 扶摇统一请求队列：全局单并发、最小间隔、三级优先级与防饥饿。
import { defaultSleep, type SleepFn } from "./ratelimit.js";

export const HITHINK_PRIORITIES = [
  "interactive",
  "scheduled-medium",
  "scheduled-low",
] as const;
export type HithinkPriority = (typeof HITHINK_PRIORITIES)[number];

interface QueueItem<T> {
  priority: HithinkPriority;
  enqueuedAt: number;
  operation: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export interface HithinkSchedulerSnapshot {
  running: boolean;
  queued: Record<HithinkPriority, number>;
  completed: number;
  failed: number;
  lastQueuedDelayMs: number;
}

export class HithinkRequestScheduler {
  private readonly queues = new Map<HithinkPriority, QueueItem<unknown>[]>(
    HITHINK_PRIORITIES.map((priority) => [priority, []]),
  );
  private running = false;
  private lastRelease = 0;
  private highPriorityBurst = 0;
  private completed = 0;
  private failed = 0;
  private lastQueuedDelayMs = 0;

  constructor(
    private readonly minIntervalMs = 3000,
    private readonly sleep: SleepFn = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {}

  schedule<T>(priority: HithinkPriority, operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queues.get(priority)!.push({
        priority,
        enqueuedAt: this.now(),
        operation,
        resolve,
        reject,
      } as QueueItem<unknown>);
      void this.pump();
    });
  }

  snapshot(): HithinkSchedulerSnapshot {
    return {
      running: this.running,
      queued: Object.fromEntries(
        HITHINK_PRIORITIES.map((priority) => [priority, this.queues.get(priority)!.length]),
      ) as Record<HithinkPriority, number>,
      completed: this.completed,
      failed: this.failed,
      lastQueuedDelayMs: this.lastQueuedDelayMs,
    };
  }

  private next(): QueueItem<unknown> | undefined {
    const low = this.queues.get("scheduled-low")!;
    if (this.highPriorityBurst >= 5 && low.length > 0) {
      this.highPriorityBurst = 0;
      return low.shift();
    }
    for (const priority of HITHINK_PRIORITIES) {
      const item = this.queues.get(priority)!.shift();
      if (!item) continue;
      if (priority === "scheduled-low") this.highPriorityBurst = 0;
      else this.highPriorityBurst += 1;
      return item;
    }
    return undefined;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const item = this.next();
        if (!item) return;
        const wait = this.minIntervalMs - (this.now() - this.lastRelease);
        if (wait > 0) await this.sleep(wait);
        this.lastRelease = this.now();
        this.lastQueuedDelayMs = Math.max(0, this.lastRelease - item.enqueuedAt);
        try {
          const value = await item.operation();
          this.completed += 1;
          item.resolve(value);
        } catch (error) {
          this.failed += 1;
          item.reject(error);
        }
      }
    } finally {
      this.running = false;
      if (HITHINK_PRIORITIES.some((priority) => this.queues.get(priority)!.length > 0)) {
        void this.pump();
      }
    }
  }
}

export const sharedHithinkRequestScheduler = new HithinkRequestScheduler(3000);
