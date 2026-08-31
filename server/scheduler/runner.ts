import crypto from "node:crypto";
import path from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import { executeAnalysis, type AnalysisRequest } from "../analysis/service.js";
import { persistAndPublishSessionEvent } from "../agent/events.js";
import { buildSystemPrompt } from "../agent/prompt.js";
import { appendMessage, nextMessageSeq, updateSessionStatus } from "../agent/repo.js";
import { runAgentSessionTurn } from "../agent/session-runner.js";
import { getAgentSettings } from "../agent/settings.js";
import { buildChatTools } from "../agent/tools.js";
import {
  buildJobAuctionAssessmentTool,
  buildJobDailyPlanTool,
  buildJobPoolAttentionTool,
} from "../agent/job-tools.js";
import {
  activateAuctionAssessmentsForRun,
  activatePlaybookForRun,
  discardDraftAuctionAssessmentsForRun,
} from "../modules/plans/repo.js";
import { PROJECT_ROOT } from "../config.js";
import {
  dailyMarketUpdate,
  type DailyUpdateScope,
  type DailyUpdateSummary,
} from "../datasource/service.js";
import {
  syncAllBoardMemberships,
  syncMarketCatalog,
  type CatalogSyncSummary,
} from "../datasource/catalog-service.js";
import { withMarketMutationLock } from "../datasource/mutation-lock.js";
import {
  syncDailyMarketStructure,
  type SpecialSyncSummary,
} from "../datasource/special-service.js";
import {
  getCurrentStrategy,
  getStrategySnapshot,
  type StrategyBundle,
} from "../modules/strategy/repo.js";
import { exportVolume, type VolumeExportResult } from "../volume/export.js";
import { validateJobConfig } from "./config.js";
import { findJobRunById } from "./repo.js";
import { dailyMarketGate, type DailyMarketMode } from "./time.js";
import type {
  AgentFlowJobConfig,
  AnalysisJobConfig,
  DatasourceJobConfig,
  JobDefinitionRow,
  JobRunRow,
  JobStatus,
} from "./types.js";

const MAX_LOG_CHARS = 100_000;
const RESULT_BANNER = "> AI 生成任务结果，已关联本次任务保存；不代表策略发布或交易执行。";
export const DEFAULT_RETRY_DELAY_MS = 5 * 60_000;

class AgentRunAbortedError extends Error {
  constructor() {
    super("用户中断了任务 Agent");
    this.name = "AgentRunAbortedError";
  }
}

class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableJobError";
  }
}

export interface JobExecutionResult {
  status: "success" | "partial";
  log: string;
  artifacts?: unknown[];
  dataGaps?: unknown[];
  resultMd?: string | null;
}

export interface RunnerDeps {
  pool: pg.Pool;
  databaseUrl: string;
  now?: () => Date;
  retryDelayMs?: number;
  dailyUpdate?: (scope: DailyUpdateScope, jobRunId: string) => Promise<DailyUpdateSummary>;
  catalogSync?: (jobRunId: string) => Promise<CatalogSyncSummary>;
  boardMembershipSync?: (
    effectiveDate: string,
    jobRunId: string,
  ) => Promise<{
    completed: Array<{ memberCount: number; opened: number; closed: number }>;
    gaps: Array<{ code: string; reason: string }>;
  }>;
  marketStructureSync?: (
    targetDate: string,
    jobRunId: string,
  ) => Promise<{ datasets: SpecialSyncSummary[]; gaps: unknown[] }>;
  volumeExport?: () => Promise<VolumeExportResult>;
  analysisRun?: (request: AnalysisRequest) => Promise<{ id: string; status: string; data_gaps: unknown[] }>;
  agentFlow?: (
    config: AgentFlowJobConfig,
    run: JobRunRow,
    definition: JobDefinitionRow,
  ) => Promise<string>;
}

function trimLog(value: string): string {
  return value.length <= MAX_LOG_CHARS ? value : value.slice(value.length - MAX_LOG_CHARS);
}

function logLine(message: string, at = new Date()): string {
  return `[${at.toISOString()}] ${message}\n`;
}

const CORE_MARKET_INDEX_CODES = [
  "000001.SH",
  "000016.SH",
  "000300.SH",
  "000688.SH",
  "000852.SH",
  "000905.SH",
  "399001.SZ",
  "399006.SZ",
] as const;

