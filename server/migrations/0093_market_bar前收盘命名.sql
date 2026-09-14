-- 0093_market_bar前收盘命名.sql：把 0092 新加的 prev_close_raw 更名为 prev_close。
-- 语义修正：该列保存「交易所前收盘」，即上一交易日收盘价，并在当日除权时按公司行为调整为
-- 除权参考价（涨跌停与真实涨跌幅的官方基准）。它不是原始价，用 _raw 命名会误导；
-- 原始意义上的前一交易日收盘价可由 close_raw 的相邻行直接得到，无需单独存列。
-- 0092 仅在本次开发实例应用过，此处用前向迁移改名，不改写已应用的 0092。

ALTER TABLE market_bar RENAME COLUMN prev_close_raw TO prev_close;
COMMENT ON COLUMN market_bar.prev_close IS
  '交易所前收盘：上一交易日收盘价，当日除权时按公司行为调整为除权参考价；用于涨跌停与真实涨跌幅';
