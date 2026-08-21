// API 客户端：统一 fetch 封装与错误形状；API 未就绪/服务未启动时优雅降级，不抛裸异常
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §三
import { appMessage } from "../stores/message";

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiFail {
  ok: false;
  /** 稳定错误码（服务端 error.code），网络层失败为 NETWORK */
  code: string;
  message: string;
  status?: number;
  /** 服务端稳定错误的附加结构（例如乐观锁冲突的 server 版本）。 */
  details?: Record<string, unknown>;
}

export type ApiResult<T> = ApiOk<T> | ApiFail;

interface ErrorEnvelope {
  error?: { code?: string; message?: string; [key: string]: unknown };
}

function reportFailure(failure: ApiFail): ApiFail {
  appMessage.apiError(failure);
  return failure;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return reportFailure({
      ok: false,
      code: "NETWORK",
      message: "服务不可达，请确认本地服务已启动后重试",
    });
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // 非 JSON 响应（如静态页）按失败处理
  }

  if (!res.ok) {
    const env = payload as ErrorEnvelope | null;
    return reportFailure({
      ok: false,
      code: env?.error?.code ?? "HTTP_" + res.status,
      message: env?.error?.message ?? `请求失败（HTTP ${res.status}）`,
      status: res.status,
      details: env?.error
        ? Object.fromEntries(Object.entries(env.error).filter(([key]) => !["code", "message"].includes(key)))
        : undefined,
    });
  }
  return { ok: true, data: payload as T };
}

export const apiClient = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};

/** 服务健康探测：骨架阶段顶栏状态条使用 */
export async function probeHealth(): Promise<ApiResult<{ status: string }>> {
  return apiClient.get<{ status: string }>("/api/health");
}

// ---- AI 对话：SSE 流与 multipart 上传（request() 只覆盖普通 JSON 请求） ----

/** 解析非 2xx 响应的统一错误信封 */
async function readErrorEnvelope(res: Response): Promise<ApiFail> {
  let env: ErrorEnvelope | null = null;
  try {
    env = (await res.json()) as ErrorEnvelope;
  } catch {
    // 非 JSON 错误响应
  }
  return reportFailure({
    ok: false,
    code: env?.error?.code ?? "HTTP_" + res.status,
    message: env?.error?.message ?? `请求失败（HTTP ${res.status}）`,
    status: res.status,
    details: env?.error
      ? Object.fromEntries(Object.entries(env.error).filter(([key]) => !["code", "message"].includes(key)))
      : undefined,
  });
}

export interface RawSseFrame {
  type: string;
  data: unknown;
}

/**
 * POST 并按帧解析 SSE 流（设计 §6.4：event: <类型>\ndata: <JSON>\n\n）。
 * 前置校验失败（未建流）返回 ApiFail；建流后协议内 error 帧由 onFrame 交给调用方。
 * 返回 null 表示流正常结束或被调用方 AbortSignal 主动中断（中断时已产出帧不丢失）。
 */
export async function postSseStream(
  path: string,
  body: unknown,
  opts: { signal?: AbortSignal; onFrame: (frame: RawSseFrame) => void },
): Promise<ApiFail | null> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal ?? null,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") return null;
    return reportFailure({
      ok: false,
      code: "NETWORK",
      message: "服务不可达，请确认本地服务已启动后重试",
    });
  }
  if (!res.ok || !res.body) return readErrorEnvelope(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const drain = (flush = false): void => {
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    if (flush && buffer.trim()) {
      blocks.push(buffer);
      buffer = "";
    }
    for (const block of blocks) {
      const lines = block.split(/\r?\n/);
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLines = lines.filter((line) => line.startsWith("data:"));
      if (!eventLine || dataLines.length === 0) continue;
      const type = eventLine.slice(6).replace(/^ /, "");
      const data = dataLines.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      try {
        opts.onFrame({ type, data: JSON.parse(data) });
      } catch {
        // 坏帧不阻断后续帧
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drain();
    }
    buffer += decoder.decode();
    drain(true);
    return null;
  } catch (err) {
    if ((err as Error).name === "AbortError") return null;
    return reportFailure({
      ok: false,
      code: "STREAM",
      message: "AI 回复连接中断，请重试",
    });
  }
}

/** multipart 单文件上传（附件端点；不走 JSON request()） */
export async function uploadFile<T>(path: string, file: File): Promise<ApiResult<T>> {
  const form = new FormData();
  form.append("file", file);
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", body: form });
  } catch (err) {
    return reportFailure({
      ok: false,
      code: "NETWORK",
      message: "服务不可达，请确认本地服务已启动后重试",
    });
  }
  if (!res.ok) return readErrorEnvelope(res);
  return { ok: true, data: (await res.json()) as T };
}