const DAILY_STRUCTURE_CANDIDATE_LIMIT = 30;

/** 当前持仓、有效标的池、市场结构候选、核心指数和官方行业是日更范围；期货单独走 futures_day。 */
export async function resolveDailyUpdateScope(
  pool: pg.Pool,
  targetDate: string,
  dayMode: DailyMarketMode = "snapshot",
): Promise<DailyUpdateScope> {
  const day = await pool.query<{ code: string }>(
    `SELECT DISTINCT i.code
       FROM market_instrument i
      WHERE i.kind <> 'futures'
        AND ((i.lifecycle_status = 'active' AND (
              i.code = ANY($1::text[])
              OR EXISTS (SELECT 1 FROM market_board board
                            WHERE board.instrument_id = i.id AND board.active = true
                              AND board.source = 'hithink' AND board.board_type = 'industry'
                            AND (i.code LIKE '881%.TI' OR i.code LIKE '884%.TI'))))
          OR EXISTS (SELECT 1 FROM portfolio_position p WHERE p.instrument_id = i.id)
          OR EXISTS (SELECT 1 FROM pool_membership pm
                      WHERE pm.instrument_id = i.id AND pm.effective_to IS NULL))
      ORDER BY i.code`,
    [[...CORE_MARKET_INDEX_CODES]],
  );
  const structureCandidates = await pool.query<{ code: string }>(
    `WITH raw_signal AS (
       SELECT event.instrument_id,
              true AS is_limit_up,
              false AS is_dragon_tiger,
              false AS is_org_or_hot_money,
              event.streak_count,
              NULL::double precision AS net_amount
         FROM market_limit_event event
        WHERE event.trade_date = $1 AND event.event_type = 'up'
       UNION ALL
       SELECT entry.instrument_id,
              false,
              true,
              entry.dataset_type IN ('org', 'hot_money'),
              NULL::integer,
              entry.net_amount
         FROM market_dragon_tiger_entry entry
        WHERE entry.trade_date = $1 AND entry.instrument_id IS NOT NULL
     ), ranked AS (
       SELECT signal.instrument_id,
              bool_or(signal.is_limit_up) AS is_limit_up,
              bool_or(signal.is_dragon_tiger) AS is_dragon_tiger,
              bool_or(signal.is_org_or_hot_money) AS is_org_or_hot_money,
              max(signal.streak_count) AS streak_count,
              max(signal.net_amount) AS net_amount
         FROM raw_signal signal
        GROUP BY signal.instrument_id
     )
     SELECT instrument.code
       FROM ranked
       JOIN market_instrument instrument ON instrument.id = ranked.instrument_id
      WHERE instrument.kind = 'stock'
        AND instrument.lifecycle_status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM pool_membership membership
           WHERE membership.instrument_id = ranked.instrument_id AND membership.effective_to IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM portfolio_position position WHERE position.instrument_id = ranked.instrument_id
        )
      ORDER BY (ranked.is_limit_up AND ranked.is_dragon_tiger) DESC,
               ranked.is_org_or_hot_money DESC,
               ranked.streak_count DESC NULLS LAST,
               ranked.net_amount DESC NULLS LAST,
               instrument.code
      LIMIT $2`,
    [targetDate, DAILY_STRUCTURE_CANDIDATE_LIMIT],
  );
  const futures = await pool.query<{ code: string }>(
    "SELECT code FROM market_instrument WHERE kind = 'futures' ORDER BY code",
  );
  const minute30 = await pool.query<{ code: string }>(
    `SELECT DISTINCT i.code
       FROM market_instrument i
      WHERE (i.lifecycle_status = 'active' AND i.code = ANY($1::text[]))
         OR EXISTS (SELECT 1 FROM portfolio_position p WHERE p.instrument_id = i.id)
      ORDER BY i.code`,
    [[...CORE_MARKET_INDEX_CODES]],
  );
  return {
    date: targetDate,
    dayMode,
    codes: [...new Set([...day.rows, ...structureCandidates.rows].map((row) => row.code))].sort(),
    futures: futures.rows.map((row) => row.code),
    minute30: minute30.rows.map((row) => row.code),
  };
}

