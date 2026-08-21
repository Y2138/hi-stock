-- 0037_v1_input_summary_cleanup.sql：清理 V1 输入摘要中的旧系统版本称呼。

UPDATE backtest_run
   SET input_summary = replace(input_summary::text, 'V26.5', 'V1 基准')::jsonb
 WHERE name = 'V1 基准项目'
   AND conclusion_status = 'final';
