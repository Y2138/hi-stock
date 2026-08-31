-- 0050_集合竞价机会研判.sql：交易日 09:30 运行普通 Agent，结合最终竞价评估持仓、近期关注与池外机会。

CREATE TABLE daily_plan_auction_assessment (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_job_run_id     bigint NOT NULL REFERENCES job_run(id),
  assessment_output_id  bigint REFERENCES job_run_output(id) ON DELETE SET NULL,
  playbook_item_id      bigint NOT NULL REFERENCES daily_plan_playbook(id) ON DELETE CASCADE,
  code                  text NOT NULL,
  conclusion            text NOT NULL
                        CHECK (conclusion IN ('worth_entering','observe','give_up','unavailable')),
  metrics_summary       text NOT NULL CHECK (length(btrim(metrics_summary)) BETWEEN 1 AND 1000),
  assessment_summary    text NOT NULL CHECK (length(btrim(assessment_summary)) BETWEEN 1 AND 2000),
  benchmark_tags        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(benchmark_tags) = 'array'),
  data_status           text NOT NULL CHECK (data_status IN ('ready','not_ready','missing','stale')),
  data_time             timestamptz,
  status                text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','active','superseded')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_job_run_id, playbook_item_id)
);

CREATE UNIQUE INDEX daily_plan_auction_assessment_active
  ON daily_plan_auction_assessment (playbook_item_id)
  WHERE status = 'active';

INSERT INTO job_prompt (code, name)
VALUES ('auction_opportunity_assessment', '集合竞价机会研判提示词');