function textOfAssistant(message: AgentMessage | null): string {
  if (!message || message.role !== "assistant") return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

function buildAgentJobPrompt(
  template: string,
  run: JobRunRow,
  definition: JobDefinitionRow,
  config: AgentFlowJobConfig,
): string {
  if (run.attempt_count > 1) {
    return [
      `系统正在重试作业 ${definition.code}（目标日 ${run.target_date}，第 ${run.attempt_count} 次尝试）。`,
      "请结合本对话第一条任务要求和已有执行记录重新完成任务，并直接输出完整 Markdown。",
      `首行必须是：${RESULT_BANNER}`,
    ].join("\n\n");
  }
  const writes = [
    config.pool_attention_write ? "pool_attention_write 维护当前池成员的短期关注" : null,
    config.daily_plan_write ? "daily_plan_write 写入次日执行预案与打板机会结构化数据" : null,
    definition.code === "auction_opportunity_assessment"
      ? "auction_assessment_write 更新打板机会的结构化竞价复核"
      : null,
  ].filter(Boolean);
  const capability = "本任务使用与普通 Agent 相同的完整工具集和当前确认制/YOLO 设置；策略发布仍只能创建待真人审核提案。";
  const tools = writes.length
    ? `本流程另提供 ${writes.join("、")}。数据库查询仍须遵循 schema_hash 渐进发现协议，数据缺失必须列入缺口。`
    : "数据库查询须遵循 schema_hash 渐进发现协议，数据缺失必须列入缺口。";
  return [
    `执行系统作业 ${definition.code}（目标日 ${run.target_date}）。`,
    capability,
    tools,
    `请直接输出完整 Markdown。首行必须是：${RESULT_BANNER}`,
    "以下是数据库内固化的流程提示词；遵循其读取范围和输出结构：",
    template,
  ].join("\n\n");
}

async function appendConversationMessage(
  pool: pg.Pool,
  sessionId: string,
  role: "user" | "assistant",
  text: string,
): Promise<void> {
  const seq = await nextMessageSeq(pool, sessionId);
  const json = role === "user"
    ? { role, content: [{ type: "text", text }], timestamp: Date.now() }
    : { role, content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() };
  const row = await appendMessage(pool, { session_id: sessionId, seq, role, json });
  await persistAndPublishSessionEvent(pool, {
    session_id: sessionId,
    event_type: "message_completed",
    data: { message_id: row.id, seq: row.seq, role: row.role },
  });
}

async function setJobSessionStatus(
  pool: pg.Pool,
  sessionId: string | null,
  status: "queued" | "running" | "success" | "partial" | "failed" | "cancelled",
  at: Date,
  errorSummary: string | null = null,
): Promise<void> {
  if (!sessionId) return;
  await updateSessionStatus(pool, sessionId, { status, at, error_summary: errorSummary });
  await persistAndPublishSessionEvent(pool, {
    session_id: sessionId,
    event_type: "session_status",
    data: { status },
  });
}

async function publishJobRefresh(
  pool: pg.Pool,
  sessionId: string | null,
  reason: string,
  targets: string[] = ["jobs", "status"],
): Promise<void> {
  if (!sessionId) return;
  await persistAndPublishSessionEvent(pool, {
    session_id: sessionId,
    event_type: "ui_refresh",
    data: { targets, reason, requested_at: new Date().toISOString() },
  });
}

function logConversationSyncError(runId: string, error: unknown): void {
  console.error(`作业 ${runId} 已入账，但同步任务对话失败：`, error);
}

async function runAgentFlow(
  pool: pg.Pool,
  prompt: string,
  sessionId: string,
  strategy: StrategyBundle,
  config: AgentFlowJobConfig,
  run: JobRunRow,
  definition: JobDefinitionRow,
): Promise<string> {
  const systemPrompt = await buildSystemPrompt(pool, strategy);
  const settings = await getAgentSettings(pool);
  const tools: AgentTool[] = buildChatTools({
    pool,
    sessionId,
    marketDomainToolsEnabled: settings.market_domain_tools_enabled,
  });
  if (config.pool_attention_write) tools.push(buildJobPoolAttentionTool({ pool, sessionId }));
  if (config.daily_plan_write) {
    tools.push(buildJobDailyPlanTool({ pool, sessionId, runId: run.id }));
  }
  if (definition.code === "auction_opportunity_assessment") {
    tools.push(buildJobAuctionAssessmentTool({ pool, sessionId, runId: run.id }));
  }
  const turn = await runAgentSessionTurn({
    pool,
    sessionId,
    historyMode: "session",
    systemPrompt,
    systemPromptSuffix:
      "自动作业与普通 Agent 使用相同工具权限和当前确认制/YOLO 设置；策略发布仍只能创建待真人审核提案。任务结果由 Runner 关联本次运行保存。",
    manageSessionStatus: false,
    text: prompt,
    tools,
  });
  if (turn.aborted) throw new AgentRunAbortedError();
  if (turn.llmError) throw new Error(turn.llmError);
  const markdown = textOfAssistant(turn.lastAssistant);
  if (!markdown) throw new Error("agent_flow 未产生 Markdown 文本");
  return markdown.startsWith(RESULT_BANNER) ? markdown : `${RESULT_BANNER}\n\n${markdown}`;
}

async function pinJobStrategySnapshot(pool: pg.Pool, run: JobRunRow): Promise<StrategyBundle> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const pinned = await client.query<{
      strategy_change_seq: string | null;
      strategy_snapshot_hash: string | null;
      session_id: string | null;
    }>(
      `SELECT strategy_change_seq::text, strategy_snapshot_hash, session_id::text
         FROM job_run WHERE id = $1 FOR UPDATE`,
      [run.id],
    );
    const row = pinned.rows[0];
    if (!row) throw new Error(`作业运行不存在：${run.id}`);
    const strategy = row.strategy_change_seq === null
      ? await getCurrentStrategy(client)
      : await getStrategySnapshot(client, row.strategy_change_seq);
    if (row.strategy_snapshot_hash && row.strategy_snapshot_hash !== strategy.state.current_hash) {
      throw new Error(`作业固化策略快照哈希不一致：change_seq=${row.strategy_change_seq}`);
    }
    if (row.strategy_change_seq === null) {
      await client.query(
        `UPDATE job_run
            SET strategy_change_seq = $2, strategy_snapshot_hash = $3
          WHERE id = $1`,
        [run.id, strategy.state.change_seq, strategy.state.current_hash],
      );
    }
    if (row.session_id) {
      await client.query(
        `UPDATE chat_session
            SET strategy_state_revision = $2, strategy_state_sha256 = $3, updated_at = now()
          WHERE id = $1`,
        [row.session_id, strategy.state.change_seq, strategy.state.current_hash],
      );
    }
    await client.query("COMMIT");
    run.strategy_change_seq = strategy.state.change_seq;
    run.strategy_snapshot_hash = strategy.state.current_hash;
    return strategy;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function pinJobPromptRevision(
  pool: pg.Pool,
  run: JobRunRow,
  definition: JobDefinitionRow,
): Promise<{ id: string; content: string }> {
  if (run.prompt_revision_id) {
    const pinned = await pool.query<{ id: string; content: string }>(
      "SELECT id::text, content FROM job_prompt_revision WHERE id = $1",
      [run.prompt_revision_id],
    );
    if (!pinned.rows[0]) throw new Error(`作业运行固化的提示词版本不存在：${run.prompt_revision_id}`);
    return pinned.rows[0];
  }
  if (!definition.prompt_id) throw new Error(`agent_flow 作业 ${definition.code} 未绑定数据库提示词`);
  const current = await pool.query<{ id: string; content: string }>(
    `SELECT r.id::text, r.content
       FROM job_prompt p JOIN job_prompt_revision r ON r.id = p.current_revision_id
      WHERE p.id = $1 AND p.status = 'active'`,
    [definition.prompt_id],
  );
  const revision = current.rows[0];
  if (!revision) throw new Error(`agent_flow 作业 ${definition.code} 的提示词不可用`);
  await pool.query(
    "UPDATE job_run SET prompt_revision_id = $2 WHERE id = $1 AND prompt_revision_id IS NULL",
    [run.id, revision.id],
  );
  run.prompt_revision_id = revision.id;
  return revision;
}

async function executeDatasource(
  deps: RunnerDeps,
  run: JobRunRow,
  config: DatasourceJobConfig,
): Promise<JobExecutionResult> {
  let dailyMode: DailyMarketMode | null = null;
  if (config.pipeline === "daily_market_update") {
    const gate = await dailyMarketGate(deps.pool, run.target_date, deps.now?.() ?? new Date());
    if (gate.action === "skip") return { status: "success", log: `${gate.reason}，无需执行行情更新或数据卷导出。` };
    if (gate.action === "reject") throw new NonRetryableJobError(gate.reason);
    dailyMode = gate.mode;
  }
  return withMarketMutationLock(deps.pool, async () => {
    const artifacts: unknown[] = [];
    let result: JobExecutionResult;
    if (config.pipeline === "daily_market_update") {
      const scope = await resolveDailyUpdateScope(deps.pool, run.target_date, dailyMode!);
      const summary = deps.dailyUpdate
        ? await deps.dailyUpdate(scope, run.id)
        : await dailyMarketUpdate(deps.pool, scope, { jobRunId: run.id });
      const gaps = summary.gaps ?? [];
      result = {
        status: gaps.length > 0 ? "partial" : "success",
        log:
          `行情更新完成：日线/快照 ${summary.snapshotRows} 行，期货 ${summary.futuresRows} 行，` +
          `30分钟 ${summary.minute30Rows} 行，缺口 ${gaps.length} 项。`,
        dataGaps: gaps,
      };
    } else if (config.pipeline === "market_catalog_sync") {
      const summary = deps.catalogSync
        ? await deps.catalogSync(run.id)
        : await syncMarketCatalog(deps.pool, { jobRunId: run.id });
      result = {
        status: "success",
        log: `市场目录同步完成：标的 ${summary.tickerCount}、板块 ${summary.boardCount}、交易日 ${summary.tradingDayCount}。`,
        artifacts: summary.fetchRunIds.map((id) => ({ kind: "market_fetch_run", id })),
      };
    } else if (config.pipeline === "board_membership_sync") {
      const summary = deps.boardMembershipSync
        ? await deps.boardMembershipSync(run.target_date, run.id)
        : await syncAllBoardMemberships(deps.pool, run.target_date, { jobRunId: run.id });
      const memberCount = summary.completed.reduce((sum, item) => sum + item.memberCount, 0);
      const opened = summary.completed.reduce((sum, item) => sum + item.opened, 0);
      const closed = summary.completed.reduce((sum, item) => sum + item.closed, 0);
      result = {
        status: summary.gaps.length > 0 ? "partial" : "success",
        log: `板块成分同步完成：板块 ${summary.completed.length}、成分 ${memberCount}、新增 ${opened}、关闭 ${closed}、缺口 ${summary.gaps.length}。`,
        dataGaps: summary.gaps,
      };
    } else {
      const summary = deps.marketStructureSync
        ? await deps.marketStructureSync(run.target_date, run.id)
        : await syncDailyMarketStructure(deps.pool, run.target_date, { jobRunId: run.id });
      const rows = summary.datasets.reduce((sum, dataset) => sum + dataset.rows, 0);
      result = {
        status: summary.gaps.length > 0 ? "partial" : "success",
        log: `市场结构同步完成：数据集 ${summary.datasets.length}、记录 ${rows}、缺口 ${summary.gaps.length}。`,
        artifacts: summary.datasets.map((dataset) => ({
          kind: "market_special_sync_run",
          id: dataset.runId,
          dataset: dataset.dataset,
          status: dataset.status,
        })),
        dataGaps: summary.gaps,
      };
    }
    if (config.export_volume) {
      const volume = deps.volumeExport
        ? await deps.volumeExport()
        : await exportVolume(deps.pool, deps.databaseUrl, { kind: "scheduled" });
      artifacts.push({
        kind: "volume_snapshot",
        path: path.relative(PROJECT_ROOT, volume.dumpPath),
        manifest_path: path.relative(PROJECT_ROOT, volume.manifestPath),
      });
    }
    return {
      ...result,
      artifacts: [...(result.artifacts ?? []), ...artifacts],
    };
  });
}

async function executeAnalysisJob(deps: RunnerDeps, config: AnalysisJobConfig): Promise<JobExecutionResult> {
  const request = { analysis_type: config.analysis_type, ...(config.request ?? {}) } as AnalysisRequest;
  const run = deps.analysisRun ? await deps.analysisRun(request) : await executeAnalysis(deps.pool, request);
  return {
    status: run.status === "partial" ? "partial" : "success",
    log: `服务内分析 ${config.analysis_type} 完成，analysis_run #${run.id}，缺口 ${run.data_gaps.length} 项。`,
    artifacts: [{ kind: "analysis_run", id: run.id, analysis_type: config.analysis_type }],
    dataGaps: run.data_gaps,
  };
}

async function executeAgentFlow(
  deps: RunnerDeps,
  run: JobRunRow,
  definition: JobDefinitionRow,
  config: AgentFlowJobConfig,
): Promise<JobExecutionResult> {
  if (!run.session_id) throw new Error("agent_flow 缺少任务对话");
  if (definition.code === "auction_opportunity_assessment" && run.attempt_count > 1) {
    await discardDraftAuctionAssessmentsForRun(deps.pool, run.id);
  }
  const strategy = await pinJobStrategySnapshot(deps.pool, run);
  const revision = await pinJobPromptRevision(deps.pool, run, definition);
  const prompt = buildAgentJobPrompt(revision.content, run, definition, config);
  let markdown: string;
  if (deps.agentFlow) {
    await appendConversationMessage(deps.pool, run.session_id, "user", prompt);
    markdown = await deps.agentFlow(config, run, definition);
    markdown = markdown.startsWith(RESULT_BANNER) ? markdown : `${RESULT_BANNER}\n\n${markdown}`;
    await appendConversationMessage(deps.pool, run.session_id, "assistant", markdown);
  } else {
    markdown = await runAgentFlow(deps.pool, prompt, run.session_id, strategy, config, run, definition);
  }
  return {
    status: "success",
    log: `agent_flow 已生成 ${markdown.length} 字符 Markdown，结果将关联当前任务运行保存。`,
    resultMd: markdown,
  };
}

const RUN_RETURNING = `id::text, job_id::text, task_run_id::text, prompt_revision_id::text,
  session_id::text, strategy_change_seq::text, strategy_snapshot_hash,
  target_date::text, trigger_kind, scheduled_for, status, attempt_count, next_retry_at,
  log, artifacts, data_gaps, result_md, started_at, finished_at, created_at`;

async function claimRun(pool: pg.Pool, id: string, now: Date): Promise<JobRunRow | null> {
  const result = await pool.query<JobRunRow>(
    `UPDATE job_run
        SET status = 'running', attempt_count = attempt_count + 1,
            next_retry_at = NULL, started_at = COALESCE(started_at, $2), finished_at = NULL
      WHERE id = $1 AND status = 'queued'
        AND (next_retry_at IS NULL OR next_retry_at <= $2)
      RETURNING ${RUN_RETURNING}`,
    [id, now],
  );
  return result.rows[0] ?? null;
}

async function finishRun(
  pool: pg.Pool,
  run: JobRunRow,
  result: JobExecutionResult,
  now: Date,
): Promise<{ run: JobRunRow; outputId: string | null }> {
  const status: JobStatus = result.status;
  const appended = trimLog(run.log + logLine(`第 ${run.attempt_count} 次尝试：${result.log}`, now));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<JobRunRow>(
      `UPDATE job_run SET status = $2, log = $3, artifacts = $4, data_gaps = $5,
              result_md = NULL, finished_at = $6, next_retry_at = NULL
        WHERE id = $1
        RETURNING ${RUN_RETURNING}`,
      [
        run.id,
        status,
        appended,
        JSON.stringify(result.artifacts ?? []),
        JSON.stringify(result.dataGaps ?? []),
        now,
      ],
    );
    const finished = updated.rows[0]!;
    let outputId: string | null = null;
    if (result.resultMd) {
      const output = await client.query<{ id: string }>(
        `INSERT INTO job_run_output
           (job_id, run_id, session_id, output_type, target_date, markdown, sha256,
            status, source, strategy_change_seq, strategy_snapshot_hash, created_at)
         SELECT r.job_id, r.id, r.session_id,
                CASE d.code WHEN 'daily_plan_flow' THEN 'daily_plan' ELSE d.code END,
                r.target_date, $2, $3, 'generated', 'agent_flow',
                r.strategy_change_seq, r.strategy_snapshot_hash, $4
           FROM job_run r JOIN job_definition d ON d.id = r.job_id
          WHERE r.id = $1
            AND NOT EXISTS (SELECT 1 FROM job_run_output existing WHERE existing.run_id = r.id)
         RETURNING id::text`,
        [
          run.id,
          result.resultMd,
          crypto.createHash("sha256").update(result.resultMd, "utf8").digest("hex"),
          now,
        ],
      );
      outputId = output.rows[0]?.id ?? (
        await client.query<{ id: string }>(
          "SELECT id::text FROM job_run_output WHERE run_id = $1 ORDER BY id DESC LIMIT 1",
          [run.id],
        )
      ).rows[0]?.id ?? null;
      await activatePlaybookForRun(client, run.id, outputId);
      await activateAuctionAssessmentsForRun(client, run.id, outputId);
    }
    await client.query("COMMIT");
    return { run: finished, outputId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function failOrRetry(
  deps: RunnerDeps,
  run: JobRunRow,
  error: unknown,
  now: Date,
): Promise<JobRunRow> {
  const retry = !(error instanceof NonRetryableJobError) && run.attempt_count < 2;
  const message = (error as Error).message || String(error);
  const failureSuffix = retry
    ? "；5 分钟后自动重试一次"
    : error instanceof NonRetryableJobError ? "；该错误不可重试" : "；已达到重试上限";
  const appended = trimLog(
    run.log +
      logLine(
        `第 ${run.attempt_count} 次尝试失败：${message}${failureSuffix}`,
        now,
      ),
  );
  const nextRetry = retry
    ? new Date(now.getTime() + (deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS))
    : null;
  const updated = await deps.pool.query<JobRunRow>(
    `UPDATE job_run SET status = $2, log = $3, next_retry_at = $4::timestamptz,
            finished_at = CASE WHEN $2 = 'failed' THEN $5::timestamptz ELSE NULL END
      WHERE id = $1
      RETURNING ${RUN_RETURNING}`,
    [run.id, retry ? "queued" : "failed", appended, nextRetry, now],
  );
  return updated.rows[0]!;
}

async function cancelRun(pool: pg.Pool, run: JobRunRow, now: Date): Promise<JobRunRow> {
  const appended = trimLog(run.log + logLine(`第 ${run.attempt_count} 次尝试：用户已中断任务`, now));
  const result = await pool.query<JobRunRow>(
    `UPDATE job_run SET status = 'cancelled', log = $2, next_retry_at = NULL, finished_at = $3
      WHERE id = $1
      RETURNING ${RUN_RETURNING}`,
    [run.id, appended, now],
  );
  return result.rows[0]!;
}

async function recordFailureInConversation(
  deps: RunnerDeps,
  run: JobRunRow,
  error: unknown,
  at: Date,
): Promise<void> {
  if (!run.session_id) return;
  const message = ((error as Error).message || String(error)).slice(0, 4_000);
  const retry = run.status === "queued";
  await setJobSessionStatus(deps.pool, run.session_id, retry ? "queued" : "failed", at, message)
    .catch((syncError) => logConversationSyncError(run.id, syncError));
  await appendConversationMessage(
    deps.pool,
    run.session_id,
    "assistant",
    retry
      ? `第 ${run.attempt_count} 次执行失败：${message}\n\n任务将在计划时间自动重试，本对话将继续保留执行记录。`
      : `任务执行失败：${message}\n\n已达到自动重试上限，可在本对话继续追问或重新发起任务。`,
  ).catch((syncError) => logConversationSyncError(run.id, syncError));
  await publishJobRefresh(deps.pool, run.session_id, retry ? "任务等待自动重试" : "任务执行失败")
    .catch((syncError) => logConversationSyncError(run.id, syncError));
}

/** 原子 claim 后执行一次；同一 run 被多个 tick 看见也只会有一个进入 Runner。 */
export async function executeJobRun(deps: RunnerDeps, runId: string): Promise<JobRunRow | null> {
  const started = deps.now?.() ?? new Date();
  const run = await claimRun(deps.pool, runId, started);
  if (!run) return null;
  const detail = await findJobRunById(deps.pool, run.id);
  if (!detail) return failOrRetry(deps, run, new Error("作业运行记录或定义不存在"), started);
  try {
    await setJobSessionStatus(deps.pool, run.session_id, "running", started);
    const config = validateJobConfig(detail.job.job_type, detail.job.config);
    let result: JobExecutionResult;
    if (detail.job.job_type === "datasource") {
      result = await executeDatasource(deps, run, config as DatasourceJobConfig);
    } else if (detail.job.job_type === "analysis") {
      result = await executeAnalysisJob(deps, config as AnalysisJobConfig);
    } else {
      result = await executeAgentFlow(deps, run, detail.job, config as AgentFlowJobConfig);
    }
    const finishedAt = deps.now?.() ?? new Date();
    const finished = await finishRun(deps.pool, run, result, finishedAt);
    if (finished.run.session_id && finished.outputId) {
      await appendConversationMessage(
          deps.pool,
          finished.run.session_id,
          "assistant",
          `任务结果已保存。\n\n[查看任务结果 #${finished.outputId}](/?result=job-output:${finished.outputId})`,
        ).catch((error) => logConversationSyncError(finished.run.id, error));
    }
    await setJobSessionStatus(deps.pool, finished.run.session_id, result.status, finishedAt)
      .catch((error) => logConversationSyncError(finished.run.id, error));
    const refreshTargets = detail.job.code === "daily_plan_flow"
      ? ["jobs", "status", "dashboard", "positions",
          ...((config as AgentFlowJobConfig).pool_attention_write ? ["pools"] : [])]
      : detail.job.code === "auction_opportunity_assessment"
        ? ["jobs", "status", "dashboard"]
      : ["jobs", "status"];
    await publishJobRefresh(deps.pool, finished.run.session_id, "任务运行与结果已更新", refreshTargets)
      .catch((error) => logConversationSyncError(finished.run.id, error));
    return finished.run;
  } catch (error) {
    const failedAt = deps.now?.() ?? new Date();
    if (error instanceof AgentRunAbortedError) {
      const cancelled = await cancelRun(deps.pool, run, failedAt);
      if (detail.job.code === "auction_opportunity_assessment") {
        await discardDraftAuctionAssessmentsForRun(deps.pool, run.id);
      }
      if (cancelled.session_id) {
        await appendConversationMessage(deps.pool, cancelled.session_id, "assistant", "任务已由用户中断，不会自动重试。")
          .catch((syncError) => logConversationSyncError(cancelled.id, syncError));
      }
      await setJobSessionStatus(deps.pool, cancelled.session_id, "cancelled", failedAt)
        .catch((syncError) => logConversationSyncError(cancelled.id, syncError));
      await publishJobRefresh(deps.pool, cancelled.session_id, "任务已由用户中断")
        .catch((syncError) => logConversationSyncError(cancelled.id, syncError));
      return cancelled;
    }
    const failed = await failOrRetry(deps, run, error, failedAt);
    if (detail.job.code === "auction_opportunity_assessment" && failed.status === "failed") {
      await discardDraftAuctionAssessmentsForRun(deps.pool, run.id);
    }
    await recordFailureInConversation(deps, failed, error, failedAt);
    return failed;
  }
}

/**
 * 服务重启时，上一进程遗留的 running 不可能仍在执行：按一次失败收敛到 retry/failed，
 * 任务对话保持不变，恢复说明直接追加进该对话。
 */
export async function recoverInterruptedJobRuns(
  deps: RunnerDeps,
  at = deps.now?.() ?? new Date(),
): Promise<number> {
  const result = await deps.pool.query<JobRunRow>(
    `SELECT ${RUN_RETURNING} FROM job_run WHERE status = 'running' ORDER BY id`,
  );
  let recovered = 0;
  for (const run of result.rows) {
    const error = new Error("服务重启：上一进程中的运行已中断");
    const retry = run.attempt_count < 2;
    const appended = trimLog(
      run.log +
        logLine(
          `第 ${run.attempt_count} 次尝试失败：${error.message}${retry ? "；5 分钟后自动重试一次" : "；已达到重试上限"}`,
          at,
        ),
    );
    const nextRetry = retry
      ? new Date(at.getTime() + (deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS))
      : null;
    const claimed = await deps.pool.query<JobRunRow>(
      `UPDATE job_run SET status = $2, log = $3, next_retry_at = $4::timestamptz,
              finished_at = CASE WHEN $2 = 'failed' THEN $5::timestamptz ELSE NULL END
        WHERE id = $1 AND status = 'running'
        RETURNING ${RUN_RETURNING}`,
      [run.id, retry ? "queued" : "failed", appended, nextRetry, at],
    );
    const failed = claimed.rows[0];
    if (!failed) continue;
    await recordFailureInConversation(deps, failed, error, at);
    recovered += 1;
  }
  return recovered;
}
