-- 0116_策略运行时基础模型.sql：建立策略定义、任务角色和可复用评估运行的基础事实。
-- 本迁移只建立关联与只读事实，不切换现有信号工具、持仓、关注池或每日计划行为。

CREATE TABLE strategy_definition (
  code                     text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{0,95}$'),
  name                     text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  strategy_type            text NOT NULL CHECK (strategy_type IN ('position','attention','observation','fallback_exit','portfolio_overlay')),
  strategy_document_code   text NOT NULL REFERENCES strategy_document(code) ON DELETE RESTRICT,
  status                   text NOT NULL CHECK (status IN ('active','exit_only','paused','retired')),
  allow_new_entry          boolean NOT NULL DEFAULT false,
  entry_evaluator_code     text CHECK (entry_evaluator_code IS NULL OR entry_evaluator_code ~ '^[a-z][a-z0-9_]{0,95}$'),
  exit_evaluator_code      text CHECK (exit_evaluator_code IS NULL OR exit_evaluator_code ~ '^[a-z][a-z0-9_]{0,95}$'),
  context_evaluator_code   text CHECK (context_evaluator_code IS NULL OR context_evaluator_code ~ '^[a-z][a-z0-9_]{0,95}$'),
  fallback_strategy_code   text REFERENCES strategy_definition(code) ON DELETE RESTRICT,
  exit_policy_mode         text NOT NULL DEFAULT 'none' CHECK (exit_policy_mode IN ('none','dedicated','fallback_only','dedicated_plus_fallback')),
  daily_plan_scope         text[] NOT NULL DEFAULT '{}'::text[] CHECK (daily_plan_scope <@ ARRAY['entry','exit','attention','observe','context']::text[]),
  attention_policy         text NOT NULL DEFAULT 'none' CHECK (attention_policy IN ('none','qualified_only','qualified_and_approaching','manual_review')),
  runtime_version          integer NOT NULL DEFAULT 1 CHECK (runtime_version > 0),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT strategy_definition_self_fallback_check CHECK (fallback_strategy_code IS NULL OR fallback_strategy_code <> code),
  CONSTRAINT strategy_definition_entry_check CHECK (
    NOT allow_new_entry OR (status = 'active' AND entry_evaluator_code IS NOT NULL)
  ),
  CONSTRAINT strategy_definition_scope_check CHECK (
    (NOT ('entry' = ANY(daily_plan_scope)) OR entry_evaluator_code IS NOT NULL)
    AND (NOT ('attention' = ANY(daily_plan_scope)) OR entry_evaluator_code IS NOT NULL)
    AND (NOT ('observe' = ANY(daily_plan_scope)) OR entry_evaluator_code IS NOT NULL)
    AND (NOT ('context' = ANY(daily_plan_scope)) OR context_evaluator_code IS NOT NULL)
  ),
  CONSTRAINT strategy_definition_type_check CHECK (
    (strategy_type = 'position' AND (
      (exit_policy_mode = 'dedicated' AND exit_evaluator_code IS NOT NULL AND fallback_strategy_code IS NULL)
      OR (exit_policy_mode = 'fallback_only' AND exit_evaluator_code IS NULL AND fallback_strategy_code IS NOT NULL)
      OR (exit_policy_mode = 'dedicated_plus_fallback' AND exit_evaluator_code IS NOT NULL AND fallback_strategy_code IS NOT NULL)
    ))
    OR (strategy_type = 'fallback_exit' AND allow_new_entry = false AND entry_evaluator_code IS NULL
        AND exit_evaluator_code IS NOT NULL AND fallback_strategy_code IS NULL AND exit_policy_mode = 'none')
    OR (strategy_type = 'portfolio_overlay' AND allow_new_entry = false AND context_evaluator_code IS NOT NULL
        AND exit_evaluator_code IS NULL AND fallback_strategy_code IS NULL AND exit_policy_mode = 'none')
    OR (strategy_type IN ('attention','observation') AND allow_new_entry = false AND entry_evaluator_code IS NOT NULL
        AND exit_evaluator_code IS NULL AND fallback_strategy_code IS NULL AND exit_policy_mode = 'none')
  ),
  CONSTRAINT strategy_definition_exit_only_check CHECK (
    status <> 'exit_only' OR strategy_type = 'position'
  )
);

