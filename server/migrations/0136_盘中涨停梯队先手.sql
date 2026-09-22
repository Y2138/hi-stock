-- 0136_盘中涨停梯队先手.sql：10:45盘中扫描从仅首板扩展到完整涨停梯队，收盘涨停接力作为二次复核。
WITH definition(content) AS (VALUES ($strategy$
# 涨停梯队盘中先手策略

> 职责：工作日10:45使用当时盘中快照同时分析首板和高位连板，形成可追溯的涨停梯队先手候选；不自动下单、不决定仓位、不覆盖收盘市场结构。

## 一、扫描口径

扫描沪深主板、非ST、非未开板新股、10:45仍在涨停池且当日连板数不低于1的股票，同时读取炸板池判断高位核心是否已开板。排除09:25后仍未打开的一字板；首次封板需在09:30至10:30之间。

每只候选必须携带当前连板数、下一晋级阶段、题材最高板、与最高板距离、题材梯队层数、高位核心状态和题材角色。题材角色分为题材最高板、梯队中位、独立题材发起、被高位带动的低位跟风、完整梯队低位补涨和高位断板后的低位切换。

## 二、排序与候选

优先级依次考虑题材角色、当前连板高度、10:45题材宽度、首次封板时间、封单/流通市值和封单保持率。被高位核心单纯带动的低位首板降级；高位核心已炸板时，只有具备承接和切换特征的低位标的才保留较高优先级。

每日最多保留4只正式候选；同时存在首板和高位连板合格项时至少各保留1只，同一题材最多2只，避免候选全部集中在单一题材或单一梯队。

## 三、收盘二次复核

10:45结果是先手信号。收盘涨停接力扫描继续使用最终市场结构独立评分，并对盘中候选标记为收盘正式信号、封住但未入选或收盘未封住。盘中结果不覆盖收盘事实，收盘结果也不回写修改10:45快照。

## 四、次日竞价

次日竞价沿用价格、买卖未匹配方向、竞价换手和数据就绪门禁，补充未匹配量/竞价量、竞价量占昨日成交量、同题材竞价共振和连板高度PK。结论统一为晋级强、正常晋级、分歧持有、转弱退出或数据不足，并按候选自身的连板阶段解释，不再只按首板晋级二板解释。

## 五、验证边界

盘中使用的涨停、炸板、行情和题材结构只保存到独立快照；最终涨停、炸板和连板天梯仍以收盘任务为准。所有候选无论是否实际成交都保留，实际排队、成交和退出只认用户记录；首轮至少积累20个交易日后统一评审。
$strategy$::text))
UPDATE strategy_document document
   SET title='涨停梯队盘中先手策略',content=definition.content,
       sha256=encode(sha256(convert_to(definition.content,'UTF8')),'hex'),updated_at=now()
  FROM definition
 WHERE document.code='first_board_advance_strategy';

UPDATE strategy_definition
   SET name='涨停梯队盘中先手策略',updated_at=now()
 WHERE code='first_board_advance';

UPDATE job_prompt SET name='涨停梯队盘中扫描',updated_at=now() WHERE code='first_board_intraday_scan';
WITH prompt AS (
  SELECT p.id AS prompt_id,p.current_revision_id AS base_revision_id,r.revision_no
    FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id
   WHERE p.code='first_board_intraday_scan'
), definition(content) AS (VALUES ($prompt$
# 涨停梯队盘中扫描

目标：在目标交易日10:45按当前最终策略《涨停梯队盘中先手策略》生成可追溯的首板与高位连板先手报告，不自动交易；最终正文保存到 `job_run_output`。

1. 一次调用 `strategy_document_query` 读取《投资总策略》和《涨停梯队盘中先手策略》。
2. 调用 `strategy_evaluation_query(strategy_code=first_board_advance,phase=entry,date=目标日)`；盘中取数、独立快照、资格、题材角色和排序均以服务端结果为准，不用通用查询重算。
3. 完整列出正式候选。逐只说明当前连板数与下一晋级阶段、题材角色、题材最高板与梯队层数、高位核心状态、首次封板时间、题材宽度、封单强度、市场炸板率和排队可成交性；最多4只，空集合时明确无合格候选。
4. 明确区分首板先手与高位连板接力。对被高位核心带动的低位跟风首板说明折价原因；对高位连板说明其在当前题材和全市场高度中的位置。
5. 10:45结果是先手信号，收盘涨停接力扫描负责二次复核；盘中快照不得覆盖17:10后的最终市场结构。
6. 最终输出必须包含 `## 结论摘要`，不得补造数据或给出自动下单、仓位建议。
$prompt$::text))
INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
SELECT prompt_id,revision_no+1,definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),
       'user',base_revision_id,'盘中扫描扩展为完整涨停梯队'
  FROM prompt CROSS JOIN definition;
