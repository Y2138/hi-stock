-- 0108_每日流程信号收敛与任务策略接入.sql：每日计划只保留波段正式信号，右侧/试盘退为评估；
-- 全市场左侧任务停用；各定时评估任务接入任务级策略文档与关注池。
-- 背景：全市场回测验证右侧/试盘/左侧信号不具备普适性；研究流程改为本地回测，
-- 系统内任务必须读取整理后的任务级策略文档，避免只有任务提示词导致评估上下文不全。

-- 1) 全市场左侧结构反转任务停用并退役其提示词（左侧信号移除）。
UPDATE job_definition
   SET enabled = false,
       name = '已停用·全市场左侧结构反转机会筛选',
       prompt_id = NULL,
       updated_at = now()
 WHERE code = 'left_reversal_opportunity_scan';

DELETE FROM job_prompt_revision WHERE prompt_id IN (SELECT id FROM job_prompt WHERE code = 'left_reversal_opportunity_scan');
DELETE FROM job_prompt WHERE code = 'left_reversal_opportunity_scan';

-- 2) 每周评分任务停用：标的评分机制已退役，周度评分失去评分对象。
UPDATE job_definition
   SET enabled = false,
       name = '已停用·每周评分',
       updated_at = now()
 WHERE code = 'weekly_review';

-- 3) 每日交易计划提示词：波段为唯一开仓信号，右侧/试盘退为持有与概率评估，左侧仅存量口径。
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
2. 按系统提示词中的文档目录，一次读取组合总策略、每日计划任务策略和打板策略的当前正文。策略参数只取本轮锁定版本，不从历史任务结果或旧提示词补充。
3. 分别且只调用一次 `daily_plan_context_query(date=目标日)`、`swing_signal_query(date=目标日)` 和 `limit_up_signal_query(date=实际市场结构数据日)`。信号、关键位、覆盖计数和缺口直接使用工具结果，不读取原始行情序列重新计算。
4. 如需连续性，只用 `job_context_query` 读取 `daily_plan_flow` 最近一份成功的 `job_run_output` 正文；仅继承仍未触发且未失效的动作，每个历史缺口必须以本轮工具结果重新确认。

## 计划与写入

1. 市场状态、温度、同步状态和全部真实持仓以 `daily_plan_context_query` 为准。开仓信号只认 `swing_signal_query` 的 `signals`；`near_candidates` 是接近候选，`suppressed_matches` 不得写成新增信号。完整扫描后无信号时明确写“当日无新增波段信号”。
2. 右侧与试盘是评估性输出，不是开仓信号：右侧条件存活复核用于判断已持有标的能否继续持有；试盘形态推进用于评估关注标的的后续上涨概率。两者都不得产生开仓动作或写入关注。
3. 打板机会只取 `limit_up_signal_query.signals`，按当前策略排序且每日最多 4 只；A 映射 A，B-抱团/B-主升映射 B，操作固定为 `observe`。接近阈值、未进路线名次或数据不足的候选不得补入。
4. 为每笔真实持仓形成一条 `position_action`，按工具返回的 `entry_signal_type` 与 `evaluation_basis` 选择口径：波段（swing）持仓使用 `swing_triggers`（任务策略中的观察期、灾难止损、常规止损、箱顶目标与到期规则）；左侧反转（left_reversal）为存量口径，使用 `left_reversal_triggers`（初始止损、6%/16% 分批触发与 10 日到期）；右侧主升、试盘及无类型回退口径的持仓使用 `short_term_triggers`（冷却期、分批止盈、移动止损与六条件复核）。存量左侧持仓不得引用右侧六条件复核；`entry_pool_mismatch=true` 时报告池归属待确认；`evaluation_basis=manual` 或执行位字段为空时按任务策略正文人工核对。动作与触发价位一次写清。历史带价位动作在未触发、未失效、未被新计划替代前继续有效；高开越过买入区间则当日放弃，跳空越过卖出触发位则按开盘执行，这两条全局规则只在本文声明一次。
5. 全部扫描完成后只调用一次 `pool_attention_write`。`items` 是本轮应保留的完整自动关注集合：未持仓的波段正式信号标记“已符合”，工具明确给出的接近候选标记“即将符合”；无候选也提交空数组。不得加入持仓、池外标的或覆盖人工关注。
6. 有结构化行时只调用一次 `daily_plan_write`：包含全部 `position_action` 和全部有效打板机会，内容必须与 Markdown 一致；没有持仓且没有有效打板信号时不调用，并在结果中说明无可写预案。
7. 任一工具状态为 `partial/unavailable/missing`、覆盖数不一致或存在 `gaps` 时逐项报告影响；否则不得把未命中写成未核验，也不得沿用旧缺口。

## 预案文案纪律

