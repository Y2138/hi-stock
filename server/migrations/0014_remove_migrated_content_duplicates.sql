-- 0014_remove_migrated_content_duplicates.sql：删除已迁移到结构化领域的内容库副本。
-- 这些业务事实分别由 pool_*、portfolio_* 与 job_prompt* 维护，内容库不再保留第二份正文。

CREATE TEMP TABLE migrated_content_path (legacy_path text PRIMARY KEY) ON COMMIT DROP;

INSERT INTO migrated_content_path (legacy_path) VALUES
  ('短线/标的池.md'),
  ('长线/标的池.md'),
  ('定时任务/每日交易计划.md'),
  ('定时任务/周中短线检查.md'),
  ('定时任务/每周评分.md'),
  ('支撑/归档/持仓流水/2026年07月.md'),
  ('支撑/归档/持仓流水/2026年08月.md');

DELETE FROM content_legacy_import
 WHERE source_path IN (SELECT legacy_path FROM migrated_content_path);

UPDATE content_document
   SET current_revision_id = NULL
 WHERE legacy_path IN (SELECT legacy_path FROM migrated_content_path);

DELETE FROM content_revision
 WHERE document_id IN (
   SELECT id FROM content_document
    WHERE legacy_path IN (SELECT legacy_path FROM migrated_content_path)
 );

DELETE FROM content_document
 WHERE legacy_path IN (SELECT legacy_path FROM migrated_content_path);
