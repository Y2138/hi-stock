-- 0030_attribution_backtest_memory.sql：成交级归因、回测最终结论与可复用 Agent 记忆。

ALTER TABLE portfolio_position_change
  ADD COLUMN decision_origin text NOT NULL DEFAULT 'unknown'
    CHECK (decision_origin IN ('strategy_signal','planned_discretionary','unplanned_exception','fact_correction','unknown')),
  ADD COLUMN execution_compliance text NOT NULL DEFAULT 'unknown'
    CHECK (execution_compliance IN ('matched','deviated','not_applicable','unknown')),
  ADD COLUMN strategy_change_seq bigint,
  ADD COLUMN strategy_snapshot_hash text
    CHECK (strategy_snapshot_hash IS NULL OR strategy_snapshot_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN plan_output_id bigint REFERENCES job_run_output(id) ON DELETE SET NULL,
  ADD COLUMN source_session_id bigint REFERENCES chat_session(id) ON DELETE SET NULL,
  ADD COLUMN attribution_note text CHECK (attribution_note IS NULL OR length(attribution_note) <= 2000),
  ADD COLUMN deviation_reason text CHECK (deviation_reason IS NULL OR length(deviation_reason) <= 2000),
  ADD CONSTRAINT portfolio_position_change_deviation_reason
    CHECK (
      (decision_origin <> 'unplanned_exception' AND execution_compliance <> 'deviated')
      OR NULLIF(btrim(deviation_reason), '') IS NOT NULL
    );

CREATE INDEX portfolio_position_change_strategy_idx
  ON portfolio_position_change (strategy_change_seq, change_date DESC)
  WHERE strategy_change_seq IS NOT NULL;
CREATE INDEX portfolio_position_change_plan_idx
  ON portfolio_position_change (plan_output_id)
  WHERE plan_output_id IS NOT NULL;

ALTER TABLE backtest_run
  ADD COLUMN conclusion_status text NOT NULL DEFAULT 'working'
    CHECK (conclusion_status IN ('working','final','superseded')),
  ADD COLUMN conclusion_summary text CHECK (conclusion_summary IS NULL OR length(conclusion_summary) <= 4000),
  ADD COLUMN applicability_boundary text CHECK (applicability_boundary IS NULL OR length(applicability_boundary) <= 4000),
  ADD COLUMN finalized_at timestamptz,
  ADD COLUMN superseded_by_run_id bigint REFERENCES backtest_run(id) ON DELETE SET NULL;

-- 无会话的历史记录没有“同一研究过程”可合并；已完成记录按历史最终结论保留。
UPDATE backtest_run
   SET conclusion_status = 'final',
       conclusion_summary = COALESCE(NULLIF(conclusion_md, ''), NULLIF(notes, ''), name),
       applicability_boundary = '历史记录未单独标注适用边界',
       finalized_at = COALESCE(finished_at, created_at)
 WHERE session_id IS NULL
   AND execution_status IN ('legacy','success','partial');

-- 有会话的既有成功记录每个会话只晋升最新一次，其余作为中间工作运行保留。
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY session_id ORDER BY COALESCE(finished_at, created_at) DESC, id DESC) AS row_no
    FROM backtest_run
   WHERE session_id IS NOT NULL AND execution_status IN ('success','partial')
)
UPDATE backtest_run run
   SET conclusion_status = 'final',
       conclusion_summary = COALESCE(NULLIF(run.conclusion_md, ''), NULLIF(run.notes, ''), run.name),
       applicability_boundary = '迁移前记录，适用边界待复核',
       finalized_at = COALESCE(run.finished_at, run.created_at)
  FROM ranked
 WHERE run.id = ranked.id AND ranked.row_no = 1;

CREATE UNIQUE INDEX backtest_run_one_current_final_per_session
  ON backtest_run (session_id)
  WHERE session_id IS NOT NULL AND conclusion_status = 'final';
CREATE INDEX backtest_run_final_history_idx
  ON backtest_run (finalized_at DESC, id DESC)
  WHERE conclusion_status = 'final';

CREATE TABLE agent_memory_artifact (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title               text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  category            text NOT NULL CHECK (category IN (
                        'research_method','evaluation_template','data_source_knowledge',
                        'task_playbook','incident_resolution','user_preference'
                      )),
  summary              text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 1000),
  content              text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 16000),
  tags                 jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tags) = 'array'),
  scope                text NOT NULL CHECK (length(btrim(scope)) BETWEEN 1 AND 500),
  source_session_id    bigint NOT NULL REFERENCES chat_session(id) ON DELETE RESTRICT,
  source_run_type      text CHECK (source_run_type IS NULL OR source_run_type IN ('job','backtest','analysis','tool')),
  source_run_id        bigint,
  evidence             text NOT NULL CHECK (length(btrim(evidence)) BETWEEN 1 AND 4000),
  status               text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','review_required','superseded','deprecated')),
  supersedes_id        bigint REFERENCES agent_memory_artifact(id) ON DELETE RESTRICT,
  last_verified_at     timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);

CREATE UNIQUE INDEX agent_memory_active_topic
  ON agent_memory_artifact (lower(title), scope)
  WHERE status IN ('active','review_required');
CREATE INDEX agent_memory_query_idx
  ON agent_memory_artifact (status, category, last_verified_at DESC, id DESC);
CREATE INDEX agent_memory_tags_idx ON agent_memory_artifact USING gin (tags);
