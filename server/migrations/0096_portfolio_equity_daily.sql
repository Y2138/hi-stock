-- 0096_portfolio_equity_daily.sql：组合每日净值快照（现金 + 持仓收盘市值）。
-- 业务背景：风控三件套的 20 日峰值回撤熔断需要每日净值序列；现有资金台账只有当前值。
-- 口径约定：
--   1. 净值 = portfolio_account_state.cash + Σ(持仓数量 × 最新收盘)；无行情的持仓按成本价估值（近似）；
--   2. 资金台账缺行（未做过快照锚定）时不写净值快照——现金口径未知，宁缺毋假；
--   3. 主键 snap_date，同日重复生成按 upsert 覆盖；
--   4. 由每日计划上下文生成时物化（plans/risk-gate.ts recordDailyEquity）。

CREATE TABLE portfolio_equity_daily (
  snap_date    date PRIMARY KEY,
  cash         numeric NOT NULL,
  market_value numeric NOT NULL,
  equity       numeric NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE portfolio_equity_daily IS '组合每日净值快照：现金与持仓收盘市值，同日 upsert 幂等';
COMMENT ON COLUMN portfolio_equity_daily.cash IS 'portfolio_account_state.cash 在当日台账口径下的现金';
COMMENT ON COLUMN portfolio_equity_daily.market_value IS '持仓数量×最新收盘（无行情持仓按成本价估值的近似）';

COMMENT ON COLUMN portfolio_equity_daily.snap_date IS '快照交易日（主键，同日 upsert 覆盖）';
COMMENT ON COLUMN portfolio_equity_daily.cash IS 'portfolio_account_state.cash 在当日台账口径下的现金';
COMMENT ON COLUMN portfolio_equity_daily.market_value IS '持仓数量×最新收盘（无行情持仓按成本价估值的近似）';
COMMENT ON COLUMN portfolio_equity_daily.equity IS '当日组合净值 = cash + market_value';
COMMENT ON COLUMN portfolio_equity_daily.updated_at IS '最近一次写入时间';
