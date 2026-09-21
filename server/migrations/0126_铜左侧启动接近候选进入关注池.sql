-- 铜左侧启动评估器与关注池关联：正式信号和仅缺一项的接近候选均维护策略来源。
UPDATE strategy_definition
   SET attention_policy='qualified_and_approaching',runtime_version=runtime_version+1,updated_at=now()
 WHERE code='copper_left_launch';
