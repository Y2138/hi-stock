-- 盘中三个常驻任务：任务中心展示、worker 心跳与汇总提醒。
-- 30 秒/5 秒不是 cron，调度器跳过 worker；任务中心读心跳状态，不写 job_run。
ALTER TABLE job_definition DROP CONSTRAINT job_definition_job_type_check;
ALTER TABLE job_definition ADD CONSTRAINT job_definition_job_type_check
  CHECK (job_type IN ('datasource','agent_flow','analysis','worker'));

CREATE TABLE job_worker_status (
  code          text PRIMARY KEY REFERENCES job_definition(code) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','success','failed')),
  trade_date    date,
  last_tick_at  timestamptz,
  last_summary  text,
  error         text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE job_worker_status IS '盘中常驻 worker 心跳；不写 job_run，只供任务中心展示';
COMMENT ON COLUMN job_worker_status.code IS '对应 job_definition.code';
COMMENT ON COLUMN job_worker_status.status IS '最近一次 tick 状态';
COMMENT ON COLUMN job_worker_status.trade_date IS '最近一次 tick 的交易日';
COMMENT ON COLUMN job_worker_status.last_tick_at IS '最近一次 tick 时间';
COMMENT ON COLUMN job_worker_status.last_summary IS '最近一次 tick 的简短摘要';
COMMENT ON COLUMN job_worker_status.error IS '最近一次失败原因；成功时为空';
COMMENT ON COLUMN job_worker_status.updated_at IS '心跳更新时间';

INSERT INTO job_definition
  (code, name, cron, job_type, config, enabled, purpose, phase, priority, trading_day_only, execution_scope)
VALUES
  ('position_intraday_watch', '普通持仓盘中观察', '* * * * *', 'worker',
   '{"interval_seconds":30}'::jsonb, true,
   '30 秒观察非超短持仓的量价与加减仓条件；汇总成一条消息发送。',
   '盘中', 290, true, 'global'),
  ('ultra_short_exit_watch', '超短持仓盘中离场观察', '* * * * *', 'worker',
   '{"interval_seconds":5}'::jsonb, true,
   '5 秒用确定性规则检查超短已持仓的硬止损、开板/炸板、时间止损与止盈；汇总成一条消息发送。',
   '盘中', 291, true, 'global'),
  ('ultra_short_watch_observe', '超短未持仓盘中观察', '* * * * *', 'worker',
   '{"interval_seconds":30}'::jsonb, true,
   '30 秒把超短未持仓候选的指标交给 LLM 判断观察/接近触发/触发/放弃；汇总成一条消息发送。',
   '盘中', 292, true, 'global');

ALTER TABLE notification_delivery DROP CONSTRAINT notification_delivery_kind_check;
ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_kind_check
  CHECK (kind IN ('daily_plan','agent_result','intraday_risk','test','ultra_short','intraday_digest'));
COMMENT ON COLUMN notification_delivery.kind IS '任务结果、盘中持仓汇总、盘中风险、超短提醒、连接测试';
