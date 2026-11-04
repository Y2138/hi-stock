-- 0186：每日计划增加“明日大盘预期”结构化事实，并把持仓情景从固定五类改为
-- 按概率排序的 2—4 个最可能情景；仪表盘与精选邮件消费同一份事实。

ALTER TABLE daily_plan_scenario
  ADD COLUMN probability integer;

ALTER TABLE daily_plan_scenario
  ADD CONSTRAINT daily_plan_scenario_probability_check
  CHECK (probability IS NULL OR (probability >= 1 AND probability <= 99));

COMMENT ON COLUMN daily_plan_scenario.probability IS
  '该情景的主观概率（1—99）；同一持仓的情景概率合计应为 100；旧数据允许为空';

CREATE TABLE daily_plan_market_forecast (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_date       date NOT NULL,
  source_job_run_id bigint NOT NULL REFERENCES job_run(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'draft',
  as_of             date NOT NULL,
  scenarios         jsonb NOT NULL,
  key_levels        jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary_md        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_plan_market_forecast_status_check
    CHECK (status IN ('draft', 'active', 'superseded')),
  CONSTRAINT daily_plan_market_forecast_scenarios_array_check
    CHECK (jsonb_typeof(scenarios) = 'array'),
  CONSTRAINT daily_plan_market_forecast_key_levels_array_check
    CHECK (jsonb_typeof(key_levels) = 'array'),
  CONSTRAINT daily_plan_market_forecast_summary_check
    CHECK (length(btrim(summary_md)) BETWEEN 1 AND 2000),
  CONSTRAINT daily_plan_market_forecast_run_unique
    UNIQUE (target_date, source_job_run_id)
);

CREATE UNIQUE INDEX daily_plan_market_forecast_active_unique
  ON daily_plan_market_forecast (target_date)
  WHERE status = 'active';

CREATE INDEX daily_plan_market_forecast_target
  ON daily_plan_market_forecast (target_date, status);

COMMENT ON TABLE daily_plan_market_forecast IS
  '每日计划的明日大盘预期：按目标日保存概率情景、关键指数位与摘要；草稿随任务成功激活';
COMMENT ON COLUMN daily_plan_market_forecast.id IS '自增主键';
COMMENT ON COLUMN daily_plan_market_forecast.target_date IS '预案目标交易日';
COMMENT ON COLUMN daily_plan_market_forecast.source_job_run_id IS '写入本预期的每日计划运行';
COMMENT ON COLUMN daily_plan_market_forecast.status IS '生命周期：draft 草稿、active 当前生效、superseded 被替代';
COMMENT ON COLUMN daily_plan_market_forecast.as_of IS '预期所依据的行情/消息数据日';
COMMENT ON COLUMN daily_plan_market_forecast.scenarios IS
  '概率情景数组：[{label,probability,view,triggers,response,invalidation}]，概率合计 100';
COMMENT ON COLUMN daily_plan_market_forecast.key_levels IS
  '关键指数位数组：[{name,support,resistance,volume_note}]';
COMMENT ON COLUMN daily_plan_market_forecast.summary_md IS '一句话总览，给仪表盘和邮件直接展示';
COMMENT ON COLUMN daily_plan_market_forecast.created_at IS '创建时间';
COMMENT ON COLUMN daily_plan_market_forecast.updated_at IS '最后更新时间';

WITH prompt AS (
  SELECT p.id AS prompt_id,p.current_revision_id AS base_revision_id,r.revision_no
    FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id
   WHERE p.code='daily_plan_flow'
), definition(content) AS (VALUES ($daily$
# 每日交易计划：个人持仓预案

目标：盘前依据目标日已确认的事实（上一交易日收盘数据与当日盘前消息面快照），先形成明日大盘预期，再覆盖全部真实持仓的当日开盘预案。只负责持仓，不扫描或推荐新的策略机会；不执行交易。

1. 用 `strategy_document_query` 读取《投资总策略》《每日计划策略》以及 `daily_plan_strategy_query` 返回的全部持仓主策略、兜底退出策略所需当前正文。
2. 只调用一次 `daily_plan_strategy_query(date=目标日)`。服务端按持仓归因运行专属与兜底退出评估并合并更严动作，直接写入每笔持仓的结构化预案，同时返回每只持仓的关键点位（均线、近10/20日高低、前日高低、当日涨跌停价）、所属板块当日表现、全市场板块强弱排行和盘前消息面。核对 `playbook_write.replaced` 与持仓数一致；缺少归因、数据或评估失败必须标注为缺口，不得自行推算退出条件。
3. 先做“明日大盘预期”，不得跳过：
   - 依据返回的市场风险、行业温度、右侧/试盘结构、板块当日排行和盘前消息面，给出 3—4 个情景；概率合计 100%，基准情景 30%—50%，不得出现 100% 或 0%。
   - 每个情景写：标签（基准/乐观/悲观/尾部）、概率、一句话观点、可观测触发（指数点位/量能/涨跌家数/板块）、应对、失效条件。
   - 至少给出创业板指、科创50、科技（TMT）或持仓主要板块的支撑、压力、量能阈值；缺数据的指数列缺口，不臆造。
4. 再做逐只持仓预案：
   - 不要求凑满五类固定情景。按概率从高到低只写 2—4 个最可能情景，概率合计 100%，先写基准（30%—50%），再写偏离情景；低概率尾部只有在有明确证据时才写。
   - 每个情景必须有可观测触发（具体价位/量能/板块）、应对、失效条件；不得写“可能上涨/下跌”这类没有操作含义的句子。
   - 做 T 区间只在基准或全天宽幅波动情景给；服务端硬性退出、减仓优先于做 T，但不免除点位输出，也不以冷却期、止盈核对期等为由拒绝给点位。
5. 调用一次 `daily_plan_scenario_write`，同时提交 `market_forecast` 和 `items`：`market_forecast` 含 as_of、summary_md、scenarios（3—4 个，概率合计 100）、key_levels（name/support/resistance/volume_note）；`items` 每只持仓 2—4 个情景，带 probability，概率合计 100。核对 `replaced_items` 与持仓数一致。结构化行只能是 `position_action`，不得调用 `daily_plan_write` 或改写服务端结果。
6. 完整正文由系统保存到 `job_run_output`，末尾输出 `## 结论摘要`，优先说明大盘基准情景、持仓退出风险和关键触发位；个人消息只发送此任务的持仓内容。

## 输出格式（固定骨架，逐次一致）

- 一级标题 `# 每日交易计划（目标日 YYYY-MM-DD，盘前预案）`；标题后用列表写策略基线、统筹调用、持仓归因与数据截止（含消息面采集时间）。
- 小节固定为：`## 一、明日大盘预期`、`## 二、逐只持仓预案`、`## 三、对立板块盯盘`、`## 四、数据缺口`、`## 结论摘要`；市场观察与数据缺口用列表。
- 明日大盘预期：先一张表 `情景｜概率｜观点｜可观测触发｜应对｜失效条件`，再列关键指数位与量能阈值。
- 每只持仓小节标题 `### 序号. 代码｜名称｜数量，成本，收盘（浮盈%）`：先一段加粗 **服务端预案**（动作、触发方式、关键价位、评估状态），再一行关键点位（支撑/压力/涨跌停），随后一张表格，列为 `情景｜概率｜可观测触发｜应对｜失效条件`，行取 2—4 个最可能情景，做 T 区间写入基准/宽幅行的应对列；表格与结构化写入严格一致。
$daily$::text)), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,revision_no+1,definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),
         'user',base_revision_id,'增加明日大盘预期与概率排序情景，取消固定五情景'
    FROM prompt CROSS JOIN definition RETURNING prompt_id,id
)
UPDATE job_prompt p SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE p.id=inserted.prompt_id;

