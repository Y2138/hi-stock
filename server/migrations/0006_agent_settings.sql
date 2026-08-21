-- 0006_agent_settings.sql（M2 补强）：agent 全局执行设置。
-- YOLO 默认关闭；开启后 database_change 跳过用户确认，但仍保留校验、事务与审计。

CREATE TABLE agent_setting (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  yolo_mode  boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO agent_setting (singleton) VALUES (true);
