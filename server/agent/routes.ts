// 对话/确认制/审计 HTTP 路由（M2）
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §6.3、§6.4、§十
// SSE 协议（§6.4）：
//   POST /api/chat/:sessionId/messages 建立流，帧类型 text/tool_start/tool_update/tool_end/
//   confirmation_pending/done/error（event: <类型>\ndata: <JSON>\n\n）。
//   确认结果推送通道（二选一，已选定）：独立的 GET /api/chat/:sessionId/events 长连 SSE，
//   approve/reject 时经 agent/events.ts 进程内总线推送 confirmation_result 帧；
//   不采用“下一条消息流携带”方案。
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import busboy from "busboy";
import type http from "node:http";
import type pg from "pg";
import type { ImageContent } from "@earendil-works/pi-ai";
import { ApiError, apiErrors } from "../http/router.js";
import { PROJECT_ROOT } from "../config.js";
import { getLlmConfigByModelId } from "./ai/repo.js";
import { resolveActiveChatModel } from "./ai/runtime.js";
import { persistAndPublishSessionEvent } from "./events.js";
import { controlAgentRun, type AgentControlAction } from "./run-control.js";
import { runAgentSessionTurn } from "./session-runner.js";
import { streamChatSessionEvents, streamCursor } from "./session-routes.js";
import { getAgentSettings } from "./settings.js";
import {
  approveConfirmation,
  listConfirmations,
  rejectConfirmation,
} from "./confirmations.js";
import {
  createSession,
  getAttachment,
  getSession,
  insertAttachment,
  listAttachments,
  listCliRuns,
  listMessages,
  listSessions,
  listToolAudits,
  updateSession,
} from "./repo.js";

interface Ctx {
  pool: pg.Pool;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}

/** 上传根目录（gitignored：project/server/uploads/） */
export const UPLOADS_DIR = path.join(PROJECT_ROOT, "server", "uploads");
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

function sendSse(res: http.ServerResponse, type: string, data: unknown): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function writeSseHead(res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
    connection: "keep-alive",
  });
  res.flushHeaders();
}

function parseLimit(query: URLSearchParams, fallback: number, max: number): number {
  const raw = query.get("limit");
  const limit = raw ? Number(raw) : fallback;
  if (!Number.isInteger(limit) || limit <= 0 || limit > max) {
    throw apiErrors.badRequest(`limit 非法：${raw}`);
  }
  return limit;
}

