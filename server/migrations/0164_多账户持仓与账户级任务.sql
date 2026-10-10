-- 0164_多账户持仓与账户级任务.sql：建立账户边界，保留全局行情、策略和关注池。
-- 现有数据全部归入默认账户；账户是持仓、成交、风控和持仓类任务的隔离边界。

CREATE TABLE portfolio_account (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name)
);

INSERT INTO portfolio_account (name) VALUES ('默认账户');

COMMENT ON TABLE portfolio_account IS '用户命名的独立持仓账户；持仓、成交、风控和账户级任务按账户隔离';
COMMENT ON COLUMN portfolio_account.id IS '账户编号';
COMMENT ON COLUMN portfolio_account.name IS '用户可见的账户名称';
COMMENT ON COLUMN portfolio_account.status IS 'active=可执行账户级任务，archived=保留历史但不再执行新任务';
COMMENT ON COLUMN portfolio_account.created_at IS '账户创建时间';
COMMENT ON COLUMN portfolio_account.updated_at IS '账户最后修改时间';

ALTER TABLE portfolio_position
  ADD COLUMN account_id bigint;
UPDATE portfolio_position SET account_id = (SELECT id FROM portfolio_account ORDER BY id LIMIT 1);
ALTER TABLE portfolio_position ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE portfolio_position DROP CONSTRAINT IF EXISTS portfolio_position_pkey;
ALTER TABLE portfolio_position DROP CONSTRAINT IF EXISTS position_pkey;
ALTER TABLE portfolio_position ADD CONSTRAINT portfolio_position_pkey PRIMARY KEY (account_id, instrument_id);
ALTER TABLE portfolio_position
  ADD CONSTRAINT portfolio_position_account_fk FOREIGN KEY (account_id) REFERENCES portfolio_account(id) ON DELETE RESTRICT;
CREATE INDEX portfolio_position_instrument_idx ON portfolio_position (instrument_id, quantity) WHERE quantity > 0;
COMMENT ON COLUMN portfolio_position.account_id IS '持仓所属账户';

ALTER TABLE portfolio_position_change
  ADD COLUMN account_id bigint;
UPDATE portfolio_position_change SET account_id = (SELECT id FROM portfolio_account ORDER BY id LIMIT 1);
ALTER TABLE portfolio_position_change ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE portfolio_position_change
  ADD CONSTRAINT portfolio_position_change_account_fk FOREIGN KEY (account_id) REFERENCES portfolio_account(id) ON DELETE RESTRICT;
CREATE INDEX portfolio_position_change_account_date_idx
  ON portfolio_position_change (account_id, change_date DESC, id DESC);
COMMENT ON COLUMN portfolio_position_change.account_id IS '成交或持仓事实修正所属账户';

ALTER TABLE portfolio_account_state
  ADD COLUMN account_id bigint;
UPDATE portfolio_account_state SET account_id = (SELECT id FROM portfolio_account ORDER BY id LIMIT 1);
ALTER TABLE portfolio_account_state ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE portfolio_account_state DROP CONSTRAINT portfolio_account_state_pkey;
ALTER TABLE portfolio_account_state DROP COLUMN id;
ALTER TABLE portfolio_account_state ADD CONSTRAINT portfolio_account_state_pkey PRIMARY KEY (account_id);
ALTER TABLE portfolio_account_state
  ADD CONSTRAINT portfolio_account_state_account_fk FOREIGN KEY (account_id) REFERENCES portfolio_account(id) ON DELETE RESTRICT;
ALTER TABLE portfolio_account_state
  ADD COLUMN id boolean NOT NULL DEFAULT true CHECK (id);
ALTER TABLE portfolio_account_state ALTER COLUMN account_id SET DEFAULT 1;
COMMENT ON COLUMN portfolio_account_state.account_id IS '现金台账所属账户';
COMMENT ON COLUMN portfolio_account_state.id IS '兼容旧版单例账户台账的固定标记；新逻辑使用 account_id';

ALTER TABLE portfolio_equity_daily
  ADD COLUMN account_id bigint;