Markdown 正文与 `daily_plan_write` 结构化行一致遵守：每个字段只写该标的当日新增的信息，不复述其他字段、其他标的或全局规则已有的结论。

1. `headline` 一句话写动作、触发方式与触发价位；`auction_md`、`intraday_md` 只写竞价或分时层面当日新增的盯防点。
2. `invalidation_md` 只写可观测且该持仓特有的改判条件（具体价位、量能或事件）。停牌、跌停无法成交属于必然情形，高开放弃、跳空按开盘执行已在本提示词固定：这些内容不得写入任何预案字段，也不得换写成风险提示。
3. 没有当日新增信息的字段直接省略，不写“无”“暂无”“继续按原计划执行”等占位备注；`missing_md` 只在有真实数据缺口时填写，`risk_md` 只写当日新识别的风险。

## 输出

输出紧凑 Markdown，包含：数据日与覆盖、市场情景、全部持仓预案、波段信号、右侧与试盘评估、打板机会、近期关注变更、数据缺口和风险；持仓预案逐只紧凑陈述、逐只标注评估口径并遵守预案文案纪律。正式或接近候选逐只列关键证据；普通筛除项只汇总数量和主要失败原因。注明策略版本和数据截止日，结果由系统保存到 `job_run_output`。
$prompt$)
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT current_prompt.prompt_id,
         (SELECT COALESCE(max(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = current_prompt.prompt_id),
         definition.content,
         encode(sha256(convert_to(definition.content,'UTF8')),'hex'),
         'user',
         current_prompt.base_revision_id,
         '信号收敛：波段为唯一开仓信号，右侧/试盘退为持有与概率评估，左侧仅存量持仓口径'
    FROM current_prompt CROSS JOIN definition
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;

-- 4) 周中检查改为周中关注检查：不再区分短线池，复核关注池与持仓状态。
WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id
    FROM job_prompt prompt
   WHERE prompt.code = 'midweek_check'
     AND prompt.status = 'active'
), definition(content) AS (
  VALUES ($prompt$
# 周中关注检查

目标：在每周中点复核关注池成员与真实持仓的状态变化，识别本周需要提前处理的信号与风险。只读评估，不交易、不修改持仓、不入池、不修改关注或策略。

## 执行流程

1. 用 `tool_catalog` 一次加载 `strategy_document_query`、`pool_context_query`、`job_context_query`、`daily_plan_context_query`，不加载无关工具。
2. 按系统提示词中的文档目录，一次读取当前最终策略中的组合总策略与每日计划任务策略正文。
3. 调用 `pool_context_query`（不带 codes）取得关注池完整摘要；再调用一次 `daily_plan_context_query(date=目标日)` 取得市场状态、持仓上下文与右侧/试盘评估。
4. 需要比对动作延续性时，用 `job_context_query` 读取最近一份成功的 `job_run_output`；只确认动作是否已触发、失效或被替代。

## 输出

输出紧凑 Markdown：市场状态与温度变化、关注池状态汇总（新增关注、待补信号、状态失效）、逐只持仓的持有或退出判断（按各自评估口径）、需要当日处理的动作与数据缺口。不得新增开仓信号；发现风险时给出下一交易日应执行的动作建议。
$prompt$)
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT current_prompt.prompt_id,
         (SELECT COALESCE(max(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = current_prompt.prompt_id),
         definition.content,
         encode(sha256(convert_to(definition.content,'UTF8')),'hex'),
         'user',
         current_prompt.base_revision_id,
         '池统一后周中检查改为关注池复核，不再区分短线与长线'
    FROM current_prompt CROSS JOIN definition
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;

UPDATE job_definition SET name = '周中关注检查', updated_at = now() WHERE code = 'midweek_check';

-- 5) 夜间板块机会筛选：策略文档引用随体系更新，筛除左侧规则，产出标的写入关注池。
WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content AS base_content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'nightly_sector_opportunity_scan'
     AND prompt.status = 'active')
, definition(content) AS (
  SELECT replace(replace(replace(replace(replace(base_content,
    '只形成研究观察与条件预案，不交易、不改持仓、不入池、不修改关注或策略；完整结果由系统保存到 `job_run_output`。',
    '只形成研究观察与条件预案，不交易、不改持仓、不入池、不修改策略；完整结果由系统保存到 `job_run_output`。'),
    '一次读取系统提示词中与短线、波段、试盘、打板相关的当前策略文档，至少包含 `limit_up_board`。',
    '一次读取系统提示词中与每日计划任务策略、打板相关的当前策略文档，至少包含 `limit_up_board`。'),
    'rules=["short_right","short_left","trial","swing"]',
    'rules=["short_right","trial","swing"]'),
    '8. `market_event_query` 仅在目标日相关数据集可用时，辅助核对涨停、连板、炸板或龙虎榜结构；缺失只列为增强证据缺口，不阻断任务，也不得用旧日期数据冒充目标日。',
    E'8. `market_event_query` 仅在目标日相关数据集可用时，辅助核对涨停、连板、炸板或龙虎榜结构；缺失只列为增强证据缺口，不阻断任务，也不得用旧日期数据冒充目标日。\n9. 全部复核完成后只调用一次 `pool_attention_write`，把最终入选与相对领先板块中值得跟踪的标的写入关注池：关注理由与触发条件均已成立的标记“已符合”，尚缺条件的标记“即将符合”并逐项列出缺口；已在持仓中的标的不得写入；没有合格标的时提交空数组完成对账。'),
    '没有合格标的时明确写“板块可观察，暂无合格标的”。',
    '没有合格标的时明确写“板块可观察，暂无合格标的”，并以空集合完成关注池对账。')
    FROM current_prompt
)
INSERT INTO job_prompt_revision
  (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
SELECT current_prompt.prompt_id,
       (SELECT COALESCE(max(existing.revision_no), 0) + 1
          FROM job_prompt_revision existing WHERE existing.prompt_id = current_prompt.prompt_id),
       definition.content,
       encode(sha256(convert_to(definition.content,'UTF8')),'hex'),
       'user',
       current_prompt.base_revision_id,
       '策略文档引用随体系更新，筛除左侧规则，入选标的统一写入关注池'
  FROM current_prompt CROSS JOIN definition
WHERE definition.content <> current_prompt.base_content;

UPDATE job_prompt prompt
   SET current_revision_id = latest.id, updated_at = now()
  FROM (
    SELECT id, prompt_id FROM job_prompt_revision
     WHERE prompt_id = (SELECT id FROM job_prompt WHERE code = 'nightly_sector_opportunity_scan')
     ORDER BY revision_no DESC LIMIT 1
  ) latest
 WHERE prompt.id = latest.prompt_id;

-- 6) 铜库存防守评估：接入任务级策略文档，作为解释与结论强度基准。
WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content AS base_content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'copper_inventory_signal_review'
     AND prompt.status = 'active')
