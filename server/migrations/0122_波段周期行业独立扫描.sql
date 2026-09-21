-- 波段入场从每日计划拆为独立任务；扫描范围改为固定周期行业，不再依赖关注池反向提供候选。

INSERT INTO job_prompt (code,name,status)
VALUES ('swing_signal_scan','周期行业波段信号扫描','active');

WITH prompt AS (
  SELECT id AS prompt_id,current_revision_id AS base_revision_id FROM job_prompt WHERE code='swing_signal_scan'
), definition(content) AS (VALUES ($prompt$
# 周期行业波段信号扫描

目标：以目标日收盘后的确定性数据和当前最终策略扫描《波段策略》规定的周期行业股票，维护波段策略自己的关注来源并生成入场报告。不交易、不修改持仓、不改写策略；结果由系统保存到 `job_run_output`。

1. 调用 `strategy_document_query`，读取《投资总策略》和《波段策略》；不得用历史任务、关注池成员或网页替代当前策略。
2. 只调用一次 `strategy_evaluation_query(date=目标日, phase="entry")`。任务已绑定 `swing`，服务端负责扩展行业覆盖且固定总量的代表标的扫描、评估运行复用、正式/接近信号持久化和本策略关注来源对账。
3. 只解释工具返回的 `result`、`run` 和 `attention_changes`。不得用数据库、行情或其他工具重算四条件，不得把关注池当成扫描范围，也不得把普通筛除项写入关注。
4. `run.status=partial` 时列明覆盖缺口；完整扫描后 0 个正式信号是有效结论。已有持仓和超过确认价格上限的匹配项只列为抑制项，不得重复写成新开仓信号。
5. 输出紧凑 Markdown：数据日、16 个一级行业及细分代表范围、成员数/扩展标的数/完成数/缺口数、正式信号、接近候选、已有持仓或价格上限抑制、关注变更。正式和接近候选逐只列四条件、确认价、价格上限、初始止损及盈亏比。
6. 最后必须有 `## 结论摘要`，明确正式信号数、接近候选数、关注变更和首要风险。
$prompt$::text)), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt.prompt_id,
         (SELECT COALESCE(max(revision_no),0)+1 FROM job_prompt_revision WHERE prompt_id=prompt.prompt_id),
         definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),'user',
         prompt.base_revision_id,'波段入场拆为周期行业独立扫描任务'
    FROM prompt CROSS JOIN definition RETURNING id,prompt_id
)
UPDATE job_prompt SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE job_prompt.id=inserted.prompt_id;

