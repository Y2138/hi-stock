-- Stock 策略演进系统一期 Schema v1
-- 设计契约：docs/design/Stock_策略演进系统_技术设计_v1.0.md §四
-- 只向前迁移，不提供 down；纠错通过新迁移完成。

CREATE TABLE schema_migrations (
  version     integer PRIMARY KEY,
  name        text NOT NULL,
  sha256      text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task_definition (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code             text NOT NULL UNIQUE,
  name             text NOT NULL,
  template_path    text NOT NULL,
  template_sha256  text NOT NULL,
  cron             text,
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task_run (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_definition_id  bigint NOT NULL REFERENCES task_definition(id),
  target_date         date NOT NULL,
  trigger_kind        text NOT NULL CHECK (trigger_kind IN ('cron','manual')),
  status              text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','success','failed','partial')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  steps               jsonb NOT NULL DEFAULT '[]',
  produced_artifacts  jsonb NOT NULL DEFAULT '[]',
  data_gaps           jsonb NOT NULL DEFAULT '[]',
  summary             text,
  UNIQUE (task_definition_id, target_date)
);
CREATE INDEX task_run_def_date_idx ON task_run (task_definition_id, target_date DESC);

CREATE TABLE dataset (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dataset_id      text NOT NULL,
  source_path     text NOT NULL,
  source_sha256   text NOT NULL,
  source_type     text NOT NULL CHECK (source_type IN
                    ('market_csv','market_30m_csv','futures_csv',
                     'backtest_output','report_md','task_template_md')),
  coverage_start  date,
  coverage_end    date,
  row_count       integer,
  registered_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_path, source_sha256)
);
CREATE INDEX dataset_type_idx ON dataset (source_type);

CREATE TABLE backtest_run (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name              text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('formal','research')),
  engine_path       text,
  engine_git_commit text,
  config_snapshot   jsonb,
  input_manifest    jsonb NOT NULL DEFAULT '[]',
  output_dir        text,
  report_path       text,
  status            text NOT NULL DEFAULT 'archived'
                    CHECK (status IN ('active','superseded','archived')),
  started_at        timestamptz,
  finished_at       timestamptz,
  metrics           jsonb,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- 正式锚点全局唯一
CREATE UNIQUE INDEX backtest_run_single_active_formal
  ON backtest_run (kind) WHERE kind = 'formal' AND status = 'active';

CREATE TABLE backtest_artifact (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  backtest_run_id bigint NOT NULL REFERENCES backtest_run(id) ON DELETE CASCADE,
  dataset_id      bigint NOT NULL REFERENCES dataset(id),
  role            text NOT NULL CHECK (role IN ('input','output','report')),
  UNIQUE (backtest_run_id, dataset_id, role)
);
