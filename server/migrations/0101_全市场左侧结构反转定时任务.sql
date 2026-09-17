-- 0101_全市场左侧结构反转定时任务.sql：用全市场动态两年结构池替代仅扫描短线池的左侧机会研究。

INSERT INTO job_prompt (code, name, status)
VALUES ('left_reversal_opportunity_scan', '全市场左侧结构反转机会筛选', 'active')
ON CONFLICT (code) DO NOTHING;

WITH prompt AS (
  SELECT id AS prompt_id, current_revision_id AS base_revision_id
    FROM job_prompt
   WHERE code = 'left_reversal_opportunity_scan'
), definition(content) AS (
  VALUES ($prompt$
# 全市场左侧结构反转机会筛选

目标：以任务目标日为截止日，用服务端固定口径扫描全市场动态左侧候选池；本任务不依赖短线池或长线池，找出行业长期上升结构仍成立、行业经历显著回撤、个股相对行业进一步超跌的研究候选。任务只形成研究观察，不交易、不自动入池、不写近期关注、不修改策略。

## 执行流程

1. 只调用一次 `left_reversal_opportunity_query(date=目标日)`，不得使用数据库工具、通用行情工具或网页资料重新手算信号。
2. 以工具返回的共同数据日、覆盖计数、合格行业、正式候选、接近候选和缺口为唯一量化事实。完整扫描后0个正式候选是有效结论，不得降低阈值凑数。
3. 动态池固定为：活跃非ST沪深A股；所属881一级行业收盘不低于MA500、500日收益为正、相对20日高点回撤10%～30%。正式个股候选固定要求5日跌幅不高于-8%，并相对行业当前成员5日收益均值额外落后至少5个百分点。
4. 成交量只参与候选排序，不设置1.5倍或2倍硬门槛。仓位分档只作为研究参考：个股20日回撤20%～30%对应25%，15%～20%对应20%，其余合格候选对应12%；不得输出直接仓位指令。
5. 已持仓、已在短线池或长线池、池外标的分别标注；不得因不在现有池中删除池外候选。数据缺口、当前行业归属回看近似和非历史点时边界必须保留。

## 输出

正文使用紧凑Markdown，控制在约1800中文字符内：

- 数据日与覆盖：完整行业数、合格行业数、股票宇宙、完成数、正式候选数、接近候选数；
- 正式候选：最多20只，列代码、名称、行业、行业500日结构与20日回撤、个股5日跌幅、相对行业跌幅、个股20日回撤、量比、综合分、参考分档、持仓/池状态；
- 接近候选：最多10只，只列尚缺条件；
- 数据缺口与边界；
- 末尾必须单独输出 `## 结论摘要`，用3～6条短句概括候选数量、排名靠前标的、触发条件和主要风险；没有正式候选时直接说明。
$prompt$)
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prompt.prompt_id,
         (SELECT COALESCE(max(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id=prompt.prompt_id),
         definition.content,
         encode(sha256(convert_to(definition.content, 'UTF8')), 'hex'),
         'user',
         prompt.base_revision_id,
         '新增全市场动态两年结构左侧机会筛选任务'
    FROM prompt CROSS JOIN definition
   WHERE NOT EXISTS (
     SELECT 1 FROM job_prompt_revision existing
      WHERE existing.prompt_id=prompt.prompt_id AND existing.content=definition.content
   )
  RETURNING prompt_id,id
)
UPDATE job_prompt prompt
   SET current_revision_id=inserted.id, updated_at=now()
  FROM inserted
 WHERE prompt.id=inserted.prompt_id;

INSERT INTO job_definition (code, name, cron, job_type, config, prompt_id, model_id, enabled)
SELECT 'left_reversal_opportunity_scan',
       '全市场左侧结构反转机会筛选',
       '0 19 * * 1-5',
       'agent_flow',
       '{}'::jsonb,
       prompt.id,
       NULL,
       true
  FROM job_prompt prompt
 WHERE prompt.code='left_reversal_opportunity_scan'
ON CONFLICT (code) DO UPDATE
  SET name=EXCLUDED.name,
      cron=EXCLUDED.cron,
      job_type=EXCLUDED.job_type,
      config=EXCLUDED.config,
      prompt_id=EXCLUDED.prompt_id,
      model_id=EXCLUDED.model_id,
      enabled=EXCLUDED.enabled,
      updated_at=now();
