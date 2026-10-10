-- 夜间板块左侧趋势增加 W13 急跌反跳补充触发线（口径冻结自窗口与短期趋势定义研究，
-- docs/回测结论/夜间板块左侧趋势结构研究结论.md 窗口矩阵章节）。
-- 主线（60日中期脱离）不变；W30/W20/W6 窗口、均线位置法、低点抬高结构法经回测证伪，写入已证伪清单。

-- 1) 任务策略文档：信号章节改为双触发线，证伪清单扩充。
WITH current_doc AS (
  SELECT id, content FROM strategy_document WHERE code = 'nightly_sector_strategy'
), updated AS (
  SELECT id,
    replace(replace(content,
      '## 一、板块信号（服务端确定性计算）

同时满足：

1. 中期下降趋势：60 日收盘 OLS 归一化斜率 ≤ -8%；
2. 脱离：收盘上穿 60 日回归趋势线，且 10 日归一化斜率转正；
3. 近 15 个交易日内出现止跌 K 线：阳包阴、双日止跌为一级形态，金针探底为二级（降权，需附加确认）；
4. 信号日量比（当日量÷5日均量）< 1.5：缩量与温和放量均可，明显放量与爆量排除；
5. 同板块信号 15 个交易日冷却。',
      '## 一、板块信号（服务端确定性计算，双触发线）

满足主线或补充线之一，且共用第 3–5 条：

1. 主线（中期脱离）：60 日收盘 OLS 归一化斜率 ≤ -8% 的背景下，收盘上穿 60 日回归趋势线，且 10 日归一化斜率转正；
2. 补充线（急跌反转）：13 日收盘 OLS 归一化斜率 ≤ -8% 的背景下，收盘上穿 13 日回归趋势线，且 5 日归一化斜率转正；
3. 近 15 个交易日内出现止跌 K 线：阳包阴、双日止跌为一级形态，金针探底为二级（降权，需附加确认）；
4. 信号日量比（当日量÷5日均量）< 1.5：缩量与温和放量均可，明显放量与爆量排除；
5. 同板块信号 15 个交易日冷却。

两线同日同时成立时标记为主线（中期脱离）。补充线主要捕捉熊市急跌后的 V 反转窗口，与主线的震荡市优势互补；信号附带 `trigger` 标签区分来源。'),
      '## 五、已证伪口径（不得复用）

温度粗筛（胜率 55%、期望 +1.3%、组合亏损）、右侧动量并列线（+0.9%/53%）、“必须温和放量”（缩量脱离质量最高）、追强与成交额领先排序（成交额领先增益 -2.25 个百分点）、财务质量硬筛（ROE≥8% 子样本增益 -1.71 个百分点）。',
      '## 五、已证伪口径（不得复用）

温度粗筛（胜率 55%、期望 +1.3%、组合亏损）、右侧动量并列线（+0.9%/53%）、“必须温和放量”（缩量脱离质量最高）、追强与成交额领先排序（成交额领先增益 -2.25 个百分点）、财务质量硬筛（ROE≥8% 子样本增益 -1.71 个百分点）、W30/W20/W6 斜率窗口（胜率 51–58%，深度过滤失效）、均线位置法（收盘上穿下行 MA13，+2.1%/56.8%，信号过密）、低点抬高结构法（+2.0%/57.4%）。

Donchian 新低回升法（近 13 日触及 60 日收盘新低且收盘创近 10 日新高，+4.5%/70.2%、全年份为正）为已验证的研究候选，未纳入生产；采纳前须按冻结规则前瞻验证。')
    AS content
  FROM current_doc
)
UPDATE strategy_document document
   SET content = updated.content,
       sha256 = encode(sha256(convert_to(updated.content, 'UTF8')), 'hex'), updated_at = now()
  FROM updated
 WHERE document.id = updated.id;

-- 2) 任务提示词：执行流程与结论标准体现双触发线。
WITH current_prompt AS (
  SELECT p.id AS prompt_id, p.current_revision_id AS base_revision_id, r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id = p.current_revision_id
   WHERE p.code = 'nightly_sector_opportunity_scan'
), revised AS (
  SELECT prompt_id, base_revision_id,
    replace(replace(replace(replace(content,
      '目标：以任务目标日为数据截止日，运行完整 881 一级行业左侧趋势结构扫描，核验板块信号与板块内补涨候选，并把个股观察写入关注池。',
      '目标：以任务目标日为数据截止日，运行完整 881 一级行业左侧趋势结构扫描，核验板块信号（主线=60日中期脱离，补充线=13日急跌反跳，以 trigger 标签区分）与板块内补涨候选，并把个股观察写入关注池。'),
      '3. 服务端已按冻结口径计算板块信号（脱离 60 日中期下降趋势、近 15 日止跌形态、量比<1.5、20 日观察窗与失效位）与补涨候选；只核验与解释，不得自行重算信号、改动口径或发明新的排序。可用 `indicator_query` 抽查候选个股或信号板块结构作增强证据。',
      '3. 服务端已按冻结口径计算板块信号（主线：脱离 60 日中期下降趋势；补充线：13 日斜率 ≤-8% 急跌后的反跳；两线均要求近 15 日止跌形态与量比<1.5，附 20 日观察窗与失效位）与补涨候选；只核验与解释，不得自行重算信号、改动口径或发明新的排序。可用 `indicator_query` 抽查候选个股或信号板块结构作增强证据。'),
      '4. 对每个信号板块给出：形态与量能、观察窗口（valid_through）、失效位（prior_low）、增强标签（二次止跌/上下收敛）、市场环境对结论强度的影响；熊市环境降低结论强度。',
      '4. 对每个信号板块给出：触发线（trigger：中期脱离/急跌反转）、形态与量能、观察窗口（valid_through）、失效位（prior_low）、增强标签（二次止跌/上下收敛）、市场环境对结论强度的影响；熊市环境降低结论强度。'),
      '- 每个信号板块给出：状态、支持证据、增强标签、观察窗口与失效位、风险与数据日期。',
      '- 每个信号板块给出：触发线、状态、支持证据、增强标签、观察窗口与失效位、风险与数据日期。')
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
         '夜间板块信号增加 13 日急跌反跳补充触发线，trigger 标签区分来源'
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
   SET purpose = '工作日夜间对完整 881 一级行业运行左侧趋势结构扫描（主线=脱离60日下降趋势，补充线=13日急跌反跳，均要求止跌形态与量比<1.5），核验信号板块的20日观察窗与板块内补涨候选并写入关注池；产出观察预案与存量复核。',
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
