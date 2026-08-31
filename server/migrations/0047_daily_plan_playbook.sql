-- 0047_daily_plan_playbook.sql：每日计划产出结构化盯防预案（持仓次日执行预案与市场结构池外机会），
-- 供仪表盘与持仓页直接展示；同步修订 daily_plan_flow 提示词：移除预期校对、逾期信号按条件位持续有效。

CREATE TABLE daily_plan_playbook (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_job_run_id  bigint NOT NULL REFERENCES job_run(id),
  plan_output_id     bigint REFERENCES job_run_output(id),
  target_date        date NOT NULL,
  item_kind          text NOT NULL,
  instrument_id      bigint NOT NULL REFERENCES market_instrument(id),
  code               text NOT NULL,
  name               text NOT NULL,
  grade              text,
  priority           integer NOT NULL DEFAULT 100,
  action             text NOT NULL,
  trigger_kind       text NOT NULL,
  price_lower        numeric,
  price_upper        numeric,
  headline           text NOT NULL,
  auction_md         text,
  intraday_md        text,
  evidence_md        text,
  missing_md         text,
  invalidation_md    text,
  risk_md            text,
  status             text NOT NULL DEFAULT 'draft',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_plan_playbook_run_item_unique UNIQUE (source_job_run_id, item_kind, code),
  CONSTRAINT daily_plan_playbook_kind_check CHECK (item_kind IN ('position_action', 'off_pool_opportunity')),
  CONSTRAINT daily_plan_playbook_grade_check CHECK (grade IS NULL OR grade IN ('A', 'B', 'C')),
  CONSTRAINT daily_plan_playbook_action_check
    CHECK (action IN ('exit', 'reduce', 'buy', 'hold', 'observe')),
  CONSTRAINT daily_plan_playbook_trigger_check
    CHECK (trigger_kind IN ('open', 'price_range', 'condition')),
  CONSTRAINT daily_plan_playbook_status_check CHECK (status IN ('draft', 'active', 'superseded')),
  CONSTRAINT daily_plan_playbook_price_check
    CHECK ((price_lower IS NULL OR price_lower > 0) AND (price_upper IS NULL OR price_upper > 0)),
  CONSTRAINT daily_plan_playbook_headline_check CHECK (length(btrim(headline)) > 0)
);

COMMENT ON TABLE daily_plan_playbook IS
  '每日计划的结构化盯防预案；draft 由任务会话写入，任务成功后激活并绑定 plan_output_id';

CREATE INDEX daily_plan_playbook_active
  ON daily_plan_playbook (plan_output_id, item_kind, priority)
  WHERE status = 'active';

-- 任务级能力开关：允许每日计划会话调用 daily_plan_write。
UPDATE job_definition
   SET config = config || '{"daily_plan_write": true}'::jsonb, updated_at = now()
 WHERE code = 'daily_plan_flow'
   AND (config->>'daily_plan_write') IS DISTINCT FROM 'true';

-- 提示词追加“执行纪律与预案结构化输出”章节；幂等条件为章节标题未出现。
WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'daily_plan_flow'
     AND prompt.status = 'active'
     AND revision.content NOT LIKE '%## 执行纪律与预案结构化输出%'
), prepared AS (
  SELECT prompt_id, base_revision_id,
         content || $execution_playbook$

## 执行纪律与预案结构化输出

1. 本任务不进行预期校对：不引用《预期校对》指引，最终 Markdown 不得包含“预期校对”小节或 E5/E6 式评分回评；上一份计划的未决事项只作为连续性输入使用。
2. 逾期信号的执行口径：上一交易日已生成且当日未成交的信号不得写成“开盘补执行”。带触发价位的信号保持原触发条件继续有效——卖出类（止损/减半目标）在次日盘中最先触及触发价位时执行，若跳空越过触发价位则以开盘价直接执行并按实际成交登记执行符合度；买入类在次日回落进入触发区间时执行，高开越过区间上沿则当日放弃；信号全天未触发则保持至失效或被后续计划明确取代。仅时间型退出（时间兜底、观察期到期、止损位切换生效日等没有触发价位的退出）在下一交易日开盘执行。每个未执行信号必须写明当前触发价位和失效条件。
3. 在输出最终 Markdown 前，调用一次 `daily_plan_write` 提交两类结构化行：
   - position_action：每笔真实持仓一行。action 取 exit/reduce/buy/hold；trigger_kind 取 open（时间型开盘执行）或 price_range（给出 price_lower/price_upper 触发区间）；headline 一句话写清做什么、依据什么；auction_md 写集合竞价观察要点与高低开/平开三种开局的应对；intraday_md 写分时盯防位与确认规则；invalidation_md 写失效或改判条件。
   - off_pool_opportunity：“市场结构池外机会”每标的一行，grade 按 A（涨停连板、龙虎榜净买与板块聚集多重证据共振）/B（两类证据）/C（单一证据待验证）标定；priority 用 1 起连续升序表示推荐顺序，最多 10 行；evidence_md 写证据摘要，missing_md 写尚缺条件，invalidation_md 写失效条件，risk_md 写主要风险。
4. `daily_plan_write` 只能调用一次且不可修改；position_action 标的必须是 `portfolio_position` 中数量大于 0 的真实持仓，off_pool_opportunity 标的必须是池外标的（既非持仓也非任何当前池成员）；工具拒绝的行必须修正重试，无法解决时列入数据缺口并在 Markdown 说明省略原因。
5. 最终 Markdown 增加“次日执行预案”小节：以表格汇总全部 position_action（标的、动作、触发方式、关键价位、竞价与分时要点摘要），并与结构化数据严格一致；“市场结构池外机会”小节保留完整论述并逐只标注 A/B/C 评级与推荐顺序。
$execution_playbook$ AS content
    FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prepared.prompt_id,
         (SELECT COALESCE(MAX(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = prepared.prompt_id),
         prepared.content,
         encode(sha256(convert_to(prepared.content, 'UTF8')), 'hex'),
         'user',
         prepared.base_revision_id,
         '移除预期校对；逾期信号改按触发价位持续有效；新增持仓盯防预案与池外机会结构化输出'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
