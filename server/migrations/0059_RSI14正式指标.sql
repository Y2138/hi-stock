-- 0059_RSI14正式指标.sql：在统一指标服务中补充 Wilder RSI14，并安排日线全量重算。

ALTER TABLE market_indicator_value
  ADD COLUMN rsi14 double precision
    CHECK (rsi14 IS NULL OR (rsi14 >= 0 AND rsi14 <= 100));

INSERT INTO market_indicator_dirty
  (instrument_id, freq, earliest_date, generation, reason, updated_at)
SELECT instrument_id, freq, min(bar_date), 1, 'RSI14 指标版本升级', now()
  FROM market_bar
 WHERE freq = 'day'
 GROUP BY instrument_id, freq
ON CONFLICT (instrument_id, freq) DO UPDATE SET
  earliest_date = LEAST(market_indicator_dirty.earliest_date, EXCLUDED.earliest_date),
  generation = market_indicator_dirty.generation + 1,
  reason = EXCLUDED.reason,
  updated_at = now();
