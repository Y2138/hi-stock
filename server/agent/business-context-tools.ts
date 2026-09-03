// 面向模型的纵向业务读取：一次返回完成业务任务所需的受控上下文。
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import { getRealizedPnlSummary, listPositionChanges, listPositions } from "../modules/positions/repo.js";
import { listPoolView } from "../modules/pools/repo.js";
import { getCurrentStrategy, getStrategySnapshot } from "../modules/strategy/repo.js";
import { findJobPrompt, listJobPrompts } from "../modules/job-prompts/repo.js";
import { listJobDefinitions, listJobOutputs, listJobRuns } from "../scheduler/repo.js";
import { sha256Json } from "./hash.js";
import { insertToolAudit } from "./repo.js";
import {
  JobContextQuerySchema,
  PoolContextQuerySchema,
  PortfolioContextQuerySchema,
  StrategyDocumentQuerySchema,
  validateJobContextQueryInput,
  validatePoolContextQueryInput,
  validatePortfolioContextQueryInput,
  validateStrategyDocumentQueryInput,
  type JobContextQueryInput,
  type PoolContextQueryInput,
  type PortfolioContextQueryInput,
  type StrategyDocumentQueryInput,
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

export function strategyDocumentPurpose(document: { role: string; title: string }): string {
  if (document.role === "portfolio") return "组合层、市场状态与风险预算的总约束";
  if (document.role === "short") return "短线资格、入场、持有与退出规则";
  if (document.role === "long") return "长线资格、估值、持有与退出规则";
  return `需要执行“${document.title}”对应专项判断时读取`;
}

async function strategyForSession(deps: { pool: pg.Pool; sessionId: string | null }) {
  if (!deps.sessionId) return getCurrentStrategy(deps.pool);
  const session = await deps.pool.query<{ strategy_state_revision: string | null }>(
    "SELECT strategy_state_revision::text FROM chat_session WHERE id = $1",
    [deps.sessionId],
  );
  const revision = session.rows[0]?.strategy_state_revision;
  return revision ? getStrategySnapshot(deps.pool, revision) : getCurrentStrategy(deps.pool);
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

export function buildBusinessContextTools(deps: { pool: pg.Pool; sessionId: string | null }): AgentTool[] {
  return [
    {
      name: "portfolio_context_query",
      label: "查询组合业务上下文",
      description:
        "一次返回真实当前持仓、最新收盘与浮动盈亏、累计已实现盈亏，以及可按代码筛选的近期持仓事件。回答组合、持仓和成交归因问题优先使用本工具，不要用通用数据库查询拼接。",
      parameters: PortfolioContextQuerySchema,
      execute: async (_id, raw) => audited<PortfolioContextQueryInput>(
        deps, "portfolio_context_query", raw, validatePortfolioContextQueryInput, async (input) => {
          const [allPositions, realized_pnl, recent_changes] = await Promise.all([
            listPositions(deps.pool),
            getRealizedPnlSummary(deps.pool),
            listPositionChanges(deps.pool, input.recent_change_limit ?? 20, input.codes),
          ]);
          const positions = input.codes?.length
            ? allPositions.filter((position) => input.codes!.includes(position.code))
            : allPositions;
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
          };
        },
      ),
    },
    {
      name: "pool_context_query",
      label: "查询标的池业务上下文",
      description:
        "一次返回短线池、长线池当前角色与研究属性、最新收盘和官方行业关系；可批量按代码筛选，只有需要板块总览时才返回完整板块列表。回答池成员、角色和入池现状优先使用本工具。",
      parameters: PoolContextQuerySchema,
      execute: async (_id, raw) => audited<PoolContextQueryInput>(
        deps, "pool_context_query", raw, validatePoolContextQueryInput, async (input) => {
          const pools = input.pools ?? ["short", "long"];
          const views = await Promise.all(pools.map(async (pool) => {
            const view = await listPoolView(deps.pool, pool);
            const members = input.codes?.length
              ? view.members.filter((member) => input.codes!.includes(member.code))
              : view.members;
            return {
              pool,
              member_count: members.length,
              attention_count: members.filter((member) => member.attention_reason !== null).length,
              members,
              ...(input.include_boards ? { boards: view.boards } : {}),
            };
          }));
          return { pools: views };
        },
      ),
    },
    {
      name: "job_context_query",
      label: "查询作业业务上下文",
      description:
        "一次查询作业定义、近期运行、结果元信息和提示词版本；可批量按作业或提示词 code 筛选。只有确实需要阅读结果或编辑提示词时才开启对应正文开关，查询任务状态不得再轮询通用数据库表。",
      parameters: JobContextQuerySchema,
      execute: async (_id, raw) => audited<JobContextQueryInput>(
        deps, "job_context_query", raw, validateJobContextQueryInput, async (input) => {
          const [allJobs, allPrompts] = await Promise.all([
            listJobDefinitions(deps.pool),
            listJobPrompts(deps.pool),
          ]);
          const jobs = input.job_codes?.length
            ? allJobs.filter((job) => input.job_codes!.includes(job.code))
            : allJobs;
          const jobRows = await Promise.all(jobs.map(async (job) => {
            const [runs, outputs] = await Promise.all([
              listJobRuns(deps.pool, job.id, input.recent_runs_per_job ?? 3, input.target_date),
              listJobOutputs(deps.pool, job.id, input.recent_runs_per_job ?? 3, input.target_date),
            ]);
            return {
              definition: job,
              runs: runs.map(summarizeRun),
              outputs: outputs.map((output) => ({
                id: output.id,
                run_id: output.run_id,
                output_type: output.output_type,
                target_date: output.target_date,
                status: output.status,
                source: output.source,
                sha256: output.sha256,
                created_at: output.created_at,
                ...(input.include_output_content ? { markdown: output.markdown } : {}),
              })),
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
      name: "strategy_document_query",
      label: "按需读取本轮策略文档",
      description:
        "按系统提示词中的策略文档 code 一次读取最多 20 份本轮策略快照正文，并返回同一策略基线。只读取完成当前任务必要的文档；提交策略发布提案前必须读取所有拟修改文档。",
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
              current_revision_id: document.current_revision_id,
              current_revision_no: document.current_revision_no,
              current_sha256: document.current_sha256,
              current_content: document.current_content,
            })),
          };
        },
      ),
    },
  ];
}
