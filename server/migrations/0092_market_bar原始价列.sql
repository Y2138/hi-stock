-- 0092_market_bar原始价列.sql：market_bar 同时保存前复权价与原始成交价。
-- 背景：全市场多年日线历史需要原始成交价（公司行为、容量与涨跌停研究），
-- 但现有 open/high/low/close 是生产信号使用的前复权口径，不能改写。
-- 方案：在同一行内并列保存两套价格，避免新增表或按 adjustment 拆行；现有读取路径全部不变。
-- 语义：open/high/low/close 仍为 adjustment 标注的口径（股票为 forward，指数/板块/ETF 为 none）；
--       *_raw 恒为原始成交价。adjustment='none' 或 NULL 时两套价格相同。

ALTER TABLE market_bar
  ADD COLUMN open_raw  numeric,
  ADD COLUMN high_raw  numeric,
  ADD COLUMN low_raw   numeric,
  ADD COLUMN close_raw numeric,
  ADD COLUMN prev_close_raw numeric;

COMMENT ON COLUMN market_bar.open_raw  IS '原始成交价：开盘（未复权）';
COMMENT ON COLUMN market_bar.high_raw  IS '原始成交价：最高（未复权）';
COMMENT ON COLUMN market_bar.low_raw   IS '原始成交价：最低（未复权）';
COMMENT ON COLUMN market_bar.close_raw IS '原始成交价：收盘（未复权）；open/high/low/close 为前复权等口径';
COMMENT ON COLUMN market_bar.prev_close_raw IS '原始成交价：前收盘（未复权），用于计算真实涨跌幅与涨跌停';

-- 指数、板块、ETF、期货无复权语义，两套价格相同，迁移时直接补齐。
-- 股票原始价与现有前复权价不同，保持 NULL 由全市场回填补齐，不用前复权价冒充原始价。
UPDATE market_bar bar
   SET open_raw = bar.open, high_raw = bar.high, low_raw = bar.low, close_raw = bar.close
  FROM market_instrument instrument
 WHERE instrument.id = bar.instrument_id
   AND instrument.kind <> 'stock'
   AND bar.open_raw IS NULL;
