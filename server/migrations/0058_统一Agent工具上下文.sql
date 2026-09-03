-- 0058_统一Agent工具上下文.sql：Agent Flow 与普通对话统一使用共享工具目录，退役任务级工具开关。

UPDATE job_definition
   SET config = config - 'pool_attention_write' - 'daily_plan_write',
       updated_at = now()
 WHERE job_type = 'agent_flow'
   AND (config ? 'pool_attention_write' OR config ? 'daily_plan_write');
