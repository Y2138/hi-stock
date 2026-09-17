-- 独立两年结构反转：旧纯指标左侧反转仍退役；新信号只供人工决策。
INSERT INTO job_prompt (code,name,status)
VALUES ('two_year_reversal_scan','两年结构反转新开仓信号扫描','active');

WITH prompt AS (SELECT id FROM job_prompt WHERE code='two_year_reversal_scan'),
     definition AS (SELECT $prompt$
# 两年结构反转新开仓信号扫描

1. 用 `tool_catalog` 加载 `strategy_document_query`、`two_year_reversal_signal_query`；读取当前最终策略中的《投资总策略》和《两年结构反转策略》。
2. 只调用一次 `two_year_reversal_signal_query(date=目标日)`。服务端固定口径是唯一量化依据，禁止用其他行情、网页或数据库工具重算、补数或放宽阈值。
3. 工具返回 `unavailable` 时明确报告数据门禁失败，不输出正式信号；`data_date` 早于目标日时只报告滞后观察，不得冒充目标日新开仓信号。0 个正式信号是有效结论。
4. 正式信号来自 `qualified`，接近候选来自 `near`；已经持仓的标的不重复列为新开仓。参考仓位分档不是资金指令；组合持仓、暴露、单日上限与回撤暂停条件尚未验证时，标注“需人工复核”，不得宣称可立即建仓。
5. 生成紧凑 Markdown：数据日、覆盖与缺口、合格行业、正式信号（代码、行业、两年结构、行业回撤、个股跌幅、相对跌幅、排名、参考分档、事件最低价（原始价））、接近候选和人工复核项。最后必须有 `## 结论摘要`，明确正式信号数及主要风险。

本任务将结论保存为 `job_run_output`，不修改旧左侧持仓、不写入每日计划、不生成成交记录。
$prompt$::text AS content),
inserted AS (
 INSERT INTO job_prompt_revision (prompt_id,revision_no,content,sha256,source,change_summary)
 SELECT prompt.id,1,definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),'user','建立独立两年结构反转新开仓信号任务'
 FROM prompt CROSS JOIN definition RETURNING id,prompt_id
)
UPDATE job_prompt prompt SET current_revision_id=inserted.id,updated_at=now()
FROM inserted WHERE prompt.id=inserted.prompt_id;

INSERT INTO job_definition (code,name,cron,job_type,config,prompt_id,enabled,purpose,phase,priority)
SELECT 'two_year_reversal_scan','两年结构反转新开仓信号扫描','0 19 * * 1-5','agent_flow','{}'::jsonb,
       id,true,'工作日盘后扫描两年上升结构行业中的相对超跌股票，产出供人工决策的独立新开仓信号与证据。','夜间',222
FROM job_prompt WHERE code='two_year_reversal_scan';

WITH definition(content) AS (VALUES ($doc$# 两年结构反转策略

> 职责：独立于已退役的纯指标左侧反转；扫描产出供人工决策的新开仓信号，不复用旧持仓退出口径。证据等级为研究采纳，不把历史收益当成生产收益。

## 入场与排序

全市场活跃非ST沪深A股，按当前有效881一级行业归属。实时行业长期结构取数据库官方881一级行业日线；回测长期结构使用固定样本当前成员等权合成近似，不能把回测收益直接归因于实时信号。所属行业指数收盘不低于MA500、500日收益正、相对20日高点回撤10%～30%；个股5日收益≤-8%，相对所属行业当前成员5日平均收益额外落后至少5个百分点。量比只参与排序，不作为硬门槛。按相对超跌、20日回撤和60日量比综合排序。只有当目标日行情、行业和股票覆盖门禁完整时才形成当日信号；滞后数据仅供观察。

接近候选的个股5日收益≤-5%，相对行业落后至少3个百分点；不得冒充正式开仓信号。已持仓标的不得重复产生新开仓信号。

## 人工决策约束

最多持仓5只、单日最多新增3只、总暴露≤85%、整手100股；20日组合高点回撤超过5%时暂停新开仓，恢复后解除。没有完整账户事实时任务只能输出候选和参考分档，不得宣称这些约束已经满足。个股20日回撤20%～30%参考25%，15%～20%参考20%，其他合格信号参考12%；按排序与组合限额人工复核。

## 新策略持仓退出（A方案）

建仓后以信号日未复权最低价为初始风险线，收盘跌破退出；首次回到MA20减半，剩余风险线抬至成本附近；5日相对行业收益修复至-1%以内仅抬高风险线，不机械清仓；峰值盈利≥10%后启用 `峰值价格 - max(峰值价格×8%，3×ATR14)`，风险线只上移。不使用固定持有期限。旧纯指标左侧持仓继续按原退出规则，不套用本方案。
$doc$::text))
INSERT INTO strategy_document (code,title,role,injection_order,job_code,content,sha256)
SELECT 'two_year_reversal_strategy','两年结构反转策略','task',45,'two_year_reversal_scan',content,
       encode(sha256(convert_to(content,'UTF8')),'hex') FROM definition;

