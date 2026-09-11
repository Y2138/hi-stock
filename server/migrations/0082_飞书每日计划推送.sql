CREATE TABLE notification_setting (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  webhook text,
  sign_secret text,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR (webhook IS NOT NULL AND sign_secret IS NOT NULL))
);
INSERT INTO notification_setting (singleton) VALUES (true);
COMMENT ON TABLE notification_setting IS '本机飞书群推送设置；凭据只供服务端读取，不进入固定资产';
COMMENT ON COLUMN notification_setting.singleton IS '唯一设置记录';
COMMENT ON COLUMN notification_setting.enabled IS '每日计划自动推送开关';
COMMENT ON COLUMN notification_setting.webhook IS '飞书群机器人私有地址，禁止回显或记录日志';
COMMENT ON COLUMN notification_setting.sign_secret IS '飞书签名密钥，禁止回显或记录日志';
COMMENT ON COLUMN notification_setting.revision IS '凭据版本，防止旧通知转发至新接收群';
COMMENT ON COLUMN notification_setting.updated_at IS '最后修改时间';

CREATE TABLE notification_delivery (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  output_id bigint REFERENCES job_run_output(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('daily_plan', 'test')),
  channel_revision integer NOT NULL,
  content text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CHECK ((kind = 'daily_plan') = (output_id IS NOT NULL)),
  UNIQUE (output_id)
);
CREATE INDEX notification_delivery_pending ON notification_delivery (next_attempt_at, id) WHERE status IN ('pending', 'sending');
COMMENT ON TABLE notification_delivery IS '飞书通知内容快照与投递状态；本机运行数据';
COMMENT ON COLUMN notification_delivery.id IS '通知编号';
COMMENT ON COLUMN notification_delivery.output_id IS '每日计划结果编号，测试通知为空';
COMMENT ON COLUMN notification_delivery.kind IS '每日计划或无业务内容的连接测试';
COMMENT ON COLUMN notification_delivery.channel_revision IS '创建时的凭据版本';
COMMENT ON COLUMN notification_delivery.content IS '固定的待发送纯文本摘要';
COMMENT ON COLUMN notification_delivery.status IS '待发送、发送中、已发送、失败或取消';
COMMENT ON COLUMN notification_delivery.attempts IS '当前投递周期的尝试次数';
COMMENT ON COLUMN notification_delivery.next_attempt_at IS '下一次允许尝试的时间';
COMMENT ON COLUMN notification_delivery.lease_until IS '发送租约截止时间，支持进程中断恢复';
COMMENT ON COLUMN notification_delivery.error IS '脱敏后的失败或取消原因';
COMMENT ON COLUMN notification_delivery.created_at IS '创建时间；超过一天不再投递';
COMMENT ON COLUMN notification_delivery.sent_at IS '飞书确认接收时间，不代表用户已读';
