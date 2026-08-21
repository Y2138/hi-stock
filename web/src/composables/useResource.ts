// 通用异步资源加载：loading / error / data 三态 + reload。
// 所有业务视图统一走这里，保证「失败原位报错 + 重试、加载有稳定占位」（M1 波次契约第 6 条）。
import { ref, type Ref } from "vue";
import type { ApiFail, ApiResult } from "../api/client";

export interface Resource<T> {
  data: Ref<T | null>;
  loading: Ref<boolean>;
  error: Ref<ApiFail | null>;
  reload: () => Promise<void>;
}

export function useResource<T>(loader: () => Promise<ApiResult<T>>): Resource<T> {
  const data = ref<T | null>(null) as Ref<T | null>;
  const loading = ref(false);
  const error = ref<ApiFail | null>(null);
  /** 防陈旧响应：只采纳最后一次发起的加载 */
  let seq = 0;

  async function reload(): Promise<void> {
    const my = ++seq;
    loading.value = true;
    error.value = null;
    const r = await loader();
    if (my !== seq) return;
    if (r.ok) {
      data.value = r.data;
    } else {
      error.value = r;
    }
    loading.value = false;
  }

  return { data, loading, error, reload };
}