COMMENT ON TABLE strategy_definition IS '策略运行时定义：关联当前策略文档、受控评估器、关注规则、兜底策略与每日计划范围';
COMMENT ON COLUMN strategy_definition.code IS '稳定策略编码，也是持仓、关注、任务和评估运行的关联键';
COMMENT ON COLUMN strategy_definition.strategy_type IS 'position=持仓策略，attention=关注策略，observation=观察策略，fallback_exit=兜底出场，portfolio_overlay=组合叠加';
COMMENT ON COLUMN strategy_definition.strategy_document_code IS '当前最终策略文档编码；策略正文仍只存 strategy_document';
COMMENT ON COLUMN strategy_definition.status IS 'active=可正常运行，exit_only=只管理存量退出，paused=暂停，retired=退役';
COMMENT ON COLUMN strategy_definition.allow_new_entry IS '是否允许产生新开仓归属；旧信号和观察策略固定为 false';
COMMENT ON COLUMN strategy_definition.entry_evaluator_code IS '代码注册表中的入场或关注评估器编码，不是模块路径';
COMMENT ON COLUMN strategy_definition.exit_evaluator_code IS '代码注册表中的专属出场评估器编码';
COMMENT ON COLUMN strategy_definition.context_evaluator_code IS '代码注册表中的组合上下文评估器编码';
COMMENT ON COLUMN strategy_definition.fallback_strategy_code IS '显式兜底出场策略；不得形成自引用或多层兜底';
COMMENT ON COLUMN strategy_definition.exit_policy_mode IS 'none/dedicated/fallback_only/dedicated_plus_fallback';
COMMENT ON COLUMN strategy_definition.daily_plan_scope IS '每日计划自动发现范围：entry/exit/attention/observe/context';
COMMENT ON COLUMN strategy_definition.attention_policy IS '入场结果到关注池的投影规则';
COMMENT ON COLUMN strategy_definition.runtime_version IS '策略运行契约版本；不等同于历史策略正文版本';

-- 先建立不被其他策略引用的兜底策略，再建立普通策略。
INSERT INTO strategy_definition
  (code, name, strategy_type, strategy_document_code, status, allow_new_entry,
   exit_evaluator_code, exit_policy_mode, daily_plan_scope, attention_policy)
VALUES
  ('portfolio_fallback_exit', '组合兜底出场', 'fallback_exit', 'daily_plan_strategy', 'active', false,
   'fallback_exit_v1', 'none', ARRAY['exit'], 'none');

INSERT INTO strategy_definition
  (code, name, strategy_type, strategy_document_code, status, allow_new_entry,
   entry_evaluator_code, exit_evaluator_code, context_evaluator_code,
   fallback_strategy_code, exit_policy_mode, daily_plan_scope, attention_policy)
