-- 0021_chat_first_agent_jobs.sql：定时 Agent 收敛为普通对话。
-- job_run/backtest_run 保存领域状态，chat_session/chat_message 保存用户可继续的对话；
-- 删除重复的 attempt/resource 投影，只保留所有对话共用的低频事件流。

ALTER TABLE job_run
  RENAME COLUMN agent_session_id TO session_id;
ALTER TABLE job_run
  RENAME CONSTRAINT job_run_agent_session_id_fkey TO job_run_session_id_fkey;
ALTER INDEX job_run_agent_session_unique
  RENAME TO job_run_session_unique;

ALTER TABLE backtest_run
  RENAME COLUMN agent_session_id TO session_id;
ALTER TABLE backtest_run
  RENAME CONSTRAINT backtest_run_agent_session_id_fkey TO backtest_run_session_id_fkey;
ALTER INDEX backtest_run_agent_session_idx
  RENAME TO backtest_run_session_idx;

DROP TABLE agent_session_attempt;
DROP TABLE agent_session_resource;

ALTER TABLE agent_session_event
  RENAME TO chat_session_event;
ALTER INDEX agent_session_event_replay_idx
  RENAME TO chat_session_event_replay_idx;

ALTER TABLE chat_session_event
  DROP COLUMN attempt_no;
ALTER TABLE chat_message
  DROP COLUMN attempt_no;
