ALTER TABLE pool_membership
  ADD COLUMN management_mode text NOT NULL DEFAULT 'manual' CHECK (management_mode IN ('manual','strategy')),
  ADD COLUMN exit_reason text;
COMMENT ON COLUMN pool_membership.management_mode IS 'manual=人工管理保留；strategy=由策略信号管理，无有效来源后自动退出';
COMMENT ON COLUMN pool_membership.exit_reason IS '成员退出关注池的原因，保留历史记录';

-- 仅识别带旧版明确自动入池标记、且无人工作业归因或人工保留的成员。
UPDATE pool_membership membership SET management_mode='strategy'
 WHERE membership.tags @> '["策略自动关注"]'::jsonb
   AND membership.note='由策略信号自动入池并采用最新五维画像'
   AND membership.evaluation_session_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM pool_attention_entry entry
                    WHERE entry.instrument_id=membership.instrument_id AND entry.source_type='manual');

-- 旧信号不再无限有效，原有明确期限保持不变；日历不足时只认可原数据日。
UPDATE pool_attention_entry entry
   SET valid_until=GREATEST(valid_from,COALESCE(
     (SELECT min(trade_date) FROM market_trading_day
       WHERE is_open AND trade_date>COALESCE(entry.data_date,entry.valid_from)),
     entry.data_date,entry.valid_from))
 WHERE source_type='strategy' AND valid_until IS NULL;

WITH current_prompt AS (
  SELECT p.id AS prompt_id,p.current_revision_id AS base_revision_id,p.code,r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id
   WHERE p.code IN ('value_anchor_opportunity_scan','two_year_reversal_scan','nightly_sector_opportunity_scan')
), revised AS (
  SELECT *, CASE WHEN code='nightly_sector_opportunity_scan' THEN content || $nightly$

## 存量关注复核

先调用 `pool_context_query` 取全本策略存量关注，逐项复核，不限于昨天或本轮新入选板块。通过研究与行情工具优先补齐缺数；可调用 `fetch_hithink_data` 获取明确缺失的数据。新发现与旧信号均按本策略当前条件评估，不自创统一评分。
调用 `pool_attention_write` 时提供目标日 `data_date`，`reviewed_codes` 是实际完成复核的全部代码，包含明确不满足条件的旧标的；`review_gaps` 逐项记录未完成复核的代码与具体缺口。存在缺口或未覆盖条目必须使用 `partial`，不可只因未入选候选清单而删除。缺数据时不更新旧信号有效期；`clear` 只用于明确失效，`mark` 必须有当前数据证据。服务端会限制关注有效期并清理无有效来源的自动成员，人工关注与其他策略来源独立保留。报告列明新增、更新、退出和待补数据。
$nightly$ ELSE $deterministic$
# 策略机会扫描与存量关注复核

1. 调用 `strategy_document_query` 读取本任务绑定策略正文与投资总策略，遵守其条件、范围和风险约束。
2. 必须调用 `strategy_evaluation_query(date=目标日, phase="entry")`。服务端统一发现新机会、复核本策略全部存量信号并维护关注池。专用只读扫描工具可辅助研究，但不能替代该步骤；不得自行调用 `pool_attention_write` 重写结构化扫描结果。
3. 按工具返回的正式信号、接近候选、`attention_changes`、`review_gaps` 与运行缺口撰写结论。缺数据不得推测失败或给旧信号续期；列出具体缺口供优先补齐。运行未完成或数据滞后时明确标记待复核，不把旧结论作为今日有效信号。
4. 每条接近信号说明当前值、策略阈值、尚缺条件；说明存量信号的保留、降级、退出原因。不直接操作持仓，不发布策略或执行交易。
5. 输出 Markdown 报告，开头为 `> AI 生成任务结果，已关联本次任务保存；不代表策略发布或交易执行。`，结尾 `## 结论摘要` 不超过 600 个中文字符，包含本轮结论、关注变化和数据缺口。无机会时明确说明，不填充候选。
$deterministic$ END AS revised_content FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,(SELECT max(revision_no)+1 FROM job_prompt_revision WHERE prompt_id=revised.prompt_id),
         revised_content,encode(sha256(convert_to(revised_content,'UTF8')),'hex'),'user',base_revision_id,'策略任务统一复核存量关注并清理失效信号'
    FROM revised RETURNING id,prompt_id
)
UPDATE job_prompt p SET current_revision_id=i.id,updated_at=now() FROM inserted i WHERE p.id=i.prompt_id;
