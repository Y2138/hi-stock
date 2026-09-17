-- 0101_碳酸锂仓单研究定时任务.sql：每日同步仓单，周五由内置Agent评估低暴露防守链路。
INSERT INTO job_definition (code, name, cron, job_type, config, enabled) VALUES
  ('commodity_lithium_warehouse_sync', '碳酸锂仓单同步', '10 17 * * 1-5', 'datasource',
   '{"pipeline":"commodity_lithium_warehouse_sync","export_volume":false}', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO job_prompt (code, name, status)
VALUES ('lithium_warehouse_signal_review', '碳酸锂低暴露防守评估', 'active')
ON CONFLICT (code) DO NOTHING;

WITH prompt AS (
  SELECT id AS prompt_id, current_revision_id AS base_revision_id FROM job_prompt WHERE code='lithium_warehouse_signal_review'
), definition(content) AS (
  VALUES ($prompt$
# 碳酸锂低暴露防守评估

目标：按目标日解释服务端固定的《碳酸锂仓单防守仓位一版》以及已验证的MA20趋势修复入场、完整防守退出链路研究结果。只形成研究评估，不交易、不改持仓、不入池、不修改策略或参数。

## 执行流程

1. 先用 `tool_catalog` 只加载 `lithium_warehouse_signal_query`。
2. 只调用一次 `lithium_warehouse_signal_query(date=目标日)`；公式、五只固定公司、10个百分点缓冲、目标仓位和已执行动作以工具结果为准，不自行重算。
3. 核对仓单报告日、发布时间、数据是否陈旧、有效公司是否完整；出现缺口时降低结论强度，不用Web或常识补值。
4. 区分原始目标仓位和当前已执行仓位。未跨过10个百分点缓冲时，明确写“保持，不调仓”。
5. 任务只解释研究目标仓位和研究级个股状态，不输出真实账户交易指令、收益承诺或强制买卖建议。

## 输出

输出目标日、规则版本、仓单变化、仓单逆百分位、原始目标、已执行目标、现金比例、五只公司等权比例、最近调仓和数据缺口。说明该引擎为B+C1+G研究候选，移动止损及仓位结果仅为研究证据。

末尾必须输出 `## 结论摘要`，用2至5条短句概括当前动作、仓单日期、目标仓位和主要风险。
$prompt$)
), inserted AS (
  INSERT INTO job_prompt_revision (prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt.prompt_id,(SELECT COALESCE(max(x.revision_no),0)+1 FROM job_prompt_revision x WHERE x.prompt_id=prompt.prompt_id),definition.content,
         encode(sha256(convert_to(definition.content,'UTF8')),'hex'),'user',prompt.base_revision_id,'固化碳酸锂仓单低暴露防守研究评估'
    FROM prompt CROSS JOIN definition
   WHERE NOT EXISTS (SELECT 1 FROM job_prompt_revision x WHERE x.prompt_id=prompt.prompt_id AND x.sha256=encode(sha256(convert_to(definition.content,'UTF8')),'hex'))
  RETURNING prompt_id,id
), selected AS (
  SELECT prompt_id,id FROM inserted
  UNION ALL
  SELECT prompt.prompt_id,revision.id FROM prompt CROSS JOIN definition JOIN job_prompt_revision revision ON revision.prompt_id=prompt.prompt_id AND revision.sha256=encode(sha256(convert_to(definition.content,'UTF8')),'hex') WHERE NOT EXISTS (SELECT 1 FROM inserted) LIMIT 1
)
UPDATE job_prompt prompt SET current_revision_id=selected.id,updated_at=now() FROM selected WHERE prompt.id=selected.prompt_id;

INSERT INTO job_definition (code,name,cron,job_type,config,prompt_id,model_id,enabled)
SELECT 'lithium_warehouse_signal_review','碳酸锂低暴露防守评估','30 17 * * 5','agent_flow','{}'::jsonb,prompt.id,NULL,true
  FROM job_prompt prompt WHERE prompt.code='lithium_warehouse_signal_review'
ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name,cron=EXCLUDED.cron,job_type=EXCLUDED.job_type,config=EXCLUDED.config,prompt_id=EXCLUDED.prompt_id,model_id=EXCLUDED.model_id,enabled=EXCLUDED.enabled,updated_at=now();
