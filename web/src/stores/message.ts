import { readonly, ref } from "vue";

export type AppMessageType = "success" | "error" | "warning" | "info";

export interface AppMessageItem {
  id: number;
  type: AppMessageType;
  title: string;
  text: string;
  code: string | null;
}

interface MessageOptions {
  title?: string;
  code?: string;
  duration?: number;
}

interface ApiFailureLike {
  code: string;
  message: string;
  status?: number;
}

const DEFAULT_TITLES: Record<AppMessageType, string> = {
  success: "操作成功",
  error: "操作失败",
  warning: "请注意",
  info: "提示",
};

const DEFAULT_DURATIONS: Record<AppMessageType, number> = {
  success: 3200,
  info: 4000,
  warning: 5000,
  error: 6500,
};

const visibleMessages = ref<AppMessageItem[]>([]);
const recentMessages = new Map<string, number>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let nextId = 1;

function dismiss(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  visibleMessages.value = visibleMessages.value.filter((item) => item.id !== id);
}

function show(type: AppMessageType, text: string, options: MessageOptions = {}): number | null {
  const normalized = text.trim();
  if (!normalized) return null;

  const title = options.title?.trim() || DEFAULT_TITLES[type];
  const code = options.code?.trim() || null;
  const key = `${type}\u0000${title}\u0000${normalized}\u0000${code ?? ""}`;
  const now = Date.now();
  const previous = recentMessages.get(key);
  if (previous !== undefined && now - previous < 5000) return null;
  recentMessages.set(key, now);
  if (recentMessages.size > 80) {
    for (const [recentKey, timestamp] of recentMessages) {
      if (now - timestamp > 60_000) recentMessages.delete(recentKey);
    }
  }

  while (visibleMessages.value.length >= 4) dismiss(visibleMessages.value[0]!.id);
  const id = nextId++;
  visibleMessages.value.push({ id, type, title, text: normalized, code });
  const duration = options.duration ?? DEFAULT_DURATIONS[type];
  if (duration > 0) timers.set(id, setTimeout(() => dismiss(id), duration));
  return id;
}

function apiError(failure: ApiFailureLike): number | null {
  let title = "请求失败";
  if (failure.code === "NETWORK" || failure.code === "STREAM") title = "服务连接失败";
  else if (failure.status === 400) title = "请求参数有误";
  else if (failure.status === 401 || failure.status === 403) title = "无权执行此操作";
  else if (failure.status === 404) title = "请求的内容不存在";
  else if (failure.status === 409) title = "数据状态已变化";
  else if ((failure.status ?? 0) >= 500) title = "服务处理失败";
  return show("error", failure.message, { title, code: failure.code });
}

export const appMessages = readonly(visibleMessages);
export const appMessage = {
  show,
  dismiss,
  success: (text: string, options?: MessageOptions) => show("success", text, options),
  error: (text: string, options?: MessageOptions) => show("error", text, options),
  warning: (text: string, options?: MessageOptions) => show("warning", text, options),
  info: (text: string, options?: MessageOptions) => show("info", text, options),
  apiError,
};
