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
         COALESCE(tasks.items, '[]'::jsonb) AS tasks
    FROM strategy_definition definition
    JOIN strategy_document document ON document.code = definition.strategy_document_code
    LEFT JOIN strategy_definition fallback ON fallback.code = definition.fallback_strategy_code
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

export async function listStrategyRuntimeDefinitions(db: Db): Promise<StrategyRuntimeDefinition[]> {
  const result = await db.query<StrategyRuntimeDefinition>(
    `${DEFINITION_SELECT}
      ORDER BY CASE definition.status WHEN 'active' THEN 1 WHEN 'exit_only' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END,
               definition.name, definition.code`,
  );
  return result.rows;
}

export async function getStrategyRuntimeDefinition(db: Db, code: string): Promise<StrategyRuntimeDefinition> {
  const result = await db.query<StrategyRuntimeDefinition>(`${DEFINITION_SELECT} WHERE definition.code = $1`, [code]);
  if (!result.rows[0]) throw apiErrors.notFound(`策略运行时不存在：${code}`);
  return result.rows[0];
}

export async function listStrategyEvaluationRuns(
  db: Db,
  strategyCode: string,
  limit = 50,
): Promise<StrategyEvaluationRunSummary[]> {
  await getStrategyRuntimeDefinition(db, strategyCode);
  const result = await db.query<StrategyEvaluationRunSummary>(
    `SELECT id::text, strategy_code, phase, target_date::text, data_date::text,
            evaluator_code, evaluator_version, strategy_runtime_version,
            strategy_snapshot_hash, input_fingerprint, status,
            requested_by_job_run_id::text, reused_from_run_id::text,
            coverage, gaps, started_at::text, finished_at::text, created_at::text,
            result, attempt_count, last_requested_at::text
       FROM strategy_evaluation_run
      WHERE strategy_code = $1
      ORDER BY target_date DESC, created_at DESC
      LIMIT $2`,
    [strategyCode, limit],
  );
  return result.rows;
}
