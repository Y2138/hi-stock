-- 0038_official_industry_pool.sql：标的池只使用同花顺官方行业关系，移除旧主板块与本地板块标签。

DELETE FROM pool_board_preference preference
USING market_board board
WHERE board.instrument_id = preference.board_instrument_id
  AND (board.source <> 'hithink' OR board.board_type <> 'industry');

DELETE FROM market_board_membership membership
USING market_board board
WHERE board.instrument_id = membership.board_instrument_id
  AND (board.source <> 'hithink' OR board.board_type <> 'industry');

UPDATE pool_membership membership
SET tags = COALESCE((
  SELECT jsonb_agg(tag ORDER BY ordinal)
  FROM jsonb_array_elements_text(membership.tags) WITH ORDINALITY AS item(tag, ordinal)
  WHERE tag NOT LIKE '板块：%'
), '[]'::jsonb)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements_text(membership.tags) tag
  WHERE tag LIKE '板块：%'
);

ALTER TABLE pool_membership DROP COLUMN primary_board_instrument_id;
