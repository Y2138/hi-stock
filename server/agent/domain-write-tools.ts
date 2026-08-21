// 按业务领域封装的 Agent 写入：模型只能提交领域命令，不能指定表、列或 SQL。
// 预览与执行均复用正式领域 service；执行前在 SERIALIZABLE + advisory lock 事务内
// 重新锁定目标状态并校验指纹，防止旧提案覆盖新事实。
import type pg from "pg";
import { applyPoolChange, setPoolBoardOrder } from "../modules/pools/repo.js";
import { recordPositionChange, upsertAccountSnapshot } from "../modules/positions/repo.js";
import { finalizeBacktest } from "../modules/backtests/repo.js";
import { applyMemoryChange } from "../modules/memory/repo.js";
import { createJobDefinition, updateJobDefinition } from "../scheduler/repo.js";
import {
  appendJobPromptRevision,
  createJobPrompt,
  rollbackJobPrompt,
  updateJobPromptStatus,
} from "../modules/job-prompts/repo.js";
import {
  validateJobWriteInput,
  validateFinalizeBacktestInput,
  validateMemoryWriteInput,
  validatePoolWriteInput,
  validatePortfolioWriteInput,
  type JobWriteInput,
  type FinalizeBacktestInput,
  type MemoryWriteInput,
  type PoolWriteInput,
  type PortfolioWriteInput,
} from "./tool-validation.js";
import { sha256Json } from "./hash.js";
import { sameTimestampVersion } from "../db/timestamp.js";

export type DomainWriteToolName =
  | "portfolio_write"
  | "pool_write"
  | "job_write"
  | "finalize_backtest"
  | "memory_write";

export type DomainWriteInput =
  | PortfolioWriteInput
  | PoolWriteInput
  | JobWriteInput
  | FinalizeBacktestInput
  | MemoryWriteInput;

function validateDomainInput(toolName: DomainWriteToolName, input: unknown): DomainWriteInput {
  switch (toolName) {
    case "portfolio_write": return validatePortfolioWriteInput(input);
    case "pool_write": return validatePoolWriteInput(input);
    case "job_write": return validateJobWriteInput(input);
    case "finalize_backtest": return validateFinalizeBacktestInput(input);
    case "memory_write": return validateMemoryWriteInput(input);
  }
}

