-- 0005_domain_table_names.sql（M2 补强）：按领域统一数据表前缀。
-- 只重命名表，不改数据与约束；PostgreSQL 会自动更新外键所引用的目标表。

ALTER TABLE dataset RENAME TO data_dataset;
ALTER INDEX dataset_type_idx RENAME TO data_dataset_type_idx;

ALTER TABLE instrument RENAME TO market_instrument;
ALTER TABLE fetch_run RENAME TO market_fetch_run;

ALTER TABLE position RENAME TO portfolio_position;
ALTER TABLE position_change RENAME TO portfolio_position_change;
ALTER TABLE position_snapshot_daily RENAME TO portfolio_position_snapshot_daily;
ALTER TABLE account_snapshot RENAME TO portfolio_account_snapshot;

ALTER TABLE confirmation RENAME TO agent_confirmation;
ALTER TABLE external_cli_run RENAME TO agent_external_cli_run;
