-- 止损由每日评估按届时策略、股性、行情、指标和持仓成本计算，不属于标的池成员属性。
ALTER TABLE pool_membership DROP COLUMN stop_loss_mode;
