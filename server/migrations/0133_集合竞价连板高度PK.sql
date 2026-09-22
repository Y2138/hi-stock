-- 0133_集合竞价连板高度PK.sql：竞价按最高连板是否退潮，评估三进四、四进五的资金空间。
WITH updated AS (
  SELECT id,content || $section$

## 十一、连板高度PK机制

集合竞价复核必须同时检查前一交易日最高连板梯队。短线资金有限，高度板继续强势时对低一至两级晋级形成资金压制；最高梯队集体竞价转弱时，三进四、四进五等次高梯队获得相对空间。

只使用最终竞价判断：最高梯队至少一只接近涨停且买方未匹配为正，记为“高度压制”；最高梯队全部低开或卖方未匹配、且无接近涨停者，记为“高度释放”；其余记为“高度混合”。该机制只用于同日候选PK与排序，不能覆盖价格、未匹配方向、换手、数据状态等原硬门禁，也不能凭高度释放把弱竞价改写为信号通过。

对三进四、四进五候选必须在竞价摘要中写明前一日最高板、最高梯队竞价状态、候选目标板数及“高度压制/高度释放/高度混合”标签。
$section$ AS next_content FROM strategy_document WHERE code='limit_up_board'
)
UPDATE strategy_document document SET content=updated.next_content,
 sha256=encode(sha256(convert_to(updated.next_content,'UTF8')),'hex'),updated_at=now()
FROM updated WHERE document.id=updated.id;

WITH prompt AS (
 SELECT p.id prompt_id,p.current_revision_id base_revision_id,r.revision_no,r.content
 FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id
 WHERE p.code='auction_opportunity_assessment'
), next AS (
 SELECT prompt.*,content || $add$

连板高度PK：读取 `auction_context_query.limit_ladder_pk`。必须把 `highest_board` 代码包含在最终 `auction_snapshot(stage=final)` 取数中，并用最高梯队竞价判断 `height_blocked`（至少一只接近涨停且买方未匹配为正）、`height_released`（最高梯队全部低开或卖方未匹配且无接近涨停者）或 `height_mixed`。对 `relevant_candidates` 中的三进四、四进五逐只写入“高度压制/高度释放/高度混合”证据和 `benchmark_tags`。该PK结果只调整同日优先级，不得推翻原竞价硬门禁或把弱竞价改成通过。
$add$ AS next_content FROM prompt
), inserted AS (
 INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
 SELECT prompt_id,revision_no+1,next_content,encode(sha256(convert_to(next_content,'UTF8')),'hex'),'user',base_revision_id,'增加连板高度PK与最高板退潮判断' FROM next
 RETURNING id,prompt_id
)
UPDATE job_prompt p SET current_revision_id=inserted.id,updated_at=now() FROM inserted WHERE p.id=inserted.prompt_id;

UPDATE strategy_state SET change_seq=change_seq+1,
 current_hash=encode(sha256(convert_to((SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id) FROM strategy_document WHERE code NOT IN ('copper_inventory_strategy','lithium_warehouse_strategy')),'UTF8')),'hex'),updated_at=now()
WHERE singleton=1;