UPDATE portfolio_equity_daily SET account_id = (SELECT id FROM portfolio_account ORDER BY id LIMIT 1);
ALTER TABLE portfolio_equity_daily ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE portfolio_equity_daily DROP CONSTRAINT portfolio_equity_daily_pkey;
ALTER TABLE portfolio_equity_daily ADD CONSTRAINT portfolio_equity_daily_pkey PRIMARY KEY (account_id, snap_date);
ALTER TABLE portfolio_equity_daily
  ADD CONSTRAINT portfolio_equity_daily_account_fk FOREIGN KEY (account_id) REFERENCES portfolio_account(id) ON DELETE RESTRICT;
ALTER TABLE portfolio_equity_daily ALTER COLUMN account_id SET DEFAULT 1;
COMMENT ON COLUMN portfolio_equity_daily.account_id IS '每日组合净值所属账户';

ALTER TABLE portfolio_realized_pnl_baseline
  ADD COLUMN account_id bigint;
UPDATE portfolio_realized_pnl_baseline SET account_id = (SELECT id FROM portfolio_account ORDER BY id LIMIT 1);
ALTER TABLE portfolio_realized_pnl_baseline ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE portfolio_realized_pnl_baseline DROP CONSTRAINT portfolio_realized_pnl_baseline_pkey;
ALTER TABLE portfolio_realized_pnl_baseline DROP COLUMN singleton;
ALTER TABLE portfolio_realized_pnl_baseline ADD CONSTRAINT portfolio_realized_pnl_baseline_pkey PRIMARY KEY (account_id);
ALTER TABLE portfolio_realized_pnl_baseline
  ADD CONSTRAINT portfolio_realized_pnl_baseline_account_fk FOREIGN KEY (account_id) REFERENCES portfolio_account(id) ON DELETE RESTRICT;
ALTER TABLE portfolio_realized_pnl_baseline
  ADD COLUMN singleton boolean NOT NULL DEFAULT true CHECK (singleton);
ALTER TABLE portfolio_realized_pnl_baseline ALTER COLUMN account_id SET DEFAULT 1;
COMMENT ON COLUMN portfolio_realized_pnl_baseline.account_id IS '累计已实现盈亏基线所属账户';
COMMENT ON COLUMN portfolio_realized_pnl_baseline.singleton IS '兼容旧版单例基线的固定标记；新逻辑使用 account_id';

ALTER TABLE intraday_position_risk
  ADD COLUMN account_id bigint;
UPDATE intraday_position_risk SET account_id = (SELECT id FROM portfolio_account ORDER BY id LIMIT 1);
ALTER TABLE intraday_position_risk ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE intraday_position_risk DROP CONSTRAINT IF EXISTS intraday_position_risk_trade_date_code_key;
ALTER TABLE intraday_position_risk
  ADD CONSTRAINT intraday_position_risk_account_unique UNIQUE (account_id, trade_date, code),
  ADD CONSTRAINT intraday_position_risk_account_fk FOREIGN KEY (account_id) REFERENCES portfolio_account(id) ON DELETE RESTRICT;
COMMENT ON COLUMN intraday_position_risk.account_id IS '盘中持仓风险所属账户';

ALTER TABLE daily_plan_playbook
  ADD COLUMN account_id bigint;
UPDATE daily_plan_playbook SET account_id = (SELECT id FROM portfolio_account ORDER BY id LIMIT 1);
ALTER TABLE daily_plan_playbook ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE daily_plan_playbook
  ADD CONSTRAINT daily_plan_playbook_account_fk FOREIGN KEY (account_id) REFERENCES portfolio_account(id) ON DELETE RESTRICT;
CREATE INDEX daily_plan_playbook_account_run_idx ON daily_plan_playbook (account_id, source_job_run_id, id);
COMMENT ON COLUMN daily_plan_playbook.account_id IS '账户每日计划预案所属账户';

ALTER TABLE daily_plan_auction_assessment
  ADD COLUMN account_id bigint;
UPDATE daily_plan_auction_assessment SET account_id = (SELECT id FROM portfolio_account ORDER BY id LIMIT 1);
ALTER TABLE daily_plan_auction_assessment ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE daily_plan_auction_assessment
  ADD CONSTRAINT daily_plan_auction_assessment_account_fk FOREIGN KEY (account_id) REFERENCES portfolio_account(id) ON DELETE RESTRICT;
COMMENT ON COLUMN daily_plan_auction_assessment.account_id IS '账户竞价复核所属账户';

ALTER TABLE auction_scope_assessment
  ADD COLUMN account_id bigint;
