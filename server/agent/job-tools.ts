// 结构化计划工具属于所有持久化 Agent 会话的共享目录；关联任务运行由会话自动解析。
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import { WATCH_POOL, setPoolAttentionEntry } from "../modules/pools/repo.js";
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
  codes: readonly string[],
): Promise<{ id: string; code: string; strategy_code: string | null }> {
  if (!sessionId) throw new Error(`${codes.join("/")} 结构化写入需要持久化 Agent 会话`);
  const result = await pool.query<{ id: string; code: string; strategy_code: string | null }>(
    `SELECT run.id::text, definition.code, definition.strategy_code
       FROM job_run run
       JOIN job_definition definition ON definition.id = run.job_id
      WHERE run.session_id = $1
        AND definition.code = ANY($2::text[])
        AND run.status IN ('queued', 'running')
      ORDER BY CASE run.status WHEN 'running' THEN 0 ELSE 1 END, run.id DESC
      LIMIT 1`,
    [sessionId, codes],
  );
  if (!result.rows[0]) throw new Error(`当前会话没有可写入的 ${codes.join("/")} 运行`);
  return result.rows[0];
}

/** 允许向关注池写入自动关注的定时评估任务；来源隔离，各自对账，互不清除。 */
const POOL_ATTENTION_JOBS = [
  "daily_plan_flow",
  "nightly_sector_opportunity_scan",
  "value_anchor_opportunity_scan",
] as const;

