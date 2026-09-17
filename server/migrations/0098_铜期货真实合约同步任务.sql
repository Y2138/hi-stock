-- 0098_铜期货真实合约同步任务.sql：工作日收盘后同步上期所铜真实合约、结算持仓和主力映射。
INSERT INTO job_definition (code, name, cron, job_type, config, enabled) VALUES
  ('commodity_copper_sync', '铜期货真实合约同步', '20 16 * * 1-5', 'datasource',
   '{"pipeline":"commodity_copper_sync","export_volume":false}', true)
ON CONFLICT (code) DO NOTHING;
