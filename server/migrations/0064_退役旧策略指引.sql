-- 0064_退役旧策略指引.sql：物理删除预期校对、数据获取规范及其历史副本，清理任务引用。

CREATE TEMP TABLE retired_strategy_document_id (id bigint PRIMARY KEY) ON COMMIT DROP;
INSERT INTO retired_strategy_document_id
SELECT id FROM strategy_document
 WHERE role = 'guidance' AND title IN ('预期校对', '数据获取规范');

-- 删除目标文档后，仍引用其 ID 的未决提案不再可批准。
WITH affected AS (
  SELECT DISTINCT proposal.id, proposal.evolution_id
    FROM strategy_publish_proposal proposal
    CROSS JOIN LATERAL jsonb_array_elements(proposal.proposed_changes) change
   WHERE proposal.status = 'pending'
     AND proposal.proposed_changes IS NOT NULL
     AND change ? 'document_id'
     AND change->>'document_id' ~ '^[0-9]+$'
     AND (change->>'document_id')::bigint IN (SELECT id FROM retired_strategy_document_id)
), rejected AS (
  UPDATE strategy_publish_proposal proposal
     SET status = 'conflict', proposed_changes = NULL, decided_by = 'developer_migration',
         decision_note = '提案引用的策略文档已由开发维护删除', decided_at = now()
    FROM affected
   WHERE proposal.id = affected.id
  RETURNING affected.evolution_id
)
UPDATE strategy_evolution_log evolution
   SET adoption_status = 'rejected', decided_at = now()
 WHERE evolution.id IN (SELECT evolution_id FROM rejected);

UPDATE strategy_document document
   SET current_revision_id = NULL
 WHERE document.id IN (SELECT id FROM retired_strategy_document_id);

DELETE FROM strategy_document_revision revision
 WHERE revision.document_id IN (SELECT id FROM retired_strategy_document_id);

DELETE FROM strategy_document document
 WHERE document.id IN (SELECT id FROM retired_strategy_document_id);

-- 同时删除冻结内容域和最早导入域中的正文副本。
CREATE TEMP TABLE retired_content_document_id (id bigint PRIMARY KEY) ON COMMIT DROP;
INSERT INTO retired_content_document_id
SELECT id FROM content_document
 WHERE legacy_path IN ('预期校对.md', '数据获取规范.md')
    OR (content_type = 'guidance' AND title IN ('预期校对', '数据获取规范'));

CREATE TEMP TABLE retired_content_revision_id (id bigint PRIMARY KEY) ON COMMIT DROP;
INSERT INTO retired_content_revision_id
SELECT id FROM content_revision
 WHERE document_id IN (SELECT id FROM retired_content_document_id);

DELETE FROM content_legacy_import
 WHERE source_path IN ('预期校对.md', '数据获取规范.md')
    OR (target_table = 'content_revision' AND target_id IN (SELECT id FROM retired_content_revision_id));

UPDATE content_revision
   SET base_revision_id = NULL
 WHERE base_revision_id IN (SELECT id FROM retired_content_revision_id);

UPDATE content_document document
   SET current_revision_id = NULL
 WHERE document.id IN (SELECT id FROM retired_content_document_id);

DELETE FROM content_revision revision
 WHERE revision.id IN (SELECT id FROM retired_content_revision_id);

DELETE FROM content_document document
 WHERE document.id IN (SELECT id FROM retired_content_document_id);

DELETE FROM strategy_doc
 WHERE path IN ('预期校对.md', '数据获取规范.md');

-- 与运行时清单哈希公式保持一致；旧 job_run 的固化哈希继续作为历史运行证据保留。
UPDATE strategy_state
   SET current_hash = manifest.hash, updated_at = now()
  FROM (
    SELECT encode(sha256(convert_to(COALESCE(string_agg(
             document.code || ':' || revision.sha256, E'\n'
             ORDER BY document.injection_order, document.id
           ), ''), 'UTF8')), 'hex') AS hash
      FROM strategy_document document
      JOIN strategy_document_revision revision ON revision.id = document.current_revision_id
  ) manifest
 WHERE strategy_state.singleton = 1;

WITH prepared AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         prompt.code,
         CASE prompt.code
           WHEN 'daily_plan_flow' THEN replace(
             revision.content,
             '1. 本任务不进行预期校对：不引用《预期校对》指引，最终 Markdown 不得包含“预期校对”小节或 E5/E6 式评分回评；上一份计划的未决事项只作为连续性输入使用。',
             '1. 上一份计划的未决事项只作为连续性输入使用。'
           )
           WHEN 'midweek_check' THEN replace(
             revision.content,
             '使用当前策略快照中的投资总策略、短线策略和数据获取规范',
             '使用当前策略快照中的投资总策略和短线策略'
           )
           WHEN 'weekly_review' THEN replace(
             revision.content,
             '使用当前策略快照中的投资总策略、短线策略、长线策略、股性分析和数据获取规范',
             '使用当前策略快照中的投资总策略、短线策略、长线策略和股性分析'
           )
         END AS content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code IN ('daily_plan_flow', 'midweek_check', 'weekly_review')
     AND prompt.status = 'active'
), changed AS (
  SELECT prepared.*
    FROM prepared
    JOIN job_prompt_revision current ON current.id = prepared.base_revision_id
   WHERE prepared.content IS DISTINCT FROM current.content
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT changed.prompt_id,
         (SELECT COALESCE(MAX(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = changed.prompt_id),
         changed.content,
         encode(sha256(convert_to(changed.content, 'UTF8')), 'hex'),
         'user',
         changed.base_revision_id,
         '只使用活跃策略和系统数据能力，不再引用退役指引'
    FROM changed
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
