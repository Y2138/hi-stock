-- 关注来源清除时外键会将历史竞价记录的 attention_entry_id 置空；历史评估必须继续保留。
ALTER TABLE auction_scope_assessment DROP CONSTRAINT auction_scope_assessment_check;
ALTER TABLE auction_scope_assessment ADD CONSTRAINT auction_scope_assessment_check CHECK (
  (scope_kind='position' AND attention_entry_id IS NULL
    AND conclusion IN ('plan_aligned','risk_alert','unavailable'))
  OR
  (scope_kind='attention'
    AND conclusion IN ('confirmed','wait','give_up','unavailable'))
  OR
  (scope_kind IN ('first_board','ladder') AND attention_entry_id IS NULL
    AND strategy_code='first_board_advance'
    AND conclusion IN ('promotion_strong','promotion_normal','divergence_hold','weak_exit','unavailable'))
);
COMMENT ON COLUMN auction_scope_assessment.attention_entry_id IS '关注来源条目编号；来源清除后由外键置空，历史竞价评估继续保留';
COMMENT ON COLUMN notification_setting.personal_enabled IS '是否启用个人通道，关闭后不创建或发送个人通道通知';
COMMENT ON COLUMN notification_setting.strategy_enabled IS '是否启用策略通道，关闭后不创建或发送策略通道通知';
