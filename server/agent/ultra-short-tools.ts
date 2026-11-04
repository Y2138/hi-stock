// 03 关注池复核写入：确定性引擎先给出候选，LLM 只能补充风险标签/复核结论，不能新增候选或上调优先级。
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import { insertToolAudit } from "./repo.js";
import { sha256Json } from "./hash.js";
import { validateToolInput } from "./tool-validation.js";
import { listWatchlist, updateWatchlist } from "../modules/ultra-short/repo.js";
import type { ReviewStatus, RiskLevel, UltraShortPriority } from "../modules/ultra-short/types.js";

const DateString = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const Priority = Type.Union([Type.Literal("P1"), Type.Literal("P2"), Type.Literal("P3")]);

const ReviewSchema = Type.Object({
  date: DateString,
  reviews: Type.Array(Type.Object({
    code: Type.String({ minLength: 1, maxLength: 32, pattern: "^[A-Za-z0-9._-]+$" }),
    review_status: Type.Optional(Type.Union([Type.Literal("pass"), Type.Literal("flag"), Type.Literal("invalid")])),
    risk_level: Type.Optional(Type.Union([
      Type.Literal("high"), Type.Literal("medium"), Type.Literal("low"), Type.Literal("unknown"),
    ])),
    risk_flags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 10 })),
    review_note: Type.Optional(Type.String({ maxLength: 500 })),
    review_sources: Type.Optional(Type.Array(Type.Object({
      title: Type.String({ minLength: 1, maxLength: 200 }),
      url: Type.Optional(Type.String({ maxLength: 500 })),
      published_at: Type.Optional(Type.String({ maxLength: 40 })),
      kind: Type.Optional(Type.String({ maxLength: 20 })),
    }), { maxItems: 10 })),
    priority: Type.Optional(Priority),
  }, { additionalProperties: false }), { minItems: 0, maxItems: 10 }),
}, { additionalProperties: false });

const PRIORITY_ORDER: Record<UltraShortPriority, number> = { P1: 1, P2: 2, P3: 3 };

function toolResult(value: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

/**
 * 复核写工具只允许：
 * - 把优先级下调或保持不变；
 * - 标记 pass/flag/invalid 与 high/medium/low/unknown 风险；
 * - 补充风险标签、复核说明和来源。
 * 不接受新增代码、总量、仓位、止损或任何买入指令。
 */
export function buildUltraShortReviewTool(deps: {
  pool: pg.Pool;
  sessionId: string | null;
  jobCode?: string;
}): AgentTool {
  return {
    name: "ultra_short_review_write",
    label: "写入超短关注池复核",
    description: "只对任务提示词中已由服务端确定性生成的超短关注池逐只写复核结论：review_status、risk_level、risk_flags、review_note、review_sources，可用 priority 下调优先级（P1→P2/P3、P2→P3），不能上调、不能新增代码、不能改总量/仓位/止损。服务端拒绝未知代码和上调优先级。",
    parameters: ReviewSchema,
    execute: async (_id, raw) => {
      const input = validateToolInput<Static<typeof ReviewSchema>>("ultra_short_review_write", ReviewSchema, raw);
      if (deps.jobCode !== "limit_up_close_scan") throw new Error("ultra_short_review_write 只允许收盘打板任务使用");
      // 模型容易把“数据日”当“关注日”传进来；服务端只认最近一次生成的关注池。
      const latest = (await deps.pool.query<{ target_date: string | null }>(
        "SELECT max(target_date)::text AS target_date FROM ultra_short_watchlist",
      )).rows[0]?.target_date ?? null;
      const date = latest ?? input.date;
      const rows = await listWatchlist(deps.pool, date);
      const byCode = new Map(rows.map((row) => [row.code, row]));
      const updated: Array<{ code: string; review_status: ReviewStatus; risk_level: RiskLevel; priority: UltraShortPriority }> = [];
      const rejected: Array<{ code: string; reason: string }> = [];
      for (const review of input.reviews) {
        const row = byCode.get(review.code);
        if (!row) {
          rejected.push({ code: review.code, reason: "不在目标日关注池" });
          continue;
        }
        if (review.priority && PRIORITY_ORDER[review.priority] < PRIORITY_ORDER[row.priority]) {
          rejected.push({ code: review.code, reason: "不允许上调优先级" });
          continue;
        }
        const nextPriority = review.priority ?? row.priority;
        const nextStatus = review.review_status ?? row.review_status;
        const nextRisk = review.risk_level ?? row.risk_level;
        await updateWatchlist(deps.pool, date, review.code, {
          priority: nextPriority,
          review_status: nextStatus,
          risk_level: nextRisk,
          ...(review.risk_flags ? { risk_flags: review.risk_flags } : {}),
          ...(review.review_note !== undefined ? { review_note: review.review_note } : {}),
          ...(review.review_sources ? { review_sources: review.review_sources } : {}),
        });
        updated.push({ code: review.code, review_status: nextStatus, risk_level: nextRisk, priority: nextPriority });
      }
      const value = {
        date,
        ...(date !== input.date ? { requested_date: input.date, notice: "已按最近一次关注池关注日写入" } : {}),
        updated,
        rejected,
      };
      await insertToolAudit(deps.pool, {
        session_id: deps.sessionId,
        tool_name: "ultra_short_review_write",
        args: input,
        result_sha256: sha256Json(value),
        status: "ok",
      });
      return toolResult(value);
    },
  };
}
