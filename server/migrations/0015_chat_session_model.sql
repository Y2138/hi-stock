-- 0015_chat_session_model.sql（M4）：会话级模型选择
-- 每个会话固定自己的模型；现有会话继承迁移时的全局当前模型。
-- 模型删除时会话字段置空，后续发送回退到全局当前模型，不保留失效外键。

ALTER TABLE chat_session
  ADD COLUMN model_id bigint REFERENCES llm_model(id) ON DELETE SET NULL;

UPDATE chat_session
SET model_id = (
  SELECT active_model_id
  FROM llm_setting
  WHERE singleton = true
)
WHERE model_id IS NULL;

CREATE INDEX chat_session_model_id_idx ON chat_session(model_id);
