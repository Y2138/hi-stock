-- 0031_daily_plan_attention.sql：每日交易计划在只读分析完成后，可窄权限维护池内近期关注。

UPDATE job_definition
   SET config = config || '{"pool_attention_write":true}'::jsonb,
       updated_at = now()
 WHERE code = 'daily_plan_flow'
   AND job_type = 'agent_flow'
   AND config->>'pool_attention_write' IS DISTINCT FROM 'true';

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id, revision.id AS base_revision_id, revision.content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'daily_plan_flow'
     AND prompt.status = 'active'
), prepared AS (
  SELECT prompt_id, base_revision_id,
         content || $attention$

## 近期关注维护

在完成全部证据查询并形成计划结论后、输出最终 Markdown 前，维护本次计划对应的近期关注：

1. 仅处理 `pool_membership.effective_to IS NULL` 的现有短线池或长线池成员，不得为了关注而新增标的、改变角色或研究属性。
2. “已符合条件”指本次计划证据已满足对应策略的完整可执行条件；“即将符合条件”必须写明仍缺的具体条件和最早可能验证日。研究评分不得单独作为关注依据。
3. 对上述标的调用 `pool_attention_write mark`，`attention_from` 不早于目标日，`attention_until` 覆盖下一次合理验证窗口；原因必须简短写明证据或缺失条件。
4. 查询已有以“每日计划·”开头的自动关注；若本轮证据已明确失效或不再接近条件，调用 `pool_attention_write clear`。不得覆盖或清除人工维护的关注。
5. 没有符合或即将符合条件的标的时不要调用写工具。最终 Markdown 增加“近期关注变更”小节，如实列出已标记、已清除、因人工关注而跳过及未操作项。
$attention$ AS content
    FROM current_prompt
   WHERE current_prompt.content NOT LIKE '%## 近期关注维护%'
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prepared.prompt_id,
         (SELECT COALESCE(MAX(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = prepared.prompt_id),
         prepared.content,
         encode(sha256(convert_to(prepared.content, 'UTF8')), 'hex'),
         'user', prepared.base_revision_id,
         '每日交易计划增加池内近期关注窄权限维护'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
