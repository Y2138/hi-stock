-- 任务级模型绑定与夜间板块机会筛选。

ALTER TABLE job_definition
  ADD COLUMN model_id bigint REFERENCES llm_model(id) ON DELETE SET NULL;

COMMENT ON COLUMN job_definition.model_id IS 'Agent 任务固定模型；为空时创建运行会话时跟随系统当前模型';

INSERT INTO llm_model (
  provider_id, model_key, name, input_modalities, reasoning, context_window, max_tokens
)
SELECT provider.id, 'deepseek-v4-pro', 'DeepSeek V4 Pro', '["text"]'::jsonb, true, 1000000, 128000
  FROM llm_provider provider
 WHERE provider.provider_key = 'deepseek'
ON CONFLICT (provider_id, model_key) DO NOTHING;

INSERT INTO job_prompt (code, name, status)
VALUES ('nightly_sector_opportunity_scan', '夜间板块机会筛选', 'active')
ON CONFLICT (code) DO NOTHING;

WITH prompt AS (
  SELECT id AS prompt_id, current_revision_id AS base_revision_id
    FROM job_prompt
   WHERE code = 'nightly_sector_opportunity_scan'
), definition(content) AS (
  VALUES ($prompt$
# 夜间板块机会筛选

目标：以任务目标日为数据截止日，依据当前最终策略扫描完整 881 一级行业，找出处于变盘节点或具备可验证入手机会的 1–3 个板块，并从中筛选少量优质标的。只形成研究观察与条件预案，不交易、不改持仓、不入池、不修改关注或策略；完整结果由系统保存到 `job_run_output`。

## 执行流程

1. 调用 `strategy_document_query`，一次读取系统提示词中与短线、波段、试盘、打板相关的当前策略文档，至少包含 `limit_up_board`。只使用本轮锁定版本，不用记忆或历史任务替代。
2. 调用一次 `analysis_run`，请求必须为 `{"requests":[{"analysis_type":"sector_temperature","as_of":"目标日","lookback":120}]}`，不得传 `codes`，确保扫描完整 881 一级行业。核对市场状态、请求/可用板块数、最新数据日和缺口。
3. 根据板块温度、相对 MA20 位置、1 日/5 日涨跌幅和 5 日量比，粗筛 6–10 个相对领先或临近方向选择的板块。不能只按单日涨幅、温度或主观题材强行排名。
4. 用 `indicator_query` 分批复核粗筛板块最近 60–120 根日线的趋势、均线、MACD、RSI14、量价和关键失效位；每批不超过 20 个代码。最终选出 1–3 个证据最完整的板块，不足 1 个时明确“暂无符合条件机会”，但仍复核最多 3 个相对领先候选并说明尚缺条件。
5. 对每个入选或相对领先板块调用 `board_query(mode="constituents", code=板块代码, as_of=目标日)`，记录成分总数、返回数、同步截止时间和缺口。局部样本不得称为全板块最优。
6. 汇总上述成分，用 `market_snapshot_query` 读取最新日线快照，并用 `strategy_screen_query(date=目标日, rules=["short_right","short_left","trial","swing"])` 分批粗筛，每批最多 50 只。根据趋势、相对强度、成交活跃度、策略条件和数据完整性缩小到最多 20 只候选。
7. 对最多 20 只候选调用 `indicator_query` 和 `stock_research_query`，复核技术结构、股性阶段、财务估值日期与缺口。每个板块最多保留 2 只标的；不得把低估值、单一指标或短线评分直接当作买入结论。
8. `market_event_query` 仅在目标日相关数据集可用时，辅助核对涨停、连板、炸板或龙虎榜结构；缺失只列为增强证据缺口，不阻断任务，也不得用旧日期数据冒充目标日。

## 结论标准

- 板块必须同时给出：当前状态、进入机会判断、支持证据、尚缺条件、触发条件、风险与失效条件。
- 标的必须给出：代码与名称、所属板块、关注理由、策略条件状态、触发条件、风险与失效条件、数据日期；没有合格标的时明确写“板块可观察，暂无合格标的”。
- 只表达“观察机会”“满足条件后关注”或“暂不具备条件”，不得给直接买卖指令、仓位建议、确定性涨跌判断或收益承诺。
- 有数据缺口时降低结论强度并列明，不得用常识补值。板块和标的都不强行凑数。

## 输出

正文使用紧凑 Markdown，控制在约 2000 中文字符内：先写市场与覆盖摘要，再按板块列出机会预案和标的，最后列数据缺口。末尾必须单独输出 `## 结论摘要`，用 3–6 条可独立阅读的短句概括 1–3 个板块、每板块最多 2 只标的、触发条件和首要风险；没有机会时直接说明。结论摘要不超过 600 个中文字符，供飞书消息推送。
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
         '新增完整 881 一级行业夜间扫描、板块与标的复核及短摘要输出'
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

INSERT INTO job_definition (code, name, cron, job_type, config, prompt_id, model_id, enabled)
SELECT 'nightly_sector_opportunity_scan',
       '夜间板块机会筛选',
       '0 21 * * 1-5',
       'agent_flow',
       '{}'::jsonb,
       prompt.id,
       model.id,
       true
  FROM job_prompt prompt
  JOIN llm_provider provider ON provider.provider_key = 'deepseek'
  JOIN llm_model model ON model.provider_id = provider.id AND model.model_key = 'deepseek-v4-pro'
 WHERE prompt.code = 'nightly_sector_opportunity_scan'
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name,
      cron = EXCLUDED.cron,
      job_type = EXCLUDED.job_type,
      config = EXCLUDED.config,
      prompt_id = EXCLUDED.prompt_id,
      model_id = EXCLUDED.model_id,
      enabled = EXCLUDED.enabled,
      updated_at = now();
