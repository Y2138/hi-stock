// node:http 路由：JSON 解析、静态页面托管、统一错误 {code,message}
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v1.0.md §五、§七
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { backtestRoutes } from "../modules/backtests/routes.js";
import { marketRoutes } from "../modules/market/routes.js";
import { positionRoutes } from "../modules/positions/routes.js";
import { listPoolView } from "../modules/pools/repo.js";
import { volumeRoutes } from "../volume/routes.js";
import { chatRoutes } from "../agent/routes.js";
import { llmConfigRoutes } from "../agent/ai/routes.js";
import { agentSettingsRoutes } from "../agent/settings-routes.js";
import { agentMetricRoutes } from "../agent/metrics-routes.js";
import { jobRoutes } from "../scheduler/routes.js";
import { jobPromptRoutes } from "../modules/job-prompts/routes.js";
import { analysisRoutes } from "../analysis/routes.js";
import { strategyRoutes } from "../modules/strategy/routes.js";
import { boardRoutes } from "../modules/boards/routes.js";
import { memoryRoutes } from "../modules/memory/routes.js";
import { systemSettingsRoutes } from "../system-settings-routes.js";

/** 统一 API 错误：携带 HTTP 状态码与稳定错误码 */
export class ApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const apiErrors = {
  badRequest: (message: string, extra?: Record<string, unknown>) =>
    new ApiError(400, "BAD_REQUEST", message, extra),
  notFound: (message: string) => new ApiError(404, "NOT_FOUND", message),
  conflict: (message: string, extra?: Record<string, unknown>) =>
    new ApiError(409, "CONFLICT", message, extra),
  forbidden: (message: string) => new ApiError(403, "FORBIDDEN", message),
  dbUnavailable: (message: string) => new ApiError(503, "DB_UNAVAILABLE", message),
};

interface RouteContext {
  pool: pg.Pool;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}

/** 返回 void/undefined 表示 handler 已自行接管响应（SSE 流式端点） */
type Handler = (ctx: RouteContext) => Promise<{ status?: number; data: unknown } | void>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  /** true 时跳过 JSON 请求体解析（multipart 上传等自行消费 req） */
  rawBody?: boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** 二期前端构建产物目录（web/ 构建输出，gitignored） */
const APP_DIR = path.join(here, "..", "public", "app");

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const regex = new RegExp(
    "^" +
      pattern.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return "([^/]+)";
      }) +
      "$",
  );
  return { regex, keys };
}

function route(
  method: string,
  pattern: string,
  handler: Handler,
  opts?: { rawBody?: boolean },
): Route {
  const { regex, keys } = compile(pattern);
  return { method, pattern: regex, keys, handler, rawBody: opts?.rawBody };
}

/** 读取并解析 JSON 请求体（上限 1MB），空体返回 {} */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw apiErrors.badRequest("请求体过大");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw apiErrors.badRequest("请求体不是合法 JSON");
  }
}

/** 把底层错误归类为统一 API 错误 */
function normalizeError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const e = err as NodeJS.ErrnoException & { code?: string };
  // 连接级失败（ECONNREFUSED 等）与 PG 08xxx 连接异常 → 503
  if (
    e.code === "ECONNREFUSED" ||
    e.code === "ENOTFOUND" ||
    e.code === "ETIMEDOUT" ||
    (typeof e.code === "string" && e.code.startsWith("08"))
  ) {
    return apiErrors.dbUnavailable("数据库不可用，请检查本地 PostgreSQL 是否已启动");
  }
  // PG CHECK 约束违反 → 400
  if (e.code === "23514") return apiErrors.badRequest(`字段取值违反约束：${e.message}`);
  // PG 唯一约束违反 → 409
  if (e.code === "23505") return apiErrors.conflict("唯一约束冲突：记录已存在");
  return new ApiError(500, "INTERNAL", "服务内部错误");
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function sendError(res: http.ServerResponse, err: ApiError): void {
  sendJson(res, err.httpStatus, {
    error: { code: err.code, message: err.message, ...err.extra },
  });
}

/** 读取目录内静态文件（防路径穿越），文件不存在或类型未知返回 null */
async function readStaticFile(root: string, rel: string): Promise<{ content: Buffer; type: string } | null> {
  const abs = path.resolve(root, rel.replace(/^\/+/, ""));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  const contentType = STATIC_CONTENT_TYPES[path.extname(abs)];
  if (!contentType) return null;
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return null;
    return { content: await fs.readFile(abs), type: contentType };
  } catch {
    return null;
  }
}

function sendFile(res: http.ServerResponse, file: { content: Buffer; type: string }): void {
  res.writeHead(200, { "content-type": file.type });
  res.end(file.content);
}

