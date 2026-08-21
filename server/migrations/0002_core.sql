-- 二期核心表：标的、池、自选、持仓、快照、行情、获取记录、数据卷、文档与脚本版本
-- 依据：project/docs/design/Stock_策略演进系统_技术设计_v2.0.md §4.1

CREATE TABLE instrument (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('stock','etf','index','futures')),
  sector_code text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pool_membership (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id  bigint NOT NULL REFERENCES instrument(id),
  pool           text NOT NULL CHECK (pool IN ('short','long')),
  role           text NOT NULL,
  grade          text,
  score          numeric,
  tags           jsonb NOT NULL DEFAULT '[]',
  effective_from date NOT NULL,
  effective_to   date,
  note           text,
  UNIQUE (instrument_id, pool, effective_from)
);

CREATE TABLE watchlist_group (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  sort int NOT NULL DEFAULT 0
);

CREATE TABLE watchlist_item (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id       bigint NOT NULL REFERENCES watchlist_group(id) ON DELETE CASCADE,
  instrument_id  bigint NOT NULL REFERENCES instrument(id),
  sort           int NOT NULL DEFAULT 0,
  added_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, instrument_id)
);

CREATE TABLE position (
  instrument_id   bigint PRIMARY KEY REFERENCES instrument(id),
  quantity        numeric NOT NULL,
  cost_price      numeric NOT NULL,
  cost_basis      text,
  opened_at       date,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE position_change (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id  bigint NOT NULL REFERENCES instrument(id),
  change_date    date NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('buy','sell','adjust','note')),
  quantity       numeric,
  price          numeric,
  amount         numeric,
  reason         text,
  source         text NOT NULL CHECK (source IN ('form','chat','job','ingest')),
  confirmation_id bigint,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE position_snapshot_daily (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snap_date      date NOT NULL,
  instrument_id  bigint NOT NULL REFERENCES instrument(id),
  quantity       numeric NOT NULL,
  cost_price     numeric NOT NULL,
  close          numeric,
  market_value   numeric,
  pnl_amount     numeric,
  stop_price     numeric,
  target_price   numeric,
  UNIQUE (snap_date, instrument_id)
);

CREATE TABLE account_snapshot (
  snap_date      date PRIMARY KEY,
  total_asset    numeric,
  market_value   numeric,
  cash           numeric,
  raw_text       text,
  precision      text NOT NULL DEFAULT 'exact' CHECK (precision IN ('exact','approx')),
  source         text NOT NULL DEFAULT 'ingest'
);

CREATE TABLE market_bar (
  instrument_id  bigint NOT NULL REFERENCES instrument(id),
  freq           text NOT NULL CHECK (freq IN ('day','30m','futures_day')),
  bar_date       date NOT NULL,
  bar_time       timestamptz NOT NULL,           -- day/futures_day 存 bar_date 当日 00:00:00Z；30m 存实际时刻
  open   numeric NOT NULL, high numeric NOT NULL,
  low    numeric NOT NULL, close numeric NOT NULL,
  volume numeric,
  ma5 numeric, ma10 numeric, ma20 numeric, ma60 numeric,
  adjustment   text,
  volume_unit  text,
  channel      text NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, freq, bar_date, bar_time)
);
CREATE INDEX market_bar_lookup ON market_bar (instrument_id, freq, bar_date DESC);

CREATE TABLE fetch_run (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_run_id  bigint,
  channel     text NOT NULL,
  scope       jsonb NOT NULL,
  rows_written int NOT NULL DEFAULT 0,
  degraded_from text,
  gaps        jsonb NOT NULL DEFAULT '[]',
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE volume_snapshot (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  path       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  manifest   jsonb NOT NULL,
  kind       text NOT NULL DEFAULT 'scheduled' CHECK (kind IN ('scheduled','manual'))
);

CREATE TABLE strategy_doc (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  path text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE strategy_version (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id         bigint NOT NULL REFERENCES strategy_doc(id) ON DELETE CASCADE,
  version_no     int NOT NULL,
  sha256         text NOT NULL,
  content        text NOT NULL,
  change_summary text,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_id, version_no)
);

CREATE TABLE script_registry (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  path text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE script_version (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  script_id      bigint NOT NULL REFERENCES script_registry(id) ON DELETE CASCADE,
  version_no     int NOT NULL,
  sha256         text NOT NULL,
  content        text NOT NULL,
  change_summary text,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (script_id, version_no)
);

ALTER TABLE backtest_run ADD COLUMN engine_sha256 text;
