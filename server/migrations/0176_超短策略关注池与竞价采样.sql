-- 超短策略四个执行节点的持久化：T+1 关注池、竞价实时采样、盘中触发状态。
-- 03 盘后研判产出关注池；01 竞价判定更新竞价字段；04 开盘执行更新触发字段。
-- 所有行都是本机运行数据，不进入固定资产包。

CREATE TABLE ultra_short_watchlist (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_date       date NOT NULL,
  data_date         date NOT NULL,
  code              text NOT NULL,
  name              text NOT NULL,
  sources           text[] NOT NULL DEFAULT '{}',
  tags              text[] NOT NULL DEFAULT '{}',
  resonance         boolean NOT NULL DEFAULT false,
  priority          text NOT NULL DEFAULT 'P3' CHECK (priority IN ('P1','P2','P3')),
  priority_reason   text NOT NULL DEFAULT '',
  stage             text,
  streak_count      integer,
  t_facts           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(t_facts) = 'object'),
  key_levels        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(key_levels) = 'object'),
  auction_expect    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(auction_expect) = 'object'),
  intraday_plan     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(intraday_plan) = 'object'),
  risk              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(risk) = 'object'),
  review_status     text NOT NULL DEFAULT 'pass' CHECK (review_status IN ('pass','flag','invalid')),
  risk_level        text NOT NULL DEFAULT 'unknown' CHECK (risk_level IN ('high','medium','low','unknown')),
  risk_flags        text[] NOT NULL DEFAULT '{}',
  review_note       text,
  review_sources    jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(review_sources) = 'array'),
  auction_branch    text,
  auction_fill_tier text,
  auction_priority  text CHECK (auction_priority IS NULL OR auction_priority IN ('P1','P2','P3')),
  auction_metrics   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(auction_metrics) = 'object'),
  queue_window      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(queue_window) = 'object'),
  auction_note      text,
  auction_status    text NOT NULL DEFAULT 'pending',
  intraday_status   text NOT NULL DEFAULT 'waiting' CHECK (intraday_status IN ('waiting','triggered','invalidated','no_chase','filled')),
  trigger_type      text,
  trigger_at        timestamptz,
  trigger_price     numeric,
  trigger_reason    text,
  intraday_note     text,
  reminder_at       timestamptz,
  reminder_type     text,
  reminder_status   text,
  reminder_note     text,
  data_status       text NOT NULL DEFAULT 'ready' CHECK (data_status IN ('ready','partial','insufficient')),
  gaps              jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(gaps) = 'array'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_date, code)
);
CREATE INDEX ultra_short_watchlist_date_priority ON ultra_short_watchlist (target_date, priority, code);
COMMENT ON TABLE ultra_short_watchlist IS '超短 T+1 关注池：03 产出，01 写竞价字段，04 写触发字段；本机运行数据';
COMMENT ON COLUMN ultra_short_watchlist.target_date IS '关注池适用的下一交易日';
COMMENT ON COLUMN ultra_short_watchlist.data_date IS '生成关注池所用的 T 日收盘数据日';
COMMENT ON COLUMN ultra_short_watchlist.sources IS '来源：post_close/intraday_ladder/low_buy';
COMMENT ON COLUMN ultra_short_watchlist.tags IS '战法标签：一字延续、换手晋级、龙回头、单阳不破、N字、线上阴线';
COMMENT ON COLUMN ultra_short_watchlist.priority IS '03 基础优先级 P1/P2/P3，只影响排序和提示强度';
COMMENT ON COLUMN ultra_short_watchlist.key_levels IS '前收、涨停价、均线、形态低点、失效位、止损位';
COMMENT ON COLUMN ultra_short_watchlist.review_status IS '确定性核验或 LLM 复核：pass/flag/invalid';
COMMENT ON COLUMN ultra_short_watchlist.auction_branch IS '01 竞价分支：一字延续/换手晋级/高开过度/低开分歧/走弱/数据不足';
COMMENT ON COLUMN ultra_short_watchlist.auction_fill_tier IS '一字排队成交概率档：高/中/低/无';
COMMENT ON COLUMN ultra_short_watchlist.auction_priority IS '01 竞价后的执行优先级；不改写 03 的 priority';
COMMENT ON COLUMN ultra_short_watchlist.intraday_status IS '04 开盘执行状态：waiting/triggered/invalidated/no_chase/filled';
COMMENT ON COLUMN ultra_short_watchlist.reminder_type IS '提醒类型：auction_buy/auction_upgrade/auction_cancel/intraday_trigger/intraday_cancel';
COMMENT ON COLUMN ultra_short_watchlist.gaps IS '数据缺口；不能猜的字段显式列出';

