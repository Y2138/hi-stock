-- 0023_market_universe_boards.sql：完整标的目录、板块有效期、交易日与系统跟踪。

ALTER TABLE market_instrument
  DROP CONSTRAINT instrument_kind_check;
ALTER TABLE market_instrument
  ADD CONSTRAINT market_instrument_kind_check
  CHECK (kind IN ('stock','etf','index','board','fund','futures'));

ALTER TABLE market_instrument
  ADD COLUMN ticker text,
  ADD COLUMN exchange text CHECK (exchange IS NULL OR exchange IN ('SH','SZ','BJ')),
  ADD COLUMN source_asset_type text
    CHECK (source_asset_type IS NULL OR source_asset_type IN
      ('a-share','a-share-index','fund-etf','fund-lof','fund-otc','internal-futures')),
  ADD COLUMN currency text NOT NULL DEFAULT 'CNY',
  ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'unknown'
    CHECK (lifecycle_status IN ('active','inactive','delisted','unknown')),
  ADD COLUMN capabilities jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(capabilities) = 'object'),
  ADD COLUMN source_updated_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE market_instrument
   SET ticker = split_part(code, '.', 1),
       exchange = CASE upper(split_part(code, '.', 2))
         WHEN 'SH' THEN 'SH' WHEN 'SZ' THEN 'SZ' WHEN 'BJ' THEN 'BJ' ELSE NULL END,
       source_asset_type = CASE kind
         WHEN 'stock' THEN 'a-share'
         WHEN 'etf' THEN 'fund-etf'
         WHEN 'index' THEN 'a-share-index'
         WHEN 'futures' THEN 'internal-futures'
         ELSE NULL END,
       lifecycle_status = 'active',
       capabilities = CASE kind
         WHEN 'stock' THEN '{"snapshot":true,"daily_bar":true,"financial":true}'::jsonb
         WHEN 'etf' THEN '{"snapshot":true,"daily_bar":true}'::jsonb
         WHEN 'index' THEN '{"snapshot":true,"daily_bar":true}'::jsonb
         WHEN 'futures' THEN '{"snapshot":false,"daily_bar":true}'::jsonb
         ELSE '{}'::jsonb END,
       updated_at = now();

CREATE INDEX market_instrument_ticker_idx ON market_instrument (ticker);
CREATE INDEX market_instrument_kind_status_idx ON market_instrument (kind, lifecycle_status);
CREATE INDEX market_instrument_name_idx ON market_instrument (name);

CREATE TABLE market_instrument_alias (
  instrument_id bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  alias         text NOT NULL CHECK (length(btrim(alias)) BETWEEN 1 AND 120),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, alias)
);
CREATE INDEX market_instrument_alias_lookup ON market_instrument_alias (alias);

CREATE TABLE market_board (
  instrument_id    bigint PRIMARY KEY REFERENCES market_instrument(id) ON DELETE CASCADE,
  board_type       text NOT NULL CHECK (board_type IN ('industry','concept','region','special')),
  source           text NOT NULL DEFAULT 'hithink',
  source_updated_at timestamptz,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX market_board_type_active ON market_board (board_type, active);

CREATE TABLE market_board_membership (
  board_instrument_id  bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  member_instrument_id bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  effective_from       date NOT NULL,
  effective_to         date,
  opened_fetch_run_id  bigint REFERENCES market_fetch_run(id) ON DELETE SET NULL,
  closed_fetch_run_id  bigint REFERENCES market_fetch_run(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_instrument_id, member_instrument_id, effective_from),
  CHECK (board_instrument_id <> member_instrument_id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX market_board_membership_current
  ON market_board_membership (board_instrument_id, member_instrument_id)
  WHERE effective_to IS NULL;
CREATE INDEX market_board_membership_member_current
  ON market_board_membership (member_instrument_id, board_instrument_id)
  WHERE effective_to IS NULL;

CREATE TABLE market_trading_day (
  trade_date  date PRIMARY KEY,
  is_open     boolean NOT NULL,
  source      text NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE market_system_tracking (
  instrument_id bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  reason        text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 120),
  realtime      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, reason)
);

-- 首次部署保持关闭：管理员完成真实目录容量探测后再按顺序开启。
INSERT INTO job_definition (code, name, cron, job_type, config, enabled) VALUES
  ('market_catalog_sync', '完整标的与板块目录同步', '10 7 * * 1-5', 'datasource',
   '{"pipeline":"market_catalog_sync","export_volume":false}', false),
  ('board_membership_sync', '全量板块成分同步', '30 7 * * 1-5', 'datasource',
   '{"pipeline":"board_membership_sync","export_volume":false}', false);
