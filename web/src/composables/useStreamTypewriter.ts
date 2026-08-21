import { onScopeDispose } from "vue";

export interface StreamTypewriterOptions {
  /** 每次屏幕更新之间的最小间隔。 */
  interval?: number;
  /** 积压较多时一次最多追赶的字素数。 */
  maxStep?: number;
  /** 每次可见文本变化后通知调用方。 */
  onUpdate: (text: string) => void;
}

/**
 * 把网络到达节奏与屏幕呈现节奏解耦：SSE delta 先进入队列，再按动画帧平滑吐出。
 * 使用字素而非 UTF-16 code unit 切分，避免把 emoji、组合字符截成半个字符。
 */
export function useStreamTypewriter(options: StreamTypewriterOptions) {
  const interval = options.interval ?? 28;
  const maxStep = options.maxStep ?? 12;
  const segmenter =
    typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;

  let displayed = "";
  let queue: string[] = [];
  let animationId: number | null = null;
  let lastPaint = 0;
  let finishWaiters: Array<() => void> = [];

  function splitGraphemes(text: string): string[] {
    if (!segmenter) return Array.from(text);
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }

  function prefersReducedMotion(): boolean {
    return (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function resolveFinished(): void {
    const waiters = finishWaiters;
    finishWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function cancelAnimation(): void {
    if (animationId !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(animationId);
    }
    animationId = null;
  }

  function revealAll(): void {
    cancelAnimation();
    if (queue.length > 0) {
      displayed += queue.join("");
      queue = [];
      options.onUpdate(displayed);
    }
    resolveFinished();
  }

  function schedule(): void {
    if (animationId !== null || queue.length === 0 || typeof window === "undefined") return;
    animationId = window.requestAnimationFrame(tick);
  }

  function tick(timestamp: number): void {
    animationId = null;
    if (queue.length === 0) {
      resolveFinished();
      return;
    }

    if (lastPaint !== 0 && timestamp - lastPaint < interval) {
      schedule();
      return;
    }

    lastPaint = timestamp;
    // 小积压逐字呈现；大块网络分帧时自适应追赶，避免回复结束后仍长时间打字。
    const step = Math.min(maxStep, Math.max(1, Math.ceil(queue.length / 24)));
    displayed += queue.splice(0, step).join("");
    options.onUpdate(displayed);

    if (queue.length > 0) schedule();
    else resolveFinished();
  }

  function start(initialText = ""): void {
    cancelAnimation();
    resolveFinished();
    displayed = initialText;
    queue = [];
    lastPaint = 0;
  }

  function push(delta: string): void {
    if (!delta) return;
    queue.push(...splitGraphemes(delta));
    // 后台页签中 rAF 会暂停；无障碍“减少动态效果”也应直接显示完整增量。
    if (prefersReducedMotion() || (typeof document !== "undefined" && document.hidden)) {
      revealAll();
    } else {
      schedule();
    }
  }

  function finish(): Promise<void> {
    if (queue.length === 0) return Promise.resolve();
    if (typeof document !== "undefined" && document.hidden) {
      revealAll();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      finishWaiters.push(resolve);
      schedule();
    });
  }

  /** 中断或切会话时保留所有已经从服务端收到、尚未逐字显示的内容。 */
  function flush(): void {
    revealAll();
  }

  onScopeDispose(() => {
    cancelAnimation();
    resolveFinished();
  });

  return { start, push, finish, flush };
}
