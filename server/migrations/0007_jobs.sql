-- 0007_jobs.sql（M3）：系统调度作业定义与运行台账。
-- 一期 task_definition/task_run 继续保留；本迁移只新增系统自动化能力。

CREATE TABLE job_definition (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{0,62}$'),
  name        text NOT NULL,
  cron        text NOT NULL,
  job_type    text NOT NULL CHECK (job_type IN ('datasource','script','agent_flow')),
  config      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_run (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id         bigint NOT NULL REFERENCES job_definition(id),
  task_run_id    bigint REFERENCES task_run(id) ON DELETE SET NULL,
  target_date    date NOT NULL,
  trigger_kind   text NOT NULL CHECK (trigger_kind IN ('cron','manual')),
  scheduled_for  timestamptz,
  status         text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','success','failed','partial','missed')),
  attempt_count  int NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
  next_retry_at  timestamptz,
  log            text NOT NULL DEFAULT '',
  artifacts      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(artifacts) = 'array'),
  data_gaps      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(data_gaps) = 'array'),
  result_md      text,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_run_job_date ON job_run (job_id, target_date DESC, id DESC);
CREATE INDEX job_run_queue ON job_run (next_retry_at, id) WHERE status = 'queued';
CREATE UNIQUE INDEX job_run_scheduled_once
  ON job_run (job_id, scheduled_for) WHERE scheduled_for IS NOT NULL;

ALTER TABLE market_fetch_run
  ADD CONSTRAINT market_fetch_run_job_run_fk
  FOREIGN KEY (job_run_id) REFERENCES job_run(id) ON DELETE SET NULL;

-- 初始作业只保存流程引用和调度参数，不复制任何策略阈值。
INSERT INTO job_definition (code, name, cron, job_type, config) VALUES
  ('daily_data_update', '每日行情与数据卷更新', '45 15 * * 1-5', 'datasource',
   '{"pipeline":"daily_market_update","export_volume":true}'),
  ('daily_plan_flow', '每日交易计划预览', '15 17 * * *', 'agent_flow',
   '{"template_path":"定时任务/每日交易计划.md","task_code":"daily_plan"}'),
  ('midweek_check', '周中短线检查预览', '30 17 * * 2', 'agent_flow',
   '{"template_path":"定时任务/周中短线检查.md","task_code":"midweek_check"}'),
  ('weekly_review', '每周评分预览', '0 20 * * 0', 'agent_flow',
   '{"template_path":"定时任务/每周评分.md","task_code":"weekly_review"}');
