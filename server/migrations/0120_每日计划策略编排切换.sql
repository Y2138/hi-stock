-- 0120_每日计划策略编排切换.sql：每日计划改用统一策略编排，并固化每笔预案的策略与评估运行来源。

ALTER TABLE daily_plan_playbook
  ADD COLUMN strategy_code text REFERENCES strategy_definition(code) ON DELETE RESTRICT,
  ADD COLUMN strategy_runtime_version integer CHECK (strategy_runtime_version IS NULL OR strategy_runtime_version > 0),
  ADD COLUMN primary_evaluation_run_id bigint REFERENCES strategy_evaluation_run(id) ON DELETE SET NULL,
  ADD COLUMN fallback_evaluation_run_id bigint REFERENCES strategy_evaluation_run(id) ON DELETE SET NULL,
  ADD COLUMN primary_action text CHECK (primary_action IS NULL OR primary_action IN ('hold','observe','reduce','exit')),
  ADD COLUMN fallback_action text CHECK (fallback_action IS NULL OR fallback_action IN ('hold','observe','reduce','exit')),
  ADD COLUMN effective_action text CHECK (effective_action IS NULL OR effective_action IN ('hold','observe','reduce','exit')),
  ADD COLUMN evaluation_status text CHECK (evaluation_status IS NULL OR evaluation_status IN ('success','partial','failed','waiting')),
  ADD COLUMN evaluation_data_date date,
  ADD COLUMN evaluation_missing jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evaluation_missing)='array');

-- 存量结构化预案没有策略运行时引用，先保留原动作作为兼容最终动作；新写入由领域 service 固化完整关联。
UPDATE daily_plan_playbook
   SET effective_action = action,
       evaluation_status = 'success'
 WHERE item_kind = 'position_action';

ALTER TABLE daily_plan_playbook
  ADD CONSTRAINT daily_plan_playbook_strategy_shape_check CHECK (
    (item_kind <> 'position_action')
    OR (effective_action IS NOT NULL AND (strategy_code IS NULL OR strategy_runtime_version IS NOT NULL))
  );

COMMENT ON COLUMN daily_plan_playbook.strategy_code IS '持仓预案的管理策略或观察机会所属策略';
COMMENT ON COLUMN daily_plan_playbook.strategy_runtime_version IS '生成预案时锁定的策略运行契约版本';
COMMENT ON COLUMN daily_plan_playbook.primary_evaluation_run_id IS '主策略结构化评估运行';
COMMENT ON COLUMN daily_plan_playbook.fallback_evaluation_run_id IS '显式兜底策略结构化评估运行';
COMMENT ON COLUMN daily_plan_playbook.primary_action IS '主策略动作';
COMMENT ON COLUMN daily_plan_playbook.fallback_action IS '兜底策略动作';
COMMENT ON COLUMN daily_plan_playbook.effective_action IS '服务端按固定优先级合并后的最终动作';
COMMENT ON COLUMN daily_plan_playbook.evaluation_status IS '本行依赖的评估覆盖状态';
COMMENT ON COLUMN daily_plan_playbook.evaluation_data_date IS '本行评估实际使用的数据日';
COMMENT ON COLUMN daily_plan_playbook.evaluation_missing IS '本行尚未覆盖的数据或执行事实';

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,prompt.current_revision_id AS base_revision_id
    FROM job_prompt prompt WHERE prompt.code='daily_plan_flow' AND prompt.status='active'
), definition(content) AS (VALUES ($prompt$
# 每日交易计划

目标：按目标日当前最终策略运行时和数据库事实生成下一交易日计划。不得交易、修改持仓或改写策略。

## 执行流程

1. 用 `tool_catalog` 加载 `strategy_document_query`、`job_context_query`、`daily_plan_strategy_query`、`daily_plan_write`。
2. 读取《投资总策略》以及 `daily_plan_strategy_query` 返回的 `required_strategy_documents`；不得读取历史策略补参数。
3. 只调用一次 `daily_plan_strategy_query(date=目标日)`。服务端自动发现入场策略、观察策略、组合叠加策略、持仓主策略和兜底策略，并复用结构化评估运行、维护策略关注集合、合并持仓最终动作。
4. 不再逐个调用垂直信号工具，不手算行情、触发位、关注集合或主/兜底优先级。
5. 如需连续性，只用 `job_context_query` 读取最近成功计划；历史动作必须以本轮统一结果重新确认。

## 计划写入

1. 市场状态、风险门禁、策略覆盖、入场信号、观察机会、关注变更、持仓主策略、兜底策略和最终动作全部以统一工具结果为准。
2. `status=partial` 时逐项报告 `gaps`；未绑定持仓、缺少评估器或等待中的评估运行不得描述为完整覆盖。
3. 有 `playbook_items` 时只调用一次 `daily_plan_write`，原样提交服务端生成的结构化行；不得改变动作、价格、策略编码、评估运行或优先级。空数组时不调用并明确无结构化预案。
4. 正式入场信号和接近候选按策略分组输出；观察机会不写成自动开仓。关注池已由服务端按策略完成对账，Agent 只解释 `attention_changes`。

## 输出

输出紧凑 Markdown：数据日、市场与风险门禁、策略覆盖、全部持仓预案、正式入场信号、接近候选、观察机会、关注变更、评估复用和数据缺口。每笔持仓必须标注管理策略、主策略动作、兜底动作、最终动作和触发位。注明策略快照与数据截止日，结果由系统保存到 `job_run_output`。
$prompt$::text)), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT current_prompt.prompt_id,
         (SELECT COALESCE(max(revision_no),0)+1 FROM job_prompt_revision WHERE prompt_id=current_prompt.prompt_id),
         definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),'user',
         current_prompt.base_revision_id,'每日计划切换为策略运行时统一编排'
    FROM current_prompt CROSS JOIN definition RETURNING id,prompt_id
)
UPDATE job_prompt prompt SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE prompt.id=inserted.prompt_id;
