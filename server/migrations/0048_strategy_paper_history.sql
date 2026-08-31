-- 0048_strategy_paper_history.sql：允许历史每日计划直接作为策略模拟信号来源。

ALTER TABLE strategy_paper_signal
  ALTER COLUMN source_job_run_id DROP NOT NULL,
  ADD CONSTRAINT strategy_paper_signal_source_check
  CHECK (source_job_run_id IS NOT NULL OR plan_output_id IS NOT NULL);

CREATE UNIQUE INDEX strategy_paper_signal_plan_instrument
  ON strategy_paper_signal (plan_output_id, instrument_id)
  WHERE plan_output_id IS NOT NULL;

COMMENT ON TABLE strategy_paper_signal IS
  '每日计划产生的次日模拟成交指令；历史回溯可直接引用计划结果';
