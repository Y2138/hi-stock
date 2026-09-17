-- 扫描服务仅评估Top10；旧提示词的Top50表述不得诱导Agent夸大覆盖。
WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,revision.id AS base_revision_id,
         replace(revision.content,'Top50','Top10') AS content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id=prompt.current_revision_id
   WHERE prompt.code='value_anchor_opportunity_scan'
     AND revision.sha256='9f1d097e09791d1de807627a345eebab1685ac32a900a30238ae0bad14d69ed7'
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id,revision_no,content,sha256,source,base_revision_id,change_summary)
  SELECT prompt_id,
         (SELECT COALESCE(max(x.revision_no),0)+1 FROM job_prompt_revision x WHERE x.prompt_id=current_prompt.prompt_id),
         content,encode(sha256(convert_to(content,'UTF8')),'hex'),'user',base_revision_id,
         '校正A级价值错杀任务Top10覆盖口径'
    FROM current_prompt
  RETURNING prompt_id,id
)
UPDATE job_prompt prompt SET current_revision_id=inserted.id,updated_at=now()
  FROM inserted WHERE prompt.id=inserted.prompt_id;
