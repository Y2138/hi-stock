-- 为复核任务提供存量集合与受控行情补齐入口，不新增独立清理任务。
WITH current_prompt AS (
  SELECT p.id AS prompt_id,p.current_revision_id AS base_revision_id,p.code,r.content
    FROM job_prompt p JOIN job_prompt_revision r ON r.id=p.current_revision_id
   WHERE p.code IN ('swing_signal_scan','copper_left_launch_signal_scan','value_anchor_opportunity_scan',
                    'two_year_reversal_scan','nightly_sector_opportunity_scan')
), revised AS (
  SELECT *, replace(content,'可调用 `fetch_hithink_data` 获取明确缺失的数据。',
    '行情及财务缺口用 `fetch_market_data` 补齐；扶摇扩展研究数据用 `fetch_hithink_data`。') ||
    CASE WHEN code='nightly_sector_opportunity_scan' THEN $nightly$

复核范围取 `pool_context_query` 返回的 `strategy_attentions`，按 `strategy_code=nightly_sector` 过滤，包含已过期条目；不要只看当前展示的 members。没有相关存量时仍正常发现新机会。
$nightly$ ELSE $review$

## 复核数据补齐

首次结构化评估后优先处理本策略存量关注的 `review_gaps` 和运行缺口。可通过 `fetch_market_data` 批量补齐明确缺失的行情、财务或估值，只请求缺失标的和必要日期，不扩大到全市场。补齐后再调用一次目标日 `strategy_evaluation_query` 完成复核；仍缺数时保留具体原因，不反复重试，不自行推断指标或策略条件。关注有效期属于信息新鲜度规则，不能作为延长买入窗口的依据。
$review$ END AS revised_content FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision(prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,(SELECT max(revision_no)+1 FROM job_prompt_revision WHERE prompt_id=revised.prompt_id),
         revised_content,encode(sha256(convert_to(revised_content,'UTF8')),'hex'),'user',base_revision_id,'关注复核取全存量并优先补齐明确数据缺口'
    FROM revised RETURNING id,prompt_id
)
UPDATE job_prompt p SET current_revision_id=i.id,updated_at=now() FROM inserted i WHERE p.id=i.prompt_id;
