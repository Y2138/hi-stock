-- 波段信号二次收敛：RSI14 超卖阈值 40 → 30 直接削减浅跌弱势信号；
-- 正式信号与接近候选合并为深度池，按深度评分（MA250 偏离 / 60 日跌幅 / 行业 20 日动量）
-- 降序排序，每日合计保留前 5 个。依据 2020-2026 事件研究：
-- 深度家族平均 R 极差 MA250 1.04、60 日跌幅 0.44、行业动量 0.48（覆盖期内复验单调），
-- RSI<25 档七年方向不变；浅跌（接近年线、跌幅不深、行业未跌透）质量最差。

WITH current AS (
  SELECT id,
         replace(
           replace(
             replace(
               content,
               '3. RSI14 < 40；',
               '3. RSI14 < 30；'
             ),
             '二次探底、MACD、MA20/MA60 位置和板块温度都不是波段硬条件。指数大跌带动全市场普跌产生的簇发信号辨识度低，正式信号、接近候选与复核候选每日合计不超过 10 个：正式信号按预期盈亏比降序、代码升序优先占用预算，剩余名额依次给信号质量最高的接近候选和存量复核候选。恰有一个条件未通过且仍具备确认窗口的标的先按唯一未达条件距阈值的归一化缺口计算信号质量，按分数降序、代码升序排序；未进入预算的达标和接近标的只计入筛除汇总，存量关注保留至到期、不续期。',
             '二次探底、MACD、MA20/MA60 位置和板块温度都不是波段硬条件。2020-2026 事件研究显示浅跌信号质量最低：RSI 收紧到 30 先削减弱势样本，再按深度评分二次过滤排序，正式信号、接近候选与复核候选每日合计只保留前 5 个。深度评分 0-5 分：相对 MA250 偏离小于等于 -35% 记 2 分、-35% 至 -15% 记 1 分；前 60 日跌幅小于等于 -25% 记 2 分、-25% 至 -12% 记 1 分；所属一级行业 20 日动量为负记 1 分；特征缺数计 0 分不阻断。池内按深度评分降序、MA250 更深优先、代码升序。恰有一个条件未通过且仍具备确认窗口的标的为接近候选，与正式信号共同参与深度池排序；未入选的达标和接近标的只计入筛除汇总，存量关注保留至到期、不续期。'
           ),
           '未持仓的正式信号写为“已符合”，入选接近候选与复核候选写为“即将符合”并保存唯一缺失条件；因每日信号总预算未入选但条件仍满足的标的保留原有关注至到期、不续期也不清除。',
           '未持仓的正式信号写为“已符合”，入选接近候选与复核候选写为“即将符合”并保存唯一缺失条件；因深度池名额未入选但条件仍满足的标的保留原有关注至到期、不续期也不清除。'
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
             replace(
               content,
               '正式信号、入选接近候选与复核候选、被每日信号总预算挤出的达标标的、已有持仓或价格上限抑制、关注变更；同时报告筛选前正式信号与接近候选总数。',
               '正式信号、入选接近候选与复核候选、被深度池名额挤出的达标标的、已有持仓或价格上限抑制、关注变更；同时报告筛选前正式信号与接近候选总数。'
             ),
             '正式和接近候选逐只列四条件、确认价、价格上限、初始止损及盈亏比。',
             '正式和接近候选逐只列四条件、确认价、价格上限、初始止损、盈亏比及深度评分构成（MA250 偏离、60 日跌幅、行业 20 日动量）。'
           ),
           '明确正式信号数、入选接近候选数/筛选前总数、总预算挤出数、关注变更和首要风险。',
           '明确正式信号数、入选接近候选数/筛选前总数、深度池挤出数、深度评分分布、关注变更和首要风险。'
         ) AS content
    FROM prompt
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT definition.prompt_id,
         (SELECT COALESCE(max(revision_no),0)+1 FROM job_prompt_revision WHERE prompt_id=definition.prompt_id),
         definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),'user',
         definition.base_revision_id,'波段RSI收紧至30并按深度评分每日保留前5'
    FROM definition RETURNING id,prompt_id
)
UPDATE job_prompt prompt SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE prompt.id=inserted.prompt_id;

UPDATE strategy_definition
   SET runtime_version=runtime_version+1,updated_at=now()
 WHERE code='swing';

UPDATE job_definition
   SET purpose='工作日盘后覆盖16个周期及新能源设备行业，从全部行业细分筛选高辨识度代表标的并把总扫描量固定在388只以内；RSI14 超卖阈值收紧至30，正式与接近候选按深度评分（MA250偏离、60日跌幅、行业动量）合并排序，每日合计保留前5个信号并维护关注来源。',
       updated_at=now()
 WHERE code='swing_signal_scan';

UPDATE strategy_state SET change_seq=change_seq+1,
 current_hash=encode(sha256(convert_to((SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id) FROM strategy_document WHERE code NOT IN ('copper_inventory_strategy','lithium_warehouse_strategy')),'UTF8')),'hex'),
 updated_at=now() WHERE singleton=1;
