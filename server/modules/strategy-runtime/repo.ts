import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import type { StrategyEvaluationRunSummary, StrategyRuntimeDefinition } from "./types.js";

type Db = Pick<pg.Pool | pg.PoolClient, "query">;

const DEFINITION_SELECT = `
  SELECT definition.code, definition.name, definition.strategy_type,
         definition.strategy_document_code, document.title AS strategy_document_title,
         document.sha256 AS strategy_document_sha256,
         definition.status, definition.allow_new_entry,
         definition.entry_evaluator_code, definition.exit_evaluator_code,
         definition.context_evaluator_code, definition.fallback_strategy_code,
         fallback.name AS fallback_strategy_name,
         definition.exit_policy_mode, definition.daily_plan_scope,
         definition.attention_policy, definition.runtime_version,
         definition.created_at::text, definition.updated_at::text,
         COALESCE(position_count.count,0)::int AS position_count,
         COALESCE(attention_count.count,0)::int AS attention_count,
         latest_evaluation.item AS latest_evaluation,
         COALESCE(tasks.items, '[]'::jsonb) AS tasks
    FROM strategy_definition definition
    JOIN strategy_document document ON document.code = definition.strategy_document_code
    LEFT JOIN strategy_definition fallback ON fallback.code = definition.fallback_strategy_code
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS count FROM portfolio_position position
       WHERE position.strategy_code=definition.code AND position.quantity>0 AND ($1::bigint IS NULL OR position.account_id=$1)
    ) position_count ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS count FROM pool_attention_entry attention
       WHERE attention.source_type='strategy' AND attention.strategy_code=definition.code
         AND attention.valid_from<=CURRENT_DATE AND (attention.valid_until IS NULL OR attention.valid_until>=CURRENT_DATE)
    ) attention_count ON true
    LEFT JOIN LATERAL (
      SELECT to_jsonb(run) || jsonb_build_object(
        'id',run.id::text,'target_date',run.target_date::text,'data_date',run.data_date::text,
        'requested_by_job_run_id',run.requested_by_job_run_id::text,'reused_from_run_id',run.reused_from_run_id::text,
        'started_at',run.started_at::text,'finished_at',run.finished_at::text,'created_at',run.created_at::text,
        'last_requested_at',run.last_requested_at::text
      ) AS item
      FROM strategy_evaluation_run run WHERE run.strategy_code=definition.code AND ($1::bigint IS NULL OR run.account_id=$1 OR run.account_id IS NULL)
      ORDER BY run.target_date DESC,run.created_at DESC LIMIT 1
    ) latest_evaluation ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'code', job.code,
               'name', job.name,
               'enabled', job.enabled,
               'agent_role', job.agent_role,
               'purpose', job.purpose,
               'phase', job.phase,
               'priority', job.priority
             ) ORDER BY job.priority NULLS LAST, job.code) AS items
        FROM job_definition job
       WHERE job.strategy_code = definition.code
    ) tasks ON true`;

export async function listStrategyRuntimeDefinitions(db: Db, accountId?: string): Promise<StrategyRuntimeDefinition[]> {
  const result = await db.query<StrategyRuntimeDefinition>(
    `${DEFINITION_SELECT}
      WHERE definition.code NOT IN ('copper_inventory','lithium_warehouse')
      ORDER BY CASE definition.status WHEN 'active' THEN 1 WHEN 'exit_only' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END,
               definition.name, definition.code`,
    [accountId ?? null],
  );
  return result.rows;
}

export async function getStrategyRuntimeDefinition(db: Db, code: string, accountId?: string): Promise<StrategyRuntimeDefinition> {
  const result = await db.query<StrategyRuntimeDefinition>(`${DEFINITION_SELECT} WHERE definition.code = $2 AND definition.code NOT IN ('copper_inventory','lithium_warehouse')`, [accountId ?? null, code]);
  if (!result.rows[0]) throw apiErrors.notFound(`策略运行时不存在：${code}`);
  return result.rows[0];
}

export async function listStrategyEvaluationRuns(
  db: Db,
  strategyCode: string,
  limit = 50,
  accountId?: string,
): Promise<StrategyEvaluationRunSummary[]> {
  await getStrategyRuntimeDefinition(db, strategyCode);
  const result = await db.query<StrategyEvaluationRunSummary>(
    `SELECT run.id::text, run.strategy_code, run.phase, run.target_date::text, run.data_date::text,
            run.evaluator_code, run.evaluator_version, run.strategy_runtime_version,
            run.strategy_snapshot_hash, run.input_fingerprint, run.status,
            run.requested_by_job_run_id::text, requested_job.code AS requested_by_job_code,
            run.reused_from_run_id::text, run.coverage, run.gaps,
            run.started_at::text, run.finished_at::text, run.created_at::text,
            run.result, run.attempt_count, run.last_requested_at::text
       FROM strategy_evaluation_run run
       LEFT JOIN job_run requested_run ON requested_run.id=run.requested_by_job_run_id
       LEFT JOIN job_definition requested_job ON requested_job.id=requested_run.job_id
      WHERE run.strategy_code = $1 AND ($3::bigint IS NULL OR run.account_id=$3 OR run.account_id IS NULL)
      ORDER BY run.target_date DESC, run.created_at DESC
      LIMIT $2`,
    [strategyCode, limit, accountId ?? null],
  );
  return result.rows;
}
