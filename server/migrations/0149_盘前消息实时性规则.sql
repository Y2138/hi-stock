-- 0149_盘前消息实时性规则.sql：固化盘前单标的消息覆盖和实时性写入要求。
WITH current_prompt AS (
  SELECT p.id AS prompt_id, p.current_revision_id AS base_revision_id, r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id = p.current_revision_id
   WHERE p.code = 'pre_market_news_scan'
), definition(content) AS (VALUES ($prompt$
# 盘前消息面探查

目标：在盘前生成最新、可追溯的市场消息快照，并为当前关注池中的单个标的建立消息关联。只做事实核验和研究提示，不修改策略正文、策略评分、关注池成员或交易计划。

1. 先调用 `pool_context_query` 读取当前关注池标的、代码、名称和所属板块；再分三层检索：市场底盘（宏观、货币、监管、交易所、海外和关键商品）、策略关联（关注池标的及其板块）、异常扩展（最近盘前出现可靠来源反复报道且尚未在关注池中的新主题）。
2. 所有搜索优先使用 `web_search`，`recency_days` 设为 2；对重要结果使用 `web_fetch` 核验正文。金十数据通过 `domains:["jin10.com"]` 或其官网结果检索，不使用专用 MCP。必须保留发布时间；缺少发布时间且无法由正文确认的结果降为待核验，不得标记为高影响。
3. 一级来源包括政府、监管、交易所和上市公司正式披露；专业财经网站只支持“该平台在该时点报道”。社交媒体、匿名爆料和无法追溯转载不得写入消息卡片。
4. 只写入最近 48 小时内仍有效的消息。每条消息明确分类、影响范围、方向、影响力、来源等级、事实摘要和对关联标的的影响说明。事实与推断分开；同一事件的转载只保留一个主要来源和必要的原始来源。
5. 调用一次 `pool_news_write` 写入完整结果：target_date 必须是今日，market_bias、summary、items、checked_codes（实际逐股检索完成的代码）和 gaps（搜索失败、未覆盖和实时性缺口）。无相关消息的已检索标的仍写入 checked_codes；未检索的不能标为已覆盖。每条 item 的 codes 是同方向同解释的关联代码；同一事件对不同标的方向相反时拆成不同卡片，不能给上下游套相同方向。source_url 必须来自本次工具实际返回链接，published_at 必须从正文核实为带时区的时间，禁止从网址推测；无法确认则填 null、direction=unknown、impact_level=low。只有核验过正文和发布时间才能标 high。先按公司名与代码批量搜索，关注池分页取全，不限于第一页；无法覆盖的写入 gaps。没有有效消息时提交空 items，并明确市场底盘为 unknown；任务不因没有消息失败。消息写入完成后输出 Markdown 简报，开头包含完成标记 `> AI 生成任务结果，已关联本次任务保存；不代表策略发布或交易执行。`，结尾增加 `## 结论摘要`。

实时性硬约束：以实际抓取时间为准；结果不得声称秒级实时。若搜索结果明显滞后、发布时间缺失或当前检索时间距最新来源超过 48 小时，必须在数据缺口中说明。
$prompt$::text)), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,(SELECT max(revision_no)+1 FROM job_prompt_revision WHERE prompt_id=current_prompt.prompt_id),definition.content,
    encode(sha256(convert_to(definition.content,'UTF8')),'hex'),'user',base_revision_id,'补齐盘前消息实时性、覆盖和结构化写入规则'
  FROM current_prompt CROSS JOIN definition RETURNING id,prompt_id
)
UPDATE job_prompt p SET current_revision_id=i.id,updated_at=now() FROM inserted i WHERE p.id=i.prompt_id;

UPDATE job_definition SET cron='45 8 * * 1-5', updated_at=now() WHERE code='pre_market_news_scan';
