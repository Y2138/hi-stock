-- 0074_持仓与近期关注解耦.sql：持仓不是近期关注，成交后的每日计划自动关注不再继续展示。

UPDATE pool_membership membership
   SET attention_reason = NULL,
       attention_from = NULL,
       attention_until = NULL
 WHERE membership.effective_to IS NULL
   AND membership.attention_reason LIKE '每日计划·%'
   AND EXISTS (
     SELECT 1
       FROM portfolio_position position
      WHERE position.instrument_id = membership.instrument_id
        AND position.quantity > 0
   );

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'daily_plan_flow'
     AND prompt.status = 'active'
     AND revision.content NOT LIKE '%## 持仓与近期关注解耦%'
), prepared AS (
  SELECT prompt_id,
         base_revision_id,
         content || $attention_boundary$

## 持仓与近期关注解耦

1. 近期关注只承载尚未持仓的池内候选，不是持仓清单；持仓、买入成交或新建池角色本身都不得作为关注理由。
2. 生成 `pool_attention_write` 完整 `mark` 集合前，必须用本轮持仓上下文排除 `portfolio_position.quantity > 0` 的标的。已持仓标的即使满足短线信号，也只进入持仓执行预案，不得重新加入近期关注。
3. 服务端会拒绝把已持仓标的写成自动关注，并清除其残留的“每日计划·”自动关注；用户人工关注保持不变。买入成交后同样立即消费自动关注。
4. 用户要求移出近期关注时，使用 `pool_write update` 将 `attention_reason`、`attention_from`、`attention_until` 同时设为 null，保留角色和全部研究属性。
$attention_boundary$ AS content
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
         '持仓与近期关注解耦，买入消费自动关注并支持手动移除'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
