-- 0027_market_structure.sql：涨跌停、炸板、连板天梯和龙虎榜的规范化存储。

CREATE TABLE market_special_sync_run (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_run_id         bigint REFERENCES job_run(id) ON DELETE SET NULL,
  dataset            text NOT NULL CHECK (dataset IN ('limit_up','limit_down','limit_break','limit_ladder','dragon_tiger_all','dragon_tiger_org','dragon_tiger_hot_money')),
  target_date        date NOT NULL,
  status             text NOT NULL CHECK (status IN ('running','success','partial','failed')),
  completed_pages    integer NOT NULL DEFAULT 0 CHECK (completed_pages >= 0),
  total_pages        integer CHECK (total_pages IS NULL OR total_pages >= 0),
  row_count          integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  gaps               jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(gaps) = 'array'),
  source_time        timestamptz,
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX market_special_sync_run_job_dataset
  ON market_special_sync_run (job_run_id, dataset)
  WHERE job_run_id IS NOT NULL;
CREATE INDEX market_special_sync_run_date
  ON market_special_sync_run (target_date DESC, dataset, id DESC);

CREATE TABLE market_limit_event (
  trade_date       date NOT NULL,
  event_type       text NOT NULL CHECK (event_type IN ('up','down','break')),
  instrument_id    bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  event_price      double precision,
  streak_count     integer,
  open_count       integer,
  first_event_time timestamptz,
  last_event_time  timestamptz,
  industry_name    text,
  reason           text,
  source_payload   jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(source_payload) = 'object'),
  source_row_sha256 text NOT NULL,
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trade_date, event_type, instrument_id),
  CHECK (octet_length(source_payload::text) <= 32768)
);
CREATE INDEX market_limit_event_query ON market_limit_event (trade_date DESC, event_type, streak_count DESC);

CREATE TABLE market_limit_ladder_snapshot (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_date    date NOT NULL,
  coverage_start date,
  coverage_end   date,
  ladder         jsonb NOT NULL CHECK (jsonb_typeof(ladder) IN ('array','object')),
  source_sha256  text NOT NULL,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_date, source_sha256)
);

CREATE TABLE market_dragon_tiger_entry (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trade_date        date NOT NULL,
  dataset_type      text NOT NULL CHECK (dataset_type IN ('all','org','hot_money')),
  instrument_id     bigint REFERENCES market_instrument(id) ON DELETE SET NULL,
  range_days        integer CHECK (range_days IS NULL OR range_days > 0),
  reason            text,
  buy_amount        double precision,
  sell_amount       double precision,
  net_amount        double precision,
  source_payload    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(source_payload) = 'object'),
  source_row_sha256 text NOT NULL,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trade_date, dataset_type, source_row_sha256),
  CHECK (octet_length(source_payload::text) <= 32768)
);
CREATE INDEX market_dragon_tiger_query
  ON market_dragon_tiger_entry (trade_date DESC, dataset_type, instrument_id);

-- 特色接口权限和连续五个交易日验收完成前保持关闭。
INSERT INTO job_definition (code, name, cron, job_type, config, enabled) VALUES
  ('daily_market_structure', '每日市场结构同步', '40 15 * * 1-5', 'datasource',
   '{"pipeline":"daily_market_structure","export_volume":false}', false);
