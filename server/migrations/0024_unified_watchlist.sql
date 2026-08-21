-- 0024_unified_watchlist.sql：自选主关系与自定义分组关系拆分。
-- 同一标的只保留一个 entry；删除分组只删除 membership。

CREATE TABLE watchlist_entry (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id bigint NOT NULL UNIQUE REFERENCES market_instrument(id) ON DELETE CASCADE,
  focused       boolean NOT NULL DEFAULT false,
  note          text CHECK (note IS NULL OR length(note) <= 2000),
  sort          integer NOT NULL DEFAULT 0,
  added_at      timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE watchlist_group_membership (
  group_id  bigint NOT NULL REFERENCES watchlist_group(id) ON DELETE CASCADE,
  entry_id  bigint NOT NULL REFERENCES watchlist_entry(id) ON DELETE CASCADE,
  sort      integer NOT NULL DEFAULT 0,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, entry_id)
);
CREATE INDEX watchlist_group_membership_entry ON watchlist_group_membership (entry_id);

INSERT INTO watchlist_entry (instrument_id, sort, added_at, updated_at)
SELECT instrument_id, min(sort), min(added_at), now()
  FROM watchlist_item
 GROUP BY instrument_id;

INSERT INTO watchlist_group_membership (group_id, entry_id, sort, added_at)
SELECT old.group_id, entry.id, old.sort, old.added_at
  FROM watchlist_item old
  JOIN watchlist_entry entry ON entry.instrument_id = old.instrument_id;

DO $$
DECLARE
  old_instruments bigint;
  old_relations bigint;
  new_entries bigint;
  new_relations bigint;
BEGIN
  SELECT count(DISTINCT instrument_id), count(*)
    INTO old_instruments, old_relations
    FROM watchlist_item;
  SELECT count(*) INTO new_entries FROM watchlist_entry;
  SELECT count(*) INTO new_relations FROM watchlist_group_membership;
  IF old_instruments <> new_entries OR old_relations <> new_relations THEN
    RAISE EXCEPTION '统一自选迁移对账失败：旧标的 % / 新条目 %，旧关系 % / 新关系 %',
      old_instruments, new_entries, old_relations, new_relations;
  END IF;
END $$;

DROP TABLE watchlist_item;

