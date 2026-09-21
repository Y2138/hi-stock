-- 0123_集合竞价提前至九点二十六.sql：工作日集合竞价跨域研判改为 09:26 调度。
UPDATE job_definition
   SET cron = '26 9 * * 1-5',
       updated_at = now()
 WHERE code = 'auction_opportunity_assessment'
   AND cron IS DISTINCT FROM '26 9 * * 1-5';
