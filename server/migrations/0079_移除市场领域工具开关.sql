-- 本地市场领域只读工具（instrument_search/market_snapshot_query/board_query/market_event_query/indicator_query）
-- 成为 PostgreSQL 事实读取的默认路径，不再由 agent_setting 开关控制；
-- 外部临时研究仍由 hithink_catalog/hithink_query 承担，两者的边界由工具描述与系统提示词分层路由维持。
ALTER TABLE agent_setting DROP COLUMN market_domain_tools_enabled;
