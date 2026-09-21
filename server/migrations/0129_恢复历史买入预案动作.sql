-- 0120 前向升级时暂存的历史买入预案，在0128放宽约束后原样恢复。
DO $restore$
BEGIN
  IF to_regclass('public.migration_0120_legacy_buy') IS NOT NULL THEN
    UPDATE daily_plan_playbook playbook
       SET action='buy',effective_action='buy'
      FROM migration_0120_legacy_buy backup
     WHERE playbook.id=backup.playbook_id;
    DROP TABLE migration_0120_legacy_buy;
  END IF;
END $restore$;
