-- 夜间板块任务升级为结构分类，并将板块内个股观察信号写入关注池。
WITH prompt AS (
  SELECT id AS prompt_id, current_revision_id AS base_revision_id
    FROM job_prompt
   WHERE code = 'nightly_sector_opportunity_scan'
), definition(content) AS (
  VALUES ($prompt$
# 夜间板块结构观察

目标：以任务目标日为数据截止日，依据当前最终策略扫描完整 881 一级行业，识别低位波动收缩突破、趋势中缩量回踩等结构，并将板块内少量个股观察信号写入关注池。只形成研究观察与条件预案，不交易、不改持仓、不发出买卖指令；完整结果保存到 `job_run_output`。

## 执行流程

1. 调用 `strategy_document_query` 读取当前最终策略正文，只使用本轮锁定版本。
2. 调用一次 `analysis_run`，请求必须为 `{"requests":[{"analysis_type":"sector_temperature","as_of":"目标日","lookback":120}]}`，不得传 `codes`，核对完整 881 覆盖、最新数据日与缺口。
3. 根据温度、相对 MA20 位置、1 日/5 日涨跌幅和 5 日量比粗筛 6–10 个板块，再用 `indicator_query` 复核最近 60–120 根日线的趋势、均线、波动、量价、关键失效位；不能只按单日涨幅、温度或题材主观排名。
4. 将板块分类为以下状态，允许一个板块同时有主状态和风险标签：
   - `early_breakout`：低位波动收缩后出现突破或临近突破，量能需要同步确认；
   - `pullback_observing`：趋势仍在、处于缩量回踩阶段；回踩阶段即可输出观察信号，不等待“再启动”；再启动只写为后续触发条件；
   - `strong_continuation_context`：强趋势延续，仅作为上下文，不默认当作新机会，防止追高；
   - `overheated`：强势但明显过热，降低结论强度；
   - `risk_deteriorating`：结构转弱或量价背离，原则上不产出新观察；
   - `neutral`：暂无明确结构。
   “强趋势延续”不是已验证的独立入场策略，不能作为主要机会来源。
5. 对入选或相对领先板块调用 `board_query(mode="constituents", code=板块代码, as_of=目标日)`，记录成分总数、返回数、同步截止时间和缺口。局部样本不得称为全板块最优。
6. 汇总成分，用 `market_snapshot_query` 和 `strategy_screen_query(date=目标日, rules=["short_right","short_left","trial","swing"])` 分批筛选，再对最多 20 只候选调用 `indicator_query` 与 `stock_research_query`。每个板块最多保留 2 只个股，不足时不强行凑数。
7. 个股只允许输出以下两类观察：
   - `early_breakout`：说明低位、收缩、突破/临近突破和量能确认状态；
   - `pullback_observing`：说明趋势未破坏、缩量回踩证据、尚缺条件、再启动触发位和失效位。
   强趋势、过热或转弱板块的个股默认不写入关注池，除非有清晰的独立风险或观察理由。
8. 调用 `pool_attention_write` 写入本轮全部个股观察信号。板块内个股可由服务端自动初始化到关注池，复用已有完整五维画像；不得调用 `pool_onboard` 或 `pool_write` 拼装流程。`approaching` 用于缩量回踩观察或尚未完成量能确认的突破，`missing_signals` 必须逐项写明后续确认条件；只有条件已成立才可用 `qualified`。已持仓标的不写入自动关注。没有候选时也要提交空 items，并按数据覆盖填写 `evaluation_status`。

## 结论标准

- 每个板块给出：状态、机会判断、支持证据、尚缺条件、触发条件、风险与失效条件、数据日期。
- 每只个股给出：代码与名称、所属板块、观察类型、观察理由、当前条件状态、触发条件、风险与失效条件、数据日期。
- 有数据缺口时降低结论强度并列明，不得用常识补值；不得把局部样本称为全市场结论。
- 只表达“观察机会”“满足条件后关注”或“暂不具备条件”，不得给直接买卖指令、仓位建议、确定性涨跌判断或收益承诺。

## 输出

正文使用紧凑 Markdown，约 2000 中文字符：先写市场与覆盖摘要，再按板块列出状态、观察个股和风险，最后列数据缺口。末尾单独输出 `## 结论摘要`，用 3–6 条可独立阅读的短句概括板块状态、最多 2 只个股、触发条件和首要风险；没有机会时直接说明。结论摘要不超过 600 个中文字符，供飞书消息推送。
$prompt$)
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prompt.prompt_id,
         (SELECT COALESCE(max(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing
           WHERE existing.prompt_id = prompt.prompt_id),
         definition.content,
         encode(sha256(convert_to(definition.content, 'UTF8')), 'hex'),
         'user',
         prompt.base_revision_id,
         '将夜间板块任务改为结构分类，并把板块内个股观察信号写入关注池'
    FROM prompt CROSS JOIN definition
   WHERE NOT EXISTS (
     SELECT 1
       FROM job_prompt_revision existing
      WHERE existing.prompt_id = prompt.prompt_id
        AND existing.sha256 = encode(sha256(convert_to(definition.content, 'UTF8')), 'hex')
   )
  RETURNING prompt_id, id
), selected AS (
  SELECT inserted.prompt_id, inserted.id
    FROM inserted
  UNION ALL
  SELECT prompt.prompt_id, revision.id
    FROM prompt
    JOIN definition ON true
    JOIN job_prompt_revision revision
      ON revision.prompt_id = prompt.prompt_id
     AND revision.sha256 = encode(sha256(convert_to(definition.content, 'UTF8')), 'hex')
   WHERE NOT EXISTS (SELECT 1 FROM inserted)
  LIMIT 1
)
UPDATE job_prompt prompt
   SET current_revision_id = selected.id, updated_at = now()
  FROM selected
 WHERE prompt.id = selected.prompt_id;
