-- 0075_重写集合竞价任务提示词.sql：当前版本整体替换，不再携带已失效规则或追加覆盖段。

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id
    FROM job_prompt prompt
   WHERE prompt.code = 'auction_opportunity_assessment'
     AND prompt.status = 'active'
), definition(content) AS (
  VALUES ($prompt$
# 集合竞价机会研判

目标：按目标日最终集合竞价数据，完整复核当前每日计划的打板候选，并简洁报告持仓和近期关注的竞价状态。只形成研究结论，不交易、不改持仓、不入池、不修改近期关注或策略。

## 执行流程

1. 先用 `tool_catalog` 一次加载 `auction_context_query`、`strategy_document_query`、`fetch_hithink_data`、`auction_assessment_write`。本任务不得加载或调用 `daily_plan_context_query`、`pool_context_query`、`database_schema`、`database_query`。
2. 只调用一次 `auction_context_query(date=目标日)` 获取交易日门禁、前一开市日、计划有效性、全部持仓、有效近期关注、打板候选、候选代码和逐项缺口。不得自行跨表补查。
3. `market_day.should_run=false` 时直接输出休市结论，不拉竞价数据、不回写判断。交易日历缺行但目标日为工作日时继续，以实际竞价响应决定数据是否可用。
4. 调用 `strategy_document_query(codes=["limit_up_board"])` 读取本轮锁定的当前《打板策略》，不得使用记忆或旧任务结果替代当前规则。
5. 对 `candidate_codes` 一次调用 `fetch_hithink_data`：包含目标日 `auction_short_term_benchmark`，并用 `auction_snapshot`、`stage="final"` 分批覆盖全部代码，每批不超过100只。核对响应日期、阶段、状态、数据时间和代码覆盖；不得用盘中行情、旧快照或常识补值。

## 判断与回写

1. 每只打板候选只使用当前策略、原计划和实际竞价字段判断。单一高开、放量、未匹配量、标签、评级或排名都不能独立构成信号，不创造策略外阈值。
2. 数据日期/阶段不符、状态未就绪或关键字段缺失：`conclusion=unavailable`、`review_type=data_insufficient`。计划缺失、过期、日期冲突或候选与持仓/池成员冲突时同样写为数据不足，并说明原因。
3. 一字延续：达到涨停价、买方未匹配量大于0、竞价换手率不高于10%且数据完整，写 `signal_passed/one_word_continue`。
4. 换手晋级：未达涨停、相对前收涨幅在0%至5%、买方未匹配量大于0、竞价换手率不高于10%，且原信号为A或B-主升，写 `signal_passed/turnover_advance`。
5. 分歧验证：不满足前两类，但符合当前策略的分歧承接条件且未触发放弃项，写 `signal_passed/divergence`。必须列出支持证据和风险，不能把“无法判断”归入分歧。
6. 涨幅超过5%、买方未匹配量不大于0、竞价换手率超过10%、跌停、停牌或不可执行异常，写 `give_up/give_up`。
7. 有打板候选时，最终输出前只调用一次 `auction_assessment_write`，`items` 必须与 `opportunities` 代码全集完全一致。`metrics_summary` 只列实际核心字段；`assessment_summary` 保留信号等级、两类分数和名次、分类依据、风险与失效条件；标签只写接口实际值。任务成功后系统统一激活草稿。

## 输出

输出完整但紧凑的 Markdown：目标日、交易日与计划状态、数据时间、覆盖计数、逐项缺口；持仓和近期关注每只一行说明竞价状态及原预案匹配；打板候选每只一行说明原等级、关键竞价字段、复核分类、结论和理由。没有某类对象时写“无”，没有有效信号时明确写“当日无有效打板信号”。“信号通过”只表示进入用户自主的小额实盘验证，不代表成交、仓位或收益承诺。
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
         '整体替换集合竞价流程，按需加载工具并使用紧凑完整上下文'
    FROM current_prompt CROSS JOIN definition
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
