// 面向模型的纵向业务读取：一次返回完成业务任务所需的受控上下文。
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import {
  getRealizedPnlSummary,
  listPassedLimitUpSignals,
  listPositionChanges,
  listPositions,
} from "../modules/positions/repo.js";
import { listPoolView, listStrategyAttentionReviewEntries } from "../modules/pools/repo.js";
import { getCurrentStrategy } from "../modules/strategy/repo.js";
import { findJobPrompt, listJobPrompts } from "../modules/job-prompts/repo.js";
import { listJobDefinitions, listJobOutputs, listJobRuns } from "../scheduler/repo.js";
import { queryAuctionAssessmentContext, queryHistoricalPlanItems } from "../modules/plans/repo.js";
import { loadWeeklyReviewSnapshot } from "../modules/weekly-review/service.js";
import { sha256Json } from "./hash.js";
import { marketNewsTargets, shanghaiDate } from "../modules/market-news/repo.js";
import { insertToolAudit } from "./repo.js";
import {
  JobContextQuerySchema,
  AuctionContextQuerySchema,
  PoolContextQuerySchema,
  PortfolioContextQuerySchema,
  StrategyDocumentQuerySchema,
  WeeklyReviewContextQuerySchema,
  validateJobContextQueryInput,
  validateAuctionContextQueryInput,
  validatePoolContextQueryInput,
  validatePortfolioContextQueryInput,
  validateStrategyDocumentQueryInput,
  validateWeeklyReviewContextQueryInput,
  type JobContextQueryInput,
  type AuctionContextQueryInput,
  type PoolContextQueryInput,
  type PortfolioContextQueryInput,
  type StrategyDocumentQueryInput,
  type WeeklyReviewContextQueryInput,
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

async function audited<T>(
  deps: { pool: pg.Pool; sessionId: string | null },
  name: string,
  raw: unknown,
  validate: (value: unknown) => T,
  query: (input: T) => Promise<unknown>,
): Promise<AgentToolResult<unknown>> {
  try {
    const input = validate(raw);
    const value = await query(input);
    await insertToolAudit(deps.pool, {
      session_id: deps.sessionId,
      tool_name: name,
      args: input,
      result_sha256: sha256Json(value),
      status: "ok",
    });
    return result(value);
  } catch (error) {
    await insertToolAudit(deps.pool, {
      session_id: deps.sessionId,
      tool_name: name,
      args: { redacted: true, args_sha256: safeArgsHash(raw) },
      result_sha256: null,
      status: "error",
    }).catch(() => {});
    throw error;
  }
}

export function strategyDocumentPurpose(document: { role: string; title: string; job_code?: string | null }): string {
  if (document.role === "portfolio") return "组合层、市场状态与风险预算的总约束";
  if (document.role === "task") return `执行任务 ${document.job_code ?? ""} 的专属策略规则，运行该任务的会话必须读取`;
  return `需要执行“${document.title}”对应专项判断时读取`;
}

/**
 * 系统只保留当前最终策略，运行中的会话和任务始终读取当前正文，不回放历史版本。
 */
export async function strategyForSession(deps: { pool: pg.Pool; sessionId: string | null }) {
  return getCurrentStrategy(deps.pool);
}

function summarizeRun(run: Awaited<ReturnType<typeof listJobRuns>>[number]) {
  return {
    id: run.id,
    target_date: run.target_date,
    trigger_kind: run.trigger_kind,
    status: run.status,
    attempt_count: run.attempt_count,
    next_retry_at: run.next_retry_at,
    data_gaps: run.data_gaps,
    started_at: run.started_at,
    finished_at: run.finished_at,
    created_at: run.created_at,
  };
}

export function buildBusinessContextTools(deps: { pool: pg.Pool; sessionId: string | null; accountId?: string | null; jobCode?: string }): AgentTool[] {
  return [
    {
      name: "portfolio_context_query",
      label: "查询组合业务上下文",
      description:
        "一次返回真实当前持仓、最新收盘与浮动盈亏、累计已实现盈亏、近期持仓事件；按代码查询时还返回可按成交日匹配的近期打板通过信号。回答组合、持仓、成交归因或录入持仓变化前优先使用本工具，不要用通用数据库查询拼接。",
      parameters: PortfolioContextQuerySchema,
      execute: async (_id, raw) => audited<PortfolioContextQueryInput>(
        deps, "portfolio_context_query", raw, validatePortfolioContextQueryInput, async (input) => {
          if (deps.accountId === null) throw new Error("会话未关联持仓账户，请先在会话中关联账户；这不代表账户没有持仓");
          const codes=input.codes?.length ? (await deps.pool.query<{code:string}>(`SELECT code FROM market_instrument
            WHERE code=ANY($1::text[]) OR (kind IN ('stock','etf') AND split_part(code,'.',1)=ANY($1::text[]))`,[input.codes])).rows.map(row=>row.code) : undefined;
          const [allPositions, realized_pnl, recent_changes, matching_limit_up_signals] = await Promise.all([
            listPositions(deps.pool, deps.accountId),
            getRealizedPnlSummary(deps.pool, deps.accountId),
            input.codes?.length && !codes?.length ? Promise.resolve([]) : listPositionChanges(deps.pool, input.recent_change_limit ?? 20, codes, deps.accountId),
            codes?.length ? listPassedLimitUpSignals(deps.pool, codes, input.change_date, deps.accountId) : Promise.resolve([]),
          ]);
          const positions = input.codes?.length ? allPositions.filter(position => codes?.includes(position.code)) : allPositions;
          return {
            summary: {
              position_count: positions.length,
              market_value: positions.reduce((sum, row) => sum + (row.market_value ?? 0), 0),
              unrealized_pnl: positions.reduce((sum, row) => sum + (row.pnl_amount ?? 0), 0),
              missing_quote_count: positions.filter((row) => row.close === null).length,
            },
            positions,
            realized_pnl,
            recent_changes,
            matching_limit_up_signals,
          };
        },
      ),
    },
    {
      name: "pool_context_query",
      label: "查询标的池业务上下文",
      description:
        "返回关注池成员全集。未传 codes 时每只成员只返回角色、阶段、关注、行情和一级行业摘要；传 codes 时才返回对应标的完整研究属性。date 指定关注有效性的判定日（缺省为今天）。strategy_attentions 返回全部策略存量关注（含过期条目），策略任务必须按 strategy_code 取全复核；当前展示成员与复核集合分开。只有需要板块总览时才开启 include_boards。",
      parameters: PoolContextQuerySchema,
      execute: async (_id, raw) => audited<PoolContextQueryInput>(
        deps, "pool_context_query", raw, validatePoolContextQueryInput, async (input) => {
          const asOf = (input as { date?: string }).date;
          const view = await listPoolView(deps.pool, asOf);
          const members = input.codes?.length
            ? view.members.filter((member) => input.codes!.includes(member.code))
            : view.members;
          const memberRows = input.codes?.length
            ? members
            : members.map((member) => ({
                code: member.code,
                name: member.name,
                kind: member.kind,
                role: member.role,
                stage: member.stage,
                attention_entries: member.attention_entries,
                last: member.last,
                change_pct: member.change_pct,
                quote_time: member.quote_time,
                primary_boards: member.boards
                  .filter((board) => board.level === "primary")
                  .map((board) => ({ code: board.code, name: board.name })),
                detail_available: true,
              }));
          return {
            pool: view.pool,
            strategy_attentions: await listStrategyAttentionReviewEntries(deps.pool),
            member_count: members.length,
            attention_count: members.filter((member) => member.attention_entries.length > 0).length,
            detail_level: input.codes?.length ? "full" : "summary",
            members: memberRows,
            ...(deps.jobCode === "pre_market_news_scan"
              ? { news_targets: await marketNewsTargets(deps.pool, asOf ?? shanghaiDate()) } : {}),
            ...(input.include_boards ? { boards: view.boards } : {}),
          };
        },
      ),
    },
    {
      name: "job_context_query",
      label: "查询作业业务上下文",
      description:
        "一次查询作业定义、近期运行、结果元信息和提示词版本；可按目标日筛选。回答昨日/历史计划信号质量时指定 daily_plan_flow、target_date，开启 include_output_content 与 include_plan_items，读取当时正文、结构化预案和策略版本，不用当前扫描替代历史。预案每份100行，按 next_offset 设置 plan_item_offset 续读；普通状态查询不开正文。",
      parameters: JobContextQuerySchema,
      execute: async (_id, raw) => audited<JobContextQueryInput>(
        deps, "job_context_query", raw, validateJobContextQueryInput, async (input) => {
          const [allJobs, allPrompts] = await Promise.all([
            listJobDefinitions(deps.pool, deps.accountId === null ? "0" : deps.accountId ?? "1"),
            listJobPrompts(deps.pool),
          ]);
          const jobs = input.job_codes?.length
            ? allJobs.filter((job) => input.job_codes!.includes(job.code))
            : allJobs;
          const jobRows = await Promise.all(jobs.map(async (job) => {
            const [runs, outputs] = await Promise.all([
              listJobRuns(deps.pool, job.id, input.recent_runs_per_job ?? 3, input.target_date, deps.accountId === null ? "0" : deps.accountId ?? "1"),
              listJobOutputs(deps.pool, job.id, input.recent_runs_per_job ?? 3, input.target_date, deps.accountId === null ? "0" : deps.accountId ?? "1"),
            ]);
            return {
              definition: job,
              runs: runs.map(summarizeRun),
              outputs: await Promise.all(outputs.map(async (output) => ({
                id: output.id,
                run_id: output.run_id,
                output_type: output.output_type,
                target_date: output.target_date,
                status: output.status,
                source: output.source,
                sha256: output.sha256,
                strategy_change_seq: output.strategy_change_seq,
                strategy_snapshot_hash: output.strategy_snapshot_hash,
                created_at: output.created_at,
                ...(input.include_output_content ? { markdown: output.markdown } : {}),
                ...(input.include_plan_items && job.code === "daily_plan_flow"
                  ? { plan_items: await queryHistoricalPlanItems(deps.pool, output.id, input.plan_item_offset) }
                  : {}),
              }))),
            };
          }));
          const boundPromptIds = new Set(jobs.map((job) => job.prompt_id).filter(Boolean));
          const prompts = allPrompts.filter((prompt) => input.prompt_codes?.length
            ? input.prompt_codes.includes(prompt.code)
            : !input.job_codes?.length || boundPromptIds.has(prompt.id));
          const promptRows = await Promise.all(prompts.map(async (prompt) => {
            const withContent = input.include_prompt_content
              ? await findJobPrompt(deps.pool, prompt.id, true)
              : prompt;
            return {
              id: prompt.id,
              code: prompt.code,
              name: prompt.name,
              status: prompt.status,
              current_revision_id: prompt.current_revision_id,
              current_revision_no: prompt.current_revision_no,
              current_sha256: prompt.current_sha256,
              updated_at: prompt.updated_at,
              ...(input.include_prompt_content ? { current_content: withContent?.current_content ?? null } : {}),
            };
          }));
          return { jobs: jobRows, prompts: promptRows };
        },
      ),
    },
    {
      name: "auction_context_query",
      label: "查询集合竞价任务上下文",
      description:
        "按目标日一次返回交易日门禁、前一开市日、前一开市日独立收盘打板任务有效性，以及有效近期关注、收盘打板候选、前一日盘中涨停梯队先手候选、候选代码、覆盖计数和逐项缺口。持仓竞价复核已下线，上下文不再返回持仓或每日计划；集合竞价任务只用本工具取得候选全集，不得调用完整标的池或通用数据库工具重复拼装。",
      parameters: AuctionContextQuerySchema,
      execute: async (_id, raw) => audited<AuctionContextQueryInput>(
        deps, "auction_context_query", raw, validateAuctionContextQueryInput,
        (input) => queryAuctionAssessmentContext(deps.pool, input.date),
      ),
    },
    {
      name: "weekly_review_context_query",
      label: "查询周复盘事实快照",
      description:
        "按目标日返回服务端在周复盘任务运行前构建的确定性事实快照：复盘窗口、账户净值、持仓与本周成交、本周产出机会标的及其信号生效日后走势、指数与 881 一级行业板块周表现、每日涨跌停与涨跌家数、数据缺口。只读；不传 date 时取最新一份。周复盘任务只用本工具取完整事实，不重复用通用数据库工具拼装持仓、行情或任务产出。",
      parameters: WeeklyReviewContextQuerySchema,
      execute: async (_id, raw) => audited<WeeklyReviewContextQueryInput>(
        deps, "weekly_review_context_query", raw, validateWeeklyReviewContextQueryInput,
        async (input) => {
          const snapshot = await loadWeeklyReviewSnapshot(deps.pool, input.date);
          if (!snapshot) {
            throw new Error(input.date
              ? `目标日 ${input.date} 没有周复盘快照；快照由周复盘任务在模型运行前生成`
              : "还没有任何周复盘快照；快照由周复盘任务在模型运行前生成");
          }
          return snapshot;
        },
      ),
    },
    {
      name: "strategy_document_query",
      label: "按需读取本轮策略文档",
      description:
        "按系统提示词中的策略文档 code 一次读取最多 20 份当前策略正文，并返回同一策略基线。任务会话必须读取本任务 job_code 对应的任务策略文档与组合总策略；只读取完成当前任务必要的文档。",
      parameters: StrategyDocumentQuerySchema,
      execute: async (_id, raw) => audited<StrategyDocumentQueryInput>(
        deps, "strategy_document_query", raw, validateStrategyDocumentQueryInput, async (input) => {
          const strategy = await strategyForSession(deps);
          const documents = strategy.documents.filter((document) => input.codes.includes(document.code));
          const found = new Set(documents.map((document) => document.code));
          const missing = input.codes.filter((code) => !found.has(code));
          if (missing.length) throw new Error(`当前策略文档不存在：${missing.join("、")}`);
          return {
            state: strategy.state,
            documents: documents.map((document) => ({
              id: document.id,
              code: document.code,
              title: document.title,
              role: document.role,
              purpose: strategyDocumentPurpose(document),
              sha256: document.sha256,
              content: document.content,
            })),
          };
        },
      ),
    },
  ];
}
