-- 集合竞价任务取消持仓复核心：持仓结论长期恒为“按原预案”，不再产生评估行。
-- 竞价范围收敛为关注来源、前一开市日收盘打板候选与盘中涨停梯队；打板机会继续沿用 daily_plan_auction_assessment。
-- 历史 auction_scope_assessment 持仓行保留用于审计，接口与前端不再返回或展示。

-- 持仓复核移除后竞价任务不再有账户专属输入，改为全局任务，避免每个账户重复评估与重复推送。
UPDATE job_definition
   SET execution_scope = 'global', updated_at = now()
 WHERE code = 'auction_opportunity_assessment' AND execution_scope <> 'global';

-- 历史持仓结论只保留审计，不再作为激活判断继续参与查询与展示。
UPDATE auction_scope_assessment
   SET status = 'superseded', updated_at = now()
 WHERE scope_kind = 'position' AND status IN ('draft', 'active');

WITH current_prompt AS (
  SELECT p.id AS prompt_id, p.current_revision_id AS base_revision_id, r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id = p.current_revision_id
   WHERE p.code = 'auction_opportunity_assessment'
), revised AS (
  SELECT prompt_id, base_revision_id,
    replace(replace(replace(replace(content,
      '账户范围：仅处理绑定账户的持仓预案，不修改其他账户。共享市场信号与关注池只读。',
      '账户范围：只写入绑定账户的竞价结果，不修改持仓、关注或策略。共享市场信号与关注池只读。'),
      '目标：按最终竞价复核持仓、关注、前一开市日收盘打板独立任务的候选及盘中梯队。不交易、不修改持仓或策略。',
      '目标：按最终竞价复核关注来源、前一开市日收盘打板独立任务的候选及盘中梯队；持仓竞价复核已下线，不产生持仓结论。不交易、不修改持仓或策略。'),
      '1. 调用 auction_context_query(date=目标日)，检查交易日历、每日计划和候选有效性。打板只取 limit_up_close_scan 激活的 off_pool_opportunity，不回退旧每日计划或临时全市场选股。读取 strategy_document_query 所要求的当前策略，持仓继承专属和兜底退出保护。',
      '1. 调用 auction_context_query(date=目标日)，检查交易日历和候选有效性。打板只取 limit_up_close_scan 激活的 off_pool_opportunity，不回退旧每日计划或临时全市场选股。读取 strategy_document_query 所要求的当前策略。'),
      '6. 调用一次 auction_assessment_write：items覆盖所有有效收盘候选，无候选传空；scope_items覆盖持仓、关注及盘中梯队全部目标键。data_time只填原始ISO时间。',
      '6. 调用一次 auction_assessment_write：items覆盖所有有效收盘候选，无候选传空；scope_items 只覆盖关注及盘中梯队全部目标键，不再提交 position 目标键。data_time只填原始ISO时间。')
    AS revised_content
  FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prompt_id,
         (SELECT max(existing.revision_no) + 1 FROM job_prompt_revision existing WHERE existing.prompt_id = revised.prompt_id),
         revised_content,
         encode(sha256(convert_to(revised_content, 'UTF8')), 'hex'),
         'user',
         base_revision_id,
         '集合竞价取消持仓复核，范围收敛到关注来源、收盘打板候选与盘中梯队'
    FROM revised
   WHERE revised_content <> (SELECT content FROM current_prompt)
  RETURNING id, prompt_id
)
UPDATE job_prompt p
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE p.id = inserted.prompt_id;
