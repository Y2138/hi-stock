-- 0044_daily_plan_market_opportunities.sql：每日计划固定检查市场结构，并从涨停与龙虎榜发现池外短线候选。

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'daily_plan_flow'
     AND prompt.status = 'active'
     AND revision.content NOT LIKE '%## 市场结构与池外短线机会%'
), prepared AS (
  SELECT prompt_id,
         base_revision_id,
         replace(
           replace(
             replace(
               content,
               '## 可参考的市场结构数据',
               '## 市场结构数据边界'
             ),
             '按本次计划需要，可参考 ',
             '可使用 '
           ),
           '这些数据用于补充市场、板块、情绪与个股证据，不是任务成功的强制前置条件；',
           '这些数据用于市场、板块、情绪与个股证据；检查为必做项，但上游数据成功不是其他计划内容的强制前置条件；'
         ) || $market_opportunities$

## 市场结构与池外短线机会

每次计划都必须完成以下检查；市场结构数据缺失不阻断其他计划内容，但必须明确标为数据缺口，不得省略本节或沿用旧日结论。

1. 先核对 `daily_market_structure` 的启停状态、目标日之前最近终态，以及 `market_special_sync_run` 七类数据集的日期、状态、完成页数、行数和缺口。非交易日使用不晚于目标日的最近一个已同步交易日，并明确实际数据日。
2. 使用最近两个可比交易日的 `market_limit_event`、最新 `market_limit_ladder_snapshot` 和 `market_dragon_tiger_entry` 判断涨停/跌停/炸板数量、连板高度、行业或原因聚集、机构与游资净额及其变化，输出市场情绪、主导方向、分歧和风险，不得只复述名单。
3. 短线候选集合不得局限于当前短线池：同时检查最近数据日全部涨停标的和龙虎榜标的，并与当前 `pool_membership`、真实 `portfolio_position` 交叉标记为短线池内、其他池、持仓或池外。
4. 单独输出“市场结构池外机会”，最多 10 只，优先保留涨停与龙虎榜重合、机构或游资净流入、连板/板块聚集得到多重证据的标的。逐只列出信号来源、市场结构证据、可用行情与指标、符合的策略条件、尚缺条件、失效条件和主要风险；涨停或上榜本身不得等同于买入条件。
5. 池外标的行情或指标不足时只能列为待验证候选，不得给出伪精确执行位。不得调用 `pool_attention_write` 处理池外标的，也不得自动加入标的池或改变策略角色；需要入池时只提出待用户确认的建议。
6. 没有合格池外候选时明确写“无”，并说明是没有通过筛选还是数据不可用。最终 Markdown 必须分别保留“市场结构判断”“短线池内预期”“市场结构池外机会”三个小节。
$market_opportunities$ AS content
    FROM current_prompt
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
         '每日计划固定检测市场结构并发现涨停、龙虎榜池外短线候选'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;
