-- 0094_补齐标准回测前置数据.sql
-- 目的：让 standard_daily 首期 day_rule 回测可以在同一代数据库内通过预检。
-- 1) 用快速默认值方式给 market_bar.volume_unit 补齐“股”，避免对千万行逐行 UPDATE；
--    期货日线成交量单位不同，显式改为 NULL。30 分钟与日线 A 股量纲按“股”处理。
-- 2) market_trading_day 补完整自然日日历，非交易日显式 is_open=false，
--    避免标准输入把缺失日期误判为日历缺口。

ALTER TABLE market_bar DROP COLUMN volume_unit;
ALTER TABLE market_bar ADD COLUMN volume_unit text DEFAULT '股';
COMMENT ON COLUMN market_bar.volume_unit IS '成交量单位；A 股日线/30分钟为股，期货日线为 NULL';

UPDATE market_bar SET volume_unit = NULL WHERE freq = 'futures_day';

WITH bounds AS (
  SELECT min(bar_date)::date AS min_date,
         max(bar_date)::date AS max_date
    FROM market_bar
   WHERE freq = 'day'
),
calendar AS (
  SELECT generate_series(bounds.min_date, bounds.max_date, interval '1 day')::date AS trade_date
    FROM bounds
   WHERE bounds.min_date IS NOT NULL
     AND bounds.max_date IS NOT NULL
),
open_dates AS (
  SELECT DISTINCT bar_date AS trade_date
    FROM market_bar
   WHERE freq = 'day'
),
derived AS (
  SELECT calendar.trade_date,
         (open_dates.trade_date IS NOT NULL OR COALESCE(existing.is_open, false)) AS is_open
    FROM calendar
    LEFT JOIN open_dates ON open_dates.trade_date = calendar.trade_date
    LEFT JOIN market_trading_day existing ON existing.trade_date = calendar.trade_date
)
INSERT INTO market_trading_day (trade_date, is_open, source, fetched_at)
SELECT trade_date, is_open, 'derived_from_market_bar', now()
  FROM derived
ON CONFLICT (trade_date) DO UPDATE SET
  is_open = EXCLUDED.is_open,
  source = EXCLUDED.source,
  fetched_at = now();
