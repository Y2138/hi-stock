-- 用户要求停止铜左侧策略的每日定时执行；只关闭该定时任务，策略本身保留，仍可手工临时运行。
UPDATE job_definition
   SET enabled = false,
       purpose = CASE
         WHEN purpose LIKE '%用户要求停止每日执行%' THEN purpose
         ELSE COALESCE(purpose, '铜左侧启动信号扫描') || '；用户要求停止每日执行（仅关闭定时任务，策略保留，可手工临时运行）'
       END,
       updated_at = now()
 WHERE code = 'copper_left_launch_signal_scan';