export const chatRoutes = {
  /**
   * GET /api/llm/status：模型配置与能力探测（M2 前端波次追加，additive only）。
   * 返回 {configured, provider, model, vision}；未配置/未知 provider 时 configured=false
   * 并附 code/message（复用 AI 层数据库解析错误语义，仍返回 200 由前端降级）。
   */
  async llmStatus({ pool }: Ctx) {
    const agentSettings = await getAgentSettings(pool);
    try {
      const resolved = await resolveActiveChatModel(pool);
      return {
        data: {
          configured: true,
          provider: resolved.provider,
          provider_name: resolved.providerName,
          model: resolved.modelId,
          vision: resolved.model.input.includes("image"),
          yolo_mode: agentSettings.yolo_mode,
        },
      };
    } catch (err) {
      if (err instanceof ApiError) {
        return {
          data: {
            configured: false,
            provider: null,
            provider_name: null,
            model: null,
            vision: false,
            yolo_mode: agentSettings.yolo_mode,
            code: err.code,
            message: err.message,
          },
        };
      }
      throw err;
    }
  },

  /** GET /api/chat/sessions（默认未归档；?archived=1 查已归档） */
  async listSessions({ pool, query }: Ctx) {
    return { data: await listSessions(pool, { archivedOnly: query.get("archived") === "1" }) };
  },

  /** POST /api/chat/sessions {title?} */
  async createSession({ pool, body }: Ctx) {
    const b = (body ?? {}) as Record<string, unknown>;
    if (b.title !== undefined && typeof b.title !== "string") {
      throw apiErrors.badRequest("title 必须是字符串");
    }
    const sessionType = b.session_type ?? "interactive";
    if (!["interactive", "backtest", "strategy_evolution"].includes(String(sessionType))) {
      throw apiErrors.badRequest("页面只能新建普通、回测或策略演进会话");
    }
    if (
      b.parent_session_id !== undefined &&
      b.parent_session_id !== null &&
      (typeof b.parent_session_id !== "string" || !/^\d+$/.test(b.parent_session_id))
    ) {
      throw apiErrors.badRequest("parent_session_id 必须是数字字符串");
    }
    if (typeof b.parent_session_id === "string" && !(await getSession(pool, b.parent_session_id))) {
      throw apiErrors.notFound(`父会话不存在：${b.parent_session_id}`);
    }
    return {
      status: 201,
      data: await createSession(pool, {
        title: b.title as string | undefined,
        session_type: sessionType as "interactive" | "backtest" | "strategy_evolution",
        parent_session_id: b.parent_session_id as string | null | undefined,
      }),
    };
  },

  /** PATCH /api/chat/sessions/:id {title? / archived? / model_id?} */
  async updateSession({ pool, params, body }: Ctx) {
    const existing = await getSession(pool, params.id!);
    if (!existing) throw apiErrors.notFound(`会话不存在：${params.id}`);
    const b = (body ?? {}) as Record<string, unknown>;
    if (b.title !== undefined && (typeof b.title !== "string" || !b.title.trim())) {
      throw apiErrors.badRequest("title 必须是非空字符串");
    }
    if (b.archived !== undefined && typeof b.archived !== "boolean") {
      throw apiErrors.badRequest("archived 必须是布尔值");
    }
    if (
      b.model_id !== undefined &&
      (typeof b.model_id !== "string" || !/^\d+$/.test(b.model_id))
    ) {
      throw apiErrors.badRequest("model_id 必须是数字字符串");
    }
    if (b.title === undefined && b.archived === undefined && b.model_id === undefined) {
      throw apiErrors.badRequest("缺少可更新字段（title / archived / model_id）");
    }
    if (typeof b.model_id === "string") {
      const config = await getLlmConfigByModelId(pool, b.model_id);
      if (!config) throw apiErrors.notFound(`模型不存在：${b.model_id}`);
      if (!config.provider.enabled || !config.model.enabled) {
        throw apiErrors.conflict("模型或所属厂商已停用，请先在设置页启用");
      }
      if (!config.provider.api_key_configured) {
        throw apiErrors.conflict(`模型厂商 ${config.provider.name} 尚未配置 API Key`);
      }
    }
    const row = await updateSession(pool, params.id!, {
      title: typeof b.title === "string" ? b.title.trim() : undefined,
      archived: b.archived as boolean | undefined,
      model_id: b.model_id as string | undefined,
    });
    if (!row) throw apiErrors.notFound(`会话不存在：${params.id}`);
    return { data: row };
  },

  /** GET /api/chat/sessions/:id/messages */
  async listMessages({ pool, params }: Ctx) {
    const session = await getSession(pool, params.id!);
    if (!session) throw apiErrors.notFound(`会话不存在：${params.id}`);
    return { data: await listMessages(pool, session.id) };
  },

  /** GET /api/chat/sessions/:id/attachments */
  async listAttachments({ pool, params }: Ctx) {
    const session = await getSession(pool, params.id!);
    if (!session) throw apiErrors.notFound(`会话不存在：${params.id}`);
    return { data: await listAttachments(pool, session.id) };
  },

  /**
   * POST /api/chat/:sessionId/messages（SSE 流）
   * body {text, attachment_ids?}；前置校验失败返回普通 JSON 错误，
   * 建流后 LLM/工具错误一律映射为 error 帧（设计 §6.1：LLM 错误不 throw）。
   */
  async postMessage({ pool, params, body, res }: Ctx): Promise<void> {
    const session = await getSession(pool, params.sessionId!);
    if (!session) throw apiErrors.notFound(`会话不存在：${params.sessionId}`);
    if (session.archived) {
      throw new ApiError(409, "SESSION_ARCHIVED", "会话已归档，仅可回看历史，不能继续发送消息");
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!text) throw apiErrors.badRequest("缺少 text");
    const attachmentIds = Array.isArray(b.attachment_ids) ? (b.attachment_ids as unknown[]) : [];
    if (attachmentIds.some((v) => typeof v !== "string" && typeof v !== "number")) {
      throw apiErrors.badRequest("attachment_ids 必须是 id 数组");
    }

    // 模型解析（未配置/未知 provider/未知模型 → 明确 JSON 错误，不建流）
    const resolved = await resolveActiveChatModel(pool, session.model_id);

    // 图片附件：读文件 → base64 ImageContent；vision 探测（model.input.includes('image')）
    const images: ImageContent[] = [];
    for (const rawId of attachmentIds) {
      const att = await getAttachment(pool, String(rawId));
      if (!att || att.session_id !== session.id) {
        throw apiErrors.notFound(`附件不存在或不属于本会话：${rawId}`);
      }
      images.push({
        type: "image",
        data: (await fsp.readFile(path.join(UPLOADS_DIR, att.path))).toString("base64"),
        mimeType: att.mime_type,
      });
    }
    if (images.length > 0 && !resolved.model.input.includes("image")) {
      throw apiErrors.badRequest(
        `当前模型 ${resolved.provider}/${resolved.modelId} 不支持图片输入，请切换支持 vision 的模型`,
      );
    }

    writeSseHead(res);
    try {
      const turn = await runAgentSessionTurn({
        pool,
        sessionId: session.id,
        text,
        images,
        titleFromText: true,
        manageSessionStatus: true,
        onFrame: (frame) => {
          try {
            sendSse(res, frame.type, frame.data);
          } catch {
            /* SSE 写入失败不阻断 agent loop 与持久化 */
          }
        },
      });
      const lastAssistant = turn.lastAssistant as
        | { stopReason?: string; errorMessage?: string }
        | null;
      if (turn.aborted || lastAssistant?.stopReason === "aborted") {
        sendSse(res, "aborted", { run_id: turn.runId, message: "已中断" });
      } else if (turn.llmError || lastAssistant?.stopReason === "error") {
        sendSse(res, "error", {
          code: "LLM_ERROR",
          message: turn.llmError ?? lastAssistant?.errorMessage ?? "LLM 调用失败",
        });
      } else {
        sendSse(res, "done", { message: lastAssistant ?? null });
      }
    } catch (err) {
      sendSse(res, "error", { code: "INTERNAL", message: (err as Error).message });
    } finally {
      res.end();
    }
  },

  /**
   * POST /api/chat/:sessionId/control
   * abort 真正取消服务端当前运行；steer 在下一执行边界注入；follow_up 在本轮自然结束后排队。
   */
  async control({ pool, params, body }: Ctx) {
    const session = await getSession(pool, params.sessionId!);
    if (!session) throw apiErrors.notFound(`会话不存在：${params.sessionId}`);
    const b = (body ?? {}) as Record<string, unknown>;
    const action = b.action as AgentControlAction;
    if (!(["abort", "steer", "follow_up"] as const).includes(action)) {
      throw apiErrors.badRequest("action 必须是 abort / steer / follow_up");
    }
    if (typeof b.run_id !== "string" || !b.run_id.trim()) {
      throw apiErrors.badRequest("缺少当前 run_id");
    }
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (action !== "abort" && !text) throw apiErrors.badRequest("干预或排队消息不能为空");
    if (text.length > 20_000) throw apiErrors.badRequest("消息超过 20000 字符上限");

    let run;
    try {
      run = controlAgentRun({
        sessionId: session.id,
        expectedRunId: b.run_id.trim(),
        action,
        text,
      });
    } catch (error) {
      const code = (error as Error).message;
      if (code === "AGENT_NOT_RUNNING") {
        throw new ApiError(409, code, "当前会话没有运行中的 Agent，请刷新会话状态");
      }
      if (code === "AGENT_RUN_MISMATCH") {
        throw new ApiError(409, code, "当前运行已切换，本次控制请求未执行");
      }
      if (code === "AGENT_CONTROL_TEXT_REQUIRED") {
        throw apiErrors.badRequest("干预或排队消息不能为空");
      }
      throw error;
    }
    await persistAndPublishSessionEvent(pool, {
      session_id: session.id,
      event_type: "agent_control",
      data: { action, run_id: run.runId },
    });
    return {
      status: 202,
      data: {
        accepted: true,
        action,
        run_id: run.runId,
        timing: action === "steer" ? "next_step" : action === "follow_up" ? "next_turn" : "now",
      },
    };
  },

  /**
   * GET /api/chat/:sessionId/events（长连 SSE）
   * 确认结果推送通道：approve/reject 后收到 confirmation_result 帧。
   */
  async events({ pool, params, query, req, res }: Ctx): Promise<void> {
    const session = await getSession(pool, params.sessionId!);
    if (!session) throw apiErrors.notFound(`会话不存在：${params.sessionId}`);
    await streamChatSessionEvents({
      pool,
      sessionId: session.id,
      after: streamCursor(query),
      req,
      res,
    });
  },

  /**
   * POST /api/chat/:sessionId/attachments（multipart，单文件，≤10MB，仅图片）
   * 落盘 project/server/uploads/{sessionId}/{uuid}{ext} 并登记 chat_attachment。
   */
  async uploadAttachment({ pool, params, req }: Ctx) {
    const session = await getSession(pool, params.sessionId!);
    if (!session) throw apiErrors.notFound(`会话不存在：${params.sessionId}`);
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw apiErrors.badRequest("需要 multipart/form-data 上传");
    }

    const saved = await new Promise<{ relPath: string; mimeType: string; size: number; sha256: string }>(
      (resolve, reject) => {
        const bb = busboy({
          headers: req.headers as Record<string, string>,
          limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 },
        });
        let result: { relPath: string; mimeType: string; size: number; sha256: string } | null = null;
        let writeDone: Promise<unknown> | null = null;
        let settled = false;
        const fail = (err: unknown) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        };

        bb.on("file", (field, file, info) => {
          const mime = info.mimeType || "application/octet-stream";
          const ext = path.extname(info.filename ?? "").toLowerCase();
          if (field !== "file" || !mime.startsWith("image/") || !IMAGE_EXT.has(ext)) {
            file.resume();
            fail(apiErrors.badRequest("仅支持图片文件（png/jpg/jpeg/gif/webp/bmp），字段名 file"));
            return;
          }
          // ≤10MB 单文件：内存收集后一次性写盘（同步绑定 data/end，避免流时序丢数据）
          const chunks: Buffer[] = [];
          let size = 0;
          let tooLarge = false;
          file.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            size += chunk.length;
          });
          file.on("limit", () => {
            tooLarge = true;
          });
          file.on("end", () => {
            if (settled) return;
            if (tooLarge) {
              fail(apiErrors.badRequest(`文件超过 ${UPLOAD_MAX_BYTES / 1024 / 1024}MB 上限`));
              return;
            }
            const buf = Buffer.concat(chunks);
            const relPath = path.join(session.id, `${crypto.randomUUID()}${ext}`);
            result = {
              relPath,
              mimeType: mime,
              size,
              sha256: crypto.createHash("sha256").update(buf).digest("hex"),
            };
            writeDone = fsp
              .mkdir(path.join(UPLOADS_DIR, session.id), { recursive: true })
              .then(() => fsp.writeFile(path.join(UPLOADS_DIR, relPath), buf));
            writeDone.catch(fail);
          });
        });
        bb.on("error", fail);
        bb.on("finish", () => {
          // 等文件写盘完成再返回
          void (writeDone ?? Promise.resolve()).then(() => {
            if (settled) return;
            if (!result) {
              fail(apiErrors.badRequest("请求中没有文件（字段名 file）"));
              return;
            }
            settled = true;
            resolve(result);
          }, fail);
        });
        req.pipe(bb);
      },
    );

    const row = await insertAttachment(pool, {
      session_id: session.id,
      path: saved.relPath,
      mime_type: saved.mimeType,
      size_bytes: saved.size,
      sha256: saved.sha256,
    });
    return { status: 201, data: row };
  },

  /** GET /api/confirmations?status=&session_id=&limit= */
  async listConfirmations({ pool, query }: Ctx) {
    const status = query.get("status") ?? undefined;
    if (status && !["pending", "approved", "rejected", "expired"].includes(status)) {
      throw apiErrors.badRequest(`status 非法：${status}`);
    }
    return {
      data: await listConfirmations(pool, {
        status,
        session_id: query.get("session_id") ?? undefined,
        limit: parseLimit(query, 50, 500),
      }),
    };
  },

  /** POST /api/confirmations/:id/approve：执行真实写入 + 回填 result + 审计 + 事件推送 */
  async approve({ pool, params }: Ctx) {
    return { data: await approveConfirmation(pool, params.id!) };
  },

  /** POST /api/confirmations/:id/reject：只留审计 */
  async reject({ pool, params }: Ctx) {
    return { data: await rejectConfirmation(pool, params.id!) };
  },

  /** GET /api/audit/tools?limit= */
  async listToolAudits({ pool, query }: Ctx) {
    return { data: await listToolAudits(pool, parseLimit(query, 100, 1000)) };
  },

  /** GET /api/audit/cli-runs?limit=（M4 占位：表已建，暂无逻辑写入） */
  async listCliRuns({ pool, query }: Ctx) {
    return { data: await listCliRuns(pool, parseLimit(query, 100, 1000)) };
  },
};
