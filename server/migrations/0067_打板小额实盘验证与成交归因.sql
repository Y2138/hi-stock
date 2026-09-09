-- 0067_打板小额实盘验证与成交归因.sql：把竞价观察升级为可追踪的小额实盘验证信号。

ALTER TABLE daily_plan_auction_assessment
  ADD COLUMN review_type text;

UPDATE daily_plan_auction_assessment
   SET review_type = CASE
         WHEN conclusion = 'give_up' THEN 'give_up'
         WHEN conclusion = 'unavailable' THEN 'data_insufficient'
         WHEN assessment_summary LIKE '%换手晋级%' THEN 'turnover_advance'
         WHEN assessment_summary LIKE '%分歧%' OR assessment_summary LIKE '%盘中冲板%' THEN 'divergence'
         WHEN assessment_summary LIKE '%一字%' OR assessment_summary LIKE '%排队%' THEN 'one_word_continue'
         ELSE 'legacy_observe'
       END;

ALTER TABLE daily_plan_auction_assessment
  ALTER COLUMN review_type SET NOT NULL,
  ADD CONSTRAINT daily_plan_auction_assessment_review_type_check
    CHECK (review_type IN (
      'one_word_continue','turnover_advance','divergence',
      'give_up','data_insufficient','legacy_observe'
    ));

ALTER TABLE daily_plan_auction_assessment
  DROP CONSTRAINT daily_plan_auction_assessment_conclusion_check,
  ADD CONSTRAINT daily_plan_auction_assessment_conclusion_check
    CHECK (conclusion IN ('worth_entering','signal_passed','observe','give_up','unavailable'));

-- 当前仍展示的已通过结果随新口径进入实盘验证；历史结果保留原语义。
UPDATE daily_plan_auction_assessment
   SET conclusion = 'signal_passed', updated_at = now()
 WHERE status = 'active' AND conclusion = 'observe';

ALTER TABLE portfolio_position_change
  ADD COLUMN entry_auction_assessment_id bigint
    REFERENCES daily_plan_auction_assessment(id) ON DELETE SET NULL;

CREATE INDEX portfolio_position_change_entry_auction_idx
  ON portfolio_position_change (entry_auction_assessment_id)
  WHERE entry_auction_assessment_id IS NOT NULL;

