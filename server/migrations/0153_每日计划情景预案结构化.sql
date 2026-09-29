-- 0153：每日计划情景预案与做 T 点位结构化落库。
-- 情景矩阵（冲高回落/开盘下砸/全天宽幅波动/强势延续/弱势破位）由模型经专用工具写入，
-- 关键点位由服务端计算写入 playbook 行；同时统一任务结论文档输出格式，并改写策略中
-- 情景/做 T 的纪律：点位依据技术面与市场板块表现，不再以冷却期、止盈核对期为由拒给。

ALTER TABLE daily_plan_playbook
  ADD COLUMN key_levels jsonb,
  ADD COLUMN t_plan jsonb;

COMMENT ON COLUMN daily_plan_playbook.key_levels IS
  '服务端计算的关键点位事实：[{kind:support|resistance|limit,label,price}]';
COMMENT ON COLUMN daily_plan_playbook.t_plan IS
  '模型提交的做T预案：{buy_lower,buy_upper,sell_lower,sell_upper,confirm_md,cancel_md} 或 {skip_reason}';

CREATE TABLE daily_plan_scenario (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  playbook_item_id  bigint NOT NULL REFERENCES daily_plan_playbook(id) ON DELETE CASCADE,
  source_job_run_id bigint NOT NULL REFERENCES job_run(id),
  scenario_kind     text NOT NULL,
  observable_md     text NOT NULL CHECK (length(btrim(observable_md)) BETWEEN 1 AND 600),
  response_md       text NOT NULL CHECK (length(btrim(response_md)) BETWEEN 1 AND 1000),
  invalidation_md   text NOT NULL CHECK (length(btrim(invalidation_md)) BETWEEN 1 AND 600),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_plan_scenario_kind_check CHECK (scenario_kind IN
    ('surge_reversal', 'open_plunge', 'wide_swing', 'strong_continuation', 'weak_breakdown')),
  CONSTRAINT daily_plan_scenario_item_kind_unique UNIQUE (playbook_item_id, scenario_kind)
);

CREATE INDEX daily_plan_scenario_item ON daily_plan_scenario (playbook_item_id);

COMMENT ON TABLE daily_plan_scenario IS
  '持仓情景预案矩阵；生命周期随 daily_plan_playbook 行（draft/active/superseded 一并过滤）';
COMMENT ON COLUMN daily_plan_scenario.id IS '自增主键';
COMMENT ON COLUMN daily_plan_scenario.playbook_item_id IS '所属持仓预案行；草稿行删除时级联清理';
COMMENT ON COLUMN daily_plan_scenario.source_job_run_id IS '写入本情景的任务运行，审计与覆盖核对用';
COMMENT ON COLUMN daily_plan_scenario.scenario_kind IS '情景类型：冲高回落/开盘下砸/全天宽幅波动/强势延续/弱势破位';
COMMENT ON COLUMN daily_plan_scenario.observable_md IS '可观测触发：必须引用具体价位的事实描述';
COMMENT ON COLUMN daily_plan_scenario.response_md IS '应对：该情景下的盯防或执行动作';
COMMENT ON COLUMN daily_plan_scenario.invalidation_md IS '失效条件：本情景应对失去效力的判定';
COMMENT ON COLUMN daily_plan_scenario.created_at IS '写入时间';

