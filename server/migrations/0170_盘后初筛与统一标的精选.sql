CREATE TABLE strategy_candidate_shortlist (
  source_job_run_id bigint PRIMARY KEY REFERENCES job_run(id) ON DELETE CASCADE,
  strategy_code text NOT NULL REFERENCES strategy_definition(code),
  target_date date NOT NULL,
  data_date date NOT NULL,
  status text NOT NULL CHECK(status IN ('success','partial')),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX strategy_candidate_shortlist_date_idx ON strategy_candidate_shortlist(target_date,strategy_code);
CREATE TABLE candidate_selection_result (
  job_run_id bigint PRIMARY KEY REFERENCES job_run(id) ON DELETE CASCADE,
  target_date date NOT NULL,
  source_context jsonb NOT NULL CHECK(jsonb_typeof(source_context)='object'),
  result jsonb CHECK(result IS NULL OR jsonb_typeof(result)='object'),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','generated')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE strategy_candidate_shortlist IS '原策略按自身排序初筛，完整命中用于共振；本机运行数据';
COMMENT ON TABLE candidate_selection_result IS '独立任务的盘后统一研究及最多三个推荐；不写持仓和关注';

COMMENT ON COLUMN strategy_candidate_shortlist.source_job_run_id IS '原策略任务运行，重试沿用同一初筛记录';
COMMENT ON COLUMN strategy_candidate_shortlist.strategy_code IS '原生策略归因';
COMMENT ON COLUMN strategy_candidate_shortlist.target_date IS '任务目标交易日';
COMMENT ON COLUMN strategy_candidate_shortlist.data_date IS '原生评估真实数据日';
COMMENT ON COLUMN strategy_candidate_shortlist.status IS '原生初筛完整或部分完成';
COMMENT ON COLUMN strategy_candidate_shortlist.payload IS '精选候选、完整命中登记、来源版本及缺口';
COMMENT ON COLUMN strategy_candidate_shortlist.input_hash IS '初筛内容指纹，防止旧研究覆盖新来源';
COMMENT ON COLUMN strategy_candidate_shortlist.created_at IS '本次初筛生成时间';
COMMENT ON COLUMN candidate_selection_result.job_run_id IS '独立统一精选任务运行';
COMMENT ON COLUMN candidate_selection_result.target_date IS '精选目标交易日';
COMMENT ON COLUMN candidate_selection_result.source_context IS '锁定的策略初筛、共振和价格证据副本';
COMMENT ON COLUMN candidate_selection_result.result IS '逐股研究、最终推荐、理由、风险与来源';
COMMENT ON COLUMN candidate_selection_result.status IS '草稿或随任务结论正式生成';
COMMENT ON COLUMN candidate_selection_result.updated_at IS '结果更新时间';

UPDATE job_definition SET cron=CASE code
  WHEN 'swing_signal_scan' THEN '5 18 * * 1-5'
  WHEN 'two_year_reversal_scan' THEN '25 18 * * 1-5'
  WHEN 'nightly_sector_opportunity_scan' THEN '40 18 * * 1-5'
  WHEN 'value_anchor_opportunity_scan' THEN '0 19 * * 1-5'
  END,updated_at=now()
WHERE code IN ('swing_signal_scan','two_year_reversal_scan','nightly_sector_opportunity_scan','value_anchor_opportunity_scan');

INSERT INTO job_prompt(code,name,status) VALUES('cross_strategy_selection','盘后统一标的精选','active');
WITH inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,change_summary)
  SELECT id,1,$prompt$# 盘后统一标的精选

目标：只对今天各盘后策略的原生初筛集合做一次集中深入研究，选择最多三个值得优先了解的标的，并通过服务端结构化结果生成飞书摘要。原生条件与技术质量由各策略评估，不建立一套通用技术分，不重算、放宽或创造入场信号。

1. 读取当前最终策略中的投资总策略；本任务完整结果保存为 job_run_output。调用 selection_context_query(date=目标日)，锁定 input_hash、来源覆盖、正式候选、接近候选及多策略命中；只研究这些代码，不解析任务 Markdown 或自己扩大范围。来源部分完成时明确覆盖不足。
2. 正式候选优先：先逐只完成正式集合研究和风险排除。若至少三个适合推荐且行业限制允许的正式标的，不研究、不填充接近候选；正式不足才补充少量接近候选，仍标等待条件，绝不升级。
3. 用 stock_research_query 分批读取本地财务、估值、原生股性画像与价格。缺数据可用 fetch_market_data 补齐后再读取，不猜利润趋势或财务值。用 web_search 核验每只候选的最新公告、消息和行业地位，重要来源再 web_fetch 核验正文、发布时间。先本地、后补缺，不进行全市场取数。
4. 逐股综合基本面、消息面、行业地位、股性、量价可执行性和约10万元参考价格适配。优先两位数股价，但买入单位与分批退出颗粒度更重要；不是所有股票都按100股。不要读取个人持仓或账户，不宣称现金、回撤与仓位约束已验证。金融和周期企业按经营背景解释，不统一高ROE或低波动硬筛。无新消息是有效检索结论，不算缺口。
5. 多策略有效命中是明确增强因素：不同依据共振优先，同超跌家族或情绪家族折减，重复运行、同策略多触发线、板块及其派生接近个股不重复计数。只认同执行窗口的有效来源，不承诺胜率提升数值；共振不能覆盖重大利空或补齐未知证据。
6. 每只正式候选提交研究，decision 分为 priority/observe/exclude/pending。priority只用于原生条件成立、无未解决重大风险且关键事实完成核验；approaching只能observe。strength表示研究支持 strong/adequate/weak，rank表示同档研究优先顺序，不是概率。每个维度写依据，每条资料 sources 引用本次工具实际返回的 URL，或 kind=local、reference=同标的代码的本次 stock_research_query 结果。未核实的关键事实写pending，不得推荐。不要把弱证据写成strong以凑名单。
7. 调用 selection_result_write(target_date,input_hash,reviews,gaps)，服务端按正式优先、研究强度、共振和研究顺序确定最多三个、每行业最多两个，并返回唯一名单和摘要。risk和condition必须清晰简短，摘要超过500字时缩短后重交。研究完整但无合适推荐时提交空名单，不凑数；除非无候选，否则不可省略实际研究工具。
8. 最终报告只能解释服务端返回的推荐，不新增或改序；末尾 ## 结论摘要 使用服务端 summary。报告说明来源、研究依据、共振、风险、原策略参与方式与失效条件、数据时间和缺口。价值关注与观察不视为可立即买入；任务不修改关注、持仓或策略。
$prompt$,encode(sha256(convert_to($prompt$盘后统一精选结构化研究与推荐$prompt$,'UTF8')),'hex'),'user','集中研究策略初筛标的并输出最多三个推荐'
  FROM job_prompt WHERE code='cross_strategy_selection' RETURNING id,prompt_id,content
)
UPDATE job_prompt p SET current_revision_id=i.id FROM inserted i WHERE p.id=i.prompt_id;
-- 当前版本内容哈希采用实际正文。
UPDATE job_prompt_revision SET sha256=encode(sha256(convert_to(content,'UTF8')),'hex')
WHERE prompt_id=(SELECT id FROM job_prompt WHERE code='cross_strategy_selection');
INSERT INTO job_definition(code,name,cron,job_type,config,prompt_id,enabled,purpose,phase,priority,agent_role,trading_day_only,execution_scope)
SELECT 'cross_strategy_selection','盘后统一标的精选','30 19 * * 1-5','agent_flow','{}',id,true,
  '19:30读取当日各策略初筛，集中研究基本面、消息、行业地位、股性与价格适配，以有效共振增强，最多推荐三只并推送飞书。',
  '夜间',245,'research_report',true,'global' FROM job_prompt WHERE code='cross_strategy_selection';

