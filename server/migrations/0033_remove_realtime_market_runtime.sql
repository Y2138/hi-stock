-- 0033_remove_realtime_market_runtime.sql：移除未启用的近实时轮询、采样与订阅存储。
-- 扶摇收盘快照转日线仍由 daily_market_update 使用，不受本迁移影响。

ALTER TABLE market_system_tracking DROP COLUMN realtime;

DROP TABLE market_quote_sample;
DROP TABLE market_quote_latest;
DROP TABLE market_runtime_setting;
