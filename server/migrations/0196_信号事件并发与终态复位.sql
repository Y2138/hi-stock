-- 0196_信号事件并发与终态复位.sql
-- 修正 0195 的三处契约缺口（PM 复核）：
--   1) 事件去重键缺账户维度，多账户同一条件会被合并成一条；
--   2) 去重键没区分来源类型，手工生产者和同名策略编码可能被当成同一个来源；
--   3) outcome 唯一键缺期限，1/3/5/10 日互相覆盖。
-- 只加列、加索引、换唯一约束；不改 0195 的表结构与历史行。

-- 1) 事件补齐账户维度与终态时间（复位证明依赖 closed_at）。
ALTER TABLE strategy_signal_event ADD COLUMN account_id bigint REFERENCES portfolio_account(id) ON DELETE SET NULL;
ALTER TABLE strategy_signal_event ADD COLUMN closed_at timestamptz;
COMMENT ON COLUMN strategy_signal_event.account_id IS 'account 范围的归属账户；personal/shared 为空，不按持仓推断';
COMMENT ON COLUMN strategy_signal_event.closed_at IS '进入 invalidated/expired 的时间；重新开启需要显式复位证明，不靠时间间隔猜';
CREATE INDEX strategy_signal_event_account_idx ON strategy_signal_event (account_id) WHERE account_id IS NOT NULL;

ALTER TABLE observation_plan ADD COLUMN account_id bigint REFERENCES portfolio_account(id) ON DELETE SET NULL;
COMMENT ON COLUMN observation_plan.account_id IS 'account 范围的归属账户，与事件保持一致';

-- 2) 存续事件唯一键：来源类型 + 来源编码 + 标的 + 条件 + 范围 + 账户。
--    COALESCE(account_id,0) 让 personal/shared 也能进唯一键（NULL 在唯一索引里互不相等）。
DROP INDEX strategy_signal_event_active_uidx;
CREATE UNIQUE INDEX strategy_signal_event_active_uidx
  ON strategy_signal_event (
    source_kind,
    COALESCE(strategy_code, producer_code),
    instrument_id,
    condition_hash,
    scope,
    COALESCE(account_id, 0)
  )
  WHERE status IN ('observing', 'pending', 'triggered');
COMMENT ON INDEX strategy_signal_event_active_uidx IS '同来源类型 + 同来源编码 + 同标的 + 同条件 + 同范围 + 同账户只允许一个存续事件';

-- 3) outcome 唯一键加入 horizon_key：同事件同口径下 1/3/5/10 日各存一行，不再互相覆盖。
ALTER TABLE strategy_signal_outcome ADD COLUMN horizon_key text NOT NULL DEFAULT '{}';
COMMENT ON COLUMN strategy_signal_outcome.horizon_key IS '期限归一化键（horizon JSON 稳定序列化）；同一期限重复回填幂等，不同期限各存一行';

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
    FROM pg_constraint
   WHERE conrelid = 'strategy_signal_outcome'::regclass AND contype = 'u';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE strategy_signal_outcome DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE strategy_signal_outcome
  ADD CONSTRAINT strategy_signal_outcome_horizon_uk
  UNIQUE (event_id, plan_revision, producer_code, producer_version, assessment_kind, horizon_key);

