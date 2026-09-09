-- 0072_交易日历缺行不阻断任务.sql：本地日历缺行时由工作日与实际竞价数据共同降级判断。

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'auction_opportunity_assessment'
     AND prompt.status = 'active'
     AND revision.content NOT LIKE '%## 交易日历缺行降级口径%'
), prepared AS (
  SELECT prompt_id,
         base_revision_id,
         content || $calendar$

## 交易日历缺行降级口径

本节替代前文“目标日必须存在于交易日历、缺失即停止”的旧口径。

1. 目标日有 `market_trading_day` 记录时，以 `is_open` 为准；明确为休市时不执行竞价研判。
2. 目标日缺行且为周六或周日时按休市处理；缺行且为周一至周五时不得因缺行停止任务，也不得把缺行列为唯一阻断项。
3. 缺行工作日继续获取 `auction_short_term_benchmark` 与 `stage='final'` 的 `auction_snapshot`，以实际响应日期、竞价阶段和数据状态完成逐只判断；关键数据未就绪时提交 `unavailable`，不得猜测或补造字段。
$calendar$ AS content
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
         '交易日历缺行时工作日继续按实际竞价数据研判'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