WITH definition(content) AS (VALUES ($strategy$
# 波段策略

> 职责：独立扫描周期行业并产生波段正式信号、接近候选与后续持仓退出依据。关注池只保存扫描结果，不参与定义扫描范围。

## 一、扫描范围

只扫描当前有效同花顺行业关系中的活跃非 ST 沪深主板股票，并遵守《投资总策略》的交易权限。一级行业覆盖扩大到 16 个，但扫描总量固定不超过 388 只。全部行业使用同一辨识度口径：每个 884 细分先保留近 60 个交易日成交额中位数排名前 10 的代表标的，再由其余标的按全域成交额排序补满总量。没有 884 细分关系时以一级行业自身作为细分组。“辨识度”仅表示稳定、可复算的市场活跃度代理，不等于公司质量或买入建议。

一级行业：

- 881105.TI 煤炭开采加工
- 881107.TI 油气开采及服务
- 881108.TI 化学原料
- 881112.TI 钢铁
- 881115.TI 建筑材料
- 881137.TI 造纸
- 881148.TI 港口航运
- 881168.TI 工业金属
- 881169.TI 贵金属
- 881170.TI 小金属
- 881180.TI 石油加工贸易
- 881264.TI 化学纤维
- 881267.TI 能源金属

- 881266.TI 橡胶制品
- 881279.TI 光伏设备
- 881280.TI 风电设备

全部 16 个行业均先按 884 细分选代表，再用全域高活跃标的补满至 388 只；不存在“原行业全量、新行业精选”的双重口径。行业成分、细分归属和成交额均按目标日点时读取；关注池、已有持仓和人工自选都不得扩大或缩小扫描范围。已有持仓仍参与信号评估，但命中后只记为抑制，不重复形成新开仓信号。

## 二、入场信号

T 日收盘必须同时满足：

1. 成交量 < 5 日均量 × 0.85；
2. 阳线，或下影线 > 收盘价 0.5%；
3. RSI14 < 40；
4. 以近 40 日箱顶 × 0.95 为目标、以初始弹性止损为风险，预期盈亏比 ≥ 1.8。

二次探底、MACD、MA20/MA60 位置和板块温度都不是波段硬条件。恰有一个条件未通过且仍具备确认窗口的标的是接近候选，其他标的只计入筛除汇总。

T+1 必须突破 T 日最高价，确认成交价不得高于 T 日收盘价 5%；未突破或确认价过高均放弃。一次建仓，不自动补仓。

## 三、初始止损与观察期

```text
护盘收回率≥50%：买入价×0.90
护盘收回率<50%：买入价×0.93
箱体边界：近20日最低价×0.97
初始止损：min(买入价×0.99, max(股性止损, 箱体边界))
```

买入后前 10 个交易日为观察期，实际止损暂设为买入价×0.75；第 11 个交易日起恢复初始止损。该位置仅为灾难保护，不得描述成常规止损。

## 四、持仓退出

- 价格达到原箱顶×0.95时卖出剩余仓位的一半，按100股取整；
- 未形成有效突破时，持有满60个交易日后下一交易日开盘退出；
- 箱顶减仓后，收盘浮盈≥8%把保护位提高到买入价，≥15%提高到买入价+5%；浮盈>5%时同时参考MA20×0.98；
- 收盘高于原箱顶且成交量>20日均量×1.2后认定突破，缓冲3个交易日；之后护盘收回率≥50%取“最高收盘-2.8×ATR14”和“MA10×0.98”的较高者，其余取“最高收盘-3.5×ATR14”和“MA20×0.97”的较高者；
- 突破后的剩余仓位取消60日到期，移动保护只能上移；日内同时触及止损和目标时按先止损处理。

## 五、关注维护

未持仓的正式信号写为“已符合”，接近候选写为“即将符合”并保存唯一缺失条件；每轮成功扫描按 `swing` 策略来源完整对账。无信号时清除已失效的波段策略关注，不影响其他策略来源。
$strategy$::text))
INSERT INTO strategy_document (code,title,role,injection_order,job_code,content,sha256)
SELECT 'swing_strategy','波段策略','task',42,'swing_signal_scan',content,
       encode(sha256(convert_to(content,'UTF8')),'hex') FROM definition;

UPDATE strategy_definition
   SET strategy_document_code='swing_strategy',
       daily_plan_scope=ARRAY['exit']::text[],
       runtime_version=runtime_version+1,
       updated_at=now()
 WHERE code='swing';

INSERT INTO job_definition
  (code,name,cron,job_type,config,prompt_id,enabled,purpose,phase,priority,strategy_code,agent_role)
SELECT 'swing_signal_scan','周期行业波段信号扫描','45 17 * * 1-5','agent_flow','{}'::jsonb,
       prompt.id,true,'工作日盘后覆盖16个周期及新能源设备行业，从全部行业细分筛选高辨识度代表标的并把总扫描量固定在388只以内，生成波段正式/接近信号并维护关注来源。','盘后',209,'swing','strategy_entry_report'
  FROM job_prompt prompt WHERE prompt.code='swing_signal_scan';

WITH definition(content) AS (VALUES ($daily$
# 每日计划策略：持仓统筹与观察

> 职责：每日计划聚合独立入场任务已经维护的关注结果，评估全部真实持仓并生成下一交易日预案；不再承担波段或其他策略的入场扫描。

## 一、独立入场任务边界

波段、两年结构反转、价值错杀和夜间板块等入场/关注策略由各自任务扫描并维护各自关注来源。每日计划不得以关注池为候选范围重跑入场条件，也不得把关注状态改写成已成交或买入指令。

## 二、右侧与试盘评估

右侧主升六条件为 DIF>0、MA20上行、MACD柱为正且增量/收盘价>0.001、收盘价>MA5>MA10、收盘相对开盘涨幅≥1%、成交量>5日均量×1.2。它只用于已有持仓与关注标的的结构存活解释，不产生新开仓。

试盘“试盘日→缩量回调→放量突破”只用于关注标的上涨概率评估，不构成开仓信号，也不单独写入关注。

## 三、存量右侧与试盘持仓退出

- 冷却期：快拉型2个交易日，其他3个交易日；期内只使用买入价×0.88止损；
- 冷却期后技术止损 = min(max(标的止损线, 买入价×0.88), 买入价×0.95)；
- MACD柱由正转负且收盘跌破MA10：次日开盘全退；
- 分批止盈：快拉+8%、其他+12%卖出首档，+28%卖出第二档；
- 移动保护按浮盈阶梯和MA5×0.99取高，只能上移；
- 未触发首档止盈且右侧条件存活不超过2项，或买入后第5个交易日仍未触发首档止盈，提示下一交易日开盘退出。

## 四、存量旧左侧反转持仓退出

初始止损取“买入价-信号日ATR14”和“买入价×0.93”的较高者；浮盈6%减半并把保护位提高至买入价+2%与MA5×0.98的较高者；浮盈16%再减约25%；持有满10个交易日仍有剩余时下一交易日开盘退出。

## 五、打板观察

打板路线按《打板策略》产生观察机会，是否成交由用户决定。每日计划只保存服务端合并后的结构化持仓动作和观察项，不修改独立任务的关注来源。
$daily$::text))
UPDATE strategy_document document
   SET title='每日计划策略',content=definition.content,
       sha256=encode(sha256(convert_to(definition.content,'UTF8')),'hex'),updated_at=now()
  FROM definition WHERE document.code='daily_plan_strategy';