VALUES
  ('swing', '波段策略', 'position', 'daily_plan_strategy', 'active', true,
   'swing_entry_v1', 'swing_exit_v1', NULL,
   NULL, 'dedicated', ARRAY['entry','exit','attention'], 'qualified_and_approaching'),
  ('two_year_reversal', '两年结构反转策略', 'position', 'two_year_reversal_strategy', 'active', true,
   'two_year_reversal_entry_v1', 'two_year_reversal_exit_v1', NULL,
   NULL, 'dedicated', ARRAY['entry','exit','attention'], 'qualified_and_approaching'),
  ('legacy_right_side', '旧右侧主升策略', 'position', 'daily_plan_strategy', 'exit_only', false,
   NULL, 'legacy_right_side_exit_v1', NULL,
   'portfolio_fallback_exit', 'dedicated_plus_fallback', ARRAY['exit'], 'none'),
  ('legacy_trial_start', '旧试盘启动策略', 'position', 'daily_plan_strategy', 'exit_only', false,
   NULL, NULL, NULL,
   'portfolio_fallback_exit', 'fallback_only', ARRAY['exit'], 'none'),
  ('legacy_left_reversal', '旧左侧反转策略', 'position', 'daily_plan_strategy', 'exit_only', false,
   NULL, 'legacy_left_reversal_exit_v1', NULL,
   NULL, 'dedicated', ARRAY['exit'], 'none'),
  ('discretionary', '自主决策策略', 'position', 'daily_plan_strategy', 'active', true,
   'manual_entry_v1', NULL, NULL,
   'portfolio_fallback_exit', 'fallback_only', ARRAY['exit'], 'manual_review'),
  ('limit_up', '打板观察策略', 'observation', 'limit_up_board', 'active', false,
   'limit_up_observation_v1', NULL, NULL,
   NULL, 'none', ARRAY['observe'], 'none'),
  ('nightly_sector', '夜间板块关注策略', 'attention', 'nightly_sector_strategy', 'active', false,
   'nightly_sector_attention_v1', NULL, NULL,
   NULL, 'none', '{}'::text[], 'qualified_and_approaching'),
  ('value_anchor', '价值错杀关注策略', 'attention', 'value_anchor_strategy', 'active', false,
   'value_anchor_entry_v1', NULL, NULL,
   NULL, 'none', '{}'::text[], 'qualified_and_approaching'),
  ('copper_inventory', '铜库存防守策略', 'portfolio_overlay', 'copper_inventory_strategy', 'active', false,
   NULL, NULL, 'copper_inventory_context_v1',
   NULL, 'none', ARRAY['context'], 'none'),
  ('lithium_warehouse', '碳酸锂低暴露策略', 'portfolio_overlay', 'lithium_warehouse_strategy', 'active', false,
   NULL, NULL, 'lithium_warehouse_context_v1',
   NULL, 'none', ARRAY['context'], 'none');

ALTER TABLE job_definition
  ADD COLUMN strategy_code text REFERENCES strategy_definition(code) ON DELETE RESTRICT,
  ADD COLUMN agent_role text CHECK (agent_role IS NULL OR agent_role IN (
    'strategy_entry_report','strategy_exit_report','strategy_confirmation',
    'portfolio_aggregator','data_pipeline','research_report'
  ));

ALTER TABLE job_definition
  ADD CONSTRAINT job_definition_strategy_role_check CHECK (
    (agent_role IS NULL AND strategy_code IS NULL)
    OR (agent_role = 'portfolio_aggregator' AND strategy_code IS NULL)
    OR (agent_role IN ('strategy_entry_report','strategy_exit_report','strategy_confirmation') AND strategy_code IS NOT NULL)
    OR (agent_role IN ('data_pipeline','research_report'))
  );

CREATE UNIQUE INDEX job_definition_enabled_strategy_role_unique
  ON job_definition (strategy_code, agent_role)
  WHERE enabled AND strategy_code IS NOT NULL AND agent_role IS NOT NULL;

COMMENT ON COLUMN job_definition.strategy_code IS '普通策略任务至多关联一个策略；组合聚合、数据和无策略研究任务为空';
COMMENT ON COLUMN job_definition.agent_role IS '任务在策略运行时中的角色；每日计划为 portfolio_aggregator';

UPDATE job_definition SET agent_role = 'data_pipeline'
 WHERE code IN (
  'market_catalog_sync','board_membership_sync','weekly_full_market_indicators',
  'daily_data_update','daily_market_structure','value_candidate_sync','value_monthly_rank',
  'commodity_copper_sync','commodity_copper_inventory_sync','commodity_lithium_warehouse_sync'
 );
