-- 收盘打板观察由独立策略任务承担；每日计划只生成真实持仓的个人预案。
UPDATE strategy_definition
   SET daily_plan_scope = array_remove(daily_plan_scope, 'observe'),
       runtime_version = runtime_version + 1,
       updated_at = now()
 WHERE code = 'limit_up' AND 'observe' = ANY(daily_plan_scope);

INSERT INTO job_prompt (code,name,status)
VALUES ('limit_up_close_scan','收盘打板机会扫描','active');

WITH prompt AS (
  SELECT id, current_revision_id FROM job_prompt WHERE code='limit_up_close_scan'
), definition(content) AS (VALUES ($prompt$
# 收盘打板机会扫描

目标：独立于每日计划，按目标日《涨停接力观察策略》的当前规则评估收盘打板机会，生成下一交易日可供竞价复核的结构化候选。不自动交易，也不修改持仓。

1. 用 `strategy_document_query` 读取《投资总策略》和《涨停接力观察策略》。
2. 只调用一次 `strategy_evaluation_query(strategy_code=limit_up,phase=entry,date=目标日)`；服务端按当前策略和评分基准扫描最终收盘市场结构，最多生成四只正式候选，并把结构化池外机会写入本任务草稿。不得改用每日计划结果、历史候选、盘中先手信号或通用查询自行评分。
3. 必须检查评估运行状态和 `opportunity_write.replaced` 与本轮正式信号数一致。数据缺失、等待或部分完成时列出缺口，不把未完成扫描写成“无机会”；完整扫描后零信号应明确说明。
4. 逐只说明评分路线、等级、题材结构、量价和资金/封单证据、竞价与盘中复核条件、失效条件和风险；以本轮工具结果为准，不补造阈值。
5. 输出紧凑 Markdown，末尾单独写 `## 结论摘要`，不超过六百个中文字符，供策略任务机器人推送。结果与结构化候选均由本任务保存；次日竞价与市场结构页面只读取本任务的候选。
$prompt$::text)), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt.id,1,definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),
         'user',prompt.current_revision_id,'收盘打板机会独立扫描并保存结构化候选'
    FROM prompt CROSS JOIN definition RETURNING prompt_id,id
)
UPDATE job_prompt SET current_revision_id=inserted.id, updated_at=now()
  FROM inserted WHERE job_prompt.id=inserted.prompt_id;

INSERT INTO job_definition
  (code,name,cron,job_type,config,prompt_id,enabled,purpose,phase,priority,strategy_code,agent_role)
SELECT 'limit_up_close_scan','收盘打板机会扫描','25 17 * * 1-5','agent_flow','{}'::jsonb,
       prompt.id,true,'独立完成收盘打板机会筛选、结构化落库与次日竞价候选准备。','盘后',205,'limit_up','strategy_entry_report'
  FROM job_prompt prompt WHERE prompt.code='limit_up_close_scan';

WITH prompt AS (
  SELECT p.id AS prompt_id,p.current_revision_id AS base_revision_id,r.revision_no
    FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id
   WHERE p.code='daily_plan_flow'
), definition(content) AS (VALUES ($daily$
# 每日交易计划：个人持仓预案

目标：依据目标日已确认的事实，覆盖全部真实持仓的下一交易日个人预案。只负责持仓，不扫描或推荐新的策略机会；不执行交易。

1. 用 `strategy_document_query` 读取《投资总策略》《每日计划策略》以及 `daily_plan_strategy_query` 返回的全部持仓主策略、兜底退出策略所需当前正文。
2. 只调用一次 `daily_plan_strategy_query(date=目标日)`。服务端按持仓入场策略归因调用专属退出评估器与已固化的兜底退出评估器，合并更严格的动作，并直接写入每笔持仓的结构化预案。核对 `playbook_write.replaced` 与持仓数一致；缺少归因、数据或评估失败必须标注为缺口，不得自行推算退出条件。
3. 仅对当前持仓分析大盘、所属行业/概念板块、量价、可用资金流、压力与支撑、股性与相对立板块。注明数据日期；无资金流数据时不可把成交额冒充净流入。优先复核已触发或临近触发的退出/减仓条件，做 T 不能覆盖主策略或兜底退出信号。
4. 每只持仓按适用证据列出冲高回落、开盘下砸、全天宽幅波动、强势延续、弱势破位等多情景的可观测触发、应对与失效条件。做 T 仅作为附属预案，写明低吸/兑现区、确认条件与取消条件；与退出、减仓条件冲突时禁止做 T。预案不是预测，也不承诺收益，盘中不满足条件不操作。
5. 正文只包含市场与板块观察、逐只持仓的退出/减仓/持有及多情景预案、对立板块盯盘和数据缺口。不得扫描打板、波段等入场策略，不生成池外机会或近期关注，不拼入其他策略任务的结论。结构化行只能是 `position_action`，不得调用 `daily_plan_write` 或改写服务端结果。
6. 完整正文由系统保存到 `job_run_output`。最终输出 `## 结论摘要`，优先说明持仓退出风险和关键触发位；个人消息只发送此任务的持仓内容。
$daily$::text)), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,revision_no+1,definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),
         'user',base_revision_id,'每日计划仅负责个人持仓与退出预案'
    FROM prompt CROSS JOIN definition RETURNING prompt_id,id
)
UPDATE job_prompt p SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE p.id=inserted.prompt_id;

