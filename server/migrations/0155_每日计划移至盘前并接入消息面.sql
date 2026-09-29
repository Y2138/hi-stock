-- 0155：每日计划移至盘前（消息面探查 08:45 之后、集合竞价研判 09:26 之前）执行，
-- 情景/开盘预案结合当日盘前消息面；消息面探查覆盖当前持仓标的，金十数据增加
-- 官网快讯文件直取兜底。

UPDATE job_definition SET cron='5 9 * * 1-5', updated_at=now()
 WHERE code='daily_plan_flow' AND cron IS DISTINCT FROM '5 9 * * 1-5';

WITH prompt AS (
  SELECT p.id AS prompt_id,p.current_revision_id AS base_revision_id,r.revision_no
    FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id
   WHERE p.code='daily_plan_flow'
), definition(content) AS (VALUES ($daily$
# 每日交易计划：个人持仓预案

目标：盘前依据目标日已确认的事实（上一交易日收盘数据与当日盘前消息面快照），覆盖全部真实持仓的当日开盘预案。只负责持仓，不扫描或推荐新的策略机会；不执行交易。

1. 用 `strategy_document_query` 读取《投资总策略》《每日计划策略》以及 `daily_plan_strategy_query` 返回的全部持仓主策略、兜底退出策略所需当前正文。
2. 只调用一次 `daily_plan_strategy_query(date=目标日)`。服务端按持仓归因运行专属与兜底退出评估并合并更严动作，直接写入每笔持仓的结构化预案，同时返回每只持仓的关键点位（均线、近10/20日高低、前日高低、当日涨跌停价）、所属板块当日表现、全市场板块强弱排行和盘前消息面（快照采集时间、市场方向、摘要与逐持仓消息关联）。核对 `playbook_write.replaced` 与持仓数一致；缺少归因、数据或评估失败必须标注为缺口，不得自行推算退出条件。
3. 情景预案与做 T 点位只依据返回的关键点位、市场与所属板块当日表现和盘前消息面，不依赖初始策略归因，不以冷却期、止盈核对期等为由拒绝给点位。开盘下砸、冲高回落情景先引用盘前消息面判断跳空方向与力度；消息面缺失、过期或未覆盖标的列为缺口，不臆测。做 T 默认写明低吸区、兑现区、确认与取消条件，仅一字板、停牌等流动性极端可不设并显式说明原因；服务端预案的硬性退出、减仓触发只决定优先级，不免除点位输出。
4. 每只持仓按适用证据列出冲高回落、开盘下砸、全天宽幅波动、强势延续、弱势破位情景的可观测触发（引用具体价位）、应对与失效条件。对立板块盯盘使用返回的持仓板块归属与板块当日排行，缺哪项列哪项缺口，不臆测。
5. 调用一次 `daily_plan_scenario_write`，按持仓提交情景矩阵、做 T 区间与集合竞价、分时盯防、失效改判、风险字段；核对 `replaced_items` 与持仓数一致。结构化行只能是 `position_action`，不得调用 `daily_plan_write` 或改写服务端结果。
6. 完整正文由系统保存到 `job_run_output`，末尾输出 `## 结论摘要`，优先说明持仓退出风险和关键触发位；个人消息只发送此任务的持仓内容。

## 输出格式（固定骨架，逐次一致）

- 一级标题 `# 每日交易计划（目标日 YYYY-MM-DD，盘前预案）`；标题后用列表写策略基线、统筹调用、持仓归因与数据截止（含消息面采集时间）。
- 小节固定为：`## 一、市场、板块与盘前消息面观察`、`## 二、逐只持仓预案`、`## 三、对立板块盯盘`、`## 四、数据缺口`、`## 结论摘要`；市场观察与数据缺口用列表。
- 每只持仓小节标题 `### 序号. 代码｜名称｜数量，成本，收盘（浮盈%）`：先一段加粗 **服务端预案**（动作、触发方式、关键价位、评估状态），再一行关键点位（支撑/压力/涨跌停），随后一张表格，列为 `情景｜可观测触发｜应对｜失效条件`，行取五情景中适用者，做 T 区间写入「全天宽幅波动」行的应对列；表格与结构化写入严格一致。
$daily$::text)), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,revision_no+1,definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),
         'user',base_revision_id,'任务移至盘前执行，情景与开盘预案结合盘前消息面'
    FROM prompt CROSS JOIN definition RETURNING prompt_id,id
)
UPDATE job_prompt p SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE p.id=inserted.prompt_id;