WITH definition(content) AS (
  VALUES ($prompt$
# 集合竞价机会研判

目标：依据本轮系统提示词已注入的当前最终策略、目标交易日的最终集合竞价数据和最新有效每日计划，评估真实持仓的竞价应对，并判断近期关注与结构化池外机会是否值得入场。任务只生成研究结论，不执行交易，不修改持仓、标的池、近期关注、策略或任务定义；完整结果由系统关联本次运行保存到 `job_run_output`，池外机会判断在任务成功后更新到“今日池外机会”。

## 日期与计划门禁

1. 先按需使用 `database_schema` 与 `database_query` 查询 `market_trading_day`。本次任务上下文中的目标日必须存在且 `is_open=true`；非交易日直接输出“休市，不执行竞价研判”，交易日历缺失时列为数据缺口并停止，不得按工作日猜测。
2. 在交易日历中找到目标日前一个开市日。查询最新一份状态有效的每日计划 `job_run_output`，并读取其已激活 `daily_plan_playbook`；结构化池外机会只接受 `item_kind='off_pool_opportunity'` 的行。
3. 每日计划的 `target_date` 不得早于前一个开市日，且必须早于本次任务目标日；这样周末生成的周一预案仍然有效。比前一个开市日更旧或日期不早于目标日的计划视为无效：保留计划日期与缺口说明，但不得对其中池外机会给出入场判断；不得改用历史计划或从全市场重新发散选股。

## 候选范围

1. 真实持仓：`portfolio_position.quantity>0` 的全部标的，并读取同一每日计划中对应的 `position_action`、集合竞价预案和失效条件。
2. 近期关注：当前有效 `pool_membership` 中在目标日仍处于关注期的全部标的，保留池别、角色、关注原因和关注起止日。已持仓标的只在持仓部分出现一次。
3. 池外机会：最新有效每日计划中按 `priority` 排序的全部结构化 `off_pool_opportunity`，保留原计划 A/B/C 评级、推荐顺序、证据、尚缺条件、失效条件和风险。与当前持仓或当前池成员冲突时标记数据异常，不按池外机会判断。

## 竞价数据

1. 先调用 `fetch_hithink_data` 获取 `auction_short_term_benchmark`，参数 `date` 使用本次任务目标日。
2. 对候选代码调用 `auction_snapshot`，`stage='final'`；单批不超过 100 只，需要时分批。必须核对响应日期、`auction_phase`、`data_status`、数据时间和返回标的覆盖。
3. `data_status` 不是 `ready`、竞价阶段不是 `final`、返回为空、日期不一致或标的缺失时，逐项列为数据缺口，不得用实时行情、旧快照或模型常识补值，也不得猜测结论。

## 判断规则

1. 逐标的使用接口实际返回的竞价涨跌幅、竞价成交额、换手率、昨日量比、竞价量比、未匹配量和短线风向标标签，并与当前最终策略及原计划证据、尚缺条件、失效条件交叉验证。
2. 高开、放量、未匹配量或短线风向标标签都只能作为证据，任何单项都不得等同于买入条件。不得创造当前策略不存在的阈值，不得把 A/B/C 评级或推荐顺序替代完整入场条件。
3. 未持仓机会只给出“值得入场”“继续观察”“放弃”之一。“值得入场”必须同时满足当前策略的完整入场条件、原计划尚缺条件已由竞价证据补齐且失效条件未触发；关键字段缺失只能“继续观察”或标记“无法判断”。
4. 真实持仓只判断“按原预案执行”“竞价转弱，升级风险”“数据不足”，说明竞价表现与原 `position_action` 是否一致；不得把本任务结论写成已成交事实，也不得自行新增卖出、减仓或加仓动作。
5. 池外机会即使判断为“值得入场”，仍须先完成现有新标的完整入池评估并由用户确认；本任务不得自动买入、自动入池或自动标记近期关注。

## 页面结构化回写

在输出最终 Markdown 前调用一次 `auction_assessment_write`，为当前每日计划的每一条结构化池外机会提交一行，代码不得遗漏或增加。`conclusion` 使用 worth_entering/observe/give_up/unavailable；`metrics_summary` 简洁列出接口实际返回的竞价核心字段；`assessment_summary` 写明策略匹配、尚缺条件、失效条件与判断依据；`benchmark_tags` 只写接口实际返回的短线风向标标签；`data_status` 使用 ready/not_ready/missing/stale，并在有可信数据时间时填写 `data_time`。竞价未就绪、计划过期或标的缺失也必须提交 unavailable 行，确保页面不会保留旧判断。工具只暂存结构化研判，任务成功后才由系统激活到“今日池外机会”。

## 输出

输出完整 Markdown，至少包含：任务目标日、前一开市日、每日计划日期、竞价数据状态与时间、候选覆盖与缺口、持仓竞价应对、新机会入场判断、总体结论与风险。逐标的写明来源（持仓/近期关注/池外机会）、原计划评级与顺序（如有）、竞价核心字段、短线风向标、策略匹配、原证据/尚缺条件/失效条件/风险、最终分类和判断依据。没有某类候选时明确写“无”。
$prompt$)
)
INSERT INTO job_prompt_revision
  (prompt_id, revision_no, content, sha256, source, change_summary)
SELECT prompt.id,
       1,
       definition.content,
       encode(sha256(convert_to(definition.content, 'UTF8')), 'hex'),
       'user',
       '新增交易日集合竞价机会研判流程'
  FROM job_prompt prompt
 CROSS JOIN definition
 WHERE prompt.code = 'auction_opportunity_assessment';

UPDATE job_prompt prompt
   SET current_revision_id = revision.id, updated_at = now()
  FROM job_prompt_revision revision
 WHERE prompt.code = 'auction_opportunity_assessment'
   AND revision.prompt_id = prompt.id
   AND revision.revision_no = 1;

INSERT INTO job_definition (code, name, cron, job_type, config, prompt_id, enabled)
SELECT 'auction_opportunity_assessment',
       '集合竞价机会研判',
       '30 9 * * 1-5',
       'agent_flow',
       '{}'::jsonb,
       prompt.id,
       true
  FROM job_prompt prompt
 WHERE prompt.code = 'auction_opportunity_assessment';