UPDATE job_prompt p SET current_revision_id=r.id,updated_at=now()
  FROM job_prompt_revision r
 WHERE p.code='first_board_intraday_scan' AND r.prompt_id=p.id
   AND r.revision_no=(SELECT max(revision_no) FROM job_prompt_revision WHERE prompt_id=p.id);

UPDATE job_definition
   SET name='涨停梯队盘中扫描',
       purpose='工作日10:45拉取独立盘中涨停、炸板、行情与竞价快照，分析首板和高位连板并保留最多4只先手候选；收盘涨停接力负责二次复核。',
       updated_at=now()
 WHERE code='first_board_intraday_scan';

WITH prompt AS (
  SELECT p.id AS prompt_id,p.current_revision_id AS base_revision_id,r.revision_no,r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id
   WHERE p.code='auction_opportunity_assessment'
), next AS (
  SELECT prompt.*,
    replace(content,
$old$首板先手专项：`auction_context_query` 返回的 `first_board_candidates` 是前一开市日10:45先手信号，必须逐条写入 `scope_items`。沿用竞价价格、未匹配方向、换手和数据状态，并补充未匹配量/竞价量、竞价量占昨日成交量、同题材竞价共振。其结论只能为 `promotion_strong`（晋级强）、`promotion_normal`（正常晋级）、`divergence_hold`（分歧持有）、`weak_exit`（转弱退出）或 `unavailable`。这些候选假定前一日已尝试排队，竞价高开超过5%不得套用“放弃追高”的入场语义。$old$,
$new$涨停梯队盘中先手专项：`auction_context_query` 返回的 `intraday_ladder_candidates` 是前一开市日10:45首板与高位连板先手信号，必须逐条写入 `scope_items`，目标键为 `ladder:<signal_id>`。沿用竞价价格、未匹配方向、换手和数据状态，并补充未匹配量/竞价量、竞价量占昨日成交量、同题材竞价共振和连板高度PK。结论只能为 `promotion_strong`（晋级强）、`promotion_normal`（正常晋级）、`divergence_hold`（分歧持有）、`weak_exit`（转弱退出）或 `unavailable`，并按候选自身的连板阶段解释。这些候选假定前一日已尝试排队，竞价高开超过5%不得套用“放弃追高”的入场语义。$new$) AS next_content
  FROM prompt
)
INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
SELECT prompt_id,revision_no+1,next_content,encode(sha256(convert_to(next_content,'UTF8')),'hex'),
       'user',base_revision_id,'集合竞价接入盘中完整涨停梯队'
  FROM next;
UPDATE job_prompt p SET current_revision_id=r.id,updated_at=now()
  FROM job_prompt_revision r
 WHERE p.code='auction_opportunity_assessment' AND r.prompt_id=p.id
   AND r.revision_no=(SELECT max(revision_no) FROM job_prompt_revision WHERE prompt_id=p.id);

ALTER TABLE auction_scope_assessment DROP CONSTRAINT auction_scope_assessment_target_key_check;
ALTER TABLE auction_scope_assessment ADD CONSTRAINT auction_scope_assessment_target_key_check
  CHECK (target_key ~ '^(position|attention|first_board|ladder):');
ALTER TABLE auction_scope_assessment DROP CONSTRAINT auction_scope_assessment_scope_kind_check;
ALTER TABLE auction_scope_assessment ADD CONSTRAINT auction_scope_assessment_scope_kind_check
  CHECK (scope_kind IN ('position','attention','first_board','ladder'));
ALTER TABLE auction_scope_assessment DROP CONSTRAINT auction_scope_assessment_check;
ALTER TABLE auction_scope_assessment ADD CONSTRAINT auction_scope_assessment_check CHECK (
 (scope_kind='position' AND attention_entry_id IS NULL AND conclusion IN ('plan_aligned','risk_alert','unavailable')) OR
 (scope_kind='attention' AND attention_entry_id IS NOT NULL AND conclusion IN ('confirmed','wait','give_up','unavailable')) OR
 (scope_kind IN ('first_board','ladder') AND attention_entry_id IS NULL AND strategy_code='first_board_advance'
   AND conclusion IN ('promotion_strong','promotion_normal','divergence_hold','weak_exit','unavailable')));

COMMENT ON TABLE first_board_intraday_snapshot IS '涨停梯队盘中先手策略独立快照；历史表名保留，不得覆盖收盘市场结构事实';
COMMENT ON COLUMN first_board_intraday_snapshot.payload IS '首板与高位连板候选、正式信号及题材梯队上下文';

UPDATE strategy_state SET change_seq=change_seq+1,
 current_hash=encode(sha256(convert_to((SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id) FROM strategy_document WHERE code NOT IN ('copper_inventory_strategy','lithium_warehouse_strategy')),'UTF8')),'hex'),
 updated_at=now() WHERE singleton=1;
