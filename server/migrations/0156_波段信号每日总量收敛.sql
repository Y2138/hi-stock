-- 波段信号每日总量收敛：指数大跌带动全市场普跌时簇发信号辨识度低，
-- 正式信号、接近候选与复核候选每日合计不超过 10 个。
-- 正式信号按预期盈亏比降序优先占用预算，剩余名额给信号质量前5接近候选和存量复核候选；
-- 被预算挤出但条件仍满足的标的保留原有关注至到期，不续期也不清退。

WITH current AS (
  SELECT id,
         replace(
           replace(
             content,
             '二次探底、MACD、MA20/MA60 位置和板块温度都不是波段硬条件。恰有一个条件未通过且仍具备确认窗口的标的先按唯一未达条件距阈值的归一化缺口计算信号质量，按分数降序、代码升序只保留前5只为接近候选，其他标的只计入筛除汇总。',
             '二次探底、MACD、MA20/MA60 位置和板块温度都不是波段硬条件。指数大跌带动全市场普跌产生的簇发信号辨识度低，正式信号、接近候选与复核候选每日合计不超过 10 个：正式信号按预期盈亏比降序、代码升序优先占用预算，剩余名额依次给信号质量最高的接近候选和存量复核候选。恰有一个条件未通过且仍具备确认窗口的标的先按唯一未达条件距阈值的归一化缺口计算信号质量，按分数降序、代码升序排序；未进入预算的达标和接近标的只计入筛除汇总，存量关注保留至到期、不续期。'
           ),
           '未持仓的正式信号写为“已符合”，信号质量前5的接近候选写为“即将符合”并保存唯一缺失条件；每轮成功扫描按 `swing` 策略来源完整对账。无信号时清除已失效的波段策略关注，不影响其他策略来源。',
           '未持仓的正式信号写为“已符合”，入选接近候选与复核候选写为“即将符合”并保存唯一缺失条件；因每日信号总预算未入选但条件仍满足的标的保留原有关注至到期、不续期也不清除。每轮成功扫描按 `swing` 策略来源完整对账，无信号时清除已失效的波段策略关注，不影响其他策略来源。'
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
             '正式信号、信号质量前5的接近候选、已有持仓或价格上限抑制、关注变更；同时报告筛选前接近候选总数。',
             '正式信号、入选接近候选与复核候选、被每日信号总预算挤出的达标标的、已有持仓或价格上限抑制、关注变更；同时报告筛选前正式信号与接近候选总数。'
           ),
           '明确正式信号数、入选接近候选数/筛选前总数、关注变更和首要风险。',
           '明确正式信号数、入选接近候选数/筛选前总数、总预算挤出数、关注变更和首要风险。'
         ) AS content
    FROM prompt
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT definition.prompt_id,
         (SELECT COALESCE(max(revision_no),0)+1 FROM job_prompt_revision WHERE prompt_id=definition.prompt_id),
         definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),'user',
         definition.base_revision_id,'波段信号每日总量收敛至10个'
    FROM definition RETURNING id,prompt_id
)
UPDATE job_prompt prompt SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE prompt.id=inserted.prompt_id;

UPDATE strategy_definition
   SET runtime_version=runtime_version+1,updated_at=now()
 WHERE code='swing';

UPDATE job_definition
   SET purpose='工作日盘后覆盖16个周期及新能源设备行业，从全部行业细分筛选高辨识度代表标的并把总扫描量固定在388只以内，按预期盈亏比优先生成每日合计不超过10个的波段正式信号、接近与复核候选并维护关注来源。',
       updated_at=now()
 WHERE code='swing_signal_scan';

UPDATE strategy_state SET change_seq=change_seq+1,
 current_hash=encode(sha256(convert_to((SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id) FROM strategy_document WHERE code NOT IN ('copper_inventory_strategy','lithium_warehouse_strategy')),'UTF8')),'hex'),
 updated_at=now() WHERE singleton=1;
