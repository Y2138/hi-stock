-- 0190_模型降级事件记录.sql
-- 模型降级兜底（specs/模型降级与首token兜底/状态.md）：在运行指标上记录降级事件，供周报统计。
-- 只新增列，不改动历史指标行；fallback_reason 取第二节的三个触发类别。
ALTER TABLE agent_run_metric ADD COLUMN fallback_from_model_key text;
ALTER TABLE agent_run_metric ADD COLUMN fallback_target_model_key text;
ALTER TABLE agent_run_metric ADD COLUMN fallback_reason text;
ALTER TABLE agent_run_metric ADD COLUMN fallback_at timestamptz;
ALTER TABLE agent_run_metric ADD CONSTRAINT agent_run_metric_fallback_reason_check
  CHECK (fallback_reason IS NULL OR fallback_reason IN ('zero_token', 'stream_interrupted', 'watchdog'));
COMMENT ON COLUMN agent_run_metric.fallback_from_model_key IS '降级前的主模型键；未降级为空';
COMMENT ON COLUMN agent_run_metric.fallback_target_model_key IS '实际切换到目标模型键；未降级为空';
COMMENT ON COLUMN agent_run_metric.fallback_reason IS '降级触发类别：zero_token、stream_interrupted、watchdog';
COMMENT ON COLUMN agent_run_metric.fallback_at IS '发生降级的时间；未降级为空';

-- 本周复盘与任务统计按降级事件查询，不扫描日志。
CREATE INDEX agent_run_metric_fallback_idx ON agent_run_metric(fallback_at) WHERE fallback_at IS NOT NULL;