, definition(content) AS (
  SELECT replace(replace(replace(replace(replace(replace(base_content,
    '本任务不读取当前最终策略，不交易、不修改持仓、不入池、不修改关注、任务、提示词或策略。',
    '本任务不交易、不修改持仓、不入池、不修改关注、任务、提示词或策略。'),
    '1. 先用 `tool_catalog` 只加载 `copper_inventory_signal_query`。',
    E'1. 先用 `tool_catalog` 只加载 `strategy_document_query` 与 `copper_inventory_signal_query`。\n2. 一次读取当前最终策略中的《铜库存防守策略》任务文档（job_code=copper_inventory_signal_review），解释口径与结论强度以该文档和工具结果共同约束。'),
    '2. 只调用一次 `copper_inventory_signal_query(date=目标日)`。',
    '3. 只调用一次 `copper_inventory_signal_query(date=目标日)`。'),
    '3. 核对 `status`、`data_summary`',
    '4. 核对 `status`、`data_summary`'),
    '4. 区分 `raw_target_exposure`',
    '5. 区分 `raw_target_exposure`'),
    '5. 展示的仓位均称为',
    '6. 展示的仓位均称为')
    FROM current_prompt
)
INSERT INTO job_prompt_revision
  (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
SELECT current_prompt.prompt_id,
       (SELECT COALESCE(max(existing.revision_no), 0) + 1
          FROM job_prompt_revision existing WHERE existing.prompt_id = current_prompt.prompt_id),
       definition.content,
       encode(sha256(convert_to(definition.content,'UTF8')),'hex'),
       'user',
       current_prompt.base_revision_id,
       '接入铜库存防守任务级策略文档，评估口径不再只依赖提示词'
  FROM current_prompt CROSS JOIN definition
WHERE definition.content <> current_prompt.base_content;

UPDATE job_prompt prompt
   SET current_revision_id = latest.id, updated_at = now()
  FROM (
    SELECT id, prompt_id FROM job_prompt_revision
     WHERE prompt_id = (SELECT id FROM job_prompt WHERE code = 'copper_inventory_signal_review')
     ORDER BY revision_no DESC LIMIT 1
  ) latest
 WHERE prompt.id = latest.prompt_id;

-- 7) 碳酸锂低暴露防守评估：接入任务级策略文档。
WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content AS base_content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'lithium_warehouse_signal_review'
     AND prompt.status = 'active')
