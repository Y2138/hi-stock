-- 0061_正式指标六年窗口.sql：正式日线指标只使用截至各标的最新行情日的近六年输入。

INSERT INTO market_indicator_dirty
  (instrument_id, freq, earliest_date, generation, reason, updated_at)
SELECT instrument_id,
       freq,
       (max(bar_date) - INTERVAL '6 years')::date,
       1,
       '正式日线指标切换近六年窗口',
       now()
  FROM market_bar
 WHERE freq = 'day'
 GROUP BY instrument_id, freq
ON CONFLICT (instrument_id, freq) DO UPDATE SET
  earliest_date = EXCLUDED.earliest_date,
  generation = market_indicator_dirty.generation + 1,
  reason = EXCLUDED.reason,
  updated_at = now();
