ALTER TABLE intraday_position_risk
  ADD COLUMN action text CHECK (action IN ('add','reduce','wait')),
  ADD COLUMN add_plan jsonb CHECK (add_plan IS NULL OR jsonb_typeof(add_plan)='object'),
  ADD COLUMN reduce_plan jsonb CHECK (reduce_plan IS NULL OR jsonb_typeof(reduce_plan)='object'),
  ADD COLUMN emotion text NOT NULL DEFAULT 'unknown' CHECK (emotion IN ('ice_point','weak','neutral','strong','unknown'));
COMMENT ON COLUMN intraday_position_risk.action IS '当日量价提醒动作；旧风险记录为空，不作为新提醒展示';
COMMENT ON COLUMN intraday_position_risk.add_plan IS '加仓价区间、触发条件、取消条件及触发状态；不执行交易';
COMMENT ON COLUMN intraday_position_risk.reduce_plan IS '减仓价区间、触发条件、取消条件及触发状态；不执行交易';
COMMENT ON COLUMN intraday_position_risk.emotion IS '结合当日市场情绪快照的判断，未知时不推断冰点';

CREATE TABLE intraday_market_sentiment (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trade_date date NOT NULL,
  captured_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('ready','partial','unavailable')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object')
);
CREATE INDEX intraday_market_sentiment_date ON intraday_market_sentiment(trade_date,captured_at DESC);
COMMENT ON TABLE intraday_market_sentiment IS '当日涨停、跌停、炸板点时总数与来源时间；所有账户共享，本机运行数据';
COMMENT ON COLUMN intraday_market_sentiment.id IS '情绪采样编号';
COMMENT ON COLUMN intraday_market_sentiment.trade_date IS '采样交易日';
COMMENT ON COLUMN intraday_market_sentiment.captured_at IS '采集时刻';
COMMENT ON COLUMN intraday_market_sentiment.status IS '覆盖状态；未知或过期不判断冰点';
COMMENT ON COLUMN intraday_market_sentiment.payload IS '三类市场总数、来源时间与覆盖缺口';
