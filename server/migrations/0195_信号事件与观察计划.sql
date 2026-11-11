-- 0195_信号事件与观察计划.sql
-- 边界 1：策略产物（信号事件、观察计划、结果评估）与通用运行时之间的契约。
-- 口径：specs/策略产物契约与影子接入/实施契约.md（PM 定稿）；存储落位见第 2/3/7 节。
-- 只新增表；不回填历史 908 条信号，历史保持原样只做只读映射对照。

-- 1) 独立信号事件：五态 observing/pending/triggered/invalidated/expired；触发不等于成交。
CREATE TABLE strategy_signal_event (
  id bigserial PRIMARY KEY,
  contract_version integer NOT NULL DEFAULT 1 CHECK (contract_version >= 1),
  source_kind text NOT NULL CHECK (source_kind IN ('strategy', 'manual')),
  source_ref text,
  scope text NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'account', 'shared')),
  strategy_code text,
  instrument_id bigint NOT NULL REFERENCES market_instrument(id),
  condition_hash text NOT NULL CHECK (condition_hash ~ '^[a-f0-9]{64}$'),
  trigger_kind text NOT NULL,
  signal_status text NOT NULL CHECK (signal_status IN ('qualified', 'approaching')),
  status text NOT NULL CHECK (status IN ('observing', 'pending', 'triggered', 'invalidated', 'expired')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  first_emitted_at timestamptz,
  triggered_at timestamptz,
  valid_from date NOT NULL,
  valid_until date,
  signal_low numeric,
  signal_low_raw numeric,
  initial_stop numeric,
  confirmation_must_exceed numeric,
  confirmation_price_cap numeric,
  invalidation numeric,
  risk_source text NOT NULL DEFAULT 'none' CHECK (risk_source IN ('evaluator', 'manual', 'none')),
  producer_code text NOT NULL,
  producer_version integer NOT NULL,
  data_as_of date,
  available_at timestamptz,
  input_fingerprint text,
  rule_hash text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  run_id bigint REFERENCES strategy_evaluation_run(id) ON DELETE SET NULL,
  plan_id bigint,
  current_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_kind = 'strategy' AND strategy_code IS NOT NULL) OR source_kind = 'manual')
);
-- 同来源（策略编码或手工生产者）+ 同标的 + 同触发条件 + 同范围只允许一个存续事件。
CREATE UNIQUE INDEX strategy_signal_event_active_uidx
  ON strategy_signal_event (COALESCE(strategy_code, producer_code), instrument_id, condition_hash, scope)
  WHERE status IN ('observing', 'pending', 'triggered');
CREATE INDEX strategy_signal_event_instrument_idx ON strategy_signal_event (instrument_id, first_seen_at DESC);
CREATE INDEX strategy_signal_event_status_idx ON strategy_signal_event (status, last_seen_at DESC);
COMMENT ON TABLE strategy_signal_event IS '独立信号事件五态：observing/pending/triggered/invalidated/expired；triggered 不是成交';
COMMENT ON COLUMN strategy_signal_event.condition_hash IS '触发条件指纹；不含价格与当日证据，避免每天新开事件';
COMMENT ON COLUMN strategy_signal_event.initial_stop IS '波段初始风险线，来自其 evidence.initial_stop，不重算固定百分比';
COMMENT ON COLUMN strategy_signal_event.confirmation_must_exceed IS '波段 T+1 确认突破价，不是生成时已触发';
COMMENT ON COLUMN strategy_signal_event.confirmation_price_cap IS '波段追高上限，超过即不满足原执行窗口，不是止损位';
COMMENT ON COLUMN strategy_signal_event.signal_low IS '两年反转事件低点（复权价基）';
COMMENT ON COLUMN strategy_signal_event.signal_low_raw IS '两年反转事件低点（原始价基），不与复权价混用';
COMMENT ON COLUMN strategy_signal_event.first_emitted_at IS '首次对外发出时间；连续命中不重写';
COMMENT ON COLUMN strategy_signal_event.triggered_at IS '首次满足触发规则的时间；后续 invalidated 不清除';

-- 2) 状态变化追加记录：每次转移写一条，不覆盖历史。
CREATE TABLE strategy_signal_event_transition (
  id bigserial PRIMARY KEY,
  event_id bigint NOT NULL REFERENCES strategy_signal_event(id) ON DELETE CASCADE,
  from_status text CHECK (from_status IS NULL OR from_status IN ('observing', 'pending', 'triggered', 'invalidated', 'expired')),
  to_status text NOT NULL CHECK (to_status IN ('observing', 'pending', 'triggered', 'invalidated', 'expired')),
  reason text,
  fact_at timestamptz NOT NULL,
  actor text,
  run_id bigint REFERENCES strategy_evaluation_run(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, idempotency_key)
);
CREATE INDEX strategy_signal_event_transition_event_idx ON strategy_signal_event_transition (event_id, fact_at);
COMMENT ON TABLE strategy_signal_event_transition IS '事件状态转移追加记录；暂停属于计划层、缺数属于健康层，不新增第六个机会状态';

