-- 降低盘中常驻 worker 的模型调用频率：优先用时间间隔控制 token，而不是裁剪盘面上下文。
-- 普通持仓观察 30 秒 → 60 秒；超短未持仓观察 30 秒 → 120 秒；超短离场快速层为确定性检查，仍保持 5 秒。
UPDATE job_definition
   SET config = jsonb_set(config, '{interval_seconds}', '60'::jsonb), updated_at = now()
 WHERE code = 'position_intraday_watch';

UPDATE job_definition
   SET config = jsonb_set(config, '{interval_seconds}', '120'::jsonb), updated_at = now()
 WHERE code = 'ultra_short_watch_observe';
