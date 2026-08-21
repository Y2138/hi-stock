-- 0004_llm_config.sql（M2 优化）：模型厂商、模型目录与当前模型
-- LLM 配置的唯一事实源为 PostgreSQL；API Key 只在服务端使用，任何查询接口均不得回显。

CREATE TABLE llm_provider (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_key  text NOT NULL UNIQUE,
  name          text NOT NULL,
  api_protocol  text NOT NULL CHECK (
    api_protocol IN ('openai-completions', 'openai-responses', 'anthropic-messages')
  ),
  base_url      text NOT NULL,
  api_key       text,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (provider_key ~ '^[a-z0-9][a-z0-9._-]*$'),
  CHECK (length(trim(name)) > 0),
  CHECK (length(trim(base_url)) > 0)
);

CREATE TABLE llm_model (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id       bigint NOT NULL REFERENCES llm_provider(id) ON DELETE CASCADE,
  model_key         text NOT NULL,
  name              text NOT NULL,
  input_modalities  jsonb NOT NULL DEFAULT '["text"]'::jsonb,
  reasoning         boolean NOT NULL DEFAULT false,
  context_window    int NOT NULL DEFAULT 128000 CHECK (context_window > 0),
  max_tokens        int NOT NULL DEFAULT 8192 CHECK (max_tokens > 0),
  enabled           boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, model_key),
  CHECK (length(trim(model_key)) > 0),
  CHECK (length(trim(name)) > 0),
  CHECK (jsonb_typeof(input_modalities) = 'array'),
  CHECK (input_modalities <@ '["text", "image"]'::jsonb),
  CHECK (input_modalities @> '["text"]'::jsonb)
);

CREATE TABLE llm_setting (
  singleton       boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_model_id bigint REFERENCES llm_model(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO llm_setting (singleton) VALUES (true);

-- 仅种下可编辑的本机模板，不写任何凭据。用户可删除、修改或新增厂商与模型。
INSERT INTO llm_provider (provider_key, name, api_protocol, base_url) VALUES
  ('deepseek', 'DeepSeek', 'openai-completions', 'https://api.deepseek.com'),
  ('xiaomi', '小米 MiMo', 'openai-completions', 'https://api.xiaomimimo.com/v1'),
  ('openai', 'OpenAI', 'openai-responses', 'https://api.openai.com/v1'),
  ('anthropic', 'Anthropic', 'anthropic-messages', 'https://api.anthropic.com');

INSERT INTO llm_model (
  provider_id, model_key, name, input_modalities, reasoning, context_window, max_tokens
)
SELECT id, 'deepseek-v4-flash', 'DeepSeek V4 Flash', '["text"]', true, 1000000, 384000
FROM llm_provider WHERE provider_key = 'deepseek';

INSERT INTO llm_model (
  provider_id, model_key, name, input_modalities, reasoning, context_window, max_tokens
)
SELECT id, 'mimo-v2.5', 'MiMo-V2.5', '["text", "image"]', true, 1048576, 131072
FROM llm_provider WHERE provider_key = 'xiaomi';

INSERT INTO llm_model (
  provider_id, model_key, name, input_modalities, reasoning, context_window, max_tokens
)
SELECT id, 'gpt-5.4', 'GPT-5.4', '["text", "image"]', true, 1050000, 128000
FROM llm_provider WHERE provider_key = 'openai';

INSERT INTO llm_model (
  provider_id, model_key, name, input_modalities, reasoning, context_window, max_tokens
)
SELECT id, 'claude-sonnet-4-6', 'Claude Sonnet 4.6', '["text", "image"]', true, 1000000, 128000
FROM llm_provider WHERE provider_key = 'anthropic';

UPDATE llm_setting
SET active_model_id = (
  SELECT m.id
  FROM llm_model m
  JOIN llm_provider p ON p.id = m.provider_id
  WHERE p.provider_key = 'deepseek' AND m.model_key = 'deepseek-v4-flash'
), updated_at = now()
WHERE singleton;

