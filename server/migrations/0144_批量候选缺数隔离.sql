-- 候选扫描按标的隔离异常输入；全局数据源和组合持仓风险缺口仍须显式失败。
WITH addition(code, section) AS (VALUES
  ('limit_up_board', $section$

## 批量评分完整性

单只标的停牌、缺少历史日线、报价或其他必要特征时，仅剔除该标的并记录代码和原因，不用中性分数补造正式信号。题材统计按有真实有效输入的成员计算，不因一只成员缺数否定其他成员；全部候选不可评估或评分基准失效时明确报告不可用。最多四只正式机会仅从完整有效候选排序产生。
$section$::text),
  ('first_board_advance_strategy', $section$

## 批量取数隔离

盘中快照逐只核对行情和最终竞价事实；单只缺失仅跳过该标的并记录原因，其他标的继续按原口径排序。全部候选不可评估或供应商数据日不符时，结果不可作为正式信号。不得用缺失报价推断一字板或成交可行性。
$section$::text),
  ('value_anchor_strategy', $section$

## 候选缺口隔离

Top候选逐只核对日线、公司行动和财务质量；单只缺少必要事实只跳过该标的，不使其他完整候选失效。全部候选不可评估、排名过期或交易日历不可用时明确报告数据缺口，不生成正式关注。
$section$::text)
)
UPDATE strategy_document document
   SET content=document.content || addition.section,
       sha256=encode(sha256(convert_to(document.content || addition.section,'UTF8')),'hex'),
       updated_at=now()
  FROM addition WHERE document.code=addition.code;

-- 全市场状态需要足够覆盖，不能因一只一级行业缺数将九成以上可用样本作废。
WITH section(content) AS (VALUES ($section$

## 批量市场数据覆盖

一级行业综合状态按点时可用的真实行业日线等权计算，并列出剔除的缺数行业；覆盖不足九成时不形成综合市场状态，不将局部样本冒充全市场。持仓的专属/兜底退出规则、整批数据源失效和必须覆盖的风险事实不能按候选缺数规则静默跳过。
$section$::text))
UPDATE strategy_document document
   SET content=document.content || section.content,
       sha256=encode(sha256(convert_to(document.content || section.content,'UTF8')),'hex'),
       updated_at=now()
  FROM section WHERE document.role='portfolio';

UPDATE strategy_state SET change_seq=change_seq+1,
  current_hash=encode(sha256(convert_to((SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id)
    FROM strategy_document WHERE code NOT IN ('copper_inventory_strategy','lithium_warehouse_strategy')),'UTF8')),'hex'),
  updated_at=now() WHERE singleton=1;

WITH prompt AS (
  SELECT p.id AS prompt_id,p.current_revision_id AS base_revision_id,r.revision_no,r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id
   WHERE p.code='limit_up_close_scan'
), definition AS (
  SELECT prompt_id,base_revision_id,revision_no,content || $section$

逐只缺失的候选只在 `skipped` 中说明代码与缺口，不计入 `gaps`、`candidate_count` 或 `signals`，也不得要求补造停牌日K线。只在全体不可评估或全局基准/来源失效时报告任务级缺口；评估成功后核对 `opportunity_write.replaced` 与有效正式信号数一致。
$section$::text AS content FROM prompt
), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,revision_no+1,content,encode(sha256(convert_to(content,'UTF8')),'hex'),
         'user',base_revision_id,'逐标的缺数隔离与批量任务完成口径'
    FROM definition RETURNING prompt_id,id
)
UPDATE job_prompt prompt SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE prompt.id=inserted.prompt_id;

UPDATE strategy_definition
   SET runtime_version=runtime_version+1,updated_at=now()
 WHERE code IN ('limit_up','first_board_advance','value_anchor');
