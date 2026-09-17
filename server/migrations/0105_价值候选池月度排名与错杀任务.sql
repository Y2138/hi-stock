-- 0105_价值候选池月度排名与错杀任务.sql：公司行动事实、月度价值排名以及第一版三类任务。

CREATE TABLE market_corporate_action (
  instrument_id       bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  ex_date             date NOT NULL,
  dividend_per_share  numeric NOT NULL DEFAULT 0,
  bonus_per_share     numeric NOT NULL DEFAULT 0,
  rights_ratio        numeric NOT NULL DEFAULT 0,
  rights_price        numeric NOT NULL DEFAULT 0,
  source              text NOT NULL,
  raw_summary         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(raw_summary) = 'object'),
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, ex_date)
);
CREATE INDEX market_corporate_action_date_idx
  ON market_corporate_action (ex_date DESC, instrument_id);

CREATE TABLE market_corporate_action_sync_state (
  instrument_id bigint PRIMARY KEY REFERENCES market_instrument(id) ON DELETE CASCADE,
  last_checked_at timestamptz NOT NULL,
  latest_ex_date date,
  status text NOT NULL CHECK (status IN ('success','empty','failed')),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE value_rank_snapshot (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  analysis_run_id       bigint NOT NULL REFERENCES analysis_run(id) ON DELETE CASCADE,
  rank_date             date NOT NULL,
  effective_from        date NOT NULL,
  instrument_id         bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  industry_code         text,
  industry_name         text,
  source_flags          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(source_flags) = 'array'),
  adapter               text NOT NULL CHECK (adapter IN ('financial','stable_cashflow','csi300_general')),
  eligibility_status    text NOT NULL CHECK (eligibility_status IN ('eligible','liquidity_ineligible','data_missing','quality_failed')),
  bar_date              date,
  fundamental_date      date,
  valuation_date        date,
  corporate_action_date date,
  median_turnover_60    numeric,
  dividend_yield_ttm    numeric,
  dividend_years_3y     int,
  roe                   numeric,
  profit_trend          numeric,
  operating_cashflow    numeric,
  debt_ratio            numeric,
  pe_ttm                numeric,
  pb                    numeric,
  ps_ttm                numeric,
  quality_score         numeric,
  value_score           numeric,
  total_score           numeric,
  rank_in_adapter       int,
  rank_overall          int,
  candidate_level       text CHECK (candidate_level IS NULL OR candidate_level IN ('core','strong','candidate','eligible')),
  data_gaps             jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(data_gaps) = 'array'),
  calculation_version   text NOT NULL,
  input_sha256          text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (analysis_run_id, instrument_id)
);
CREATE INDEX value_rank_snapshot_rank_idx
  ON value_rank_snapshot (rank_date DESC, eligibility_status, rank_overall);
CREATE INDEX value_rank_snapshot_instrument_idx
  ON value_rank_snapshot (instrument_id, rank_date DESC);
CREATE INDEX value_rank_snapshot_level_idx
  ON value_rank_snapshot (effective_from DESC, candidate_level, rank_overall);

ALTER TABLE analysis_run DROP CONSTRAINT analysis_run_analysis_type_check;
ALTER TABLE analysis_run ADD CONSTRAINT analysis_run_analysis_type_check
  CHECK (analysis_type IN ('sector_temperature','key_levels','long_valuation','value_monthly_rank'));

INSERT INTO job_definition (code,name,cron,job_type,config,enabled) VALUES
  ('value_candidate_sync','价值候选数据同步','40 6 * * 6','datasource',
   '{"pipeline":"value_candidate_sync","export_volume":false}',true),
  ('value_monthly_rank','月度价值排名','45 17 * * 1-5','analysis',
   '{"analysis_type":"value_monthly_rank","request":{}}',true)
ON CONFLICT (code) DO UPDATE SET
  name=EXCLUDED.name,cron=EXCLUDED.cron,job_type=EXCLUDED.job_type,
  config=EXCLUDED.config,enabled=EXCLUDED.enabled,updated_at=now();

INSERT INTO job_prompt (code,name,status)
VALUES ('value_anchor_opportunity_scan','每日A级价值错杀扫描','active')
ON CONFLICT (code) DO NOTHING;

