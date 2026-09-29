-- 盘中持仓风险观察：只保存盘中采样和每只持仓的最新简短判断，不创建 Agent 会话。

CREATE TABLE intraday_market_sample (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trade_date     date NOT NULL,
  sample_at      timestamptz NOT NULL,
  source_at      timestamptz,
  code           text NOT NULL,
  name           text NOT NULL,
  role           text NOT NULL CHECK (role IN ('position','industry','index')),
  open_price     numeric,
  high_price     numeric,
  low_price      numeric,
  last_price     numeric,
  prev_close     numeric,
  volume         numeric,
  turnover       numeric,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  data_status    text NOT NULL DEFAULT 'ready' CHECK (data_status IN ('ready','missing','stale')),
  UNIQUE (trade_date, sample_at, code, role)
);
CREATE INDEX intraday_market_sample_code_time
  ON intraday_market_sample (trade_date, code, sample_at DESC);

CREATE TABLE intraday_position_risk (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trade_date     date NOT NULL,
  code           text NOT NULL,
  name           text NOT NULL,
  risk           text NOT NULL CHECK (risk IN ('normal','watch','high')),
  key_level      text,
  reason         text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 240),
  sample_at      timestamptz,
  data_time      timestamptz,
  model_key      text NOT NULL,
  input_sha256   text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trade_date, code)
);
CREATE INDEX intraday_position_risk_date_updated
  ON intraday_position_risk (trade_date, updated_at DESC);

COMMENT ON TABLE intraday_market_sample IS '盘中持仓风险观察使用的个股、行业板块与大盘指数快照';
COMMENT ON TABLE intraday_position_risk IS '盘中持仓风险观察的最新简短判断，不关联 Agent 会话';
COMMENT ON COLUMN intraday_market_sample.id IS '采样编号';
COMMENT ON COLUMN intraday_market_sample.trade_date IS '交易日';
COMMENT ON COLUMN intraday_market_sample.sample_at IS '服务端采样时刻';
COMMENT ON COLUMN intraday_market_sample.source_at IS '数据源快照时刻';
COMMENT ON COLUMN intraday_market_sample.code IS '标的代码';
COMMENT ON COLUMN intraday_market_sample.name IS '标的名称';
COMMENT ON COLUMN intraday_market_sample.role IS '持仓、行业板块或大盘指数';
COMMENT ON COLUMN intraday_market_sample.open_price IS '当日开盘价';
COMMENT ON COLUMN intraday_market_sample.high_price IS '当日最高价';
COMMENT ON COLUMN intraday_market_sample.low_price IS '当日最低价';
COMMENT ON COLUMN intraday_market_sample.last_price IS '最新价';
COMMENT ON COLUMN intraday_market_sample.prev_close IS '前收盘价';
COMMENT ON COLUMN intraday_market_sample.volume IS '数据源成交量';
COMMENT ON COLUMN intraday_market_sample.turnover IS '数据源成交额';
COMMENT ON COLUMN intraday_market_sample.fetched_at IS '服务端写入时刻';
COMMENT ON COLUMN intraday_market_sample.data_status IS '采样数据状态';
COMMENT ON COLUMN intraday_position_risk.id IS '风险判断编号';
COMMENT ON COLUMN intraday_position_risk.trade_date IS '交易日';
COMMENT ON COLUMN intraday_position_risk.code IS '持仓标的代码';
COMMENT ON COLUMN intraday_position_risk.name IS '持仓标的名称';
COMMENT ON COLUMN intraday_position_risk.risk IS '风险等级';
COMMENT ON COLUMN intraday_position_risk.key_level IS '需要关注的关键位置';
COMMENT ON COLUMN intraday_position_risk.reason IS '简短盘面分析原因';
COMMENT ON COLUMN intraday_position_risk.sample_at IS '对应采样时刻';
COMMENT ON COLUMN intraday_position_risk.data_time IS '对应数据时刻';
COMMENT ON COLUMN intraday_position_risk.model_key IS '使用的模型标识';
COMMENT ON COLUMN intraday_position_risk.input_sha256 IS '模型输入哈希';
COMMENT ON COLUMN intraday_position_risk.updated_at IS '最后更新时间';
