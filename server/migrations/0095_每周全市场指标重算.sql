-- 0094_每周全市场指标重算.sql：新增每周全市场指标重算任务。
-- 背景：日更默认覆盖全市场个股，但指标（MA/MACD/RSI/股性）只对信号相关范围
-- （持仓、标的池、核心指数、行业板块、当日结构候选）每日计算，控制计算成本。
-- 其余标的的指标由本任务每周入队一次，交由后台指标工作器分批消化。
-- 任务只写市场指标脏标记，不在任务内同步计算，因此耗时恒定。

INSERT INTO job_definition (code, name, cron, job_type, config) VALUES
  ('weekly_full_market_indicators', '每周全市场指标重算', '30 5 * * 6', 'datasource',
   '{"pipeline":"full_market_indicator_refresh","export_volume":false}')
ON CONFLICT (code) DO NOTHING;
