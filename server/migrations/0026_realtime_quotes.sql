-- 0026_realtime_quotes.sql：近实时最新快照、盘中采样与运行参数。
-- 盘中采样不表达 K 线，不得写入 market_bar。

CREATE TABLE market_quote_latest (
  instrument_id bigint PRIMARY KEY REFERENCES market_instrument(id) ON DELETE CASCADE,
  trade_date    date NOT NULL,
  quote_time    timestamptz NOT NULL,
  fetched_at    timestamptz NOT NULL,
  last          double precision NOT NULL
                CHECK (last NOT IN ('Infinity'::float8, '-Infinity'::float8, 'NaN'::float8)),
  prev_close    double precision
                CHECK (prev_close IS NULL OR prev_close NOT IN ('Infinity'::float8, '-Infinity'::float8, 'NaN'::float8)),
  open          double precision
                CHECK (open IS NULL OR open NOT IN ('Infinity'::float8, '-Infinity'::float8, 'NaN'::float8)),
  high          double precision
                CHECK (high IS NULL OR high NOT IN ('Infinity'::float8, '-Infinity'::float8, 'NaN'::float8)),
  low           double precision
                CHECK (low IS NULL OR low NOT IN ('Infinity'::float8, '-Infinity'::float8, 'NaN'::float8)),
  volume        double precision
                CHECK (volume IS NULL OR volume NOT IN ('Infinity'::float8, '-Infinity'::float8, 'NaN'::float8)),
  turnover      double precision
                CHECK (turnover IS NULL OR turnover NOT IN ('Infinity'::float8, '-Infinity'::float8, 'NaN'::float8)),
  source        text NOT NULL,
  request_id    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX market_quote_latest_trade_date ON market_quote_latest (trade_date, quote_time DESC);

CREATE TABLE market_quote_sample (
  instrument_id bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  quote_time    timestamptz NOT NULL,
  trade_date    date NOT NULL,
  fetched_at    timestamptz NOT NULL,
  last          double precision NOT NULL
                CHECK (last NOT IN ('Infinity'::float8, '-Infinity'::float8, 'NaN'::float8)),
  prev_close    double precision NOT NULL
                CHECK (prev_close > 0 AND prev_close NOT IN ('Infinity'::float8, '-Infinity'::float8, 'NaN'::float8)),
  volume        double precision
                CHECK (volume IS NULL OR volume NOT IN ('Infinity'::float8, '-Infinity'::float8, 'NaN'::float8)),
  turnover      double precision
                CHECK (turnover IS NULL OR turnover NOT IN ('Infinity'::float8, '-Infinity'::float8, 'NaN'::float8)),
  source        text NOT NULL,
  request_id    text,
  PRIMARY KEY (instrument_id, quote_time)
);
CREATE INDEX market_quote_sample_date ON market_quote_sample (trade_date, quote_time);

CREATE TABLE market_runtime_setting (
  singleton                   boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  realtime_enabled            boolean NOT NULL DEFAULT false,
  foreground_interval_seconds integer NOT NULL DEFAULT 60 CHECK (foreground_interval_seconds BETWEEN 30 AND 3600),
  background_interval_seconds integer NOT NULL DEFAULT 300 CHECK (background_interval_seconds BETWEEN 60 AND 7200),
  sample_retention_trade_days  integer NOT NULL DEFAULT 30 CHECK (sample_retention_trade_days BETWEEN 1 AND 250),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO market_runtime_setting (singleton) VALUES (true);
