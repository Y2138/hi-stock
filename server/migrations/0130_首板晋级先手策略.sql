-- 0130_首板晋级先手策略.sql：10:45 单点盘中扫描独立于收盘市场结构，次日竞价按持有晋级语义复核。
CREATE TABLE first_board_intraday_snapshot (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scan_date date NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  source_timestamp timestamptz NOT NULL,
  limit_up_count integer NOT NULL CHECK (limit_up_count>=0),
  limit_break_count integer NOT NULL CHECK (limit_break_count>=0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object')
);
CREATE INDEX first_board_intraday_snapshot_date ON first_board_intraday_snapshot(scan_date DESC,captured_at DESC);
COMMENT ON TABLE first_board_intraday_snapshot IS '首板晋级先手策略盘中独立快照；不得覆盖收盘市场结构事实';

UPDATE strategy_definition SET name='涨停接力观察策略',updated_at=now() WHERE code='limit_up';
UPDATE strategy_document SET title='涨停接力策略：抱团接力与题材主升',
  content=replace(content,'# 打板策略：Daban-v1.4 抱团接力与题材主升','# 涨停接力策略：Daban-v1.4 抱团接力与题材主升'),
  sha256=encode(sha256(convert_to(replace(content,'# 打板策略：Daban-v1.4 抱团接力与题材主升','# 涨停接力策略：Daban-v1.4 抱团接力与题材主升'),'UTF8')),'hex'),updated_at=now()
 WHERE code='limit_up_board';

WITH definition(content) AS (VALUES ($strategy$
# 首板晋级先手策略

> 职责：工作日10:45使用当时盘中快照识别首板先手候选，形成前瞻性验证样本；不自动下单、不决定仓位、不覆盖收盘市场结构。

## 一、扫描口径

只扫描沪深主板、非ST、非未开板新股、当日连板数为1且10:45仍在涨停池的股票。排除09:25开盘一字；首次封板需在09:30至10:30之间。每日最多保留2只。

排序依次使用首次封板时间、10:45题材宽度、当前封单/流通市值、当前封单/当日最大封单。市场涨停数、炸板数和炸板率作为环境风险，不使用收盘后才可知道的最终数据。

## 二、竞价补充因子

次日竞价沿用价格、买卖未匹配方向、竞价换手和数据就绪门禁，只增加未匹配量/竞价量、竞价量占昨日成交量、同题材竞价共振作为排序和风险证据，不在初版增加新硬阈值。

## 三、次日语义

本策略假定候选在首板日尝试排队，次日竞价用于判断已有先手的晋级强弱，不复用“高开超过5%则放弃入场”的语义。结构化结论只允许：晋级强、正常晋级、分歧持有、转弱退出、数据不足。

## 四、验证边界

所有候选无论是否实际成交都必须保留。实际排队、成交和退出以用户记录为准。首轮至少积累20个交易日后统一评审，不因短期结果临时修改时间或阈值。
$strategy$::text))
INSERT INTO strategy_document(code,title,role,injection_order,job_code,content,sha256)
SELECT 'first_board_advance_strategy','首板晋级先手策略','task',46,'first_board_intraday_scan',content,encode(sha256(convert_to(content,'UTF8')),'hex') FROM definition;

INSERT INTO strategy_definition(code,name,strategy_type,strategy_document_code,status,allow_new_entry,entry_evaluator_code,exit_evaluator_code,context_evaluator_code,fallback_strategy_code,exit_policy_mode,daily_plan_scope,attention_policy)
VALUES ('first_board_advance','首板晋级先手策略','observation','first_board_advance_strategy','active',false,'first_board_advance_entry_v1',NULL,NULL,NULL,'none','{}'::text[],'none');

INSERT INTO job_prompt(code,name,status) VALUES ('first_board_intraday_scan','首板先手盘中扫描','active');
WITH p AS (SELECT id,current_revision_id FROM job_prompt WHERE code='first_board_intraday_scan'), d(content) AS (VALUES ($prompt$
# 首板先手盘中扫描

目标：在目标交易日10:45按当前最终策略《首板晋级先手策略》生成可追溯的前瞻性候选报告，不自动交易；最终正文保存到 `job_run_output`。

1. 调用 `strategy_document_query` 读取《投资总策略》和《首板晋级先手策略》。
2. 调用 `strategy_evaluation_query(strategy_code=first_board_advance,phase=entry,date=目标日)`；盘中取数、快照保存、资格和排序均以服务端结果为准，不用通用查询重算。
3. 完整列出正式候选；逐只说明首次封板时间、题材宽度、封单/流通市值、封单保持率、竞价未匹配比例、竞价量占昨日成交量、市场炸板率、晋级质量与排队可成交性。最多2只；空集合时明确无合格候选。
4. 结果只表示首板先手研究信号。收盘最终涨停和炸板仍以17:10市场结构同步为准。
5. 最终输出必须包含 `## 结论摘要`，不得补造数据或给出自动下单、仓位建议。
$prompt$::text))
INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
SELECT p.id,1,d.content,encode(sha256(convert_to(d.content,'UTF8')),'hex'),'user',p.current_revision_id,'新增10:45首板先手盘中扫描' FROM p CROSS JOIN d;
UPDATE job_prompt p SET current_revision_id=r.id,updated_at=now() FROM job_prompt_revision r WHERE p.code='first_board_intraday_scan' AND r.prompt_id=p.id AND r.revision_no=1;
INSERT INTO job_definition(code,name,cron,job_type,config,prompt_id,enabled,purpose,phase,priority,strategy_code,agent_role)
SELECT 'first_board_intraday_scan','首板先手盘中扫描','45 10 * * 1-5','agent_flow','{}'::jsonb,p.id,true,
 '工作日10:45拉取独立盘中涨停、炸板、行情与竞价快照，识别最多2只首板晋级先手候选；不覆盖收盘市场结构。','盘中',305,'first_board_advance','strategy_entry_report'
FROM job_prompt p WHERE p.code='first_board_intraday_scan';

ALTER TABLE auction_scope_assessment DROP CONSTRAINT auction_scope_assessment_target_key_check;
ALTER TABLE auction_scope_assessment ADD CONSTRAINT auction_scope_assessment_target_key_check CHECK (target_key ~ '^(position|attention|first_board):');
ALTER TABLE auction_scope_assessment DROP CONSTRAINT auction_scope_assessment_scope_kind_check;
ALTER TABLE auction_scope_assessment ADD CONSTRAINT auction_scope_assessment_scope_kind_check CHECK (scope_kind IN ('position','attention','first_board'));
ALTER TABLE auction_scope_assessment DROP CONSTRAINT auction_scope_assessment_conclusion_check;
ALTER TABLE auction_scope_assessment ADD CONSTRAINT auction_scope_assessment_conclusion_check CHECK (conclusion IN ('plan_aligned','risk_alert','confirmed','wait','give_up','promotion_strong','promotion_normal','divergence_hold','weak_exit','unavailable'));
ALTER TABLE auction_scope_assessment DROP CONSTRAINT auction_scope_assessment_check;
ALTER TABLE auction_scope_assessment ADD CONSTRAINT auction_scope_assessment_check CHECK (
 (scope_kind='position' AND attention_entry_id IS NULL AND conclusion IN ('plan_aligned','risk_alert','unavailable')) OR
 (scope_kind='attention' AND attention_entry_id IS NOT NULL AND conclusion IN ('confirmed','wait','give_up','unavailable')) OR
 (scope_kind='first_board' AND attention_entry_id IS NULL AND strategy_code='first_board_advance' AND conclusion IN ('promotion_strong','promotion_normal','divergence_hold','weak_exit','unavailable')));

WITH prompt AS (SELECT p.id AS prompt_id,p.current_revision_id AS base_revision_id,r.revision_no,r.content FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id WHERE p.code='auction_opportunity_assessment'), next AS (
 SELECT prompt.*, content || $add$

首板先手专项：`auction_context_query` 返回的 `first_board_candidates` 是前一开市日10:45先手信号，必须逐条写入 `scope_items`。沿用竞价价格、未匹配方向、换手和数据状态，并补充未匹配量/竞价量、竞价量占昨日成交量、同题材竞价共振。其结论只能为 `promotion_strong`（晋级强）、`promotion_normal`（正常晋级）、`divergence_hold`（分歧持有）、`weak_exit`（转弱退出）或 `unavailable`。这些候选假定前一日已尝试排队，竞价高开超过5%不得套用“放弃追高”的入场语义。
$add$ AS next_content FROM prompt)
INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
SELECT prompt_id,revision_no+1,next_content,encode(sha256(convert_to(next_content,'UTF8')),'hex'),'user',base_revision_id,'增加首板先手次日竞价分支' FROM next;
UPDATE job_prompt p SET current_revision_id=r.id,updated_at=now() FROM job_prompt_revision r WHERE p.code='auction_opportunity_assessment' AND r.prompt_id=p.id AND r.revision_no=(SELECT max(revision_no) FROM job_prompt_revision WHERE prompt_id=p.id);

UPDATE strategy_state SET change_seq=change_seq+1,
 current_hash=encode(sha256(convert_to((SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id) FROM strategy_document WHERE code NOT IN ('copper_inventory_strategy','lithium_warehouse_strategy')),'UTF8')),'hex'),
 updated_at=now() WHERE singleton=1;
COMMENT ON COLUMN first_board_intraday_snapshot.id IS '盘中快照主键';
COMMENT ON COLUMN first_board_intraday_snapshot.scan_date IS '上海时区扫描交易日';
COMMENT ON COLUMN first_board_intraday_snapshot.captured_at IS '本机保存时间';
COMMENT ON COLUMN first_board_intraday_snapshot.source_timestamp IS '上游快照组装时间';
COMMENT ON COLUMN first_board_intraday_snapshot.limit_up_count IS '扫描时涨停池总数';
COMMENT ON COLUMN first_board_intraday_snapshot.limit_break_count IS '扫描时炸板池总数';
COMMENT ON COLUMN first_board_intraday_snapshot.payload IS '候选、信号和盘中证据快照';
