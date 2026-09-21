-- 0124 新增铜策略正文后前滚策略清单哈希，保持只读策略接口一致。
UPDATE strategy_state
   SET change_seq=change_seq+1,
       current_hash=encode(sha256(convert_to((
         SELECT string_agg(code || ':' || sha256,E'\n' ORDER BY injection_order,id)
           FROM strategy_document
       ),'UTF8')),'hex'),
       updated_at=now()
 WHERE singleton=1;