UPDATE job_definition SET agent_role = 'portfolio_aggregator'
 WHERE code = 'daily_plan_flow';
UPDATE job_definition SET strategy_code = 'nightly_sector', agent_role = 'strategy_entry_report'
 WHERE code = 'nightly_sector_opportunity_scan';
UPDATE job_definition SET strategy_code = 'value_anchor', agent_role = 'strategy_entry_report'
 WHERE code = 'value_anchor_opportunity_scan';
UPDATE job_definition SET strategy_code = 'two_year_reversal', agent_role = 'strategy_entry_report'
 WHERE code = 'two_year_reversal_scan';
UPDATE job_definition SET strategy_code = 'limit_up', agent_role = 'strategy_confirmation'
 WHERE code = 'auction_opportunity_assessment';
UPDATE job_definition SET strategy_code = 'copper_inventory', agent_role = 'strategy_exit_report'
 WHERE code = 'copper_inventory_signal_review';
UPDATE job_definition SET strategy_code = 'lithium_warehouse', agent_role = 'strategy_exit_report'
 WHERE code = 'lithium_warehouse_signal_review';

CREATE TABLE strategy_evaluation_run (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  strategy_code            text NOT NULL REFERENCES strategy_definition(code) ON DELETE RESTRICT,
  phase                    text NOT NULL CHECK (phase IN ('entry','exit','context')),
  target_date              date NOT NULL,
  data_date                date,
  evaluator_code           text NOT NULL CHECK (evaluator_code ~ '^[a-z][a-z0-9_]{0,95}$'),
  evaluator_version        integer NOT NULL CHECK (evaluator_version > 0),
  strategy_runtime_version integer NOT NULL CHECK (strategy_runtime_version > 0),
  strategy_snapshot_hash   text NOT NULL CHECK (strategy_snapshot_hash ~ '^[0-9a-f]{64}$'),
  input_fingerprint        text NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  status                   text NOT NULL CHECK (status IN ('queued','running','success','partial','failed')),
  requested_by_job_run_id  bigint REFERENCES job_run(id) ON DELETE SET NULL,
  reused_from_run_id       bigint REFERENCES strategy_evaluation_run(id) ON DELETE SET NULL,
  coverage                 jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(coverage) = 'object'),
  gaps                     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(gaps) = 'array'),
  started_at               timestamptz,
  finished_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT strategy_evaluation_run_time_check CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),
  UNIQUE (strategy_code, phase, target_date, evaluator_code, evaluator_version, input_fingerprint),
  UNIQUE (id, strategy_code)
);

CREATE INDEX strategy_evaluation_run_lookup_idx
  ON strategy_evaluation_run (strategy_code, phase, target_date DESC, created_at DESC);

COMMENT ON TABLE strategy_evaluation_run IS '策略评估运行：每日计划、专项任务和交互查询复用的结构化执行事实';
COMMENT ON COLUMN strategy_evaluation_run.input_fingerprint IS '影响结论的策略、评估器、数据和持仓事实摘要哈希';
COMMENT ON COLUMN strategy_evaluation_run.reused_from_run_id IS '复用来源；同一有效身份不会并发重复执行';

CREATE TABLE strategy_entry_signal (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id              bigint NOT NULL,
  strategy_code       text NOT NULL REFERENCES strategy_definition(code) ON DELETE RESTRICT,
  instrument_id       bigint NOT NULL REFERENCES market_instrument(id) ON DELETE RESTRICT,
  signal_status       text NOT NULL CHECK (signal_status IN ('qualified','approaching')),
  trigger_kind        text,
  trigger_price_lower numeric,
  trigger_price_upper numeric,
  invalidation        text,
  reason              text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  evidence            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  missing_signals     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(missing_signals) = 'array'),
  valid_from          date NOT NULL,
  valid_until         date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT strategy_entry_signal_run_fk FOREIGN KEY (run_id, strategy_code)
    REFERENCES strategy_evaluation_run(id, strategy_code) ON DELETE CASCADE,
  CONSTRAINT strategy_entry_signal_price_check CHECK (
    trigger_price_lower IS NULL OR trigger_price_upper IS NULL OR trigger_price_lower <= trigger_price_upper
  ),
  CONSTRAINT strategy_entry_signal_date_check CHECK (valid_until IS NULL OR valid_until >= valid_from),
  CONSTRAINT strategy_entry_signal_missing_check CHECK (
    (signal_status = 'qualified' AND missing_signals = '[]'::jsonb)
    OR (signal_status = 'approaching' AND missing_signals <> '[]'::jsonb)
  ),
  UNIQUE (run_id, instrument_id)
);

