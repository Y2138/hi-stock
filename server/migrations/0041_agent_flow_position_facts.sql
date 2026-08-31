-- 0041_agent_flow_position_facts.sql：每日计划只读取当前持仓与持仓事件，不再引用退役账户事实。

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'daily_plan_flow'
     AND prompt.status = 'active'
     AND (
       revision.content LIKE '%当前持仓与账户读 `portfolio_*`%'
       OR revision.content LIKE '%资金组合和风险%'
     )
), prepared AS (
  SELECT prompt_id,
         base_revision_id,
         replace(
           replace(
             content,
             '当前持仓与账户读 `portfolio_*`',
             '当前持仓读 `portfolio_position`，持仓变化读 `portfolio_position_change`'
           ),
           '资金组合和风险',
           '组合持仓结构和风险'
         ) AS content
    FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prepared.prompt_id,
         (SELECT COALESCE(MAX(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = prepared.prompt_id),
         prepared.content,
         encode(sha256(convert_to(prepared.content, 'UTF8')), 'hex'),
         'user',
         prepared.base_revision_id,
         '每日计划只读取当前持仓与持仓事件，移除退役账户口径'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
