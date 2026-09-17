-- 0099_铜库存周报同步任务.sql：每周五收盘后同步上期所铜总库存周报。
INSERT INTO job_definition (code, name, cron, job_type, config, enabled) VALUES
  ('commodity_copper_inventory_sync', '铜库存周报同步', '10 17 * * 5', 'datasource',
   '{"pipeline":"commodity_copper_inventory_sync","export_volume":false}', true)
ON CONFLICT (code) DO NOTHING;
