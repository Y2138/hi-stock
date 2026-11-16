-- 空库全量迁移后的策略状态建档：strategy_document 已有正文，但 0017 的条件建行在空库不会触发，
-- strategy_state 缺失会让 getCurrentStrategy 报“当前策略尚未初始化”。
-- 这里按当前清单幂等补建一次；已有单例行的库不做任何修改（哈希刷新由各正文迁移负责）。

INSERT INTO strategy_state (singleton, change_seq, current_hash)
SELECT 1, 1,
       encode(sha256(convert_to(string_agg(code || ':' || sha256, E'\n' ORDER BY injection_order, id), 'UTF8')), 'hex')
  FROM strategy_document
 WHERE code NOT IN ('copper_inventory_strategy', 'lithium_warehouse_strategy')
HAVING count(*) > 0
ON CONFLICT (singleton) DO NOTHING;
