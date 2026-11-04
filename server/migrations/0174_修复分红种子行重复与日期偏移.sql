-- 研究脚本把 ex_date_ms 按 UTC 取日回填分红，比真实除权日（北京时间零点）早一天，
-- 于是同一次除权既留下种子行又留下正式同步行，按 366 天窗口求和时被计两次。
-- 先删除与次日正式行金额一致的种子行，再把没有正式行可对的种子行校正到真实除权日。
DELETE FROM market_corporate_action seed
 WHERE seed.raw_summary->>'seed' = 'research-cache'
   AND EXISTS (
     SELECT 1 FROM market_corporate_action live
      WHERE live.instrument_id = seed.instrument_id
        AND live.ex_date = seed.ex_date + 1
        AND live.dividend_per_share = seed.dividend_per_share
        AND live.bonus_per_share = seed.bonus_per_share
        AND live.rights_ratio = seed.rights_ratio
        AND live.rights_price = seed.rights_price
        AND live.raw_summary->>'seed' IS DISTINCT FROM 'research-cache'
   );

-- 增量同步游标存的是已同步最新除权日，必须在种子行前移之前一并前移，否则会指向不存在的日期。
UPDATE market_corporate_action_sync_state state
   SET latest_ex_date = state.latest_ex_date + 1, updated_at = now()
 WHERE EXISTS (
   SELECT 1 FROM market_corporate_action seed
    WHERE seed.instrument_id = state.instrument_id
      AND seed.raw_summary->>'seed' = 'research-cache'
      AND seed.ex_date = state.latest_ex_date
      AND NOT EXISTS (
        SELECT 1 FROM market_corporate_action live
         WHERE live.instrument_id = seed.instrument_id AND live.ex_date = seed.ex_date + 1
      )
 );

UPDATE market_corporate_action seed
   SET ex_date = seed.ex_date + 1
 WHERE seed.raw_summary->>'seed' = 'research-cache'
   AND NOT EXISTS (
     SELECT 1 FROM market_corporate_action live
      WHERE live.instrument_id = seed.instrument_id
        AND live.ex_date = seed.ex_date + 1
   );
