-- 0189_板块机会筛选确认度分级.sql
-- 夜间板块机会筛选：优先级从「触发线/形态类别」改为「当日确认度分档」，同步收紧 ST 排除与失效位口径。
-- 口径全文见 specs/板块机会筛选确认度分级/状态.md 与 docs/strategy/板块机会筛选确认度分级口径.md；
-- 三触发线阈值、15 日冷却、20 日观察窗口、分支A/B 资格均不变。

-- 1) 策略正文：新增当日确认度分档、结构位失效位、ST 排除；触发线降为观察准入。
WITH updated AS (
  SELECT id, $doc$# 夜间板块左侧趋势策略

> **职责**：定义夜间板块机会筛选的板块信号、当日确认度分档、观察窗口、板块内补涨候选与关注写入标准。
> **板块口径**：881 一级行业全集等权。板块信号、确认度分档与补涨候选由服务端确定性计算（`sector_trend_structure` 分析），任务只核验、解释与写入，不自行重算或发明排序。
> **证据来源**：`docs/回测结论/` 下夜间板块左侧趋势结构、反弹择时与超额增强、板块内个股选择三份研究结论。

## 一、板块信号（三触发线，只决定是否进入观察）

满足任一触发线即成信号：

1. 中期脱离：60 日收盘 OLS 归一化斜率 ≤ -8% 的背景下，收盘上穿 60 日回归趋势线，且 10 日归一化斜率转正；需近 15 个交易日出现止跌 K 线（阳包阴、双日止跌为一级形态，金针探底为二级），且信号日量比（当日量÷5日均量）< 1.5；
2. 新低回升：近 13 个交易日内触及 60 日最低收盘（×1.001），且当日收盘创近 10 日最高收盘；不附加止跌形态与量比条件（消融证明冗余）；
3. 急跌反转：13 日收盘 OLS 归一化斜率 ≤ -8% 的背景下，收盘上穿 13 日回归趋势线，且 5 日归一化斜率转正；需近 15 个交易日止跌 K 线与量比 < 1.5。

同板块信号 15 个交易日冷却。同日多线同时成立时按 中期脱离 > 新低回升 > 急跌反转 标记来源（`trigger` 标签）。

**触发线不再决定优先级**：它只回答「是否进入观察」。报告中不得再用「一级/二级」指代触发线；急跌反转历史集中度高（前三信号月贡献 102.5%，其余月份合计为负），其集中度警示只作为结论稳健性说明保留。

信号附带增强标签（只影响结论表述，不改变准入）：二次止跌（首次止跌后 5–20 日回踩不破锚定低点×0.97）、上下收敛（20/40 日振幅比 ≤0.85 且高降低抬且收盘>MA10）。

## 二、当日确认度分档（服务端确定性计算，满分 10）

板块优先级只由当日确认度决定。五项分值相加，再由脉冲项扣分：

| 代号 | 指标 | 2 分 | 1 分 | 0 分 |
| --- | --- | --- | --- | --- |
| M1 | 板块内上涨家数占比 | ≥90% | 80%–90% | <80% |
| M2 | 板块当日涨幅 − 上证当日涨幅 | ≥+3.0 个点 | +1.0～+3.0 个点 | <+1.0 个点 |
| M3 | 板块内涨停家数（含 20cm，按涨跌幅限制推断） | ≥5 家 | 1–4 家 | 0 家 |
| M4 | 量比（当日量 ÷ 5 日均量，`volume_ratio_5`） | ≥1.30 | 1.10–1.30 | <1.10 |
| M5 | 日内确认：收盘位置 ≥0.90 且无脉冲 = 2；≥0.90 有脉冲 = 1；<0.90 = 0 | — | — | — |

- 收盘位置 =（收盘 − 最低）÷（最高 − 最低），取板块指数日线。
- 日内单根脉冲：开盘涨幅 ≤ +1.0% 且（收盘涨幅 − 开盘涨幅）≥ 6.0 个点 且 收盘位置 ≥0.95，扣 2 分并标注「次日分歧风险」。
- 涨停家数按涨跌幅限制从日线推断：主板（60/00 开头）≥9.8%，创业板与科创板（300/301/688/689）≥19.8%，北交所（43/83/87/88）≥29.8%；封板事件表只用于补充首板/炸板质量，不用于计数。
- 扩散度与涨停统计排除 ST/退市风险股（其涨跌幅限制为 5%，会污染广度与涨停统计），排除数量写入数据缺口。
- 分档：A 档（≥6 分）进前列，可输出板块内候选；B 档（3–5 分）进次列，可输出候选但结论必须写「需次日确认」；C 档（≤2 分）只记录、排最后，不得输出板块内个股候选、不得写入关注池。
- 同分排序：总分 → 涨停家数 → 量比 → 板块代码升序。熊市只降低结论表述强度，不改变档位。
- 权重与阈值在本轮属于初始值，回测冻结前只按本口径执行，不得在代码或提示词里临场调参。

## 三、观察窗口与失效位

- 观察窗口：信号日起 20 个交易日；到期未延续即退出观察，不自动续期。
- 失效位按结构位制，不使用固定百分比：候选结构位为 MA5、MA10、近 20 个交易日最低价（含信号日），只取低于收盘价的；该结构位距收盘 ≥ 0.5 ×（信号日最高 − 最低）÷ 收盘 才算有效（未被当日振幅吞掉）。
- 失效位 = 收盘下方最近的有效结构位；三道都无效时取近 20 日前低并标注「结构位过近」。报告必须同时给出失效位数值、距收盘百分比和第二道结构位（追踪位）。
- 失效位只用于提前降级，不改变 20 个交易日观察窗口，不改变退出研究结论。

## 四、板块内补涨候选（两个独立分支）

资格：沪深主板（60/00 开头）、信号日前至少 121 根日线且行情新鲜、近 20 日成交量为正、20 日均成交额 ≥2000 万元。

**ST/退市排除**：证券简称含 ST（含 \*ST，不区分大小写）、简称含「退」、`lifecycle_status` 非 `active`、`is_st` 为真，任一命中即出局；以证券简称为主、`is_st` 为辅（库内 `is_st` 存在空值）。排除适用于分支 A、分支 B、板块内个股观察输出与关注池写入。已入池的 ST 票在复核时标记「资格失效，建议移除」，不自动删除，走人工确认。

- 分支A（跌幅补涨）：近 20 日涨跌幅最低 2 只。
- 分支B（止跌修复确认）：20 日收益<0、5 日收益>0、收盘>MA10、对 MA20 乖离≤10%，按 5 日行业残差最高 2 只。

两分支独立保留，不合并不加权，不得引用未验证组合的历史成绩；同代码去重；每板块写入关注池最多 2 只（分支B优先）。

## 五、关注写入与结论

- 只有 A/B 档可输出候选并写入关注池；C 档不输出候选、不写入关注池。
- 个股候选一律“即将符合”：`missing_signals` 必须逐项列出独立证据缺口（公开公告、盈利改善、独立相对强度等）；不得把“跌得多”或“板块在反弹”直接当作“已符合”。
- 已持仓标的不写入自动关注；无候选时以空集合完成对账。
- 市场环境（881 等权牛/熊/震荡）只作结论强度上下文：熊市降低结论强度，不作为信号过滤。
- 只表达“观察机会”“满足条件后关注”或“暂不具备条件”，不给买卖指令、仓位建议或收益承诺。

## 六、已证伪口径（不得复用）

温度粗筛（胜率 55%、期望 +1.3%、组合亏损）、右侧动量并列线（+0.9%/53%）、“必须温和放量”（缩量脱离质量最高）、追强与成交额领先排序（成交额领先增益 -2.25 个百分点）、财务质量硬筛（ROE≥8% 子样本增益 -1.71 个百分点）、W30/W20/W6 斜率窗口（胜率 51–58%，深度过滤失效）、均线位置法（收盘上穿下行 MA13，+2.1%/56.8%，信号过密）、低点抬高结构法（+2.0%/57.4%）。

W13 急跌反转的历史集中度警示：前三信号月贡献 102.5%，其余月份合计为负；生产前瞻验证须单独跟踪三线各自表现。Donchian 新低回升法已于 2026-10-10 接入为第三触发线（纯口径：60 日新低、触及 13 日、破 10 日高，不附加形态与量比；用户确认跳过前瞻验证直接采纳）。

## 七、数据边界

- 板块成分为当前时点回看，存在幸存者偏差；个股 20 日窗口用前复权价近似。
- 涨停家数以日线涨跌幅推断为主口径，封板事件源不完整时以推断为准并标注。
- 缺数显式列缺口，不推断、不补值；候选不足不凑数。$doc$ AS content
    FROM strategy_document WHERE code = 'nightly_sector_strategy'
)
UPDATE strategy_document document
   SET title = '夜间板块左侧趋势策略', content = updated.content,
       sha256 = encode(sha256(convert_to(updated.content, 'UTF8')), 'hex'), updated_at = now()
  FROM updated
 WHERE document.id = updated.id;

