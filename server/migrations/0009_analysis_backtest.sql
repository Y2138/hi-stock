-- 0009_analysis_backtest.sql（M3.5）：复合分析事实、服务内回测结论与 script Runner 退役。

CREATE TABLE fundamental_snapshot (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id   bigint NOT NULL REFERENCES market_instrument(id),
  as_of_date      date NOT NULL,
  report_period   date,
  revenue         numeric,
  net_profit      numeric,
  operating_cashflow numeric,
  roe             numeric,
  gross_margin    numeric,
  debt_ratio      numeric,
  source          text NOT NULL,
  raw_summary     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(raw_summary) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instrument_id, as_of_date, report_period)
);

CREATE TABLE valuation_snapshot (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id   bigint NOT NULL REFERENCES market_instrument(id),
  as_of_date      date NOT NULL,
  pe_ttm          numeric,
  pb              numeric,
  ps_ttm          numeric,
  dividend_yield  numeric,
  market_cap      numeric,
  source          text NOT NULL,
  raw_summary     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(raw_summary) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instrument_id, as_of_date)
);

CREATE TABLE analysis_run (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  analysis_type   text NOT NULL CHECK (analysis_type IN ('sector_temperature','key_levels','long_valuation')),
  request_json    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(request_json) = 'object'),
  input_summary   jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(input_summary) = 'object'),
  service_version text NOT NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','success','partial','failed')),
  result_json     jsonb,
  data_gaps       jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(data_gaps) = 'array'),
  error_message   text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analysis_run_type_time ON analysis_run (analysis_type, created_at DESC);

ALTER TABLE backtest_run
  ADD COLUMN request_json jsonb,
  ADD COLUMN input_summary jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN service_version text,
  ADD COLUMN metrics_json jsonb,
  ADD COLUMN conclusion_md text,
  ADD COLUMN data_gaps jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN execution_status text NOT NULL DEFAULT 'legacy'
    CHECK (execution_status IN ('legacy','queued','running','success','partial','failed')),
  ADD COLUMN progress int NOT NULL DEFAULT 100 CHECK (progress BETWEEN 0 AND 100),
  ADD COLUMN error_message text;

CREATE INDEX backtest_run_execution_queue
  ON backtest_run (execution_status, id) WHERE execution_status IN ('queued','running');

-- 把过渡 script 作业转换为服务内 analysis；数据库约束不再允许新 script。
UPDATE job_definition
   SET job_type = 'analysis',
       config = jsonb_build_object(
         'analysis_type',
         CASE config->>'command_id'
           WHEN 'sector_temperature' THEN 'sector_temperature'
           WHEN 'key_levels' THEN 'key_levels'
           WHEN 'long_valuation' THEN 'long_valuation'
           ELSE 'sector_temperature'
         END,
         'request', '{}'::jsonb
       ),
       updated_at = now()
 WHERE job_type = 'script';

ALTER TABLE job_definition DROP CONSTRAINT job_definition_job_type_check;
ALTER TABLE job_definition ADD CONSTRAINT job_definition_job_type_check
  CHECK (job_type IN ('datasource','agent_flow','analysis'));