UPDATE strategy_document
   SET content = content || $doc$

## 六、概率情景纪律

- 明日大盘预期先于个股预案：3—4 个情景，概率合计 100%，基准 30%—50%，不得给 100%。
- 每只持仓只写 2—4 个最可能情景，不必凑满五类；概率合计 100%，先写基准。
- 每个情景必须有可观测触发（具体价位/量能/板块）、应对、失效条件；不得写无操作含义的“可能上涨/下跌”。
- 做 T 区间只在基准/宽幅情景给；硬性退出优先。
$doc$,
       sha256=encode(sha256(convert_to(content || $doc$

## 六、概率情景纪律

- 明日大盘预期先于个股预案：3—4 个情景，概率合计 100%，基准 30%—50%，不得给 100%。
- 每只持仓只写 2—4 个最可能情景，不必凑满五类；概率合计 100%，先写基准。
- 每个情景必须有可观测触发（具体价位/量能/板块）、应对、失效条件；不得写无操作含义的“可能上涨/下跌”。
- 做 T 区间只在基准/宽幅情景给；硬性退出优先。
$doc$,'UTF8')),'hex'),
       updated_at=now()
 WHERE code='daily_plan_strategy';

UPDATE strategy_state SET change_seq=change_seq+1,
  current_hash=encode(sha256(convert_to((SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id)
    FROM strategy_document WHERE code NOT IN ('copper_inventory_strategy','lithium_warehouse_strategy')),'UTF8')),'hex'),
  updated_at=now() WHERE singleton=1;