-- 2) 任务提示词：按当日确认度分档呈现，缺失分档表/分项/失效位视为不合格。
WITH prompt AS (
  SELECT id AS prompt_id, current_revision_id AS base_revision_id
    FROM job_prompt
   WHERE code = 'nightly_sector_opportunity_scan'
), definition(content) AS (
  VALUES ($prompt$
# 夜间板块机会筛选

目标：以任务目标日为数据截止日，运行完整 881 一级行业左侧趋势结构扫描，按当日确认度分档呈现板块信号，核验板块内补涨候选并把个股观察写入关注池。只形成研究观察与条件预案，不交易、不改持仓、不发出买卖指令；完整结果保存到 `job_run_output`。

## 执行流程

1. 调用 `strategy_document_query` 读取当前最终策略正文中的夜间板块左侧趋势策略与投资总策略，只使用本轮锁定版本。
2. 调用一次 `analysis_run`，请求必须为 `{"requests":[{"analysis_type":"sector_trend_structure","as_of":"目标日"}]}`，不得传 `codes`。核对 881 覆盖、市场状态、信号清单与缺口。
3. 服务端已按冻结口径计算板块信号（三触发线只决定是否进入观察）与当日确认度：`confirmation` 给出 M1–M5 分项、脉冲标记、总分、A/B/C 档位、失效位与第二道结构位。只核验与解释，不得自行重算信号、改动口径、临场调参或发明新的排序。
4. 板块一律按分档 A→B→C 呈现，不按触发线。每个信号板块给出：分档与总分、M1–M5 分项、脉冲标记（有则写「次日分歧风险」）、形态与量能、观察窗口（valid_through）、失效位与距收盘百分比、第二道结构位、增强标签、市场环境对结论强度的影响。不得用「一级/二级」指代触发线；急跌反转只注明历史集中度与结论强度较低。
5. 个股观察只从 catch_up 候选选取：分支B（止跌修复确认）优先、分支A（跌幅补涨）补充，同代码去重，每个板块最多保留 2 只个股。只有 A/B 档可输出候选；C 档不得输出任何板块内个股。逐只说明分支、20 日位置、修复状态、所属板块、风险与失效条件；ST/退市风险已由服务端排除，不得自行放回。
6. 调用 `pool_attention_write` 写入本轮全部个股观察。板块内个股可由服务端自动初始化到关注池，复用已有完整五维画像；不得调用 `pool_onboard` 或 `pool_write` 拼装流程。补涨候选一律 `approaching`，`missing_signals` 必须逐项写明尚缺的独立证据（公告、盈利改善、独立相对强度等）；不得把“跌得多”或“板块在反弹”标为 `qualified`。已持仓标的不写入自动关注。没有候选时也要提交空 items，并按数据覆盖填写 `evaluation_status`。

## 存量关注复核

先调用 `pool_context_query` 取全本策略存量关注，按 `strategy_code=nightly_sector` 过滤 `strategy_attentions`，包含已过期条目，逐项复核，不限于昨天或本轮新入选板块。行情及财务缺口用 `fetch_market_data` 补齐；扶摇扩展研究数据用 `fetch_hithink_data`。旧信号按本策略当前条件评估：观察窗口已过、或板块收盘跌破失效位且未修复的标记失效，其余按最新结构证据更新；没有相关存量时仍正常发现新机会。调用 `pool_attention_write` 时提供目标日 `data_date`，`reviewed_codes` 是实际完成复核的全部代码，包含明确不满足条件的旧标的；`review_gaps` 逐项记录未完成复核的代码与具体缺口。存在缺口或未覆盖条目必须使用 `partial`，不可只因未入选候选清单而删除。缺数据时不更新旧信号有效期；`clear` 只用于明确失效，`mark` 必须有当前数据证据。ST 存量按策略口径标记「资格失效，建议移除」，不自动删除。

## 结论标准

- 分档表必须齐全：每个信号板块给出档位、总分、M1–M5 分项、脉冲标记、失效位与距收盘百分比；缺任一项视为结果不合格。
- 每只个股给出：代码与名称、所属板块、分支、观察理由、尚缺条件、风险与失效条件、数据日期；B 档板块的个股结论必须注明「需次日确认」。
- 有数据缺口时降低结论强度并列明，不得用常识补值；不得把局部样本称为全市场结论。
- 只表达“观察机会”“满足条件后关注”或“暂不具备条件”，不得给直接买卖指令、仓位建议、确定性涨跌判断或收益承诺。

## 输出

正文使用紧凑 Markdown，约 2000 中文字符：先写市场与覆盖摘要，再按 A/B/C 分档列出信号要素与观察个股，最后列数据缺口。末尾单独输出 `## 结论摘要`，用 3–6 条可独立阅读的短句概括分档板块、最多 2 只个股、观察窗口和首要风险；没有机会时直接说明。结论摘要不超过 600 个中文字符，供飞书消息推送。
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
         '板块优先级改为当日确认度分档，触发线降为观察准入并补 ST 与结构位失效位口径'
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

-- 3) 任务目的与策略运行时版本。
UPDATE job_definition
   SET purpose = '工作日夜间对完整 881 一级行业运行左侧趋势结构扫描，按当日确认度分档（上涨广度、相对强度、涨停家数、量比、日内确认与脉冲）排序，核验结构位失效位与板块内补涨候选并写入关注池；产出观察预案与存量复核。',
       updated_at = now()
 WHERE code = 'nightly_sector_opportunity_scan';

UPDATE strategy_definition
   SET runtime_version = runtime_version + 1, updated_at = now()
 WHERE code = 'nightly_sector';

-- 4) 策略清单哈希前滚（排除已归档的铜库存与碳酸锂仓单策略）。
UPDATE strategy_state SET change_seq = change_seq + 1,
  current_hash = encode(sha256(convert_to((SELECT string_agg(code || ':' || sha256, E'\n' ORDER BY injection_order, id)
      FROM strategy_document
      WHERE code NOT IN ('copper_inventory_strategy', 'lithium_warehouse_strategy')), 'UTF8')), 'hex'),
  updated_at = now()
 WHERE singleton = 1;