export function buildJobPoolAttentionTool(deps: { pool: pg.Pool; sessionId: string | null }): AgentTool {
  return {
    name: "pool_attention_write",
    label: "批量维护关注池自动关注",
    description:
      "一次提交本轮应保留的全部自动关注并在同一事务按策略来源对账。items 中的 mark 是本任务来源的完整保留集合，遗漏的本策略历史关注会被清除；没有候选时提交空 items。已持仓标的不会进入自动关注，误提交时服务端跳过并清除其旧本来源关注；其他策略来源与人工关注互不影响、不得覆盖。只维护已在关注池中的标的，不得新增标的、改变角色或研究属性。qualified 表示信号已成立，不得有缺失条件；approaching 必须在 missing_signals 中逐项列出尚未成立的信号和次日确认标准（包含策略名称与实际阈值，只使用查询证据，不得臆造）。不同策略来源的关注在页面并列展示，不合成统一质量分。",
    parameters: ScheduledPoolAttentionSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, rawInput, signal) => {
      try {
        if (signal?.aborted) throw new Error("关注池维护已中断");
        const input = validateScheduledPoolAttentionInput(rawInput);
        const { code: jobCode, strategy_code: boundStrategyCode } = await associatedRunningJob(deps.pool, deps.sessionId, POOL_ATTENTION_JOBS);
        const strategyCode = boundStrategyCode ?? (jobCode === "daily_plan_flow" ? "swing" : null);
        if (!strategyCode) throw new Error(`任务 ${jobCode} 未绑定关注策略`);
        const outcome = await withAgentMutationLock(deps.pool, async (client) => {
          const items = [];
          const kept = new Set<string>();
          for (const item of input.items) {
            const current = await client.query<{ quantity: number }>(
              `SELECT COALESCE(position.quantity, 0)::float8 AS quantity
                 FROM market_instrument instrument
                 LEFT JOIN portfolio_position position ON position.instrument_id = instrument.id
                WHERE instrument.code = $1`,
              [item.code],
            );
            const held = (current.rows[0]?.quantity ?? 0) > 0;
            const existing = held
              ? await client.query<{ source_job: string }>(
                  `SELECT entry.source_job FROM pool_attention_entry entry
                    JOIN market_instrument instrument ON instrument.id = entry.instrument_id
                   WHERE instrument.code = $1 AND entry.source_job = $2`,
                  [item.code, jobCode],
                )
              : { rows: [] as Array<{ source_job: string }> };
            if (!current.rows[0]) throw new Error(`未知标的代码：${item.code}`);
            const membership = await client.query<{ id: string }>(
              `SELECT membership.id::text FROM pool_membership membership
                 JOIN market_instrument instrument ON instrument.id = membership.instrument_id
                WHERE instrument.code = $1 AND membership.pool = $2 AND membership.effective_to IS NULL`,
              [item.code, WATCH_POOL],
            );
            if (!membership.rows[0]) {
              throw new Error(`标的 ${item.code} 不在关注池中，自动作业不得绕过完整入池评估`);
            }
            if (item.action === "mark" && held) {
              if (existing.rows[0]) {
                const write = await setPoolAttentionEntry(client, {
                  code: item.code, source_job: jobCode, strategy_code: strategyCode, status: item.attention_status!,
                  reason: null,
                });
                items.push({
                  code: item.code, action: "clear",
                  previous_reason: write.before?.reason ?? null,
                  suppressed_by: "existing_position",
                });
              } else {
                items.push({ code: item.code, action: "skip", suppressed_by: "existing_position" });
              }
              continue;
            }
            if (item.action === "mark") kept.add(item.code);
            const write = await setPoolAttentionEntry(client, {
              code: item.code,
              source_job: jobCode,
              strategy_code: strategyCode,
              data_date: input.data_date ?? null,
              stale_reason: null,
              status: item.action === "mark" ? item.attention_status! : "qualified",
              reason: item.action === "mark" ? item.attention_reason! : null,
              missing_signals: item.action === "mark" ? item.missing_signals ?? [] : [],
              valid_from: item.attention_from ?? undefined,
              valid_until: item.action === "mark" ? item.attention_until ?? null : null,
            });
            items.push({
              code: item.code,
              action: item.action,
              previous_reason: write.before?.reason ?? null,
              reason: write.after?.reason ?? null,
              attention_from: write.after?.valid_from ?? null,
              attention_until: write.after?.valid_until ?? null,
            });
          }
          if (input.evaluation_status === "partial") {
            await client.query(
              `UPDATE pool_attention_entry SET stale_reason=$2, updated_at=now()
                WHERE source_type='strategy' AND strategy_code=$1
                  AND NOT (instrument_id IN (SELECT id FROM market_instrument WHERE code = ANY($3::text[])))`,
              [strategyCode, input.reason, [...kept]],
            );
          }
          const stale = input.evaluation_status === "success" ? await client.query<{ code: string }>(
            `SELECT instrument.code
               FROM pool_attention_entry entry
               JOIN market_instrument instrument ON instrument.id = entry.instrument_id
              WHERE entry.source_type = 'strategy' AND entry.strategy_code = $1
                AND NOT (instrument.code = ANY($2::text[]))
              ORDER BY instrument.code`,
            [strategyCode, [...kept]],
          ) : { rows: [] as Array<{ code: string }> };
          for (const item of stale.rows) {
            const write = await setPoolAttentionEntry(client, {
              code: item.code, source_job: jobCode, strategy_code: strategyCode, status: "qualified", reason: null,
            });
            items.push({
              code: item.code, action: "clear",
              previous_reason: write.before?.reason ?? null,
              reconciled: true,
            });
          }
          const summary = { source_job: jobCode, strategy_code: strategyCode, evaluation_status: input.evaluation_status, total: items.length, items };
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
        const { id: runId } = await associatedRunningJob(deps.pool, deps.sessionId, ["daily_plan_flow"]);
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
    label: "写入跨域集合竞价研判",
    description:
      "一次提交三类竞价结果：items 完整覆盖每日计划打板机会；scope_items 按 target_key 完整覆盖全部真实持仓与每条有效关注来源。持仓只作原计划匹配/风险升级/数据不足判断，关注按来源策略补齐条件，打板按打板策略门禁分类。服务端对账后由任务成功统一激活；不成交、不改持仓或关注。",
    parameters: AuctionAssessmentWriteSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, rawInput, signal) => {
      try {
        if (signal?.aborted) throw new Error("集合竞价研判写入已中断");
        const input = validateAuctionAssessmentWriteInput(rawInput);
        const { id: runId } = await associatedRunningJob(deps.pool, deps.sessionId, ["auction_opportunity_assessment"]);
        const outcome = await withAgentMutationLock(deps.pool, async (client) => {
          const write = await replaceDraftAuctionAssessments(client, {
            source_job_run_id: runId,
            items: input.items,
            scope_items: input.scope_items,
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
