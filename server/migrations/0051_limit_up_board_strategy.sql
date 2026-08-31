-- 0051_limit_up_board_strategy.sql：新增第 9 个策略文档《打板策略》（用户 2026-08-27 授权创建，
-- 内容源自 G2/OW 回测结论，报告见 支撑/tmp/g2_data/ow_report.md）；同步修订每日计划与集合竞价
-- 研判提示词，使池外机会与竞价判断按《打板策略》门禁执行。

-- 1) 新文档 + 首版修订（source='migration'，与 bootstrap 初始文档同机制）
INSERT INTO strategy_document (code, title, role, injection_order)
VALUES ('limit_up_board', '打板策略', 'guidance', 150)
ON CONFLICT (code) DO NOTHING;

WITH doc AS (
  SELECT id FROM strategy_document WHERE code = 'limit_up_board'
), content AS (
  SELECT $strategy$
# 打板策略

> 版本：Daban-v1.0；状态：**前向验证期**（未通过第六节验证标准前，任何任务不得据本策略给出"值得入场"结论，只能"继续观察"）。
> 证据：G2-v1.0 与一字排队专项回测（2025-09~2026-04，120 信号日三段切分，报告与逐笔数据见 `支撑/tmp/g2_data/ow_report.md`）。
> 职责：定义涨停延续/连板方向的池外候选门禁、竞价门禁、排队执行纪律与退出；与其他文档并列，不修改既有短线/波段/长线规则。

## 一、已证伪口径（不得复活）

1. E 日开盘市价追入（普通开盘买入）：三段全负（训练 -0.4%/验证 -1.8%/盲测 -1.6%），调整高度、题材参数均无效。
2. 开盘涨停后开板按涨停价接回：三段全负（-2.6%/-2.9%/-10.4%），开板给出的成交机会本身是出货信号。
3. 无差别一字排队（不筛 S 日形态、不看竞价）：混合期望 -2.07%（20% 成交率），45.2% 的挂单变成开板毒药单。

## 二、标的门禁（S 日收盘判定，逐条硬性，失败即出局）

1. 沪深主板（600/601/603/605/000/001/002/003）、非 ST、非上市新股。
2. S 日收盘涨停且 **S 日为一字板**（当日最低价 = 涨停收盘价）：连续一字惯性是唯一跨段稳定前向先验，次日封死率 74.6%（训练 76.5%/验证 69.2%/盲测 66.7%）。
3. 涨停原因清洗后存在有效题材标签（纯事件驱动涨停出局），且主标签题材当日宽度 ≥3。
4. 系统性恐慌门控未触发（跌停数/炸板率/最高板开盘溢价三项两项规则，沿用每日计划市场结构口径）。

## 三、竞价门禁（E 日 09:25 集合竞价结果公布后判定，任一缺失只能"继续观察"）

1. 竞价涨停：竞价价格触及 E 日涨停价（未顶一字直接放弃，无论高开多少）。
2. 买方未匹配量 > 0（卖方堆积或未匹配为负 = 弱标的，放弃）。
3. 竞价换手率 ≤ 10%（异常放大视为分歧，放弃）。

## 四、执行纪律（排队单专项）

1. 只做涨停价排队单：09:25 竞价结果公布后通过第三节全部门禁才挂单；开盘未一字不挂；一字盘中开板的挂单按涨停价成交（毒药风险由门禁压降，不承诺消除）。
2. 成交率预期保守取 15%~25%（散户队尾），期望评估不得使用高于 35% 的假设。
3. 仓位：单只不超过常规短线单笔额度的 1/3，同日通过门禁候选合计不超过总资金 1/4；未成交资金留现金。

## 五、退出

X1（E 的下一交易日）开盘无条件全出。证据：封死单 +6.84%、开板单 -2.74%，全面优于盘中止损止盈；涨停持仓的隔日溢价在 X1 开盘集中兑现，拖到盘中只会恶化。T+1 下 E 日不可卖出，隔夜跳空风险由第四节仓位上限约束。

## 六、前向验证标准（通过前本策略仅为观察口径）

`auction_opportunity_assessment` 每日按本策略研判，累计 ≥20 个交易日且 ≥30 笔通过竞价门禁的一字委托后评估：1) 门禁内 E 日封死率 ≥70%；2) 开板毒药单占比 ≤30% 且竞价未匹配量/换手对封死与开板有可复现分层；3) 15%~25% 成交率下混合期望 >0 且 20 日滚动中位不为负。三条同时满足才可提案升级为正式模块（仍须真实用户批准）；任一不满足维持"只观察、不入场"。第一节已证伪口径永久不得通过参数微调复活。
$strategy$ AS text
), ins AS (
  INSERT INTO strategy_document_revision (document_id, revision_no, content, sha256, source)
  SELECT doc.id, 1, content.text,
         encode(sha256(convert_to(content.text, 'UTF8')), 'hex'), 'migration'
    FROM doc CROSS JOIN content
   WHERE NOT EXISTS (SELECT 1 FROM strategy_document_revision r WHERE r.document_id = doc.id)
  RETURNING document_id, id
)
UPDATE strategy_document d
   SET current_revision_id = ins.id, updated_at = now()
  FROM ins
 WHERE d.id = ins.document_id AND d.current_revision_id IS NULL;

