-- 标准回测首批基础：只冻结数据库已有数据，不创建数据同步或策略发布任务。
ALTER TABLE backtest_run DROP CONSTRAINT backtest_run_execution_status_check;
ALTER TABLE backtest_run ADD CONSTRAINT backtest_run_execution_status_check
  CHECK (execution_status IN ('legacy','queued','preparing','running','success','partial','failed','cancelled','rejected'));

CREATE TABLE backtest_input_set (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sha256 text NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  schema_version text NOT NULL,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  row_count integer NOT NULL CHECK (row_count >= 0),
  byte_count bigint NOT NULL CHECK (byte_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE backtest_input_set IS '标准回测不可变输入集；只含本机研究数据，不进入可移植固定资产。';
COMMENT ON COLUMN backtest_input_set.id IS '冻结输入集编号。';
COMMENT ON COLUMN backtest_input_set.sha256 IS '规范清单的内容哈希，包含每块数据哈希。';
COMMENT ON COLUMN backtest_input_set.schema_version IS '输入契约版本。';
COMMENT ON COLUMN backtest_input_set.manifest IS '冻结范围、覆盖、种子、质量和分块清单。';
COMMENT ON COLUMN backtest_input_set.row_count IS '输入行情总行数，包含预热和环境输入。';
COMMENT ON COLUMN backtest_input_set.byte_count IS '全部分块压缩后的总字节数。';
COMMENT ON COLUMN backtest_input_set.created_at IS '输入集冻结时间，不等于历史信息公开时刻。';

CREATE TABLE backtest_input_chunk (
  input_set_id bigint NOT NULL REFERENCES backtest_input_set(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 0),
  trade_date date NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  encoding text NOT NULL CHECK (encoding = 'gzip-json-v1'),
  payload bytea NOT NULL,
  raw_bytes integer NOT NULL CHECK (raw_bytes BETWEEN 1 AND 8388608),
  row_count integer NOT NULL CHECK (row_count >= 0),
  PRIMARY KEY (input_set_id, seq),
  UNIQUE (input_set_id, trade_date)
);
COMMENT ON TABLE backtest_input_chunk IS '标准回测按日冻结的压缩输入块，禁止静默覆盖或替换。';
COMMENT ON COLUMN backtest_input_chunk.input_set_id IS '所属冻结输入集。';
COMMENT ON COLUMN backtest_input_chunk.seq IS '从零开始的顺序号。';
COMMENT ON COLUMN backtest_input_chunk.trade_date IS '交易日期，包含预热日期。';
COMMENT ON COLUMN backtest_input_chunk.sha256 IS '解压后规范内容的哈希。';
COMMENT ON COLUMN backtest_input_chunk.encoding IS '压缩和内容编码版本。';
COMMENT ON COLUMN backtest_input_chunk.payload IS '压缩行情和环境信息；无密钥和真实持仓。';
COMMENT ON COLUMN backtest_input_chunk.raw_bytes IS '解压前检查的预期原始字节数。';
COMMENT ON COLUMN backtest_input_chunk.row_count IS '当日股票与环境行情总行数。';

ALTER TABLE backtest_run
  ADD COLUMN engine_type text NOT NULL DEFAULT 'legacy' CHECK (engine_type IN ('legacy','standard_daily')),
  ADD COLUMN execution_plan jsonb CHECK (execution_plan IS NULL OR jsonb_typeof(execution_plan) = 'object'),
  ADD COLUMN plan_sha256 text CHECK (plan_sha256 IS NULL OR plan_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN input_set_id bigint REFERENCES backtest_input_set(id) ON DELETE RESTRICT,
  ADD COLUMN quality_status text NOT NULL DEFAULT 'unchecked' CHECK (quality_status IN ('unchecked','complete','incomplete','invalid')),
  ADD COLUMN evidence_status text NOT NULL DEFAULT 'legacy_unverified' CHECK (evidence_status IN ('legacy_unverified','research_only','qualified')),
  ADD COLUMN replay_status text NOT NULL DEFAULT 'unavailable' CHECK (replay_status IN ('exact','materials_only','unavailable'));
COMMENT ON COLUMN backtest_run.engine_type IS '运行引擎类型；旧记录不自动取得标准化资格。';
COMMENT ON COLUMN backtest_run.execution_plan IS '标准实验的有限确定性参数，不保存策略正文副本。';
COMMENT ON COLUMN backtest_run.plan_sha256 IS '规范执行计划的哈希。';
COMMENT ON COLUMN backtest_run.input_set_id IS '运行使用的不可变冻结输入集。';
COMMENT ON COLUMN backtest_run.quality_status IS '数据质量状态，与执行是否成功独立。';
COMMENT ON COLUMN backtest_run.evidence_status IS '系统验证的证据资格，不从旧正式分类推断。';
COMMENT ON COLUMN backtest_run.replay_status IS '按实际输入、计划和制品可得性判断的重放能力。';
CREATE INDEX backtest_run_input_set_idx ON backtest_run(input_set_id) WHERE input_set_id IS NOT NULL;

CREATE FUNCTION reject_backtest_input_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '冻结回测输入不可修改；请建立新输入集';
END;
$$;
COMMENT ON FUNCTION reject_backtest_input_update() IS '阻止已冻结输入被更新，删除仍受引用及领域确认契约约束。';
CREATE TRIGGER backtest_input_set_immutable BEFORE UPDATE ON backtest_input_set
  FOR EACH ROW EXECUTE FUNCTION reject_backtest_input_update();
CREATE TRIGGER backtest_input_chunk_immutable BEFORE UPDATE ON backtest_input_chunk
  FOR EACH ROW EXECUTE FUNCTION reject_backtest_input_update();
