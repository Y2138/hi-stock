-- 旧库存仓位和碳酸锂任务不再作为当前能力；保留受外键约束的私有运行历史。
UPDATE job_definition SET enabled=false,
       purpose='历史归档：旧商品仓位策略已移除，不可再次执行。'
 WHERE code IN ('copper_inventory_signal_review','lithium_warehouse_signal_review','commodity_lithium_warehouse_sync');
UPDATE job_prompt SET status='archived',updated_at=now()
 WHERE code IN ('copper_inventory_signal_review','lithium_warehouse_signal_review');
UPDATE strategy_definition SET status='retired',allow_new_entry=false,daily_plan_scope='{}'::text[],
       attention_policy='none',updated_at=now()
 WHERE code IN ('copper_inventory','lithium_warehouse');
-- 当前策略目录与固定资产不再携带旧策略正文；旧行仅维持历史外键完整性。
UPDATE strategy_state
   SET change_seq=change_seq+1,
       current_hash=encode(sha256(convert_to((
         SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id)
         FROM strategy_document
         WHERE code NOT IN ('copper_inventory_strategy','lithium_warehouse_strategy')
       ),'UTF8')),'hex'),updated_at=now()
 WHERE singleton=1;
