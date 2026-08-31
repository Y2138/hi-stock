-- 0052_limit_up_board_v11.sql：《打板策略》v1.1（用户 2026-08-28 授权修订）：
-- 引入形态链分层（一字接力 vs 加速一字）与规模分层（S 日成交额三档），
-- 竞价门禁相对化并新增"盘中冲板观察"处理；同步修订两个任务提示词。
-- 依据：ow_features.csv 形态链/规模切片 + 2026-08-28 实盘案例（金安国纪、深中华A）；
-- 探索性分层，val/test 样本薄，维持 §六"只观察、不入场"冻结。

-- 1) 《打板策略》v1.1
WITH doc AS (SELECT id FROM strategy_document WHERE code = 'limit_up_board'),
content AS (
  SELECT $strategy$
# 打板策略

> 版本：Daban-v1.1；状态：**前向验证期**（未通过第六节验证标准前，任何任务不得据本策略给出"值得入场"结论，只能"继续观察"）。
> 证据：G2-v1.0 与一字排队专项回测（2025-09~2026-04 三段切分）+ 形态链/规模切片（ow_features.csv）+ 2026-08-27/28 前向实测；报告见 `支撑/tmp/g2_data/ow_report.md`。
> 职责：定义涨停延续/连板方向的池外候选门禁、竞价门禁、排队执行纪律与退出；不修改既有短线/波段/长线规则。

## 一、已证伪口径（不得复活）

1. E 日开盘市价追入：三段全负（-0.4%/-1.8%/-1.6%），调整高度、题材参数均无效。
2. 开盘涨停后开板按涨停价接回：三段全负（-2.6%/-2.9%/-10.4%）。
3. 无差别一字排队：混合期望 -2.07%（20% 成交率），45.2% 挂单变开板毒药单。
4. S 日非一字 + 中大成交额的竞价一字开盘：封死率仅 17%~31%（36+12 笔），是毒药单主要来源。

## 二、标的门禁（S 日收盘判定，逐条硬性）

1. 沪深主板（600/601/603/605/000/001/002/003）、非 ST、非上市新股。
2. S 日收盘涨停且 **S 日为一字板**（当日最低价 = 涨停收盘价，盘中开板不算）。
3. 涨停原因清洗后存在有效题材标签（纯事件驱动出局），主标签题材当日宽度 ≥3。
4. 系统性恐慌门控未触发（沿用每日计划市场结构口径）。

### 2.1 形态链与规模分层（v1.1，决定评级与观察强度，不放宽 §二）

| 分层 | 定义 | n | E 日封死率 | 开板伤害 | 评级 |
|---|---|---:|---:|---:|---|
| 接力一字 | S-1 一字 → S 一字 | 40 | 72.5% | -1.01% | **A** |
| 加速一字 | S-1 普通涨停 → S 一字 | 75 | 45.3% | -3.20% | **B** |
| 小盘加固 | S 日成交额 < 1 亿 | 39 | 76.9% | — | 层内升半级 |
| 大盘降权 | S 日成交额 > 4.5 亿 | 38 | 34.2% | — | 层内降半级，最高 B |

接力一字是唯一在 15%~20% 保守成交率下全段期望为正的子集（+0.62%~+1.13%），但验证段仅 7 笔、盲测段 1 笔，**不得据此解冻入场**。

## 三、竞价门禁（E 日 09:25 后判定，任一缺失只能"继续观察"）

1. 竞价涨停：竞价价格触及 E 日涨停价。未顶一字的一律不挂排队单（挂单将按开盘价成交，属第一节已证伪的追入口径）。
2. 买方未匹配量 > 0；**按规模相对化解读**：小盘（<1 亿档）未匹配量绝对值小但比例高即有效，大盘（>4.5 亿档）需显著放量排队；绝对阈值待 ≥20 日前向数据分规模标定。
3. 竞价换手 ≤10%（大盘档可收紧）。
4. **竞价强但未顶一字**（正未匹配 + 高竞价量比 + 题材 A 级）：存在盘中快速回封路径（2026-08-28 金安国纪 +3.83% 竞价后触板、深中华A +7.4% 竞价后封死为实证），但不属于排队执行方式，结论只能是 observe 并在摘要注明"盘中冲板观察"，不得给出入场判断。

## 四、执行纪律（排队单专项，冻结中）

1. 只做涨停价排队单：09:25 竞价结果公布后通过第三节全部门禁才挂单；一字盘中开板的挂单按涨停价成交。
2. 成交率预期保守取 15%~25%，期望评估不得使用高于 35% 的假设。
3. 仓位：单只不超过常规短线单笔额度的 1/3，同日合计不超过总资金 1/4；未成交留现金。

## 五、退出

X1 开盘无条件全出（封死单 +6.84%/开板单 -2.74%，优于一切盘中规则变体）。T+1 下隔夜跳空风险由仓位上限约束。

## 六、前向验证标准（通过前本策略仅为观察口径）

`auction_opportunity_assessment` 每日按本策略研判，累计 ≥20 个交易日且 ≥30 笔通过竞价门禁的一字委托后，**分形态链与规模层**评估：1) A 层（接力一字）封死率 ≥70% 且 B 层显著低于 A 层（分层有效性）；2) 开板毒药单占比 ≤30% 且竞价未匹配量/换手的规模相对口径对封死与开板可分层；3) A 层在 15%~25% 成交率下混合期望 >0 且 20 日滚动中位不为负。三条同时满足才可提案升级（仍须真实用户批准）；任一不满足维持冻结。第一节已证伪口径永久不得通过参数微调复活。
$strategy$ AS text
), ins AS (
  INSERT INTO strategy_document_revision (document_id, revision_no, content, sha256, source)
  SELECT doc.id, (SELECT COALESCE(MAX(r.revision_no),0)+1 FROM strategy_document_revision r WHERE r.document_id = doc.id),
         content.text, encode(sha256(convert_to(content.text,'UTF8')),'hex'), 'migration'
    FROM doc CROSS JOIN content
  RETURNING document_id, id
)
UPDATE strategy_document d SET current_revision_id = ins.id, updated_at = now()
  FROM ins WHERE d.id = ins.document_id;

