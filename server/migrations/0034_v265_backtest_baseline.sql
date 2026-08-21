-- 0034_v265_backtest_baseline.sql：补齐 V26.5 正式基准，并移除基准前的空白同步记录。

WITH baseline_metrics AS (
  SELECT $json$
  {
    "initial_equity": 200000,
    "ending_equity": 734413.8599891088,
    "total_return_pct": 267.20692999455434,
    "annualized_return_pct": 24.251723030982664,
    "max_drawdown_pct": -13.849442163159742,
    "annualized_volatility_pct": 14.187479544653565,
    "sharpe_ratio": 1.6614061195014482,
    "profit_factor": 1.8227643411698995,
    "trade_count": 696,
    "win_rate_pct": 46.12068965517241,
    "average_capital_utilization_pct": 54.506483372755966,
    "peak_capital_utilization_pct": 99.97435237587405,
    "logic_breakdown": {
      "右侧主升": {"trade_count": 482, "win_rate_pct": 44.40, "pnl": 347313, "average_holding_days": 6.47},
      "左侧反转": {"trade_count": 46, "win_rate_pct": 69.57, "pnl": 42304, "average_holding_days": 6.22},
      "试盘启动": {"trade_count": 57, "win_rate_pct": 43.86, "pnl": 51937, "average_holding_days": 5.91},
      "波段箱体": {"trade_count": 99, "win_rate_pct": 44.44, "pnl": 56670, "average_holding_days": 31.96},
      "长线价值": {"trade_count": 12, "win_rate_pct": 50.00, "pnl": 30981, "average_holding_days": 243.00}
    },
    "研究分级信号回测": {
      "status": "未采纳",
      "evaluation_period": {"start": "2022-01-01", "end": "2025-12-31"},
      "hypothesis": "S=0.80、A=0.90、B=1.00 的分级信号阈值可同时改善全期与 2024—2025 时间验证",
      "conclusion": "不支持分级或股性调整信号阈值；维持统一信号阈值，S/A/B 只用于既有仓位分配。",
      "full_period": {
        "统一阈值基线": {"total_return_pct": 79.21, "annualized_return_pct": 15.75, "max_drawdown_pct": -13.56, "sharpe_ratio": 1.18, "trade_count": 454, "win_rate_pct": 44.49, "profit_factor": 1.49, "pnl": 153797},
        "仅分级阈值": {"total_return_pct": 66.43, "annualized_return_pct": 13.62, "max_drawdown_pct": -14.34, "sharpe_ratio": 1.01, "trade_count": 469, "win_rate_pct": 42.22, "profit_factor": 1.38, "pnl": 128379},
        "仅股性阈值": {"total_return_pct": 46.97, "annualized_return_pct": 10.13, "max_drawdown_pct": -17.52, "sharpe_ratio": 0.82, "trade_count": 417, "win_rate_pct": 42.69, "profit_factor": 1.32, "pnl": 89110},
        "分级＋股性阈值": {"total_return_pct": 61.62, "annualized_return_pct": 12.79, "max_drawdown_pct": -12.48, "sharpe_ratio": 0.98, "trade_count": 427, "win_rate_pct": 43.33, "profit_factor": 1.39, "pnl": 119660}
      },
      "validation_2024_2025": {
        "统一阈值基线": {"annualized_return_pct": 37.16, "max_drawdown_pct": -11.37, "sharpe_ratio": 2.23, "trade_count": 237, "win_rate_pct": 48.52, "profit_factor": 2.04},
        "仅分级阈值": {"annualized_return_pct": 31.20, "max_drawdown_pct": -12.37, "sharpe_ratio": 1.85, "trade_count": 249, "win_rate_pct": 45.78, "profit_factor": 1.79},
        "仅股性阈值": {"annualized_return_pct": 23.75, "max_drawdown_pct": -13.73, "sharpe_ratio": 1.56, "trade_count": 220, "win_rate_pct": 44.55, "profit_factor": 1.71},
        "分级＋股性阈值": {"annualized_return_pct": 30.06, "max_drawdown_pct": -11.47, "sharpe_ratio": 1.85, "trade_count": 225, "win_rate_pct": 46.22, "profit_factor": 1.85}
      }
    }
  }
  $json$::jsonb AS metrics
), baseline_strategy AS (
  SELECT COALESCE(
           (SELECT strategy_hash_before
              FROM strategy_evolution_log
             WHERE adoption_status = 'adopted'
             ORDER BY decided_at, id
             LIMIT 1),
           (SELECT current_hash FROM strategy_state WHERE singleton = 1)
         ) AS strategy_hash,
         CASE
           WHEN EXISTS (SELECT 1 FROM strategy_evolution_log WHERE adoption_status = 'adopted') THEN 0
           ELSE (SELECT change_seq FROM strategy_state WHERE singleton = 1)
         END AS change_seq
)
UPDATE backtest_run run
   SET name = 'V26.5 左侧质量反转版（2026-08-13 正式集合扩容）',
       config_snapshot = $json$
       {
         "version": "V26.5",
         "scheme": "左侧质量反转版",
         "formal_universe_closed_on": "2026-08-13",
         "implementation": "portfolio_engine.py 的最终配置()",
         "one_way_slippage_bp": 10,
         "position_grades": {"S": 3.0, "A": 1.5, "B": 0.8},
         "left_reversal": "点时质量连续仓位、ATR 初始止损、6%/16% 分批移动退出、最长持有 10 个交易日"
       }
       $json$::jsonb,
       input_manifest = $json$
       ["V26.5 正式配置", "32 只短线", "10 只波段", "8 只长线", "正式组合结果", "参数选择与消融证据", "研究分级信号独立回测"]
       $json$::jsonb,
       request_json = $json$
       {"purpose": "建立 V26.5 正式回测基准，并纳入研究分级信号独立回测证据"}
       $json$::jsonb,
       input_summary = $json$
       {
         "formal_period": {"start": "2020-07-13", "end": "2026-07-10", "trading_days": 1454},
         "formal_universe": {"short": 32, "swing": 10, "long": 8, "total": 50},
         "research_grading_period": {"start": "2022-01-01", "end": "2025-12-31"},
         "research_grading_universe": {"short": 32, "swing": 10, "long": 8, "total": 50},
         "transaction_cost": {"one_way_slippage_bp": 10, "other_costs": "V26.5 正式引擎口径"}
       }
       $json$::jsonb,
       metrics = baseline_metrics.metrics,
       metrics_json = baseline_metrics.metrics,
       conclusion_md = $markdown$
