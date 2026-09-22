-- 为已有接近候选补齐可直接比较的当前值与目标值；后续运行由服务层统一生成。

UPDATE strategy_entry_signal
   SET missing_signals = CASE strategy_code
     WHEN 'swing' THEN CASE missing_signals->>0
       WHEN 'rsi_oversold' THEN jsonb_build_array(
         'RSI14：当前 ' || to_char((evidence#>>'{evidence,rsi14}')::numeric,'FM999990.00') || '，目标 < 40.00')
       WHEN 'volume_contracted' THEN jsonb_build_array(
         '5日量比：当前 ' || to_char((evidence#>>'{evidence,volume_ratio_5}')::numeric,'FM999990.000') || '，目标 < 0.850')
       WHEN 'reward_risk_acceptable' THEN jsonb_build_array(
         '预期盈亏比：当前 ' || to_char((evidence#>>'{evidence,expected_reward_risk}')::numeric,'FM999990.00') || '，目标 ≥ 1.80')
       WHEN 'reversal_candle' THEN jsonb_build_array(
         '反转形态：当前开盘/收盘 ' || to_char((evidence#>>'{evidence,open}')::numeric,'FM999990.00') || '/' ||
         to_char((evidence#>>'{evidence,close}')::numeric,'FM999990.00') || '、下影线 ' ||
         to_char((evidence#>>'{evidence,lower_shadow_ratio}')::numeric*100,'FM999990.00') ||
         '%，目标 收盘>开盘或下影线>0.50%')
       ELSE missing_signals END
     WHEN 'two_year_reversal' THEN CASE
       WHEN missing_signals ? '个股5日跌幅未达8%' OR missing_signals ? '相对行业5日额外落后未达5个百分点' THEN
         (CASE WHEN missing_signals ? '个股5日跌幅未达8%' AND evidence ? 'stock_return_5' THEN jsonb_build_array(
            '个股5日收益：当前 ' || to_char((evidence->>'stock_return_5')::numeric*100,'FM999990.0') || '%，目标 ≤ -8.0%')
          ELSE '[]'::jsonb END) ||
         (CASE WHEN missing_signals ? '相对行业5日额外落后未达5个百分点' AND evidence ? 'relative_return_5' THEN jsonb_build_array(
            '相对行业5日收益：当前 ' || to_char((evidence->>'relative_return_5')::numeric*100,'FM999990.0') || '%，目标 ≤ -5.0%')
          ELSE '[]'::jsonb END)
       ELSE missing_signals END
     WHEN 'copper_left_launch' THEN CASE missing_signals->>0
       WHEN 'low_within_30_days' THEN jsonb_build_array(
         '近60日低点距今：当前 ' || (evidence#>>'{evidence,low_age}') || ' 个交易日，目标 ≤ 30 个交易日')
       WHEN 'rebound_8_to_15' THEN jsonb_build_array(
         '较近60日低点反弹：当前 ' || to_char((evidence#>>'{evidence,rebound_60}')::numeric*100,'FM999990.0') || '%，目标 8.0%–15.0%')
       WHEN 'drawdown_15_to_40' THEN jsonb_build_array(
         '较近252日高点回撤：当前 ' || to_char((evidence#>>'{evidence,drawdown_252}')::numeric*100,'FM999990.0') || '%，目标 -40.0%–-15.0%')
       WHEN 'macro_two_of_three' THEN jsonb_build_array(
         '宏观满足项：当前 ' || (evidence#>>'{evidence,macro,ok_count}') || '/3，目标 ≥ 2/3')
       ELSE missing_signals END
     WHEN 'value_anchor' THEN CASE missing_signals->>0
       WHEN 'below_ma250' THEN jsonb_build_array(
         '相对MA250偏离：当前 ' || to_char((evidence->>'ma250_deviation')::numeric*100,'FM999990.0') || '%，目标 ≤ -10.0%')
       WHEN 'drawdown20' THEN jsonb_build_array(
         '20日回撤：当前 ' || to_char((evidence->>'drawdown_20')::numeric*100,'FM999990.0') || '%，目标 > -30.0% 且 ≤ -10.0%')
       WHEN 'decline5' THEN jsonb_build_array(
         '5日收益：当前 ' || to_char((evidence->>'return_5')::numeric*100,'FM999990.0') || '%，目标 ≤ -4.0%')
       ELSE missing_signals END
     ELSE missing_signals END
 WHERE signal_status='approaching' AND jsonb_array_length(missing_signals)>0;

UPDATE pool_attention_entry attention
   SET missing_signals=signal.missing_signals,updated_at=now()
  FROM strategy_entry_signal signal
 WHERE attention.status='approaching'
   AND attention.source_evaluation_run_id=signal.run_id
   AND attention.instrument_id=signal.instrument_id
   AND signal.signal_status='approaching';
