-- 0111_任务特征标注与废弃任务清理.sql：为定时任务补充职责产出特征与重要性排序，并清理已退役任务。
-- 背景：任务清单只靠名称区分，职责笼统、看不出产出形态、时段特征与重要程度。
-- 变更：
--   1) job_definition 新增 purpose（职责与产出）、phase（调度时段特征）、priority（重要性排序权重）；
--   2) 删除已退役任务：每周评分（标的评分机制已退役）、周中检查、全市场左侧结构反转，含其运行与结果；
--   3) 统一重排任务优先级：数据链路先行、收盘与夜间研判次之、盘中复核再次、低频深度研究最后。

-- 1) 新增任务特征列。
ALTER TABLE job_definition ADD COLUMN purpose text;
ALTER TABLE job_definition ADD COLUMN phase text;
ALTER TABLE job_definition ADD COLUMN priority integer;

COMMENT ON COLUMN job_definition.purpose IS '任务职责与产出：说明读取哪些事实、做出什么判断、留下什么结果，供任务页与 Agent 概览使用';
COMMENT ON COLUMN job_definition.phase IS '调度时段特征：盘前/盘中/盘后/夜间/周末；用于任务分组，不参与调度计算';
COMMENT ON COLUMN job_definition.priority IS '重要性排序权重：数值越小越靠前；数据链路先于研判，盘中复核先于低频深度研究';

ALTER TABLE job_definition
  ADD CONSTRAINT job_definition_phase_check
    CHECK (phase IS NULL OR phase IN ('盘前', '盘中', '盘后', '夜间', '周末')),
  ADD CONSTRAINT job_definition_priority_check
    CHECK (priority IS NULL OR priority BETWEEN 1 AND 999);

-- 2) 清理已退役任务。依赖方向：job_run_output/job_run → job_definition → job_prompt → job_prompt_revision，
--    因此按“结果 → 运行 → 定义 → 提示词版本 → 提示词”的顺序删除。
DELETE FROM job_run_output
 WHERE job_id IN (SELECT id FROM job_definition
                   WHERE code IN ('weekly_review', 'midweek_check', 'left_reversal_opportunity_scan'));
DELETE FROM job_run
 WHERE job_id IN (SELECT id FROM job_definition
                   WHERE code IN ('weekly_review', 'midweek_check', 'left_reversal_opportunity_scan'));
DELETE FROM job_definition
 WHERE code IN ('weekly_review', 'midweek_check', 'left_reversal_opportunity_scan');
DELETE FROM job_prompt_revision
 WHERE prompt_id IN (SELECT id FROM job_prompt
                      WHERE code IN ('weekly_review', 'midweek_check', 'left_reversal_opportunity_scan'));
DELETE FROM job_prompt
 WHERE code IN ('weekly_review', 'midweek_check', 'left_reversal_opportunity_scan');

-- 3) 数据链路（1xx）：先补齐输入事实，再谈研判。
UPDATE job_definition SET
  purpose = '同步完整标的、板块目录与交易日历；产出标的主数据、板块目录与交易日历，供后续扫描与入池解析标的身份。',
  phase = '盘前', priority = 101
 WHERE code = 'market_catalog_sync';

UPDATE job_definition SET
  purpose = '每周一同步全部有效板块的当前成分及生效、失效区间；产出可追溯历史变化的成分关系，供行业归属与关注池投影。',
  phase = '周末', priority = 102
 WHERE code = 'board_membership_sync';

UPDATE job_definition SET
  purpose = '每周六盘前批量重算全市场正式日线指标与五维股性画像；产出完整行情指标与股性阶段，补齐工作日增量未覆盖的标的。',
  phase = '周末', priority = 103
 WHERE code = 'weekly_full_market_indicators';

UPDATE job_definition SET
  purpose = '工作日盘后同步持仓、关注池、核心指数与行业板块日线，并补充期货与关键标的 30 分钟线；产出日线行情、均线指标与数据卷快照。',
  phase = '盘后', priority = 110
 WHERE code = 'daily_data_update';

