-- 0060_周中检查交易日窗口.sql：纠正交易日窗口、指标和同步缺口的判定口径。

WITH addition(content) AS (
  VALUES ($rules$

## 量化窗口与缺口判定

1. 策略要求最近 N 个交易日时，必须按每只标的实际行情行数取截至目标日的最近 N 根，不能用“目标日减 N 个自然日”代替。使用 `database_query` 时按不超过 20 只标的分批、查询足够宽的自然日范围并逐只计数；只有库内实际少于 N 根时才能报告行情缺失，不能把本次查询范围不足写成系统数据缺口。市场领域工具已启用时优先使用 `indicator_query(end=目标日, limit>=N)`。
2. RSI14 读取 `market_indicator_value.rsi14`，同时核对对应 `market_indicator_run` 的计算版本、状态、复权口径和截止日；少于 15 根收盘价、值为空或指标状态不可信时才列为缺口。
3. 需要目标日板块温度时，先读取目标日已完成的 `analysis_run`；没有则调用一次 `analysis_run(sector_temperature, as_of=目标日)` 并使用返回结果。最终输出前重新核对本轮并发任务新生成的目标日分析，避免把运行初期的旧快照写成最终缺口。
4. 目录和板块成分按作业自身计划频率判断新鲜度；最近一次应执行批次成功且覆盖目标日时，不得因“今日未运行”列为缺口。`running` 只表示在途，不属于数据缺口。上游 `partial` 只影响对应失败数据集，不扩大为其他数据不可用。
$rules$)
)
, prepared AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content || addition.content AS content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
    CROSS JOIN addition
   WHERE prompt.code = 'midweek_check'
     AND prompt.status = 'active'
     AND revision.content NOT LIKE '%## 量化窗口与缺口判定%'
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prepared.prompt_id,
         (SELECT COALESCE(MAX(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing
           WHERE existing.prompt_id = prepared.prompt_id),
         prepared.content,
         encode(sha256(convert_to(prepared.content, 'UTF8')), 'hex'),
         'user',
         prepared.base_revision_id,
         '按实际交易日行数核验窗口，补充 RSI14、分析竞态和同步新鲜度判定'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
