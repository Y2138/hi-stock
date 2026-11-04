-- 05 离场与风控：关注池行承接真实成交与持仓期退出状态。
-- 只扩展已有表，不新建持仓/成交流水表；真实成交仍以 portfolio_position_change 为准。

ALTER TABLE ultra_short_watchlist
  ADD COLUMN entry_price          numeric,
  ADD COLUMN position_opened_at   timestamptz,
  ADD COLUMN exit_status          text NOT NULL DEFAULT 'none'
    CHECK (exit_status IN ('none','holding','exit_triggered','closed')),
  ADD COLUMN exit_stage           integer NOT NULL DEFAULT 0,
  ADD COLUMN exit_reason          text,
  ADD COLUMN exit_price           numeric,
  ADD COLUMN exit_at              timestamptz,
  ADD COLUMN realized_r           numeric,
  ADD COLUMN exit_reminder_at     timestamptz,
  ADD COLUMN exit_reminder_type   text;

COMMENT ON COLUMN ultra_short_watchlist.entry_price IS '用户实际买入价；仅买入成交写回';
COMMENT ON COLUMN ultra_short_watchlist.position_opened_at IS '实际买入时间；用于 T+1 时间止损';
COMMENT ON COLUMN ultra_short_watchlist.exit_status IS '退出生命周期：none 未持仓、holding 持有、exit_triggered 已发出退出提醒、closed 已清仓';
COMMENT ON COLUMN ultra_short_watchlist.exit_stage IS '止盈阶段：0 未触发、1 已发第一止盈、2 已发第二止盈';
COMMENT ON COLUMN ultra_short_watchlist.exit_reason IS '最近一次退出原因';
COMMENT ON COLUMN ultra_short_watchlist.exit_price IS '用户实际卖出价；仅清仓成交写回';
COMMENT ON COLUMN ultra_short_watchlist.exit_at IS '实际清仓时间';
COMMENT ON COLUMN ultra_short_watchlist.realized_r IS '按 R 计算的已实现盈亏比';
COMMENT ON COLUMN ultra_short_watchlist.exit_reminder_at IS '最近一次退出提醒时间';
COMMENT ON COLUMN ultra_short_watchlist.exit_reminder_type IS '最近一次退出提醒类型，用于去重';

CREATE INDEX ultra_short_watchlist_exit_idx
  ON ultra_short_watchlist (exit_status, target_date, code)
  WHERE exit_status IN ('holding','exit_triggered');
