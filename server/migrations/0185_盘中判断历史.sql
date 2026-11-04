-- 盘中判断历史：每个采样周期、每只持仓各追加一条模型判断，用于事后复盘与胜率评估。
-- 最新判断仍由 intraday_position_risk 覆盖保存；本表只追加，不因新判断改写旧行。

CREATE TABLE intraday_position_signal (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     bigint NOT NULL REFERENCES portfolio_account(id),
  trade_date     date NOT NULL,
  sample_at      timestamptz NOT NULL,
  code           text NOT NULL,
  name           text NOT NULL,
  action         text NOT NULL CHECK (action IN ('add','reduce','wait')),
  emotion        text NOT NULL CHECK (emotion IN ('ice_point','weak','neutral','strong','unknown')),
  risk           text NOT NULL CHECK (risk IN ('normal','watch','high')),
  key_level      text,
  reason         text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 240),
  add_plan       jsonb CHECK (add_plan IS NULL OR jsonb_typeof(add_plan)='object'),
  reduce_plan    jsonb CHECK (reduce_plan IS NULL OR jsonb_typeof(reduce_plan)='object'),
  latest_price   numeric CHECK (latest_price IS NULL OR latest_price > 0),
  model_key      text NOT NULL,
  input_sha256   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, trade_date, code, sample_at)
);
CREATE INDEX intraday_position_signal_date ON intraday_position_signal (trade_date, sample_at);

COMMENT ON TABLE intraday_position_signal IS '盘中每轮模型判断的追加历史；复盘与胜率评估用，本机运行数据不进入固定资产包';
COMMENT ON COLUMN intraday_position_signal.id IS '判断历史编号';
COMMENT ON COLUMN intraday_position_signal.account_id IS '账户编号';
COMMENT ON COLUMN intraday_position_signal.trade_date IS '交易日';
COMMENT ON COLUMN intraday_position_signal.sample_at IS '本轮判断对应的采样时刻';
COMMENT ON COLUMN intraday_position_signal.code IS '持仓标的代码';
COMMENT ON COLUMN intraday_position_signal.name IS '持仓标的名称';
COMMENT ON COLUMN intraday_position_signal.action IS '本轮动作：加仓、减仓或等待';
COMMENT ON COLUMN intraday_position_signal.emotion IS '当轮市场情绪；数据不足时为 unknown';
COMMENT ON COLUMN intraday_position_signal.risk IS '由动作映射的风险等级，仅用于展示与回溯';
COMMENT ON COLUMN intraday_position_signal.key_level IS '当轮关注的加减仓价区间摘要';
COMMENT ON COLUMN intraday_position_signal.reason IS '当轮量价依据，60 字以内';
COMMENT ON COLUMN intraday_position_signal.add_plan IS '当轮加仓价区间、条件、取消条件与触发状态；不执行交易';
COMMENT ON COLUMN intraday_position_signal.reduce_plan IS '当轮减仓价区间、条件、取消条件与触发状态；不执行交易';
COMMENT ON COLUMN intraday_position_signal.latest_price IS '判断时刻该标的的最新价，用于事后计算信号后收益';
COMMENT ON COLUMN intraday_position_signal.model_key IS '使用的模型标识';
COMMENT ON COLUMN intraday_position_signal.input_sha256 IS '本轮模型输入哈希，用于识别相同输入的重复判断';
COMMENT ON COLUMN intraday_position_signal.created_at IS '写入时刻';