, definition(content) AS (
  SELECT replace(replace(replace(replace(replace(base_content,
    '1. 先用 `tool_catalog` 只加载 `lithium_warehouse_signal_query`。',
    '1. 先用 `tool_catalog` 只加载 `strategy_document_query` 与 `lithium_warehouse_signal_query`，并从当前最终策略中读取《碳酸锂低暴露策略》任务文档（job_code=lithium_warehouse_signal_review）作为链路解释基准。'),
    '2. 只调用一次 `lithium_warehouse_signal_query(date=目标日)`',
    '3. 只调用一次 `lithium_warehouse_signal_query(date=目标日)`'),
    '3. 核对仓单报告日',
    '4. 核对仓单报告日'),
    '4. 区分原始目标仓位',
    '5. 区分原始目标仓位'),
    '5. 任务只解释',
    '6. 任务只解释')
    FROM current_prompt
)
INSERT INTO job_prompt_revision
  (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
SELECT current_prompt.prompt_id,
       (SELECT COALESCE(max(existing.revision_no), 0) + 1
          FROM job_prompt_revision existing WHERE existing.prompt_id = current_prompt.prompt_id),
       definition.content,
       encode(sha256(convert_to(definition.content,'UTF8')),'hex'),
       'user',
       current_prompt.base_revision_id,
       '接入碳酸锂低暴露任务级策略文档，防守链路解释不再只依赖提示词'
  FROM current_prompt CROSS JOIN definition
WHERE definition.content <> current_prompt.base_content;

UPDATE job_prompt prompt
   SET current_revision_id = latest.id, updated_at = now()
  FROM (
    SELECT id, prompt_id FROM job_prompt_revision
     WHERE prompt_id = (SELECT id FROM job_prompt WHERE code = 'lithium_warehouse_signal_review')
     ORDER BY revision_no DESC LIMIT 1
  ) latest
 WHERE prompt.id = latest.prompt_id;

-- 8) 每日A级价值错杀扫描：接入任务级策略文档，正式候选统一写入关注池。
WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content AS base_content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'value_anchor_opportunity_scan'
     AND prompt.status = 'active')
, definition(content) AS (
  SELECT replace(replace(replace(replace(replace(replace(replace(replace(base_content,
    '任务只形成研究级人工决策证据，不入池、不写关注、不写持仓、不交易，也不修改其他策略信号。',
    '任务只形成研究级人工决策证据，不入池、不写持仓、不交易，也不修改其他策略信号。'),
    '1. 只调用一次 `value_anchor_signal_query(date=目标日)`，不得使用数据库、通用行情或网页资料重新计算。',
    E'1. 用 `tool_catalog` 加载 `strategy_document_query` 与 `value_anchor_signal_query`，从当前最终策略中读取《价值错杀筛选策略》任务文档（job_code=value_anchor_opportunity_scan），候选口径与结论强度以该文档共同约束。\n2. 只调用一次 `value_anchor_signal_query(date=目标日)`，不得使用数据库、通用行情或网页资料重新计算。'),
    '2. 以工具返回的排名日期',
    '3. 以工具返回的排名日期'),
    '3. 正式候选固定要求',
    '4. 正式候选固定要求'),
    '4. 建议增配比例固定为10%',
    '5. 建议增配比例固定为10%'),
    '5. 接近候选只允许缺一个价格条件',
    '6. 接近候选只允许缺一个价格条件'),
    '主要筛除原因、数据缺口和边界。',
    E'主要筛除原因、数据缺口和边界。\n\n全部候选复核完成后只调用一次 `pool_attention_write`：正式候选标记“已符合”，接近候选标记“即将符合”并列出唯一缺口；已在持仓中的标的不得写入；没有候选时提交空数组完成对账。'),
    '没有正式候选时明确说明。',
    '没有正式候选时明确说明，并以空集合完成关注池对账。')
    FROM current_prompt
)
INSERT INTO job_prompt_revision
  (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
SELECT current_prompt.prompt_id,
       (SELECT COALESCE(max(existing.revision_no), 0) + 1
          FROM job_prompt_revision existing WHERE existing.prompt_id = current_prompt.prompt_id),
       definition.content,
       encode(sha256(convert_to(definition.content,'UTF8')),'hex'),
       'user',
       current_prompt.base_revision_id,
       '接入价值错杀任务级策略文档，正式候选统一写入关注池'
  FROM current_prompt CROSS JOIN definition
WHERE definition.content <> current_prompt.base_content;

UPDATE job_prompt prompt
   SET current_revision_id = latest.id, updated_at = now()
  FROM (
    SELECT id, prompt_id FROM job_prompt_revision
     WHERE prompt_id = (SELECT id FROM job_prompt WHERE code = 'value_anchor_opportunity_scan')
     ORDER BY revision_no DESC LIMIT 1
  ) latest
 WHERE prompt.id = latest.prompt_id;
