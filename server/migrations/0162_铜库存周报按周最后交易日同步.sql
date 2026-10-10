-- 铜库存周报仍在周五执行，但查询该周最后一个交易日；周五休市时自动回退到周四等实际报告日。
UPDATE job_definition
   SET trading_day_only=false,
       purpose='每周五按本周最后一个交易日同步上期所铜总库存周报并保留官方发布时间；周五休市时自动使用本周更早的最后交易日。',
       updated_at=now()
 WHERE code='commodity_copper_inventory_sync';
