-- 只向前放宽存量无策略关联的历史买入预案；新策略预案仍不能新增 buy 动作。
ALTER TABLE daily_plan_playbook DROP CONSTRAINT daily_plan_playbook_check;
ALTER TABLE daily_plan_playbook ADD CONSTRAINT daily_plan_playbook_effective_action_check
  CHECK (effective_action IS NULL OR effective_action IN ('hold','observe','reduce','exit')
    OR (effective_action='buy' AND strategy_code IS NULL));
COMMENT ON COLUMN daily_plan_playbook.effective_action IS
  '服务端按固定优先级合并后的最终动作；无策略关联的历史买入原样保留';
