-- 0040_system_settings.sql：本机系统设置统一落 PostgreSQL，凭据不再从运行环境读取。

CREATE TABLE system_setting (
  singleton       boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  hithink_api_key text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (hithink_api_key IS NULL OR length(btrim(hithink_api_key)) > 0)
);

INSERT INTO system_setting (singleton) VALUES (true);

COMMENT ON COLUMN system_setting.hithink_api_key IS
  '扶摇 hithink-finance API Key；仅服务端读取，HTTP API 永不回显正文';
