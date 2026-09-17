-- 0100_铜库存防守仓位定时评估.sql：内置Agent每周解释固定公式结果，不自行计算或交易。

INSERT INTO job_prompt (code, name, status)
VALUES ('copper_inventory_signal_review', '铜库存防守仓位评估', 'active')
ON CONFLICT (code) DO NOTHING;

WITH prompt AS (
  SELECT id AS prompt_id, current_revision_id AS base_revision_id
    FROM job_prompt
   WHERE code = 'copper_inventory_signal_review'
), definition(content) AS (
  VALUES ($prompt$
# 铜库存防守仓位评估

目标：按任务目标日解释服务端固定计算的《铜库存防守仓位一版》结果，形成可追溯的研究评估。结果由系统保存到 `job_run_output`。本任务不读取当前最终策略，不交易、不修改持仓、不入池、不修改关注、任务、提示词或策略。

## 执行流程

1. 先用 `tool_catalog` 只加载 `copper_inventory_signal_query`。
2. 只调用一次 `copper_inventory_signal_query(date=目标日)`。公式、历史百分位、目标仓位、调仓缓冲、有效公司和动作全部以工具结果为准；不得使用数据库通用查询、Web搜索、旧任务结果或自行计算替代。
3. 核对 `status`、`data_summary`、`gaps`、最新库存报告日和发布时间。若最新库存报告早于目标日所在周的最近有效周报，明确写“库存数据未更新”，不得把旧信号包装成新信号。
4. 区分 `raw_target_exposure` 与 `current_target.stock_exposure`。只有工具返回已执行或待执行的 `increase`、`decrease`、`initial_entry`、`universe_change` 时才称为仓位变化信号；`hold` 必须明确写“未跨过20个百分点缓冲，不调仓”。
5. 展示的仓位均称为“研究目标仓位”，不得转换成交易指令、成交承诺、收益预测或针对用户真实账户的操作建议。

## 输出

输出紧凑Markdown，依次包含：

- 目标日、规则版本、数据状态和最新库存报告日；
- 当前库存、四周对比库存、4周变化、库存逆百分位；
- 原始目标股票仓位、当前已执行股票仓位、现金比例、每只核心公司的等权比例；
- 本轮信号动作、最近一次实际调仓信号及执行日期；
- 数据缺口和研究证据边界。

末尾必须输出 `## 结论摘要`，用2至5条短句说明当前是加仓、减仓、待执行还是保持，以及最重要的数据日期和风险。不得重复整篇正文。
$prompt$)
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prompt.prompt_id,
         (SELECT COALESCE(max(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = prompt.prompt_id),
         definition.content,
         encode(sha256(convert_to(definition.content, 'UTF8')), 'hex'),
         'user',
         prompt.base_revision_id,
         '固化铜库存防守仓位一版的只读定时评估表达'
    FROM prompt CROSS JOIN definition
   WHERE NOT EXISTS (
     SELECT 1 FROM job_prompt_revision existing
      WHERE existing.prompt_id = prompt.prompt_id
        AND existing.sha256 = encode(sha256(convert_to(definition.content, 'UTF8')), 'hex')
   )
  RETURNING prompt_id, id
), selected AS (
  SELECT inserted.prompt_id, inserted.id FROM inserted
  UNION ALL
  SELECT prompt.prompt_id, revision.id
    FROM prompt CROSS JOIN definition
    JOIN job_prompt_revision revision
      ON revision.prompt_id = prompt.prompt_id
     AND revision.sha256 = encode(sha256(convert_to(definition.content, 'UTF8')), 'hex')
   WHERE NOT EXISTS (SELECT 1 FROM inserted)
  LIMIT 1
)
UPDATE job_prompt prompt
   SET current_revision_id = selected.id, updated_at = now()
  FROM selected
 WHERE prompt.id = selected.prompt_id;

INSERT INTO job_definition (code, name, cron, job_type, config, prompt_id, model_id, enabled)
SELECT 'copper_inventory_signal_review',
       '铜库存防守仓位评估',
       '30 17 * * 5',
       'agent_flow',
       '{}'::jsonb,
       prompt.id,
       NULL,
       true
  FROM job_prompt prompt
 WHERE prompt.code = 'copper_inventory_signal_review'
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name,
      cron = EXCLUDED.cron,
      job_type = EXCLUDED.job_type,
      config = EXCLUDED.config,
      prompt_id = EXCLUDED.prompt_id,
      model_id = EXCLUDED.model_id,
      enabled = EXCLUDED.enabled,
      updated_at = now();
