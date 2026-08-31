-- 0053_打板任务跟随当前策略.sql：任务不再固化某一版打板门禁，始终服从真人批准的当前策略正文。

WITH additions(code, content) AS (
  VALUES
  ('daily_plan_flow', $daily$

## 当前打板策略优先级

涨停延续、连板和池外打板候选必须完整读取本轮注入的当前《打板策略》正文，并以该正文的候选范围、评分路线、阈值、评级和验证状态为最高优先级。提示词较早段落中对 S 日一字、形态链、规模档或 A/B/C 评级的静态描述只代表旧版本；与当前正文冲突时不得继续执行或据此排除候选。策略仍处于观察或验证状态时，不得把候选筛选结果写成入场结论。
$daily$),
  ('auction_opportunity_assessment', $auction$

## 当前打板策略优先级

只对当前《打板策略》筛出的 E 日候选执行竞价复核。提示词较早段落中对 S 日一字、排队形态、规模档或放弃语义的静态描述只代表旧版本；与当前正文冲突时以当前正文为准。竞价与可成交性尚未完成独立验证的路线只能输出观察结论，不得因竞价数据存在而自动升级为值得入场。
$auction$)
), current_prompt AS (
  SELECT prompt.id AS prompt_id, prompt.current_revision_id AS base_revision_id,
         revision.content, additions.content AS addition
    FROM additions
    JOIN job_prompt prompt ON prompt.code = additions.code
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.status = 'active'
     AND revision.content NOT LIKE '%## 当前打板策略优先级%'
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT current_prompt.prompt_id,
         (SELECT COALESCE(MAX(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = current_prompt.prompt_id),
         current_prompt.content || current_prompt.addition,
         encode(sha256(convert_to(current_prompt.content || current_prompt.addition, 'UTF8')), 'hex'),
         'user', current_prompt.base_revision_id,
         '打板相关任务始终服从真人批准的当前策略正文，不再固化旧版一字门禁'
    FROM current_prompt
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;