WITH prompt AS (
  SELECT id AS prompt_id,current_revision_id AS base_revision_id
    FROM job_prompt WHERE code='value_anchor_opportunity_scan'
), definition(content) AS (
  VALUES ($prompt$
# 每日A级价值错杀扫描

目标：读取服务端固定口径的当前月度价值Top50，按目标日扫描A级价值错杀。任务只形成研究级人工决策证据，不入池、不写关注、不写持仓、不交易，也不修改其他策略信号。

## 执行流程

1. 只调用一次 `value_anchor_signal_query(date=目标日)`，不得使用数据库、通用行情或网页资料重新计算。
2. 以工具返回的排名日期、覆盖计数、正式候选、接近候选、筛除项和缺口为唯一量化事实；0个正式候选是有效结论，不得降低阈值凑数。
3. 正式候选固定要求：当前月度排名Top10、TTM股息率至少3%、过去3年持续现金分红、未复权价格低于MA250至少10%、20日回撤10%至30%、5日跌幅至少4%、不处于除息日及其后3日、月度质量资格仍有效。
4. 建议增配比例固定为10%，并给出第20个交易日复核日期；这只是研究建议，不得输出自动交易指令或收益承诺。
5. 接近候选只允许缺一个价格条件；数据缺口不得包装成筛除或正式候选。

## 输出

输出紧凑Markdown，包含：数据日与月度排名日期、Top50覆盖、正式候选、接近候选、主要筛除原因、数据缺口和边界。正式候选逐只列代码、名称、行业、月度排名、股息率、连续分红年数、MA250偏离、20日回撤、5日跌幅、建议比例和复核日期。

末尾必须输出 `## 结论摘要`，用2至5条短句概括正式候选数量、优先标的、触发条件和主要风险；没有正式候选时明确说明。
$prompt$)
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt.prompt_id,
         (SELECT COALESCE(max(x.revision_no),0)+1 FROM job_prompt_revision x WHERE x.prompt_id=prompt.prompt_id),
         definition.content,
         encode(sha256(convert_to(definition.content,'UTF8')),'hex'),
         'user',prompt.base_revision_id,'新增每日A级价值错杀扫描任务'
    FROM prompt CROSS JOIN definition
   WHERE NOT EXISTS (
     SELECT 1 FROM job_prompt_revision x
      WHERE x.prompt_id=prompt.prompt_id
        AND x.sha256=encode(sha256(convert_to(definition.content,'UTF8')),'hex')
   )
  RETURNING prompt_id,id
), selected AS (
  SELECT prompt_id,id FROM inserted
  UNION ALL
  SELECT prompt.prompt_id,revision.id
    FROM prompt CROSS JOIN definition
    JOIN job_prompt_revision revision
      ON revision.prompt_id=prompt.prompt_id
     AND revision.sha256=encode(sha256(convert_to(definition.content,'UTF8')),'hex')
   WHERE NOT EXISTS (SELECT 1 FROM inserted)
   LIMIT 1
)
UPDATE job_prompt prompt SET current_revision_id=selected.id,updated_at=now()
  FROM selected WHERE prompt.id=selected.prompt_id;

INSERT INTO job_definition (code,name,cron,job_type,config,prompt_id,model_id,enabled)
SELECT 'value_anchor_opportunity_scan','每日A级价值错杀扫描','30 19 * * 1-5',
       'agent_flow','{}'::jsonb,prompt.id,NULL,true
  FROM job_prompt prompt WHERE prompt.code='value_anchor_opportunity_scan'
ON CONFLICT (code) DO UPDATE SET
  name=EXCLUDED.name,cron=EXCLUDED.cron,job_type=EXCLUDED.job_type,
  config=EXCLUDED.config,prompt_id=EXCLUDED.prompt_id,model_id=EXCLUDED.model_id,
  enabled=EXCLUDED.enabled,updated_at=now();

