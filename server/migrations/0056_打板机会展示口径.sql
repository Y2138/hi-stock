-- 0056_打板机会展示口径.sql：对外统一使用“打板机会”，结构化字段名保持兼容。

WITH prompt_change(code, addition) AS (
  VALUES
  ('daily_plan_flow', $daily$

## 打板机会最终输出口径

1. `off_pool_opportunity` 只作为内部兼容字段名，对外统一称“打板机会”。只写入当前《打板策略》形成的有效信号，不再收录普通市场结构候选、接近分数线候选或单一证据待验证候选。
2. 每日最多 4 只，按当前策略优先级连续排序。结构化 `grade` 只作兼容映射：A 级写 A，B-抱团与 B-主升写 B；不得写 C。精确信号等级必须写入 `headline` 和 `evidence_md`，不能由兼容评级反推。
3. `evidence_md` 必须保留主标签、抱团分、主升分、两条路线是否成立及各自名次、关键得分项和实际数据日；`missing_md`、`risk_md`、`invalidation_md` 分别记录数据缺口、风险标记和失效条件。
4. 当前策略处于前向验证期时，打板机会的 `action` 固定为 `observe`，不得写成买入或入场结论。最终 Markdown 使用“打板机会”标题；没有有效信号时明确写“当日无有效打板信号”。
$daily$),
  ('auction_opportunity_assessment', $auction$

## 打板机会页面回写口径

1. `off_pool_opportunity` 只作为内部兼容字段名，对外统一称“打板机会”。竞价阶段只复核每日计划已经形成的当前《打板策略》有效信号，不补选普通池外标的。
2. `assessment_summary` 必须保留主标签、精确信号等级、抱团分、主升分、两条路线名次、T+1 复核分类、风险标记和失效原因；结构化 A/B 兼容评级不能替代这些字段。
3. 前向验证期的 `conclusion` 只使用 `observe`、`give_up`、`unavailable`，分别展示为“继续观察”“放弃”“数据不足”，不得使用 `worth_entering`。
4. 最终 Markdown 和页面回写说明统一使用“打板机会”。
$auction$)
), current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.code,
         prompt.current_revision_id AS base_revision_id,
         revision.content,
         prompt_change.addition
    FROM prompt_change
    JOIN job_prompt prompt ON prompt.code = prompt_change.code
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.status = 'active'
     AND revision.content NOT LIKE '%## 打板机会最终输出口径%'
     AND revision.content NOT LIKE '%## 打板机会页面回写口径%'
), renamed AS (
  SELECT prompt_id,
         code,
         base_revision_id,
         CASE code
           WHEN 'daily_plan_flow' THEN
             replace(
               replace(
                 replace(
                   replace(content, '## 市场结构与池外短线机会', '## 市场结构与打板机会'),
                   '市场结构池外机会', '打板机会'
                 ),
                 '池外短线候选', '打板候选'
               ),
               '池外机会', '打板机会'
             )
           ELSE
             replace(
               replace(
                 replace(
                   replace(
                     replace(
                       replace(
                         replace(content,
                           '### 持仓、近期关注与其他池外机会', '### 持仓与近期关注'),
                         '近期关注和非打板类池外机会', '近期关注'
                       ),
                       '非打板类池外机会才可', '近期关注候选才可'
                     ),
                     '打板类池外机会', '打板机会'
                   ),
                   '结构化池外机会', '结构化打板机会'
                 ),
                 '今日池外机会', '打板机会'
               ),
               '池外机会', '打板机会'
             )
         END || addition AS content
    FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT renamed.prompt_id,
         (SELECT COALESCE(MAX(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = renamed.prompt_id),
         renamed.content,
         encode(sha256(convert_to(renamed.content, 'UTF8')), 'hex'),
         'user',
         renamed.base_revision_id,
         CASE renamed.code
           WHEN 'daily_plan_flow' THEN '打板机会按当前策略有效信号、精确等级和最多四只的口径输出'
           ELSE '集合竞价对外统一回写打板机会并执行前向验证期结论约束'
         END
    FROM renamed
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