WITH current_prompt AS (
  SELECT p.id AS prompt_id,p.current_revision_id AS base_revision_id,r.content
  FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id
  WHERE p.code IN ('swing_signal_scan','two_year_reversal_scan','value_anchor_opportunity_scan','limit_up_close_scan','nightly_sector_opportunity_scan')
), revised AS (
  SELECT *,content || E'\n\n## 本策略简单精选\n保持本策略原生指标和排序，正式优先。行业最多两只，总量最多五只（现有更严格上限不放宽）。至少三只正式入选时忽略接近候选，否则最多补充两只接近。数量落选不等于原生条件失效，需保留完整复核事实；深入基本面、消息与跨策略比较由19:30统一精选任务承担。只展示服务端结构化初筛名单。夜间板块在18:40执行，个股仍为approaching且按原分支B优先。' AS new_content
  FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,(SELECT max(revision_no)+1 FROM job_prompt_revision WHERE prompt_id=revised.prompt_id),
  new_content,encode(sha256(convert_to(new_content,'UTF8')),'hex'),'user',base_revision_id,'原生正式优先初筛并提供统一精选来源'
  FROM revised RETURNING id,prompt_id
)
UPDATE job_prompt p SET current_revision_id=i.id,updated_at=now() FROM inserted i WHERE p.id=i.prompt_id;
UPDATE strategy_definition SET runtime_version=runtime_version+1,updated_at=now()
WHERE code IN ('swing','two_year_reversal','value_anchor','limit_up');
-- 用户明确要求新任务推送；已有显式策略订阅增加新任务，通道开关与密钥保持原配置。
UPDATE notification_setting SET job_codes=array_append(job_codes,'cross_strategy_selection')
WHERE job_codes IS NOT NULL AND NOT ('cross_strategy_selection'=ANY(job_codes));
