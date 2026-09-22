-- 两个飞书通道独立维护凭据版本，修改一个通道不取消另一个通道的待发消息。
ALTER TABLE notification_setting
  ADD COLUMN personal_revision integer NOT NULL DEFAULT 1,
  ADD COLUMN strategy_revision integer NOT NULL DEFAULT 1;

UPDATE notification_setting
   SET personal_revision = revision,
       strategy_revision = revision
 WHERE singleton;

COMMENT ON COLUMN notification_setting.personal_revision IS '个人消息凭据版本';
COMMENT ON COLUMN notification_setting.strategy_revision IS '策略任务消息凭据版本';
