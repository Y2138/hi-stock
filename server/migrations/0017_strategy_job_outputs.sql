-- 0017_strategy_job_outputs.sql：第三阶段当前策略、简要演进、真人发布提案与任务结果归位。
-- 只迁移当前策略正文；content_* 旧记录保留为冻结审计，不再作为策略/计划生产写入目标。

CREATE TABLE strategy_document (
  id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                       text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{0,95}$'),
  title                      text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  role                       text NOT NULL CHECK (role IN ('portfolio','short','long','guidance')),
  injection_order            int NOT NULL CHECK (injection_order BETWEEN 1 AND 10000),
  current_revision_id        bigint,
  legacy_content_document_id bigint UNIQUE REFERENCES content_document(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE strategy_document_revision (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id       bigint NOT NULL REFERENCES strategy_document(id),
  revision_no       int NOT NULL CHECK (revision_no > 0),
  content           text NOT NULL,
  sha256            text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  source            text NOT NULL CHECK (source IN ('migration','human_publish','restore')),
  proposal_id       bigint,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision_no),
  UNIQUE (id, document_id)
);

ALTER TABLE strategy_document
  ADD CONSTRAINT strategy_document_current_revision_fk
  FOREIGN KEY (current_revision_id, id)
  REFERENCES strategy_document_revision(id, document_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE strategy_evolution_log (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id         bigint REFERENCES chat_session(id) ON DELETE SET NULL,
  outline            text NOT NULL CHECK (length(btrim(outline)) BETWEEN 1 AND 4000),
  conclusion         text NOT NULL CHECK (length(btrim(conclusion)) BETWEEN 1 AND 8000),
  adjustments        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(adjustments) = 'array'),
  adoption_status    text NOT NULL DEFAULT 'pending'
                     CHECK (adoption_status IN ('pending','adopted','rejected')),
  strategy_hash_before text NOT NULL CHECK (strategy_hash_before ~ '^[0-9a-f]{64}$'),
  strategy_hash_after  text CHECK (strategy_hash_after ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz
);

CREATE TABLE strategy_state (
  singleton          smallint PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  change_seq         bigint NOT NULL DEFAULT 0 CHECK (change_seq >= 0),
  current_hash       text NOT NULL CHECK (current_hash ~ '^[0-9a-f]{64}$'),
  last_evolution_id  bigint REFERENCES strategy_evolution_log(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE strategy_publish_proposal (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id         bigint NOT NULL REFERENCES chat_session(id) ON DELETE RESTRICT,
  evolution_id       bigint NOT NULL UNIQUE REFERENCES strategy_evolution_log(id) ON DELETE RESTRICT,
  base_change_seq    bigint NOT NULL CHECK (base_change_seq >= 0),
  base_strategy_hash text NOT NULL CHECK (base_strategy_hash ~ '^[0-9a-f]{64}$'),
  summary            text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 2000),
  proposed_changes   jsonb CHECK (proposed_changes IS NULL OR jsonb_typeof(proposed_changes) = 'array'),
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','expired','conflict')),
  requires_human     boolean NOT NULL DEFAULT true CHECK (requires_human),
  decided_by         text,
  decision_note      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz
);

ALTER TABLE strategy_document_revision
  ADD CONSTRAINT strategy_document_revision_proposal_fk
  FOREIGN KEY (proposal_id) REFERENCES strategy_publish_proposal(id) ON DELETE SET NULL;

CREATE TABLE strategy_evolution_backtest (
  evolution_id       bigint NOT NULL REFERENCES strategy_evolution_log(id) ON DELETE CASCADE,
  backtest_run_id    bigint NOT NULL REFERENCES backtest_run(id) ON DELETE RESTRICT,
  PRIMARY KEY (evolution_id, backtest_run_id)
);

CREATE TABLE job_run_output (
  id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id                     bigint NOT NULL REFERENCES job_definition(id) ON DELETE RESTRICT,
  run_id                     bigint REFERENCES job_run(id) ON DELETE SET NULL,
  session_id                 bigint REFERENCES chat_session(id) ON DELETE SET NULL,
  output_type                text NOT NULL CHECK (output_type ~ '^[a-z][a-z0-9_]{0,62}$'),
  target_date                date NOT NULL,
  markdown                   text NOT NULL,
  sha256                     text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status                     text NOT NULL DEFAULT 'generated'
                             CHECK (status IN ('generated','approved','rejected','superseded')),
  source                     text NOT NULL CHECK (source IN ('agent_flow','historical_import','user_edit')),
  supersedes_output_id       bigint REFERENCES job_run_output(id) ON DELETE SET NULL,
  strategy_change_seq        bigint,
  strategy_snapshot_hash     text CHECK (strategy_snapshot_hash ~ '^[0-9a-f]{64}$'),
  legacy_content_document_id bigint UNIQUE REFERENCES content_document(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX strategy_document_injection ON strategy_document (injection_order, id);
CREATE INDEX strategy_document_revision_time ON strategy_document_revision (document_id, revision_no DESC);
CREATE INDEX strategy_evolution_time ON strategy_evolution_log (created_at DESC, id DESC);
CREATE INDEX strategy_publish_status_time ON strategy_publish_proposal (status, created_at DESC, id DESC);
CREATE UNIQUE INDEX strategy_publish_one_pending_session
  ON strategy_publish_proposal (session_id) WHERE status = 'pending';
CREATE INDEX job_run_output_job_date ON job_run_output (job_id, target_date DESC, id DESC);
CREATE INDEX job_run_output_run ON job_run_output (run_id, id DESC) WHERE run_id IS NOT NULL;

ALTER TABLE job_run
  ADD COLUMN strategy_change_seq bigint,
  ADD COLUMN strategy_snapshot_hash text CHECK (strategy_snapshot_hash ~ '^[0-9a-f]{64}$');

-- 当前策略与核心指引迁入专用领域；只取 content_* 当前指针，不构造历史策略演进。
INSERT INTO strategy_document
  (code, title, role, injection_order, legacy_content_document_id, created_at, updated_at)
SELECT d.code,
       CASE d.legacy_path
         WHEN '短线/策略.md' THEN '短线策略'
         WHEN '长线/策略.md' THEN '长线策略'
         ELSE d.title
       END,
       CASE d.legacy_path
         WHEN '投资总策略.md' THEN 'portfolio'
         WHEN '短线/策略.md' THEN 'short'
         WHEN '长线/策略.md' THEN 'long'
         ELSE 'guidance'
       END,
       CASE d.legacy_path
         WHEN '投资总策略.md' THEN 10
         WHEN '短线/策略.md' THEN 20
         WHEN '长线/策略.md' THEN 30
         WHEN '关键位分析指引.md' THEN 100
         WHEN '股性分析.md' THEN 110
         WHEN '临时决策接入评估.md' THEN 120
         WHEN '数据获取规范.md' THEN 130
         WHEN '预期校对.md' THEN 140
         ELSE 500 + d.id::int
       END,
       d.id, d.created_at, d.updated_at
  FROM content_document d
 WHERE d.content_type IN ('strategy','guidance')
   AND d.status = 'published'
   AND d.current_revision_id IS NOT NULL
ON CONFLICT (code) DO NOTHING;

INSERT INTO strategy_document_revision
  (document_id, revision_no, content, sha256, source, created_at)
SELECT sd.id, 1, cr.content, cr.sha256, 'migration', cr.created_at
  FROM strategy_document sd
  JOIN content_document cd ON cd.id = sd.legacy_content_document_id
  JOIN content_revision cr ON cr.id = cd.current_revision_id
 WHERE NOT EXISTS (
   SELECT 1 FROM strategy_document_revision existing WHERE existing.document_id = sd.id
 );

UPDATE strategy_document sd
   SET current_revision_id = r.id,
       updated_at = greatest(sd.updated_at, r.created_at)
  FROM strategy_document_revision r
 WHERE r.document_id = sd.id AND r.revision_no = 1 AND sd.current_revision_id IS NULL;

INSERT INTO strategy_state (singleton, change_seq, current_hash)
SELECT 1, 0,
       encode(sha256(convert_to(string_agg(sd.code || ':' || r.sha256, E'\n' ORDER BY sd.injection_order, sd.id), 'UTF8')), 'hex')
  FROM strategy_document sd
  JOIN strategy_document_revision r ON r.id = sd.current_revision_id
HAVING count(*) > 0
ON CONFLICT (singleton) DO NOTHING;

-- 已有真实 Agent Flow 结果归具体运行；job_run.result_md 仅保留兼容读取。
INSERT INTO job_run_output
  (job_id, run_id, session_id, output_type, target_date, markdown, sha256, status, source,
   strategy_change_seq, strategy_snapshot_hash, created_at)
SELECT r.job_id, r.id, r.agent_session_id,
       CASE d.code WHEN 'daily_plan_flow' THEN 'daily_plan' ELSE d.code END,
       r.target_date, r.result_md,
       encode(sha256(convert_to(r.result_md, 'UTF8')), 'hex'),
       'generated', 'agent_flow', r.strategy_change_seq, r.strategy_snapshot_hash,
       COALESCE(r.finished_at, r.created_at)
  FROM job_run r
  JOIN job_definition d ON d.id = r.job_id
 WHERE r.result_md IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM job_run_output o WHERE o.run_id = r.id);

-- 历史与当前交易计划归每日计划作业，但不伪造不存在的 job_run。
INSERT INTO job_run_output
  (job_id, output_type, target_date, markdown, sha256, status, source,
   legacy_content_document_id, created_at)
SELECT jd.id, 'daily_plan',
       substring(cd.title FROM '([0-9]{4}-[0-9]{2}-[0-9]{2})')::date,
       cr.content, cr.sha256, 'approved', 'historical_import', cd.id, cr.created_at
  FROM content_document cd
  JOIN content_revision cr ON cr.id = cd.current_revision_id
  JOIN job_definition jd ON jd.code = 'daily_plan_flow'
 WHERE cd.content_type IN ('trading_plan','archive')
   AND cd.title ~ '^明日交易计划_[0-9]{4}-[0-9]{2}-[0-9]{2}$'
ON CONFLICT (legacy_content_document_id) DO NOTHING;

-- Agent Flow 改读当前策略专用域与任务结果域；旧 0012 提示词保留为不可变历史。
WITH definitions(code, content) AS (
  VALUES
  ('daily_plan_flow', $daily17$
# 每日交易计划

目标：依据本轮系统提示词已注入的当前最终策略与目标日数据库事实，生成下一交易日计划。只读、不执行交易、不修改策略或业务表。

1. 规则与核心指引直接使用系统提示词的 `strategy_state` 同一快照，不查询冻结的 `content_*`；当前持仓与账户读 `portfolio_*`，标的池读 `pool_membership`，行情读 `market_bar`，数据完整性读 `job_run` / `market_fetch_run`，已有分析读 `analysis_run`。
2. 需要上一份计划或历史任务结果时，按 `job_definition.code='daily_plan_flow'` 关联 `job_run_output` 查询；不得去内容库查找交易计划。
3. 先按需 `database_schema.describe_tables`，再用带 `schema_hash` 的 `database_query` 批量查询。核对目标日数据作业终态、数据缺口和行情截止日；缺失时明确影响，不猜测。
4. 覆盖真实持仓与当前有效标的池，区分市场情景、可执行条件、预判候选、失效条件、资金组合和风险；研究评分不得替代量化条件。

输出完整 Markdown，注明策略序号、数据截止日和数据库证据。结果由系统自动关联本次任务并保存到 `job_run_output`。
$daily17$),
  ('midweek_check', $midweek17$
# 周中短线检查

目标：依据本轮系统提示词已注入的当前最终策略，只读检查短线池评分、阶段、右侧/左侧条件和市场变化。

1. 使用当前策略快照中的投资总策略、短线策略和数据获取规范；不得查询冻结的 `content_*` 或外部文件。
2. 当前短线池读 `pool_membership(pool='short', effective_to IS NULL)`，标的读 `market_instrument`，持仓读 `portfolio_position`，行情读 `market_bar`，数据缺口读 `job_run` / `market_fetch_run`，已有分析读 `analysis_run`。
3. 先按需发现 Schema，再批量查询；覆盖全部短线池标的，分别报告研究评分、阶段、右侧完整条件、左侧候选、市场/板块变化和数据缺口。不得直接更新标的池或持仓。

输出完整 Markdown，注明策略序号与数据截止日；系统会把结果关联本次任务保存到 `job_run_output`。
$midweek17$),
  ('weekly_review', $weekly17$
# 每周评分

目标：依据本轮系统提示词已注入的当前最终策略，只读重评短线/长线池的研究评分、角色状态和量化资格。

1. 使用当前策略快照中的投资总策略、短线策略、长线策略、股性分析和数据获取规范；不得查询冻结的 `content_*` 或外部文件。
2. 当前池角色读 `pool_membership(effective_to IS NULL)`，标的读 `market_instrument`，真实持仓读 `portfolio_position`，行情读 `market_bar`，基本面/估值读 `fundamental_snapshot` / `valuation_snapshot`，已有分析读 `analysis_run`。
3. 先按需发现 Schema，再批量查询。覆盖全部短线/长线池标的，分开报告当前值、建议评分/阶段/角色、证据和缺口；研究评分不得替代量化资格，角色变化只作为待确认建议。

输出完整 Markdown，注明策略序号与数据截止日；系统会把结果关联本次任务保存到 `job_run_output`。
$weekly17$)
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT p.id,
         (SELECT COALESCE(MAX(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = p.id),
         definitions.content,
         encode(sha256(convert_to(definitions.content, 'UTF8')), 'hex'),
         'user', p.current_revision_id,
         '切换为当前策略快照与任务结果域，不再读取旧内容库'
    FROM definitions
    JOIN job_prompt p ON p.code = definitions.code
    LEFT JOIN job_prompt_revision current ON current.id = p.current_revision_id
   WHERE current.content IS DISTINCT FROM definitions.content
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