-- 4) 补齐 0195 四张表的列注释：仓库要求每张表和每个列都有 COMMENT（migrate.test.ts 校验）。
COMMENT ON COLUMN strategy_signal_event.id IS '事件编号';
COMMENT ON COLUMN strategy_signal_event.contract_version IS '契约版本，便于后续字段演进而不改语义';
COMMENT ON COLUMN strategy_signal_event.source_kind IS 'strategy=策略评估器自动来源，manual=用户手工录入';
COMMENT ON COLUMN strategy_signal_event.source_ref IS '来源侧原始引用（手工会话/发现编号），不参与去重键';
COMMENT ON COLUMN strategy_signal_event.scope IS 'personal=个人、account=账户级、shared=共享；与业务池隔离';
COMMENT ON COLUMN strategy_signal_event.strategy_code IS '策略编码；手工来源为空，不虚构策略身份';
COMMENT ON COLUMN strategy_signal_event.instrument_id IS '标的编号，引用 market_instrument';
COMMENT ON COLUMN strategy_signal_event.trigger_kind IS '触发方式类别（price_range/condition 等），参与条件指纹';
COMMENT ON COLUMN strategy_signal_event.signal_status IS '评估器原始判定：qualified=正式信号，approaching=接近候选';
COMMENT ON COLUMN strategy_signal_event.status IS '五态机会状态；与计划管理状态、运行健康和通知状态分离';
COMMENT ON COLUMN strategy_signal_event.first_seen_at IS '首次观察到该机会的时间；连续命中不重写';
COMMENT ON COLUMN strategy_signal_event.last_seen_at IS '最近一次命中的时间；连续命中只推进这一列';
COMMENT ON COLUMN strategy_signal_event.valid_from IS '机会起始交易日，来自评估目标日';
COMMENT ON COLUMN strategy_signal_event.valid_until IS '机会有效终点；连续命中取更早者，不续窗口';
COMMENT ON COLUMN strategy_signal_event.invalidation IS '顶层失效价；策略另有更细价位时以风险对象为准';
COMMENT ON COLUMN strategy_signal_event.risk_source IS '风险价位来源：evaluator=策略计算，manual=用户给出，none=缺失';
COMMENT ON COLUMN strategy_signal_event.producer_code IS '生产者编码（评估器编码或手工生产者），与策略编码区分';
COMMENT ON COLUMN strategy_signal_event.producer_version IS '生产者版本，便于回放时定位规则版本';
COMMENT ON COLUMN strategy_signal_event.data_as_of IS '证据数据的业务截止日';
COMMENT ON COLUMN strategy_signal_event.available_at IS '证据实际可获得时间，缺数时用于区分滞后与缺失';
COMMENT ON COLUMN strategy_signal_event.input_fingerprint IS '本次输入指纹，用于回放对照';
COMMENT ON COLUMN strategy_signal_event.rule_hash IS '规则版本哈希，历史缺失时不可声称可复算';
COMMENT ON COLUMN strategy_signal_event.evidence IS '策略产物原始证据；续存时更新为最新一次';
COMMENT ON COLUMN strategy_signal_event.evidence_refs IS '证据引用列表，指向行情与评估记录';
COMMENT ON COLUMN strategy_signal_event.gaps IS '数据缺口说明；缺数不等于失效';
COMMENT ON COLUMN strategy_signal_event.missing_signals IS '评估器给出的缺失条件，接近候选尤其需要';
COMMENT ON COLUMN strategy_signal_event.run_id IS '产生该事件的评估运行编号';
COMMENT ON COLUMN strategy_signal_event.plan_id IS '当前生效观察计划编号';
COMMENT ON COLUMN strategy_signal_event.current_revision IS '当前生效计划的修订号';
COMMENT ON COLUMN strategy_signal_event.created_at IS '记录创建时间';
COMMENT ON COLUMN strategy_signal_event.updated_at IS '记录最后更新时间';

COMMENT ON COLUMN strategy_signal_event_transition.id IS '转移记录编号';
COMMENT ON COLUMN strategy_signal_event_transition.event_id IS '所属信号事件';
COMMENT ON COLUMN strategy_signal_event_transition.from_status IS '转移前状态；首次记录为空';
COMMENT ON COLUMN strategy_signal_event_transition.to_status IS '转移后状态';
COMMENT ON COLUMN strategy_signal_event_transition.reason IS '转移原因，触发、失效、到期、缺数需可区分';
COMMENT ON COLUMN strategy_signal_event_transition.fact_at IS '事实发生时间，不用写入时间冒充';
COMMENT ON COLUMN strategy_signal_event_transition.actor IS '执行者：评估器、观测模块或人工';
COMMENT ON COLUMN strategy_signal_event_transition.run_id IS '关联的评估或任务运行编号';
COMMENT ON COLUMN strategy_signal_event_transition.idempotency_key IS '幂等键；同一事件同一键只记一次';
COMMENT ON COLUMN strategy_signal_event_transition.created_at IS '记录写入时间';

