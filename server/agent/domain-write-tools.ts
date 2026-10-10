// 按业务领域封装的 Agent 写入：模型只能提交领域命令，不能指定表、列或 SQL。
// 预览与执行均复用正式领域 service；执行前在 SERIALIZABLE + advisory lock 事务内
// 重新锁定目标状态并校验指纹，防止旧提案覆盖新事实。
import type pg from "pg";
import { applyPoolChange, setPoolBoardOrder } from "../modules/pools/repo.js";
import { resolvePoolOnboarding } from "../modules/pools/onboarding.js";
import { recordPositionChange, updatePositionEntrySignalType } from "../modules/positions/repo.js";
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
  validateMemoryWriteInput,
  validatePoolOnboardCommitInput,
  validatePoolWriteInput,
  validatePortfolioWriteInput,
  validatePositionEntrySignalWriteInput,
  type JobWriteInput,
  type MemoryWriteInput,
  type PoolOnboardCommitInput,
  type PoolWriteOperation,
  type PoolWriteInput,
  type PortfolioWriteInput,
  type PositionEntrySignalWriteInput,
} from "./tool-validation.js";
import { sha256Json } from "./hash.js";
import { sameTimestampVersion } from "../db/timestamp.js";

export type DomainWriteToolName =
  | "portfolio_write"
  | "position_entry_signal_write"
  | "pool_onboard"
  | "pool_write"
  | "job_write"
  | "memory_write";

export type DomainWriteInput =
  | PortfolioWriteInput
  | PositionEntrySignalWriteInput
  | PoolOnboardCommitInput
  | PoolWriteInput
  | JobWriteInput
  | MemoryWriteInput;