# V26.5 正式基准结论

当前基准采用“V26.5 左侧质量反转版”具体方案，并以 2026-08-13 闭合后的 32 只短线、10 只波段、8 只长线正式集合复跑结果为准。V26.5 只升级短线左侧模块；右侧主升、试盘启动、波段箱体、长线价值、市场状态和组合资金调度沿用原口径。

## 正式组合结果

| 指标 | 结果 |
|---|---:|
| 回测区间 | 2020-07-13—2026-07-10 |
| 单边滑点 | 10bp |
| 初始权益 | 200,000 元 |
| 期末权益 | 734,414 元 |
| 总收益 | 267.21% |
| CAGR | 24.25% |
| 最大回撤 | -13.85% |
| 年化波动 | 14.19% |
| 夏普 | 1.66 |
| 盈利因子 | 1.82 |
| 交易数 / 胜率 | 696 / 46.12% |

| 交易逻辑 | 笔数 | 胜率 | 盈亏 | 平均持有日 |
|---|---:|---:|---:|---:|
| 右侧主升 | 482 | 44.40% | +347,313 元 | 6.47 |
| 左侧反转 | 46 | 69.57% | +42,304 元 | 6.22 |
| 试盘启动 | 57 | 43.86% | +51,937 元 | 5.91 |
| 波段箱体 | 99 | 44.44% | +56,670 元 | 31.96 |
| 长线价值 | 12 | 50.00% | +30,981 元 | 243.00 |

## 研究分级信号回测（独立研究）

研究检验 S=0.80、A=0.90、B=1.00 的分级信号阈值，以及股性阈值是否能改善 2022—2025 年结果。结论为**不支持**：统一阈值基线在全期和 2024—2025 时间验证中均优于三种调整方案。因此维持统一信号阈值；S/A/B 继续只用于既有仓位分配，研究评分和股性标签不替代量化信号。

| 全期方案 | 总收益 | CAGR | 最大回撤 | 夏普 | 交易数 | 胜率 | 盈利因子 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 统一阈值基线 | 79.21% | 15.75% | -13.56% | 1.18 | 454 | 44.49% | 1.49 |
| 仅分级阈值 | 66.43% | 13.62% | -14.34% | 1.01 | 469 | 42.22% | 1.38 |
| 仅股性阈值 | 46.97% | 10.13% | -17.52% | 0.82 | 417 | 42.69% | 1.32 |
| 分级＋股性阈值 | 61.62% | 12.79% | -12.48% | 0.98 | 427 | 43.33% | 1.39 |

| 2024—2025 验证方案 | CAGR | 最大回撤 | 夏普 | 交易数 | 胜率 | 盈利因子 |
|---|---:|---:|---:|---:|---:|---:|
| 统一阈值基线 | 37.16% | -11.37% | 2.23 | 237 | 48.52% | 2.04 |
| 仅分级阈值 | 31.20% | -12.37% | 1.85 | 249 | 45.78% | 1.79 |
| 仅股性阈值 | 23.75% | -13.73% | 1.56 | 220 | 44.55% | 1.71 |
| 分级＋股性阈值 | 30.06% | -11.47% | 1.85 | 225 | 46.22% | 1.85 |

## 结论边界

