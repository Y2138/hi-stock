-- 0076_重写其余Agent任务提示词.sql：整体替换每日计划、周中检查和每周评分提示词，删除历史追加段。

WITH definitions(code, content, change_summary) AS (
  VALUES
  ('daily_plan_flow', $daily$
# 每日交易计划

目标：使用目标日数据库事实和本轮锁定的当前最终策略，生成下一交易日计划。不得交易、修改持仓、改变池角色或修改策略。

## 执行流程

1. 用 `tool_catalog` 一次加载 `strategy_document_query`、`job_context_query`、`daily_plan_context_query`、`swing_signal_query`、`limit_up_signal_query`、`pool_attention_write`、`daily_plan_write`，不加载无关工具。
2. 按系统提示词中的文档目录，一次读取组合、短线、长线和打板判断所需的当前策略正文。策略参数只取本轮锁定版本，不从历史任务结果或旧提示词补充。
3. 分别且只调用一次 `daily_plan_context_query(date=目标日)`、`swing_signal_query(date=目标日)` 和 `limit_up_signal_query(date=实际市场结构数据日)`。信号、关键位、评分、覆盖计数和缺口直接使用工具结果，不读取原始行情序列重新计算。
4. 如需连续性，只用 `job_context_query` 读取 `daily_plan_flow` 最近一份成功的 `job_run_output` 正文；仅继承仍未触发且未失效的动作，每个历史缺口必须以本轮工具结果重新确认。

## 计划与写入

1. 市场状态、温度、同步状态和全部真实持仓以 `daily_plan_context_query` 为准。短线信号按其 `signal_selection` 固定的“右侧 > 左侧 > 试盘”结果输出；正式信号、接近候选、筛除项和缺口不得混淆。完整扫描后 0 个信号是有效结论。
2. 波段只使用 `swing_signal_query`：`signals` 是新增信号，`near_candidates` 是接近候选，`suppressed_matches` 不得写成新增信号。完整扫描后无信号时明确写“当日无新增波段信号”。
3. 打板机会只取 `limit_up_signal_query.signals`，按当前策略排序且每日最多 4 只；A 映射 A，B-抱团/B-主升映射 B，操作固定为 `observe`。接近阈值、未进路线名次或数据不足的候选不得补入。
4. 为每笔真实持仓形成一条 `position_action`，使用工具返回的止损档位、冷却期、止盈止损位和退出候选；写清动作、触发方式、竞价/分时要点、失效条件与缺口。历史带价位动作在未触发、未失效、未被新计划替代前继续有效；高开越过买入区间则当日放弃，跳空越过卖出触发位则按开盘执行。
5. 全部扫描完成后只调用一次 `pool_attention_write`。`items` 是本轮应保留的完整自动关注集合：未持仓的正式信号标记“已符合”，工具明确给出的接近候选及右侧仅缺一个条件的候选标记“即将符合”；短线与波段合并提交，无候选也提交空数组。不得加入持仓、池外标的或覆盖人工关注。
6. 有结构化行时只调用一次 `daily_plan_write`：包含全部 `position_action` 和全部有效打板机会，内容必须与 Markdown 一致；没有持仓且没有有效打板信号时不调用，并在结果中说明无可写预案。
7. 任一工具状态为 `partial/unavailable/missing`、覆盖数不一致或存在 `gaps` 时逐项报告影响；否则不得把未命中写成未核验，也不得沿用旧缺口。

## 输出

输出紧凑 Markdown，包含：数据日与覆盖、市场情景、全部持仓预案、短线右侧/左侧/试盘、波段信号、打板机会、近期关注变更、数据缺口和风险。正式或接近候选逐只列关键证据；普通筛除项只汇总数量和主要失败原因。注明策略版本和数据截止日，结果由系统保存到 `job_run_output`。
$daily$, '整体重写每日计划流程，使用确定性工具和一次性结构化写入'),

  ('midweek_check', $midweek$
# 周中短线检查

目标：使用目标日事实和本轮锁定的当前最终策略，完整检查短线池的评分、阶段、右侧/左侧/试盘信号及市场变化，只形成研究结论。

1. 用 `tool_catalog` 一次加载 `strategy_document_query`、`pool_context_query`、`job_context_query`、`daily_plan_context_query`。
2. 读取组合与短线策略正文；用 `pool_context_query(pools=["short"])` 取得全部成员摘要，只对需要解释评分或阶段变化的代码再取完整研究属性。
3. 只调用一次 `daily_plan_context_query(date=目标日)`，直接使用市场状态、覆盖计数、右侧/左侧/试盘分组和缺口，不拉取原始行情手算。需要比较时只读取 `midweek_check` 最近一份成功的 `job_run_output`。
4. 池成员数与扫描覆盖不一致、工具为部分状态或存在缺口时如实列出；完整扫描后 0 个信号是有效结论。不得修改持仓、标的池或近期关注。

输出紧凑 Markdown：数据日与覆盖、市场/板块变化、全部短线池成员当前评分和阶段、正式信号、接近候选、建议变化及缺口。未变化成员每只一行，建议变化项才展开证据；注明策略版本，系统保存到 `job_run_output`。
$midweek$, '整体重写周中检查流程，改用短线池摘要和确定性扫描'),

  ('weekly_review', $weekly$
# 每周评分

目标：使用目标日事实和本轮锁定的当前最终策略，完整复核短线池、长线池的研究评分、阶段、角色和量化资格，只提出待确认建议。

1. 用 `tool_catalog` 一次加载 `strategy_document_query`、`pool_context_query`、`portfolio_context_query`、`daily_plan_context_query`、`swing_signal_query`、`analysis_run`。
2. 读取组合、短线、长线及股性判断所需的当前策略正文；用 `pool_context_query` 取得两个池的全部成员摘要，用 `portfolio_context_query` 标记真实持仓。只对建议变化的代码再读取完整研究属性。
3. 短线量化资格使用一次 `daily_plan_context_query(date=目标日)`，波段资格使用一次 `swing_signal_query(date=目标日)`；长线估值按当前长线代码合并调用 `analysis_run(long_valuation)`。不得以研究评分替代量化资格。
4. 数据不足时保留当前评分、阶段和角色并列出缺口；角色变化不得直接写库。覆盖全部当前成员，正式信号、接近候选、抑制项和缺口分别统计。

输出紧凑 Markdown：数据日与覆盖、组合与市场概览、短线池复核、长线池复核、建议变化和缺口。全部成员每只一行列当前值与建议值，只有变化项展开证据；注明策略版本，系统保存到 `job_run_output`。
$weekly$, '整体重写每周评分流程，按摘要覆盖全集并按需展开证据')
), current_prompts AS (
  SELECT prompt.id AS prompt_id,
         prompt.code,
         prompt.current_revision_id AS base_revision_id,
         definitions.content,
         definitions.change_summary
    FROM definitions
    JOIN job_prompt prompt ON prompt.code = definitions.code
   WHERE prompt.status = 'active'
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT current_prompts.prompt_id,
         (SELECT COALESCE(max(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = current_prompts.prompt_id),
         current_prompts.content,
         encode(sha256(convert_to(current_prompts.content, 'UTF8')), 'hex'),
         'user',
         current_prompts.base_revision_id,
         current_prompts.change_summary
    FROM current_prompts
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
