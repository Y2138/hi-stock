-- 个股交易权限统一：仅沪深主板可交易，创业板（300/301）、科创板（688）、北交所/新三板排除。
-- 《投资总策略》第一章早已明确该权限，但两年结构反转正文写“全市场沪深A股”、
-- 价值排名使用沪深300通用口径，导致服务端扫描把无权限标的纳入信号。
-- 本迁移只收紧任务正文表述并结束旧宇宙产生的自动关注，不改任何阈值、排序或资金约束。

-- 1) 两年结构反转：股票宇宙限定为可交易的沪深主板个股。
WITH updated AS (
  SELECT id,replace(content,
    '全市场活跃非ST沪深A股，按当前有效881一级行业归属。',
    '沪深主板活跃非ST个股（遵守《投资总策略》第一章交易权限，排除创业板、科创板、北交所及新三板），按当前有效881一级行业归属。') AS content
  FROM strategy_document WHERE code='two_year_reversal_strategy'
)
UPDATE strategy_document document
   SET content=updated.content,
       sha256=encode(sha256(convert_to(updated.content,'UTF8')),'hex'),
       updated_at=now()
  FROM updated WHERE document.id=updated.id;

-- 2) 价值错杀：月度排名仍按三类适配，但只纳入可交易的沪深主板个股。
WITH updated AS (
  SELECT id,replace(content,
    '月度价值排名覆盖三类适配：财务质量、稳定现金分红、沪深300通用口径；',
    '月度价值排名覆盖三类适配：财务质量、稳定现金分红、沪深300通用口径；仅纳入沪深主板可交易个股，遵守《投资总策略》第一章交易权限；') AS content
  FROM strategy_document WHERE code='value_anchor_strategy'
)
UPDATE strategy_document document
   SET content=updated.content,
       sha256=encode(sha256(convert_to(updated.content,'UTF8')),'hex'),
       updated_at=now()
  FROM updated WHERE document.id=updated.id;

-- 3) 结束旧扫描宇宙仍在有效期的自动关注：保留历史行，仅让其退出当前关注。
UPDATE pool_attention_entry entry
   SET valid_until=(now() AT TIME ZONE 'Asia/Shanghai')::date-1,
       stale_reason='标的板块无交易权限，已按《投资总策略》第一章排除',
       updated_at=now()
 WHERE entry.source_type='strategy'
   AND (entry.valid_until IS NULL OR entry.valid_until >= (now() AT TIME ZONE 'Asia/Shanghai')::date)
   AND EXISTS (
     SELECT 1 FROM market_instrument instrument
      WHERE instrument.id=entry.instrument_id
        AND instrument.code !~ '^(600|601|603|605|000|001|002|003)'
   );

-- 4) 策略运行时版本前滚：扫描宇宙变化会影响结构化评估结果。
UPDATE strategy_definition
   SET runtime_version=runtime_version+1,updated_at=now()
 WHERE code IN ('two_year_reversal','value_anchor');

-- 5) 策略清单哈希前滚（排除已归档的铜库存与碳酸锂仓单策略）。
UPDATE strategy_state SET change_seq=change_seq+1,
  current_hash=encode(sha256(convert_to((SELECT string_agg(code||':'||sha256,E'\n' ORDER BY injection_order,id)
      FROM strategy_document
      WHERE code NOT IN ('copper_inventory_strategy','lithium_warehouse_strategy')),'UTF8')),'hex'),
  updated_at=now()
 WHERE singleton=1;
