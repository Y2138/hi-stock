ALTER TABLE notification_delivery
  ADD COLUMN intraday_risk_id bigint REFERENCES intraday_position_risk(id) ON DELETE CASCADE;

ALTER TABLE notification_delivery DROP CONSTRAINT notification_delivery_kind_check;
ALTER TABLE notification_delivery DROP CONSTRAINT notification_delivery_output_check;
ALTER TABLE notification_delivery
  ADD CONSTRAINT notification_delivery_kind_check CHECK (kind IN ('daily_plan','agent_result','intraday_risk','test'));
ALTER TABLE notification_delivery
  ADD CONSTRAINT notification_delivery_output_check CHECK (
    (kind IN ('daily_plan','agent_result')) = (output_id IS NOT NULL)
    AND (kind = 'intraday_risk') = (intraday_risk_id IS NOT NULL)
  );

COMMENT ON COLUMN notification_delivery.intraday_risk_id IS '盘中持仓风险提醒来源；不关联 Agent 会话';
