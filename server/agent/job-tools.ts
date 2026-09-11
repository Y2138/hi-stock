// 结构化计划工具属于所有持久化 Agent 会话的共享目录；关联任务运行由会话自动解析。
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

function safeArgsHash(value: unknown): string {
  try {
    return sha256Json(value);
  } catch {
    return sha256Json({ unserializable: true, type: typeof value });
  }
}

async function auditError(pool: pg.Pool, sessionId: string | null, toolName: string, input: unknown): Promise<void> {
  await insertToolAudit(pool, {
    session_id: sessionId,
    tool_name: toolName,
    args: { redacted: true, args_sha256: safeArgsHash(input) },
    result_sha256: null,
    status: "error",
  }).catch(() => {});
}

async function associatedRunningJob(
  pool: pg.Pool,
  sessionId: string | null,
  code: "daily_plan_flow" | "auction_opportunity_assessment",
): Promise<string> {
  if (!sessionId) throw new Error(`${code} 结构化写入需要持久化 Agent 会话`);
  const result = await pool.query<{ id: string }>(
    `SELECT run.id::text
       FROM job_run run
       JOIN job_definition definition ON definition.id = run.job_id
      WHERE run.session_id = $1
        AND definition.code = $2
        AND run.status IN ('queued', 'running')
      ORDER BY CASE run.status WHEN 'running' THEN 0 ELSE 1 END, run.id DESC
      LIMIT 1`,
    [sessionId, code],
  );
  if (!result.rows[0]) throw new Error(`当前会话没有可写入的 ${code} 运行`);
  return result.rows[0].id;
}

