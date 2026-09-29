-- 0154_定时任务仅交易日执行.sql
-- 背景：法定节假日落在工作日时（如 2026-09-25 中秋），cron 限制星期几无法排除，
-- 任务照常触发并以休市日为目标日执行，覆盖了上一开市日的信号。
-- 方案：job_definition 增加 trading_day_only 门禁位（默认 true），调度器只在工作日历
-- 标记为开市日的目标日入队 cron/missed 运行；周维护类任务显式关闭。
-- 交易日历由 market_catalog_sync 同步深交所月度日历补全休市日与未来月份。

ALTER TABLE job_definition ADD COLUMN trading_day_only boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN job_definition.trading_day_only IS '仅交易日执行：目标日非交易所日历开市日时 cron/missed 触发不入队；周维护类任务设为 false';

-- 周维护任务固定排在周六，属于刻意安排的周末执行，豁免交易日门禁。
UPDATE job_definition SET trading_day_only = false
 WHERE code IN ('value_candidate_sync', 'weekly_full_market_indicators');
