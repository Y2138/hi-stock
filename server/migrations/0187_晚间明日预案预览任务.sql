-- 0187：晚间“明日预案预览”轻量任务。
-- 19:15 收盘后为下一交易日生成大盘概率情景与持仓预览，供 19:30 精选邮件读取；
-- 早盘 daily_plan_flow 仍是最终执行预案，本表只做预判，不写持仓/关注/交易。

CREATE TABLE daily_plan_evening_preview (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_date       date NOT NULL,
  account_id        bigint NOT NULL REFERENCES portfolio_account(id) ON DELETE CASCADE,
  source_job_run_id bigint NOT NULL REFERENCES job_run(id) ON DELETE CASCADE,
  as_of             date NOT NULL,
  market_forecast   jsonb NOT NULL,
  position_previews jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_plan_evening_preview_market_object_check
    CHECK (jsonb_typeof(market_forecast) = 'object'),
  CONSTRAINT daily_plan_evening_preview_positions_array_check
    CHECK (jsonb_typeof(position_previews) = 'array'),
  CONSTRAINT daily_plan_evening_preview_unique
    UNIQUE (target_date, account_id)
);

CREATE INDEX daily_plan_evening_preview_target
  ON daily_plan_evening_preview (target_date);

COMMENT ON TABLE daily_plan_evening_preview IS
  '晚间轻量“明日预案预览”：每个账户每个目标日一行；精选邮件读取，早盘每日计划覆盖';
COMMENT ON COLUMN daily_plan_evening_preview.id IS '自增主键';
COMMENT ON COLUMN daily_plan_evening_preview.target_date IS '预览对应的下一交易日';
COMMENT ON COLUMN daily_plan_evening_preview.account_id IS '预览所属账户';
COMMENT ON COLUMN daily_plan_evening_preview.source_job_run_id IS '生成本预览的晚间任务运行';
COMMENT ON COLUMN daily_plan_evening_preview.as_of IS '预览所依据的行情数据日';
COMMENT ON COLUMN daily_plan_evening_preview.market_forecast IS
  '大盘概率情景：{as_of,summary_md,scenarios:[{label,probability,view,triggers,response,invalidation}],key_levels}';
COMMENT ON COLUMN daily_plan_evening_preview.position_previews IS
  '逐只持仓预览：[{code,action,headline,scenarios:[{label,probability,trigger,response,invalidation}],key_levels}]';
COMMENT ON COLUMN daily_plan_evening_preview.created_at IS '创建时间';
COMMENT ON COLUMN daily_plan_evening_preview.updated_at IS '最后更新时间';

INSERT INTO job_prompt (code, name, status)
VALUES ('evening_plan_preview', '晚间明日预案预览', 'active');

WITH prompt AS (
  SELECT id AS prompt_id FROM job_prompt WHERE code = 'evening_plan_preview'
), definition(content) AS (VALUES ($prompt$
# 晚间明日预案预览

目标：19:15 收盘后为下一交易日生成一份轻量预判，供 19:30 精选邮件使用。它不替代早盘 09:05 的每日交易计划，不执行交易、不修改持仓、关注或策略；早盘计划会覆盖本预览。

1. 调用一次 `daily_plan_context_query(date=目标日)`。目标是本次运行目标日（今日收盘日）；只读返回市场温度、风险门禁、板块当日强弱、全部持仓与关键点位、所属行业。数据日以返回的 `market.data_date` 为准，不用当前实时价替代收盘事实。
2. 生成 3—4 个下一交易日大盘情景：概率合计 100%，基准 30%—50%，不得给 100% 或 0%。每个情景写标签（基准/乐观/悲观/尾部）、概率、一句话观点、可观测触发（量能/涨跌家数/板块/指数位）、应对、失效条件。关键指数位工具未返回就列缺口，不臆造。
3. 对返回的每只持仓写 2—3 个下一交易日最可能情景，概率合计 100%，先写基准；每个情景必须有可观测触发（具体价位/量能/板块）、应对、失效条件。不要固定凑五类，不写“可能上涨/下跌”这类没有操作含义的句子。做 T 只在基准或宽幅情景写，且硬性退出优先。
4. 调用一次 `evening_preview_write`，提交 `as_of`、`market_forecast`、`positions`；`market_forecast` 与每日计划同结构（scenarios 3—4 个、概率合计 100、key_levels），`positions` 每只 2—3 个情景。服务端按运行目标日自动计算下一交易日并落库，不需要你传目标日。
5. 正文输出 Markdown：一级标题 `# 晚间明日预案预览（数据日 YYYY-MM-DD）`；小节固定为 `## 一、明日大盘预期`、`## 二、持仓预案预览`、`## 结论摘要`；开头明确“晚间预判，早盘每日计划覆盖”。大盘先一张表 `情景｜概率｜观点｜触发｜应对｜失效`；持仓逐只列代码｜名称｜动作｜2—3 个情景（含概率、触发、应对、失效）。
$prompt$::text)), inserted AS (
  INSERT INTO job_prompt_revision (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prompt.prompt_id, 1, definition.content,
         encode(sha256(convert_to(definition.content, 'UTF8')), 'hex'), 'user', NULL,
         '新增晚间明日预案预览提示词'
    FROM prompt CROSS JOIN definition
   WHERE NOT EXISTS (
     SELECT 1 FROM job_prompt_revision existing
      WHERE existing.prompt_id = prompt.prompt_id
        AND existing.sha256 = encode(sha256(convert_to(definition.content, 'UTF8')), 'hex')
   )
  RETURNING prompt_id, id
), selected AS (
  SELECT prompt_id, id FROM inserted
  UNION ALL
  SELECT prompt.prompt_id, revision.id
    FROM prompt CROSS JOIN definition
    JOIN job_prompt_revision revision
      ON revision.prompt_id = prompt.prompt_id
     AND revision.sha256 = encode(sha256(convert_to(definition.content, 'UTF8')), 'hex')
   WHERE NOT EXISTS (SELECT 1 FROM inserted)
   LIMIT 1
)
UPDATE job_prompt p SET current_revision_id = selected.id, updated_at = now()
  FROM selected WHERE p.id = selected.prompt_id;

INSERT INTO job_definition
  (code, name, cron, job_type, config, prompt_id, enabled, purpose, phase, priority,
   trading_day_only, execution_scope)
SELECT 'evening_plan_preview', '晚间明日预案预览', '15 19 * * 1-5', 'agent_flow', '{}'::jsonb,
       prompt.id, true,
       '19:15 收盘后为下一交易日生成轻量大盘概率情景与持仓预览，供19:30精选邮件；早盘每日计划仍为最终版。',
       '夜间', 244, true, 'account'
  FROM job_prompt prompt
 WHERE prompt.code = 'evening_plan_preview'
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, cron = EXCLUDED.cron, prompt_id = EXCLUDED.prompt_id,
  purpose = EXCLUDED.purpose, phase = EXCLUDED.phase, priority = EXCLUDED.priority,
  trading_day_only = EXCLUDED.trading_day_only, execution_scope = EXCLUDED.execution_scope,
  updated_at = now();