COMMENT ON TABLE market_corporate_action_sync_state IS '公司行动候选增量同步游标和空结果留痕';
COMMENT ON TABLE market_corporate_action IS '股票点时公司行动：现金分红、送股与配股，用于价值排名和未复权现金账本';
COMMENT ON TABLE value_rank_snapshot IS '月度价值候选资格、行业适配评分与Top5/Top10/Top50快照';
COMMENT ON COLUMN market_corporate_action.instrument_id IS '关联股票标的';
COMMENT ON COLUMN market_corporate_action.ex_date IS '除权除息日';
COMMENT ON COLUMN market_corporate_action.dividend_per_share IS '每股现金分红';
COMMENT ON COLUMN market_corporate_action.bonus_per_share IS '每股送股比例';
COMMENT ON COLUMN market_corporate_action.rights_ratio IS '配股比例';
COMMENT ON COLUMN market_corporate_action.rights_price IS '配股价格';
COMMENT ON COLUMN market_corporate_action.source IS '数据来源';
COMMENT ON COLUMN market_corporate_action.raw_summary IS '脱敏原始摘要';
COMMENT ON COLUMN market_corporate_action.fetched_at IS '抓取时间';
COMMENT ON COLUMN market_corporate_action_sync_state.instrument_id IS '关联股票标的';
COMMENT ON COLUMN market_corporate_action_sync_state.last_checked_at IS '最后检查时间';
COMMENT ON COLUMN market_corporate_action_sync_state.latest_ex_date IS '已同步最新除权日';
COMMENT ON COLUMN market_corporate_action_sync_state.status IS '同步状态';
COMMENT ON COLUMN market_corporate_action_sync_state.last_error IS '最近错误摘要';
COMMENT ON COLUMN market_corporate_action_sync_state.updated_at IS '更新时间';
COMMENT ON COLUMN value_rank_snapshot.id IS '月度价值排名快照主键';
COMMENT ON COLUMN value_rank_snapshot.analysis_run_id IS '关联分析运行';
COMMENT ON COLUMN value_rank_snapshot.rank_date IS '排名数据截止日';
COMMENT ON COLUMN value_rank_snapshot.effective_from IS '排名生效日';
COMMENT ON COLUMN value_rank_snapshot.instrument_id IS '关联股票标的';
COMMENT ON COLUMN value_rank_snapshot.industry_code IS '点时行业代码';
COMMENT ON COLUMN value_rank_snapshot.industry_name IS '点时行业名称';
COMMENT ON COLUMN value_rank_snapshot.source_flags IS '候选来源标记';
COMMENT ON COLUMN value_rank_snapshot.adapter IS '行业适配评分模型';
COMMENT ON COLUMN value_rank_snapshot.eligibility_status IS '排名资格状态';
COMMENT ON COLUMN value_rank_snapshot.bar_date IS '行情数据日期';
COMMENT ON COLUMN value_rank_snapshot.fundamental_date IS '财务数据日期';
COMMENT ON COLUMN value_rank_snapshot.valuation_date IS '估值数据日期';
COMMENT ON COLUMN value_rank_snapshot.corporate_action_date IS '公司行动数据日期';
COMMENT ON COLUMN value_rank_snapshot.median_turnover_60 IS '近60日成交额中位数';
COMMENT ON COLUMN value_rank_snapshot.dividend_yield_ttm IS 'TTM现金股息率';
COMMENT ON COLUMN value_rank_snapshot.dividend_years_3y IS '过去3年有现金分红的年份数';
COMMENT ON COLUMN value_rank_snapshot.roe IS '净资产收益率';
COMMENT ON COLUMN value_rank_snapshot.profit_trend IS '相邻可见报告净利润变化率';
COMMENT ON COLUMN value_rank_snapshot.operating_cashflow IS '经营活动现金流';
COMMENT ON COLUMN value_rank_snapshot.debt_ratio IS '资产负债率';
COMMENT ON COLUMN value_rank_snapshot.pe_ttm IS '滚动市盈率';
COMMENT ON COLUMN value_rank_snapshot.pb IS '市净率';
COMMENT ON COLUMN value_rank_snapshot.ps_ttm IS '滚动市销率';
COMMENT ON COLUMN value_rank_snapshot.quality_score IS '质量评分';
COMMENT ON COLUMN value_rank_snapshot.value_score IS '价值评分';
COMMENT ON COLUMN value_rank_snapshot.total_score IS '统一总评分';
COMMENT ON COLUMN value_rank_snapshot.rank_in_adapter IS '适配组内排名';
COMMENT ON COLUMN value_rank_snapshot.rank_overall IS '统一排名';
COMMENT ON COLUMN value_rank_snapshot.candidate_level IS 'Top5 Top10 Top50候选等级';
COMMENT ON COLUMN value_rank_snapshot.data_gaps IS '该标的数据缺口';
COMMENT ON COLUMN value_rank_snapshot.calculation_version IS '计算版本';
COMMENT ON COLUMN value_rank_snapshot.input_sha256 IS '冻结输入摘要';
COMMENT ON COLUMN value_rank_snapshot.created_at IS '创建时间';
