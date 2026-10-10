-- 波段准入二次收紧（基于 RSI<30 池内复验）：
-- 1. 缩量条件 0.85 → 0.70，或门豁免 MA250 偏离 ≤ -35% 的深度标的：
--    「缩量<0.70 或 MA250≤-35%」口径下胜率 39.5%→43.1%、日度平均R +0.261→+0.434；
-- 2. 行业 20 日动量非负（≥0）的候选一票否决正式/接近资格，降级为行业逆风复核：
--    RSI<30 池内该档胜率 32.4%、平均 R 为负，且仅损失 7% 信号量。

WITH current AS (
  SELECT id,
         replace(
           replace(
             content,
             '1. 成交量 < 5 日均量 × 0.85；',
             '1. 成交量 < 5 日均量 × 0.70；相对 MA250 偏离 ≤ -35% 的深度标的豁免缩量要求；'
           ),
           '特征缺数计 0 分不阻断。池内按深度评分降序、MA250 更深优先、代码升序。',
           '特征缺数计 0 分不阻断。所属一级行业 20 日动量非负的候选不进入正式信号与接近候选，仅列为行业逆风复核；行业动量缺数时不降级。池内按深度评分降序、MA250 更深优先、代码升序。'
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
               '正式信号、入选接近候选与复核候选、被深度池名额挤出的达标标的、已有持仓或价格上限抑制、关注变更；同时报告筛选前正式信号与接近候选总数。',
               '正式信号、入选接近候选与复核候选、被深度池名额挤出的达标标的、行业逆风降级复核标的、已有持仓或价格上限抑制、关注变更；同时报告筛选前正式信号与接近候选总数。'
             ),
             '正式和接近候选逐只列四条件、确认价、价格上限、初始止损、盈亏比及深度评分构成（MA250 偏离、60 日跌幅、行业 20 日动量）。',
             '正式和接近候选逐只列四条件、确认价、价格上限、初始止损、盈亏比及深度评分构成（MA250 偏离、60 日跌幅、行业 20 日动量）；缩量条件按 0.70 或深度豁免解释，行业 20 日动量非负的候选单独列为行业逆风复核。'
           ),
           '明确正式信号数、入选接近候选数/筛选前总数、深度池挤出数、深度评分分布、关注变更和首要风险。',
           '明确正式信号数、入选接近候选数/筛选前总数、深度池挤出数、行业逆风降级数、深度评分分布、关注变更和首要风险。'
         ) AS content
    FROM prompt
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT definition.prompt_id,
         (SELECT COALESCE(max(revision_no),0)+1 FROM job_prompt_revision WHERE prompt_id=definition.prompt_id),
         definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),'user',
         definition.base_revision_id,'波段缩量或门与行业逆风降级复核'
    FROM definition RETURNING id,prompt_id
)
UPDATE job_prompt prompt SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE prompt.id=inserted.prompt_id;

UPDATE strategy_definition
   SET runtime_version=runtime_version+1,updated_at=now()
 WHERE code='swing';

UPDATE job_definition
   SET purpose='工作日盘后覆盖16个周期及新能源设备行业，从全部行业细分筛选高辨识度代表标的并把总扫描量固定在388只以内；RSI14 超卖阈值收紧至30，缩量条件按 0.70 或 MA250 深度豁免执行，正式与接近候选按深度评分（MA250偏离、60日跌幅、行业动量）合并排序，行业动量非负降级为复核，每日合计保留前5个信号并维护关注来源。',
       updated_at=now()
 WHERE code='swing_signal_scan';

UPDATE strategy_state SET change_seq=change_seq+1,
 current_hash=encode(sha256(convert_to((SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id) FROM strategy_document WHERE code NOT IN ('copper_inventory_strategy','lithium_warehouse_strategy')),'UTF8')),'hex'),
 updated_at=now() WHERE singleton=1;
