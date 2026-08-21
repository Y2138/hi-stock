-- 0008_content_jobs.sql（M3.5）：数据库内容事实源与作业提示词版本。
-- 只向前新增；旧 strategy_* 与 job config.template_path 在切换对账前保留。

CREATE TABLE content_document (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{0,95}$'),
  title               text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  content_type        text NOT NULL CHECK (content_type IN ('strategy','guidance','trading_plan','archive')),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  legacy_path         text UNIQUE,
  current_revision_id bigint,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content_revision (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id       bigint NOT NULL REFERENCES content_document(id),
  revision_no       int NOT NULL CHECK (revision_no > 0),
  content           text NOT NULL,
  sha256            text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  source            text NOT NULL CHECK (source IN ('legacy_import','user','agent','rollback')),
  base_revision_id  bigint REFERENCES content_revision(id),
  change_summary    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision_no),
  UNIQUE (id, document_id)
);

ALTER TABLE content_document
  ADD CONSTRAINT content_document_current_revision_fk
  FOREIGN KEY (current_revision_id, id)
  REFERENCES content_revision(id, document_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX content_document_type_status ON content_document (content_type, status, updated_at DESC);
CREATE INDEX content_revision_document_time ON content_revision (document_id, revision_no DESC);

CREATE TABLE content_legacy_import (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_kind   text NOT NULL CHECK (source_kind IN ('content','job_prompt','strategy_version')),
  source_path   text NOT NULL,
  source_mtime  timestamptz,
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  target_table  text NOT NULL CHECK (target_table IN ('content_revision','job_prompt_revision')),
  target_id     bigint NOT NULL,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_path, sha256)
);

CREATE TABLE job_prompt (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{0,62}$'),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  legacy_path         text UNIQUE,
  current_revision_id bigint,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_prompt_revision (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prompt_id         bigint NOT NULL REFERENCES job_prompt(id),
  revision_no       int NOT NULL CHECK (revision_no > 0),
  content           text NOT NULL,
  sha256            text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  source            text NOT NULL CHECK (source IN ('legacy_import','user','agent','rollback')),
  base_revision_id  bigint REFERENCES job_prompt_revision(id),
  change_summary    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, revision_no),
  UNIQUE (id, prompt_id)
);

ALTER TABLE job_prompt
  ADD CONSTRAINT job_prompt_current_revision_fk
  FOREIGN KEY (current_revision_id, id)
  REFERENCES job_prompt_revision(id, prompt_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE job_definition
  ADD COLUMN prompt_id bigint REFERENCES job_prompt(id);

ALTER TABLE job_run
  ADD COLUMN prompt_revision_id bigint REFERENCES job_prompt_revision(id) ON DELETE SET NULL;

CREATE INDEX job_prompt_revision_prompt_time ON job_prompt_revision (prompt_id, revision_no DESC);
CREATE INDEX job_run_prompt_revision ON job_run (prompt_revision_id) WHERE prompt_revision_id IS NOT NULL;

-- 先迁移已经入库的策略版本；原表继续保留到事实源切换完成。
INSERT INTO content_document (code, title, content_type, status, legacy_path, created_at, updated_at)
SELECT 'legacy_' || substr(md5(d.path), 1, 24), d.name, 'strategy', 'published', d.path,
       d.created_at, d.created_at
  FROM strategy_doc d
ON CONFLICT (legacy_path) DO NOTHING;

INSERT INTO content_revision
  (document_id, revision_no, content, sha256, source, change_summary, created_at)
SELECT cd.id, sv.version_no, sv.content, sv.sha256, 'legacy_import', sv.change_summary, sv.synced_at
  FROM strategy_version sv
  JOIN strategy_doc sd ON sd.id = sv.doc_id
  JOIN content_document cd ON cd.legacy_path = sd.path
 WHERE NOT EXISTS (
   SELECT 1 FROM content_revision existing
    WHERE existing.document_id = cd.id AND existing.revision_no = sv.version_no
 );

UPDATE content_document cd
   SET current_revision_id = (
         SELECT cr.id FROM content_revision cr
          WHERE cr.document_id = cd.id ORDER BY cr.revision_no DESC LIMIT 1
       ),
       updated_at = greatest(cd.updated_at, (
         SELECT cr.created_at FROM content_revision cr
          WHERE cr.document_id = cd.id ORDER BY cr.revision_no DESC LIMIT 1
       ))
 WHERE cd.current_revision_id IS NULL
   AND EXISTS (SELECT 1 FROM content_revision cr WHERE cr.document_id = cd.id);

INSERT INTO content_legacy_import (source_kind, source_path, sha256, target_table, target_id, imported_at)
SELECT 'strategy_version', sd.path, cr.sha256, 'content_revision', cr.id, cr.created_at
  FROM content_revision cr
  JOIN content_document cd ON cd.id = cr.document_id
  JOIN strategy_doc sd ON sd.path = cd.legacy_path
ON CONFLICT DO NOTHING;

-- 三个稳定提示词身份先建行；正文由一次性导入器只读导入。
INSERT INTO job_prompt (code, name, legacy_path) VALUES
  ('daily_plan_flow', '每日交易计划提示词', '定时任务/每日交易计划.md'),
  ('midweek_check', '周中短线检查提示词', '定时任务/周中短线检查.md'),
  ('weekly_review', '每周评分提示词', '定时任务/每周评分.md')
ON CONFLICT (code) DO NOTHING;

UPDATE job_definition jd
   SET prompt_id = jp.id
  FROM job_prompt jp
 WHERE jd.job_type = 'agent_flow'
   AND jp.code = jd.code
   AND jd.prompt_id IS NULL;
