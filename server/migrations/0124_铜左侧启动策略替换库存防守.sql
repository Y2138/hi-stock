-- 铜库存防守仓位评估退役；启用江西铜业左侧启动入场与价格结构退出策略。

ALTER TABLE portfolio_position_change DROP CONSTRAINT portfolio_position_change_entry_signal_type_check;
ALTER TABLE portfolio_position_change ADD CONSTRAINT portfolio_position_change_entry_signal_type_check CHECK (
  entry_signal_type IS NULL OR entry_signal_type IN
  ('right_side','left_reversal','two_year_reversal','trial_start','swing','limit_up','copper_left_launch','discretionary'));
ALTER TABLE portfolio_position DROP CONSTRAINT portfolio_position_entry_signal_type_check;
ALTER TABLE portfolio_position ADD CONSTRAINT portfolio_position_entry_signal_type_check CHECK (
  entry_signal_type IS NULL OR entry_signal_type IN
  ('right_side','left_reversal','two_year_reversal','trial_start','swing','limit_up','copper_left_launch','discretionary'));

WITH definition(content) AS (VALUES ($strategy$
# 铜左侧启动策略

> 职责：只锚定江西铜业，识别长期宏观没有全面破坏时的深度回撤恢复，并在江西铜业、沪铜与铜股宽度共同破坏后退出。铜库存只保留为供给约束证据，不再决定目标仓位。

## 一、入场范围

正式入场标的固定为江西铜业 `600362.SH`。铜陵有色、云南铜业、北方铜业只用于计算铜股MA60宽度，不产生本策略开仓信号。

T日收盘同时满足：

1. 当前收盘价距近252个交易日最高收盘价回撤15%至40%；
2. 当前收盘价较近60个交易日最低收盘价反弹8%至15%；
3. 该60日低点出现在最近30个交易日内；
4. 全球增长、中国需求、供给约束三项中至少两项正常；
5. 江西铜业没有当前持仓。

全球增长使用当时已发布的OECD G7 CLI：不低于99.5，或不低于三个月前。中国需求使用中国CLI三个月均值：不低于99，或不低于三个月前。供给约束使用SHFE铜库存：十二周增幅不超过25%，或库存不高于近三年70%分位。

信号在T日收盘后形成，执行参考为下一交易日开盘。系统只生成信号和关注，不自动交易、不决定用户仓位。MA60、MA120、CU0均线、铜股宽度、RSI、缩量和K线反转都不是入场硬条件。

## 二、持仓退出

持仓后每日检查：

- 江西铜业收盘价低于MA60；
- CU0收盘价低于MA60；
- 江西铜业、铜陵有色、云南铜业、北方铜业中站上MA60的比例低于50%。

三项同时连续满足10个交易日，第10日收盘确认结构破坏，下一交易日开盘退出全部剩余仓位。没有固定止盈、箱顶减仓、固定持有期限或库存单项退出。

## 三、数据边界

OECD CLI按报告月末后45日作为保守可获得时间，修订值按新发布时间写入。宏观、库存、江西铜业、CU0或铜股宽度任一关键数据不足时，评估必须返回部分完成并禁止形成正式信号。
$strategy$::text))
INSERT INTO strategy_document (code,title,role,injection_order,job_code,content,sha256)
SELECT 'copper_left_launch_strategy','铜左侧启动策略','task',43,'copper_left_launch_signal_scan',content,
       encode(sha256(convert_to(content,'UTF8')),'hex') FROM definition;

INSERT INTO strategy_definition
  (code,name,strategy_type,strategy_document_code,status,allow_new_entry,
   entry_evaluator_code,exit_evaluator_code,context_evaluator_code,
   fallback_strategy_code,exit_policy_mode,daily_plan_scope,attention_policy)
VALUES
  ('copper_left_launch','铜左侧启动策略','position','copper_left_launch_strategy','active',true,
   'copper_left_launch_entry_v1','copper_left_launch_exit_v1',NULL,
   NULL,'dedicated',ARRAY['exit','attention'], 'qualified_only');

UPDATE strategy_definition
   SET status='retired',allow_new_entry=false,daily_plan_scope='{}'::text[],attention_policy='none',
       runtime_version=runtime_version+1,updated_at=now()
 WHERE code='copper_inventory';
UPDATE job_definition SET enabled=false,purpose='已由铜左侧启动策略替换；保留历史运行记录。'
 WHERE code='copper_inventory_signal_review';

INSERT INTO job_definition (code,name,cron,job_type,config,enabled,purpose,phase,priority,agent_role)
VALUES ('commodity_copper_macro_sync','铜宏观因子同步','20 17 * * 5','datasource',
        '{"pipeline":"commodity_copper_macro_sync","export_volume":false}'::jsonb,true,
        '每周同步OECD G7/中国CLI，按保守发布时间写入点时因子，供铜左侧启动策略使用。','盘后',207,'data_pipeline');

INSERT INTO job_prompt (code,name,status)
VALUES ('copper_left_launch_signal_scan','铜左侧启动信号扫描','active');

WITH prompt AS (
  SELECT id AS prompt_id,current_revision_id AS base_revision_id FROM job_prompt WHERE code='copper_left_launch_signal_scan'
), definition(content) AS (VALUES ($prompt$
# 铜左侧启动信号扫描

目标：按目标日当前最终策略《铜左侧启动策略》评估江西铜业入场条件，维护策略关注并输出可追溯报告；结果保存到 `job_run_output`。不交易、不修改持仓、不改写策略。

1. 调用 `strategy_document_query` 读取《投资总策略》和《铜左侧启动策略》。
2. 只调用一次 `strategy_evaluation_query(date=目标日, phase="entry")`。任务已绑定 `copper_left_launch`，服务端负责宏观、库存、价格和持仓抑制的确定性计算以及关注来源对账。
3. 只解释结构化评估结果，不用网页、数据库或模型手算替代。`status=partial`时逐项列出数据缺口，不得形成入场结论。
4. 正式信号必须列明252日回撤、60日低点反弹、低点年龄、宏观3项状态、失效条件和下一交易日开盘执行参考；已有持仓只列抑制，不重复提示开仓。
5. 输出紧凑Markdown：数据日、正式信号、接近条件、宏观证据、关注变化、数据缺口和风险。最后保留`## 结论摘要`。
$prompt$::text)), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt.prompt_id,
         (SELECT COALESCE(max(revision_no),0)+1 FROM job_prompt_revision WHERE prompt_id=prompt.prompt_id),
         definition.content,encode(sha256(convert_to(definition.content,'UTF8')),'hex'),'user',
         prompt.base_revision_id,'铜左侧启动策略替换库存防守评估'
    FROM prompt CROSS JOIN definition RETURNING id,prompt_id
)
UPDATE job_prompt SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE job_prompt.id=inserted.prompt_id;

INSERT INTO job_definition
  (code,name,cron,job_type,config,prompt_id,enabled,purpose,phase,priority,strategy_code,agent_role)
SELECT 'copper_left_launch_signal_scan','铜左侧启动信号扫描','35 17 * * 1-5','agent_flow','{}'::jsonb,
       prompt.id,true,'工作日盘后评估江西铜业深度回撤恢复与宏观许可，维护正式入场关注。','盘后',208,
       'copper_left_launch','strategy_entry_report'
  FROM job_prompt prompt WHERE prompt.code='copper_left_launch_signal_scan';
