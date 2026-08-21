// 回测 repo：Agent 自驱回测结论、历史比较与旧记录只读兼容。
// 新运行只能由 run_backtest 工具创建；HTTP 不提供创建、激活或写入入口。
import type pg from "pg";
import { inServiceTransaction, type TransactionDb } from "../../db/transaction.js";
import { apiErrors } from "../../http/router.js";

type Db = Pick<pg.Pool | pg.PoolClient, "query">;

export interface BacktestRunRow {
  id: string;
  name: string;
  kind: string;
  engine_path: string | null;
  engine_git_commit: string | null;
  config_snapshot: unknown;
  input_manifest: unknown[];
  output_dir: string | null;
  report_path: string | null;
  status: string;
  execution_status: string;
  started_at: string | null;
  finished_at: string | null;
  metrics: unknown;
  request_json: Record<string, unknown> | null;
  input_summary: Record<string, unknown>;
  service_version: string | null;
  metrics_json: Record<string, unknown> | null;
  conclusion_md: string | null;
  data_gaps: unknown[];
  progress: number;
  error_message: string | null;
  execution_origin: "legacy" | "service" | "agent_workspace";
  session_id: string | null;
  strategy_change_seq: string | null;
  strategy_snapshot_hash: string | null;
  research_outline: string | null;
  hypothesis: string | null;
  worker_version: string | null;
  sdk_version: string | null;
  source_sha256: string | null;
  source_size_bytes: number | null;
  code_cleanup_status: "not_applicable" | "deleted" | "cleanup_failed";
  conclusion_status: "working" | "final" | "superseded";
  conclusion_summary: string | null;
  applicability_boundary: string | null;
  finalized_at: string | null;
  superseded_by_run_id: string | null;
  comparison_run_ids: string[];
  notes: string | null;
  created_at: string;
}

export interface BacktestRunListItem extends BacktestRunRow {
  is_active_anchor: boolean;
}

export interface BacktestComparison {
  id: string;
  name: string;
  kind: string;
  execution_status: string;
  strategy_change_seq: string | null;
  strategy_snapshot_hash: string | null;
  research_outline: string | null;
  hypothesis: string | null;
  metrics_json: Record<string, unknown> | null;
  conclusion_md: string | null;
  created_at: string;
}

const RUN_SELECT = `r.*,
  COALESCE((SELECT jsonb_agg(c.compared_run_id::text ORDER BY c.compared_run_id)
              FROM backtest_run_comparison c
              JOIN backtest_run prior ON prior.id = c.compared_run_id
             WHERE c.run_id = r.id AND prior.conclusion_status = 'final'), '[]'::jsonb)
    AS comparison_run_ids`;

/** 用户历史只展示每个研究过程晋升后的当前最终结论。 */
export async function listBacktestRuns(db: Db): Promise<BacktestRunListItem[]> {
  const r = await db.query<BacktestRunRow>(
    `SELECT ${RUN_SELECT} FROM backtest_run r
      WHERE r.conclusion_status = 'final'
      ORDER BY (r.kind = 'formal' AND r.status = 'active') DESC, r.finalized_at DESC, r.id DESC`,
  );
  return r.rows.map((row) => ({
    ...row,
    is_active_anchor: row.kind === "formal" && row.status === "active",
  }));
}

/** 运行详情：run + artifacts（join dataset，含路径/哈希/角色） */
export async function getBacktestRunWithArtifacts(
  db: Db,
  id: string,
): Promise<(BacktestRunListItem & { artifacts: unknown[]; comparisons: BacktestComparison[] }) | null> {
  const r = await db.query<BacktestRunRow>(
    `SELECT ${RUN_SELECT} FROM backtest_run r WHERE r.id = $1 AND r.conclusion_status = 'final'`,
    [id],
  );
  const run = r.rows[0];
  if (!run) return null;
  const artifacts = await db.query(
    `SELECT a.role, a.id AS artifact_id, d.id AS dataset_id, d.dataset_id AS dataset_key,
            d.source_path, d.source_sha256, d.source_type
       FROM backtest_artifact a
       JOIN data_dataset d ON d.id = a.dataset_id
      WHERE a.backtest_run_id = $1
      ORDER BY a.role, d.source_path`,
    [id],
  );
  const comparisons = await db.query<BacktestComparison>(
    `SELECT prior.id::text, prior.name, prior.kind, prior.execution_status,
            prior.strategy_change_seq::text, prior.strategy_snapshot_hash,
            prior.research_outline, prior.hypothesis, prior.metrics_json,
            prior.conclusion_md, prior.created_at
       FROM backtest_run_comparison c
       JOIN backtest_run prior ON prior.id = c.compared_run_id
      WHERE c.run_id = $1 AND prior.conclusion_status = 'final'
      ORDER BY prior.created_at DESC, prior.id DESC`,
    [id],
  );
  return {
    ...run,
    is_active_anchor: run.kind === "formal" && run.status === "active",
    artifacts: artifacts.rows,
    comparisons: comparisons.rows,
  };
}

export interface FinalizeBacktestInput {
  session_id: string;
  run_id: string;
  conclusion_summary: string;
  applicability_boundary: string;
}

/** 同一研究会话只保留一个当前最终结论；重新确认会保留旧记录并标记已替代。 */
export async function finalizeBacktest(
  db: TransactionDb,
  input: FinalizeBacktestInput,
): Promise<BacktestRunRow> {
  return inServiceTransaction(db, async (client) => {
    const target = await client.query<BacktestRunRow>(
      `SELECT ${RUN_SELECT} FROM backtest_run r
        WHERE r.id = $1 AND r.session_id = $2 FOR UPDATE OF r`,
      [input.run_id, input.session_id],
    );
    const run = target.rows[0];
    if (!run) throw apiErrors.badRequest("只能确认当前 Agent 会话中的回测运行");
    if (!['success','partial'].includes(run.execution_status)) {
      throw apiErrors.badRequest("只有已完成的 success/partial 回测可以晋升为最终结论");
    }
    await client.query(
      `UPDATE backtest_run
          SET conclusion_status = 'superseded', superseded_by_run_id = $2
        WHERE session_id = $1 AND conclusion_status = 'final' AND id <> $2`,
      [input.session_id, input.run_id],
    );
    await client.query(
      `DELETE FROM backtest_run_comparison comparison
        USING backtest_run prior
        WHERE comparison.run_id = $1
          AND prior.id = comparison.compared_run_id
          AND prior.conclusion_status <> 'final'`,
      [input.run_id],
    );
    const updated = await client.query<BacktestRunRow>(
      `UPDATE backtest_run
          SET conclusion_status = 'final', conclusion_summary = $2,
              applicability_boundary = $3, finalized_at = now(), superseded_by_run_id = NULL
        WHERE id = $1
        RETURNING *, COALESCE((SELECT jsonb_agg(c.compared_run_id::text ORDER BY c.compared_run_id)
                                FROM backtest_run_comparison c WHERE c.run_id = backtest_run.id), '[]'::jsonb)
                    AS comparison_run_ids`,
      [input.run_id, input.conclusion_summary.trim(), input.applicability_boundary.trim()],
    );
    return updated.rows[0]!;
  });
}
