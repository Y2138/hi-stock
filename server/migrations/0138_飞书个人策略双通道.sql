-- 飞书推送拆分为个人每日计划与通用策略任务两个独立通道。
ALTER TABLE notification_setting
  ADD COLUMN personal_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN personal_webhook text,
  ADD COLUMN personal_sign_secret text,
  ADD COLUMN strategy_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN strategy_webhook text,
  ADD COLUMN strategy_sign_secret text;

UPDATE notification_setting
   SET personal_enabled = enabled,
       personal_webhook = webhook,
       personal_sign_secret = sign_secret,
       strategy_enabled = enabled,
       strategy_webhook = webhook,
       strategy_sign_secret = sign_secret
 WHERE singleton;

ALTER TABLE notification_setting
  ADD CONSTRAINT notification_setting_personal_credentials_check
    CHECK (NOT personal_enabled OR (personal_webhook IS NOT NULL AND personal_sign_secret IS NOT NULL)),
  ADD CONSTRAINT notification_setting_strategy_credentials_check
    CHECK (NOT strategy_enabled OR (strategy_webhook IS NOT NULL AND strategy_sign_secret IS NOT NULL));

ALTER TABLE notification_delivery
  ADD COLUMN channel text NOT NULL DEFAULT 'personal';

UPDATE notification_delivery
   SET channel = CASE WHEN kind = 'agent_result' THEN 'strategy' ELSE 'personal' END;

ALTER TABLE notification_delivery
  ADD CONSTRAINT notification_delivery_channel_check CHECK (channel IN ('personal', 'strategy'));

COMMENT ON COLUMN notification_setting.personal_webhook IS '个人消息飞书机器人地址；每日计划使用，禁止回显或记录日志';
COMMENT ON COLUMN notification_setting.personal_sign_secret IS '个人消息飞书签名密钥，禁止回显或记录日志';
COMMENT ON COLUMN notification_setting.strategy_webhook IS '策略任务飞书机器人地址；通用策略任务使用，禁止回显或记录日志';
COMMENT ON COLUMN notification_setting.strategy_sign_secret IS '策略任务飞书签名密钥，禁止回显或记录日志';
COMMENT ON COLUMN notification_delivery.channel IS '投递通道：personal 为每日计划，strategy 为通用策略任务';
