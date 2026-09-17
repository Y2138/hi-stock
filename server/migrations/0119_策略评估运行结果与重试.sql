-- 0119_策略评估运行结果与重试.sql：评估运行保存完整结构化结果并支持同输入失败重试。

ALTER TABLE strategy_evaluation_run
  ADD COLUMN result jsonb,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  ADD COLUMN last_requested_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT strategy_evaluation_run_result_check CHECK (
    result IS NULL OR jsonb_typeof(result) IN ('object','array')
  );

COMMENT ON COLUMN strategy_evaluation_run.result IS '可供专项任务、每日计划和交互查询复用的完整结构化评估结果';
COMMENT ON COLUMN strategy_evaluation_run.attempt_count IS '同一输入指纹下的执行尝试次数；成功运行直接复用不递增';
COMMENT ON COLUMN strategy_evaluation_run.last_requested_at IS '该运行最近一次被请求、复用或重试的时间';
