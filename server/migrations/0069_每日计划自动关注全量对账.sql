-- 0069_每日计划自动关注全量对账.sql：近期关注按本轮完整集合维护，遗漏的旧自动信号立即清理。

WITH latest_run AS (
  SELECT run.session_id
    FROM job_run run
    JOIN job_definition definition ON definition.id = run.job_id
   WHERE definition.code = 'daily_plan_flow'
     AND run.status = 'success'
     AND run.session_id IS NOT NULL
   ORDER BY run.finished_at DESC NULLS LAST, run.id DESC
   LIMIT 1
), latest_write AS (
  SELECT audit.args
    FROM latest_run
    JOIN agent_tool_audit audit ON audit.session_id = latest_run.session_id
   WHERE audit.tool_name = 'pool_attention_write'
     AND audit.status = 'ok'
     AND jsonb_typeof(audit.args -> 'items') = 'array'
   ORDER BY audit.id DESC
   LIMIT 1
), kept AS (
  SELECT item ->> 'code' AS code, item ->> 'pool' AS pool
    FROM latest_write
   CROSS JOIN LATERAL jsonb_array_elements(latest_write.args -> 'items') item
   WHERE item ->> 'action' = 'mark'
)
UPDATE pool_membership membership
   SET attention_reason = NULL,
       attention_from = NULL,
       attention_until = NULL
  FROM market_instrument instrument
 WHERE instrument.id = membership.instrument_id
   AND membership.effective_to IS NULL
   AND membership.attention_reason LIKE '每日计划·%'
   AND EXISTS (SELECT 1 FROM latest_write)
   AND NOT EXISTS (
     SELECT 1 FROM kept
      WHERE kept.code = instrument.code AND kept.pool = membership.pool
   );

UPDATE pool_membership
   SET attention_reason = replace(
         replace(attention_reason,
           '每日计划·已符合：每日计划·已符合：', '每日计划·已符合：'),
           '每日计划·即将符合：每日计划·即将符合：', '每日计划·即将符合：')
 WHERE attention_reason LIKE '每日计划·%';

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'daily_plan_flow'
     AND prompt.status = 'active'
     AND revision.content NOT LIKE '%## 近期关注全量对账最终口径%'
), prepared AS (
  SELECT prompt_id,
         base_revision_id,
         content || $attention$

## 近期关注全量对账最终口径

本节替代前文“主动逐条清理、无候选时不调用工具”的旧口径。

1. 全部扫描完成后必须且只能调用一次 `pool_attention_write`；`items` 中的 `mark` 是本轮应保留的完整自动关注集合，不是增量变更。
2. 服务端会在同一事务自动清除未出现在本轮 `mark` 集合中的“每日计划·”自动关注；无符合或即将符合标的时也必须提交空 `items`，不得让旧信号等待到期。
3. 人工关注不会被自动覆盖或清除；`attention_reason` 只写证据正文，不要自行添加“每日计划·已符合/即将符合”前缀。
4. 最终 Markdown 必须按工具实际返回值列出本轮保留和自动清除项，不得在存在自动清除时写“无清除项”。
$attention$ AS content
    FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prepared.prompt_id,
         (SELECT COALESCE(max(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = prepared.prompt_id),
         prepared.content,
         encode(sha256(convert_to(prepared.content, 'UTF8')), 'hex'),
         'user',
         prepared.base_revision_id,
         '每日计划近期关注改为完整集合对账并自动清理旧信号'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
