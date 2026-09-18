-- 0121_竞价跨域研判.sql：竞价是独立跨域任务，打板评分仍由每日计划完成。
ALTER TABLE job_definition DROP CONSTRAINT job_definition_agent_role_check;
ALTER TABLE job_definition ADD CONSTRAINT job_definition_agent_role_check CHECK (
  agent_role IS NULL OR agent_role IN (
    'strategy_entry_report','strategy_exit_report','strategy_confirmation',
    'portfolio_aggregator','data_pipeline','research_report','auction_cross_scope'
  )
);
ALTER TABLE job_definition DROP CONSTRAINT job_definition_strategy_role_check;
ALTER TABLE job_definition ADD CONSTRAINT job_definition_strategy_role_check CHECK (
  (agent_role IS NULL AND strategy_code IS NULL)
  OR (agent_role IN ('portfolio_aggregator','auction_cross_scope') AND strategy_code IS NULL)
  OR (agent_role IN ('strategy_entry_report','strategy_exit_report','strategy_confirmation') AND strategy_code IS NOT NULL)
  OR (agent_role IN ('data_pipeline','research_report'))
);
COMMENT ON COLUMN job_definition.agent_role IS '单策略入场/出场/确认、组合聚合、竞价跨域、数据或研究任务的受控角色';
UPDATE job_definition SET strategy_code=NULL, agent_role='auction_cross_scope',
  purpose='目标日最终集合竞价对全部持仓、有效策略关注和每日计划打板机会分别复核；持仓评估原预案风险，关注评估所属策略缺口，打板按打板策略专项门禁确认。',
  updated_at=now() WHERE code='auction_opportunity_assessment';
UPDATE strategy_document SET job_code=NULL, updated_at=now() WHERE code='limit_up_board';

CREATE TABLE auction_scope_assessment (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_job_run_id bigint NOT NULL REFERENCES job_run(id) ON DELETE RESTRICT,
  assessment_output_id bigint REFERENCES job_run_output(id) ON DELETE SET NULL,
  target_date date NOT NULL,
  target_key text NOT NULL CHECK (target_key ~ '^(position|attention):'),
  scope_kind text NOT NULL CHECK (scope_kind IN ('position','attention')),
  instrument_id bigint NOT NULL REFERENCES market_instrument(id) ON DELETE RESTRICT,
  attention_entry_id bigint REFERENCES pool_attention_entry(id) ON DELETE SET NULL,
  strategy_code text REFERENCES strategy_definition(code) ON DELETE RESTRICT,
  conclusion text NOT NULL CHECK (conclusion IN ('plan_aligned','risk_alert','confirmed','wait','give_up','unavailable')),
  metrics_summary text NOT NULL CHECK (length(btrim(metrics_summary)) BETWEEN 1 AND 1000),
  assessment_summary text NOT NULL CHECK (length(btrim(assessment_summary)) BETWEEN 1 AND 2000),
  data_status text NOT NULL CHECK (data_status IN ('ready','not_ready','missing','stale')),
  data_time timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_job_run_id,target_key),
  CHECK ((scope_kind='position' AND attention_entry_id IS NULL AND conclusion IN ('plan_aligned','risk_alert','unavailable'))
    OR (scope_kind='attention' AND attention_entry_id IS NOT NULL AND conclusion IN ('confirmed','wait','give_up','unavailable')))
);
CREATE INDEX auction_scope_assessment_active ON auction_scope_assessment (instrument_id,scope_kind,target_date DESC)
 WHERE status='active';
