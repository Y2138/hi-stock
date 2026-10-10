-- 盘中涨停梯队收敛推送信号：候选清单仍完整保留用于收盘与竞价二次复核，
-- 但必须在全部判断维度综合后选出且仅选出一只当日最值得排队的首选标的，
-- 并置于结论摘要第一句；无合格首选时明确判定，不得并列或多选。

WITH addition(code, section) AS (VALUES
  ('first_board_advance_strategy', $section$

## 唯一首选排队标的

正式候选确定后，综合题材角色、连板高度与全市场高度结构、题材宽度与梯队层数、封单强度与封单保持率、首次封板时间、市场炸板率和排队可成交性，选出且仅选出一只当日最值得排队的首选标的，逐项说明入选理由，并给出一句话的其余候选落选主因。全部候选存在硬伤（高位核心已炸板且无低位承接、一字板排队成交率过低等）时明确判定无首选，不得并列或多选。候选清单仍完整保留用于收盘二次复核；首选不改变各候选自身失效条件，也不构成自动下单。
$section$::text)
)
UPDATE strategy_document document
   SET content=document.content || addition.section,
       sha256=encode(sha256(convert_to(document.content || addition.section,'UTF8')),'hex'),
       updated_at=now()
  FROM addition WHERE document.code=addition.code;

WITH prompt AS (
  SELECT p.id AS prompt_id,p.current_revision_id AS base_revision_id,r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id
   WHERE p.code='first_board_intraday_scan'
), definition AS (
  SELECT prompt_id,base_revision_id,
         replace(
           content,
           '6. 最终输出必须包含 `## 结论摘要`，不得补造数据或给出自动下单、仓位建议。',
           '6. 在正式候选中综合题材角色、连板高度与全市场高度结构、题材宽度与梯队层数、封单强度与封单保持率、首次封板时间、市场炸板率和排队可成交性，选出且仅选出一只当日最值得排队的首选标的，写明入选理由和其余候选各自落选的主因；全部候选存在硬伤（高位核心已炸板且无低位承接、一字板排队成交率过低等）时明确判定无首选，不得并列或多选。
7. 最终输出必须包含 `## 结论摘要`，第一句必须是首选排队标的（代码、名称和最关键的一条理由）或明确的“无首选”；落选候选在摘要中各用短语带过，不逐只展开。不得补造数据或给出自动下单、仓位建议。'
         ) AS content
    FROM prompt
), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT definition.prompt_id,
         (SELECT COALESCE(max(revision_no),0)+1 FROM job_prompt_revision WHERE prompt_id=definition.prompt_id),
         definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),'user',
         definition.base_revision_id,'候选内选出唯一首选排队标的并收敛结论摘要'
    FROM definition RETURNING id,prompt_id
)
UPDATE job_prompt prompt SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE prompt.id=inserted.prompt_id;

UPDATE strategy_definition
   SET runtime_version=runtime_version+1,updated_at=now()
 WHERE code='first_board_advance';

UPDATE job_definition
   SET purpose='工作日10:45拉取独立盘中涨停、炸板、行情与竞价快照，分析首板和高位连板并保留最多4只先手候选，在候选内选出唯一最值得排队的首选标的；收盘涨停接力负责二次复核。',
       updated_at=now()
 WHERE code='first_board_intraday_scan';

UPDATE strategy_state SET change_seq=change_seq+1,
 current_hash=encode(sha256(convert_to((SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id) FROM strategy_document WHERE code NOT IN ('copper_inventory_strategy','lithium_warehouse_strategy')),'UTF8')),'hex'),
 updated_at=now() WHERE singleton=1;
