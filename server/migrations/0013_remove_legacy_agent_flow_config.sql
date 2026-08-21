-- 0013_remove_legacy_agent_flow_config.sql：清除 Agent Flow 的一期文件/台账关联配置。
-- 新 Runner 只固化数据库提示词版本并写 job_run，不再创建一期 task_run。

UPDATE job_definition
   SET config = config - 'template_path' - 'task_code', updated_at = now()
 WHERE job_type = 'agent_flow'
   AND (config ? 'template_path' OR config ? 'task_code');
