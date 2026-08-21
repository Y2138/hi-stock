import { onBeforeUnmount, onMounted } from "vue";
import type { UiRefreshRequest, UiRefreshTarget } from "../api/types";

export const UI_REFRESH_EVENT = "stock:ui-refresh";

export function dispatchUiRefresh(request: UiRefreshRequest): void {
  window.dispatchEvent(new CustomEvent<UiRefreshRequest>(UI_REFRESH_EVENT, { detail: request }));
}

/**
 * 模块级刷新桥。只重新读取模块数据，不重挂载页面，因此不会清空未提交表单或编辑草稿。
 */
export function useUiRefresh(
  targets: UiRefreshTarget | UiRefreshTarget[],
  reload: (request: UiRefreshRequest) => void | Promise<void>,
): void {
  const accepted = new Set(Array.isArray(targets) ? targets : [targets]);
  let timer: number | null = null;
  let latest: UiRefreshRequest | null = null;
  const listener = (event: Event): void => {
    const request = (event as CustomEvent<UiRefreshRequest>).detail;
    if (!request?.targets?.some((target) => accepted.has(target))) return;
    latest = request;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      if (latest) void reload(latest);
      latest = null;
    }, 80);
  };

  onMounted(() => window.addEventListener(UI_REFRESH_EVENT, listener));
  onBeforeUnmount(() => {
    window.removeEventListener(UI_REFRESH_EVENT, listener);
    if (timer !== null) window.clearTimeout(timer);
  });
}
