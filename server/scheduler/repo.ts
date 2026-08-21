import { apiErrors } from "../http/router.js";
import { createSession } from "../agent/repo.js";
import { inServiceTransaction, type TransactionDb } from "../db/transaction.js";
import { sameTimestampVersion } from "../db/timestamp.js";
import { assertJobType, validateJobConfig } from "./config.js";
import { assertCron, dailyMarketGate, nextCronRun, shanghaiDate } from "./time.js";
import type {
  DatasourceJobConfig,
  Db,
  JobDefinitionRow,
  JobDefinitionWithLatest,
  JobRunRow,
  JobRunOutputRow,
  JobType,
} from "./types.js";

const CODE_RE = /^[a-z][a-z0-9_]{0,62}$/;

function assertCode(value: unknown): string {
  if (typeof value !== "string" || !CODE_RE.test(value)) {
    throw apiErrors.badRequest("code 必须以小写字母开头，且只含小写字母、数字和下划线");
  }
  return value;
}

function assertName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) {
    throw apiErrors.badRequest("name 必须是 1–100 字符的非空字符串");
  }
  return value.trim();
}

function validationError(error: unknown): never {
  throw apiErrors.badRequest((error as Error).message);
}

export async function listJobDefinitions(db: Db): Promise<JobDefinitionWithLatest[]> {
  const result = await db.query<JobDefinitionRow & { latest_run: Partial<JobRunRow> | null }>(
    `SELECT d.id::text, d.code, d.name, d.cron, d.job_type, d.config, d.prompt_id::text, d.enabled,
            to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            to_char(d.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
            (SELECT json_build_object(
                      'id', r.id::text, 'target_date', r.target_date,
                      'trigger_kind', r.trigger_kind, 'status', r.status,
                      'session_id', r.session_id::text,
                      'strategy_change_seq', r.strategy_change_seq::text,
                      'strategy_snapshot_hash', r.strategy_snapshot_hash,
                      'attempt_count', r.attempt_count, 'scheduled_for', r.scheduled_for,
                      'started_at', r.started_at, 'finished_at', r.finished_at)
               FROM job_run r WHERE r.job_id = d.id
              ORDER BY r.id DESC LIMIT 1) AS latest_run
       FROM job_definition d ORDER BY d.code`,
  );
  return result.rows.map((row) => ({
    ...row,
    next_run: row.enabled ? nextCronRun(row.cron)?.toISOString() ?? null : null,
  }));
}

export async function findJobByCode(db: Db, code: string): Promise<JobDefinitionRow | null> {
  const result = await db.query<JobDefinitionRow>(
    `SELECT id::text, code, name, cron, job_type, config, prompt_id::text, enabled,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
       FROM job_definition WHERE code = $1`,
    [code],
  );
  return result.rows[0] ?? null;
}

export async function createJobDefinition(
  db: Db,
  input: { code: unknown; name: unknown; cron: unknown; job_type: unknown; config: unknown; prompt_id?: unknown; enabled?: unknown },
): Promise<JobDefinitionRow> {
  const code = assertCode(input.code);
  const name = assertName(input.name);
  let cron: string;
  let jobType: JobType;
  let config;
  try {
    cron = assertCron(input.cron);
    jobType = assertJobType(input.job_type);
    config = validateJobConfig(jobType, input.config);
  } catch (error) {
    validationError(error);
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw apiErrors.badRequest("enabled 必须是布尔值");
  }
  const promptId = await validatePromptBinding(db, jobType, input.prompt_id);
  const result = await db.query<JobDefinitionRow>(
    `INSERT INTO job_definition (code, name, cron, job_type, config, prompt_id, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id::text, code, name, cron, job_type, config, prompt_id::text, enabled,
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
               to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`,
    [code, name, cron, jobType, JSON.stringify(config), promptId, input.enabled ?? true],
  );
  return result.rows[0]!;
}