-- 用户批准的 Daban-v1.4：评分保持 v1.3 不变，只修改竞价结论、实盘归因和毕业标准。
WITH current_document AS (
  SELECT document.id AS document_id,
         document.current_revision_id AS base_revision_id
    FROM strategy_document document
   WHERE document.code = 'limit_up_board'
), definition(content) AS (
  VALUES ($strategy$
# 打板策略：Daban-v1.4 抱团接力与题材主升

> **职责**：定义每日涨停池的候选资格、抱团接力与题材主升信号、信号等级、T+1 竞价复核和失效条件。
> **适用范围**：扫描沪深主板当日涨停股，不受现有标的池限制；形成打板验证信号，不自动下单、加入标的池、建立持仓或发布策略。
> **时间口径**：T 日收盘后生成信号，T+1 日 09:25 后复核。T 日评分只能使用 T 日及此前已经落库的数据。

---

## 一、候选资格

T 日收盘后，股票必须同时满足以下条件，才进入评分：

1. 代码以 `600/601/603/605/000/001/002/003` 开头，属于沪深主板 A 股；
2. 非 ST、非未开板新股；
3. T 日收盘涨停；
4. 涨停原因清洗后至少保留一个有效题材标签；
5. T 日涨停事件、连板数、封板时间、封单和成交额等评分所需数据可用；缺少非关键连续变量时按中性分位处理，无法确认候选资格或主标签时直接标为“数据不足”。

T 日是否一字板不是候选硬条件。一字板只影响 T+1 的执行形态，不能排除非一字的主升或换手接力信号。

## 二、题材口径

1. 删除涨停原因中的括号内容，按 `+、/、，、;、|` 等分隔符拆分；
2. 删除“概念”字样、少于 2 字的标签，以及业绩、回购、中标、重组等纯公司事件标签；
3. 氢能、绿电、液冷、光模块、机器人、国企改革等同义表达按固定词表合并；
4. 一只股票有 N 个有效标签时，对每个标签贡献 `1/N` 的题材宽度；
5. 股票的主标签依次按 T 日题材宽度、截至 T 日近 5 个交易日进入每日宽度前三的次数、标签名称确定。每只股票只使用主标签计算两类分数。

## 三、固定分位口径

`R↑(x)` 表示 x 在固定研究基准分布中的经验中位秩，越大越接近 1；`R↓(x)=1-R↑(x)`。并列值取左右秩中点，缺失连续变量取 0.5，比例变量截断到 `[0,1]`。

固定研究基准更新前，所有交易日继续使用同一分布和固定分数线。`Q95`、`Q70` 是策略版本名称中的研究分层标签，不是每天重新选取最高 5% 或 30%；实际信号以第四、第五章的固定分数线判断。

## 四、抱团接力信号

### 4.1 评分

```text
抱团分 = 100 × [
  18% × R↑(题材占比)
  + 18% × R↑(题材最高连板)
  + 12% × R↑(题材梯队数)
  + 10% × R↑(市场题材集中度)
  + 10% × R↓(市场涨停数)
  + 8% × R↓(题材成交额)
  + 12% × 核心地位
  + 8% × R↑(封单金额/成交额)
  + 4% × R↓(封板分钟)
]
```

| 分项 | 实际定义 |
|---|---|
| 题材占比 | 主标签分摊宽度 / T 日全部有效标签分摊宽度之和 |
| 题材最高连板 | 主标签 T 日成员的最高连板数 |
| 题材梯队数 | 首板、二板、三板及以上三个层级中实际出现的层级数，范围 0 至 3 |
| 市场题材集中度 | T 日所有题材占比的平方和 |
| 市场涨停数 | T 日完整涨停池股票数 |
| 题材成交额 | 主标签成员 T 日成交额中位数的 `log(1+x)`，只作为小盘代理 |
| 核心地位 | 候选连板数 / 主标签最高连板数，截断到 `[0,1]` |
| 封单金额/成交额 | 候选 T 日封单金额 / T 日成交额 |
| 封板分钟 | T 日封板时间换算为当天分钟数；无效时间按 15:00 |

### 4.2 信号成立

同时满足以下条件，记为“抱团接力信号”：

1. 已通过第一章全部候选资格；
2. 抱团分不低于 `69.35`；
3. 按抱团分降序、股票代码升序排序后，位于 T 日前 2 名。

该信号寻找的是涨停家数相对收敛、题材集中、连板高度和梯队突出、候选接近题材最高板，同时封单相对充足且封板较早的核心股。

### 4.3 风险标记

出现以下任一情况时，信号仍按量化条件记录，但必须附加风险标记，不得主观改写分数：

- 市场涨停家数明显扩张，存量抱团可能被新方向分流；
- 新题材形成更高的涨停宽度或连板高度；
- 候选虽处于题材高位，但封单弱、反复开板或题材梯队断层；
- 同题材主要由少数一字板构成，可成交性弱。

## 五、题材主升信号

### 5.1 评分

```text
主升分 = 100 × [
  18% × 近5日持续性
  + 20% × R↑(题材涨停前5日收益)
  + 16% × 成员站上MA20判断
  + 14% × R↑(T日题材宽度)
  + 10% × 晋级率
  + 10% × (1-负反馈)
  + 6% × 首板占比
  + 6% × R↑(个股涨停前5日收益)
]
```

| 分项 | 实际定义 |
|---|---|
| 近 5 日持续性 | T 日前 5 个交易日中主标签宽度大于 0 的天数 / 5 |
| 题材涨停前 5 日收益 | 主标签 T 日成员逐只计算 `T-1 收盘 / T-6 收盘 - 1`，取成员中位数 |
| 成员站上 MA20 判断 | 逐只判断 T-1 收盘是否高于截至 T-1 的 MA20，再对 0/1 结果取中位数；过半为 1、恰好一半为 0.5、未过半为 0 |
| T 日题材宽度 | 主标签 T 日的分摊宽度 |
| 晋级率 | 前一交易日首板晋级二板及以上、二板晋级三板及以上的比例；两项都有时等权平均 |
| 负反馈 | 前一交易日非新成员在 T 日低开、收盘跌停、触板未封三项的标签分摊比例均值 |
| 首板占比 | 主标签首板成员分摊宽度 / 主标签总宽度 |
| 个股涨停前 5 日收益 | 候选自身 `T-1 收盘 / T-6 收盘 - 1` |

单个成员至少有 15 个有效收盘价才参与 MA20 判断。

### 5.2 信号成立

同时满足以下条件，记为“题材主升信号”：

1. 已通过第一章全部候选资格；
2. 主升分不低于 `70.03`；
3. 按主升分降序、股票代码升序排序后，位于 T 日前 2 名。

该信号寻找的是题材已经连续活跃，成员在涨停前具备趋势基础，T 日涨停宽度和晋级表现较好、前排负反馈较低，同时仍有首板补充的标的。

### 5.3 风险标记

出现以下任一情况时，必须附加风险标记：

- 题材宽度主要由首日脉冲贡献，近 5 日持续性不足；
- 多数成员未站上 MA20，个股强而题材弱；
- 前排低开、跌停或触板未封比例上升；
- 题材有宽度但晋级率低，内部缺少持续领涨核心。

## 六、信号等级与排序

每只候选按两条路线独立计算，不把两类分数相加，也不直接比较抱团分与主升分的高低。

| 等级 | 判断 | 含义 |
|---|---|---|
| A：双路线共振 | 同时满足抱团接力信号和题材主升信号 | 兼具资金集中、连板核心与题材趋势，列为当日第一优先级 |
| B-抱团 | 只满足抱团接力信号 | 存量资金核心，重点防范市场回暖或新主线分流 |
| B-主升 | 只满足题材主升信号 | 题材趋势候选，允许非一字和换手晋级 |
| 无有效信号 | 两条路线均未达到分数线或未进入各自前 2 名 | 不进入 T+1 打板观察名单 |
| 数据不足 | 无法确认候选资格、主标签或关键评分字段 | 不猜测、不补零、不进入排序 |

同等级排序规则：A 级先按两条路线各自名次之和升序，再按两条路线超过分数线的幅度之和降序；B 级按对应路线分数降序。最终名单每日最多 4 只，双路线共振只计 1 只。

## 七、T+1 竞价复核

T 日信号只说明股票值得进入次日打板验证，不等于可直接成交。T+1 日 09:25 后必须按实际竞价结果形成以下结论之一。

### 7.1 一字延续确认

同时满足：

1. 竞价价格达到 T+1 涨停价；
2. 买方未匹配量大于 0；
3. 竞价换手率不高于 10%；
4. 非停牌且竞价数据完整。

满足时标记“信号通过·一字延续”。一字排队存在成交率低和开板后被动成交风险，不得把信号强度等同于实际可得收益。

### 7.2 非一字换手晋级确认

同时满足：

1. 竞价价格未达到涨停价；
2. 相对 T 日收盘的竞价涨幅处于 `0% 至 5%`；
3. 买方未匹配量大于 0；
4. 竞价换手率不高于 10%；
5. T 日信号等级为 A 或 B-主升。

满足时标记“信号通过·换手晋级”。该分支用于保留题材主升中非一字但承接正常的候选，不允许因未顶一字直接淘汰。

### 7.3 分歧验证

出现以下情况之一，标记“信号通过·分歧验证”：

- 竞价低于 T 日收盘，但买方未匹配量仍大于 0；
- T 日为 B-抱团且 T+1 未顶一字，但竞价没有明显卖方堆积；
- 竞价方向与题材、连板或市场结构证据不一致。

### 7.4 放弃与数据不足

以下任一情况直接标记“放弃”：

- 竞价涨幅超过 5%，不追高；
- 买方未匹配量小于等于 0；
- 竞价换手率超过 10%；
- 跌停开盘、停牌或出现无法执行的异常状态。

竞价价格、未匹配量或换手率缺失时标记“数据不足”，不得改用盘中涨幅补造竞价结论。

当前 T+1 竞价分支处于小额实盘验证期。“信号通过”表示标的完成 T 日评分和 T+1 竞价复核，可以纳入实盘验证样本，但不是自动买入指令。是否成交及数量由用户自主决定；系统不自动下单、不推荐仓位，用户报告持仓变化后按实际成交记录。

## 八、每日输出

每日计划和竞价研判必须逐只输出：

1. 股票代码、名称、主标签和信号等级；
2. 抱团分、主升分、各自是否达到分数线及当日路线名次；
3. 两条路线的关键得分项和风险标记；
4. T+1 竞价复核结果：一字延续、换手晋级、分歧验证、放弃或数据不足；
5. 数据实际日期、缺口和失效原因；
6. 当前验证结论：信号通过、放弃或数据不足。

没有股票形成有效信号时，明确输出“当日无有效打板信号”，不得用接近分数线、单一涨停或主观故事替代量化条件。

## 九、小额实盘验证与毕业标准

1. 每一条“信号通过”均保留为候选全集；用户没有实际成交的信号也不得删除，避免只统计主观挑选后的样本。
2. 用户报告买入时，成交事件必须关联同代码、同成交日的 T+1 竞价复核及其 T 日计划；后续卖出继承该入场信号。无法建立精确关联的成交不计入打板策略实盘样本。
3. 实盘验证只使用用户报告的真实成交价格和数量。系统不维护总资金或可用资金，不自动计算或建议“小额度”；实际金额由用户自主控制。未提供费用时，收益必须标注为“不含费用”。
4. 累计至少 `20` 个交易日且至少 `30` 笔已完整买卖闭环、归因明确的实盘样本后，才进入毕业评审。拟毕业的一字延续、换手晋级或分歧验证分支各自至少需要 `10` 笔闭环样本；样本不足的分支继续保留验证状态。
5. 毕业分支必须同时满足：实际成交收益均值大于 `0`、中位数大于 `0`、最近 `20` 笔滚动收益中位数不为负；一字延续分支的开板毒药单占比不超过 `30%`。统计必须同时披露信号通过数、实际执行数、完整闭环数、未执行数、费用口径和最大单笔亏损。
6. 达到数量不等于自动毕业。Agent 只能基于关联持仓事件形成策略评估和修订提案；指标全部满足且不存在未解决的数据或归因缺口后，仍须真实用户批准新策略版本。任一条件不满足时维持小额实盘验证或淘汰对应分支。

## 十、研究证据与边界

三年研究中，抱团 Q95 的固定分数线为 69.35，独立盲测为 129 个信号、83 个交易日，T 日收盘至 T+1 日收盘平均收益 4.98%，相对当日全部合格涨停候选的平均超额为 3.45%。

主升 Q70 的固定分数线为 70.03，独立盲测为 351 个信号、184 个交易日，T 日收盘至 T+1 日收盘平均收益 2.83%，相对当日全部合格涨停候选的平均超额为 1.28%。

上述结果验证的是 T 日筛选质量，不包含真实竞价、排队成交、仓位、止损或退出。训练期数据覆盖不足，且理想化持有结果的不确定区间贴近 0，因此：

- 禁止把 Q95 理解为 95% 胜率，把 Q70 理解为 70% 胜率；
- 禁止把信号等级直接解释为收益承诺；
- 禁止因回测结果调整 T+1 真实竞价数据；
- 禁止把一字板重新设为所有候选的统一硬门禁；
- 禁止把两条路线分数相加后创造新的综合分数线；
- 固定分布、权重或分数线的调整必须另行验证并由真实用户批准。
$strategy$)
), inserted_revision AS (
  INSERT INTO strategy_document_revision
    (document_id, revision_no, content, sha256, source)
  SELECT current_document.document_id,
         (SELECT COALESCE(max(existing.revision_no), 0) + 1
            FROM strategy_document_revision existing
           WHERE existing.document_id = current_document.document_id),
         definition.content,
         encode(sha256(convert_to(definition.content, 'UTF8')), 'hex'),
         'migration'
    FROM current_document CROSS JOIN definition
  RETURNING document_id, id
), updated_document AS (
  UPDATE strategy_document document
     SET current_revision_id = inserted_revision.id, updated_at = now()
    FROM inserted_revision
   WHERE document.id = inserted_revision.document_id
  RETURNING document.id
)
INSERT INTO strategy_score_benchmark
  (document_revision_id, benchmark_code, training_start, training_end, methodology,
   distributions, sample_counts, source_summary, sha256)
