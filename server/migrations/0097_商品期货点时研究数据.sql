-- 0097_商品期货点时研究数据.sql：补齐期货合约、商品因子和公司商品暴露的可回测存储。
-- OHLCV 继续复用 market_bar(futures_day)；本迁移只保存期货专属字段和带发布时间的研究事实。

CREATE TABLE market_futures_contract (
  instrument_id   bigint PRIMARY KEY REFERENCES market_instrument(id) ON DELETE CASCADE,
  exchange        text NOT NULL CHECK (length(btrim(exchange)) BETWEEN 2 AND 24),
  commodity_code  text NOT NULL CHECK (commodity_code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
  contract_kind   text NOT NULL CHECK (contract_kind IN ('listed','main_continuous','nearby_continuous')),
  contract_month  text CHECK (contract_month IS NULL OR contract_month ~ '^\d{6}$'),
  multiplier      numeric CHECK (multiplier IS NULL OR multiplier > 0),
  price_unit      text CHECK (price_unit IS NULL OR length(btrim(price_unit)) BETWEEN 1 AND 40),
  currency        text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  last_trade_date date,
  source          text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 80),
  raw_summary     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(raw_summary) = 'object'),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((contract_kind = 'listed') = (contract_month IS NOT NULL))
);
CREATE INDEX market_futures_contract_commodity_idx
  ON market_futures_contract (commodity_code, exchange, contract_month);

-- 现有运行库已登记的四条主力连续补最小元数据；不猜测乘数、报价单位或交易规则。
WITH known(code, exchange, commodity_code) AS (
  VALUES ('CU0','SHFE','CU'), ('AL0','SHFE','AL'), ('NI0','SHFE','NI'), ('LC0','GFEX','LC')
)
INSERT INTO market_futures_contract
  (instrument_id, exchange, commodity_code, contract_kind, source, raw_summary)
SELECT instrument.id, known.exchange, known.commodity_code, 'main_continuous', 'migration_0097',
       jsonb_build_object('legacy_code', known.code)
  FROM known JOIN market_instrument instrument ON instrument.code = known.code AND instrument.kind = 'futures'
ON CONFLICT (instrument_id) DO NOTHING;

CREATE TABLE market_futures_daily_detail (
  instrument_id   bigint NOT NULL REFERENCES market_futures_contract(instrument_id) ON DELETE CASCADE,
  trade_date      date NOT NULL,
  settlement      numeric CHECK (settlement IS NULL OR settlement > 0),
  prev_settlement numeric CHECK (prev_settlement IS NULL OR prev_settlement > 0),
  open_interest   numeric CHECK (open_interest IS NULL OR open_interest >= 0),
  upper_limit     numeric CHECK (upper_limit IS NULL OR upper_limit > 0),
  lower_limit     numeric CHECK (lower_limit IS NULL OR lower_limit > 0),
  source          text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 80),
  raw_summary     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(raw_summary) = 'object'),
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, trade_date),
  CHECK (upper_limit IS NULL OR lower_limit IS NULL OR upper_limit >= lower_limit)
);

CREATE TABLE market_futures_roll (
  continuous_instrument_id bigint NOT NULL REFERENCES market_futures_contract(instrument_id) ON DELETE CASCADE,
  trade_date               date NOT NULL,
  underlying_instrument_id bigint NOT NULL REFERENCES market_futures_contract(instrument_id) ON DELETE RESTRICT,
  roll_reason              text CHECK (roll_reason IS NULL OR length(btrim(roll_reason)) BETWEEN 1 AND 120),
  method_code              text NOT NULL CHECK (method_code ~ '^[a-z0-9][a-z0-9._-]{1,79}$'),
  adjustment_factor        numeric NOT NULL DEFAULT 1 CHECK (adjustment_factor > 0),
  source                   text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 80),
  raw_summary              jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(raw_summary) = 'object'),
  fetched_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (continuous_instrument_id, trade_date, method_code),
  CHECK (continuous_instrument_id <> underlying_instrument_id)
);
CREATE INDEX market_futures_roll_underlying_idx
  ON market_futures_roll (underlying_instrument_id, trade_date);