/** web 产物缺失时的引导页（设计 §三：缺失则 / 返回引导提示而不是 404） */
function sendBuildGuide(res: http.ServerResponse): void {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Stock 策略演进系统 · 前端未构建</title>
  <style>
    body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
           background: #faf6ef; color: #3d362e; display: flex; justify-content: center;
           align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #fffdf8; border: 1px solid #e7ddcd; border-radius: 14px;
            padding: 32px 40px; max-width: 520px; box-shadow: 0 2px 10px rgba(96,78,55,.08); }
    code { background: #f3ede1; border-radius: 6px; padding: 2px 8px;
           font-family: ui-monospace, Menlo, monospace; }
  </style>
</head>
<body>
  <div class="card">
    <h1>前端产物尚未构建</h1>
    <p>二期前端（Vue 3）需要先构建才能访问。请在 <code>project/</code> 目录下运行：</p>
    <p><code>npm run web:build</code></p>
    <p>构建完成后刷新本页即可；API 在 <code>/api/*</code> 下正常工作。</p>
  </div>
</body>
</html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

/**
 * 静态托管分发：
 * web 产物位于 server/public/app/，SPA fallback 到 app/index.html；
 *   产物缺失时 / 返回构建引导页
 */
async function serveStatic(reqPath: string, res: http.ServerResponse): Promise<void> {
  const appIndex = await fs.stat(path.join(APP_DIR, "index.html")).catch(() => null);
  if (!appIndex || !appIndex.isFile()) {
    sendBuildGuide(res);
    return;
  }

  if (reqPath !== "/") {
    const file = await readStaticFile(APP_DIR, reqPath);
    if (file) {
      sendFile(res, file);
      return;
    }
    // 带扩展名的资源未命中 → 真 404；其余路径走 SPA fallback
    if (path.extname(reqPath) !== "") {
      sendError(res, apiErrors.notFound("资源不存在"));
      return;
    }
  }

  const index = await readStaticFile(APP_DIR, "index.html");
  if (!index) {
    sendError(res, apiErrors.notFound("资源不存在"));
    return;
  }
  sendFile(res, index);
}

