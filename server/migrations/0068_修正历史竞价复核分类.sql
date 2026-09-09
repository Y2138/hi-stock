-- 0068_修正历史竞价复核分类.sql：历史摘要可能同时包含“一字排队”和风险项“分歧”，以明确的执行形态为准。

UPDATE daily_plan_auction_assessment
   SET review_type = 'one_word_continue',
       updated_at = now()
 WHERE conclusion = 'signal_passed'
   AND review_type = 'divergence'
   AND assessment_summary LIKE '%一字排队观察%';
