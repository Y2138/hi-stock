-- 夜间板块机会筛选改为左侧趋势结构信号与板块内补涨候选。
-- 口径冻结自 docs/回测结论/夜间板块左侧趋势结构研究结论.md、夜间板块反弹择时与超额增强验证.md、
-- 夜间板块内个股选择原则与验证.md；温度粗筛与右侧动量线经回测证伪，一并移除。

-- 1) analysis_run 类型约束加入 sector_trend_structure。
ALTER TABLE analysis_run DROP CONSTRAINT analysis_run_analysis_type_check;
ALTER TABLE analysis_run ADD CONSTRAINT analysis_run_analysis_type_check
  CHECK (analysis_type = ANY (ARRAY['sector_temperature'::text, 'key_levels'::text, 'long_valuation'::text,
    'value_monthly_rank'::text, 'sector_trend_structure'::text]));

-- 2) 任务策略文档全文重写：单线左侧趋势 + 补涨候选。
WITH updated AS (
  SELECT id, $doc$# 夜间板块左侧趋势策略

> **职责**：定义夜间板块机会筛选的板块信号、观察窗口、板块内补涨候选与关注写入标准。
> **板块口径**：881 一级行业全集等权。板块信号与补涨候选由服务端确定性计算（`sector_trend_structure` 分析），任务只核验、解释与写入，不自行重算或发明排序。
> **证据来源**：`docs/回测结论/` 下夜间板块左侧趋势结构、反弹择时与超额增强、板块内个股选择三份研究结论。

## 一、板块信号（服务端确定性计算）

同时满足：

1. 中期下降趋势：60 日收盘 OLS 归一化斜率 ≤ -8%；
2. 脱离：收盘上穿 60 日回归趋势线，且 10 日归一化斜率转正；
3. 近 15 个交易日内出现止跌 K 线：阳包阴、双日止跌为一级形态，金针探底为二级（降权，需附加确认）；
4. 信号日量比（当日量÷5日均量）< 1.5：缩量与温和放量均可，明显放量与爆量排除；
5. 同板块信号 15 个交易日冷却。

信号附带增强标签（只影响结论表述，不改变准入）：二次止跌（首次止跌后 5–20 日回踩不破锚定低点×0.97）、上下收敛（20/40 日振幅比 ≤0.85 且高降低抬且收盘>MA10）。

## 二、观察窗口与失效

- 观察窗口：信号日起 20 个交易日；到期未延续即退出观察，不自动续期。
- 结构失效：板块收盘跌破信号前低（近 20 日最低低点）。
- 板块信号条件全部由服务端确定性判定成立，板块观察按“已符合”记录。

## 三、板块内补涨候选（两个独立分支）

资格：沪深主板（60/00 开头）、信号日前至少 121 根日线且行情新鲜、近 20 日成交量为正、20 日均成交额 ≥2000 万元。

- 分支A（跌幅补涨）：近 20 日涨跌幅最低 2 只。
- 分支B（止跌修复确认）：20 日收益<0、5 日收益>0、收盘>MA10、对 MA20 乖离≤10%，按 5 日行业残差最高 2 只。

两分支独立保留，不合并不加权，不得引用未验证组合的历史成绩；同代码去重；每板块写入关注池最多 2 只（分支B优先）。

## 四、关注写入与结论

- 个股候选一律“即将符合”：`missing_signals` 必须逐项列出独立证据缺口（公开公告、盈利改善、独立相对强度等）；不得把“跌得多”或“板块在反弹”直接当作“已符合”。
- 已持仓标的不写入自动关注；无候选时以空集合完成对账。
- 市场环境（881 等权牛/熊/震荡）只作结论强度上下文：熊市降低结论强度，不作为信号过滤。
- 只表达“观察机会”“满足条件后关注”或“暂不具备条件”，不给买卖指令、仓位建议或收益承诺。

## 五、已证伪口径（不得复用）

温度粗筛（胜率 55%、期望 +1.3%、组合亏损）、右侧动量并列线（+0.9%/53%）、“必须温和放量”（缩量脱离质量最高）、追强与成交额领先排序（成交额领先增益 -2.25 个百分点）、财务质量硬筛（ROE≥8% 子样本增益 -1.71 个百分点）。

## 六、数据边界

- 板块成分为当前时点回看，存在幸存者偏差；个股 20 日窗口用前复权价近似。
- 缺数显式列缺口，不推断、不补值；候选不足不凑数。$doc$ AS content
    FROM strategy_document WHERE code = 'nightly_sector_strategy'
)
UPDATE strategy_document document
   SET title = '夜间板块左侧趋势策略', content = updated.content,
       sha256 = encode(sha256(convert_to(updated.content, 'UTF8')), 'hex'), updated_at = now()
  FROM updated
 WHERE document.id = updated.id;