export function buildJobPoolAttentionTool(deps: { pool: pg.Pool; sessionId: string | null }): AgentTool {
  return {
    name: "pool_attention_write",
    label: "批量维护每日计划近期关注",
    description:
      "一次提交本轮应保留的全部近期关注并在同一事务对账。items 中的 mark 是完整保留集合，遗漏的历史自动关注会被清除；没有候选时提交空 items。已持仓标的不会进入自动关注，误提交时服务端跳过并清除其旧自动关注；人工关注永不清除或覆盖。只维护已在短线池或长线池中的标的，不得新增标的、改变池角色或研究属性。qualified 表示信号已成立，不得有缺失条件；approaching 必须在 missing_signals 中逐项列出尚未成立的信号和次日确认标准（包含策略名称与实际阈值，只使用查询证据，不得臆造）。不同策略不可合成统一质量分，页面按已成立、待补信号分档展示。",
    parameters: ScheduledPoolAttentionSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, rawInput, signal) => {
      try {
        if (signal?.aborted) throw new Error("每日计划关注维护已中断");
        const input = validateScheduledPoolAttentionInput(rawInput);
        await associatedRunningJob(deps.pool, deps.sessionId, "daily_plan_flow");
        const outcome = await withAgentMutationLock(deps.pool, async (client) => {
          const items = [];
          const kept = new Set<string>();
          for (const item of input.items) {
            const current = await client.query<{ attention_reason: string | null; quantity: number }>(
              `SELECT membership.attention_reason, COALESCE(position.quantity, 0)::float8 AS quantity
                 FROM pool_membership membership
                 JOIN market_instrument instrument ON instrument.id = membership.instrument_id
                 LEFT JOIN portfolio_position position ON position.instrument_id = membership.instrument_id
                WHERE instrument.code = $1 AND membership.pool = $2 AND membership.effective_to IS NULL
                FOR UPDATE OF membership`,
              [item.code, item.pool],
            );
            const existingReason = current.rows[0]?.attention_reason ?? null;
            if (!current.rows[0]) throw new Error(`标的 ${item.code} 不在当前策略池中，自动作业不得绕过完整入池评估`);
            if (item.action === "mark" && current.rows[0].quantity > 0) {
              if (existingReason?.startsWith(DAILY_PREFIX)) {
                const write = await setPoolAttention(client, {
                  code: item.code,
                  pool: item.pool,
                  attention_reason: null,
                  attention_from: null,
                  attention_until: null,
                });
                items.push({
                  code: item.code,
                  pool: item.pool,
                  action: "clear",
                  previous_attention_reason: write.before.attention_reason,
                  attention_reason: null,
                  attention_from: null,
                  attention_until: null,
                  suppressed_by: "existing_position",
                });
              } else {
                items.push({
                  code: item.code,
                  pool: item.pool,
                  action: "skip",
                  previous_attention_reason: existingReason,
                  attention_reason: existingReason,
                  suppressed_by: "existing_position",
                });
              }
              continue;
            }
            if (item.action === "clear" && !existingReason?.startsWith(DAILY_PREFIX)) {
              throw new Error(`标的 ${item.code} 的关注不是每日计划自动创建，自动作业不得清除`);
            }
            if (item.action === "mark" && existingReason && !existingReason.startsWith(DAILY_PREFIX)) {
              throw new Error(`标的 ${item.code} 已有人工关注原因，自动作业不得覆盖`);
            }
            if (item.action === "mark") kept.add(`${item.pool}:${item.code}`);
            const write = item.action === "mark"
              ? await setPoolAttention(client, {
                  code: item.code,
                  pool: item.pool,
                  attention_reason: `${DAILY_PREFIX}${item.attention_status === "qualified" ? "已符合" : "即将符合"}：${item.attention_reason!.replace(/^每日计划·(?:已符合|即将符合)：/, "")}`,
                  attention_signal: { status: item.attention_status!, missing_signals: item.missing_signals ?? [] },
                  attention_from: item.attention_from!,
                  attention_until: item.attention_until!,
                })
              : await setPoolAttention(client, {
                  code: item.code,
                  pool: item.pool,
                  attention_reason: null,
                  attention_from: null,
                  attention_until: null,
                });
            items.push({
              code: item.code,
              pool: item.pool,
              action: item.action,
              previous_attention_reason: write.before.attention_reason,
              attention_signal: write.after.attention_signal,
              attention_reason: write.after.attention_reason,
              attention_from: write.after.attention_from,
              attention_until: write.after.attention_until,
            });
          }
          const stale = await client.query<{ code: string; pool: "short" | "long" }>(
            `SELECT instrument.code, membership.pool
               FROM pool_membership membership
               JOIN market_instrument instrument ON instrument.id = membership.instrument_id
              WHERE membership.effective_to IS NULL
                AND membership.attention_reason LIKE $1
                AND NOT ((membership.pool || ':' || instrument.code) = ANY($2::text[]))
              ORDER BY membership.pool, instrument.code
              FOR UPDATE OF membership`,
            [`${DAILY_PREFIX}%`, [...kept]],
          );
          for (const item of stale.rows) {
            const write = await setPoolAttention(client, {
              code: item.code,
              pool: item.pool,
              attention_reason: null,
              attention_from: null,
              attention_until: null,
            });
            items.push({
              code: item.code,
              pool: item.pool,
              action: "clear",
              previous_attention_reason: write.before.attention_reason,
              attention_reason: null,
              attention_from: null,
              attention_until: null,
              reconciled: true,
            });
          }
          const summary = { total: items.length, items };
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
  sessionId: string | null;
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
        const runId = await associatedRunningJob(deps.pool, deps.sessionId, "daily_plan_flow");
        const outcome = await withAgentMutationLock(deps.pool, async (client) => {
          const write = await replaceDraftPlaybook(client, {
            source_job_run_id: runId,
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
  sessionId: string | null;
}): AgentTool {
  return {
    name: "auction_assessment_write",
    label: "更新打板机会竞价复核",
    description:
      "一次性提交当前每日计划全部打板机会的 T+1 集合竞价复核。必须完整覆盖并写明一字延续、换手晋级、分歧、放弃或数据不足分类；小额实盘验证期只允许信号通过、放弃或数据不足，任务成功后才在仪表盘“打板机会”中激活。",
    parameters: AuctionAssessmentWriteSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, rawInput, signal) => {
      try {
        if (signal?.aborted) throw new Error("集合竞价研判写入已中断");
        const input = validateAuctionAssessmentWriteInput(rawInput);
        const runId = await associatedRunningJob(deps.pool, deps.sessionId, "auction_opportunity_assessment");
        const outcome = await withAgentMutationLock(deps.pool, async (client) => {
          const write = await replaceDraftAuctionAssessments(client, {
            source_job_run_id: runId,
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
