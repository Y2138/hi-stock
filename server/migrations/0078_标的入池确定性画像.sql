-- 正式指标重算同步生成版本化五维股性、阶段和评分；池成员保存入池时采用的画像快照与来源。

ALTER TABLE market_stock_character_metric
  ADD COLUMN stock_character_profile jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(stock_character_profile) = 'object'),
  ADD COLUMN stage text,
  ADD COLUMN research_score double precision
    CHECK (research_score IS NULL OR research_score BETWEEN 0 AND 100),
  ADD COLUMN grade text CHECK (grade IS NULL OR grade IN ('A','B','C','D')),
  ADD COLUMN stock_character text,
  ADD COLUMN tags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags) = 'array');

ALTER TABLE pool_membership
  ADD COLUMN stock_character_profile jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(stock_character_profile) = 'object'),
  ADD COLUMN profile_as_of date,
  ADD COLUMN profile_calculation_version text,
  ADD COLUMN profile_input_sha256 text
    CHECK (profile_input_sha256 IS NULL OR profile_input_sha256 ~ '^[a-f0-9]{64}$');

COMMENT ON TABLE market_stock_character_metric IS
  '按正式日线指标运行与计算版本保存五维股性、阶段、评分及护盘恢复指标';
COMMENT ON COLUMN market_stock_character_metric.stock_character_profile IS '洗盘、拉升、假突破、护盘和波动五维确定性画像及证据';
COMMENT ON COLUMN market_stock_character_metric.stage IS '由正式日线和均线确定性计算的当前阶段';
COMMENT ON COLUMN market_stock_character_metric.research_score IS '五维画像确定性研究评分，范围0至100';
COMMENT ON COLUMN market_stock_character_metric.grade IS '由研究评分确定性映射的A至D等级';
COMMENT ON COLUMN market_stock_character_metric.stock_character IS '五维股性的紧凑中文摘要';
COMMENT ON COLUMN market_stock_character_metric.tags IS '由五维画像确定性生成的标签数组';
COMMENT ON COLUMN pool_membership.stock_character_profile IS '入池时采用的五维股性确定性画像快照';
COMMENT ON COLUMN pool_membership.profile_as_of IS '入池画像的数据截止日';
COMMENT ON COLUMN pool_membership.profile_calculation_version IS '入池画像的确定性计算版本';
COMMENT ON COLUMN pool_membership.profile_input_sha256 IS '入池画像所用正式指标输入的SHA-256';

INSERT INTO market_indicator_dirty
  (instrument_id, freq, earliest_date, generation, reason, updated_at)
SELECT bar.instrument_id, 'day', min(bar.bar_date), 1, '补算标的入池五维画像', now()
  FROM market_bar bar
  JOIN market_instrument instrument ON instrument.id = bar.instrument_id
 WHERE bar.freq = 'day' AND instrument.kind IN ('stock','etf')
 GROUP BY bar.instrument_id
ON CONFLICT (instrument_id, freq) DO UPDATE SET
  earliest_date = LEAST(market_indicator_dirty.earliest_date, EXCLUDED.earliest_date),
  generation = market_indicator_dirty.generation + 1,
  reason = EXCLUDED.reason,
  updated_at = now();
