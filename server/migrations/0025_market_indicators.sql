-- 0025_market_indicators.sql：派生指标的脏标记、计算批次和当前权威值。

CREATE TABLE market_indicator_dirty (
  instrument_id bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  freq          text NOT NULL CHECK (freq IN ('day','30m','futures_day')),
  earliest_date date NOT NULL,
  generation    bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  reason        text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, freq)
);

CREATE TABLE market_indicator_run (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id       bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  freq                text NOT NULL CHECK (freq IN ('day','30m','futures_day')),
  calculation_version text NOT NULL,
  input_sha256        text NOT NULL,
  input_row_count     integer NOT NULL CHECK (input_row_count >= 0),
  input_start_date    date,
  input_end_date      date,
  adjustment          text,
  status              text NOT NULL CHECK (status IN ('running','success','partial','failed','untrusted','stale')),
  gaps                jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(gaps) = 'array'),
  error_message       text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX market_indicator_run_lookup
  ON market_indicator_run (instrument_id, freq, created_at DESC);

CREATE TABLE market_indicator_value (
  instrument_id bigint NOT NULL,
  freq          text NOT NULL,
  bar_date      date NOT NULL,
  bar_time      timestamptz NOT NULL,
  run_id        bigint NOT NULL REFERENCES market_indicator_run(id) ON DELETE CASCADE,
  ma5           double precision,
  ma10          double precision,
  ma20          double precision,
  ma60          double precision,
  dif           double precision,
  dea           double precision,
  macd_hist     double precision,
  status        text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','untrusted')),
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, freq, bar_date, bar_time),
  FOREIGN KEY (instrument_id, freq, bar_date, bar_time)
    REFERENCES market_bar(instrument_id, freq, bar_date, bar_time) ON DELETE CASCADE
);
CREATE INDEX market_indicator_value_run ON market_indicator_value (run_id);

INSERT INTO market_indicator_dirty (instrument_id, freq, earliest_date, reason)
SELECT instrument_id, freq, min(bar_date), '迁移后首次全量计算'
  FROM market_bar
 WHERE freq IN ('day','futures_day')
 GROUP BY instrument_id, freq;