WITH prompt AS (
  SELECT p.id AS prompt_id,p.current_revision_id AS base_revision_id,r.revision_no
    FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id
   WHERE p.code='daily_plan_flow'
), definition(content) AS (VALUES ($daily$
# 每日交易计划：个人持仓预案

目标：依据目标日已确认的事实，覆盖全部真实持仓的下一交易日个人预案。只负责持仓，不扫描或推荐新的策略机会；不执行交易。

1. 用 `strategy_document_query` 读取《投资总策略》《每日计划策略》以及 `daily_plan_strategy_query` 返回的全部持仓主策略、兜底退出策略所需当前正文。
2. 只调用一次 `daily_plan_strategy_query(date=目标日)`。服务端按持仓归因运行专属与兜底退出评估并合并更严动作，直接写入每笔持仓的结构化预案，同时返回每只持仓的关键点位（均线、近10/20日高低、前日高低、当日涨跌停价）、所属板块当日表现和全市场板块强弱排行。核对 `playbook_write.replaced` 与持仓数一致；缺少归因、数据或评估失败必须标注为缺口，不得自行推算退出条件。
3. 情景预案与做 T 点位只依据返回的关键点位、市场与所属板块当日表现，不依赖初始策略归因，不以冷却期、止盈核对期等为由拒绝给点位。做 T 默认写明低吸区、兑现区、确认与取消条件，仅一字板、停牌等流动性极端可不设并显式说明原因；服务端预案的硬性退出、减仓触发只决定优先级，不免除点位输出。
4. 每只持仓按适用证据列出冲高回落、开盘下砸、全天宽幅波动、强势延续、弱势破位情景的可观测触发（引用具体价位）、应对与失效条件。对立板块盯盘使用返回的持仓板块归属与板块当日排行，缺哪项列哪项缺口，不臆测。
5. 调用一次 `daily_plan_scenario_write`，按持仓提交情景矩阵、做 T 区间与集合竞价、分时盯防、失效改判、风险字段；核对 `replaced_items` 与持仓数一致。结构化行只能是 `position_action`，不得调用 `daily_plan_write` 或改写服务端结果。
6. 完整正文由系统保存到 `job_run_output`，末尾输出 `## 结论摘要`，优先说明持仓退出风险和关键触发位；个人消息只发送此任务的持仓内容。

## 输出格式（固定骨架，逐次一致）

- 一级标题 `# 每日交易计划（目标日 YYYY-MM-DD，下一交易日预案）`；标题后用列表写策略基线、统筹调用、持仓归因与数据截止。
- 小节固定为：`## 一、市场与板块观察`、`## 二、逐只持仓预案`、`## 三、对立板块盯盘`、`## 四、数据缺口`、`## 结论摘要`；市场观察与数据缺口用列表。
- 每只持仓小节标题 `### 序号. 代码｜名称｜数量，成本，收盘（浮盈%）`：先一段加粗 **服务端预案**（动作、触发方式、关键价位、评估状态），再一行关键点位（支撑/压力/涨跌停），随后一张表格，列为 `情景｜可观测触发｜应对｜失效条件`，行取五情景中适用者，做 T 区间写入「全天宽幅波动」行的应对列；表格与结构化写入严格一致。
$daily$::text)), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,revision_no+1,definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),
         'user',base_revision_id,'统一结论文档格式，情景与做T预案结构化落库'
    FROM prompt CROSS JOIN definition RETURNING prompt_id,id
)
UPDATE job_prompt p SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE p.id=inserted.prompt_id;

WITH definition AS (
  SELECT replace(
           content,
           '按当前持仓逐只核对大盘、所属板块和对立板块、量价、可用资金流、股性、支撑/压力与保护位。冲高回落、开盘下砸、宽幅波动、强势延续、弱势破位只写有证据的条件情形；做 T 是附属盯盘预案，绝不能压过专属或兜底的减仓、退出和保护位。未确认的预案不视为执行指令。',
           '情景预案与做 T 点位只依据个股自身关键点位（均线、近10/20日高低点、前日高低、当日涨跌停价）、市场与所属板块当日表现和全市场板块强弱，不依赖持仓的初始策略归因，也不以冷却期、止盈核对期等状态为由拒绝给出点位。做 T 预案默认写明低吸区、兑现区、确认与取消条件，仅一字板、停牌等流动性极端情况可不设且必须显式说明原因。服务端预案的硬性退出、减仓触发仍优先于做 T，但只决定执行优先级，不免除点位输出。未确认的预案不视为执行指令。'
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
