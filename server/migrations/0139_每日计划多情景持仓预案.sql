-- 细化每日计划：只服务个人持仓消息，补充市场、板块、量价、资金、关键位、股性与多情景做T预案。
WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'daily_plan_flow'
), definition AS (
  SELECT prompt_id, base_revision_id,
         content || $prompt$

## 每日计划职责边界

每日计划只负责当前真实持仓的个人交易预案，以及与持仓直接相关的大盘、所属板块和对立板块观察；不得承担通用策略任务、全市场策略筛选、夜间研究或其他策略任务的完整结论。通用策略任务由独立任务输出，不能把它们的正文拼入每日计划。

## 持仓评估细则

对每一只真实持仓，必须在当前可用数据范围内综合说明：

1. 大盘环境：指数趋势、短中期均线、成交额/量能、涨跌家数或市场结构、风险偏好与主要压力/支撑区域；数据缺失时明确缺口，不用常识补值。
2. 所属板块：板块相对大盘强弱、近一日与阶段表现、量价变化、资金流入流出或可用的替代资金证据、板块关键压力/支撑，以及板块内部强弱。
3. 个股证据：收盘价与成交量变化、量价是否匹配、近端高低点和均线压力位/支撑位、前高前低与缺口等可观测关键位、资金流向（若数据可用）、波动和回撤特征、股性/历史对市场环境的响应。每个数值注明数据日。
4. 交易预案：除退出、减仓、持有或观察外，必须在适用时给出做 T 预案，分别写明低吸区、冲高兑现区、确认条件、仓位上限或不得追涨的边界；做 T 只是条件预案，不是自动交易指令，也不得承诺成功。
5. 对立板块观察：至少列出与当前持仓主线表现相反、可能分流资金或反映风险偏好的板块；说明观察理由和它对持仓预案的影响，没有可信数据时写明未能形成结论。

## 下一交易日多情景预案

每只持仓至少按实际证据覆盖适用情形，不得只写单一涨跌判断。优先使用以下情形并逐项写出“触发特征—应对动作—失效条件”：

- 冲高回落：高开或快速上冲至压力位、量价背离或板块转弱时，何处观察兑现/减仓，何处不追。
- 开盘后下砸洗盘：低开或开盘快速下探但未破关键支撑、板块未同步转弱时，如何区分洗盘与结构破坏，是否允许分批低吸做 T。
- 全天宽幅波动：上下反复、量能放大但方向不明时，明确不追涨、不在无确认时加仓，以及 T 的撤销条件。
- 强势延续：放量站稳压力位、板块同步走强时，说明持有或回踩确认条件，不把突破本身写成必然上涨。
- 弱势破位：跌破关键支撑且量价、板块或大盘共振转弱时，明确减仓/退出复核条件。

情形可以合并，但不能用“视盘中情况而定”代替触发条件。预案按可能性和证据强弱排序，明确哪些信号优先级更高；无法可靠排序时写“仅列情形，不比较概率”。正文必须反复提示预案不准确，盘中只按已定义的触发和失效条件执行，避免冲动型交易。

## 输出补充要求

在“市场情景”后增加“持仓多情景预案与做T边界”和“对立板块观察”两部分；逐只持仓同时给出行动、关键位、量价/资金/股性证据、情景应对、做T撤销条件和数据缺口。结构化 `position_action` 的 `headline`、`auction_md`、`intraday_md`、`risk_md`、`invalidation_md` 只能写与该持仓对应的可执行条件，不写确定性预测。个人消息摘要优先保留持仓情景、关键触发位和做T边界，通用策略任务摘要不得混入。
$prompt$::text AS content
    FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT definition.prompt_id,
         (SELECT COALESCE(max(revision_no), 0) + 1 FROM job_prompt_revision WHERE job_prompt_revision.prompt_id = definition.prompt_id),
         definition.content,
         encode(sha256(convert_to(definition.content, 'UTF8')), 'hex'),
         'user',
         definition.base_revision_id,
         '每日计划只负责个人持仓，并细化多情景与做T预案'
    FROM definition
  RETURNING id, prompt_id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id,
       updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
