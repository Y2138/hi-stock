-- 市场整体偏向与逐条消息方向分开，历史快照保留原判断。
ALTER TABLE market_news_snapshot DROP CONSTRAINT market_news_snapshot_market_bias_check;
ALTER TABLE market_news_snapshot ADD CONSTRAINT market_news_snapshot_market_bias_check
  CHECK (market_bias IN ('positive','neutral','negative','mixed','unknown','mixed_positive','mixed_negative'));
COMMENT ON COLUMN market_news_snapshot.market_bias IS '当天A股整体消息面加权偏向：mixed_positive 为 mixed 偏多，mixed_negative 为 mixed 偏空；unknown 为证据不足，旧枚举仅保留历史快照兼容。';

WITH current_prompt AS (
  SELECT p.id AS prompt_id,p.current_revision_id AS base_revision_id,r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id
   WHERE p.code='pre_market_news_scan'
), definition AS (
  SELECT *, content || $bias$

## 当天行情整体偏向（最终判断）

消息探查完成后，必须对目标日 A 股整体行情形成一个消息面预估。有利多也有利空是正常情况，不能仅以“多空并存”“mixed”“分化”结束判断。最终方向只选 `mixed 偏多` 或 `mixed 偏空`；这是整体偏向，不要求所有板块同向，不预测涨跌幅或点位。

1. 先区分全市场系统性消息、重要权重/主导板块消息与单公司局部消息。货币流动性、重大政策、监管、海外风险偏好和关键商品冲击的权重，取决于其对当天 A 股资金与盈利预期的实际传导；池内个股利好不能直接代表全市场偏多。
2. 对主要利多、利空比较：重要程度及意外性、影响强度和覆盖范围、当天兑现的时效与持续性、来源可信度、市场是否已提前反映。同一事件的转载只计一次，不按消息条数简单投票，不编造量化权重或置信概率。已消化的旧信息、时间未核验和低可信转述降权。
3. 判断哪一侧更可能主导当天开盘及日内风险偏好。即使两侧接近，也在有效证据范围内给出较弱的倾向，在正文说明最关键的主导因素、反向因素及足以使判断翻转的条件；不因正常分歧机械写数据缺口。
4. `pool_news_write.market_bias` 写 `mixed_positive`（mixed 偏多）或 `mixed_negative`（mixed 偏空）。仅全部证据不可用、无有效新消息或重要核验缺失导致无法形成方向时写 `unknown`，正文说明“证据不足”及原因，禁止凭空选边。单条消息 `direction` 沿用其独立方向，不受整体偏向强行改变。
5. 正文以 `## 当天行情整体预估` 收束综合判断，结论行固定为 `mixed 偏多` 或 `mixed 偏空`，依据与翻转条件在该行前说明。随后保留 `## 结论摘要`：首行只写同一方向，后续用短句说明主导因素、最大反向风险及实际覆盖缺口，总计不超过 600 个中文字符，供飞书推送。结构化字段、正文结论与摘要必须一致。证据不足时三处一致标明证据不足。

时间口径：盘前预估对应目标日尚未开盘的交易时段；开盘后手动运行只能判断采集时点之后的当日剩余时段，明确标注时点，不把已发生行情当作盘前预测。休市日只输出下一交易日的暂定偏向并注明对应日期，开盘前须用新消息重新判断。
$bias$ AS updated_content FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,(SELECT max(revision_no)+1 FROM job_prompt_revision WHERE prompt_id=definition.prompt_id),
    updated_content,encode(sha256(convert_to(updated_content,'UTF8')),'hex'),'user',base_revision_id,
    '按消息重要性与影响力形成当天行情整体偏向，结论和飞书摘要明确偏多或偏空'
  FROM definition RETURNING id,prompt_id
)
UPDATE job_prompt p SET current_revision_id=i.id,updated_at=now() FROM inserted i WHERE p.id=i.prompt_id;
