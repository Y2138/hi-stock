-- 盘中涨停梯队以任务执行时的当前涨停池为准，不再硬排除一字板和10:30后封板。
UPDATE strategy_document
   SET content=replace(
         replace(content,
           '扫描沪深主板、非ST、非未开板新股、10:45仍在涨停池且当日连板数不低于1的股票，同时读取炸板池判断高位核心是否已开板。排除09:25后仍未打开的一字板；首次封板需在09:30至10:30之间。',
           '扫描沪深主板、非ST、非未开板新股、执行时仍在涨停池且当日连板数不低于1的股票，同时读取炸板池判断高位核心是否已开板。当时涨停池即为梯队数据源，一字板、10:30后至扫描时间封板的标的均不作硬排除。'),
         '优先级依次考虑题材角色、当前连板高度、10:45题材宽度、首次封板时间、封单/流通市值和封单保持率。',
         '优先级依次考虑题材角色、当前连板高度、扫描时题材宽度、首次封板时间、封单/流通市值和封单保持率。一字板按“一致性高、盘中分歧小”评价强度，同时单独标记排队成交率低及开板后被动成交风险；10:30后封板仅在排序中反映封板偏晚，不因时间单独淘汰。')
 WHERE code='first_board_advance_strategy';

UPDATE strategy_document
   SET sha256=encode(sha256(convert_to(content,'UTF8')),'hex'),updated_at=now()
 WHERE code='first_board_advance_strategy';

WITH prompt AS (
  SELECT p.id AS prompt_id,p.current_revision_id AS base_revision_id,r.revision_no,r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id
   WHERE p.code='first_board_intraday_scan'
), definition AS (
  SELECT prompt_id,base_revision_id,revision_no,content || $section$

当次执行时的当前涨停池就是完整梯队数据源：不得排除一字板或10:30后至扫描时间封板的标的。一字板按高一致性、低盘中分歧解释强度，但必须另行说明排队难成交和开板后被动成交风险；晚封板只作排序因素，不作资格门禁。
$section$::text AS content FROM prompt
), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,revision_no+1,content,encode(sha256(convert_to(content,'UTF8')),'hex'),
         'user',base_revision_id,'盘中梯队改用执行时点全量涨停池'
    FROM definition RETURNING prompt_id,id
)
UPDATE job_prompt prompt SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE prompt.id=inserted.prompt_id;

UPDATE strategy_definition
   SET runtime_version=runtime_version+1,updated_at=now()
 WHERE code='first_board_advance';

UPDATE strategy_state SET change_seq=change_seq+1,
  current_hash=encode(sha256(convert_to((SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id)
    FROM strategy_document WHERE code NOT IN ('copper_inventory_strategy','lithium_warehouse_strategy')),'UTF8')),'hex'),
  updated_at=now() WHERE singleton=1;
