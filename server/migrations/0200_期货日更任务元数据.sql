-- 0199已应用；向前补齐新增任务职责与阶段，不改任何既有任务。
UPDATE job_definition SET purpose='同步首批期货目录、日线、主连与仓单，逐品种报告覆盖及缺口', phase='盘后', priority=100
WHERE code='futures_daily_sync';
