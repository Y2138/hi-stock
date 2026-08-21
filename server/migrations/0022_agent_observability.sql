-- 0022_agent_observability.sql：Agent 运行、工具与固定评测的最小遥测。
-- 只保存计数、时延、状态和大小；不复制提示词、用户正文或工具结果。

CREATE TABLE agent_run_metric (
  id                              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_key                         text NOT NULL UNIQUE,
  session_id                      bigint REFERENCES chat_session(id) ON DELETE SET NULL,
  model_id                        bigint REFERENCES llm_model(id) ON DELETE SET NULL,
  input_tokens                    bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens                   bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens               bigint CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens              bigint CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  reasoning_tokens                bigint CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  cost_amount                     numeric CHECK (cost_amount IS NULL OR cost_amount >= 0),
  estimated_system_tokens         bigint CHECK (estimated_system_tokens IS NULL OR estimated_system_tokens >= 0),
  estimated_history_tokens        bigint CHECK (estimated_history_tokens IS NULL OR estimated_history_tokens >= 0),
  estimated_tool_definition_tokens bigint CHECK (estimated_tool_definition_tokens IS NULL OR estimated_tool_definition_tokens >= 0),
  first_text_ms                   integer CHECK (first_text_ms IS NULL OR first_text_ms >= 0),
  total_ms                        integer CHECK (total_ms IS NULL OR total_ms >= 0),
  compaction_count                integer NOT NULL DEFAULT 0 CHECK (compaction_count >= 0),
  status                          text NOT NULL DEFAULT 'running'
                                  CHECK (status IN ('running','complete','failed','cancelled','blocked')),
  started_at                      timestamptz NOT NULL DEFAULT now(),
  finished_at                     timestamptz,
  created_at                      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_run_metric_session_time
  ON agent_run_metric (session_id, started_at DESC);
CREATE INDEX agent_run_metric_model_time
  ON agent_run_metric (model_id, started_at DESC);

CREATE TABLE agent_tool_metric (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_metric_id  bigint NOT NULL REFERENCES agent_run_metric(id) ON DELETE CASCADE,
  tool_call_id   text NOT NULL,
  tool_name      text NOT NULL,
  sequence_no    integer NOT NULL CHECK (sequence_no > 0),
  duration_ms    integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  status         text NOT NULL CHECK (status IN ('running','ok','error','blocked','cancelled')),
  args_bytes     integer CHECK (args_bytes IS NULL OR args_bytes >= 0),
  result_bytes   integer CHECK (result_bytes IS NULL OR result_bytes >= 0),
  result_rows    integer CHECK (result_rows IS NULL OR result_rows >= 0),
  truncated      boolean NOT NULL DEFAULT false,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  UNIQUE (run_metric_id, tool_call_id)
);
CREATE INDEX agent_tool_metric_run_sequence
  ON agent_tool_metric (run_metric_id, sequence_no);

CREATE TABLE agent_evaluation_run (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evaluation_version text NOT NULL,
  model_id            bigint REFERENCES llm_model(id) ON DELETE SET NULL,
  tool_config         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(tool_config) = 'object'),
  summary             jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(summary) = 'object'),
  conclusion          text NOT NULL CHECK (conclusion IN ('pending','enabled','disabled','failed')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agent_setting
  ADD COLUMN market_domain_tools_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN web_research_enabled boolean NOT NULL DEFAULT false;