WITH definition AS (
  SELECT replace(
           replace(
             split_part(content,'## 五、打板观察',1),
             '# 每日计划策略：持仓统筹与观察',
             '# 每日计划策略：个人持仓预案'
           ),
           '> 职责：每日计划聚合独立入场任务已经维护的关注结果，评估全部真实持仓并生成下一交易日预案；不再承担波段或其他策略的入场扫描。',
           '> 职责：每日计划仅评估全部真实持仓的专属及兜底退出条件，并生成下一交易日个人预案；所有入场与观察扫描由独立策略任务承担。'
         ) || $scope$
## 五、持仓预案与任务边界

按当前持仓逐只核对大盘、所属板块和对立板块、量价、可用资金流、股性、支撑/压力与保护位。冲高回落、开盘下砸、宽幅波动、强势延续、弱势破位只写有证据的条件情形；做 T 是附属盯盘预案，绝不能压过专属或兜底的减仓、退出和保护位。未确认的预案不视为执行指令。

涨停接力、波段、价值关注和其他入场/观察扫描及策略关注维护均由独立策略任务承担。每日计划不筛选打板机会，不写池外候选，不把其他策略任务的正文写入个人消息。
$scope$::text AS content
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

WITH prompt AS (
  SELECT p.id AS prompt_id,p.current_revision_id AS base_revision_id,r.revision_no
    FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id
   WHERE p.code='auction_opportunity_assessment'
), definition(content) AS (VALUES ($auction$
# 集合竞价复核

目标：按目标交易日的最终竞价数据复核真实持仓、有效关注来源、前一开市日收盘打板独立任务的结构化候选，以及盘中涨停梯队先手候选。不交易、不修改持仓或策略。

1. 调用 `auction_context_query(date=目标日)`，核对交易日历、前一开市日、每日计划的持仓有效性与独立收盘打板任务的候选有效性。打板只取 `limit_up_close_scan` 激活的 `off_pool_opportunity`；每日计划不再是打板来源。缺失、过期或数据不可用不得改用旧每日计划候选，也不得临时全市场选股。
2. 用 `strategy_document_query` 读取《投资总策略》和上下文要求的当前任务策略。持仓需继承当日持仓专属/兜底退出保护规则；关注来源逐项保留归属；收盘打板和盘中梯队分别按自身策略复核。
3. 一次批量调用 `fetch_hithink_data` 获取 `auction_short_term_benchmark(date=目标日)` 及 `auction_snapshot(stage=final,codes=上下文candidate_codes)`。竞价快照不得传 `date`，基准请求不得传 `codes` 或 `stage`；只认最终竞价时间和业务状态，缺数时写 unavailable。
4. 收盘打板候选逐一核对价格、买卖未匹配方向、竞价换手、竞价量与前日成交量之比、同题材共振，以及原等级、风险和失效位。高位连板候选还需按 `limit_ladder_pk` 比较前一日最高梯队的竞价状态；高度压制/释放只调整排序，不能推翻硬门禁。
5. 调用一次 `auction_assessment_write`，`items` 覆盖上下文全部收盘打板候选（无候选传空数组），`scope_items` 覆盖全部真实持仓、关注来源与盘中梯队目标键。`data_time` 只填原始 ISO 8601 时间戳；解释写入摘要。非交易日不得提交任何评估。任务成功后系统激活结果，不对无效旧候选写入判断。
6. 输出目标日期、数据日与时间、候选覆盖和缺口、持仓应对、关注复核、收盘打板复核、盘中梯队竞价结论、连板高度 PK 与风险；末尾单独输出 `## 结论摘要`，不超过六百个中文字符。没有某类候选明确写“无”，不推断实际成交。
$auction$::text)), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,revision_no+1,definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),
         'user',base_revision_id,'竞价打板候选切换为独立收盘策略任务结果'
    FROM prompt CROSS JOIN definition RETURNING prompt_id,id
)
UPDATE job_prompt p SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE p.id=inserted.prompt_id;

UPDATE strategy_document
   SET job_code='limit_up_close_scan',updated_at=now()
 WHERE code='limit_up_board';

UPDATE job_definition
   SET purpose='目标日最终集合竞价复核持仓、各策略关注、独立收盘打板候选及盘中涨停梯队，不从每日计划派生打板候选。',
       updated_at=now()
 WHERE code='auction_opportunity_assessment';

COMMENT ON TABLE daily_plan_playbook IS '持仓个人预案和独立收盘打板任务的结构化候选；按任务来源分别激活与替代';
