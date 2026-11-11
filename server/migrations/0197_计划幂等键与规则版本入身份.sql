-- 0197_计划幂等键与规则版本入身份.sql
-- 边界 1 补口（PM 复核第 3 轮）：
--   1) 观察计划缺请求幂等键，重试会重复建计划；
--   2) 事件身份没带规则版本，规则换了仍续写成同一事件，无法证明"规则变更算新机会"。
-- 只加列、加索引、换唯一索引；不改 0195/0196 已应用的约束语义。

-- 1) 计划请求幂等：同事件同请求键只落一份计划，重试返回同一行。
ALTER TABLE observation_plan ADD COLUMN request_key text;
COMMENT ON COLUMN observation_plan.request_key IS '计划创建请求幂等键；重试复用同一计划，不新建修订';
CREATE UNIQUE INDEX observation_plan_request_uk ON observation_plan (event_id, request_key)
  WHERE request_key IS NOT NULL;

-- 2) 事件身份改为「同来源 + 同标的 + 同规则版本 + 同范围 + 同账户」，
--    不再把条件指纹放进唯一键：条件演化（例如某条条件由真变假）只更新证据与指纹，
--    不自动新开机会；新机会必须先结束旧事件并显式给出复位证明。
DROP INDEX strategy_signal_event_active_uidx;
CREATE UNIQUE INDEX strategy_signal_event_active_uidx
  ON strategy_signal_event (
    source_kind,
    COALESCE(strategy_code, producer_code),
    instrument_id,
    COALESCE(rule_hash, ''),
    scope,
    COALESCE(account_id, 0)
  )
  WHERE status IN ('observing', 'pending', 'triggered');
COMMENT ON INDEX strategy_signal_event_active_uidx IS '同来源类型 + 同来源编码 + 同标的 + 同规则版本 + 同范围 + 同账户只允许一个存续事件；条件指纹只作属性更新';
