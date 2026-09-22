-- 波段接近候选只保留最接近正式信号的前5只，避免关注和报告被低质量候选淹没。

WITH current AS (
  SELECT id,
         replace(
           replace(
             content,
             '二次探底、MACD、MA20/MA60 位置和板块温度都不是波段硬条件。恰有一个条件未通过且仍具备确认窗口的标的是接近候选，其他标的只计入筛除汇总。',
             '二次探底、MACD、MA20/MA60 位置和板块温度都不是波段硬条件。恰有一个条件未通过且仍具备确认窗口的标的先按唯一未达条件距阈值的归一化缺口计算信号质量，按分数降序、代码升序只保留前5只为接近候选，其他标的只计入筛除汇总。'
           ),
           '未持仓的正式信号写为“已符合”，接近候选写为“即将符合”并保存唯一缺失条件；每轮成功扫描按 `swing` 策略来源完整对账。',
           '未持仓的正式信号写为“已符合”，信号质量前5的接近候选写为“即将符合”并保存唯一缺失条件；每轮成功扫描按 `swing` 策略来源完整对账。'
         ) AS content
    FROM strategy_document
   WHERE code='swing_strategy'
), updated AS (
  SELECT id,content,encode(sha256(convert_to(content,'UTF8')),'hex') AS sha256 FROM current
)
UPDATE strategy_document document
   SET content=updated.content,sha256=updated.sha256,updated_at=now()
  FROM updated WHERE document.id=updated.id;

WITH prompt AS (
  SELECT prompt.id AS prompt_id,prompt.current_revision_id AS base_revision_id,revision.content
    FROM job_prompt prompt JOIN job_prompt_revision revision ON revision.id=prompt.current_revision_id
   WHERE prompt.code='swing_signal_scan'
), definition AS (
  SELECT prompt_id,base_revision_id,
         replace(
           replace(
             content,
             '正式信号、接近候选、已有持仓或价格上限抑制、关注变更。',
             '正式信号、信号质量前5的接近候选、已有持仓或价格上限抑制、关注变更；同时报告筛选前接近候选总数。'
           ),
           '明确正式信号数、接近候选数、关注变更和首要风险。',
           '明确正式信号数、入选接近候选数/筛选前总数、关注变更和首要风险。'
         ) AS content
    FROM prompt
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT definition.prompt_id,
         (SELECT COALESCE(max(revision_no),0)+1 FROM job_prompt_revision WHERE prompt_id=definition.prompt_id),
         definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),'user',
         definition.base_revision_id,'波段接近候选按信号质量收敛至前5只'
    FROM definition RETURNING id,prompt_id
)
UPDATE job_prompt prompt SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE prompt.id=inserted.prompt_id;

UPDATE strategy_definition
   SET runtime_version=runtime_version+1,updated_at=now()
 WHERE code='swing';

UPDATE job_definition
   SET purpose='工作日盘后覆盖16个周期及新能源设备行业，从全部行业细分筛选高辨识度代表标的并把总扫描量固定在388只以内，生成波段正式信号与信号质量前5的接近候选并维护关注来源。',
       updated_at=now()
 WHERE code='swing_signal_scan';
