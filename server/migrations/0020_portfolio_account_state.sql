-- 0020_portfolio_account_state.sql：单行资金台账（快照锚点 + 锚点后成交变动）。
-- 业务背景：记录成交此前只更新持仓与事件流，资金摘要停留在最近一次手工快照，导致现金口径失真。
-- 口径约定：
--   1. upsert 资金快照时若 snap_date >= 当前 anchor_date，台账重锚到该快照（券商口径校准）；
--   2. buy/sell 且 change_date > anchor_date：buy 扣减现金（不足抛错回滚），sell 回补现金，
--      全清（卖后数量为 0）时 closed_pnl 累加 数量×(成交价−成本)，与 0010「只统计完全清仓」口径一致；
--   3. change_date <= anchor_date 的成交视为已被快照吸收，不动台账；
--   4. 无快照时无台账行，成交不阻塞，现金口径为未知（tracked=false）；
--   5. 不含手续费建模，漂移由定期快照同步校准。

CREATE TABLE portfolio_account_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  cash numeric NOT NULL,
  closed_pnl numeric NOT NULL DEFAULT 0,
  anchor_date date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE portfolio_account_state IS
  '单行资金台账：cash/closed_pnl 自 anchor_date 快照锚点起由成交事件流连续维护';
COMMENT ON COLUMN portfolio_account_state.anchor_date IS
  '台账锚定的 portfolio_account_snapshot.snap_date；change_date <= anchor_date 的成交不再计入';
