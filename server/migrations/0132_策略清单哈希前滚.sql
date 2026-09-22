-- 0132_策略清单哈希前滚.sql：0131 更新波段正文后同步当前策略清单哈希。
UPDATE strategy_state
   SET change_seq=change_seq+1,
       current_hash=encode(sha256(convert_to((
         SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id)
           FROM strategy_document
          WHERE code NOT IN ('copper_inventory_strategy','lithium_warehouse_strategy')
       ),'UTF8')),'hex'),
       updated_at=now()
 WHERE singleton=1;
