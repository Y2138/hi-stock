-- 0010_portfolio_account_summary.sql：账户资金快照补充累计清仓收益。
-- 清仓收益只统计已完全清仓标的的累计盈亏，不与未清仓标的的部分已实现盈亏合并。

ALTER TABLE portfolio_account_snapshot
  ADD COLUMN closed_pnl numeric;

COMMENT ON COLUMN portfolio_account_snapshot.closed_pnl IS
  '所有已完全清仓标的的累计盈亏（用户/券商口径）';
