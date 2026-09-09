-- 0073_每日计划波段确定性扫描.sql：每日计划独立调用波段垂类工具，不继续扩大通用上下文职责。

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'daily_plan_flow'
     AND prompt.status = 'active'
     AND revision.content NOT LIKE '%## 波段确定性扫描完成门禁%'
), prepared AS (
  SELECT prompt_id,
         base_revision_id,
         content || $swing_gate$

## 波段确定性扫描完成门禁

1. 调用 `daily_plan_context_query` 后，必须且只能调用一次 `swing_signal_query(date=目标日)`；该工具独立扫描长线池中角色为“波段”的全部当前成员，不得用 `daily_plan_context_query`、通用数据库查询或模型手算替代。
2. 最终 Markdown 固定保留“波段信号”小节，如实报告数据日、成员数、完成数、四条件命中数、可执行新信号数、已有持仓抑制数、接近候选数和逐只缺口。完整扫描后 0 个信号是有效结论，必须明确写“当日无新增波段信号”。
3. 四条件、40 日箱顶、20 日箱底、护盘收回率、初始止损、预期盈亏比、T+1 突破价和确认价上限全部使用工具返回值。`signals` 才是可执行新信号；四条件命中但已持仓或确认价窗口不可用的标的不得作为新增信号。
4. `signals` 中的标的写入本轮 `pool_attention_write` 完整集合并标记“已符合”；未持仓且恰有一个四条件未通过的 `near_candidates` 标记“即将符合”，注明唯一失败条件和最早复核日。不得自动补仓，不得把波段信号改写成短线左侧信号。
5. `status=partial`、`completed_count<member_count` 或存在 `gaps` 时，逐只列入数据缺口，不得声称波段全池已核验；调用 `pool_attention_write` 时必须把短线、波段全部应保留项合并为同一个完整集合，不能因分工具扫描而互相清除。
$swing_gate$ AS content
    FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prepared.prompt_id,
         (SELECT COALESCE(max(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = prepared.prompt_id),
         prepared.content,
         encode(sha256(convert_to(prepared.content, 'UTF8')), 'hex'),
         'user',
         prepared.base_revision_id,
         '每日计划独立完成波段四条件、执行窗口和接近候选扫描'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
