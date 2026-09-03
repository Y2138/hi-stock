-- 0057_每日任务仅工作日执行.sql：保留执行时分，仅将每日交易计划限制为周一至周五。

UPDATE job_definition
   SET cron = regexp_replace(trim(cron), '\s+\S+$', ' 1-5'),
       updated_at = now()
 WHERE code = 'daily_plan_flow'
   AND cron !~ '\s1-5\s*$';