UPDATE job_definition SET
  purpose = '工作日收盘后同步涨停池、跌停池、炸板池、连板天梯与龙虎榜；产出当日市场结构事件，供打板候选与市场情绪判断。',
  phase = '盘后', priority = 111
 WHERE code = 'daily_market_structure';

UPDATE job_definition SET
  purpose = '每周六盘前同步价值候选池所需的财务、估值与分红数据；产出价值排名的点时输入，供月度排名与错杀扫描读取。',
  phase = '周末', priority = 120
 WHERE code = 'value_candidate_sync';

UPDATE job_definition SET
  purpose = '工作日收盘后按固定口径计算全市场质量分与估值分并生成月度排名；产出月度价值 Top 榜与候选等级，供错杀扫描读取。',
  phase = '盘后', priority = 121
 WHERE code = 'value_monthly_rank';

UPDATE job_definition SET
  purpose = '工作日同步上期所铜真实合约日行情、结算持仓与主力连续映射；产出真实合约 K 线、期货专属字段与换月映射。',
  phase = '盘后', priority = 130
 WHERE code = 'commodity_copper_sync';

UPDATE job_definition SET
  purpose = '每周五同步上期所铜总库存周报并保留官方发布时间；产出铜库存点时观测，供铜库存防守评估读取。',
  phase = '盘后', priority = 131
 WHERE code = 'commodity_copper_inventory_sync';

UPDATE job_definition SET
  purpose = '工作日同步广期所碳酸锂仓单总量；产出仓单点时观测，供碳酸锂低暴露评估读取。',
  phase = '盘后', priority = 132
 WHERE code = 'commodity_lithium_warehouse_sync';

-- 4) 收盘与夜间研判（2xx）：生成下一交易日计划与候选。
UPDATE job_definition SET
  purpose = '工作日晚间生成下一交易日计划：读取关注池与持仓，输出唯一的波段开仓信号、右侧与试盘评估、持仓预案和关注池更新。',
  phase = '盘后', priority = 210
 WHERE code = 'daily_plan_flow';

UPDATE job_definition SET
  purpose = '工作日夜间扫描完整 881 一级行业，筛出 1–3 个处于变盘节点或具备可验证机会的板块，并从成分中挑优质标的写入关注池；产出板块机会预案与关注更新。',
  phase = '夜间', priority = 220
 WHERE code = 'nightly_sector_opportunity_scan';

UPDATE job_definition SET
  purpose = '工作日夜间扫描当前月度价值 Top10 中的 A 级错杀标的（高股息、深度回撤、仍具质量资格）；正式候选写入关注池，产出研究级增配建议。',
  phase = '夜间', priority = 221
 WHERE code = 'value_anchor_opportunity_scan';

-- 5) 盘中复核（3xx）：只复核已生成计划，不新造信号。
UPDATE job_definition SET
  purpose = '工作日 09:27 集合竞价结束后复核前一日计划中的打板候选，给出通过或否定的结构化判断并刷新打板机会；产出竞价复核结论。',
  phase = '盘中', priority = 310
 WHERE code = 'auction_opportunity_assessment';

-- 6) 低频深度研究（4xx）：研究与解释固定公式结果，不直接形成交易动作。
UPDATE job_definition SET
  purpose = '每周五收盘后解释服务端固定公式的铜库存防守仓位结果（目标仓位、20 个百分点调仓缓冲、有效公司清单）；产出研究级仓位评估。',
  phase = '盘后', priority = 410
 WHERE code = 'copper_inventory_signal_review';

UPDATE job_definition SET
  purpose = '每周五收盘后解释碳酸锂仓单防守链路（仓单 4 周变化、逆百分位、10 个百分点缓冲、五只固定公司）；产出研究级低暴露评估。',
  phase = '盘后', priority = 411
 WHERE code = 'lithium_warehouse_signal_review';
