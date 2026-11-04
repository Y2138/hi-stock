// 结构化计划工具属于所有持久化 Agent 会话的共享目录；关联任务运行由会话自动解析。
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import { saveNightlyShortlist, saveStrategyShortlist } from "../modules/selection/service.js";
import { attentionValidUntil, reconcileAttentionRemainder, strategyAttentionCodes } from "../modules/pools/attention-lifecycle.js";
import { ensureStrategyPoolMemberProfile, WATCH_POOL, setPoolAttentionEntry } from "../modules/pools/repo.js";
import { replaceDraftAuctionAssessments, replaceDraftPlaybook, replaceDraftScenarios, replaceEveningPreview } from "../modules/plans/repo.js";
import { withAgentMutationLock } from "./mutation-lock.js";
import { insertToolAudit } from "./repo.js";
import { sha256Json } from "./hash.js";
import { writeMarketNews } from "../modules/market-news/repo.js";
import {
  ScheduledPoolAttentionSchema,
  AuctionAssessmentWriteSchema,
  DailyPlanWriteSchema,
  DailyPlanScenarioWriteSchema,
  EveningPreviewWriteSchema,
  validateScheduledPoolAttentionInput,
  validateAuctionAssessmentWriteInput,
  validateDailyPlanWriteInput,
  validateDailyPlanScenarioWriteInput,
  validateEveningPreviewWriteInput,
  PoolNewsWriteSchema,
  validatePoolNewsWriteInput,
  type PoolNewsWriteInput,
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
): Promise<{ id: string; code: string; strategy_code: string | null; target_date: string; started_at: string }> {
  if (!sessionId) throw new Error(`${codes.join("/")} 结构化写入需要持久化 Agent 会话`);
  const result = await pool.query<{ id: string; code: string; strategy_code: string | null; target_date: string; started_at: string }>(
    `SELECT run.id::text, definition.code, definition.strategy_code, run.target_date::text, COALESCE(run.started_at,run.created_at)::text AS started_at
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
  "nightly_sector_opportunity_scan",
] as const;

export function buildPoolNewsWriteTool(deps: { pool: pg.Pool; sessionId: string | null }): AgentTool {
  return {
    name: "pool_news_write",
    label: "写入盘前消息面快照",
    description: "一次性写入本次盘前消息快照和消息卡片。只保存最近 48 小时内已核验的公开消息，并将 codes 关联到标的；不修改策略、关注池或交易数据。",
    parameters: PoolNewsWriteSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, rawInput, signal) => {
      if (signal?.aborted) throw new Error("消息面写入已中断");
      const input: PoolNewsWriteInput = validatePoolNewsWriteInput(rawInput);
      const running = await associatedRunningJob(deps.pool, deps.sessionId, ["pre_market_news_scan"]);
      const outcome = await withAgentMutationLock(deps.pool, async (client) => {
        const written = await writeMarketNews(client, input, running.id);
        await insertToolAudit(client, { session_id: deps.sessionId, tool_name: "pool_news_write", args: { args_sha256: sha256Json(input) }, result_sha256: sha256Json(written), status: "ok" });
        return written;
      });
      return result(outcome);
    },
  };
}

export function buildJobPoolAttentionTool(deps: { pool: pg.Pool; sessionId: string | null }): AgentTool {
  return {
    name: "pool_attention_write",
    label: "批量维护关注池自动关注",
    description:
      "复核夜间板块策略全部存量关注后提交结果。先读取 pool_context_query，逐项研究、优先补齐缺数。mark 更新符合或接近条件的信号；clear 仅用于明确失效。reviewed_codes 列出确已完成复核的全部代码（包括不再符合者），review_gaps 列出缺数代码和具体原因。未覆盖条目必须提交 partial，不得凭未入选推断失效。数据不足不续期，过期自动退出；仅自动入池且无其他有效来源的标的退出关注池。人工关注、其他策略和持仓独立保留。",
    parameters: ScheduledPoolAttentionSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, rawInput, signal) => {
      try {
        if (signal?.aborted) throw new Error("关注池维护已中断");
        const input = validateScheduledPoolAttentionInput(rawInput);
        const running = await associatedRunningJob(deps.pool, deps.sessionId, POOL_ATTENTION_JOBS);
        const { code: jobCode, strategy_code: strategyCode, target_date: date } = running;
        if (!strategyCode) throw new Error(`任务 ${jobCode} 未绑定关注策略`);
        if (input.data_date && input.data_date !== date) throw new Error("关注复核数据日必须与任务目标日一致");
        if ((input.reviewed_codes.length || input.items.length) && !input.data_date) throw new Error("实际复核必须提供目标日 data_date");
        if (input.evaluation_status === "failed" && input.items.length) throw new Error("评估失败不能更新或清除信号");
        const shortlist = input.evaluation_status !== "failed"
          ? await saveNightlyShortlist(deps.pool, running.id, deps.sessionId!, date, running.started_at)
          : { candidates: [], deferred_codes: [] };
        if (input.evaluation_status === "failed") await saveStrategyShortlist(deps.pool, running.id, strategyCode, date,
          { data_date: date, qualified: [], near: [], shortlist_matches: [] }, {}, "partial", input.review_gaps);
        const selected = new Set(shortlist.candidates.map((item) => item.code));
        const native = new Set([...selected, ...shortlist.deferred_codes]);
        const outcome = await withAgentMutationLock(deps.pool, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('pool-attention-lifecycle'))");
          await client.query("SELECT code FROM strategy_definition WHERE code=$1 FOR UPDATE", [strategyCode]);
          const newer = await client.query(`SELECT 1 FROM job_run run JOIN job_definition definition ON definition.id=run.job_id
            WHERE definition.strategy_code=$1 AND run.target_date>$2::date AND run.status IN ('running','success') LIMIT 1`, [strategyCode, date]);
          if (newer.rows.length) throw new Error("已有更新日期的策略任务，拒绝历史运行覆盖关注池");
          const existing = await strategyAttentionCodes(client, strategyCode);
          if (input.items.some((item) => item.action === "mark" && !native.has(item.code) && !existing.includes(item.code)))
            throw new Error("新增关注标的不属于本次夜间原生候选");
          if (input.items.some((item) => item.action === "mark" && item.attention_status !== "approaching"))
            throw new Error("夜间板块个股只允许接近观察，不得升级正式信号");
          const covered = new Set([...input.reviewed_codes, ...input.items.map((item) => item.code)]);
          if (input.evaluation_status === "success" && (input.review_gaps.length || existing.some((code) => !covered.has(code)))) {
            throw new Error("尚未逐项复核全部存量关注；请补齐 reviewed_codes，缺数时提交 partial 和 review_gaps");
          }
          const items: Array<Record<string, unknown>> = [];
          const kept: string[] = [];
          const validUntil = await attentionValidUntil(client, date);
          for (const item of input.items) {
            if (input.review_gaps.some((gap) => gap.code === item.code)) throw new Error(`${item.code} 缺数据时不能续期或判定失效`);
            if (item.action === "mark" && (selected.has(item.code) || existing.includes(item.code))) {
              if (!input.data_date || item.attention_from !== date) throw new Error("更新关注必须提供目标日 data_date，attention_from 必须与任务日期一致");
              const membership = await client.query(`SELECT 1 FROM pool_membership membership JOIN market_instrument instrument
                ON instrument.id=membership.instrument_id WHERE instrument.code=$1 AND membership.pool=$2 AND membership.effective_to IS NULL`, [item.code, WATCH_POOL]);
              if (!membership.rows.length) await ensureStrategyPoolMemberProfile(client, {
                code: item.code, effective_from: date, strategy_name: "夜间板块结构观察",
              });
              const write = await setPoolAttentionEntry(client, {
                code: item.code, source_job: jobCode, strategy_code: strategyCode, data_date: date,
                status: item.attention_status!, reason: item.attention_reason!, missing_signals: item.missing_signals,
                valid_from: date, valid_until: item.attention_until! < validUntil ? item.attention_until : validUntil,
                stale_reason: null,
              });
              kept.push(item.code);
              items.push({ code: item.code, action: "mark", reason: write.after?.reason,
                attention_from: write.after?.valid_from, attention_until: write.after?.valid_until });
            }
          }
          const remainder = await reconcileAttentionRemainder(client, {
            strategy_code: strategyCode, date, kept,
            reviewed: input.evaluation_status === "failed" ? [] : [...input.reviewed_codes,
              ...input.items.filter((item) => item.action === "clear").map((item) => item.code)],
            gaps: input.review_gaps, deferred: shortlist.deferred_codes, reason: input.reason,
          });
          items.push(...remainder.changes.map((item) => ({ ...item, reconciled: true })));
          const summary = { source_job: jobCode, strategy_code: strategyCode, evaluation_status: input.evaluation_status,
            total: items.length, items, pool_removed: remainder.removed, shortlist: shortlist.candidates };
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

export function buildJobDailyPlanScenarioTool(deps: {
  pool: pg.Pool;
  sessionId: string | null;
}): AgentTool {
  return {
    name: "daily_plan_scenario_write",
    label: "写入每日计划情景与做T预案",
    description:
      "一次性提交明日大盘预期（3—4 个概率情景、关键指数位）与每笔持仓的 2—4 个最可能情景（按概率排序，概率合计 100）、做T区间、集合竞价、分时盯防、失效改判、风险字段。大盘与个股情景只依据 daily_plan_strategy_query 返回的关键点位、市场与所属板块当日表现和盘前消息面，不固定凑满五类，不以冷却期、止盈核对期等为由缺省；做T默认给低吸/兑现区间，仅一字板、停牌等流动性极端可用 skip_reason 显式说明。全量替换式写入，只能调用一次。",
    parameters: DailyPlanScenarioWriteSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, rawInput, signal) => {
      try {
        if (signal?.aborted) throw new Error("情景预案写入已中断");
        const input = validateDailyPlanScenarioWriteInput(rawInput);
        const { id: runId } = await associatedRunningJob(deps.pool, deps.sessionId, ["daily_plan_flow"]);
        const outcome = await withAgentMutationLock(deps.pool, async (client) => {
          const write = await replaceDraftScenarios(client, {
            source_job_run_id: runId,
            market_forecast: input.market_forecast,
            items: input.items,
          });
          await insertToolAudit(client, {
            session_id: deps.sessionId,
            tool_name: "daily_plan_scenario_write",
            args: input,
            result_sha256: sha256Json(write),
            status: "ok",
          });
          return write;
        });
        return result(outcome);
      } catch (error) {
        await auditError(deps.pool, deps.sessionId, "daily_plan_scenario_write", rawInput);
        throw error;
      }
    },
  };
}

export function buildJobEveningPreviewTool(deps: {
  pool: pg.Pool;
  sessionId: string | null;
}): AgentTool {
  return {
    name: "evening_preview_write",
    label: "写入晚间明日预案预览",
    description:
      "一次性提交下一交易日的大盘概率情景（3—4 个，概率合计 100）与每只持仓 2—3 个最可能情景（概率合计 100）。只读预览，不写持仓、关注或交易；早盘每日计划会覆盖。",
    parameters: EveningPreviewWriteSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, rawInput, signal) => {
      try {
        if (signal?.aborted) throw new Error("晚间预览写入已中断");
        const input = validateEveningPreviewWriteInput(rawInput);
        const { id: runId } = await associatedRunningJob(deps.pool, deps.sessionId, ["evening_plan_preview"]);
        const outcome = await withAgentMutationLock(deps.pool, async (client) => {
          const write = await replaceEveningPreview(client, {
            source_job_run_id: runId,
            as_of: input.as_of,
            market_forecast: input.market_forecast,
            positions: input.positions,
          });
          await insertToolAudit(client, {
            session_id: deps.sessionId,
            tool_name: "evening_preview_write",
            args: input,
            result_sha256: sha256Json(write),
            status: "ok",
          });
          return write;
        });
        return result(outcome);
      } catch (error) {
        await auditError(deps.pool, deps.sessionId, "evening_preview_write", rawInput);
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
      "一次提交两类竞价结果：items 完整覆盖收盘打板机会；scope_items 按 target_key 完整覆盖每条有效关注来源和前一日盘中涨停梯队。关注按来源策略补齐条件，打板按打板策略门禁分类，梯队按原生持有复核；持仓竞价复核已下线，不再提交 position 目标键。服务端对账后由任务成功统一激活；不成交、不改持仓或关注。",
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