-- 2) 清单哈希重算
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

-- 3) 集合竞价研判提示词：give_up 语义细分与规模分层
WITH cur AS (
  SELECT p.id AS prompt_id, p.current_revision_id AS base_id, r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id = p.current_revision_id
   WHERE p.code = 'auction_opportunity_assessment' AND p.status = 'active'
     AND r.content NOT LIKE '%盘中冲板观察%'
), prep AS (
  SELECT prompt_id, base_id,
         replace(content,
           '3. 未持仓机会只给出“值得入场”“继续观察”“放弃”之一。',
           '3. 未持仓机会只给出“值得入场”“继续观察”“放弃”之一；“放弃”必须区分两种写法：竞价证据弱（未匹配为负/缩量/竞价量比低）写“竞价转弱放弃”；竞价强但未顶一字（正未匹配+高竞价量比+A 级题材）写“放弃（非排队口径）”，并在 assessment_summary 注明“盘中冲板观察”——该路径不属于排队执行方式，不得给出入场判断。'
         ) AS content
    FROM cur
), ins AS (
  INSERT INTO job_prompt_revision (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prompt_id, (SELECT COALESCE(MAX(x.revision_no),0)+1 FROM job_prompt_revision x WHERE x.prompt_id = prep.prompt_id),
         content, encode(sha256(convert_to(content,'UTF8')),'hex'), 'user', base_id,
         '按打板策略 v1.1 细化放弃语义、盘中冲板观察与规模分层'
    FROM prep
  RETURNING prompt_id, id
)
UPDATE job_prompt p SET current_revision_id = ins.id, updated_at = now()
  FROM ins WHERE p.id = ins.prompt_id;

-- 4) 每日计划提示词：A/B 评级按 v1.1 形态链定义
WITH cur AS (
  SELECT p.id AS prompt_id, p.current_revision_id AS base_id, r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id = p.current_revision_id
   WHERE p.code = 'daily_plan_flow' AND p.status = 'active'
     AND r.content NOT LIKE '%接力一字%'
), prep AS (
  SELECT prompt_id, base_id,
         replace(content,
           'S 日一字且题材证据完整的标 A，通过部分门禁或二板以上非一字标 B，单一证据待验证标 C',
           '评级按《打板策略》v1.1 形态链执行：接力一字（前一日亦一字）且题材证据完整标 A，加速一字（前一日普通涨停）或大盘档（S 日成交额>4.5 亿）标 B，通过部分门禁或二板以上非一字标 C'
         ) AS content
    FROM cur
), ins AS (
  INSERT INTO job_prompt_revision (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prompt_id, (SELECT COALESCE(MAX(x.revision_no),0)+1 FROM job_prompt_revision x WHERE x.prompt_id = prep.prompt_id),
         content, encode(sha256(convert_to(content,'UTF8')),'hex'), 'user', base_id,
         '池外机会 A/B 评级改按打板策略 v1.1 形态链与规模分层'
    FROM prep
  RETURNING prompt_id, id
)
UPDATE job_prompt p SET current_revision_id = ins.id, updated_at = now()
  FROM ins WHERE p.id = ins.prompt_id;