UPDATE auction_scope_assessment SET account_id = (SELECT id FROM portfolio_account ORDER BY id LIMIT 1);
ALTER TABLE auction_scope_assessment ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE auction_scope_assessment
  ADD CONSTRAINT auction_scope_assessment_account_fk FOREIGN KEY (account_id) REFERENCES portfolio_account(id) ON DELETE RESTRICT;
COMMENT ON COLUMN auction_scope_assessment.account_id IS '账户竞价范围复核所属账户';

ALTER TABLE strategy_evaluation_run
  ADD COLUMN account_id bigint REFERENCES portfolio_account(id) ON DELETE RESTRICT;
ALTER TABLE strategy_evaluation_run
  DROP CONSTRAINT IF EXISTS strategy_evaluation_run_strategy_code_phase_target_date_evaluator_code_evaluator_version_input_fingerprint_key;
CREATE UNIQUE INDEX strategy_evaluation_run_scope_unique
  ON strategy_evaluation_run (
    COALESCE(account_id, 0), strategy_code, phase, target_date,
    evaluator_code, evaluator_version, input_fingerprint
  );
CREATE INDEX strategy_evaluation_run_account_lookup_idx
  ON strategy_evaluation_run (account_id, strategy_code, phase, target_date DESC, created_at DESC);
COMMENT ON COLUMN strategy_evaluation_run.account_id IS '账户级评估所属账户；全局市场评估为空';

ALTER TABLE job_definition
  ADD COLUMN execution_scope text NOT NULL DEFAULT 'global'
    CHECK (execution_scope IN ('global', 'account'));
UPDATE job_definition SET execution_scope = 'account'
 WHERE code IN ('daily_plan_flow', 'auction_opportunity_assessment');
COMMENT ON COLUMN job_definition.execution_scope IS 'global=全局任务，account=每个 active 账户独立生成运行';

ALTER TABLE job_run
  ADD COLUMN account_id bigint REFERENCES portfolio_account(id) ON DELETE RESTRICT;
UPDATE job_run run
   SET account_id = (SELECT id FROM portfolio_account ORDER BY id LIMIT 1)
 WHERE EXISTS (
   SELECT 1 FROM job_definition definition
    WHERE definition.id = run.job_id AND definition.execution_scope = 'account'
 );
DROP INDEX IF EXISTS job_run_scheduled_once;
CREATE UNIQUE INDEX job_run_scheduled_once
  ON job_run (job_id, COALESCE(account_id, 0), scheduled_for)
  WHERE scheduled_for IS NOT NULL;
CREATE INDEX job_run_account_date ON job_run (account_id, target_date DESC, id DESC);
COMMENT ON COLUMN job_run.account_id IS '账户级任务运行所属账户；全局任务为空';

ALTER TABLE chat_session
  ADD COLUMN account_id bigint REFERENCES portfolio_account(id) ON DELETE RESTRICT;
CREATE INDEX chat_session_account_updated_idx ON chat_session (account_id, updated_at DESC);
COMMENT ON COLUMN chat_session.account_id IS '账户级 Agent 会话所属账户；全局会话为空';

ALTER TABLE notification_delivery
  ADD COLUMN account_id bigint REFERENCES portfolio_account(id) ON DELETE RESTRICT;
CREATE INDEX notification_delivery_account_idx ON notification_delivery (account_id, created_at DESC);
COMMENT ON COLUMN notification_delivery.account_id IS '账户级任务通知所属账户';

-- 默认值只用于存量调用兼容；正式账户写入由会话或任务服务显式提供账户。
ALTER TABLE portfolio_position ALTER COLUMN account_id SET DEFAULT 1;
ALTER TABLE portfolio_position_change ALTER COLUMN account_id SET DEFAULT 1;
ALTER TABLE intraday_position_risk ALTER COLUMN account_id SET DEFAULT 1;
-- 共享市场机会没有账户归属；账户持仓预案从所属运行取得账户。
ALTER TABLE daily_plan_playbook ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE daily_plan_playbook ALTER COLUMN account_id SET DEFAULT 1;
ALTER TABLE daily_plan_auction_assessment ALTER COLUMN account_id SET DEFAULT 1;
ALTER TABLE auction_scope_assessment ALTER COLUMN account_id SET DEFAULT 1;

