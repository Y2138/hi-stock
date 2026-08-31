-- 0055_退役策略模拟盘.sql：完整移除策略模拟盘及其每日计划写入能力。

UPDATE job_definition
   SET config = config - 'paper_trade_signal_write',
       updated_at = now()
 WHERE code = 'daily_plan_flow'
   AND config ? 'paper_trade_signal_write';

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content,
         strpos(revision.content, E'\n## 策略模拟账户信号\n') AS section_start,
         strpos(revision.content, E'\n## 执行纪律与预案结构化输出\n') AS next_section_start
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'daily_plan_flow'
     AND prompt.status = 'active'
), prepared AS (
  SELECT prompt_id,
         base_revision_id,
         CASE
           WHEN next_section_start > section_start
             THEN left(content, section_start - 1) || substr(content, next_section_start)
           ELSE left(content, section_start - 1)
         END AS content
    FROM current_prompt
   WHERE section_start > 0
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
         '退役策略模拟盘及其结构化买卖信号'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;

DROP TABLE IF EXISTS strategy_paper_trade;
DROP TABLE IF EXISTS strategy_paper_signal;
DROP TABLE IF EXISTS strategy_paper_position;
DROP TABLE IF EXISTS strategy_paper_account;
