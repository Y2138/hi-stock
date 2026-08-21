// 限流与重试：串行间隔限流器 + 指数退避
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §5.2
// 间隔与重试口径引用 数据获取规范.md（批量串行、间隔 ≥3 秒；限流退避重试），此处不复制

export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 串行间隔限流器：相邻两次放行的间隔不小于 minIntervalMs。
 * 所有调用方共享同一实例即形成全局串行队列（acquire 按注册顺序逐个放行）。
 * sleep 可注入，测试用记录型假函数避免真实等待。
 */
export class RateLimiter {
  private lastRelease = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly minIntervalMs = 3000,
    private readonly sleep: SleepFn = defaultSleep,
  ) {}

  /** 获取一个令牌；返回的 Promise 在放行后 resolve */
  acquire(): Promise<void> {
    const turn = this.chain.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastRelease);
      if (wait > 0) await this.sleep(wait);
      this.lastRelease = Date.now();
    });
    // 排队链本身不因单个等待失败而中断
    this.chain = turn.catch(() => {});
    return turn;
  }
}

export interface BackoffOptions {
  /** 最大重试次数（不含首次），缺省 2 */
  maxRetries?: number;
  /** 退避基数毫秒，缺省 2000；第 n 次重试等待 base * 2^(n-1)，封顶 maxDelayMs */
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: SleepFn;
  /** 判断错误是否可重试；缺省全部可重试 */
  shouldRetry?: (err: unknown) => boolean;
  /** 从错误中提取服务端要求的等待毫秒（如 Retry-After），优先于指数退避 */
  retryAfterMs?: (err: unknown) => number | null;
}

/** 指数退避重试包装：仅对 shouldRetry 判为可重试的错误退避，其余直接抛出 */
export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const base = opts.baseDelayMs ?? 2000;
  const cap = opts.maxDelayMs ?? 8000;
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !(opts.shouldRetry ? opts.shouldRetry(err) : true)) {
        throw err;
      }
      attempt += 1;
      const hint = opts.retryAfterMs?.(err);
      const delay = hint != null && hint > 0 ? hint : Math.min(base * 2 ** (attempt - 1), cap);
      await sleep(delay);
    }
  }
}