SELECT inserted_revision.id,
       'daban_v1_4_fixed_20250901_20260122',
       benchmark.training_start,
       benchmark.training_end,
       benchmark.methodology,
       benchmark.distributions,
       benchmark.sample_counts,
       benchmark.source_summary,
       'b3a53d2308bf56e977fd5a89c7f2305b32db352ac760521e9988bfc2a34de3f1'
  FROM inserted_revision
  JOIN current_document ON current_document.document_id = inserted_revision.document_id
  JOIN strategy_score_benchmark benchmark
    ON benchmark.document_revision_id = current_document.base_revision_id;

UPDATE strategy_state
   SET change_seq = change_seq + 1,
       current_hash = manifest.hash,
       updated_at = now()
  FROM (
    SELECT encode(sha256(convert_to(string_agg(document.code || ':' || revision.sha256, E'\n'
             ORDER BY document.injection_order, document.id), 'UTF8')), 'hex') AS hash
      FROM strategy_document document
      JOIN strategy_document_revision revision ON revision.id = document.current_revision_id
     WHERE document.current_revision_id IS NOT NULL
  ) manifest
 WHERE strategy_state.singleton = 1;

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'auction_opportunity_assessment'
     AND prompt.status = 'active'
     AND revision.content NOT LIKE '%## 小额实盘验证最终口径%'
), prepared AS (
  SELECT prompt_id,
         base_revision_id,
         content || $auction$

## 小额实盘验证最终口径

1. 本节替代前文所有“前向验证期只能继续观察”的旧口径。当前《打板策略》处于小额实盘验证期；一字延续、换手晋级和分歧验证的结构化 `conclusion` 统一使用 `signal_passed`，页面展示“信号通过”，不得再提交 `observe`。
2. 每项必须同时提交结构化 `review_type`：一字延续=`one_word_continue`、换手晋级=`turnover_advance`、分歧验证=`divergence`、放弃=`give_up`、数据不足=`data_insufficient`。分类不得只写在摘要文本中。
3. “信号通过”只表示完成 T 日评分与 T+1 竞价复核并进入实盘验证候选，不是自动买入指令。任务不得自动下单、确定数量、建立持仓、加入标的池或修改近期关注；是否成交及小额数量由用户自主决定。
4. `assessment_summary` 保留主标签、精确信号等级、两类分数和名次、复核分类、风险及失效条件。放弃继续使用 `give_up`，关键数据缺失继续使用 `unavailable`。
$auction$ AS content
    FROM current_prompt
), inserted_prompt AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prepared.prompt_id,
         (SELECT COALESCE(max(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = prepared.prompt_id),
         prepared.content,
         encode(sha256(convert_to(prepared.content, 'UTF8')), 'hex'),
         'user',
         prepared.base_revision_id,
         '竞价通过信号进入小额实盘验证并结构化复核分类'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted_prompt.id, updated_at = now()
  FROM inserted_prompt
 WHERE prompt.id = inserted_prompt.prompt_id;
