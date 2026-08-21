-- 0039_position_close_pnl.sql：完整累计分批卖出的清仓收益，并禁止零数量当前持仓。
-- 历史零持仓已被资金快照吸收，只清理当前态，不重复追补 closed_pnl，避免双计。

ALTER TABLE portfolio_position
  ADD COLUMN pending_realized_pnl numeric NOT NULL DEFAULT 0;

DELETE FROM portfolio_position WHERE quantity <= 0;

ALTER TABLE portfolio_position
  ADD CONSTRAINT portfolio_position_quantity_positive CHECK (quantity > 0);

COMMENT ON COLUMN portfolio_position.pending_realized_pnl IS
  '当前持仓周期内部分卖出已实现但尚未转入账户 closed_pnl 的累计收益';