WITH current_prompt AS (
  SELECT p.id AS prompt_id, p.current_revision_id AS base_revision_id, r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id = p.current_revision_id
   WHERE p.code = 'pre_market_news_scan'
), definition(content) AS (VALUES ($prompt$
# 盘前消息面探查

目标：在盘前生成最新、可追溯的市场消息快照，并为当前关注池和当前持仓中的单个标的建立消息关联。只做事实核验和研究提示，不修改策略正文、策略评分、关注池成员或交易计划。

1. 先调用 `pool_context_query` 读取当前关注池标的、代码、名称和所属板块，并用 `database_query` 查询当前持仓代码清单；再分三层检索：市场底盘（宏观、货币、监管、交易所、海外和关键商品）、策略关联（关注池与当前持仓标的及其板块）、异常扩展（最近盘前出现可靠来源反复报道且尚未在关注池中的新主题）。
2. 所有搜索优先使用 `web_search`，`recency_days` 设为 2；对重要结果使用 `web_fetch` 核验正文。金十数据先用 `domains:["jin10.com"]` 检索；域内无可用的 48 小时内条目时，直接 `web_fetch` 核验 `https://www.jin10.com/flash_newest.js`（金十官网最新快讯文件，逐条含 time 发布时间），以该文件作为金十来源，不使用专用 MCP。必须保留发布时间；缺少发布时间且无法由正文确认的结果降为待核验，不得标记为高影响。
3. 一级来源包括政府、监管、交易所和上市公司正式披露；专业财经网站只支持“该平台在该时点报道”。社交媒体、匿名爆料和无法追溯转载不得写入消息卡片。
4. 只写入最近 48 小时内仍有效的消息。每条消息明确分类、影响范围、方向、影响力、来源等级、事实摘要和对关联标的的影响说明。事实与推断分开；同一事件的转载只保留一个主要来源和必要的原始来源。
5. 调用一次 `pool_news_write` 写入完整结果：target_date 必须是今日，market_bias、summary、items、checked_codes（实际逐股检索完成的代码）和 gaps（搜索失败、未覆盖和实时性缺口）。无相关消息的已检索标的仍写入 checked_codes；未检索的不能标为已覆盖。每条 item 的 codes 是同方向同解释的关联代码；同一事件对不同标的方向相反时拆成不同卡片，不能给上下游套相同方向。source_url 必须来自本次工具实际返回链接，published_at 必须从正文核实为带时区的时间，禁止从网址推测；无法确认则填 null、direction=unknown、impact_level=low。只有核验过正文和发布时间才能标 high。先按公司名与代码批量搜索，关注池分页取全，不限于第一页；无法覆盖的写入 gaps。没有有效消息时提交空 items，并明确市场底盘为 unknown；任务不因没有消息失败。消息写入完成后输出 Markdown 简报，开头包含完成标记 `> AI 生成任务结果，已关联本次任务保存；不代表策略发布或交易执行。`，结尾增加 `## 结论摘要`。

实时性硬约束：以实际抓取时间为准；结果不得声称秒级实时。若搜索结果明显滞后、发布时间缺失或当前检索时间距最新来源超过 48 小时，必须在数据缺口中说明。
$prompt$::text)), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,(SELECT max(revision_no)+1 FROM job_prompt_revision WHERE prompt_id=current_prompt.prompt_id),definition.content,
    encode(sha256(convert_to(definition.content,'UTF8')),'hex'),'user',base_revision_id,'覆盖当前持仓标的，金十官网快讯文件直取兜底'
  FROM current_prompt CROSS JOIN definition RETURNING id,prompt_id
)
UPDATE job_prompt p SET current_revision_id=i.id,updated_at=now() FROM inserted i WHERE p.id=i.prompt_id;

WITH definition AS (
  SELECT replace(
           content,
           '情景预案与做 T 点位只依据个股自身关键点位（均线、近10/20日高低点、前日高低、当日涨跌停价）、市场与所属板块当日表现和全市场板块强弱，不依赖持仓的初始策略归因，也不以冷却期、止盈核对期等状态为由拒绝给出点位。',
           '情景预案与做 T 点位只依据个股自身关键点位（均线、近10/20日高低点、前日高低、当日涨跌停价）、市场与所属板块当日表现、全市场板块强弱和当日盘前消息面，不依赖持仓的初始策略归因，也不以冷却期、止盈核对期等状态为由拒绝给出点位。开盘下砸、冲高回落情景先引用盘前消息面判断跳空方向与力度；消息面缺失、过期或未覆盖列为数据缺口。'
         ) AS content
    FROM strategy_document WHERE code='daily_plan_strategy'
)
UPDATE strategy_document document
   SET content=definition.content,
       sha256=encode(sha256(convert_to(definition.content,'UTF8')),'hex'),updated_at=now()
  FROM definition WHERE document.code='daily_plan_strategy';

UPDATE strategy_state SET change_seq=change_seq+1,
  current_hash=encode(sha256(convert_to((SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id)
    FROM strategy_document WHERE code NOT IN ('copper_inventory_strategy','lithium_warehouse_strategy')),'UTF8')),'hex'),
  updated_at=now() WHERE singleton=1;