-- 现有“唯一开仓信号”限定于每日计划；旧左侧仍不产生新开仓，新策略另有独立任务。
UPDATE strategy_document SET
 content=replace(content,
  '系统的唯一量化开仓信号是波段信号（见《每日计划策略》）；打板机会仅作观察，不自动开仓；右侧主升、试盘启动与左侧反转不再产生新开仓，对应存量持仓按各自退出口径管理至清零，不得因清零目标放宽任何退出条件。',
  '每日计划的量化开仓信号是波段信号；独立《两年结构反转策略》任务可产出供人工决策的新开仓信号。打板机会仅作观察；旧纯指标左侧反转、右侧主升与试盘启动不再产生新开仓，对应存量持仓按原退出口径管理至清零。新两年结构反转持仓按该任务策略的A方案管理。'),
 sha256=encode(sha256(convert_to(replace(content,
  '系统的唯一量化开仓信号是波段信号（见《每日计划策略》）；打板机会仅作观察，不自动开仓；右侧主升、试盘启动与左侧反转不再产生新开仓，对应存量持仓按各自退出口径管理至清零，不得因清零目标放宽任何退出条件。',
  '每日计划的量化开仓信号是波段信号；独立《两年结构反转策略》任务可产出供人工决策的新开仓信号。打板机会仅作观察；旧纯指标左侧反转、右侧主升与试盘启动不再产生新开仓，对应存量持仓按原退出口径管理至清零。新两年结构反转持仓按该任务策略的A方案管理。'),'UTF8')),'hex')
WHERE role='portfolio' AND content LIKE '%系统的唯一量化开仓信号是波段信号%';

UPDATE strategy_document SET
 content=replace(content,
  '右侧、试盘与左侧反转不再产生新开仓。','右侧、试盘与旧纯指标左侧反转不再产生新开仓；独立两年结构反转任务不属于每日计划的波段信号。'),
 sha256=encode(sha256(convert_to(replace(content,
  '右侧、试盘与左侧反转不再产生新开仓。','右侧、试盘与旧纯指标左侧反转不再产生新开仓；独立两年结构反转任务不属于每日计划的波段信号。'),'UTF8')),'hex')
WHERE code='daily_plan_strategy' AND content LIKE '%右侧、试盘与左侧反转不再产生新开仓。%';

UPDATE strategy_state SET change_seq=change_seq+1,
 current_hash=encode(sha256(convert_to((SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id) FROM strategy_document),'UTF8')),'hex'),
 updated_at=now() WHERE singleton=1;

-- 人工记录新策略入场时保留独立归因；每日计划不得套用旧左侧或短线退出规则。
ALTER TABLE portfolio_position_change DROP CONSTRAINT portfolio_position_change_entry_signal_type_check;
ALTER TABLE portfolio_position_change ADD CONSTRAINT portfolio_position_change_entry_signal_type_check
 CHECK (entry_signal_type IS NULL OR entry_signal_type IN
 ('right_side','left_reversal','two_year_reversal','trial_start','swing','limit_up','discretionary'));
ALTER TABLE portfolio_position DROP CONSTRAINT portfolio_position_entry_signal_type_check;
ALTER TABLE portfolio_position ADD CONSTRAINT portfolio_position_entry_signal_type_check
 CHECK (entry_signal_type IS NULL OR entry_signal_type IN
 ('right_side','left_reversal','two_year_reversal','trial_start','swing','limit_up','discretionary'));

-- 每日计划保留波段开仓口径；对新策略的已登记持仓只按A方案提示人工复核，不得误用旧左侧触发位。
WITH current_prompt AS (
 SELECT prompt.id AS prompt_id,prompt.current_revision_id AS base_id,revision.content
 FROM job_prompt prompt JOIN job_prompt_revision revision ON revision.id=prompt.current_revision_id
 WHERE prompt.code='daily_plan_flow'
), inserted AS (
 INSERT INTO job_prompt_revision (prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
 SELECT prompt_id,(SELECT max(revision_no)+1 FROM job_prompt_revision WHERE prompt_id=current_prompt.prompt_id),
        content || E'\n\n两年结构反转（two_year_reversal）为独立任务的新开仓信号，不参与本任务波段信号归并。若持仓 entry_signal_type=two_year_reversal，读取《两年结构反转策略》，只按A方案人工复核信号日最低价、MA20首次修复减半、剩余仓位成本保护与盈利ATR移动止损；缺少分批执行事实或可信指标时明确列缺口，不得套用旧 left_reversal_triggers 或 short_term_triggers。',
        encode(sha256(convert_to(content || E'\n\n两年结构反转（two_year_reversal）为独立任务的新开仓信号，不参与本任务波段信号归并。若持仓 entry_signal_type=two_year_reversal，读取《两年结构反转策略》，只按A方案人工复核信号日最低价、MA20首次修复减半、剩余仓位成本保护与盈利ATR移动止损；缺少分批执行事实或可信指标时明确列缺口，不得套用旧 left_reversal_triggers 或 short_term_triggers。','UTF8')),'hex'),
        'user',base_id,'新两年结构反转持仓与旧左侧退出隔离'
 FROM current_prompt RETURNING id,prompt_id
)
UPDATE job_prompt prompt SET current_revision_id=inserted.id,updated_at=now()
FROM inserted WHERE prompt.id=inserted.prompt_id;
