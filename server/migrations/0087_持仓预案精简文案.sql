-- 0087_持仓预案精简文案.sql：整体替换每日计划提示词，收紧持仓预案文案纪律，
-- 失效/改判条件只写该持仓特有的可观测条件，必然情形与占位备注不写入。

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id
    FROM job_prompt prompt
   WHERE prompt.code = 'daily_plan_flow'
     AND prompt.status = 'active'
), definition(content) AS (
  VALUES ($prompt$
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
4. 为每笔真实持仓形成一条 `position_action`，使用工具返回的止损档位、冷却期、止盈止损位和退出候选，动作与触发价位一次写清。历史带价位动作在未触发、未失效、未被新计划替代前继续有效；高开越过买入区间则当日放弃，跳空越过卖出触发位则按开盘执行，这两条全局规则只在本文声明一次。
5. 全部扫描完成后只调用一次 `pool_attention_write`。`items` 是本轮应保留的完整自动关注集合：未持仓的正式信号标记“已符合”，工具明确给出的接近候选及右侧仅缺一个条件的候选标记“即将符合”；短线与波段合并提交，无候选也提交空数组。不得加入持仓、池外标的或覆盖人工关注。
6. 有结构化行时只调用一次 `daily_plan_write`：包含全部 `position_action` 和全部有效打板机会，内容必须与 Markdown 一致；没有持仓且没有有效打板信号时不调用，并在结果中说明无可写预案。
7. 任一工具状态为 `partial/unavailable/missing`、覆盖数不一致或存在 `gaps` 时逐项报告影响；否则不得把未命中写成未核验，也不得沿用旧缺口。

## 预案文案纪律

Markdown 正文与 `daily_plan_write` 结构化行一致遵守：每个字段只写该标的当日新增的信息，不复述其他字段、其他标的或全局规则已有的结论。

1. `headline` 一句话写动作、触发方式与触发价位；`auction_md`、`intraday_md` 只写竞价或分时层面当日新增的盯防点。
2. `invalidation_md` 只写可观测且该持仓特有的改判条件（具体价位、量能或事件）。停牌、跌停无法成交属于必然情形，高开放弃、跳空按开盘执行已在本提示词固定：这些内容不得写入任何预案字段，也不得换写成风险提示。
3. 没有当日新增信息的字段直接省略，不写“无”“暂无”“继续按原计划执行”等占位备注；`missing_md` 只在有真实数据缺口时填写，`risk_md` 只写当日新识别的风险。

## 输出

输出紧凑 Markdown，包含：数据日与覆盖、市场情景、全部持仓预案、短线右侧/左侧/试盘、波段信号、打板机会、近期关注变更、数据缺口和风险；持仓预案逐只紧凑陈述并遵守预案文案纪律。正式或接近候选逐只列关键证据；普通筛除项只汇总数量和主要失败原因。注明策略版本和数据截止日，结果由系统保存到 `job_run_output`。
$prompt$)
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT current_prompt.prompt_id,
         (SELECT COALESCE(max(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = current_prompt.prompt_id),
         definition.content,
         encode(sha256(convert_to(definition.content, 'UTF8')), 'hex'),
         'user',
         current_prompt.base_revision_id,
         '收紧持仓预案文案：字段只写当日增量信息，停牌等必然情形与占位备注不写入'
    FROM current_prompt CROSS JOIN definition
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
