-- 0151_补齐持仓股性止损档位.sql：把已计算的护盘收回率固化为每日计划可识别的止损标签。
UPDATE market_stock_character_metric
   SET tags = CASE
                WHEN defense_recovery_ma10 >= 0.5 AND NOT (tags @> '["止损：买入价×0.90"]'::jsonb)
                  THEN tags || '["止损：买入价×0.90"]'::jsonb
                WHEN defense_recovery_ma10 < 0.5 AND NOT (tags @> '["止损：买入价×0.93"]'::jsonb)
                  THEN tags || '["止损：买入价×0.93"]'::jsonb
                ELSE tags
              END
 WHERE defense_recovery_ma10 IS NOT NULL;

COMMENT ON COLUMN market_stock_character_metric.tags IS '由五维画像确定性生成的标签数组，包含护盘收回率对应的止损档位标签。';
