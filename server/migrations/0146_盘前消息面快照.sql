-- 0146_盘前消息面快照.sql：盘前消息结构化快照与关注池单标的关联。
CREATE TABLE market_news_snapshot (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_date date NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'success' CHECK (status IN ('success','partial','failed')),
  market_bias text NOT NULL DEFAULT 'unknown' CHECK (market_bias IN ('positive','neutral','negative','mixed','unknown')),
  summary text NOT NULL DEFAULT '',
  checked_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
  run_id bigint REFERENCES job_run(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX market_news_snapshot_date_idx ON market_news_snapshot (target_date DESC, captured_at DESC, id DESC);
CREATE UNIQUE INDEX market_news_snapshot_run_idx ON market_news_snapshot (run_id);

CREATE TABLE market_news_item (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id bigint NOT NULL REFERENCES market_news_snapshot(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 2000),
  category text NOT NULL CHECK (category IN ('macro','policy','regulation','industry','company','overseas','risk','other')),
  scope text NOT NULL CHECK (scope IN ('market','sector','instrument')),
  direction text NOT NULL CHECK (direction IN ('positive','neutral','negative','mixed','unknown')),
  impact_level text NOT NULL CHECK (impact_level IN ('high','medium','low')),
  relation_type text NOT NULL DEFAULT 'market' CHECK (relation_type IN ('market','direct','supply_chain','sector','anomaly')),
  source_level text NOT NULL CHECK (source_level IN ('primary','professional','media','unverified')),
  source_name text NOT NULL CHECK (length(btrim(source_name)) BETWEEN 1 AND 120),
  source_url text NOT NULL CHECK (source_url ~ '^https?://'),
  published_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  facts text NOT NULL CHECK (length(btrim(facts)) BETWEEN 1 AND 3000),
  impact_note text NOT NULL CHECK (length(btrim(impact_note)) BETWEEN 1 AND 1200),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX market_news_item_snapshot_idx ON market_news_item (snapshot_id, impact_level, id);

CREATE TABLE market_news_item_instrument (
  item_id bigint NOT NULL REFERENCES market_news_item(id) ON DELETE CASCADE,
  instrument_id bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, instrument_id)
);

CREATE INDEX market_news_item_instrument_idx ON market_news_item_instrument (instrument_id, item_id);

COMMENT ON TABLE market_news_snapshot IS '盘前消息面结构化快照；只作为研究上下文，不覆盖策略正文或数据库行情事实。';
COMMENT ON TABLE market_news_item IS '盘前消息卡片；保留来源、发布时间、抓取时间和对市场/标的的有限解释。';
COMMENT ON TABLE market_news_item_instrument IS '消息卡片与关注池标的的关联。';

INSERT INTO job_prompt (code, name, status)
VALUES ('pre_market_news_scan', '盘前消息面探查', 'active')
ON CONFLICT (code) DO NOTHING;

WITH prompt AS (
  SELECT id AS prompt_id, current_revision_id AS base_revision_id FROM job_prompt WHERE code = 'pre_market_news_scan'
), definition(content) AS (VALUES ($prompt$
# 盘前消息面探查

目标：在盘前生成最新、可追溯的市场消息快照，并为当前关注池中的单个标的建立消息关联。只做事实核验和研究提示，不修改策略正文、策略评分、关注池成员或交易计划。

1. 先调用 `pool_context_query` 读取当前关注池标的、代码、名称和所属板块；再分三层检索：市场底盘（宏观、货币、监管、交易所、海外和关键商品）、策略关联（关注池标的及其板块）、异常扩展（最近盘前出现可靠来源反复报道且尚未在关注池中的新主题）。
2. 所有搜索优先使用 `web_search`，`recency_days` 设为 2；对重要结果使用 `web_fetch` 核验正文。金十数据通过 `domains:["jin10.com"]` 或其官网结果检索，不使用专用 MCP。必须保留发布时间；缺少发布时间且无法由正文确认的结果降为待核验，不得标记为高影响。
3. 一级来源包括政府、监管、交易所和上市公司正式披露；专业财经网站只支持“该平台在该时点报道”。社交媒体、匿名爆料和无法追溯转载不得写入消息卡片。
4. 只写入最近 48 小时内仍有效的消息。每条消息明确分类、影响范围、方向、影响力、来源等级、事实摘要和对关联标的的影响说明。事实与推断分开；同一事件的转载只保留一个主要来源和必要的原始来源。
5. 调用一次 `pool_news_write` 写入完整结果：market_bias、summary、items 和每条 item 的 codes。没有有效消息时提交空 items，并明确市场底盘为 unknown/neutral；任务不因没有消息失败。消息写入完成后输出 Markdown 简报，开头包含完成标记 `> AI 生成任务结果，已关联本次任务保存；不代表策略发布或交易执行。`，结尾增加 `## 结论摘要`。

实时性硬约束：以实际抓取时间为准；结果不得声称秒级实时。若搜索结果明显滞后、发布时间缺失或当前检索时间距最新来源超过 48 小时，必须在数据缺口中说明。
$prompt$::text)), inserted AS (
  INSERT INTO job_prompt_revision (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prompt.prompt_id, 1, definition.content, encode(sha256(convert_to(definition.content, 'UTF8')), 'hex'), 'user', prompt.base_revision_id, '新增盘前消息面结构化探查任务'
    FROM prompt CROSS JOIN definition
   WHERE NOT EXISTS (SELECT 1 FROM job_prompt_revision r WHERE r.prompt_id = prompt.prompt_id AND r.sha256 = encode(sha256(convert_to(definition.content, 'UTF8')), 'hex'))
  RETURNING prompt_id, id
), selected AS (
  SELECT prompt_id, id FROM inserted
  UNION ALL
  SELECT prompt.prompt_id, r.id FROM prompt CROSS JOIN definition JOIN job_prompt_revision r ON r.prompt_id = prompt.prompt_id AND r.sha256 = encode(sha256(convert_to(definition.content, 'UTF8')), 'hex')
  WHERE NOT EXISTS (SELECT 1 FROM inserted) LIMIT 1
)
UPDATE job_prompt p SET current_revision_id = selected.id, updated_at = now() FROM selected WHERE p.id = selected.prompt_id;

INSERT INTO job_definition (code, name, cron, job_type, config, prompt_id, enabled, purpose, phase, priority)
SELECT 'pre_market_news_scan', '盘前消息面探查', '20 7 * * 1-5', 'agent_flow', '{}'::jsonb, p.id, false,
       '盘前扫描市场底盘、关注池关联消息和异常扩展，写入结构化消息卡片供关注池和市场消息页面查看。', '盘前', 160
  FROM job_prompt p WHERE p.code = 'pre_market_news_scan'
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, cron = EXCLUDED.cron, prompt_id = EXCLUDED.prompt_id,
  purpose = EXCLUDED.purpose, phase = EXCLUDED.phase, priority = EXCLUDED.priority, updated_at = now();