- 正式组合结果来自固定角色与固定标的集合，存在幸存者偏差；历史 ST、退市状态和完整盘中成交顺序不可复原。
- 参数研究与正式指标使用同一历史区间，没有独立样本外；需要继续积累向前样本。
- 双汇发展、海天味业缺少对应点时基本面，虽然属于正式集合，但在该六年区间不会产生长线信号。
- 分级信号回测是独立研究，不改写 V26.5 正式配置，也不能包装成 V26.5 正式业绩。
- 本基准对应策略序号 0，不包含 2026-08-20 真人批准的短线退出 §2.4 调整；后续策略演进以独立最终回测结论为证据。
       $markdown$,
       data_gaps = $json$
       [
         {"item": "point_in_time_fundamentals", "detail": "双汇发展、海天味业缺少对应点时基本面，区间内不产生长线信号"},
         {"item": "historical_listing_state", "detail": "历史 ST 与退市状态不完整"},
         {"item": "out_of_sample", "detail": "参数研究和正式结果来自同一历史区间，尚无独立样本外"},
         {"item": "intraday_sequence", "detail": "日线无法复原同日分批触发的真实盘中顺序"}
       ]
       $json$::jsonb,
       service_version = 'portfolio_engine.py/V26.5',
       strategy_change_seq = baseline_strategy.change_seq,
       strategy_snapshot_hash = baseline_strategy.strategy_hash,
       research_outline = '以 V26.5 正式配置与完整 50 只标的集合建立组合基准，并并入 2022—2025 年研究分级信号独立回测，检验 S/A/B 与股性阈值调整是否优于统一阈值。',
       hypothesis = 'V26.5 左侧质量反转整套方案在正式集合上保持可用；分级信号阈值 S=0.80、A=0.90、B=1.00 可同时改善全期与 2024—2025 时间验证。',
       conclusion_status = 'final',
       conclusion_summary = 'V26.5 左侧质量反转版在 2026-08-13 闭合后的 50 只正式集合上，10bp 单边滑点下取得 CAGR 24.25%、最大回撤 -13.85%、夏普 1.66、696 笔交易、胜率 46.12%。研究分级信号独立回测未支持 S=0.80、A=0.90、B=1.00 或股性阈值调整：统一阈值在全期与 2024—2025 时间验证均更优，因此分级继续只用于仓位，不改写正式信号阈值。',
       applicability_boundary = '适用于 V26.5 左侧质量反转参数与 2026-08-13 闭合的固定正式集合。固定池、幸存者偏差、历史 ST/退市状态不完整、日线盘中顺序不可复原，且参数研究没有独立样本外。研究分级信号回测是独立研究，不构成 V26.5 正式业绩。该基准对应策略序号 0，不包含 2026-08-20 真人批准的短线退出 §2.4 调整。',
       notes = 'V26.5 正式基准；已合并参数选择、正式集合结果与研究分级信号独立回测证据。'
  FROM baseline_metrics, baseline_strategy
 WHERE run.kind = 'formal'
   AND run.status = 'active'
   AND run.execution_origin = 'legacy';

-- 两份仍属于基准证据的报告改挂到正式锚点，避免随空白历史记录一起删除。
WITH anchor AS (
  SELECT id FROM backtest_run
   WHERE kind = 'formal' AND status = 'active' AND execution_origin = 'legacy'
)
INSERT INTO backtest_artifact (backtest_run_id, dataset_id, role)
SELECT anchor.id, dataset.id, 'report'
  FROM anchor
  JOIN data_dataset dataset ON dataset.source_path IN (
    '支撑/results/回测报告_V26.5左侧质量反转_2026-08-12.md',
    '支撑/results/研究分级信号回测_2026-08-13.md'
  )
ON CONFLICT DO NOTHING;

CREATE TEMP TABLE obsolete_backtest_dataset ON COMMIT DROP AS
SELECT DISTINCT artifact.dataset_id
  FROM backtest_artifact artifact
  JOIN backtest_run run ON run.id = artifact.backtest_run_id
 WHERE run.execution_origin = 'legacy'
   AND NOT (run.kind = 'formal' AND run.status = 'active');

DELETE FROM backtest_run_comparison comparison
 WHERE comparison.run_id IN (
         SELECT id FROM backtest_run
          WHERE execution_origin = 'legacy'
            AND NOT (kind = 'formal' AND status = 'active')
       )
    OR comparison.compared_run_id IN (
         SELECT id FROM backtest_run
          WHERE execution_origin = 'legacy'
            AND NOT (kind = 'formal' AND status = 'active')
       );

DELETE FROM strategy_evolution_backtest link
 WHERE link.backtest_run_id IN (
   SELECT id FROM backtest_run
    WHERE execution_origin = 'legacy'
      AND NOT (kind = 'formal' AND status = 'active')
 );

DELETE FROM backtest_run
 WHERE execution_origin = 'legacy'
   AND NOT (kind = 'formal' AND status = 'active');

DELETE FROM data_dataset dataset
 USING obsolete_backtest_dataset obsolete
 WHERE dataset.id = obsolete.dataset_id
   AND NOT EXISTS (
     SELECT 1 FROM backtest_artifact artifact WHERE artifact.dataset_id = dataset.id
   );