CREATE TABLE auction_intraday_sample (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trade_date                  date NOT NULL,
  sample_at                   timestamptz NOT NULL,
  stage                       text NOT NULL CHECK (stage IN ('live','final')),
  code                        text NOT NULL,
  auction_price               numeric,
  auction_pct                 numeric,
  auction_unmatched           numeric,
  auction_volume              numeric,
  auction_amount              numeric,
  auction_turnover_pct        numeric,
  auction_volume_ratio        numeric,
  auction_yesterday_ratio_pct numeric,
  float_market_cap            numeric,
  unmatched_ratio             numeric,
  source_at                   timestamptz,
  data_status                 text NOT NULL DEFAULT 'ready' CHECK (data_status IN ('ready','partial','insufficient')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trade_date, code, stage, sample_at)
);
CREATE INDEX auction_intraday_sample_date_code ON auction_intraday_sample (trade_date, code, sample_at DESC);
COMMENT ON TABLE auction_intraday_sample IS '关注池 09:18–09:25 竞价轨迹；只保留判定需要的盘口数值';
COMMENT ON COLUMN auction_intraday_sample.stage IS 'live=9:20–9:24 实时阶段，final=9:25 最终快照';
COMMENT ON COLUMN auction_intraday_sample.unmatched_ratio IS '未匹配量/竞价量；正为买方未匹配，负为卖方未匹配';

-- 04 复用 30 秒盘中采样：关注池角色与持仓风险采样分开，避免改变持仓观察语义。
ALTER TABLE intraday_market_sample DROP CONSTRAINT intraday_market_sample_role_check;
ALTER TABLE intraday_market_sample ADD CONSTRAINT intraday_market_sample_role_check
  CHECK (role IN ('position','industry','index','watch'));

-- 超短提醒只走个人通道，不关联任务结果；event_key 保证同一事件不重复推送。
ALTER TABLE notification_delivery DROP CONSTRAINT notification_delivery_kind_check;
ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_kind_check
  CHECK (kind IN ('daily_plan','agent_result','intraday_risk','test','ultra_short'));
ALTER TABLE notification_delivery ADD COLUMN event_key text;
CREATE UNIQUE INDEX notification_delivery_event_key ON notification_delivery (event_key) WHERE event_key IS NOT NULL;
COMMENT ON COLUMN notification_delivery.event_key IS '超短提醒去重键；任务结果与连接测试为空';

-- 01 竞价判定作为确定性 analysis 任务运行，不引入 Agent/LLM。
ALTER TABLE analysis_run DROP CONSTRAINT analysis_run_analysis_type_check;
ALTER TABLE analysis_run ADD CONSTRAINT analysis_run_analysis_type_check
  CHECK (analysis_type = ANY (ARRAY[
    'sector_temperature','key_levels','long_valuation','value_monthly_rank',
    'sector_trend_structure','ultra_short_auction'
  ]));

INSERT INTO job_definition (code, name, cron, job_type, config, enabled, purpose, phase, priority, trading_day_only, execution_scope)
VALUES (
  'ultra_short_auction_watch',
  '超短竞价判定',
  '18,20-25 9 * * 1-5',
  'analysis',
  '{"analysis_type":"ultra_short_auction"}'::jsonb,
  true,
  '09:18–09:25 对超短关注池逐只采样竞价事实，判定一字延续/换手晋级/高开/低开/走弱，并在 09:20–09:24 对满足条件的一字延续发买入提醒；只更新关注池，不新增候选。',
  '盘前',
  150,
  true,
  'global'
);

