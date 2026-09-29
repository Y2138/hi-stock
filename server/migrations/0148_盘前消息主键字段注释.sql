-- 0148_盘前消息主键字段注释.sql：补齐自动主键和创建时间注释。
COMMENT ON COLUMN market_news_snapshot.id IS '消息快照主键。';
COMMENT ON COLUMN market_news_snapshot.created_at IS '消息快照创建时间。';
COMMENT ON COLUMN market_news_item.id IS '消息卡片主键。';
COMMENT ON COLUMN market_news_item.created_at IS '消息卡片创建时间。';
