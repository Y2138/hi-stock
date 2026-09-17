-- 0103_暂停碳酸锂仓单周度评估.sql：短样本不再形成周度Agent研究结论；保留每日仓单同步积累未来数据。
UPDATE job_definition
   SET enabled=false, updated_at=now()
 WHERE code='lithium_warehouse_signal_review';
