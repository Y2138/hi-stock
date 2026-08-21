-- 0018_agent_context_compaction.sql（M4）：Agent 会话上下文压缩检查点。
-- chat_message 原始事件永久保留；这里只记录模型可见历史的摘要替换边界。

ALTER TABLE chat_session
  ADD COLUMN context_summary text,
  ADD COLUMN context_summary_through_seq int NOT NULL DEFAULT 0
    CHECK (context_summary_through_seq >= 0),
  ADD COLUMN context_summary_estimated_tokens int NOT NULL DEFAULT 0
    CHECK (context_summary_estimated_tokens >= 0),
  ADD COLUMN context_compacted_at timestamptz,
  ADD CONSTRAINT chat_session_context_summary_boundary
    CHECK (
      (context_summary IS NULL AND context_summary_through_seq = 0)
      OR (context_summary IS NOT NULL AND context_summary_through_seq > 0)
    );

-- 用户可真正中断运行中的任务 Agent；取消是终态，不进入自动重试。
ALTER TABLE job_run
  DROP CONSTRAINT job_run_status_check,
  ADD CONSTRAINT job_run_status_check
    CHECK (status IN ('queued','running','success','failed','partial','missed','cancelled'));