UPDATE strategy_document
   SET content=replace(content,
     '每日计划的量化开仓信号是波段信号；独立《两年结构反转策略》任务可产出供人工决策的新开仓信号。',
     '独立《波段策略》任务产出波段量化开仓信号；独立《两年结构反转策略》任务可产出供人工决策的新开仓信号。'),
       sha256=encode(sha256(convert_to(replace(content,
     '每日计划的量化开仓信号是波段信号；独立《两年结构反转策略》任务可产出供人工决策的新开仓信号。',
     '独立《波段策略》任务产出波段量化开仓信号；独立《两年结构反转策略》任务可产出供人工决策的新开仓信号。'),'UTF8')),'hex'),
       updated_at=now()
 WHERE role='portfolio';

UPDATE job_definition
   SET purpose='工作日晚间聚合独立入场任务的关注结果、市场状态与全部真实持仓，输出主策略/兜底出场动作和下一交易日执行预案；不再扫描新入场信号。',
       updated_at=now()
 WHERE code='daily_plan_flow';

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,prompt.current_revision_id AS base_revision_id
    FROM job_prompt prompt WHERE prompt.code='daily_plan_flow' AND prompt.status='active'
), definition(content) AS (VALUES ($prompt$
# 每日交易计划

目标：按目标日当前最终策略运行时、独立入场任务已维护的关注状态和数据库持仓事实，生成下一交易日计划。不得交易、修改持仓、重跑入场扫描或改写策略。

1. 调用 `daily_plan_strategy_query(date=目标日)`，读取市场状态、当前关注来源、全部持仓主策略/兜底策略评估和服务端生成的 `playbook_items`。
2. 调用 `strategy_document_query` 读取《投资总策略》及工具返回的 `required_strategy_documents`。波段等新入场信号由独立任务负责；每日计划不得以关注池为扫描范围调用入场评估器。
3. 如需连续性，只用 `job_context_query` 读取最近成功计划；历史动作必须以本轮结果重新确认。
4. `status=partial` 时逐项报告 `gaps`。关注仅表示相应策略的正式或接近信号仍有效，不代表成交；不得把关注条目自动变成买入预案。
5. 有 `playbook_items` 时只调用一次 `daily_plan_write` 并原样提交；空数组时不调用并明确无结构化预案。
6. 输出紧凑 Markdown：数据日、市场与风险门禁、独立策略关注摘要、全部持仓主策略动作、兜底动作、最终动作、观察机会、数据缺口。注明策略快照与数据截止日，结果由系统保存到 `job_run_output`。
$prompt$::text)), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT current_prompt.prompt_id,
         (SELECT COALESCE(max(revision_no),0)+1 FROM job_prompt_revision WHERE prompt_id=current_prompt.prompt_id),
         definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),'user',
         current_prompt.base_revision_id,'每日计划退出入场扫描并改为聚合独立任务关注'
    FROM current_prompt CROSS JOIN definition RETURNING id,prompt_id
)
UPDATE job_prompt SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE job_prompt.id=inserted.prompt_id;

UPDATE strategy_state
   SET change_seq=change_seq+1,
       current_hash=encode(sha256(convert_to((
         SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id) FROM strategy_document
       ),'UTF8')),'hex'),
       updated_at=now()
 WHERE singleton=1;
