-- 0104_重新启用碳酸锂仓单周度评估.sql：保留短样本研究边界，恢复每周Agent评估。
UPDATE job_definition
   SET enabled=true, updated_at=now()
 WHERE code='lithium_warehouse_signal_review';
