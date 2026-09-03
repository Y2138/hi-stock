-- 0065_每日计划垂类计算与终止门禁.sql：补齐旧短线档位，并禁止每日计划回退到通用查询手算。

-- 当前策略已明确由股性中的拉升节奏选择均线；仅在语义不冲突时做确定性回填。
UPDATE pool_membership
   SET stop_loss_mode = CASE
         WHEN concat_ws('·', stock_character, tags::text) LIKE '%快拉%'
          AND concat_ws('·', stock_character, tags::text) NOT LIKE '%慢拉%'
          AND concat_ws('·', stock_character, tags::text) NOT LIKE '%温吞%' THEN 'ma5'
         WHEN (concat_ws('·', stock_character, tags::text) LIKE '%慢拉%'
            OR concat_ws('·', stock_character, tags::text) LIKE '%温吞%')
          AND concat_ws('·', stock_character, tags::text) NOT LIKE '%快拉%' THEN 'ma10'
       END
 WHERE pool = 'short'
   AND effective_to IS NULL
   AND stop_loss_mode IS NULL
   AND (
     concat_ws('·', stock_character, tags::text) LIKE '%快拉%'
     OR concat_ws('·', stock_character, tags::text) LIKE '%慢拉%'
     OR concat_ws('·', stock_character, tags::text) LIKE '%温吞%'
   );

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'daily_plan_flow'
     AND prompt.status = 'active'
     AND revision.content NOT LIKE '%## 每日计划垂类计算门禁%'
), prepared AS (
  SELECT prompt_id,
         base_revision_id,
         content || $daily_plan_vertical_gate$

## 每日计划垂类计算门禁

1. `daily_plan_context_query` 同时完成短线池右侧六条件重算与持仓触发位计算；逐只使用其布尔条件、存活数、信号、止损档位来源、冷却期、止盈位、技术止损和退出候选，不得再调用 `database_schema` / `database_query` 拉取日线或指标序列手算。
2. 工具只返回结论、覆盖数和验证结论所需的关键数值，不返回原始序列。只有工具明确返回对应逐项缺口，且任务需要定位服务故障时，才可使用低优先级数据库排障工具；排障结果不得冒充正式信号。
3. 短线止损档位以持久化配置优先；旧成员缺配置时，股性唯一包含“快拉”推断 MA5，唯一包含“慢拉”或“温吞”推断 MA10，语义冲突或均不包含时继续报告缺口，不猜测固定 0.90 档。
4. 最终结果必须以 Runner 指定的任务结果标记开头。达到输出上限、只输出执行进度、空文本或未带结果标记都不算完成，系统只做有限次续写，超过上限按失败处理。
$daily_plan_vertical_gate$ AS content
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
         '每日计划使用垂类信号与触发位计算，并明确最终结果终止门禁'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