export async function updateJobDefinition(
  db: Db,
  code: string,
  patch: Record<string, unknown>,
): Promise<JobDefinitionRow> {
  const allowed = ["name", "cron", "job_type", "config", "prompt_id", "enabled", "base_updated_at"];
  const unknown = Object.keys(patch).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw apiErrors.badRequest(`包含未知字段：${unknown.join(", ")}`);
  if (Object.keys(patch).length === 0) throw apiErrors.badRequest("缺少可更新字段");
  const current = await findJobByCode(db, code);
  if (!current) throw apiErrors.notFound(`未知作业 code：${code}`);

  const name = patch.name === undefined ? current.name : assertName(patch.name);
  let cron: string;
  let jobType: JobType;
  let config;
  try {
    cron = patch.cron === undefined ? current.cron : assertCron(patch.cron);
    jobType = patch.job_type === undefined ? current.job_type : assertJobType(patch.job_type);
    config = validateJobConfig(jobType, patch.config === undefined ? current.config : patch.config);
  } catch (error) {
    validationError(error);
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    throw apiErrors.badRequest("enabled 必须是布尔值");
  }
  if (patch.base_updated_at !== undefined && typeof patch.base_updated_at !== "string") {
    throw apiErrors.badRequest("base_updated_at 必须是时间字符串");
  }
  if (patch.base_updated_at !== undefined && Number.isNaN(new Date(patch.base_updated_at).getTime())) {
    throw apiErrors.badRequest("base_updated_at 必须是有效时间字符串");
  }
  const baseUpdatedAt = patch.base_updated_at === undefined
    ? null
    : sameTimestampVersion(current.updated_at, patch.base_updated_at) ? current.updated_at : patch.base_updated_at;
  const promptId = await validatePromptBinding(
    db,
    jobType,
    patch.prompt_id === undefined ? current.prompt_id : patch.prompt_id,
  );
  const result = await db.query<JobDefinitionRow>(
    `UPDATE job_definition
        SET name = $2, cron = $3, job_type = $4, config = $5,
            prompt_id = $6, enabled = $7, updated_at = now()
      WHERE code = $1
        AND ($8::timestamptz IS NULL OR updated_at = $8::timestamptz)
      RETURNING id::text, code, name, cron, job_type, config, prompt_id::text, enabled,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`,
    [code, name, cron, jobType, JSON.stringify(config), promptId, patch.enabled ?? current.enabled, baseUpdatedAt],
  );
  if (!result.rows[0]) throw apiErrors.conflict("作业定义已被其他会话更新，请刷新后重试");
  return result.rows[0];
}

async function validatePromptBinding(db: Db, jobType: JobType, value: unknown): Promise<string | null> {
  if (jobType !== "agent_flow") {
    if (value !== undefined && value !== null) throw apiErrors.badRequest(`${jobType} 作业不能绑定提示词`);
    return null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw apiErrors.badRequest("agent_flow 作业必须绑定 prompt_id");
  }
  const prompt = await db.query<{ id: string }>(
    `SELECT id::text FROM job_prompt
      WHERE id = $1 AND status = 'active' AND current_revision_id IS NOT NULL`,
    [value],
  );
  if (!prompt.rows[0]) throw apiErrors.badRequest(`提示词不可用：${value}`);
  return prompt.rows[0].id;
}

export async function listJobRuns(db: Db, jobId: string, limit: number): Promise<JobRunRow[]> {
  const result = await db.query<JobRunRow>(
    `SELECT id::text, job_id::text, task_run_id::text, prompt_revision_id::text,
            session_id::text, strategy_change_seq::text, strategy_snapshot_hash,
            target_date::text, trigger_kind,
            scheduled_for, status, attempt_count, next_retry_at, log, artifacts, data_gaps,
            result_md, started_at, finished_at, created_at
       FROM job_run WHERE job_id = $1
      ORDER BY job_run.created_at DESC, job_run.id DESC LIMIT $2`,
    [jobId, limit],
  );
  return result.rows;
}

