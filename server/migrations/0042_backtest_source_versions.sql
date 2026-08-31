-- 0042_backtest_source_versions.sql：保存已完成回测的候选源码，并在最终化后固化为可复用版本。

ALTER TABLE backtest_run
  ADD COLUMN base_source_run_id bigint REFERENCES backtest_run(id) ON DELETE SET NULL;

CREATE INDEX backtest_run_base_source_idx
  ON backtest_run (base_source_run_id)
  WHERE base_source_run_id IS NOT NULL;

CREATE TABLE backtest_run_source (
  backtest_run_id bigint PRIMARY KEY REFERENCES backtest_run(id) ON DELETE CASCADE,
  source_code text NOT NULL CHECK (octet_length(source_code) BETWEEN 1 AND 65536),
  retention_status text NOT NULL DEFAULT 'candidate'
    CHECK (retention_status IN ('candidate','versioned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  versioned_at timestamptz,
  CHECK (
    (retention_status = 'candidate' AND versioned_at IS NULL)
    OR (retention_status = 'versioned' AND versioned_at IS NOT NULL)
  )
);

CREATE INDEX backtest_run_source_versioned_idx
  ON backtest_run_source (versioned_at DESC, backtest_run_id DESC)
  WHERE retention_status = 'versioned';
