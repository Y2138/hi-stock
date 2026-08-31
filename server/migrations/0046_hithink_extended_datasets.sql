-- 0046_hithink_extended_datasets.sql：扶摇竞价、特色数据与基金研究快照。

ALTER TABLE market_instrument
  DROP CONSTRAINT IF EXISTS market_instrument_source_asset_type_check;
ALTER TABLE market_instrument
  ADD CONSTRAINT market_instrument_source_asset_type_check
  CHECK (source_asset_type IS NULL OR source_asset_type IN
    ('a-share','a-share-index','fund-etf','fund-lof','fund-otc','fund-reits','internal-futures'));

CREATE TABLE hithink_dataset_snapshot (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  capability          text NOT NULL CHECK (length(btrim(capability)) BETWEEN 1 AND 80),
  request_key         text NOT NULL CHECK (request_key ~ '^[a-f0-9]{64}$'),
  request_params      jsonb NOT NULL CHECK (jsonb_typeof(request_params) = 'object'),
  as_of_date          date NOT NULL,
  source_timestamp_ms bigint CHECK (source_timestamp_ms IS NULL OR source_timestamp_ms > 0),
  data_status         text,
  row_count           integer NOT NULL CHECK (row_count >= 0),
  payload             jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capability, request_key)
);

CREATE INDEX hithink_dataset_snapshot_lookup
  ON hithink_dataset_snapshot (capability, as_of_date DESC, fetched_at DESC);

COMMENT ON TABLE hithink_dataset_snapshot IS
  '扶摇竞价、热榜、异动与基金研究数据的最新请求快照；只允许白名单数据源 service 写入';