-- 2) 每日计划提示词：池外机会按《打板策略》门禁评级（幂等：未出现引用时追加修订）
WITH cur AS (
  SELECT p.id AS prompt_id, p.current_revision_id AS base_id, r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id = p.current_revision_id
   WHERE p.code = 'daily_plan_flow' AND p.status = 'active'
     AND r.content NOT LIKE '%《打板策略》%'
), prep AS (
  SELECT prompt_id, base_id,
         replace(content,
           '4. 单独输出“市场结构池外机会”，最多 10 只，优先保留涨停与龙虎榜重合、机构或游资净流入、连板/板块聚集得到多重证据的标的。逐只列出信号来源、市场结构证据、可用行情与指标、符合的策略条件、尚缺条件、失效条件和主要风险；涨停或上榜本身不得等同于买入条件。',
           '4. 单独输出“市场结构池外机会”，最多 10 只，候选筛选与 A/B/C 评级必须按《打板策略》执行：涨停延续/连板类候选先过其第二节标的门禁（主板非 ST 非新、S 日一字、有效题材且宽度≥3、非恐慌日）；S 日一字且题材证据完整的标 A，通过部分门禁或二板以上非一字标 B，单一证据待验证标 C。逐只列出信号来源、市场结构证据、门禁逐条通过情况、可用行情与指标、尚缺条件、失效条件和主要风险；涨停或上榜本身不得等同于买入条件，《打板策略》第一节已证伪口径（开盘追入、开板接回、无差别排队）不得写成建议动作。'
         ) AS content
    FROM cur
), ins AS (
  INSERT INTO job_prompt_revision (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prompt_id,
         (SELECT COALESCE(MAX(x.revision_no), 0) + 1 FROM job_prompt_revision x WHERE x.prompt_id = prep.prompt_id),
         content, encode(sha256(convert_to(content, 'UTF8')), 'hex'), 'user', base_id,
         '池外机会筛选与评级改按《打板策略》门禁执行'
    FROM prep
  RETURNING prompt_id, id
)
UPDATE job_prompt p SET current_revision_id = ins.id, updated_at = now()
  FROM ins WHERE p.id = ins.prompt_id;

-- 3) 集合竞价研判提示词：增加按《打板策略》的一字排队专项判断（幂等同上）
WITH cur AS (
  SELECT p.id AS prompt_id, p.current_revision_id AS base_id, r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id = p.current_revision_id
   WHERE p.code = 'auction_opportunity_assessment' AND p.status = 'active'
     AND r.content NOT LIKE '%《打板策略》%'
), prep AS (
  SELECT prompt_id, base_id,
         replace(content,
           '2. 高开、放量、未匹配量或短线风向标标签都只能作为证据，任何单项都不得等同于买入条件。不得创造当前策略不存在的阈值，不得把 A/B/C 评级或推荐顺序替代完整入场条件。',
           '2. 高开、放量、未匹配量或短线风向标标签都只能作为证据，任何单项都不得等同于买入条件。不得创造当前策略不存在的阈值，不得把 A/B/C 评级或推荐顺序替代完整入场条件。涨停延续/连板类候选必须按《打板策略》整节执行：先核对其第二节标的门禁（S 日一字、主板、题材宽度≥3、非恐慌日），再按第三节竞价门禁逐项核对（竞价涨停、买方未匹配量>0、竞价换手≤10%）；该策略处于前向验证期，即使全部门禁通过，结论也只能是“继续观察（排队专项验证中）”，不得给出“值得入场”；《打板策略》第一节已证伪口径（开盘追入、开板接回、无差别排队）必须在研判中显式排除。'
         ) AS content
    FROM cur
), ins AS (
  INSERT INTO job_prompt_revision (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prompt_id,
         (SELECT COALESCE(MAX(x.revision_no), 0) + 1 FROM job_prompt_revision x WHERE x.prompt_id = prep.prompt_id),
         content, encode(sha256(convert_to(content, 'UTF8')), 'hex'), 'user', base_id,
         '增加按《打板策略》的一字排队专项门禁与验证期约束'
    FROM prep
  RETURNING prompt_id, id
)
UPDATE job_prompt p SET current_revision_id = ins.id, updated_at = now()
  FROM ins WHERE p.id = ins.prompt_id;


-- 4) 新文档加入清单后重算 strategy_state.current_hash（与 repo 清单哈希公式一致）
UPDATE strategy_state
   SET current_hash = sub.h, updated_at = now()
  FROM (
    SELECT encode(sha256(convert_to(string_agg(d.code || ':' || r.sha256, E'\n'
             ORDER BY d.injection_order, d.id), 'UTF8')), 'hex') AS h
      FROM strategy_document d
      JOIN strategy_document_revision r ON r.id = d.current_revision_id
     WHERE d.current_revision_id IS NOT NULL
  ) sub
 WHERE strategy_state.singleton = 1;
