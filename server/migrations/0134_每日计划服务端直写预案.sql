-- 每日计划统一编排直接写入结构化预案，取消 Agent 对 playbook_items 的大段转抄。

WITH prompt AS (
  SELECT prompt.id AS prompt_id,prompt.current_revision_id AS base_revision_id,revision.revision_no,revision.content
    FROM job_prompt prompt JOIN job_prompt_revision revision ON revision.id=prompt.current_revision_id
   WHERE prompt.code='daily_plan_flow'
), definition AS (
  SELECT prompt_id,base_revision_id,revision_no,
         replace(
           replace(
             content,
             '1. 调用 `daily_plan_strategy_query(date=目标日)`，读取市场状态、当前关注来源、全部持仓主策略/兜底策略评估和服务端生成的 `playbook_items`。',
             '1. 调用 `daily_plan_strategy_query(date=目标日)`，读取市场状态、当前关注来源、全部持仓主策略/兜底策略评估；服务端同时把生成的 `playbook_items` 直接写入本次运行草稿，并返回 `playbook_write`。'
           ),
           '5. 有 `playbook_items` 时只调用一次 `daily_plan_write` 并原样提交；空数组时不调用并明确无结构化预案。',
           '5. 检查 `playbook_write.replaced` 与 `playbook_items` 数量一致。不得调用 `daily_plan_write`，也不得转抄或改写结构化预案；空数组时明确无结构化预案。'
         ) AS content
    FROM prompt
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,revision_no+1,content,encode(sha256(convert_to(content,'UTF8')),'hex'),'user',base_revision_id,
         '每日计划统一编排由服务端直接写入结构化预案'
    FROM definition RETURNING id,prompt_id
)
UPDATE job_prompt prompt SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE prompt.id=inserted.prompt_id;