CREATE TABLE market_factor_series (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_code     text NOT NULL UNIQUE CHECK (series_code ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
  commodity_code  text CHECK (commodity_code IS NULL OR commodity_code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
  market          text CHECK (market IS NULL OR length(btrim(market)) BETWEEN 1 AND 40),
  metric_code     text NOT NULL CHECK (metric_code ~ '^[a-z0-9][a-z0-9._-]{1,79}$'),
  frequency       text NOT NULL CHECK (frequency IN ('daily','weekly','monthly','quarterly','annual','event')),
  unit            text NOT NULL CHECK (length(btrim(unit)) BETWEEN 1 AND 40),
  source          text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 80),
  source_timezone text NOT NULL DEFAULT 'Asia/Shanghai' CHECK (length(btrim(source_timezone)) BETWEEN 1 AND 80),
  revision_policy text NOT NULL DEFAULT 'revisable' CHECK (revision_policy IN ('none','revisable')),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX market_factor_series_lookup_idx
  ON market_factor_series (commodity_code, metric_code, active);

CREATE TABLE market_factor_observation (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_id        bigint NOT NULL REFERENCES market_factor_series(id) ON DELETE RESTRICT,
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  published_at     timestamptz NOT NULL,
  revision_no      integer NOT NULL DEFAULT 0 CHECK (revision_no >= 0),
  value            numeric NOT NULL,
  source_ref       text NOT NULL CHECK (length(btrim(source_ref)) BETWEEN 1 AND 1000),
  raw_summary      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(raw_summary) = 'object'),
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (series_id, period_start, period_end, published_at, revision_no),
  CHECK (period_end >= period_start)
);
CREATE INDEX market_factor_observation_point_in_time_idx
  ON market_factor_observation (series_id, published_at, period_end);

CREATE TABLE company_commodity_profile (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id  bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  commodity_code text NOT NULL CHECK (commodity_code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
  role           text NOT NULL CHECK (role IN ('upstream_producer','integrated','smelter','processor','service','other')),
  effective_from date NOT NULL,
  effective_to   date,
  published_at   timestamptz NOT NULL,
  source_ref     text NOT NULL CHECK (length(btrim(source_ref)) BETWEEN 1 AND 1000),
  raw_summary    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(raw_summary) = 'object'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instrument_id, commodity_code, effective_from, published_at),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX company_commodity_profile_point_in_time_idx
  ON company_commodity_profile (instrument_id, commodity_code, published_at, effective_from);

CREATE TABLE company_commodity_metric (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id  bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  commodity_code text NOT NULL CHECK (commodity_code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
  report_period  date NOT NULL,
  published_at   timestamptz NOT NULL,
  revision_no    integer NOT NULL DEFAULT 0 CHECK (revision_no >= 0),
  metric_code    text NOT NULL CHECK (metric_code ~ '^[a-z0-9][a-z0-9._-]{1,79}$'),
  value          numeric NOT NULL,
  unit           text NOT NULL CHECK (length(btrim(unit)) BETWEEN 1 AND 40),
  source_ref     text NOT NULL CHECK (length(btrim(source_ref)) BETWEEN 1 AND 1000),
  raw_summary    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(raw_summary) = 'object'),
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instrument_id, commodity_code, report_period, published_at, revision_no, metric_code)
);
CREATE INDEX company_commodity_metric_point_in_time_idx
  ON company_commodity_metric (instrument_id, commodity_code, metric_code, published_at, report_period);

COMMENT ON TABLE market_futures_contract IS '期货真实合约与连续合约元数据；OHLCV继续存放在market_bar';
COMMENT ON COLUMN market_futures_contract.instrument_id IS '对应kind=futures的统一标的主键';
COMMENT ON COLUMN market_futures_contract.exchange IS '交易所代码，如SHFE、LME或COMEX';
COMMENT ON COLUMN market_futures_contract.commodity_code IS '标准商品代码，如CU';
COMMENT ON COLUMN market_futures_contract.contract_kind IS 'listed真实合约、main_continuous主力连续或nearby_continuous近月连续';
COMMENT ON COLUMN market_futures_contract.contract_month IS '真实合约交割月YYYYMM；连续合约必须为空';
COMMENT ON COLUMN market_futures_contract.multiplier IS '每手合约乘数';
COMMENT ON COLUMN market_futures_contract.price_unit IS '报价单位，如人民币/吨';
COMMENT ON COLUMN market_futures_contract.currency IS 'ISO三位币种代码';
COMMENT ON COLUMN market_futures_contract.last_trade_date IS '真实合约最后交易日';
COMMENT ON COLUMN market_futures_contract.source IS '合约元数据来源';
COMMENT ON COLUMN market_futures_contract.raw_summary IS '来源附加字段和原始口径摘要';
COMMENT ON COLUMN market_futures_contract.updated_at IS '元数据最近更新时间';

COMMENT ON TABLE market_futures_daily_detail IS '期货日线专属结算、持仓和涨跌停字段；不重复OHLCV';
COMMENT ON COLUMN market_futures_daily_detail.instrument_id IS '期货合约标的主键';
COMMENT ON COLUMN market_futures_daily_detail.trade_date IS '交易日';
COMMENT ON COLUMN market_futures_daily_detail.settlement IS '当日结算价';
COMMENT ON COLUMN market_futures_daily_detail.prev_settlement IS '前一交易日结算价';
COMMENT ON COLUMN market_futures_daily_detail.open_interest IS '当日收盘持仓量';
COMMENT ON COLUMN market_futures_daily_detail.upper_limit IS '当日涨停价';
COMMENT ON COLUMN market_futures_daily_detail.lower_limit IS '当日跌停价';
COMMENT ON COLUMN market_futures_daily_detail.source IS '日线专属字段来源';
COMMENT ON COLUMN market_futures_daily_detail.raw_summary IS '来源附加字段和原始口径摘要';
COMMENT ON COLUMN market_futures_daily_detail.fetched_at IS '系统抓取或刷新时间';

COMMENT ON TABLE market_futures_roll IS '连续合约每日对应的真实合约及换月调整口径';
COMMENT ON COLUMN market_futures_roll.continuous_instrument_id IS '主力或近月连续合约标的';
COMMENT ON COLUMN market_futures_roll.trade_date IS '映射生效交易日';
COMMENT ON COLUMN market_futures_roll.underlying_instrument_id IS '当日对应的真实期货合约';
COMMENT ON COLUMN market_futures_roll.roll_reason IS '换月或保持当前合约的原因';
COMMENT ON COLUMN market_futures_roll.method_code IS '官方映射或连续合约算法版本代码';
COMMENT ON COLUMN market_futures_roll.adjustment_factor IS '连续序列重放使用的乘法调整因子，未调整为1';
COMMENT ON COLUMN market_futures_roll.source IS '换月映射来源或算法版本';
COMMENT ON COLUMN market_futures_roll.raw_summary IS '成交持仓比较等原始判断摘要';
COMMENT ON COLUMN market_futures_roll.fetched_at IS '映射写入时间';

COMMENT ON TABLE market_factor_series IS '商品、库存、现货和宏观研究序列目录';
COMMENT ON COLUMN market_factor_series.id IS '序列主键';
COMMENT ON COLUMN market_factor_series.series_code IS '稳定序列代码，如shfe.cu.inventory.total';
COMMENT ON COLUMN market_factor_series.commodity_code IS '关联商品代码；纯宏观序列可为空';
COMMENT ON COLUMN market_factor_series.market IS '交易所、地区或统计市场';
COMMENT ON COLUMN market_factor_series.metric_code IS '标准指标代码';
COMMENT ON COLUMN market_factor_series.frequency IS '原始发布频率';
COMMENT ON COLUMN market_factor_series.unit IS '原始数值单位';
COMMENT ON COLUMN market_factor_series.source IS '权威数据来源';
COMMENT ON COLUMN market_factor_series.source_timezone IS '发布时间解释使用的IANA时区';
COMMENT ON COLUMN market_factor_series.revision_policy IS '数据是否允许后续修订';
COMMENT ON COLUMN market_factor_series.active IS '是否继续同步该序列';
COMMENT ON COLUMN market_factor_series.created_at IS '序列登记时间';
COMMENT ON COLUMN market_factor_series.updated_at IS '序列元数据最近更新时间';

COMMENT ON TABLE market_factor_observation IS '带报告期、发布时间和修订号的商品及宏观点时观测';
COMMENT ON COLUMN market_factor_observation.id IS '观测主键';
COMMENT ON COLUMN market_factor_observation.series_id IS '所属研究序列';
COMMENT ON COLUMN market_factor_observation.period_start IS '观测描述区间起点';
COMMENT ON COLUMN market_factor_observation.period_end IS '观测描述区间终点';
COMMENT ON COLUMN market_factor_observation.published_at IS '市场最早可获得该值的时间';
COMMENT ON COLUMN market_factor_observation.revision_no IS '同一报告期的修订序号，首次发布为0';
COMMENT ON COLUMN market_factor_observation.value IS '按序列单位保存的原始数值';
COMMENT ON COLUMN market_factor_observation.source_ref IS '来源页面、公告号或文件标识';
COMMENT ON COLUMN market_factor_observation.raw_summary IS '来源附加字段和口径摘要';
COMMENT ON COLUMN market_factor_observation.fetched_at IS '系统抓取时间，不替代published_at';

COMMENT ON TABLE company_commodity_profile IS '上市公司商品业务角色及其点时有效区间';
COMMENT ON COLUMN company_commodity_profile.id IS '公司商品画像主键';
COMMENT ON COLUMN company_commodity_profile.instrument_id IS '上市公司统一标的主键';
COMMENT ON COLUMN company_commodity_profile.commodity_code IS '关联商品代码';
COMMENT ON COLUMN company_commodity_profile.role IS '上游、矿冶一体、冶炼、加工、服务或其他角色';
COMMENT ON COLUMN company_commodity_profile.effective_from IS '业务角色有效期起点';
COMMENT ON COLUMN company_commodity_profile.effective_to IS '业务角色有效期终点，空表示仍有效';
COMMENT ON COLUMN company_commodity_profile.published_at IS '市场最早可获得该分类证据的时间';
COMMENT ON COLUMN company_commodity_profile.source_ref IS '公司公告或其他原始证据标识';
COMMENT ON COLUMN company_commodity_profile.raw_summary IS '分类依据和原始摘要';
COMMENT ON COLUMN company_commodity_profile.created_at IS '记录写入时间';

COMMENT ON TABLE company_commodity_metric IS '公司产量、成本、储量、套保等商品经营指标的点时观测';
COMMENT ON COLUMN company_commodity_metric.id IS '公司商品指标主键';
COMMENT ON COLUMN company_commodity_metric.instrument_id IS '上市公司统一标的主键';
COMMENT ON COLUMN company_commodity_metric.commodity_code IS '关联商品代码';
COMMENT ON COLUMN company_commodity_metric.report_period IS '指标所属报告期';
COMMENT ON COLUMN company_commodity_metric.published_at IS '市场最早可获得该指标的时间';
COMMENT ON COLUMN company_commodity_metric.revision_no IS '同一报告期指标的修订序号';
COMMENT ON COLUMN company_commodity_metric.metric_code IS '服务端白名单经营指标代码';
COMMENT ON COLUMN company_commodity_metric.value IS '按unit保存的原始数值';
COMMENT ON COLUMN company_commodity_metric.unit IS '指标单位';
COMMENT ON COLUMN company_commodity_metric.source_ref IS '公司公告或其他原始证据标识';
COMMENT ON COLUMN company_commodity_metric.raw_summary IS '披露口径和原始摘要';
COMMENT ON COLUMN company_commodity_metric.fetched_at IS '系统抓取时间，不替代published_at';
