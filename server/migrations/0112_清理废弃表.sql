-- 0112_清理废弃表.sql：删除已由新领域表替代、当前没有业务读写路径的历史表。
--
-- 注意：本迁移只做结构清理，不删除关注池业务数据。关注池同时承接系统信号与用户自选观察，
-- 没有近期关注条目的成员同样可能是用户自选或待观察标的，不能按“有无关注条目”批量删除。

-- 1) 移除一期任务和旧内容库兼容字段。
ALTER TABLE job_run DROP COLUMN task_run_id;
ALTER TABLE job_run_output DROP COLUMN legacy_content_document_id;

-- 2) 删除冻结的旧内容库及迁移对账表。
ALTER TABLE content_document DROP CONSTRAINT content_document_current_revision_fk;
DROP TABLE content_legacy_import;
DROP TABLE content_revision;
DROP TABLE content_document;

-- 3) 删除旧策略库和旧脚本库。
DROP TABLE script_version;
DROP TABLE script_registry;
DROP TABLE strategy_version;
DROP TABLE strategy_doc;

-- 4) 删除一期任务表。
DROP TABLE task_run;
DROP TABLE task_definition;

-- 5) 删除已经退役且无运行时读写路径的数据表。
DROP TABLE portfolio_position_snapshot_daily;
DROP TABLE portfolio_account_snapshot;
DROP TABLE market_system_tracking;
DROP TABLE agent_evaluation_run;
DROP TABLE agent_external_cli_run;
