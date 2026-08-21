-- 0016_agent_session.sql（当前策略与 Agent 工作台第一阶段）：统一 Agent session 留痕。
-- 只扩展运行过程，不迁移策略、任务结果或回测事实。

ALTER TABLE chat_session
  ADD COLUMN session_type text NOT NULL DEFAULT 'interactive'
    CHECK (session_type IN ('interactive', 'job', 'backtest', 'strategy_evolution')),
  ADD COLUMN session_status text NOT NULL DEFAULT 'idle'
    CHECK (session_status IN (
      'idle', 'queued', 'running', 'waiting_confirmation',
      'success', 'partial', 'failed', 'cancelled'
    )),
  ADD COLUMN source text NOT NULL DEFAULT 'user'
    CHECK (source IN ('user', 'cron', 'manual_job', 'agent')),
  ADD COLUMN parent_session_id bigint REFERENCES chat_session(id) ON DELETE SET NULL,
  ADD COLUMN strategy_state_revision bigint,
  ADD COLUMN strategy_state_sha256 text
    CHECK (strategy_state_sha256 IS NULL OR strategy_state_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN started_at timestamptz,
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN last_error_summary text,
  ADD CONSTRAINT chat_session_parent_not_self
    CHECK (parent_session_id IS NULL OR parent_session_id <> id),
  ADD CONSTRAINT chat_session_time_order
    CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at);

CREATE INDEX chat_session_type_updated_idx
  ON chat_session(session_type, archived, updated_at DESC);
CREATE INDEX chat_session_parent_idx
  ON chat_session(parent_session_id) WHERE parent_session_id IS NOT NULL;

ALTER TABLE chat_message
  ADD COLUMN attempt_no int NOT NULL DEFAULT 0 CHECK (attempt_no >= 0);

CREATE INDEX chat_message_session_attempt_idx
  ON chat_message(session_id, attempt_no, seq);

ALTER TABLE job_run
  ADD COLUMN agent_session_id bigint REFERENCES chat_session(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX job_run_agent_session_unique
  ON job_run(agent_session_id) WHERE agent_session_id IS NOT NULL;

CREATE TABLE agent_session_attempt (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id    bigint NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
  attempt_no    int NOT NULL CHECK (attempt_no > 0),
  status        text NOT NULL CHECK (status IN (
                  'queued', 'running', 'success', 'partial', 'failed', 'cancelled'
                )),
  started_at    timestamptz,
  finished_at   timestamptz,
  error_summary text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, attempt_no),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE agent_session_event (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  bigint NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
  attempt_no  int NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  event_type  text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]{0,62}$'),
  data        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_session_event_replay_idx
  ON agent_session_event(session_id, id);

CREATE TABLE agent_session_resource (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id     bigint NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
  resource_type  text NOT NULL CHECK (resource_type ~ '^[a-z][a-z0-9_]{0,62}$'),
  resource_id    text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 200),
  relation       text NOT NULL CHECK (relation IN ('produced', 'referenced')),
  metadata       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_session_resource_session_idx
  ON agent_session_resource(session_id, id);
CREATE INDEX agent_session_resource_lookup_idx
  ON agent_session_resource(resource_type, resource_id);
