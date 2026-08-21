-- 0011_content_classification.sql（M3.5）：纠正 0008 从旧 strategy_doc 泛化迁入的内容分类。
-- 历史正文和版本不删除；标的池已是 pool_* 结构化事实，任务模板已是 job_prompt* 事实。

UPDATE content_document
   SET content_type = 'guidance', updated_at = now()
 WHERE legacy_path IN (
   '股性分析.md',
   '关键位分析指引.md',
   '临时决策接入评估.md',
   '预期校对.md',
   '数据获取规范.md'
 );

UPDATE content_document
   SET content_type = 'archive',
       status = 'archived',
       title = CASE legacy_path
         WHEN '短线/标的池.md' THEN '短线标的池（结构化事实源已迁移）'
         WHEN '长线/标的池.md' THEN '长线标的池（结构化事实源已迁移）'
         ELSE title || '（已迁移至作业提示词）'
       END,
       updated_at = now()
 WHERE legacy_path IN (
   '短线/标的池.md',
   '长线/标的池.md',
   '定时任务/每日交易计划.md',
   '定时任务/周中短线检查.md',
   '定时任务/每周评分.md'
 );