-- 3) 观察计划：lifecycle_status 只描述计划管理状态；actionable 表示是否可执行。
CREATE TABLE observation_plan (
  id bigserial PRIMARY KEY,
  contract_version integer NOT NULL DEFAULT 1 CHECK (contract_version >= 1),
  event_id bigint NOT NULL REFERENCES strategy_signal_event(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  source_kind text NOT NULL CHECK (source_kind IN ('strategy', 'manual')),
  source_ref text,
  scope text NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'account', 'shared')),
  strategy_code text,
  lifecycle_status text NOT NULL CHECK (lifecycle_status IN ('draft', 'published', 'paused', 'ended')),
  actionable boolean NOT NULL DEFAULT false,
  producer_code text NOT NULL,
  producer_version integer NOT NULL,
  trigger jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk jsonb NOT NULL DEFAULT '{}'::jsonb,
  observation_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  evaluation_policy jsonb,
  execution_mode text NOT NULL DEFAULT 'shadow' CHECK (execution_mode = 'shadow'),
  price_levels jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_as_of date,
  available_at timestamptz,
  generated_at timestamptz NOT NULL DEFAULT now(),
  input_fingerprint text,
  rule_hash text,
  gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
  effective_from date,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, revision)
);
CREATE INDEX observation_plan_lifecycle_idx ON observation_plan (lifecycle_status, generated_at DESC);
COMMENT ON TABLE observation_plan IS '观察计划：lifecycle 只描述管理状态；actionable 要求触发窗口、触发规则与取消规则明确';
COMMENT ON COLUMN observation_plan.execution_mode IS '本轮仅 shadow：可以发布在影子空间，但不产生业务订阅或外发副作用';
COMMENT ON COLUMN observation_plan.risk IS '结构化风险对象，缺必要项时计划只能 draft 且 actionable=false';
COMMENT ON COLUMN observation_plan.evaluation_policy IS '评估器编码/版本、起算、期限、费用与成交假设；未配置不得默认 0 收益';

ALTER TABLE strategy_signal_event
  ADD CONSTRAINT strategy_signal_event_plan_fk FOREIGN KEY (plan_id) REFERENCES observation_plan(id) ON DELETE SET NULL;

-- 4) 结果评估：区分固定前瞻诊断与完整执行模拟；不成熟/缺数/不可成交/未配置都不是 0 收益。
CREATE TABLE strategy_signal_outcome (
  id bigserial PRIMARY KEY,
  contract_version integer NOT NULL DEFAULT 1 CHECK (contract_version >= 1),
  event_id bigint NOT NULL REFERENCES strategy_signal_event(id) ON DELETE CASCADE,
  plan_id bigint REFERENCES observation_plan(id) ON DELETE SET NULL,
  plan_revision integer NOT NULL DEFAULT 0,
  signal_id bigint REFERENCES strategy_entry_signal(id) ON DELETE SET NULL,
  assessment_kind text NOT NULL CHECK (assessment_kind IN ('forward_diagnostic', 'execution_simulation')),
  producer_code text NOT NULL,
  producer_version integer NOT NULL,
  sample_start date,
  sample_end date,
  entry_basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  tradability text CHECK (tradability IS NULL OR tradability IN ('tradable', 'untradable', 'unknown')),
  fee_assumption jsonb NOT NULL DEFAULT '{}'::jsonb,
  horizon jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  benchmark_coverage jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'unavailable', 'not_executable', 'not_configured', 'evaluated')),
  not_evaluable_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, plan_revision, producer_code, producer_version, assessment_kind)
);
CREATE INDEX strategy_signal_outcome_event_idx ON strategy_signal_outcome (event_id);
CREATE INDEX strategy_signal_outcome_status_idx ON strategy_signal_outcome (status, sample_end DESC);
COMMENT ON TABLE strategy_signal_outcome IS '信号结果评估；pending=未成熟、unavailable=缺行情、not_executable=不可成交、not_configured=未配置评估，均不记 0 收益';
COMMENT ON COLUMN strategy_signal_outcome.assessment_kind IS '固定前瞻诊断与完整执行模拟不可互相冒充';
