ALTER TABLE pool_membership ADD COLUMN attention_signal jsonb;
COMMENT ON COLUMN pool_membership.attention_signal IS '当前关注信号状态与逐项缺失条件；空值代表未明确，历史临近信号允许缺口未补充';
ALTER TABLE pool_membership ADD CONSTRAINT pool_attention_signal_check CHECK (
  attention_signal IS NULL OR COALESCE((
    attention_reason IS NOT NULL
    AND jsonb_typeof(attention_signal) = 'object'
    AND attention_signal ? 'status' AND attention_signal ? 'missing_signals'
    AND attention_signal->>'status' IN ('qualified', 'approaching')
    AND jsonb_typeof(attention_signal->'missing_signals') = 'array'
    AND (attention_signal->>'status' <> 'qualified' OR attention_signal->'missing_signals' = '[]'::jsonb)
  ), false)
);

UPDATE pool_membership
   SET attention_signal = jsonb_build_object(
     'status', CASE WHEN attention_reason LIKE '每日计划·已符合：%' THEN 'qualified' ELSE 'approaching' END,
     'missing_signals', '[]'::jsonb
   )
 WHERE attention_reason LIKE '每日计划·已符合：%' OR attention_reason LIKE '每日计划·即将符合：%';