CREATE INDEX strategy_entry_signal_strategy_date_idx
  ON strategy_entry_signal (strategy_code, valid_from DESC, instrument_id);

COMMENT ON TABLE strategy_entry_signal IS '策略入场或接近信号；普通筛除项只保留运行级汇总';

CREATE TABLE strategy_position_evaluation (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id              bigint NOT NULL,
  strategy_code       text NOT NULL REFERENCES strategy_definition(code) ON DELETE RESTRICT,
  instrument_id       bigint NOT NULL REFERENCES market_instrument(id) ON DELETE RESTRICT,
  position_opened_at  date,
  evaluation_role     text NOT NULL CHECK (evaluation_role IN ('primary','fallback')),
  action              text NOT NULL CHECK (action IN ('hold','observe','reduce','exit')),
  trigger_kind        text,
  trigger_price_lower numeric,
  trigger_price_upper numeric,
  protection_price    numeric,
  reason              text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  evidence            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  missing_items       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(missing_items) = 'array'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT strategy_position_evaluation_run_fk FOREIGN KEY (run_id, strategy_code)
    REFERENCES strategy_evaluation_run(id, strategy_code) ON DELETE CASCADE,
  CONSTRAINT strategy_position_evaluation_price_check CHECK (
    trigger_price_lower IS NULL OR trigger_price_upper IS NULL OR trigger_price_lower <= trigger_price_upper
  ),
  UNIQUE (run_id, instrument_id, evaluation_role)
);

CREATE INDEX strategy_position_evaluation_strategy_idx
  ON strategy_position_evaluation (strategy_code, instrument_id, created_at DESC);

COMMENT ON TABLE strategy_position_evaluation IS '策略对当前持仓的主评估或兜底评估结构化动作';

COMMENT ON COLUMN strategy_definition.name IS '策略显示名称';
COMMENT ON COLUMN strategy_definition.context_evaluator_code IS '代码注册表中的组合上下文评估器编码';
COMMENT ON COLUMN strategy_definition.created_at IS '策略运行时定义创建时间';
COMMENT ON COLUMN strategy_definition.updated_at IS '策略运行时定义更新时间';

COMMENT ON COLUMN strategy_evaluation_run.id IS '策略评估运行主键';
COMMENT ON COLUMN strategy_evaluation_run.strategy_code IS '本次运行对应的策略编码';
COMMENT ON COLUMN strategy_evaluation_run.phase IS '评估阶段：entry/exit/context';
COMMENT ON COLUMN strategy_evaluation_run.target_date IS '业务目标日';
COMMENT ON COLUMN strategy_evaluation_run.data_date IS '实际使用的最新数据日';
COMMENT ON COLUMN strategy_evaluation_run.evaluator_code IS '代码注册表中的评估器编码';
COMMENT ON COLUMN strategy_evaluation_run.evaluator_version IS '评估器实现版本';
COMMENT ON COLUMN strategy_evaluation_run.strategy_runtime_version IS '本次执行锁定的策略运行版本';
COMMENT ON COLUMN strategy_evaluation_run.strategy_snapshot_hash IS '本次执行锁定的当前策略清单哈希';
COMMENT ON COLUMN strategy_evaluation_run.status IS 'queued/running/success/partial/failed';
COMMENT ON COLUMN strategy_evaluation_run.requested_by_job_run_id IS '首次请求该评估的任务运行';
COMMENT ON COLUMN strategy_evaluation_run.coverage IS '本次评估覆盖计数与范围摘要';
COMMENT ON COLUMN strategy_evaluation_run.gaps IS '本次评估的数据与执行缺口';
COMMENT ON COLUMN strategy_evaluation_run.started_at IS '实际开始执行时间';
COMMENT ON COLUMN strategy_evaluation_run.finished_at IS '执行结束时间';
COMMENT ON COLUMN strategy_evaluation_run.created_at IS '评估运行创建时间';

