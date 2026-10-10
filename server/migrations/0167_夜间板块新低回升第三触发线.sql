-- 夜间板块左侧趋势增加第三触发线：Donchian 新低回升（纯口径，用户确认直接采纳）。
-- 三线优先级：中期脱离 > 新低回升 > 急跌反转；急跌反转结论强度略低（历史集中度高）。
-- 口径冻结自 docs/回测结论/夜间板块Donchian新低回升研究结论.md。

-- 1) 任务策略文档：信号章节三线化并写明优先级。
WITH current_doc AS (
  SELECT id, content FROM strategy_document WHERE code = 'nightly_sector_strategy'
), updated AS (
  SELECT id,
    replace(replace(content,
      '## 一、板块信号（服务端确定性计算，双触发线）

满足主线或补充线之一，且共用第 3–5 条：

1. 主线（中期脱离）：60 日收盘 OLS 归一化斜率 ≤ -8% 的背景下，收盘上穿 60 日回归趋势线，且 10 日归一化斜率转正；
2. 补充线（急跌反转）：13 日收盘 OLS 归一化斜率 ≤ -8% 的背景下，收盘上穿 13 日回归趋势线，且 5 日归一化斜率转正；
3. 近 15 个交易日内出现止跌 K 线：阳包阴、双日止跌为一级形态，金针探底为二级（降权，需附加确认）；
4. 信号日量比（当日量÷5日均量）< 1.5：缩量与温和放量均可，明显放量与爆量排除；
5. 同板块信号 15 个交易日冷却。

两线同日同时成立时标记为主线（中期脱离）。补充线主要捕捉熊市急跌后的 V 反转窗口，与主线的震荡市优势互补；信号附带 `trigger` 标签区分来源。',
      '## 一、板块信号（服务端确定性计算，三触发线，优先级 中期脱离 > 新低回升 > 急跌反转）

满足任一触发线即成信号：

1. 中期脱离（一级）：60 日收盘 OLS 归一化斜率 ≤ -8% 的背景下，收盘上穿 60 日回归趋势线，且 10 日归一化斜率转正；需近 15 个交易日出现止跌 K 线（阳包阴、双日止跌为一级形态，金针探底为二级），且信号日量比（当日量÷5日均量）< 1.5；
2. 新低回升（一级）：近 13 个交易日内触及 60 日最低收盘（×1.001），且当日收盘创近 10 日最高收盘；不附加止跌形态与量比条件（消融证明冗余）；
3. 急跌反转（二级）：13 日收盘 OLS 归一化斜率 ≤ -8% 的背景下，收盘上穿 13 日回归趋势线，且 5 日归一化斜率转正；需近 15 个交易日止跌 K 线与量比 < 1.5。

同板块信号 15 个交易日冷却。同日多线同时成立时按优先级标记来源（`trigger` 标签）。急跌反转历史集中度高（前三信号月贡献 102.5%，其余月份合计为负），结论强度低于前两级；报告与关注理由中置于其后并注明稳健性限制。'),
      'Donchian 新低回升法（近 13 日触及 60 日收盘新低且收盘创近 10 日新高，+4.5%/70.2%、全年份为正）为已验证的研究候选，未纳入生产；采纳前须按冻结规则前瞻验证。',
      'W13 急跌反转的历史集中度警示：前三信号月贡献 102.5%，其余月份合计为负；生产前瞻验证须单独跟踪三线各自表现。Donchian 新低回升法已于 2026-10-10 接入为第三触发线（纯口径：60 日新低、触及 13 日、破 10 日高，不附加形态与量比；用户确认跳过前瞻验证直接采纳）。')
    AS content
  FROM current_doc
)
UPDATE strategy_document document
   SET content = updated.content,
       sha256 = encode(sha256(convert_to(updated.content, 'UTF8')), 'hex'), updated_at = now()
  FROM updated
 WHERE document.id = updated.id;

-- 2) 任务提示词：三触发线与优先级排序。
WITH current_prompt AS (
  SELECT p.id AS prompt_id, p.current_revision_id AS base_revision_id, r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id = p.current_revision_id
   WHERE p.code = 'nightly_sector_opportunity_scan'
), revised AS (
  SELECT prompt_id, base_revision_id,
    replace(replace(replace(replace(content,
      '核验板块信号（主线=60日中期脱离，补充线=13日急跌反跳，以 trigger 标签区分）与板块内补涨候选',
      '核验板块信号（三触发线：中期脱离、新低回升、急跌反转，以 trigger 标签区分，前两级优先于急跌反转）与板块内补涨候选'),
      '服务端已按冻结口径计算板块信号（主线：脱离 60 日中期下降趋势；补充线：13 日斜率 ≤-8% 急跌后的反跳；两线均要求近 15 日止跌形态与量比<1.5，附 20 日观察窗与失效位）与补涨候选',
      '服务端已按冻结口径计算板块信号（中期脱离：60 日斜率 ≤-8% 背景下上穿趋势线；新低回升：近 13 日触及 60 日最低收盘且收盘创近 10 日新高；急跌反转：13 日斜率 ≤-8% 急跌后的反跳；前两线为一级、急跌反转为二级，附 20 日观察窗与失效位）与补涨候选'),
      '4. 对每个信号板块给出：触发线（trigger：中期脱离/急跌反转）、形态与量能、观察窗口（valid_through）、失效位（prior_low）、增强标签（二次止跌/上下收敛）、市场环境对结论强度的影响；熊市环境降低结论强度。',
      '4. 信号板块按触发线优先级排序呈现：中期脱离、新低回升在前，急跌反转在后并注明结论强度较低（历史集中度高）。每个信号板块给出：触发线、形态与量能、观察窗口（valid_through）、失效位（prior_low）、增强标签（二次止跌/上下收敛）、市场环境对结论强度的影响；熊市环境降低结论强度。'),
      '- 每个信号板块给出：触发线、状态、支持证据、增强标签、观察窗口与失效位、风险与数据日期。',
      '- 每个信号板块按优先级排序给出：触发线、状态、支持证据、增强标签、观察窗口与失效位、风险与数据日期；急跌反转信号注明结论强度较低。')
      AS revised_content
  FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prompt_id,
         (SELECT max(existing.revision_no) + 1 FROM job_prompt_revision existing WHERE existing.prompt_id = revised.prompt_id),
         revised_content,
         encode(sha256(convert_to(revised_content, 'UTF8')), 'hex'),
         'user',
         base_revision_id,
         '夜间板块信号增加 Donchian 新低回升第三触发线，三线按 中期脱离 > 新低回升 > 急跌反转 排序'
    FROM revised
   WHERE revised_content <> (SELECT content FROM current_prompt)
  RETURNING id, prompt_id
)
UPDATE job_prompt p
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE p.id = inserted.prompt_id;

-- 3) 任务目的与运行时版本。
UPDATE job_definition
   SET purpose = '工作日夜间对完整 881 一级行业运行左侧趋势结构扫描（三触发线：60日中期脱离、Donchian新低回升、13日急跌反跳，前两级优先），核验信号板块的20日观察窗与板块内补涨候选并写入关注池；产出观察预案与存量复核。',
       updated_at = now()
 WHERE code = 'nightly_sector_opportunity_scan';

UPDATE strategy_definition
   SET runtime_version = runtime_version + 1, updated_at = now()
 WHERE code = 'nightly_sector';

-- 4) 策略清单哈希前滚。
UPDATE strategy_state SET change_seq = change_seq + 1,
  current_hash = encode(sha256(convert_to((SELECT string_agg(code || ':' || sha256, E'\n' ORDER BY injection_order, id)
      FROM strategy_document
      WHERE code NOT IN ('copper_inventory_strategy', 'lithium_warehouse_strategy')), 'UTF8')), 'hex'),
  updated_at = now()
 WHERE singleton = 1;
