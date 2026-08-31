// 自动 Agent Flow 的结构化结果工具；任务仍同时使用普通 Agent 的完整工具目录。
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import { setPoolAttention } from "../modules/pools/repo.js";
import { replaceDraftAuctionAssessments, replaceDraftPlaybook } from "../modules/plans/repo.js";
import { withAgentMutationLock } from "./mutation-lock.js";
import { insertToolAudit } from "./repo.js";
import { sha256Json } from "./hash.js";
import {
  ScheduledPoolAttentionSchema,
  AuctionAssessmentWriteSchema,
  DailyPlanWriteSchema,
  validateScheduledPoolAttentionInput,
  validateAuctionAssessmentWriteInput,
  validateDailyPlanWriteInput,
} from "./tool-validation.js";

const DAILY_PREFIX = "每日计划·";

function result(value: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 1) }], details: value };
}

async function auditError(pool: pg.Pool, sessionId: string, toolName: string, input: unknown): Promise<void> {
  await insertToolAudit(pool, {
    session_id: sessionId,
    tool_name: toolName,
    args: { redacted: true, args_sha256: sha256Json(input) },
    result_sha256: null,
    status: "error",
  }).catch(() => {});
}

export function buildJobPoolAttentionTool(deps: { pool: pg.Pool; sessionId: string }): AgentTool {
  return {
    name: "pool_attention_write",
    label: "维护每日计划近期关注",
    description:
      "仅维护已在短线池或长线池中的标的近期关注。mark 必须区分已符合/即将符合、写明证据与起止日期；clear 只能清理由每日计划自动创建的关注。不得新增标的、改变池角色或研究属性。",
    parameters: ScheduledPoolAttentionSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, rawInput, signal) => {
      try {
        if (signal?.aborted) throw new Error("每日计划关注维护已中断");
        const input = validateScheduledPoolAttentionInput(rawInput);
        const outcome = await withAgentMutationLock(deps.pool, async (client) => {
          const current = await client.query<{ attention_reason: string | null }>(
            `SELECT membership.attention_reason
               FROM pool_membership membership
               JOIN market_instrument instrument ON instrument.id = membership.instrument_id
              WHERE instrument.code = $1 AND membership.pool = $2 AND membership.effective_to IS NULL
              FOR UPDATE OF membership`,
            [input.code, input.pool],
          );
          const existingReason = current.rows[0]?.attention_reason ?? null;
          if (!current.rows[0]) throw new Error(`标的 ${input.code} 不在当前策略池中，自动作业不得绕过完整入池评估`);
          if (input.action === "clear" && !existingReason?.startsWith(DAILY_PREFIX)) {
            throw new Error(`标的 ${input.code} 的关注不是每日计划自动创建，自动作业不得清除`);
          }
          if (input.action === "mark" && existingReason && !existingReason.startsWith(DAILY_PREFIX)) {
            throw new Error(`标的 ${input.code} 已有人工关注原因，自动作业不得覆盖`);
          }
          const write = input.action === "mark"
            ? await setPoolAttention(client, {
                code: input.code,
                pool: input.pool,
                attention_reason: `${DAILY_PREFIX}${input.attention_status === "qualified" ? "已符合" : "即将符合"}：${input.attention_reason}`,
                attention_from: input.attention_from,
                attention_until: input.attention_until,
              })
            : await setPoolAttention(client, {
                code: input.code,
                pool: input.pool,
                attention_reason: null,
                attention_from: null,
                attention_until: null,
              });
          const summary = {
            code: input.code,
            pool: input.pool,
            action: input.action,
            previous_attention_reason: write.before.attention_reason,
            attention_reason: write.after.attention_reason,
            attention_from: write.after.attention_from,
            attention_until: write.after.attention_until,
          };
          await insertToolAudit(client, {
            session_id: deps.sessionId,
            tool_name: "pool_attention_write",
            args: input,
            result_sha256: sha256Json(summary),
            status: "ok",
          });
          return summary;
        });
        return result(outcome);
      } catch (error) {
        await auditError(deps.pool, deps.sessionId, "pool_attention_write", rawInput);
        throw error;
      }
    },
  };
}

export function buildJobDailyPlanTool(deps: {
  pool: pg.Pool;
  sessionId: string;
  runId: string;
}): AgentTool {
  return {
    name: "daily_plan_write",
    label: "写入每日计划盯防预案",
    description:
      "一次性提交本计划的结构化预案：position_action 为每笔真实持仓的次日执行预案；off_pool_opportunity 是打板机会的内部兼容名称，只写当前《打板策略》形成的有效信号。A 映射 A，B-抱团/B-主升兼容映射 B，精确信号等级、两类分数、路线名次与风险写入 headline/evidence_md。全量替换式写入，只能调用一次。",
    parameters: DailyPlanWriteSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, rawInput, signal) => {
      try {
        if (signal?.aborted) throw new Error("每日计划预案写入已中断");
        const input = validateDailyPlanWriteInput(rawInput);
        const outcome = await withAgentMutationLock(deps.pool, async (client) => {
          const write = await replaceDraftPlaybook(client, {
            source_job_run_id: deps.runId,
            items: input.items,
          });
          await insertToolAudit(client, {
            session_id: deps.sessionId,
            tool_name: "daily_plan_write",
            args: input,
            result_sha256: sha256Json(write),
            status: "ok",
          });
          return write;
        });
        return result(outcome);
      } catch (error) {
        await auditError(deps.pool, deps.sessionId, "daily_plan_write", rawInput);
        throw error;
      }
    },
  };
}

export function buildJobAuctionAssessmentTool(deps: {
  pool: pg.Pool;
  sessionId: string;
  runId: string;
}): AgentTool {
  return {
    name: "auction_assessment_write",
    label: "更新打板机会竞价复核",
    description:
      "一次性提交当前每日计划全部打板机会的 T+1 集合竞价复核。必须完整覆盖，不得增加或遗漏代码；前向验证期只允许继续观察、放弃或数据不足，任务成功后才在仪表盘“打板机会”中激活。",
    parameters: AuctionAssessmentWriteSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, rawInput, signal) => {
      try {
        if (signal?.aborted) throw new Error("集合竞价研判写入已中断");
        const input = validateAuctionAssessmentWriteInput(rawInput);
        const outcome = await withAgentMutationLock(deps.pool, async (client) => {
          const write = await replaceDraftAuctionAssessments(client, {
            source_job_run_id: deps.runId,
            items: input.items,
          });
          await insertToolAudit(client, {
            session_id: deps.sessionId,
            tool_name: "auction_assessment_write",
            args: input,
            result_sha256: sha256Json(write),
            status: "ok",
          });
          return write;
        });
        return result(outcome);
      } catch (error) {
        await auditError(deps.pool, deps.sessionId, "auction_assessment_write", rawInput);
        throw error;
      }
    },
  };
}
