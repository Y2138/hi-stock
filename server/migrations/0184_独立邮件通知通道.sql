-- 0184_独立邮件通知通道.sql
-- 与飞书推送完全解耦的邮件通知：独立设置、独立投递队列、独立凭据版本。
-- 只做出站 SMTP；默认发送盘后统一标的精选与每周交易复盘的任务结果。
-- 邮件配置属于本机私有数据，进入完整私有备份，不进入固定资产包。

CREATE TABLE email_notification_setting (
  singleton      boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled        boolean NOT NULL DEFAULT false,
  smtp_host      text CHECK (smtp_host IS NULL OR length(btrim(smtp_host)) BETWEEN 1 AND 253),
  smtp_port      integer CHECK (smtp_port IS NULL OR smtp_port BETWEEN 1 AND 65535),
  smtp_secure    boolean NOT NULL DEFAULT true,
  smtp_user      text CHECK (smtp_user IS NULL OR length(btrim(smtp_user)) BETWEEN 1 AND 320),
  smtp_password  text CHECK (smtp_password IS NULL OR length(smtp_password) BETWEEN 1 AND 1024),
  from_address   text CHECK (from_address IS NULL OR length(btrim(from_address)) BETWEEN 3 AND 320),
  recipients     text[] CHECK (recipients IS NULL OR cardinality(recipients) BETWEEN 1 AND 20),
  job_codes      text[] NOT NULL DEFAULT ARRAY['cross_strategy_selection', 'weekly_trading_review']::text[],
  revision       integer NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR (
    smtp_host IS NOT NULL AND smtp_port IS NOT NULL AND smtp_user IS NOT NULL
    AND smtp_password IS NOT NULL AND from_address IS NOT NULL
    AND recipients IS NOT NULL AND cardinality(recipients) > 0
  ))
);
INSERT INTO email_notification_setting (singleton) VALUES (true);
COMMENT ON TABLE email_notification_setting IS '独立邮件通知设置：SMTP 凭据、收件人白名单与任务订阅；与飞书设置互不影响';
COMMENT ON COLUMN email_notification_setting.singleton IS '唯一设置记录';
COMMENT ON COLUMN email_notification_setting.enabled IS '邮件通知总开关；关闭后不再入队或投递业务邮件';
COMMENT ON COLUMN email_notification_setting.smtp_host IS 'SMTP 服务器主机名或 IP；私有配置，不在接口回显密码';
COMMENT ON COLUMN email_notification_setting.smtp_port IS 'SMTP 端口：465 使用 SSL，587 使用 STARTTLS；禁止明文 25';
COMMENT ON COLUMN email_notification_setting.smtp_secure IS 'true 为 SSL 直连（465），false 为 STARTTLS（587）';
COMMENT ON COLUMN email_notification_setting.smtp_user IS 'SMTP 登录账号';
COMMENT ON COLUMN email_notification_setting.smtp_password IS 'SMTP 专用密码；只供服务端读取，禁止回显、记录日志或写入 Git';
COMMENT ON COLUMN email_notification_setting.from_address IS '发件人邮箱地址';
COMMENT ON COLUMN email_notification_setting.recipients IS '收件人白名单；发送时不接受任意收件人，最多 20 个';
COMMENT ON COLUMN email_notification_setting.job_codes IS '订阅的 agent_flow 任务编码；默认盘后统一精选与每周交易复盘；空数组表示不订阅任何任务';
COMMENT ON COLUMN email_notification_setting.revision IS '邮件配置版本；主机/账号/密码/发件人/收件人变更时递增，取消旧队列';
COMMENT ON COLUMN email_notification_setting.updated_at IS '最后修改时间';

CREATE TABLE email_delivery (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  output_id bigint UNIQUE REFERENCES job_run_output(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'agent_result' CHECK (kind IN ('agent_result', 'test')),
  subject text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 300),
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 200000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  error text,
  channel_revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CHECK ((kind = 'agent_result') = (output_id IS NOT NULL))
);
CREATE INDEX email_delivery_pending ON email_delivery (next_attempt_at, id) WHERE status IN ('pending', 'sending');
CREATE INDEX email_delivery_created ON email_delivery (created_at DESC, id DESC);
COMMENT ON TABLE email_delivery IS '独立邮件投递队列与状态；本机运行数据，不进入固定资产包';
COMMENT ON COLUMN email_delivery.id IS '邮件投递编号';
COMMENT ON COLUMN email_delivery.output_id IS '任务结果编号；一个结果最多一封邮件，重试复用同一行；测试邮件为空';
COMMENT ON COLUMN email_delivery.kind IS '任务结果邮件或连接测试邮件';
COMMENT ON COLUMN email_delivery.subject IS '邮件主题：Stock｜任务名｜目标日';
COMMENT ON COLUMN email_delivery.content IS '待发送正文；任务结果为完整 Markdown 报告，发送时转纯文本与 HTML';
COMMENT ON COLUMN email_delivery.status IS '待发送、发送中、已发送、失败或取消';
COMMENT ON COLUMN email_delivery.attempts IS '当前投递周期的尝试次数，最多 3 次';
COMMENT ON COLUMN email_delivery.next_attempt_at IS '下一次允许尝试的时间';
COMMENT ON COLUMN email_delivery.lease_until IS '发送租约截止时间，支持进程中断恢复';
COMMENT ON COLUMN email_delivery.error IS '脱敏后的失败或取消原因，不包含密码与收件人';
COMMENT ON COLUMN email_delivery.channel_revision IS '入队时的邮件配置版本，配置变更后旧队列取消';
COMMENT ON COLUMN email_delivery.created_at IS '入队时间；超过一天不再投递';
COMMENT ON COLUMN email_delivery.sent_at IS 'SMTP 服务器接受邮件的时间，不代表已读';
