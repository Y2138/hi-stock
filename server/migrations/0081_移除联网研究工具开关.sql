-- web_search 已完成供应商、安全、白名单、限额与脱敏边界，成为所有 Agent 会话的永久只读能力。
-- 删除不再控制任何运行时行为的预留开关，避免设置页和 API 产生错误预期。
ALTER TABLE agent_setting DROP COLUMN web_research_enabled;
