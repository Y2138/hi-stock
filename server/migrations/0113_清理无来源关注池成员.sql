-- 0113_清理无来源关注池成员.sql：关注池只保留具有当前有效来源的标的。
-- 来源以 pool_attention_entry 为准；来源已过期或从未建立来源的成员及其历史池记录一并删除。

DELETE FROM pool_membership membership
 WHERE NOT EXISTS (
   SELECT 1
     FROM pool_attention_entry attention
    WHERE attention.instrument_id = membership.instrument_id
      AND attention.valid_from <= CURRENT_DATE
      AND (attention.valid_until IS NULL OR attention.valid_until >= CURRENT_DATE)
 );