async function oneRow(
  client: pg.PoolClient,
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown> | null> {
  const result = await client.query(sql, params);
  return result.rows[0] ?? null;
}

async function portfolioState(client: pg.PoolClient, input: PortfolioWriteInput, lock: boolean): Promise<unknown> {
  if (input.action === "upsert_account_snapshot") {
    const snapshot = await oneRow(
      client,
      `SELECT snap_date::text, total_asset::text, market_value::text, cash::text,
              closed_pnl::text, precision, source, raw_text
         FROM portfolio_account_snapshot WHERE snap_date = $1${lock ? " FOR UPDATE" : ""}`,
      [input.snap_date],
    );
    return { snapshot };
  }
  const instrument = await oneRow(
    client,
    `SELECT id::text, code, name, kind FROM market_instrument WHERE code = $1${lock ? " FOR UPDATE" : ""}`,
    [input.code],
  );
  if (!instrument) throw new Error(`未知标的代码：${input.code}`);
  const position = await oneRow(
    client,
    `SELECT instrument_id::text, quantity::text, cost_price::text, cost_basis,
            opened_at::text, updated_at
       FROM portfolio_position WHERE instrument_id = $1${lock ? " FOR UPDATE" : ""}`,
    [instrument.id],
  );
  const latestChange = await oneRow(
    client,
    `SELECT id::text, change_date::text, kind, quantity::text, price::text, reason, created_at
       FROM portfolio_position_change WHERE instrument_id = $1
      ORDER BY id DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [instrument.id],
  );
  return { instrument, position, latest_change: latestChange };
}

async function poolState(client: pg.PoolClient, input: PoolWriteInput, lock: boolean): Promise<unknown> {
  if (input.action === "set_board_order") {
    const rows = await client.query(
      `SELECT preference.board_instrument_id::text, instrument.code, preference.sort
         FROM pool_board_preference preference
         JOIN market_instrument instrument ON instrument.id = preference.board_instrument_id
        WHERE preference.pool = $1 ORDER BY preference.sort${lock ? " FOR UPDATE OF preference" : ""}`,
      [input.pool],
    );
    return { current_order: rows.rows };
  }
  const instrument = await oneRow(
    client,
    `SELECT id::text, code, name FROM market_instrument WHERE code = $1${lock ? " FOR UPDATE" : ""}`,
    [input.code],
  );
  if (!instrument) throw new Error(`未知标的代码：${input.code}`);
  const current = await oneRow(
    client,
    `SELECT id::text, pool, role, grade, score::text, tags, stock_character, stage,
            evaluation_summary, attention_reason,
            attention_from::text, attention_until::text, effective_from::text, effective_to::text, note
       FROM pool_membership
      WHERE instrument_id = $1 AND effective_to IS NULL
      ORDER BY id DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [instrument.id],
  );
  if (input.action === "add" && current) {
    throw new Error(`标的 ${input.code} 已有当前角色，请用 update`);
  }
  if ((input.action === "update" || input.action === "remove") && !current) {
    throw new Error(`标的 ${input.code} 在 ${input.pool} 池没有当前角色行`);
  }
  return { instrument, current };
}

async function backtestState(client: pg.PoolClient, input: FinalizeBacktestInput, lock: boolean, sessionId?: string | null): Promise<unknown> {
  if (!sessionId) throw new Error("finalize_backtest 必须绑定持久化 Agent 会话");
  const run = await oneRow(client,
    `SELECT id::text, session_id::text, execution_status, conclusion_status, finished_at,
            conclusion_summary, applicability_boundary
       FROM backtest_run WHERE id = $1 AND session_id = $2${lock ? " FOR UPDATE" : ""}`,
    [input.run_id, sessionId],
  );
  if (!run) throw new Error("只能确认当前 Agent 会话中的回测运行");
  const currentFinal = await oneRow(client,
    `SELECT id::text, conclusion_summary, applicability_boundary, finalized_at
       FROM backtest_run WHERE session_id = $1 AND conclusion_status = 'final'
       ORDER BY id DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [sessionId],
  );
  return { run, current_final: currentFinal };
}

async function memoryState(client: pg.PoolClient, input: MemoryWriteInput, lock: boolean): Promise<unknown> {
  if (input.action === "create") {
    const existing = await oneRow(client,
      `SELECT id::text, title, scope, status, updated_at FROM agent_memory_artifact
        WHERE lower(title) = lower($1) AND scope = $2 AND status IN ('active','review_required')
        LIMIT 1${lock ? " FOR UPDATE" : ""}`,
      [input.title, input.scope],
    );
    if (existing) throw new Error("同标题和适用范围已有有效记忆，请使用 update 或 supersede");
    return { existing: null };
  }
  const memory = await oneRow(client,
      `SELECT id::text, title, category, summary, tags, scope, status,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
       FROM agent_memory_artifact WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [input.memory_id],
  );
  if (!memory) throw new Error(`Agent 记忆不存在：${input.memory_id}`);
  return { memory };
}

async function jobState(client: pg.PoolClient, input: JobWriteInput, lock: boolean): Promise<unknown> {
  if (input.action === "create_job") {
    const existing = await oneRow(
      client,
      `SELECT id::text, code, updated_at FROM job_definition WHERE code = $1${lock ? " FOR UPDATE" : ""}`,
      [input.code],
    );
    if (existing) throw new Error(`作业 code 已存在：${input.code}`);
    const prompt = input.prompt_id
      ? await oneRow(client, `SELECT id::text, status, current_revision_id::text FROM job_prompt WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [input.prompt_id])
      : null;
    return { existing: null, prompt };
  }
  if (input.action === "update_job") {
    const job = await oneRow(
      client,
      `SELECT id::text, code, name, cron, job_type, config, prompt_id::text, enabled,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
         FROM job_definition WHERE code = $1${lock ? " FOR UPDATE" : ""}`,
      [input.code],
    );
    if (!job) throw new Error(`作业不存在：${input.code}`);
    if (!sameTimestampVersion(String(job.updated_at), input.base_updated_at)) throw new Error("作业定义基线已变化");
    return { job };
  }
  if (input.action === "create_prompt") {
    const existing = await oneRow(
      client,
      `SELECT id::text, code, current_revision_id::text FROM job_prompt WHERE code = $1${lock ? " FOR UPDATE" : ""}`,
      [input.code],
    );
    if (existing) throw new Error(`提示词 code 已存在：${input.code}`);
    return { existing: null };
  }
  const prompt = await oneRow(
    client,
    `SELECT id::text, code, status, current_revision_id::text, updated_at
       FROM job_prompt WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [input.prompt_id],
  );
  if (!prompt) throw new Error(`提示词不存在：${input.prompt_id}`);
  if (prompt.current_revision_id !== input.base_revision_id) throw new Error("提示词基线已变化");
  if (input.action === "rollback_prompt") {
    const target = await oneRow(
      client,
      "SELECT id::text, revision_no, sha256 FROM job_prompt_revision WHERE id = $1 AND prompt_id = $2",
      [input.target_revision_id, input.prompt_id],
    );
    if (!target) throw new Error(`回滚目标提示词版本不存在：${input.target_revision_id}`);
    return { prompt, target };
  }
  return { prompt };
}

async function targetState(
  client: pg.PoolClient,
  toolName: DomainWriteToolName,
  input: DomainWriteInput,
  lock: boolean,
  sessionId?: string | null,
): Promise<unknown> {
  switch (toolName) {
    case "portfolio_write": return portfolioState(client, input as PortfolioWriteInput, lock);
    case "pool_write": return poolState(client, input as PoolWriteInput, lock);
    case "job_write": return jobState(client, input as JobWriteInput, lock);
    case "finalize_backtest": return backtestState(client, input as FinalizeBacktestInput, lock, sessionId);
    case "memory_write": return memoryState(client, input as MemoryWriteInput, lock);
  }
}

export interface DomainWritePreview {
  tool_name: DomainWriteToolName;
  domain: string;
  action: string;
  reason: string;
  target: Record<string, unknown>;
  _state_hash: string;
}

const DOMAIN_LABELS: Record<DomainWriteToolName, string> = {
  portfolio_write: "组合账户",
  pool_write: "标的池",
  job_write: "作业",
  finalize_backtest: "回测最终结论",
  memory_write: "Agent 记忆",
};

function targetSummary(toolName: DomainWriteToolName, input: DomainWriteInput): Record<string, unknown> {
  if (toolName === "portfolio_write") {
    const value = input as PortfolioWriteInput;
    if (value.action === "upsert_account_snapshot") {
      return {
        snap_date: value.snap_date,
        total_asset: value.total_asset,
        market_value: value.market_value ?? Math.round((value.total_asset - value.cash) * 100) / 100,
        market_value_derived: value.market_value === undefined,
        cash: value.cash,
        closed_pnl: value.closed_pnl,
        precision: value.precision ?? "exact",
      };
    }
    return { code: value.code, kind: value.kind, change_date: value.change_date, quantity: value.quantity, price: value.price };
  }
  if (toolName === "pool_write") {
    const value = input as PoolWriteInput;
    if (value.action === "set_board_order") return { pool: value.pool, board_codes: value.board_codes };
    return {
      code: value.code,
      pool: value.pool,
      effective_from: value.effective_from,
      role: value.role,
      grade: value.grade,
      score: value.score,
      stage: value.stage,
      attention_reason: value.attention_reason,
      attention_from: value.attention_from,
      attention_until: value.attention_until,
    };
  }
  if (toolName === "job_write") {
    const value = input as JobWriteInput;
    if (value.action === "create_job") return { code: value.code, job_type: value.job_type, prompt_id: value.prompt_id };
    if (value.action === "update_job") return { code: value.code };
    if (value.action === "create_prompt") return { code: value.code, name: value.name };
    return { prompt_id: value.prompt_id, action: value.action };
  }
  if (toolName === "finalize_backtest") {
    const value = input as FinalizeBacktestInput;
    return { run_id: value.run_id, conclusion_summary: value.conclusion_summary, applicability_boundary: value.applicability_boundary };
  }
  if (toolName === "memory_write") {
    const value = input as MemoryWriteInput;
    return {
      action: value.action,
      memory_id: "memory_id" in value ? value.memory_id : undefined,
      title: "title" in value ? value.title : undefined,
      category: "category" in value ? value.category : undefined,
      scope: "scope" in value ? value.scope : undefined,
    };
  }
  return {};
}

export async function previewDomainWrite(
  client: pg.PoolClient,
  toolName: DomainWriteToolName,
  rawInput: unknown,
  options: { lock?: boolean; sessionId?: string | null } = {},
): Promise<DomainWritePreview> {
  const input = validateDomainInput(toolName, rawInput);
  return buildDomainWritePreview(client, toolName, input, options.lock === true, options.sessionId);
}

async function buildDomainWritePreview(
  client: pg.PoolClient,
  toolName: DomainWriteToolName,
  input: DomainWriteInput,
  lock: boolean,
  sessionId?: string | null,
): Promise<DomainWritePreview> {
  const state = await targetState(client, toolName, input, lock, sessionId);
  const action = "action" in input ? String(input.action) : toolName;
  return {
    tool_name: toolName,
    domain: DOMAIN_LABELS[toolName],
    action,
    reason: input.reason,
    target: targetSummary(toolName, input),
    _state_hash: sha256Json({ tool_name: toolName, input, state }),
  };
}

export function publicDomainWritePreview(preview: DomainWritePreview): Omit<DomainWritePreview, "_state_hash"> {
  const { _state_hash: _internal, ...result } = preview;
  return result;
}

export class DomainWriteConflictError extends Error {
  readonly code = "DOMAIN_WRITE_STALE";

  constructor() {
    super("领域目标状态在提案后已变化，本次写入未执行；请重新查询当前状态并生成新提案");
    this.name = "DomainWriteConflictError";
  }
}

export async function executeDomainWriteInTransaction(
  client: pg.PoolClient,
  toolName: DomainWriteToolName,
  rawInput: unknown,
  options: { expectedStateHash?: string | null; sessionId?: string | null } = {},
): Promise<unknown> {
  const input = validateDomainInput(toolName, rawInput);
  const preview = await buildDomainWritePreview(client, toolName, input, true, options.sessionId);
  if (options.expectedStateHash && options.expectedStateHash !== preview._state_hash) {
    throw new DomainWriteConflictError();
  }

  switch (toolName) {
    case "portfolio_write": {
      const value = input as PortfolioWriteInput;
      if (value.action === "upsert_account_snapshot") {
        return upsertAccountSnapshot(client, {
          snap_date: value.snap_date,
          total_asset: value.total_asset,
          market_value: value.market_value,
          cash: value.cash,
          closed_pnl: value.closed_pnl,
          precision: value.precision,
          source: "chat",
          reason: value.reason,
        });
      }
      return recordPositionChange(client, {
        code: value.code,
        kind: value.kind,
        quantity: value.quantity,
        price: value.price,
        change_date: value.change_date,
        reason: value.reason,
        source: "chat",
        source_session_id: options.sessionId,
        decision_origin: value.decision_origin,
        execution_compliance: value.execution_compliance,
        plan_output_id: value.plan_output_id,
        attribution_note: value.attribution_note,
        deviation_reason: value.deviation_reason,
      });
    }
    case "pool_write": {
      const value = input as PoolWriteInput;
      if (value.action === "set_board_order") return setPoolBoardOrder(client, value.pool, value.board_codes);
      return applyPoolChange(client, {
        action: value.action,
        code: value.code,
        pool: value.pool,
        role: value.role,
        grade: value.grade,
        score: value.score,
        tags: value.tags,
        stock_character: value.stock_character,
        stage: value.stage,
        evaluation_summary: value.evaluation_summary,
        attention_reason: value.attention_reason,
        attention_from: value.attention_from,
        attention_until: value.attention_until,
        effective_from: value.effective_from,
        note: value.note,
        evaluation_session_id: options.sessionId,
      });
    }
    case "job_write": {
      const value = input as JobWriteInput;
      if (value.action === "create_job") {
        return createJobDefinition(client, {
          code: value.code,
          name: value.name,
          cron: value.cron,
          job_type: value.job_type,
          config: value.config,
          prompt_id: value.prompt_id,
          enabled: value.enabled,
        });
      }
      if (value.action === "update_job") {
        const { action: _action, reason: _reason, code, ...patch } = value;
        return updateJobDefinition(client, code, patch);
      }
      if (value.action === "create_prompt") {
        return createJobPrompt(client, {
          code: value.code,
          name: value.name,
          content: value.content,
          source: "agent",
          change_summary: value.change_summary,
        });
      }
      if (value.action === "update_prompt") {
        return appendJobPromptRevision(client, value.prompt_id, {
          base_revision_id: value.base_revision_id,
          content: value.content,
          source: "agent",
          change_summary: value.change_summary,
        });
      }
      if (value.action === "set_prompt_status") {
        return updateJobPromptStatus(client, value.prompt_id, {
          base_revision_id: value.base_revision_id,
          status: value.status,
        });
      }
      return rollbackJobPrompt(client, value.prompt_id, {
        base_revision_id: value.base_revision_id,
        target_revision_id: value.target_revision_id,
        change_summary: value.change_summary,
      });
    }
    case "finalize_backtest": {
      if (!options.sessionId) throw new Error("finalize_backtest 必须绑定持久化 Agent 会话");
      const value = input as FinalizeBacktestInput;
      return finalizeBacktest(client, {
        session_id: options.sessionId,
        run_id: value.run_id,
        conclusion_summary: value.conclusion_summary,
        applicability_boundary: value.applicability_boundary,
      });
    }
    case "memory_write": {
      if (!options.sessionId) throw new Error("memory_write 必须绑定持久化 Agent 会话");
      return applyMemoryChange(client, { ...(input as MemoryWriteInput), source_session_id: options.sessionId });
    }
  }
}
