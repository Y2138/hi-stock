-- 0188：晚间预览任务的模型常把 daily_plan_context_query 的 date 传成下一交易日，
-- 完成门禁按运行目标日丢弃结果后任务仍成功。明确“date 必须是运行目标日”，
-- 并把 daily_plan_context_query 与 evening_preview_write 设为硬性完成条件。

WITH prompt AS (
  SELECT p.id AS prompt_id, p.current_revision_id AS base_revision_id, r.revision_no
    FROM job_prompt p JOIN job_prompt_revision r ON r.id = p.current_revision_id
   WHERE p.code = 'evening_plan_preview'
), definition(content) AS (VALUES ($prompt$
# 晚间明日预案预览

目标：19:15 收盘后为下一交易日生成一份轻量预判，供 19:30 精选邮件使用。它不替代早盘 09:05 的每日交易计划，不执行交易、不修改持仓、关注或策略；早盘计划会覆盖本预览。

1. 必须调用一次 `daily_plan_context_query(date=本次运行目标日)`。**date 必须是任务运行目标日（今日），不是下一交易日**；传错日期会被完成门禁丢弃，任务不能收尾。只读返回市场温度、风险门禁、板块当日强弱、全部持仓与关键点位、所属行业；数据日以返回的 `market.data_date` 为准。
2. 生成 3—4 个下一交易日大盘情景：概率合计 100%，基准 30%—50%，不得给 100% 或 0%。每个情景写标签（基准/乐观/悲观/尾部）、概率、一句话观点、可观测触发（量能/涨跌家数/板块/指数位）、应对、失效条件。关键指数位工具未返回就列缺口，不臆造。
3. 对返回的每只持仓写 2—3 个下一交易日最可能情景，概率合计 100%，先写基准；每个情景必须有可观测触发（具体价位/量能/板块）、应对、失效条件。不要固定凑五类，不写“可能上涨/下跌”这类没有操作含义的句子。做 T 只在基准或宽幅情景写，且硬性退出优先。
4. 必须调用一次 `evening_preview_write`，提交 `as_of`、`market_forecast`、`positions`；`market_forecast` 与每日计划同结构（scenarios 3—4 个、概率合计 100、key_levels），`positions` 每只 2—3 个情景。服务端按运行目标日自动计算下一交易日并落库，不需要你传目标日。未调用本工具不得收尾。
5. 正文输出 Markdown：一级标题 `# 晚间明日预案预览（数据日 YYYY-MM-DD）`；小节固定为 `## 一、明日大盘预期`、`## 二、持仓预案预览`、`## 结论摘要`；开头明确“晚间预判，早盘每日计划覆盖”。大盘先一张表 `情景｜概率｜观点｜触发｜应对｜失效`；持仓逐只列代码｜名称｜动作｜2—3 个情景（含概率、触发、应对、失效）。
$prompt$::text)), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prompt_id, revision_no + 1, definition.content,
         encode(sha256(convert_to(definition.content, 'UTF8')), 'hex'), 'user', base_revision_id,
         '明确 daily_plan_context_query 必须使用运行目标日，并把结构化写入设为硬门禁'
    FROM prompt CROSS JOIN definition
  RETURNING prompt_id, id
)
UPDATE job_prompt p SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted WHERE p.id = inserted.prompt_id;
