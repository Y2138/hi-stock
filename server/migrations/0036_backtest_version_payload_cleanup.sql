-- 0036_backtest_version_payload_cleanup.sql：清理 V2 原始请求快照中的旧系统版本称呼。

UPDATE backtest_run
   SET config_snapshot = replace(config_snapshot::text, 'V26.5', 'V1 基准项目')::jsonb,
       request_json = replace(request_json::text, 'V26.5', 'V1 基准项目')::jsonb
 WHERE name = 'V2 右侧退出'
   AND conclusion_status = 'final';