COMMENT ON COLUMN observation_plan.id IS '计划编号';
COMMENT ON COLUMN observation_plan.contract_version IS '契约版本';
COMMENT ON COLUMN observation_plan.event_id IS '所属信号事件';
COMMENT ON COLUMN observation_plan.revision IS '计划修订号，同事件内唯一';
COMMENT ON COLUMN observation_plan.source_kind IS '来源类型，与事件一致';
COMMENT ON COLUMN observation_plan.source_ref IS '来源侧原始引用';
COMMENT ON COLUMN observation_plan.scope IS '计划作用范围，与事件一致';
COMMENT ON COLUMN observation_plan.strategy_code IS '策略编码；手工计划为空';
COMMENT ON COLUMN observation_plan.lifecycle_status IS '计划管理状态：草案、已发布、暂停、结束；不等于机会状态';
COMMENT ON COLUMN observation_plan.actionable IS '是否可执行；缺触发规则、窗口、取消规则或风险价位时为 false';
COMMENT ON COLUMN observation_plan.producer_code IS '计划生产者编码';
COMMENT ON COLUMN observation_plan.producer_version IS '计划生产者版本';
COMMENT ON COLUMN observation_plan.trigger IS '触发规则与观察窗口的结构化描述';
COMMENT ON COLUMN observation_plan.observation_policy IS '盘中观测口径：窗口、频率、缺数处理';
COMMENT ON COLUMN observation_plan.price_levels IS '策略给出的价位序列，保留原始用途标注';
COMMENT ON COLUMN observation_plan.data_as_of IS '计划依据数据的业务截止日';
COMMENT ON COLUMN observation_plan.available_at IS '计划依据数据的可获得时间';
COMMENT ON COLUMN observation_plan.generated_at IS '计划生成时间';
COMMENT ON COLUMN observation_plan.input_fingerprint IS '生成计划的输入指纹';
COMMENT ON COLUMN observation_plan.rule_hash IS '生成计划时的规则哈希';
COMMENT ON COLUMN observation_plan.gaps IS '计划依据中的缺口说明';
COMMENT ON COLUMN observation_plan.effective_from IS '计划生效交易日';
COMMENT ON COLUMN observation_plan.effective_to IS '计划失效交易日';
COMMENT ON COLUMN observation_plan.created_at IS '记录创建时间';
COMMENT ON COLUMN observation_plan.updated_at IS '记录最后更新时间';

COMMENT ON COLUMN strategy_signal_outcome.id IS '评估结果编号';
COMMENT ON COLUMN strategy_signal_outcome.contract_version IS '契约版本';
COMMENT ON COLUMN strategy_signal_outcome.event_id IS '所属信号事件';
COMMENT ON COLUMN strategy_signal_outcome.plan_id IS '评估所依据的观察计划';
COMMENT ON COLUMN strategy_signal_outcome.plan_revision IS '计划修订号；未关联计划为 0';
COMMENT ON COLUMN strategy_signal_outcome.signal_id IS '对应的旧链路信号编号，用于历史映射对照';
COMMENT ON COLUMN strategy_signal_outcome.producer_code IS '评估器编码';
COMMENT ON COLUMN strategy_signal_outcome.producer_version IS '评估器版本';
COMMENT ON COLUMN strategy_signal_outcome.sample_start IS '评估起算日';
COMMENT ON COLUMN strategy_signal_outcome.sample_end IS '评估到期日；未成熟为空';
COMMENT ON COLUMN strategy_signal_outcome.entry_basis IS '起算价基：次日开盘、信号价等，必须写清';
COMMENT ON COLUMN strategy_signal_outcome.tradability IS '可成交性：可成交、不可成交、未知；不可成交不记零收益';
COMMENT ON COLUMN strategy_signal_outcome.fee_assumption IS '费用与滑点假设';
COMMENT ON COLUMN strategy_signal_outcome.horizon IS '评估期限描述（1/3/5/10 日等）';
COMMENT ON COLUMN strategy_signal_outcome.result IS '评估结果；未成熟、缺数、不可成交时为空';
COMMENT ON COLUMN strategy_signal_outcome.benchmark_coverage IS '基准覆盖情况，缺失时不得静默按零超额计算';
COMMENT ON COLUMN strategy_signal_outcome.status IS '评估状态：未成熟、缺数、不可成交、未配置、已评估';
COMMENT ON COLUMN strategy_signal_outcome.not_evaluable_reason IS '不可评估原因，便于区分缺数与策略失效';
COMMENT ON COLUMN strategy_signal_outcome.created_at IS '记录创建时间';
COMMENT ON COLUMN strategy_signal_outcome.updated_at IS '记录最后更新时间';
