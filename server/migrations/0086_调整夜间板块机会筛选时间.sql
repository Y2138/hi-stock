-- 将夜间板块机会筛选固定在工作日 23:00 执行。

UPDATE job_definition
   SET cron = '0 23 * * 1-5',
       updated_at = now()
 WHERE code = 'nightly_sector_opportunity_scan';