-- 3) 任务提示词全文替换（幂等：同 sha256 不重复插入）。
WITH prompt AS (
  SELECT id AS prompt_id, current_revision_id AS base_revision_id
    FROM job_prompt
   WHERE code = 'nightly_sector_opportunity_scan'
), definition(content) AS (
  VALUES ($prompt$
# 夜间板块左侧趋势观察

目标：以任务目标日为数据截止日，运行完整 881 一级行业左侧趋势结构扫描，核验板块信号与板块内补涨候选，并把个股观察写入关注池。只形成研究观察与条件预案，不交易、不改持仓、不发出买卖指令；完整结果保存到 `job_run_output`。

## 执行流程

1. 调用 `strategy_document_query` 读取当前最终策略正文中的夜间板块左侧趋势策略与投资总策略，只使用本轮锁定版本。
2. 调用一次 `analysis_run`，请求必须为 `{"requests":[{"analysis_type":"sector_trend_structure","as_of":"目标日"}]}`，不得传 `codes`。核对 881 覆盖、市场状态、信号清单与缺口。
3. 服务端已按冻结口径计算板块信号（脱离 60 日中期下降趋势、近 15 日止跌形态、量比<1.5、20 日观察窗与失效位）与补涨候选；只核验与解释，不得自行重算信号、改动口径或发明新的排序。可用 `indicator_query` 抽查候选个股或信号板块结构作增强证据。
4. 对每个信号板块给出：形态与量能、观察窗口（valid_through）、失效位（prior_low）、增强标签（二次止跌/上下收敛）、市场环境对结论强度的影响；熊市环境降低结论强度。
5. 个股观察只从 catch_up 候选选取：分支B（止跌修复确认）优先、分支A（跌幅补涨）补充，同代码去重，每个板块最多保留 2 只个股。逐只说明分支、20 日位置、修复状态、所属板块、风险与失效条件。
6. 调用 `pool_attention_write` 写入本轮全部个股观察。板块内个股可由服务端自动初始化到关注池，复用已有完整五维画像；不得调用 `pool_onboard` 或 `pool_write` 拼装流程。补涨候选一律 `approaching`，`missing_signals` 必须逐项写明尚缺的独立证据（公告、盈利改善、独立相对强度等）；不得把“跌得多”或“板块在反弹”标为 `qualified`。已持仓标的不写入自动关注。没有候选时也要提交空 items，并按数据覆盖填写 `evaluation_status`。

## 存量关注复核

先调用 `pool_context_query` 取全本策略存量关注，按 `strategy_code=nightly_sector` 过滤 `strategy_attentions`，包含已过期条目，逐项复核，不限于昨天或本轮新入选板块。行情及财务缺口用 `fetch_market_data` 补齐；扶摇扩展研究数据用 `fetch_hithink_data`。旧信号按本策略当前条件评估：观察窗口已过、或板块收盘跌破信号前低且未修复的标记失效，其余按最新结构证据更新；没有相关存量时仍正常发现新机会。调用 `pool_attention_write` 时提供目标日 `data_date`，`reviewed_codes` 是实际完成复核的全部代码，包含明确不满足条件的旧标的；`review_gaps` 逐项记录未完成复核的代码与具体缺口。存在缺口或未覆盖条目必须使用 `partial`，不可只因未入选候选清单而删除。缺数据时不更新旧信号有效期；`clear` 只用于明确失效，`mark` 必须有当前数据证据。

## 结论标准

- 每个信号板块给出：状态、支持证据、增强标签、观察窗口与失效位、风险与数据日期。
- 每只个股给出：代码与名称、所属板块、分支、观察理由、尚缺条件、风险与失效条件、数据日期。
- 有数据缺口时降低结论强度并列明，不得用常识补值；不得把局部样本称为全市场结论。
- 只表达“观察机会”“满足条件后关注”或“暂不具备条件”，不得给直接买卖指令、仓位建议、确定性涨跌判断或收益承诺。

## 输出

正文使用紧凑 Markdown，约 2000 中文字符：先写市场与覆盖摘要，再按板块列出信号要素与观察个股，最后列数据缺口。末尾单独输出 `## 结论摘要`，用 3–6 条可独立阅读的短句概括板块信号、最多 2 只个股、观察窗口和首要风险；没有机会时直接说明。结论摘要不超过 600 个中文字符，供飞书消息推送。
$prompt$)
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prompt.prompt_id,
         (SELECT COALESCE(max(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing
           WHERE existing.prompt_id = prompt.prompt_id),
         definition.content,
         encode(sha256(convert_to(definition.content, 'UTF8')), 'hex'),
         'user',
         prompt.base_revision_id,
         '夜间板块改为左侧趋势结构信号与补涨候选，移除温度粗筛与右侧动量线'
    FROM prompt CROSS JOIN definition
   WHERE NOT EXISTS (
     SELECT 1
       FROM job_prompt_revision existing
      WHERE existing.prompt_id = prompt.prompt_id
        AND existing.sha256 = encode(sha256(convert_to(definition.content, 'UTF8')), 'hex')
   )
  RETURNING prompt_id, id
), selected AS (
  SELECT inserted.prompt_id, inserted.id
    FROM inserted
  UNION ALL
  SELECT prompt.prompt_id, revision.id
    FROM prompt
    JOIN definition ON true
    JOIN job_prompt_revision revision
      ON revision.prompt_id = prompt.prompt_id
     AND revision.sha256 = encode(sha256(convert_to(definition.content, 'UTF8')), 'hex')
   WHERE NOT EXISTS (SELECT 1 FROM inserted)
  LIMIT 1
)
UPDATE job_prompt prompt
   SET current_revision_id = selected.id, updated_at = now()
  FROM selected
 WHERE prompt.id = selected.prompt_id;

-- 4) 任务目的与策略运行时版本。
UPDATE job_definition
   SET purpose = '工作日夜间对完整 881 一级行业运行左侧趋势结构扫描（脱离60日下降趋势+止跌形态+量比<1.5），核验信号板块的20日观察窗与板块内补涨候选并写入关注池；产出观察预案与存量复核。',
       updated_at = now()
 WHERE code = 'nightly_sector_opportunity_scan';

UPDATE strategy_definition
   SET runtime_version = runtime_version + 1, updated_at = now()
 WHERE code = 'nightly_sector';

-- 5) 策略清单哈希前滚（排除已归档的铜库存与碳酸锂仓单策略）。
UPDATE strategy_state SET change_seq = change_seq + 1,
  current_hash = encode(sha256(convert_to((SELECT string_agg(code || ':' || sha256, E'\n' ORDER BY injection_order, id)
      FROM strategy_document
      WHERE code NOT IN ('copper_inventory_strategy', 'lithium_warehouse_strategy')), 'UTF8')), 'hex'),
  updated_at = now()
 WHERE singleton = 1;
