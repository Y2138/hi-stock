-- 0032_agent_flow_market_references.sql：为三个分析型 Agent 流程补充可选市场结构参考数据。

WITH additions(code, content) AS (
  VALUES
  ('daily_plan_flow', $daily$

## 可参考的市场结构数据

按本次计划需要，可参考 `market_board` / `market_board_membership` 的板块目录、成分与历史有效期，`market_limit_event` 的涨停、跌停和炸板事件，`market_limit_ladder_snapshot` 的连板天梯，以及 `market_dragon_tiger_entry` 的龙虎榜数据。使用前核对 `market_catalog_sync`、`board_membership_sync`、`daily_market_structure` 对应 `job_run` 的最近终态和目标日期。这些数据用于补充市场、板块、情绪与个股证据，不是任务成功的强制前置条件；上游暂停、失败或数据缺失时列明缺口与影响，不得用旧值伪装最新值或猜测补齐。
$daily$),
  ('midweek_check', $midweek$

## 可参考的市场结构数据

按本次检查需要，可参考 `market_board` / `market_board_membership` 的板块目录、成分与历史有效期，`market_limit_event` 的涨停、跌停和炸板事件，`market_limit_ladder_snapshot` 的连板天梯，以及 `market_dragon_tiger_entry` 的龙虎榜数据。使用前核对 `market_catalog_sync`、`board_membership_sync`、`daily_market_structure` 对应 `job_run` 的最近终态和目标日期。这些数据用于补充板块切换、市场情绪和短线标的证据，不是任务成功的强制前置条件；上游暂停、失败或数据缺失时列明缺口与影响，不得用旧值伪装最新值或猜测补齐。
$midweek$),
  ('weekly_review', $weekly$

## 可参考的市场结构数据

按本次复核需要，可参考 `market_board` / `market_board_membership` 的板块目录、成分与历史有效期，`market_limit_event` 的涨停、跌停和炸板事件，`market_limit_ladder_snapshot` 的连板天梯，以及 `market_dragon_tiger_entry` 的龙虎榜数据。使用前核对 `market_catalog_sync`、`board_membership_sync`、`daily_market_structure` 对应 `job_run` 的最近终态和目标日期。这些数据用于补充板块、市场情绪和研究评分证据，不是任务成功的强制前置条件；上游暂停、失败或数据缺失时列明缺口与影响，不得用旧值伪装最新值或猜测补齐。
$weekly$)
), prepared AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content || additions.content AS content
    FROM additions
    JOIN job_prompt prompt ON prompt.code = additions.code
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.status = 'active'
     AND revision.content NOT LIKE '%## 可参考的市场结构数据%'
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prepared.prompt_id,
         (SELECT COALESCE(MAX(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = prepared.prompt_id),
         prepared.content,
         encode(sha256(convert_to(prepared.content, 'UTF8')), 'hex'),
         'user',
         prepared.base_revision_id,
         '补充板块、涨跌停与炸板、连板天梯、龙虎榜参考数据及上游缺口边界'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
