-- 启用完整标的与板块目录同步、行业板块成分同步（初始迁移 0023 预置为停用）。
-- market_bar 的 881/884 行业指数日更、board_query 的成分读取与策略条件筛选所需的本地日线，
-- 都依赖这两个任务先行落库；每日新增两次 datasource 同步，扶摇限流内执行。
-- 边界不变：board_membership_sync 只同步行业板块成分；
-- 概念/地域/特色板块成分继续经 hithink board_constituents 临时查询。
UPDATE job_definition
   SET enabled = true, updated_at = now()
 WHERE code IN ('market_catalog_sync', 'board_membership_sync');
