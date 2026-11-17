-- 研究订阅与业务池隔离：不写关注、超短候选或通知。
CREATE TABLE research_observation_subscription (
 code text PRIMARY KEY REFERENCES market_instrument(code),
 enabled boolean NOT NULL DEFAULT true
);
COMMENT ON TABLE research_observation_subscription IS '研究仅观察订阅，不代表入池或交易信号';
COMMENT ON COLUMN research_observation_subscription.code IS '已登记股票代码';
COMMENT ON COLUMN research_observation_subscription.enabled IS '是否采集公开快照';
INSERT INTO research_observation_subscription(code)
 SELECT code FROM market_instrument WHERE code IN
 ('600362.SH','000878.SZ','601899.SH','600547.SH','600489.SH','600938.SH','601857.SH','601808.SH');
CREATE TABLE research_observation_sample (
 trade_date date NOT NULL,
 code text NOT NULL REFERENCES research_observation_subscription(code),
 kind text NOT NULL CHECK(kind IN ('intraday','auction_final')),
 sample_at timestamptz NOT NULL,
 source_at timestamptz,
 price numeric,
 data_status text NOT NULL CHECK(data_status IN ('ready','missing','stale')),
 data_source text NOT NULL,
 PRIMARY KEY(trade_date,code,kind,sample_at)
);
COMMENT ON TABLE research_observation_sample IS '独立研究公开行情采样；竞价与普通快照严格分开';
COMMENT ON COLUMN research_observation_sample.trade_date IS '上海交易日';
COMMENT ON COLUMN research_observation_sample.code IS '订阅股票';
COMMENT ON COLUMN research_observation_sample.kind IS 'intraday普通快照或auction_final终态竞价';
COMMENT ON COLUMN research_observation_sample.sample_at IS '本机采集时间';
COMMENT ON COLUMN research_observation_sample.source_at IS '上游真实来源时间，缺失为空';
COMMENT ON COLUMN research_observation_sample.price IS '对应种类的价格，缺失为空';
COMMENT ON COLUMN research_observation_sample.data_status IS '来源有效性，不以普通快照填竞价';
COMMENT ON COLUMN research_observation_sample.data_source IS '公开取数能力来源';
