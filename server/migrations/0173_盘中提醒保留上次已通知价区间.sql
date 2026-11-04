ALTER TABLE intraday_position_risk ADD COLUMN last_alert_signal jsonb
  CHECK (last_alert_signal IS NULL OR jsonb_typeof(last_alert_signal)='object');
COMMENT ON COLUMN intraday_position_risk.last_alert_signal IS '上次已入队通知的动作和价区间，用于跨采样去重；退出触发后清空';
