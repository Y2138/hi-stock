// 自动 Agent Flow 的窄权限工具：只能维护当前标的池成员的短期关注状态。
// 不开放角色、研究属性、持仓、策略或任意 SQL 写入。
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import { setPoolAttention } from "../modules/pools/repo.js";
import { withAgentMutationLock } from "./mutation-lock.js";
import { insertToolAudit } from "./repo.js";
import { sha256Json } from "./hash.js";
import {
  ScheduledPoolAttentionSchema,
  validateScheduledPoolAttentionInput,
} from "./tool-validation.js";

const DAILY_PREFIX = "每日计划·";

function result(value: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 1) }], details: value };
}

async function auditError(pool: pg.Pool, sessionId: string, input: unknown): Promise<void> {
  await insertToolAudit(pool, {
    session_id: sessionId,
    tool_name: "pool_attention_write",
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
        await auditError(deps.pool, deps.sessionId, rawInput);
        throw error;
      }
    },
  };
}