function validateDomainInput(toolName: DomainWriteToolName, input: unknown): DomainWriteInput {
  switch (toolName) {
    case "portfolio_write": return validatePortfolioWriteInput(input);
    case "position_entry_signal_write": return validatePositionEntrySignalWriteInput(input);
    case "pool_onboard": return validatePoolOnboardCommitInput(input);
    case "pool_write": return validatePoolWriteInput(input);
    case "job_write": return validateJobWriteInput(input);
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

async function portfolioState(
  client: pg.PoolClient,
  code: string,
  changeDates: string[],
  lock: boolean,
  accountId = "1",
): Promise<unknown> {
  const instrument = await oneRow(
    client,
    `SELECT id::text, code, name, kind FROM market_instrument WHERE code = $1${lock ? " FOR UPDATE" : ""}`,
    [code],
  );
  if (!instrument) throw new Error(`未知标的代码：${code}`);
  const position = await oneRow(
    client,
    `SELECT instrument_id::text, quantity::text, cost_price::text, cost_basis,
            opened_at::text, updated_at
       FROM portfolio_position WHERE account_id = $1 AND instrument_id = $2${lock ? " FOR UPDATE" : ""}`,
    [accountId, instrument.id],
  );
  const latestChange = await oneRow(
    client,
    `SELECT id::text, change_date::text, kind, quantity::text, price::text, reason, created_at
       FROM portfolio_position_change WHERE account_id = $1 AND instrument_id = $2
      ORDER BY id DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [accountId, instrument.id],
  );
  const passedSignals = await client.query(
    `SELECT assessment.id::text, assessment.conclusion, assessment.review_type,
            assessment.status, auction_run.target_date::text AS assessment_date,
            item.plan_output_id::text
       FROM daily_plan_auction_assessment assessment
       JOIN daily_plan_playbook item ON item.id = assessment.playbook_item_id
       JOIN job_run auction_run ON auction_run.id = assessment.source_job_run_id
      WHERE assessment.account_id=$3 AND assessment.code = $1
        AND auction_run.target_date = ANY($2::date[])
        AND assessment.conclusion = 'signal_passed'
        AND assessment.status IN ('active','superseded')
      ORDER BY auction_run.target_date, assessment.id`,
    [code, changeDates, accountId],
  );
  const account = await oneRow(client, `SELECT id::text,name,status FROM portfolio_account WHERE id=$1${lock ? " FOR UPDATE" : ""}`,[accountId]);
  if (!account || account.status !== "active") throw new Error("账户不存在或已归档");
  return { account, instrument, position, latest_change: latestChange, passed_signals: passedSignals.rows };
}

async function positionEntrySignalState(
  client: pg.PoolClient,
  input: PositionEntrySignalWriteInput,
  lock: boolean,
  accountId = "1",
): Promise<unknown> {
  const instrument = await oneRow(
    client,
    `SELECT id::text, code, name FROM market_instrument WHERE code = $1${lock ? " FOR UPDATE" : ""}`,
    [input.code],
  );
  if (!instrument) throw new Error(`未知标的代码：${input.code}`);
  const position = await oneRow(
    client,
    `SELECT instrument_id::text, quantity::text, opened_at::text, entry_signal_type
       FROM portfolio_position WHERE account_id = $1 AND instrument_id = $2 AND quantity > 0${lock ? " FOR UPDATE" : ""}`,
    [accountId, instrument.id],
  );
  if (!position) throw new Error(`标的 ${input.code} 当前无持仓，不能修正买入信号类型`);
  return { instrument, position };
}

async function poolState(client: pg.PoolClient, input: PoolWriteOperation, lock: boolean): Promise<unknown> {
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
    `SELECT id::text, pool, role, tags, stock_character,
            stock_character_profile, stage, evaluation_summary, profile_as_of::text,
            profile_calculation_version, profile_input_sha256, effective_from::text, effective_to::text, note
       FROM pool_membership
      WHERE instrument_id = $1 AND effective_to IS NULL
      ORDER BY id DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [instrument.id],
  );
  if ((input.action === "update" || input.action === "remove") && !current) {
    throw new Error(`标的 ${input.code} 在关注池没有当前角色行`);
  }
  if (input.action === "update" && current?.pool !== input.pool) {
    throw new Error("pool_write 不负责迁池；请使用 pool_onboard");
  }
  return { instrument, current };
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
      `SELECT id::text, code, name, cron, job_type, config, prompt_id::text, model_id::text, enabled,
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
  accountId = "1",
): Promise<unknown> {
  switch (toolName) {
    case "portfolio_write": {
      const value = input as PortfolioWriteInput;
      const states = [];
      for (const code of [...new Set(value.changes.map((change) => change.code))].sort()) {
        const changeDates = value.changes
          .filter((change) => change.code === code)
          .map((change) => change.change_date);
        states.push(await portfolioState(client, code, changeDates, lock, accountId));
      }
      return states;
    }
    case "position_entry_signal_write":
      return positionEntrySignalState(client, input as PositionEntrySignalWriteInput, lock, accountId);
    case "pool_onboard": return resolvePoolOnboarding(client, input as PoolOnboardCommitInput, lock);
    case "pool_write": {
      const value = input as PoolWriteInput;
      const operations = [...value.operations].sort((left, right) => {
        const leftKey = left.action === "set_board_order" ? `board:${left.pool}` : `member:${left.code}`;
        const rightKey = right.action === "set_board_order" ? `board:${right.pool}` : `member:${right.code}`;
        return leftKey.localeCompare(rightKey);
      });
      const states = [];
      for (const operation of operations) states.push(await poolState(client, operation, lock));
      return states;
    }
    case "job_write": return jobState(client, input as JobWriteInput, lock);
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
  portfolio_write: "持仓",
  position_entry_signal_write: "持仓信号归因",
  pool_onboard: "标的入池初始化",
  pool_write: "标的池",
  job_write: "作业",
  memory_write: "Agent 记忆",
};

function targetSummary(toolName: DomainWriteToolName, input: DomainWriteInput, state: unknown): Record<string, unknown> {
  if (toolName === "portfolio_write") {
    const value = input as PortfolioWriteInput;
    return {
      count: value.changes.length,
      changes: value.changes.map((change) => ({
        code: change.code,
        kind: change.kind,
        change_date: change.change_date,
        quantity: change.quantity,
        price: change.price,
      })),
    };
  }
  if (toolName === "position_entry_signal_write") {
    const value = input as PositionEntrySignalWriteInput;
    const position = (state as { position: { entry_signal_type: string | null } | null }).position;
    return {
      code: value.code,
      previous_entry_signal_type: position?.entry_signal_type ?? null,
      entry_signal_type: value.entry_signal_type,
    };
  }
  if (toolName === "pool_onboard") {
    return (state as Awaited<ReturnType<typeof resolvePoolOnboarding>>).preview;
  }
  if (toolName === "pool_write") {
    const value = input as PoolWriteInput;
    return {
      count: value.operations.length,
      operations: value.operations.map((operation) => operation.action === "set_board_order"
        ? { action: operation.action, pool: operation.pool, board_codes: operation.board_codes }
        : {
            action: operation.action,
            code: operation.code,
            pool: operation.pool,
            effective_from: operation.effective_from,
          }),
    };
  }
  if (toolName === "job_write") {
    const value = input as JobWriteInput;
    if (value.action === "create_job") return { code: value.code, job_type: value.job_type, prompt_id: value.prompt_id };
    if (value.action === "update_job") return { code: value.code };
    if (value.action === "create_prompt") return { code: value.code, name: value.name };
    return { prompt_id: value.prompt_id, action: value.action };
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

async function writeAccount(client: pg.PoolClient, toolName: DomainWriteToolName, options: { sessionId?: string | null; accountId?: string | null }) {
  if (!["portfolio_write", "position_entry_signal_write"].includes(toolName)) return undefined;
  const session = options.sessionId ? (await client.query<{ account_id: string | null }>(
    "SELECT account_id::text FROM chat_session WHERE id=$1", [options.sessionId])).rows[0] : null;
  const id = session ? session.account_id : options.accountId === undefined ? "1" : options.accountId;
  if (!id) throw new Error("持仓写入必须绑定账户会话");
  if (options.accountId && session && options.accountId !== session.account_id) throw new Error("写入账户与会话账户不一致");
  return id;
}

export async function previewDomainWrite(
  client: pg.PoolClient,
  toolName: DomainWriteToolName,
  rawInput: unknown,
  options: { lock?: boolean; sessionId?: string | null; accountId?: string | null } = {},
): Promise<DomainWritePreview> {
  const input = validateDomainInput(toolName, rawInput);
  return buildDomainWritePreview(client, toolName, input, options.lock === true, await writeAccount(client, toolName, options));
}

async function buildDomainWritePreview(
  client: pg.PoolClient,
  toolName: DomainWriteToolName,
  input: DomainWriteInput,
  lock: boolean,
  accountId?: string | null,
): Promise<DomainWritePreview> {
  const state = await targetState(client, toolName, input, lock, accountId ?? undefined);
  const action = toolName === "portfolio_write" || toolName === "pool_write"
    ? "batch"
    : "action" in input ? String(input.action) : toolName;
  return {
    tool_name: toolName,
    domain: DOMAIN_LABELS[toolName],
    action,
    reason: input.reason,
    target: { ...targetSummary(toolName, input, state), ...(accountId ? { account_id: accountId } : {}) },
    _state_hash: sha256Json({ tool_name: toolName, input, state, account_id: accountId ?? null }),
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
  options: { expectedStateHash?: string | null; sessionId?: string | null; accountId?: string | null } = {},
): Promise<unknown> {
  const input = validateDomainInput(toolName, rawInput);
  const accountId = await writeAccount(client, toolName, options);
  const preview = await buildDomainWritePreview(client, toolName, input, true, accountId);
  if (options.expectedStateHash && options.expectedStateHash !== preview._state_hash) {
    throw new DomainWriteConflictError();
  }

  switch (toolName) {
    case "portfolio_write": {
      const value = input as PortfolioWriteInput;
      const items = [];
      for (const change of value.changes) {
        items.push(await recordPositionChange(client, {
          code: change.code,
          account_id: accountId,
          kind: change.kind,
          quantity: change.quantity,
          price: change.price,
          change_date: change.change_date,
          reason: value.reason,
          source: "chat",
          source_session_id: options.sessionId,
          decision_origin: change.decision_origin,
          execution_compliance: change.execution_compliance,
          strategy_code: change.strategy_code,
          entry_signal_type: change.entry_signal_type,
          entry_signal_id: change.entry_signal_id,
          plan_output_id: change.plan_output_id,
          attribution_note: change.attribution_note,
          deviation_reason: change.deviation_reason,
        }));
      }
      return { total: items.length, items };
    }
    case "position_entry_signal_write": {
      const value = input as PositionEntrySignalWriteInput;
      return updatePositionEntrySignalType(client, {
        code: value.code,
        account_id: accountId,
        entry_signal_type: value.entry_signal_type,
        reason: value.reason,
        source: "chat",
        source_session_id: options.sessionId,
      });
    }
    case "pool_onboard": {
      const resolved = await resolvePoolOnboarding(client, input as PoolOnboardCommitInput, true);
      return applyPoolChange(client, {
        ...resolved.change,
        evaluation_session_id: options.sessionId,
      });
    }
    case "pool_write": {
      const value = input as PoolWriteInput;
      const items = [];
      for (const operation of value.operations) {
        if (operation.action === "set_board_order") {
          items.push(await setPoolBoardOrder(client, operation.board_codes!));
          continue;
        }
        items.push(await applyPoolChange(client, {
          action: operation.action,
          code: operation.code!,
          pool: operation.pool,
          effective_from: operation.effective_from!,
          note: operation.note,
          evaluation_session_id: options.sessionId,
        }));
      }
      return { total: items.length, items };
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
          model_id: value.model_id,
          purpose: value.purpose,
          phase: value.phase,
          priority: value.priority,
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
    case "memory_write": {
      if (!options.sessionId) throw new Error("memory_write 必须绑定持久化 Agent 会话");
      return applyMemoryChange(client, { ...(input as MemoryWriteInput), source_session_id: options.sessionId });
    }
  }
}