COMMENT ON COLUMN strategy_entry_signal.id IS '结构化入场信号主键';
COMMENT ON COLUMN strategy_entry_signal.run_id IS '产生该信号的策略评估运行';
COMMENT ON COLUMN strategy_entry_signal.strategy_code IS '信号所属策略编码';
COMMENT ON COLUMN strategy_entry_signal.instrument_id IS '信号标的';
COMMENT ON COLUMN strategy_entry_signal.signal_status IS 'qualified=正式信号，approaching=接近候选';
COMMENT ON COLUMN strategy_entry_signal.trigger_kind IS '价格、开盘、盘中、时间或其他受控触发类型';
COMMENT ON COLUMN strategy_entry_signal.trigger_price_lower IS '触发价格下界';
COMMENT ON COLUMN strategy_entry_signal.trigger_price_upper IS '触发价格上界';
COMMENT ON COLUMN strategy_entry_signal.invalidation IS '可观测失效条件';
COMMENT ON COLUMN strategy_entry_signal.reason IS '信号成立或接近的紧凑原因';
COMMENT ON COLUMN strategy_entry_signal.evidence IS '策略专属必要数值证据';
COMMENT ON COLUMN strategy_entry_signal.missing_signals IS '接近候选尚缺条件';
COMMENT ON COLUMN strategy_entry_signal.valid_from IS '信号生效开始日期';
COMMENT ON COLUMN strategy_entry_signal.valid_until IS '信号失效日期；为空表示由策略规则决定';
COMMENT ON COLUMN strategy_entry_signal.created_at IS '结构化信号创建时间';

COMMENT ON COLUMN strategy_position_evaluation.id IS '结构化持仓评估主键';
COMMENT ON COLUMN strategy_position_evaluation.run_id IS '产生该动作的策略评估运行';
COMMENT ON COLUMN strategy_position_evaluation.strategy_code IS '评估使用的主策略或兜底策略编码';
COMMENT ON COLUMN strategy_position_evaluation.instrument_id IS '被评估的持仓标的';
COMMENT ON COLUMN strategy_position_evaluation.position_opened_at IS '本次评估对应的当前持仓周期开始日';
COMMENT ON COLUMN strategy_position_evaluation.evaluation_role IS 'primary=主策略，fallback=兜底策略';
COMMENT ON COLUMN strategy_position_evaluation.action IS 'hold/observe/reduce/exit';
COMMENT ON COLUMN strategy_position_evaluation.trigger_kind IS '价格、开盘、盘中、时间或其他受控触发类型';
COMMENT ON COLUMN strategy_position_evaluation.trigger_price_lower IS '动作触发价格下界';
COMMENT ON COLUMN strategy_position_evaluation.trigger_price_upper IS '动作触发价格上界';
COMMENT ON COLUMN strategy_position_evaluation.protection_price IS '下一交易日生效的保护位';
COMMENT ON COLUMN strategy_position_evaluation.reason IS '动作与触发条件的紧凑原因';
COMMENT ON COLUMN strategy_position_evaluation.evidence IS '策略专属必要数值证据';
COMMENT ON COLUMN strategy_position_evaluation.missing_items IS '尚未覆盖的数据或执行事实';
COMMENT ON COLUMN strategy_position_evaluation.created_at IS '持仓评估结果创建时间';
