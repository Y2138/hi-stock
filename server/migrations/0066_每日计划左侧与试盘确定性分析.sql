-- 0066_每日计划左侧与试盘确定性分析.sql：要求每日计划完整使用服务层的左侧、试盘与唯一信号结论。

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'daily_plan_flow'
     AND prompt.status = 'active'
     AND revision.content NOT LIKE '%## 左侧反转与试盘启动完成门禁%'
), prepared AS (
  SELECT prompt_id,
         base_revision_id,
         content || $left_trial_gate$

## 左侧反转与试盘启动完成门禁

1. `daily_plan_context_query` 已按当前短线策略对短线池逐只完成右侧、左侧和试盘的机械计算，并按“右侧 > 左侧 > 试盘”归并同一标的的唯一信号；最终计划必须直接使用 `signal_selection` 和各扫描模块的 `signal` / `suppressed_by`，不得自行改变优先级。
2. 左侧反转必须报告 `left_reversal_scan` 的短线股票数、完成数、形态命中数、最终信号数和接近候选数。正式或接近候选逐只列出未通过的基础条件、反转形态、质量分、T+1 突破价/最高确认价、ATR14 和初始止损参考；不得只写“无左侧信号”。
3. 试盘启动必须报告 `trial_start_scan` 的短线股票数、完成数、形态命中数、最终信号数和接近候选数。正式或接近候选逐只列出试盘日、间隔、回调是否守住试盘低点、回调量是否低于试盘量、T日量比、是否突破试盘高点，以及环境或高优先级信号造成的抑制；不得把“未命中”写成“未核验”。
4. 任一模块 `completed_count < stock_member_count`、状态为 `partial`，或唯一信号仍为 `null` 时，必须把工具返回的逐只原因列入数据缺口，不得输出“全池已核验”或确定的路线名次。三类扫描均完整且 0 个信号是有效结论。
5. 每日计划正文固定保留“左侧反转”和“试盘启动”两个小节；没有正式候选时仍报告覆盖数、最接近候选及其缺失条件，让用户能够区分市场没有形态、形态尚未确认和数据不足。
$left_trial_gate$ AS content
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
         '每日计划逐只完成左侧反转、试盘启动及唯一信号归并'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
