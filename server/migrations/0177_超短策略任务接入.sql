-- 超短策略节点接入既有任务：03 收盘任务追加关注池复核，02 盘中任务追加唯一首选说明。
-- 只追加流程职责，不改任务时点、不改策略评估器、不改竞价任务。

WITH current_prompt AS (
  SELECT p.id AS prompt_id, p.current_revision_id AS base_revision_id, r.revision_no, r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id = p.current_revision_id
   WHERE p.code = 'limit_up_close_scan'
), revised AS (
  SELECT prompt_id, base_revision_id, revision_no,
         content || E'\n\n## 超短关注池复核（服务端确定性引擎产出）\n' ||
         E'目标：T+1 超短关注池已由服务端在本次任务开始前确定性生成并写入 ultra_short_watchlist；你只做复核，不重新选股、不改变池子成员。\n' ||
         E'1. 逐只核对阶段/高度、封单与换手、T 日竞价特征、断板/炸板、低吸形态和关键价位是否与本次证据自洽；提示词中的关注池摘要与工具结果冲突时，以服务端结构化结果为准。\n' ||
         E'2. 用 web_search 核验每只候选最新公告、澄清、减持、监管、停牌、重大合同等风险；没有检索到新消息是有效结论，不算缺口；未核实传闻不得写成事实。\n' ||
         E'3. 调用一次 ultra_short_review_write(date=目标日, reviews=全部关注池代码)；没有关注标的时传空数组。可将 review_status 标为 pass/flag/invalid、risk_level 标为 high/medium/low/unknown，补充 risk_flags/review_note/review_sources；只能下调优先级，不得新增候选、上调优先级或修改总量/仓位/止损。\n' ||
         E'4. 正文说明环境结论（连板情绪/指数/低位扩散/主线真空）、关注池逐只理由、复核结论、风险与数据缺口；末尾保留 ## 结论摘要。所有结论都是关注信号，开仓由用户决定。' AS content
    FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prompt_id, revision_no + 1, content,
         encode(sha256(convert_to(content, 'UTF8')), 'hex'), 'user', base_revision_id,
         '收盘任务追加超短关注池复核'
    FROM revised RETURNING prompt_id, id
)
UPDATE job_prompt p SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted WHERE p.id = inserted.prompt_id;

WITH current_prompt AS (
  SELECT p.id AS prompt_id, p.current_revision_id AS base_revision_id, r.revision_no, r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id = p.current_revision_id
   WHERE p.code = 'first_board_intraday_scan'
), revised AS (
  SELECT prompt_id, base_revision_id, revision_no,
         content || E'\n\n## 唯一首选与排队提醒\n' ||
         E'服务端已把 T 日 09:25 竞价强度纳入候选排序，并按“一字只作强势观察、竞价弱或未知不作首选”的规则确定唯一首选（可为空）。只对唯一首选发排队提醒，提醒由服务端在扫描成功后发送；正文说明首选/无首选、同高度 PK、风险标记、参与前提和失效条件，不得把非首选写成排队建议，也不得承诺成交。' AS content
    FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prompt_id, revision_no + 1, content,
         encode(sha256(convert_to(content, 'UTF8')), 'hex'), 'user', base_revision_id,
         '盘中任务追加唯一首选与排队提醒边界'
    FROM revised RETURNING prompt_id, id
)
UPDATE job_prompt p SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted WHERE p.id = inserted.prompt_id;

UPDATE job_definition
   SET purpose = '收盘后生成并复核超短 T+1 关注池：收盘打板、盘中梯队复核、断板/炸板/前期龙头低吸，统一优先级后交给竞价与开盘执行。'
 WHERE code = 'limit_up_close_scan';
