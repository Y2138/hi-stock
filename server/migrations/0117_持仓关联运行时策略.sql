-- 0117_持仓关联运行时策略.sql：持仓与成交事件固化管理策略、运行版本和兜底出场配置。
-- 兼容期保留 entry_signal_type；存量按确定映射回填，无法确认的 NULL 保持待归因。

-- 打板虽然由每日计划标记为观察，但用户可以自主成交并保留打板归因；其持仓使用显式兜底退出。
UPDATE strategy_definition
   SET strategy_type = 'position',
       allow_new_entry = true,
       fallback_strategy_code = 'portfolio_fallback_exit',
       exit_policy_mode = 'fallback_only',
       updated_at = now()
 WHERE code = 'limit_up';

ALTER TABLE portfolio_position
  ADD COLUMN strategy_code text REFERENCES strategy_definition(code) ON DELETE RESTRICT,
  ADD COLUMN strategy_runtime_version integer CHECK (strategy_runtime_version IS NULL OR strategy_runtime_version > 0),
  ADD COLUMN entry_signal_id bigint REFERENCES strategy_entry_signal(id) ON DELETE SET NULL,
  ADD COLUMN fallback_strategy_code text REFERENCES strategy_definition(code) ON DELETE RESTRICT,
  ADD COLUMN exit_policy_mode text CHECK (exit_policy_mode IS NULL OR exit_policy_mode IN ('dedicated','fallback_only','dedicated_plus_fallback')),
  ADD CONSTRAINT portfolio_position_strategy_fields_check CHECK (
    strategy_code IS NULL
    OR (strategy_runtime_version IS NOT NULL AND exit_policy_mode IS NOT NULL)
  );

ALTER TABLE portfolio_position_change
  ADD COLUMN strategy_code text REFERENCES strategy_definition(code) ON DELETE RESTRICT,
  ADD COLUMN strategy_runtime_version integer CHECK (strategy_runtime_version IS NULL OR strategy_runtime_version > 0),
  ADD COLUMN entry_signal_id bigint REFERENCES strategy_entry_signal(id) ON DELETE SET NULL,
  ADD COLUMN fallback_strategy_code text REFERENCES strategy_definition(code) ON DELETE RESTRICT,
  ADD COLUMN exit_policy_mode text CHECK (exit_policy_mode IS NULL OR exit_policy_mode IN ('dedicated','fallback_only','dedicated_plus_fallback')),
  ADD CONSTRAINT portfolio_position_change_strategy_fields_check CHECK (
    strategy_code IS NULL
    OR (strategy_runtime_version IS NOT NULL AND exit_policy_mode IS NOT NULL)
  ),
  ADD CONSTRAINT portfolio_position_change_entry_signal_check CHECK (
    entry_signal_id IS NULL OR kind = 'buy'
  );

COMMENT ON COLUMN portfolio_position.strategy_code IS '当前持仓唯一管理策略；NULL 表示存量待归因';
COMMENT ON COLUMN portfolio_position.strategy_runtime_version IS '建仓或最后一次确认时固化的策略运行契约版本';
COMMENT ON COLUMN portfolio_position.entry_signal_id IS '首次或当前管理策略对应的结构化入场信号；自主决策可为空';
COMMENT ON COLUMN portfolio_position.fallback_strategy_code IS '建仓时固化的显式兜底出场策略';
COMMENT ON COLUMN portfolio_position.exit_policy_mode IS 'dedicated/fallback_only/dedicated_plus_fallback';
COMMENT ON COLUMN portfolio_position_change.strategy_code IS '成交或修正事件所属策略；卖出与调整继承当前持仓策略';
COMMENT ON COLUMN portfolio_position_change.strategy_runtime_version IS '事件发生时固化的策略运行契约版本';
COMMENT ON COLUMN portfolio_position_change.entry_signal_id IS '买入事件关联的结构化入场信号；仅 buy 可填写';
COMMENT ON COLUMN portfolio_position_change.fallback_strategy_code IS '事件发生时固化的兜底出场策略';
COMMENT ON COLUMN portfolio_position_change.exit_policy_mode IS '事件发生时固化的出场组合模式';

WITH mapped AS (
  SELECT position.instrument_id,
         CASE position.entry_signal_type
           WHEN 'right_side' THEN 'legacy_right_side'
           WHEN 'left_reversal' THEN 'legacy_left_reversal'
           WHEN 'two_year_reversal' THEN 'two_year_reversal'
           WHEN 'trial_start' THEN 'legacy_trial_start'
           WHEN 'swing' THEN 'swing'
           WHEN 'limit_up' THEN 'limit_up'
           WHEN 'discretionary' THEN 'discretionary'
         END AS strategy_code
    FROM portfolio_position position
   WHERE position.entry_signal_type IS NOT NULL
)
UPDATE portfolio_position position
   SET strategy_code = definition.code,
       strategy_runtime_version = definition.runtime_version,
       fallback_strategy_code = definition.fallback_strategy_code,
       exit_policy_mode = definition.exit_policy_mode
  FROM mapped
  JOIN strategy_definition definition ON definition.code = mapped.strategy_code
 WHERE position.instrument_id = mapped.instrument_id;

WITH mapped AS (
  SELECT change.id,
         CASE change.entry_signal_type
           WHEN 'right_side' THEN 'legacy_right_side'
           WHEN 'left_reversal' THEN 'legacy_left_reversal'
           WHEN 'two_year_reversal' THEN 'two_year_reversal'
           WHEN 'trial_start' THEN 'legacy_trial_start'
           WHEN 'swing' THEN 'swing'
           WHEN 'limit_up' THEN 'limit_up'
           WHEN 'discretionary' THEN 'discretionary'
         END AS strategy_code
    FROM portfolio_position_change change
   WHERE change.kind = 'buy' AND change.entry_signal_type IS NOT NULL
)
UPDATE portfolio_position_change change
   SET strategy_code = definition.code,
       strategy_runtime_version = definition.runtime_version,
       fallback_strategy_code = definition.fallback_strategy_code,
       exit_policy_mode = definition.exit_policy_mode
  FROM mapped
  JOIN strategy_definition definition ON definition.code = mapped.strategy_code
 WHERE change.id = mapped.id;

CREATE INDEX portfolio_position_strategy_idx ON portfolio_position (strategy_code) WHERE quantity > 0;
CREATE INDEX portfolio_position_change_runtime_strategy_idx
  ON portfolio_position_change (strategy_code, change_date DESC, id DESC)
  WHERE strategy_code IS NOT NULL;
