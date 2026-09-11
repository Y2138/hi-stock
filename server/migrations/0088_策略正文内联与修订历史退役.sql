-- 0088_策略正文内联与修订历史退役.sql：策略域只保留当前最终正文。
-- 精简目标：系统不再保存、也不再重建历史策略正文；发布序号与集合哈希只作为运行归因标签保留。
-- 迁移步骤：正文内联 → 评分基准改挂策略文档 → 会话取消历史策略固化 → 删除修订表和遗留导入指针 → 重算集合哈希。

-- 1) 把当前修订正文内联到 strategy_document，作为唯一保留的策略内容。
ALTER TABLE strategy_document ADD COLUMN content text;
ALTER TABLE strategy_document ADD COLUMN sha256 text;

UPDATE strategy_document document
   SET content = revision.content,
       sha256 = revision.sha256
  FROM strategy_document_revision revision
 WHERE revision.id = document.current_revision_id;

-- 未挂当前正文的占位文档没有可执行内容；它们此前也无法被读取。
DELETE FROM strategy_document WHERE sha256 IS NULL;

ALTER TABLE strategy_document
  ALTER COLUMN content SET NOT NULL,
  ALTER COLUMN sha256 SET NOT NULL,
  ADD CONSTRAINT strategy_document_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN strategy_document.content IS '当前最终策略正文';
COMMENT ON COLUMN strategy_document.sha256 IS '当前策略正文 SHA-256';

-- 2) 评分基准改为绑定策略文档；同一文档只保留最新一份基准。
ALTER TABLE strategy_score_benchmark DROP CONSTRAINT strategy_score_benchmark_document_revision_id_fkey;
ALTER TABLE strategy_score_benchmark DROP CONSTRAINT strategy_score_benchmark_document_revision_id_key;
ALTER TABLE strategy_score_benchmark RENAME COLUMN document_revision_id TO document_id;

UPDATE strategy_score_benchmark benchmark
   SET document_id = revision.document_id
  FROM strategy_document_revision revision
 WHERE revision.id = benchmark.document_id;

DELETE FROM strategy_score_benchmark benchmark
 WHERE EXISTS (
   SELECT 1
     FROM strategy_score_benchmark newer
    WHERE newer.document_id = benchmark.document_id
      AND newer.id > benchmark.id
 );

ALTER TABLE strategy_score_benchmark
  ADD CONSTRAINT strategy_score_benchmark_document_id_fkey
  FOREIGN KEY (document_id) REFERENCES strategy_document(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX strategy_score_benchmark_document_unique ON strategy_score_benchmark (document_id);

COMMENT ON COLUMN strategy_score_benchmark.document_id IS '关联策略文档标识';

-- 3) 会话不再固化历史策略；任务与对话始终读取当前策略。
ALTER TABLE chat_session DROP COLUMN strategy_state_revision;
ALTER TABLE chat_session DROP COLUMN strategy_state_sha256;

-- 4) 退役修订表、修订指针与遗留内容导入指针。
ALTER TABLE strategy_document DROP CONSTRAINT strategy_document_current_revision_fk;
ALTER TABLE strategy_document DROP COLUMN current_revision_id;
ALTER TABLE strategy_document DROP COLUMN legacy_content_document_id;
DROP TABLE strategy_document_revision;

-- 5) 按内联正文重算策略集合哈希，口径与运行时 calculateStrategyHash 一致。
UPDATE strategy_state
   SET current_hash = manifest.hash,
       updated_at = now()
  FROM (
    SELECT encode(sha256(convert_to(string_agg(document.code || ':' || document.sha256, E'\n'
             ORDER BY document.injection_order, document.id), 'UTF8')), 'hex') AS hash
      FROM strategy_document document
  ) manifest
 WHERE strategy_state.singleton = 1;
