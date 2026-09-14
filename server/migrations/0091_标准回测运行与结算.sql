ALTER TABLE backtest_run
 ADD COLUMN idempotency_key text,
 ADD COLUMN request_sha256 text CHECK (request_sha256 IS NULL OR request_sha256 ~ '^[0-9a-f]{64}$'),
 ADD COLUMN generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
 ADD COLUMN lease_token uuid,
 ADD COLUMN lease_expires_at timestamptz,
 ADD COLUMN heartbeat_at timestamptz,
 ADD COLUMN cancel_requested_at timestamptz,
 ADD COLUMN phase text NOT NULL DEFAULT 'legacy',
 ADD COLUMN worker_build_hash text CHECK (worker_build_hash IS NULL OR worker_build_hash ~ '^[0-9a-f]{64}$'),
 ADD COLUMN output_sha256 text CHECK (output_sha256 IS NULL OR output_sha256 ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX backtest_run_standard_idempotency ON backtest_run(session_id,idempotency_key)
 WHERE engine_type='standard_daily';
CREATE INDEX backtest_run_standard_queue ON backtest_run(created_at,id)
 WHERE engine_type='standard_daily' AND execution_status='queued';
COMMENT ON COLUMN backtest_run.idempotency_key IS '来源会话内标准运行幂等键。';
COMMENT ON COLUMN backtest_run.request_sha256 IS '规范请求哈希，重复幂等键不同请求拒绝。';
COMMENT ON COLUMN backtest_run.generation IS '本次执行代次，旧代次不得写入结果。';
COMMENT ON COLUMN backtest_run.lease_token IS '领取时生成的不可预测执行令牌，不通过查询接口返回。';
COMMENT ON COLUMN backtest_run.lease_expires_at IS '执行租约截止时刻。';
COMMENT ON COLUMN backtest_run.heartbeat_at IS '最近一次有效心跳。';
COMMENT ON COLUMN backtest_run.cancel_requested_at IS '取消请求时间，终态后不允许继续写入。';
COMMENT ON COLUMN backtest_run.phase IS '标准任务阶段，区别于执行终态。';
COMMENT ON COLUMN backtest_run.worker_build_hash IS '受信任内核及相关代码制品内容哈希。';
COMMENT ON COLUMN backtest_run.output_sha256 IS '成功输出事件和结算的链式内容哈希。';

CREATE TABLE backtest_event (
 run_id bigint NOT NULL REFERENCES backtest_run(id) ON DELETE CASCADE,
 generation integer NOT NULL CHECK (generation>0),
 seq integer NOT NULL CHECK (seq>0),
 trade_date date NOT NULL,
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
 sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(run_id,generation,seq)
);
CREATE INDEX backtest_event_date_idx ON backtest_event(run_id,generation,trade_date);
COMMENT ON TABLE backtest_event IS '标准回测有序事件；只有运行成功代次才用于最终结果，失败代次仅用于诊断。';
COMMENT ON COLUMN backtest_event.run_id IS '所属运行。';
COMMENT ON COLUMN backtest_event.generation IS '执行代次。';
COMMENT ON COLUMN backtest_event.seq IS '运行内从一开始连续的事件序号。';
COMMENT ON COLUMN backtest_event.trade_date IS '模拟交易日期。';
COMMENT ON COLUMN backtest_event.payload IS '经服务校验的信号、订单、成交或风险事件，不含凭据。';
COMMENT ON COLUMN backtest_event.sha256 IS '事件规范内容哈希。';

CREATE TABLE backtest_equity_daily (
 run_id bigint NOT NULL REFERENCES backtest_run(id) ON DELETE CASCADE,
 generation integer NOT NULL CHECK (generation>0),
 trade_date date NOT NULL,
 cash_cents bigint NOT NULL CHECK(cash_cents>=0),
 equity_cents bigint NOT NULL CHECK(equity_cents>=0),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(run_id,generation,trade_date)
);
COMMENT ON TABLE backtest_equity_daily IS '标准模拟账户每日结算，与实盘账户快照隔离，仅进入私有备份。';
COMMENT ON COLUMN backtest_equity_daily.run_id IS '所属运行。';
COMMENT ON COLUMN backtest_equity_daily.generation IS '执行代次。';
COMMENT ON COLUMN backtest_equity_daily.trade_date IS '正式模拟结算日，不包含指标预热。';
COMMENT ON COLUMN backtest_equity_daily.cash_cents IS '现金余额，单位分。';
COMMENT ON COLUMN backtest_equity_daily.equity_cents IS '组合权益，单位分。';
COMMENT ON COLUMN backtest_equity_daily.payload IS '结算、持仓及可选基准的完整审计载荷。';
COMMENT ON COLUMN backtest_equity_daily.sha256 IS '本日事件和结算批次哈希，用于重复批次一致性判断。';