export async function findJobRunById(db: Db, id: string): Promise<(JobRunRow & { job: JobDefinitionRow }) | null> {
  const result = await db.query<JobRunRow & { job: JobDefinitionRow }>(
    `SELECT r.id::text, r.job_id::text, r.task_run_id::text, r.prompt_revision_id::text,
            r.session_id::text, r.strategy_change_seq::text, r.strategy_snapshot_hash,
            r.target_date::text,
            r.trigger_kind, r.scheduled_for, r.status, r.attempt_count, r.next_retry_at,
            r.log, r.artifacts, r.data_gaps, r.result_md, r.started_at, r.finished_at, r.created_at,
            json_build_object('id', d.id::text, 'code', d.code, 'name', d.name,
              'cron', d.cron, 'job_type', d.job_type, 'config', d.config, 'prompt_id', d.prompt_id::text,
              'enabled', d.enabled,
              'created_at', to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
              'updated_at', to_char(d.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS job
       FROM job_run r JOIN job_definition d ON d.id = r.job_id WHERE r.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

const OUTPUT_SELECT = `SELECT id::text, job_id::text, run_id::text, session_id::text,
  output_type, target_date::text, markdown, sha256, status, source,
  supersedes_output_id::text, strategy_change_seq::text, strategy_snapshot_hash,
  legacy_content_document_id::text, created_at FROM job_run_output`;

export async function listJobOutputs(
  db: Db,
  jobId: string,
  limit: number,
): Promise<JobRunOutputRow[]> {
  const result = await db.query<JobRunOutputRow>(
    `${OUTPUT_SELECT} WHERE job_id = $1 ORDER BY target_date DESC, id DESC LIMIT $2`,
    [jobId, limit],
  );
  return result.rows;
}

export async function listRunOutputs(db: Db, runId: string): Promise<JobRunOutputRow[]> {
  const result = await db.query<JobRunOutputRow>(
    `${OUTPUT_SELECT} WHERE run_id = $1 ORDER BY id DESC`,
    [runId],
  );
  return result.rows;
}

export async function findJobOutputById(
  db: Db,
  id: string,
): Promise<(JobRunOutputRow & { job: JobDefinitionRow }) | null> {
  const result = await db.query<JobRunOutputRow & { job: JobDefinitionRow }>(
    `SELECT o.id::text, o.job_id::text, o.run_id::text, o.session_id::text,
            o.output_type, o.target_date::text, o.markdown, o.sha256, o.status, o.source,
            o.supersedes_output_id::text, o.strategy_change_seq::text, o.strategy_snapshot_hash,
            o.legacy_content_document_id::text, o.created_at,
            json_build_object('id', d.id::text, 'code', d.code, 'name', d.name,
              'cron', d.cron, 'job_type', d.job_type, 'config', d.config,
              'prompt_id', d.prompt_id::text, 'enabled', d.enabled,
              'created_at', to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
              'updated_at', to_char(d.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS job
       FROM job_run_output o JOIN job_definition d ON d.id = o.job_id
      WHERE o.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function queueManualJob(
  db: TransactionDb,
  code: string,
  requestedTargetDate?: string,
  now = new Date(),
): Promise<JobRunRow> {
  const targetDate = requestedTargetDate ?? shanghaiDate(now);
  const parsedDate = new Date(`${targetDate}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) ||
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== targetDate
  ) {
    throw apiErrors.badRequest("target_date 必须是 YYYY-MM-DD");
  }
  return inServiceTransaction(db, async (client) => {
    const def = await findJobByCode(client, code);
    if (!def) throw apiErrors.notFound(`未知作业 code：${code}`);
    let config;
    try {
      config = validateJobConfig(def.job_type, def.config);
    } catch (error) {
      throw apiErrors.badRequest(`作业配置不可执行：${(error as Error).message}`);
    }
    if (def.job_type === "datasource" && (config as DatasourceJobConfig).pipeline === "daily_market_update") {
      const gate = await dailyMarketGate(client, targetDate, now);
      if (gate.action !== "run") throw apiErrors.badRequest(gate.reason);
    }
    if (def.job_type === "agent_flow") {
      await validatePromptBinding(client, def.job_type, def.prompt_id);
    }
    const result = await client.query<JobRunRow>(
      `INSERT INTO job_run (job_id, target_date, trigger_kind)
       VALUES ($1, $2, 'manual')
       RETURNING id::text, job_id::text, task_run_id::text, prompt_revision_id::text,
                 session_id::text, strategy_change_seq::text, strategy_snapshot_hash,
                 target_date::text, trigger_kind,
                 scheduled_for, status, attempt_count, next_retry_at, log, artifacts, data_gaps,
                 result_md, started_at, finished_at, created_at`,
      [def.id, targetDate],
    );
    const run = result.rows[0]!;
    if (def.job_type !== "agent_flow") return run;
    const session = await createSession(client, {
      title: `${def.name} · ${targetDate}`,
      session_type: "job",
      session_status: "queued",
      source: "manual_job",
    });
    await client.query("UPDATE job_run SET session_id = $2 WHERE id = $1", [run.id, session.id]);
    run.session_id = session.id;
    return run;
  });
}

/** cron/missed 共用唯一 scheduled_for；并发 tick 只会有一个插入成功。 */
export async function insertScheduledJobRun(
  db: TransactionDb,
  jobId: string,
  scheduledFor: Date,
  status: "queued" | "missed",
): Promise<JobRunRow | null> {
  return inServiceTransaction(db, async (client) => {
    const definition = await client.query<{ name: string; job_type: JobType }>(
      "SELECT name, job_type FROM job_definition WHERE id = $1",
      [jobId],
    );
    const def = definition.rows[0];
    if (!def) throw apiErrors.notFound(`作业不存在：${jobId}`);
    const targetDate = shanghaiDate(scheduledFor);
    const result = await client.query<JobRunRow>(
      `INSERT INTO job_run
         (job_id, target_date, trigger_kind, scheduled_for, status, finished_at, log)
       VALUES ($1, $2, 'cron', $3, $4,
               CASE WHEN $4 = 'missed' THEN now() ELSE NULL END,
               CASE WHEN $4 = 'missed' THEN '服务停机期间错过计划时刻；未自动补跑。' ELSE '' END)
       ON CONFLICT (job_id, scheduled_for) WHERE scheduled_for IS NOT NULL DO NOTHING
       RETURNING id::text, job_id::text, task_run_id::text, prompt_revision_id::text,
                 session_id::text, strategy_change_seq::text, strategy_snapshot_hash,
                 target_date::text, trigger_kind,
                 scheduled_for, status, attempt_count, next_retry_at, log, artifacts, data_gaps,
                 result_md, started_at, finished_at, created_at`,
      [jobId, targetDate, scheduledFor.toISOString(), status],
    );
    const run = result.rows[0];
    if (!run || status === "missed" || def.job_type !== "agent_flow") return run ?? null;
    const session = await createSession(client, {
      title: `${def.name} · ${targetDate}`,
      session_type: "job",
      session_status: "queued",
      source: "cron",
    });
    await client.query("UPDATE job_run SET session_id = $2 WHERE id = $1", [run.id, session.id]);
    run.session_id = session.id;
    return run;
  });
}

export async function latestScheduledFor(db: Db, jobId: string): Promise<Date | null> {
  const result = await db.query<{ scheduled_for: string | null }>(
    "SELECT MAX(scheduled_for) AS scheduled_for FROM job_run WHERE job_id = $1 AND scheduled_for IS NOT NULL",
    [jobId],
  );
  return result.rows[0]?.scheduled_for ? new Date(result.rows[0].scheduled_for) : null;
}
