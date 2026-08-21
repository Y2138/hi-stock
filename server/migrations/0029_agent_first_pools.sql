-- 0029_agent_first_pools.sql：移除自选与持久化标注，扩展短线/长线池研究属性。

ALTER TABLE pool_membership
  ADD COLUMN stock_character text CHECK (stock_character IS NULL OR length(stock_character) <= 500),
  ADD COLUMN stage text CHECK (stage IS NULL OR length(stage) <= 200),
  ADD COLUMN evaluation_summary text CHECK (evaluation_summary IS NULL OR length(evaluation_summary) <= 4000),
  ADD COLUMN primary_board_instrument_id bigint REFERENCES market_instrument(id) ON DELETE SET NULL,
  ADD COLUMN attention_reason text CHECK (attention_reason IS NULL OR length(attention_reason) <= 500),
  ADD COLUMN attention_from date,
  ADD COLUMN attention_until date,
  ADD COLUMN evaluation_session_id bigint REFERENCES chat_session(id) ON DELETE SET NULL,
  ADD CONSTRAINT pool_membership_attention_dates
    CHECK (attention_until IS NULL OR attention_from IS NULL OR attention_until >= attention_from);

-- 业务规则：同一标的任一时刻只能有一个当前策略角色，不能同时出现在短线池和长线池。
CREATE UNIQUE INDEX pool_membership_one_current_role
  ON pool_membership (instrument_id)
  WHERE effective_to IS NULL;

CREATE TABLE pool_board_preference (
  pool                text NOT NULL CHECK (pool IN ('short','long')),
  board_instrument_id bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  sort                integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pool, board_instrument_id)
);
CREATE INDEX pool_board_preference_sort ON pool_board_preference (pool, sort, board_instrument_id);

-- 不把未评估自选自动迁入策略池。存在这种数据时停止迁移，要求先由 Agent 完整评估。
DO $$
DECLARE orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count
    FROM watchlist_entry entry
   WHERE NOT EXISTS (
     SELECT 1 FROM pool_membership membership
      WHERE membership.instrument_id = entry.instrument_id
        AND membership.effective_to IS NULL
   );
  IF orphan_count > 0 THEN
    RAISE EXCEPTION '仍有 % 个未进入策略池的旧自选，必须先由 Agent 完整评估', orphan_count;
  END IF;
END $$;

DROP TABLE watchlist_group_membership;
DROP TABLE watchlist_entry;
DROP TABLE watchlist_group;

-- 辅助线改为页面内临时趋势线，不再保留服务端事实。
DROP TABLE chart_annotation;
