-- 0183_每周交易复盘任务.sql
-- 周维度全局复盘任务：周六对刚结束的完整交易周做只读复盘。
-- 服务端在模型运行前用确定性 SQL 生成周快照（持仓与本周交易、本周机会标的及其信号日后走势、
-- 指数与 881 一级行业板块周表现、涨跌停与涨跌家数宽度），模型只负责归因和风险预估。
-- 只读任务：不修改持仓、成交、策略、关注池或任何业务数据。

CREATE TABLE weekly_review_snapshot (
  run_id        bigint PRIMARY KEY REFERENCES job_run(id) ON DELETE CASCADE,
  version       text NOT NULL,
  target_date   date NOT NULL,
  week_start    date,
  week_end      date,
  status        text NOT NULL CHECK (status IN ('success','partial')),
  payload       jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  gaps          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(gaps) = 'array'),
  built_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX weekly_review_snapshot_date_idx ON weekly_review_snapshot (target_date DESC, built_at DESC);
COMMENT ON TABLE weekly_review_snapshot IS '每周交易复盘的服务端确定性事实快照：本机运行数据，不进入固定资产包';
COMMENT ON COLUMN weekly_review_snapshot.run_id IS '对应的复盘任务运行；重试覆盖同一行';
COMMENT ON COLUMN weekly_review_snapshot.version IS '快照结构版本，便于口径演进时识别';
COMMENT ON COLUMN weekly_review_snapshot.target_date IS '任务目标日（通常为周六）';
COMMENT ON COLUMN weekly_review_snapshot.week_start IS '复盘窗口所在自然周的周一（可能为休市日）；实际开市日见 payload.trading_days';
COMMENT ON COLUMN weekly_review_snapshot.week_end IS '复盘窗口最后一个开市日（目标日当日或之前最近开市日）';
COMMENT ON COLUMN weekly_review_snapshot.status IS 'success=无缺口；partial=存在数据缺口，报告必须列明';
COMMENT ON COLUMN weekly_review_snapshot.payload IS '账户、持仓、成交、机会标的走势、指数、板块与市场宽度结构化事实';
COMMENT ON COLUMN weekly_review_snapshot.gaps IS '快照缺口清单，按 scope 与 reason 记录';
COMMENT ON COLUMN weekly_review_snapshot.built_at IS '快照构建时间';

INSERT INTO job_prompt (code, name, status)
VALUES ('weekly_trading_review', '每周交易复盘', 'active');

WITH prompt AS (
  SELECT id AS prompt_id FROM job_prompt WHERE code = 'weekly_trading_review'
), definition(content) AS (VALUES ($prompt$
# 每周交易复盘

目标：对刚结束的完整交易周做一次只读复盘，覆盖持仓与本周产出的机会标的，解释盈亏原因与决策质量，并评估大盘与板块走势、给出下周风险预估。只读取数据库事实，不修改持仓、成交、策略、关注池或任何业务数据；不构成买卖建议，不承诺收益。

1. 调用一次 `weekly_review_context_query(date=目标日)` 取得服务端确定性周快照：复盘窗口、账户净值、持仓与本周成交、本周机会标的及信号日后走势、指数与 881 一级行业板块周表现、每日涨跌停与涨跌家数。
2. 调用 `strategy_document_query` 读取投资总策略（role=portfolio）正文，作为仓位、退出与执行纪律的评判口径。快照缺口可用 `fetch_market_data`、`stock_research_query`、`board_query`、`market_snapshot_query`、`market_event_query` 补读；本周宏观、政策、行业与持仓个股公告用 `web_search`（recency_days=7），重要来源再 `web_fetch` 核验正文与发布时间。网页只作带来源资料，不得覆盖数据库行情、持仓与成交事实。
3. 复盘窗口以快照返回的 week_start 至 week_end 为准；信号在最后交易日之后才生效的机会标的写入“下周生效、本周不计入评价”，不得事后挑选标的，不得把未触发机会算作命中。所有统计注明样本数与缺口，不以单日噪音下结论。
4. 正文按以下二级标题组织：
   - `## 一周市场与板块`：指数周涨跌与成交额变化、板块强弱与轮动、涨停/跌停/炸板/最高连板与涨跌家数反映的情绪，指出本周主线、扩散或退潮信号。
   - `## 持仓复盘`：逐账户说明本周已实现与浮动盈亏、买卖与调整动作、持仓理由是否仍成立；把亏损拆分为策略判断错误、执行偏差（追高、迟滞止损、违反仓位）和市场环境三类，引用快照事实与日期。
   - `## 机会标的复盘`：按来源给出本周机会标的的胜负分布（命中/落空/未生效），分析为什么盈或亏，区分信号本身失效、入场时点或执行问题、环境不配合。
   - `## 做得好的与做得不好的`：各写 2–4 条具体做法，带日期、标的或板块、可核对数字；说明下周可复用的做法与必须纠正的错误。
   - `## 下周风险预估`：分大盘、板块、持仓、机会四层，给出关键价位、情景、触发与失效条件、需要观察的指标与事件；风险预估是条件式判断，不给买卖指令，不保证方向。
5. 结尾保留 `## 结论摘要`：只列最终持仓动作与重点观察标的，不重复推理，不凑数；没有内容时明确说明。每个判断引用快照字段、工具结果或网页来源；数据缺失列为缺口，不猜价格、指标或盈亏。
$prompt$::text)), inserted AS (
  INSERT INTO job_prompt_revision (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prompt.prompt_id, 1, definition.content,
         encode(sha256(convert_to(definition.content, 'UTF8')), 'hex'), 'user', NULL,
         '新增每周交易复盘任务提示词'
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
  (code, name, cron, job_type, config, prompt_id, enabled, purpose, phase, priority, trading_day_only, execution_scope)
SELECT 'weekly_trading_review', '每周交易复盘', '0 9 * * 6', 'agent_flow', '{}'::jsonb, prompt.id, true,
       '每周六对最近完整交易周做只读复盘：逐账户持仓与本周成交、本周各策略与计划产出的机会标的及其后续走势、指数与一级行业板块表现、市场情绪与宽度，归纳做得好与不好的决策，并对下周给出条件式风险预估。',
       '周末', 190, false, 'global'
  FROM job_prompt prompt
 WHERE prompt.code = 'weekly_trading_review'
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, cron = EXCLUDED.cron, prompt_id = EXCLUDED.prompt_id,
  purpose = EXCLUDED.purpose, phase = EXCLUDED.phase, priority = EXCLUDED.priority,
  trading_day_only = EXCLUDED.trading_day_only, execution_scope = EXCLUDED.execution_scope,
  updated_at = now();

-- 用户明确要求复盘产出后告知：已有显式任务订阅时追加该任务，通道开关与密钥保持原配置。
UPDATE notification_setting
   SET job_codes = array_append(job_codes, 'weekly_trading_review'), updated_at = now()
 WHERE job_codes IS NOT NULL AND cardinality(job_codes) > 0
   AND NOT ('weekly_trading_review' = ANY(job_codes));
