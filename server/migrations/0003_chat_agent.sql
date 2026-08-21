-- 0003_chat_agent.sql（M2/M4）：AI 对话六表
-- 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §4.2
-- external_cli_run 仅建表不接逻辑（M4 外部 CLI 桥使用）。

CREATE TABLE chat_session (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title      text NOT NULL DEFAULT '新会话',
  archived   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_message (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  bigint NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
  seq         int NOT NULL,
  role        text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content     jsonb NOT NULL,        -- pi Message 序列化（文本/图片/工具调用块）
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

CREATE TABLE chat_attachment (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  bigint NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
  path        text NOT NULL,         -- uploads/ 相对路径
  mime_type   text NOT NULL,
  size_bytes  int NOT NULL,
  sha256      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 确认制提案
CREATE TABLE confirmation (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  bigint REFERENCES chat_session(id),
  tool_name   text NOT NULL,
  payload     jsonb NOT NULL,        -- 提案全文（变更前后 diff 所需数据）
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  decided_at  timestamptz,
  result      jsonb,                 -- 执行结果摘要
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_tool_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  bigint,
  tool_name   text NOT NULL,
  args        jsonb NOT NULL,
  result_sha256 text,
  status      text NOT NULL,         -- ok/error/blocked/pending
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE external_cli_run (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  bigint,
  agent       text NOT NULL CHECK (agent IN ('codex','claude')),
  prompt      text NOT NULL,
  exit_code   int,
  output_sha256 text,
  timed_out   boolean NOT NULL DEFAULT false,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
