-- 盘前消息使用跨账户标的清单；正常无消息与检索缺口分别表述。
WITH current_prompt AS (
  SELECT p.id AS prompt_id,p.current_revision_id AS base_revision_id,r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id
   WHERE p.code='pre_market_news_scan'
), definition AS (
  SELECT *,replace(content,
    '先调用 `pool_context_query` 读取当前关注池标的、代码、名称和所属板块，并用 `database_query` 查询当前持仓代码清单；',
    '先调用 `pool_context_query(date=目标日)`，以返回的 `news_targets` 作为当前关注池与全部账户持仓去重后的完整检索清单（含代码、名称、持仓/关注标记与一级行业）。全局任务没有账户上下文，不调用 `database_query` 或 `portfolio_context_query` 读取持仓，也不得把未绑定账户误判为无持仓；'
  ) || $rules$

## 覆盖、状态与通知要求

- 必须逐项完成 `news_targets` 的公司名与代码检索，可按 3–5 只分组，但不得只查板块后声明已逐股覆盖。已完成检索但最近 48 小时无有效新消息的标的仍写入 `checked_codes`；未检索或搜索失败的标的不得写入。过期策略存量关注不属于本次覆盖范围，除非仍在 `news_targets` 中。
- `gaps` 只记录真实未完成的覆盖、全部替代来源仍失败的检索、影响所保留结论的事实或时间核验缺失。已检索无新消息、旧闻已剔除、无持仓、专业财经报道未获官方确认但已明确来源等级、正常抓取截止时间及非秒级实时属于正文说明，不放入 `gaps`。全部要求完成时传 `gaps:[]`；真实缺口不得隐藏。
- 国内财经网站明确采用北京时间的完整年月日时分可规范为 `+08:00`，在事实说明中注明口径；只有日期、缺少时间或无法判断时区则不得编造。无法确认时保持未知方向和低影响，影响结论的核验缺失写入缺口。
- 正文固定包含市场底盘、重点板块/标的、覆盖统计、数据缺口与来源时效说明。写入后以工具返回的 `gaps` 为准报告覆盖情况，服务端自动补充漏查标的。
- 末尾单独输出 `## 结论摘要`，用 3–5 条短句概括市场方向、最重要的消息与受影响标的、首要风险及实际覆盖缺口，不超过 600 个中文字符。不要复制全文或堆积来源链接；无有效新消息直接说明，不凑消息。部分成功的摘要仍可推送，必须明确尚缺证据，不得写成完整覆盖。
$rules$ AS updated_content FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,(SELECT max(revision_no)+1 FROM job_prompt_revision WHERE prompt_id=definition.prompt_id),
    updated_content,encode(sha256(convert_to(updated_content,'UTF8')),'hex'),'user',base_revision_id,
    '盘前消息覆盖全部账户持仓，明确真实缺口与正常说明，输出精简通知摘要'
  FROM definition RETURNING id,prompt_id
)
UPDATE job_prompt p SET current_revision_id=i.id,updated_at=now() FROM inserted i WHERE p.id=i.prompt_id;