COMMENT ON TABLE auction_scope_assessment IS '独立竞价任务对持仓和每个策略关注来源的结构化评估；打板机会沿用专项竞价复核表';
COMMENT ON COLUMN auction_scope_assessment.id IS '结构化竞价评估主键';
COMMENT ON COLUMN auction_scope_assessment.source_job_run_id IS '关联竞价任务运行';
COMMENT ON COLUMN auction_scope_assessment.assessment_output_id IS '任务成功后关联的竞价结果';
COMMENT ON COLUMN auction_scope_assessment.target_date IS '竞价交易日';
COMMENT ON COLUMN auction_scope_assessment.scope_kind IS 'position=真实持仓，attention=关注来源';
COMMENT ON COLUMN auction_scope_assessment.instrument_id IS '被评价标的';
COMMENT ON COLUMN auction_scope_assessment.attention_entry_id IS '关注来源条目编号；持仓为空';
COMMENT ON COLUMN auction_scope_assessment.metrics_summary IS '实际竞价字段摘要';
COMMENT ON COLUMN auction_scope_assessment.assessment_summary IS '基于所属位置规则的研判摘要';
COMMENT ON COLUMN auction_scope_assessment.data_status IS '竞价数据就绪或缺口状态';
COMMENT ON COLUMN auction_scope_assessment.data_time IS '官方最终竞价数据时间';
COMMENT ON COLUMN auction_scope_assessment.status IS 'draft/active/superseded';
COMMENT ON COLUMN auction_scope_assessment.created_at IS '首次写入时间';
COMMENT ON COLUMN auction_scope_assessment.updated_at IS '最近状态变更时间';
COMMENT ON COLUMN auction_scope_assessment.target_key IS '位置唯一键：position:标的代码 或 attention:关注条目编号';
COMMENT ON COLUMN auction_scope_assessment.strategy_code IS '持仓管理策略或关注来源策略；竞价任务本身不绑定单一策略';
COMMENT ON COLUMN auction_scope_assessment.conclusion IS '持仓仅原计划匹配/风险升级/不可用；关注仅确认/等待/放弃/不可用；不记录成交';

WITH current_prompt AS (
 SELECT prompt.id,prompt.current_revision_id FROM job_prompt prompt
 WHERE prompt.code='auction_opportunity_assessment' AND prompt.status='active'
), definition(content) AS (VALUES ($prompt$# 集合竞价跨域研判

目标：以目标日最终集合竞价，分别复核全部真实持仓、关注池中每条有效来源及前一有效每日计划的打板机会。竞价是独立的跨域研判任务，不属于任何单一策略的入场或出场任务；不交易、不改持仓或关注。

1. 用 `tool_catalog` 加载 `auction_context_query`、`strategy_document_query`、`fetch_hithink_data`、`auction_assessment_write`；调用 `auction_context_query(date=目标日)` 一次取得交易日、有效计划、三类目标的全量集合及目标键。休市不拉取或写入；日历缺行的工作日以实际竞价数据核验。
2. 读取《投资总策略》、全部涉及的持仓/关注策略正文与《打板策略》；不得把打板阈值用于持仓或关注标的。
3. 对 `candidate_codes` 批量获取目标日最终 `auction_snapshot(stage=final)` 和 `auction_short_term_benchmark`，逐项核对日期、阶段、覆盖、状态及数据时间；缺失不得使用旧快照或模型补值。
4. 持仓按原 `position_action`、管理策略、风险线和竞价表现判断 `plan_aligned/risk_alert/unavailable`。只说明是否仍符合原预案，不新增交易动作。
5. 关注按每条来源策略的 `missing_signals`、失效条件和竞价证据判断 `confirmed/wait/give_up/unavailable`。同一标的多个策略关注分别评价；竞价单项不能替代策略完整入场门槛。
6. 打板机会严格按《打板策略》一字延续、换手晋级、分歧承接或放弃/数据不足分类；`signal_passed` 仅表示通过竞价门禁供用户自主决定，不代表成交。
7. 有任一目标时只调用一次 `auction_assessment_write`：`items` 完整覆盖打板机会，`scope_items` 完整覆盖持仓与关注来源，均使用上下文目标键；没有对应类别提交空数组。数据不足也逐项写 `unavailable`。任务成功后服务端统一激活草稿。
8. 输出数据时间和覆盖、三类逐项结论及缺口。不得用报告文字代替结构化写入。
$prompt$::text)), inserted AS (
 INSERT INTO job_prompt_revision (prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
 SELECT c.id,(SELECT max(revision_no)+1 FROM job_prompt_revision WHERE prompt_id=c.id),d.content,
        encode(sha256(convert_to(d.content,'UTF8')),'hex'),'user',c.current_revision_id,'竞价独立跨域完整研判'
 FROM current_prompt c CROSS JOIN definition d RETURNING id,prompt_id
)
UPDATE job_prompt p SET current_revision_id=i.id, updated_at=now() FROM inserted i WHERE p.id=i.prompt_id;
