-- 0118_关注池按策略归属.sql：自动关注的业务所有者从任务切换为策略，任务只保留执行审计。

ALTER TABLE pool_attention_entry DROP CONSTRAINT pool_attention_entry_pkey;
ALTER TABLE pool_attention_entry
  ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN source_type text,
  ADD COLUMN strategy_code text REFERENCES strategy_definition(code) ON DELETE RESTRICT,
  ADD COLUMN source_evaluation_run_id bigint,
  ADD COLUMN last_evaluated_at timestamptz,
  ADD COLUMN data_date date,
  ADD COLUMN stale_reason text;

UPDATE pool_attention_entry
   SET source_type = CASE WHEN source_job = 'manual' THEN 'manual' ELSE 'strategy' END,
       strategy_code = CASE source_job
         WHEN 'daily_plan_flow' THEN 'swing'
         WHEN 'nightly_sector_opportunity_scan' THEN 'nightly_sector'
         WHEN 'value_anchor_opportunity_scan' THEN 'value_anchor'
         WHEN 'two_year_reversal_scan' THEN 'two_year_reversal'
         ELSE NULL
       END,
       last_evaluated_at = CASE WHEN source_job = 'manual' THEN NULL ELSE updated_at END,
       data_date = CASE WHEN source_job = 'manual' THEN NULL ELSE valid_from END;

ALTER TABLE pool_attention_entry
  ADD CONSTRAINT pool_attention_entry_id_unique UNIQUE (id),
  ADD CONSTRAINT pool_attention_entry_pkey PRIMARY KEY (id),
  ALTER COLUMN source_type SET NOT NULL,
  ADD CONSTRAINT pool_attention_entry_source_type_check CHECK (source_type IN ('manual','strategy')),
  ADD CONSTRAINT pool_attention_entry_source_check CHECK (
    (source_type = 'manual' AND strategy_code IS NULL AND source_job = 'manual' AND status = 'manual')
    OR (source_type = 'strategy' AND strategy_code IS NOT NULL AND source_job <> 'manual' AND status IN ('qualified','approaching'))
  ),
  ADD CONSTRAINT pool_attention_entry_evaluation_fk
    FOREIGN KEY (source_evaluation_run_id, strategy_code)
    REFERENCES strategy_evaluation_run(id, strategy_code) ON DELETE SET NULL,
  ADD CONSTRAINT pool_attention_entry_stale_reason_check CHECK (stale_reason IS NULL OR length(btrim(stale_reason)) BETWEEN 1 AND 500);

CREATE UNIQUE INDEX pool_attention_entry_manual_unique
  ON pool_attention_entry (instrument_id) WHERE source_type = 'manual';
CREATE UNIQUE INDEX pool_attention_entry_strategy_unique
  ON pool_attention_entry (instrument_id, strategy_code) WHERE source_type = 'strategy';
CREATE INDEX pool_attention_entry_strategy_status_idx
  ON pool_attention_entry (strategy_code, status, valid_from DESC) WHERE source_type = 'strategy';

COMMENT ON TABLE pool_attention_entry IS '关注池来源条目：人工按标的唯一，自动关注按标的与策略唯一；任务只记录最近触发来源';
COMMENT ON COLUMN pool_attention_entry.id IS '关注来源条目主键';
COMMENT ON COLUMN pool_attention_entry.source_type IS 'manual=人工关注，strategy=策略评估投影';
COMMENT ON COLUMN pool_attention_entry.strategy_code IS '自动关注所属策略；人工关注为空';
COMMENT ON COLUMN pool_attention_entry.source_job IS '最近触发该策略关注对账的任务编码；不参与业务唯一性';
COMMENT ON COLUMN pool_attention_entry.source_evaluation_run_id IS '最近产生该关注状态的结构化策略评估运行';
COMMENT ON COLUMN pool_attention_entry.last_evaluated_at IS '该策略最近完成当前条目评估的时间';
COMMENT ON COLUMN pool_attention_entry.data_date IS '该策略关注结论实际使用的数据日';
COMMENT ON COLUMN pool_attention_entry.stale_reason IS '部分运行未覆盖或数据滞后时的待复核原因';
