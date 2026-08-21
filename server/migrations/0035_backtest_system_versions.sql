-- 0035_backtest_system_versions.sql：系统回测版本从基准项目重新编号，并清理不可打开的历史关联。

UPDATE backtest_run
   SET name = 'V1 基准项目',
       config_snapshot = (COALESCE(config_snapshot, '{}'::jsonb) - 'version' - 'scheme')
         || '{"version":"V1","project":"基准项目","scheme":"左侧质量反转基准"}'::jsonb,
       request_json = '{"purpose":"建立 V1 基准项目，并纳入研究分级信号独立回测证据"}'::jsonb,
       input_manifest = replace(input_manifest::text, 'V26.5', 'V1')::jsonb,
       conclusion_md = replace(
         replace(conclusion_md, '# V26.5 正式基准结论', '# V1 基准项目'),
         'V26.5', 'V1 基准项目'
       ),
       conclusion_summary = replace(conclusion_summary, 'V26.5', 'V1 基准项目'),
       applicability_boundary = replace(applicability_boundary, 'V26.5', 'V1 基准项目'),
       research_outline = replace(research_outline, 'V26.5', 'V1 基准项目'),
       hypothesis = replace(hypothesis, 'V26.5', 'V1 基准项目'),
       service_version = 'portfolio_engine.py/V1-baseline',
       notes = 'V1 基准项目；已合并基准结果、参数选择与研究分级信号独立回测证据。'
 WHERE kind = 'formal'
   AND status = 'active'
   AND conclusion_status = 'final';

WITH v2 AS (
  SELECT run.id
    FROM strategy_evolution_backtest link
    JOIN strategy_evolution_log evolution ON evolution.id = link.evolution_id
    JOIN backtest_run run ON run.id = link.backtest_run_id
   WHERE evolution.adoption_status = 'adopted'
     AND run.conclusion_status = 'final'
   ORDER BY evolution.decided_at DESC, evolution.id DESC
   LIMIT 1
)
UPDATE backtest_run run
   SET name = 'V2 右侧退出',
       config_snapshot = COALESCE(run.config_snapshot, '{}'::jsonb)
         || '{"version":"V2","name":"右侧退出","comparison_run_ids":[]}'::jsonb,
       request_json = COALESCE(run.request_json, '{}'::jsonb)
         || '{"version":"V2","name":"右侧退出","comparison_run_ids":[]}'::jsonb,
       conclusion_md = replace(
         replace(
           regexp_replace(
             regexp_replace(
               run.conclusion_md,
               E'^# Agent 自驱回测结论：[^\\n]+',
               '# V2 右侧退出'
             ),
             E'\\n- 对比历史回测：[^\\n]*',
             ''
           ),
           'V26.5', 'V1 基准项目'
         ),
         '# 右侧退出方案多模块组合回测', '# V2 右侧退出结果'
       ),
       conclusion_summary = 'V2 右侧退出：' || run.conclusion_summary,
       applicability_boundary = replace(run.applicability_boundary, 'V26.5', 'V1 基准项目'),
       research_outline = replace(run.research_outline, 'V26.5', 'V1 基准项目'),
       hypothesis = replace(run.hypothesis, 'V26.5', 'V1 基准项目'),
       notes = 'V2 右侧退出；由已采纳策略演进关联的最终回测结论重新编号。'
  FROM v2
 WHERE run.id = v2.id;

-- 页面历史只允许打开 final；final 指向 working/superseded 的关联会显示但无法打开。
DELETE FROM backtest_run_comparison comparison
 USING backtest_run run, backtest_run prior
 WHERE run.id = comparison.run_id
   AND prior.id = comparison.compared_run_id
   AND run.conclusion_status = 'final'
   AND prior.conclusion_status <> 'final';
