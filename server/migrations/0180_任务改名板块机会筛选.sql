-- 任务展示名简化：夜间板块机会筛选 → 板块机会筛选。
-- 只改展示名，不改调度、提示词正文、阶段、优先级和产出，历史运行记录按 job_id 关联不受影响。
UPDATE job_definition
   SET name = '板块机会筛选', updated_at = now()
 WHERE code = 'nightly_sector_opportunity_scan';

UPDATE job_prompt
   SET name = '板块机会筛选', updated_at = now()
 WHERE code = 'nightly_sector_opportunity_scan';
