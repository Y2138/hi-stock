-- 期货公开目录补充；运行数据不进入固定资产。
ALTER TABLE market_futures_contract
 ADD COLUMN tick_size numeric CHECK (tick_size > 0),
 ADD COLUMN listed_date date,
 ADD COLUMN end_date date,
 ADD COLUMN external_code text,
 ADD COLUMN trade_unit text,
 ADD COLUMN source_as_of timestamptz;
COMMENT ON COLUMN market_futures_contract.tick_size IS '来源披露的最小变动价位，未知为空';
COMMENT ON COLUMN market_futures_contract.listed_date IS '来源披露上市日期';
COMMENT ON COLUMN market_futures_contract.end_date IS '来源披露结束日期';
COMMENT ON COLUMN market_futures_contract.external_code IS '数据源完整代码，包含交易所';
COMMENT ON COLUMN market_futures_contract.trade_unit IS '交易单位原文，不推断仓单单位';
COMMENT ON COLUMN market_futures_contract.source_as_of IS '来源时间，不冒充发布时间';
CREATE TABLE futures_sync_coverage (
 product_code text NOT NULL,
 target_date date NOT NULL,
 dataset text NOT NULL,
 status text NOT NULL CHECK (status IN ('ok','missing','stale','unsupported','upstream_failed','partial')),
 expected_count integer,
 written_count integer NOT NULL DEFAULT 0,
 latest_date date,
 source text NOT NULL,
 gaps jsonb NOT NULL DEFAULT '[]',
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (product_code,target_date,dataset)
);
COMMENT ON TABLE futures_sync_coverage IS '期货逐品种逐数据种类同步覆盖与显式缺口';
COMMENT ON COLUMN futures_sync_coverage.product_code IS '品种编码';
COMMENT ON COLUMN futures_sync_coverage.target_date IS '目标交易日';
COMMENT ON COLUMN futures_sync_coverage.dataset IS '目录、日线、主连、仓单或库存';
COMMENT ON COLUMN futures_sync_coverage.status IS '覆盖状态；无数据不得静默成功';
COMMENT ON COLUMN futures_sync_coverage.expected_count IS '应有合约分母，未知为空';
COMMENT ON COLUMN futures_sync_coverage.written_count IS '本次已验证记录数';
COMMENT ON COLUMN futures_sync_coverage.latest_date IS '实际最新数据日';
COMMENT ON COLUMN futures_sync_coverage.source IS '公开数据来源';
COMMENT ON COLUMN futures_sync_coverage.gaps IS '缺口与说明，不含密钥';
COMMENT ON COLUMN futures_sync_coverage.updated_at IS '核验时间';
CREATE TABLE futures_receipt_observation (
 product_code text NOT NULL, report_date date NOT NULL, external_code text NOT NULL,
 amount numeric NOT NULL, amount_change numeric, equivalent_lots numeric,
 source text NOT NULL, unit text, published_at timestamptz,
 fetched_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(product_code,report_date,external_code,source)
);
COMMENT ON TABLE futures_receipt_observation IS '期货仓单来源原值，单位和发布时间未知保留NULL，不换算总库存';
COMMENT ON COLUMN futures_receipt_observation.product_code IS '品种';
COMMENT ON COLUMN futures_receipt_observation.report_date IS '统计日期';
COMMENT ON COLUMN futures_receipt_observation.external_code IS '查询所用外部完整合约代码，不假定仓单为合约粒度';
COMMENT ON COLUMN futures_receipt_observation.amount IS '原始仓单数量';
COMMENT ON COLUMN futures_receipt_observation.amount_change IS '原始仓单变化';
COMMENT ON COLUMN futures_receipt_observation.equivalent_lots IS '来源给出的折合手数';
COMMENT ON COLUMN futures_receipt_observation.source IS '来源';
COMMENT ON COLUMN futures_receipt_observation.unit IS '原始单位，来源未披露为空';
COMMENT ON COLUMN futures_receipt_observation.published_at IS '真实发布时间，未知为空';
COMMENT ON COLUMN futures_receipt_observation.fetched_at IS '抓取时间，不冒充发布时间';
INSERT INTO job_definition(code,name,cron,job_type,config,enabled)
VALUES ('futures_daily_sync','期货目录行情与仓单日更','10 17,18,20 * * 1-5','datasource',
 '{"pipeline":"futures_daily_sync","export_volume":false}',true)
ON CONFLICT(code) DO NOTHING;