COMMENT ON COLUMN ultra_short_watchlist.id IS '关注池行主键';
COMMENT ON COLUMN ultra_short_watchlist.name IS '标的名称';
COMMENT ON COLUMN ultra_short_watchlist.code IS '标的代码';
COMMENT ON COLUMN ultra_short_watchlist.resonance IS '多来源共振标记';
COMMENT ON COLUMN ultra_short_watchlist.priority_reason IS '基础优先级理由';
COMMENT ON COLUMN ultra_short_watchlist.stage IS '阶段：首板/中位/高位/断板/前期龙头';
COMMENT ON COLUMN ultra_short_watchlist.streak_count IS 'T 日连板高度';
COMMENT ON COLUMN ultra_short_watchlist.t_facts IS 'T 日筹码与量价事实';
COMMENT ON COLUMN ultra_short_watchlist.auction_expect IS '01 竞价验证预期分支';
COMMENT ON COLUMN ultra_short_watchlist.intraday_plan IS '04 盘中触发与失效计划';
COMMENT ON COLUMN ultra_short_watchlist.risk IS '风险模板：止损、仓位上限、战法';
COMMENT ON COLUMN ultra_short_watchlist.review_note IS '复核说明';
COMMENT ON COLUMN ultra_short_watchlist.review_sources IS '复核引用来源';
COMMENT ON COLUMN ultra_short_watchlist.auction_metrics IS '竞价盘口数值';
COMMENT ON COLUMN ultra_short_watchlist.queue_window IS '一字建议排队窗口与价格';
COMMENT ON COLUMN ultra_short_watchlist.auction_note IS '竞价结论';
COMMENT ON COLUMN ultra_short_watchlist.auction_status IS '竞价判定数据状态：pending/ready/partial/insufficient';
COMMENT ON COLUMN ultra_short_watchlist.trigger_type IS '04 触发类型';
COMMENT ON COLUMN ultra_short_watchlist.trigger_at IS '04 触发时间';
COMMENT ON COLUMN ultra_short_watchlist.trigger_price IS '04 触发价';
COMMENT ON COLUMN ultra_short_watchlist.trigger_reason IS '04 触发依据';
COMMENT ON COLUMN ultra_short_watchlist.intraday_note IS '04 盘中结论';
COMMENT ON COLUMN ultra_short_watchlist.reminder_at IS '最近一次提醒时间';
COMMENT ON COLUMN ultra_short_watchlist.reminder_status IS '提醒状态：queued/skipped/failed';
COMMENT ON COLUMN ultra_short_watchlist.reminder_note IS '提醒补充说明';
COMMENT ON COLUMN ultra_short_watchlist.data_status IS '行级数据完整度';
COMMENT ON COLUMN ultra_short_watchlist.created_at IS '创建时间';
COMMENT ON COLUMN ultra_short_watchlist.updated_at IS '更新时间';

COMMENT ON COLUMN auction_intraday_sample.id IS '竞价采样主键';
COMMENT ON COLUMN auction_intraday_sample.trade_date IS '采样交易日';
COMMENT ON COLUMN auction_intraday_sample.sample_at IS '本机采样时间';
COMMENT ON COLUMN auction_intraday_sample.code IS '标的代码';
COMMENT ON COLUMN auction_intraday_sample.auction_price IS '竞价价格';
COMMENT ON COLUMN auction_intraday_sample.auction_pct IS '竞价相对前收涨跌幅';
COMMENT ON COLUMN auction_intraday_sample.auction_unmatched IS '未匹配量：正为买方，负为卖方';
COMMENT ON COLUMN auction_intraday_sample.auction_volume IS '竞价成交量';
COMMENT ON COLUMN auction_intraday_sample.auction_amount IS '竞价成交额';
COMMENT ON COLUMN auction_intraday_sample.auction_turnover_pct IS '竞价换手率';
COMMENT ON COLUMN auction_intraday_sample.auction_volume_ratio IS '竞价量比';
COMMENT ON COLUMN auction_intraday_sample.auction_yesterday_ratio_pct IS '竞价量占昨日成交量比例';
COMMENT ON COLUMN auction_intraday_sample.float_market_cap IS '流通市值';
COMMENT ON COLUMN auction_intraday_sample.source_at IS '供应商快照时间';
COMMENT ON COLUMN auction_intraday_sample.data_status IS '采样数据完整度';
COMMENT ON COLUMN auction_intraday_sample.created_at IS '写入时间';
COMMENT ON COLUMN ultra_short_watchlist.sources IS '来源集合：post_close/intraday_ladder/low_buy';
COMMENT ON COLUMN ultra_short_watchlist.tags IS '战法标签集合';
COMMENT ON COLUMN ultra_short_watchlist.priority IS '基础优先级 P1/P2/P3';
COMMENT ON COLUMN ultra_short_watchlist.review_status IS '复核状态：pass/flag/invalid';
COMMENT ON COLUMN ultra_short_watchlist.risk_level IS '风险等级：high/medium/low/unknown';
COMMENT ON COLUMN ultra_short_watchlist.risk_flags IS '风险标签';
COMMENT ON COLUMN ultra_short_watchlist.auction_branch IS '竞价分支';
COMMENT ON COLUMN ultra_short_watchlist.auction_fill_tier IS '一字排队成交概率档：high/medium/low/none';
COMMENT ON COLUMN ultra_short_watchlist.auction_priority IS '竞价后的执行优先级';
COMMENT ON COLUMN ultra_short_watchlist.intraday_status IS '04 盘中状态：waiting/triggered/invalidated/no_chase/filled';
COMMENT ON COLUMN ultra_short_watchlist.reminder_type IS '提醒类型';
COMMENT ON COLUMN ultra_short_watchlist.gaps IS '数据缺口';