-- PostgreSQL 自动生成的长约束名可能截断，按列识别旧的全局复用约束。
DO $$
DECLARE old_constraint record;
BEGIN
  FOR old_constraint IN
    SELECT conname FROM pg_constraint
     WHERE conrelid='strategy_evaluation_run'::regclass AND contype='u'
       AND pg_get_constraintdef(oid) LIKE '%input_fingerprint%'
       AND pg_get_constraintdef(oid) NOT LIKE '%account_id%'
  LOOP
    EXECUTE format('ALTER TABLE strategy_evaluation_run DROP CONSTRAINT %I', old_constraint.conname);
  END LOOP;
END $$;

UPDATE strategy_evaluation_run SET account_id=1 WHERE phase IN ('exit','context');
UPDATE chat_session session SET account_id=run.account_id FROM job_run run
 WHERE run.session_id=session.id AND run.account_id IS NOT NULL;
UPDATE chat_session SET account_id=1 WHERE session_type='interactive';

CREATE TABLE daily_plan_market_context (
  target_date date PRIMARY KEY,
  input_sha256 text NOT NULL,
  result jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE daily_plan_market_context IS '每日计划共享市场层：相同数据输入只计算一次，不含账户持仓成本和数量';
COMMENT ON COLUMN daily_plan_market_context.target_date IS '共享市场上下文目标日';
COMMENT ON COLUMN daily_plan_market_context.input_sha256 IS '市场数据、池和策略输入的指纹';
COMMENT ON COLUMN daily_plan_market_context.result IS '共享行业、市场结构和观察信号上下文';
COMMENT ON COLUMN daily_plan_market_context.updated_at IS '共享市场上下文更新时间';

ALTER TABLE job_run_output ADD COLUMN account_id bigint REFERENCES portfolio_account(id) ON DELETE RESTRICT;
UPDATE job_run_output output SET account_id=run.account_id FROM job_run run WHERE run.id=output.run_id;
UPDATE job_run_output SET account_id=1 WHERE account_id IS NULL AND output_type='daily_plan';
COMMENT ON COLUMN job_run_output.account_id IS '任务结果所属账户；全局市场任务为空';
DROP INDEX daily_plan_auction_assessment_active;
CREATE UNIQUE INDEX daily_plan_auction_assessment_active
  ON daily_plan_auction_assessment(account_id,playbook_item_id) WHERE status='active';
ALTER TABLE chat_session ALTER COLUMN account_id SET DEFAULT 1;
UPDATE daily_plan_playbook item SET account_id=NULL FROM job_run run
 WHERE run.id=item.source_job_run_id AND run.account_id IS NULL;
UPDATE notification_delivery delivery SET account_id=output.account_id
 FROM job_run_output output WHERE output.id=delivery.output_id;
UPDATE notification_delivery delivery SET account_id=risk.account_id
 FROM intraday_position_risk risk WHERE risk.id=delivery.intraday_risk_id;

UPDATE job_definition SET purpose='复用共享市场、板块与盘前消息，为每个账户独立评估持仓退出、生成当日情景和做T预案'
 WHERE code='daily_plan_flow';
WITH current_prompt AS (
  SELECT prompt.id,prompt.current_revision_id,revision.content
    FROM job_prompt prompt JOIN job_prompt_revision revision ON revision.id=prompt.current_revision_id
   WHERE prompt.code IN ('daily_plan_flow','auction_opportunity_assessment')
), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT id,(SELECT COALESCE(max(revision_no),0)+1 FROM job_prompt_revision WHERE prompt_id=current_prompt.id),
    '账户范围：本次任务仅处理绑定账户的持仓与预案，账户编号和名称由系统提供。共享市场信号与关注池只读；不得修改其他账户、消费共享关注或将其他账户结果作为本账户结果。' || E'\n\n' || content,
    encode(sha256(convert_to('账户范围：本次任务仅处理绑定账户的持仓与预案，账户编号和名称由系统提供。共享市场信号与关注池只读；不得修改其他账户、消费共享关注或将其他账户结果作为本账户结果。' || E'\n\n' || content,'UTF8')),'hex'),
    'user',current_revision_id,'账户级任务范围与共享市场边界'
  FROM current_prompt RETURNING id,prompt_id
)
UPDATE job_prompt prompt SET current_revision_id=inserted.id,updated_at=now() FROM inserted WHERE prompt.id=inserted.prompt_id;
