-- 未来交易日历上游不提供时，A级价值错杀仍完成当日扫描；复核日期留空并明确报告缺口。
WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,prompt.current_revision_id AS base_id,revision.content
    FROM job_prompt prompt JOIN job_prompt_revision revision ON revision.id=prompt.current_revision_id
   WHERE prompt.code='value_anchor_opportunity_scan'
), updated AS (
  SELECT prompt_id,base_id,
         replace(content,
           '建议增配比例固定为10%，并给出第20个交易日复核日期；',
           '建议增配比例固定为10%；存在已确认的未来第20个交易日时给出复核日期，否则留空并报告日历缺口，不得阻断当日扫描或推算开市日；') AS content
    FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision (prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,(SELECT max(revision_no)+1 FROM job_prompt_revision WHERE prompt_id=updated.prompt_id),
         content,encode(sha256(convert_to(content,'UTF8')),'hex'),'user',base_id,'未来复核日期缺失不再阻断价值错杀扫描'
    FROM updated WHERE content <> (SELECT content FROM current_prompt)
  RETURNING id,prompt_id
)
UPDATE job_prompt prompt SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE prompt.id=inserted.prompt_id;
