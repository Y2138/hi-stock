-- 0019_agent_backtest_workspace.sql（第四阶段）：Agent 自驱临时代码回测元数据与历史对比关系。
-- source_code、临时路径、stdout/stderr 永不入库；这里只保存可复查摘要、哈希与清理状态。

ALTER TABLE backtest_run
  ADD COLUMN execution_origin text NOT NULL DEFAULT 'legacy'
    CHECK (execution_origin IN ('legacy', 'service', 'agent_workspace')),
  ADD COLUMN agent_session_id bigint REFERENCES chat_session(id) ON DELETE SET NULL,
  ADD COLUMN strategy_change_seq bigint,
  ADD COLUMN strategy_snapshot_hash text
    CHECK (strategy_snapshot_hash IS NULL OR strategy_snapshot_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN research_outline text,
  ADD COLUMN hypothesis text,
  ADD COLUMN worker_version text,
  ADD COLUMN sdk_version text,
  ADD COLUMN source_sha256 text
    CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN source_size_bytes int
    CHECK (source_size_bytes IS NULL OR source_size_bytes BETWEEN 1 AND 65536),
  ADD COLUMN code_cleanup_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (code_cleanup_status IN ('not_applicable', 'deleted', 'cleanup_failed'));

UPDATE backtest_run
   SET execution_origin = CASE
     WHEN service_version = 'backtest-v1' THEN 'service'
     ELSE 'legacy'
   END;

CREATE INDEX backtest_run_agent_session_idx
  ON backtest_run (agent_session_id, created_at DESC)
  WHERE agent_session_id IS NOT NULL;
CREATE INDEX backtest_run_strategy_idx
  ON backtest_run (strategy_change_seq, created_at DESC)
  WHERE strategy_change_seq IS NOT NULL;

CREATE TABLE backtest_run_comparison (
  run_id          bigint NOT NULL REFERENCES backtest_run(id) ON DELETE CASCADE,
  compared_run_id bigint NOT NULL REFERENCES backtest_run(id) ON DELETE RESTRICT,
  relation        text NOT NULL DEFAULT 'prior'
                  CHECK (relation IN ('prior', 'baseline')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, compared_run_id),
  CHECK (run_id <> compared_run_id)
);

CREATE INDEX backtest_run_comparison_reverse_idx
  ON backtest_run_comparison (compared_run_id, run_id);