/** 组装 HTTP 服务：/api/* 走 JSON 路由，其余路径走静态页面 */
export function createApiServer(deps: { pool: pg.Pool }): http.Server {
  const { pool } = deps;

  const routes: Route[] = [
    route("GET", "/api/health", async () => {
      await pool.query("SELECT 1");
      return { data: { status: "ok" } };
    }),
    // 系统调度作业；一期 task_* 表仅作迁移历史，不再暴露写入口。
    route("GET", "/api/jobs", jobRoutes.list),
    route("PATCH", "/api/jobs/:code/control", jobRoutes.control),
    route("POST", "/api/jobs/:code/trigger", jobRoutes.trigger),
    route("GET", "/api/jobs/:code/runs", jobRoutes.runs),
    route("GET", "/api/jobs/:code/outputs", jobRoutes.outputs),
    route("GET", "/api/job-runs/:id", jobRoutes.runDetail),
    route("GET", "/api/job-outputs/:id", jobRoutes.outputDetail),
    route("GET", "/api/strategy/current", strategyRoutes.current),
    route("GET", "/api/strategy/evolutions", strategyRoutes.evolutions),
    route("GET", "/api/strategy/proposals", strategyRoutes.proposals),
    route("GET", "/api/strategy/proposals/:id/review", strategyRoutes.review),
    route("POST", "/api/strategy/proposals/:id/approve", strategyRoutes.approve),
    route("POST", "/api/strategy/proposals/:id/reject", strategyRoutes.reject),
    route("GET", "/api/job-prompts", jobPromptRoutes.list),
    route("GET", "/api/job-prompts/:id", jobPromptRoutes.get),
    route("GET", "/api/job-prompts/:id/revisions", jobPromptRoutes.revisions),
    route("GET", "/api/job-prompts/:id/revisions/:revision", jobPromptRoutes.revision),
    route("GET", "/api/analysis/runs", analysisRoutes.list),
    route("POST", "/api/analysis/run", analysisRoutes.run),
    route("GET", "/api/analysis/runs/:id", analysisRoutes.get),
    route("GET", "/api/backtests", backtestRoutes.listRuns),
    route("GET", "/api/backtests/:id", backtestRoutes.getRun),
    route("GET", "/api/memories", memoryRoutes.list),
    route("GET", "/api/memories/:id", memoryRoutes.get),
    // 二期 M1 任务六：行情/标的检索（技术设计 v2.0 §十，只追加不改既有端点）
    route("GET", "/api/instruments", marketRoutes.search),
    route("GET", "/api/instruments/search", marketRoutes.searchV2),
    route("GET", "/api/boards", boardRoutes.list),
    route("GET", "/api/boards/:code/constituents", boardRoutes.constituents),
    route("GET", "/api/market/bars", marketRoutes.bars),
    route("GET", "/api/market/structure", marketRoutes.structure),
    route("GET", "/api/market/coverage", marketRoutes.coverage),
    // 持仓、账户与短线/长线池。
    route("GET", "/api/positions", positionRoutes.list),
    route("GET", "/api/positions/changes", positionRoutes.changes),
    route("GET", "/api/account/snapshots", positionRoutes.accountSnapshots),
    route("GET", "/api/account/summary", positionRoutes.accountSummary),
    route("GET", "/api/pools/:pool", async ({ params }) => {
      if (params.pool !== "short" && params.pool !== "long") throw apiErrors.notFound("标的池不存在");
      return { data: await listPoolView(pool, params.pool) };
    }),
    // 二期 M1 收尾：数据卷 HTTP 路由（技术设计 v2.0 §九，只追加；恢复的前端二次确认在 web 侧）
    route("GET", "/api/volume/snapshots", volumeRoutes.listSnapshots),
    route("GET", "/api/volume/portable", volumeRoutes.listPortable),
    route("POST", "/api/volume/portable/export", volumeRoutes.exportPortable),
    route("POST", "/api/volume/portable/restore", volumeRoutes.restorePortable),
    route("POST", "/api/volume/export", volumeRoutes.exportNow),
    route("POST", "/api/volume/restore", volumeRoutes.restore),
    // 二期 M2：AI 对话（技术设计 v2.0 §6.3/§6.4/§十，只追加）
    route("GET", "/api/llm/status", chatRoutes.llmStatus),
    route("GET", "/api/llm/providers", llmConfigRoutes.list),
    route("POST", "/api/llm/providers", llmConfigRoutes.createProvider),
    route("PATCH", "/api/llm/providers/:id", llmConfigRoutes.updateProvider),
    route("DELETE", "/api/llm/providers/:id", llmConfigRoutes.deleteProvider),
    route("POST", "/api/llm/providers/:id/models", llmConfigRoutes.createModel),
    route("PATCH", "/api/llm/models/:id", llmConfigRoutes.updateModel),
    route("DELETE", "/api/llm/models/:id", llmConfigRoutes.deleteModel),
    route("POST", "/api/llm/models/:id/activate", llmConfigRoutes.activateModel),
    route("GET", "/api/system/settings", systemSettingsRoutes.get),
    route("PATCH", "/api/system/settings", systemSettingsRoutes.update),
    route("GET", "/api/agent/settings", agentSettingsRoutes.get),
    route("PATCH", "/api/agent/settings", agentSettingsRoutes.update),
    route("GET", "/api/agent/metrics/summary", agentMetricRoutes.summary),
    route("GET", "/api/chat/sessions", chatRoutes.listSessions),
    route("POST", "/api/chat/sessions", chatRoutes.createSession),
    route("PATCH", "/api/chat/sessions/:id", chatRoutes.updateSession),
    route("GET", "/api/chat/sessions/:id/messages", chatRoutes.listMessages),
    route("GET", "/api/chat/sessions/:id/attachments", chatRoutes.listAttachments),
    route("POST", "/api/chat/:sessionId/messages", chatRoutes.postMessage),
    route("POST", "/api/chat/:sessionId/control", chatRoutes.control),
    route("GET", "/api/chat/:sessionId/events", chatRoutes.events),
    route("POST", "/api/chat/:sessionId/attachments", chatRoutes.uploadAttachment, {
      rawBody: true,
    }),
    route("GET", "/api/confirmations", chatRoutes.listConfirmations),
    route("POST", "/api/confirmations/:id/approve", chatRoutes.approve),
    route("POST", "/api/confirmations/:id/reject", chatRoutes.reject),
    route("GET", "/api/audit/tools", chatRoutes.listToolAudits),
    route("GET", "/api/audit/cli-runs", chatRoutes.listCliRuns),
  ];

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(url.pathname);

      if (pathname.startsWith("/api/")) {
        const matched = routes.find(
          (r) => r.method === req.method && r.pattern.test(pathname),
        );
        if (!matched) throw apiErrors.notFound("接口不存在");
        const m = matched.pattern.exec(pathname)!;
        const params: Record<string, string> = {};
        matched.keys.forEach((k, i) => {
          params[k] = m[i + 1] ?? "";
        });
        const body =
          (req.method === "POST" || req.method === "PATCH") && !matched.rawBody
            ? await readJsonBody(req)
            : {};
        const result = await matched.handler({ pool, params, query: url.searchParams, body, req, res });
        // handler 返回 undefined 表示已自行接管响应（SSE 流式端点）
        if (result === undefined) return;
        sendJson(res, result.status ?? 200, result.data);
        return;
      }

      if (req.method === "GET") {
        await serveStatic(pathname, res);
        return;
      }
      throw apiErrors.notFound("资源不存在");
    } catch (err) {
      sendError(res, normalizeError(err));
    }
  });
}
