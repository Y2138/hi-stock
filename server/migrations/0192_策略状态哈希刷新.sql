-- 0191 只更新了 copper_left_launch_strategy 正文与 sha256，未刷新 strategy_state.current_hash，
-- 导致 2026-11-10 17:25 起盘后 agent_flow 任务在策略清单校验处失败。
-- 按 0160/0186 既有口径重算当前策略清单哈希（排除已退役的 copper_inventory / lithium_warehouse）并递增变更序号。

UPDATE strategy_state SET change_seq=change_seq+1,
 current_hash=encode(sha256(convert_to((SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id) FROM strategy_document WHERE code NOT IN ('copper_inventory_strategy','lithium_warehouse_strategy')),'UTF8')),'hex'),
 updated_at=now() WHERE singleton=1;
