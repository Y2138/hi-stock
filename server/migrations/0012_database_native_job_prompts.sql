-- 0012_database_native_job_prompts.sql：Agent Flow 提示词彻底切换为数据库事实源。
-- 历史文件版本继续保留；新版本只通过 content_* 与结构化业务表读取事实。

WITH definitions(code, content) AS (
  VALUES
  ('daily_plan_flow', $daily$
# 每日交易计划预览（数据库内容库版）

目标：依据目标日已确认的数据库事实，生成下一交易日计划预览。只读、不执行交易、不修改内容库或业务表。

## 事实源

1. 规则与指引只读取 `content_document.current_revision_id` 指向的 `content_revision`；只使用 `published` 文档。需要：投资总策略、短线策略、长线策略、数据获取规范、关键位分析指引、预期校对，以及最新交易计划。同名策略按当前正文标题区分。
2. 当前持仓与账户读取 `portfolio_*`；短线/长线池读取 `pool_membership` 并用 `market_instrument` 解析标的；行情只读 `market_bar`；数据完整性读取 `job_run`、`market_fetch_run`；已有复合分析读取 `analysis_run`，基本面与估值读取 `fundamental_snapshot`、`valuation_snapshot`。
3. 禁止调用或要求文件读取工具、外部文件、CSV 或外部脚本。

## 执行

1. 用 `database_schema.describe_tables` 获取上述任务实际需要的少量表结构，再用带当前 `schema_hash` 的 `database_query` 批量查询。
2. 先取相关 `content_document` 的 `current_revision_id`，再按这些 id 取当前正文；不得把历史版本当当前规则。
3. 核对目标日 `daily_data_update` 终态、数据缺口和 `market_bar` 截止日；缺失时明确影响，不用旧值或猜测补齐。
4. 覆盖全部真实持仓和当前有效标的池，严格按内容库当前规则形成市场与板块、情景、关键位、持仓观察、新机会分层、资金组合和数据缺口预览；不创造阈值，不把研究评分替代量化条件。

## 输出

输出完整 Markdown，至少包含：数据截止与缺口、市场与板块、明日情景、关键位、全部持仓、新机会（可执行条件/预判候选分开）、资金与组合、风险。每条规则引用内容标题与版本号；每项数据注明数据库表和截止日。
$daily$),
  ('midweek_check', $midweek$
# 周中短线检查预览（数据库内容库版）

目标：只读检查短线池评分、阶段、右侧/左侧条件和市场变化，结果只写入本次 `job_run.result_md`。

1. 规则只读取 `content_document.current_revision_id` 对应的已发布正文：投资总策略、短线策略、数据获取规范；不得读取外部文件或旧任务模板。
2. 当前短线池读取 `pool_membership(pool='short', effective_to IS NULL)`，标的读取 `market_instrument`，持仓读取 `portfolio_position`，行情读取 `market_bar`，数据作业与缺口读取 `job_run`/`market_fetch_run`，已有板块或关键位结果读取 `analysis_run`。
3. 先 `describe_tables`，再用带 `schema_hash` 的结构化批量查询；先查当前内容版本 id，再取正文。
4. 覆盖全部短线池标的，按当前短线策略分别报告研究评分变化、阶段变化、右侧完整条件、左侧候选、市场/板块切换和数据缺口。评分不得替代量化条件，不删除标的，不修改持仓，不直接更新标的池。
5. 输出完整 Markdown，引用内容标题与版本号，并注明行情截止日和数据库证据。禁止文件读取工具、CSV、外部脚本或任何文件写入。
$midweek$),
  ('weekly_review', $weekly$
# 每周评分预览（数据库内容库版）

目标：只读重评短线/长线池的研究评分、角色状态和量化资格，结果只写入本次 `job_run.result_md`。

1. 规则只读取 `content_document.current_revision_id` 对应的已发布正文：投资总策略、短线策略、长线策略、股性分析、数据获取规范；不得读取外部文件。
2. 当前池角色读取 `pool_membership(effective_to IS NULL)`，标的读取 `market_instrument`，真实持仓读取 `portfolio_position`，行情读取 `market_bar`，基本面/估值读取 `fundamental_snapshot`、`valuation_snapshot`，已有分析读取 `analysis_run`。
3. 先 `describe_tables`，再用带 `schema_hash` 的结构化批量查询；先查当前内容版本 id，再取正文。数据缺失时保留原状态并列出缺口，不用旧值伪装最新值。
4. 对全部短线/长线池标的分别报告当前值、建议的新评分/阶段/角色及证据；研究评分与量化资格分开，S/A/B 只按总策略冻结规则复核，角色变化只作为待确认建议，不直接写库。
5. 输出完整 Markdown，引用内容标题与版本号，并注明数据截止日和数据库证据。禁止文件读取工具、CSV、外部脚本或任何文件写入。
$weekly$)
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT p.id,
         (SELECT COALESCE(MAX(rn.revision_no), 0) + 1 FROM job_prompt_revision rn WHERE rn.prompt_id = p.id),
         d.content,
         encode(sha256(convert_to(d.content, 'UTF8')), 'hex'),
         'user',
         p.current_revision_id,
         '切换为数据库内容库与结构化业务表，不再读取旧文件系统'
    FROM definitions d
    JOIN job_prompt p ON p.code = d.code
    LEFT JOIN job_prompt_revision current ON current.id = p.current_revision_id
   WHERE current.content IS DISTINCT FROM d.content
  RETURNING prompt_id, id
)
UPDATE job_prompt p
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE p.id = inserted.prompt_id;

UPDATE job_definition
   SET config = config - 'template_path', updated_at = now()
 WHERE job_type = 'agent_flow' AND config ? 'template_path';
