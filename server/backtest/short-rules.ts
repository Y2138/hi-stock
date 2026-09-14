// 标准首期纯规则：左侧反转与试盘启动。
// 与 server/modules/plans/daily-context.ts 使用同一组公式；此文件不得引用数据库、服务配置或环境变量。

export interface TrialBar {
  code: string;
  bar_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface LeftSideSignalBar extends TrialBar {
  ma20: number | null;
  rsi14: number | null;
  indicator_status: "ready" | "untrusted" | null;
}

export interface LeftSideSignalEvaluation {
  as_of: string;
  price_signal: boolean;
  stage: "base_conditions" | "reversal_pattern" | "matched";
  failed_conditions: string[];
  pattern: "缩量长下影+止跌组合" | "阳包阴" | "双日止跌" | "缩量长下影" | null;
  quality_score: number;
  quality_factor: number;
  conditions: {
    five_day_decline: boolean;
    rsi_oversold: boolean;
    below_ma20: boolean;
    selloff_absorbed: boolean;
    volume_contracted: boolean;
    long_lower_shadow: boolean;
    bullish_engulfing: boolean;
    prior_near_five_day_low: boolean;
    two_day_reversal: boolean;
    quality_reversal: boolean;
  };
  score_components: {
    volume: number;
    close_acceptance: number;
    lower_shadow: number;
    pattern: number;
    rsi_zone: number;
    ma20_deviation_zone: number;
  };
  evidence: {
    close: number;
    high: number;
    five_day_return: number;
    day_return: number;
    rsi14: number;
    ma20: number;
    ma20_deviation: number;
    volume_ratio_5: number;
    close_position: number;
    lower_shadow_ratio: number;
    lower_shadow_body_multiple: number | null;
    atr14: number;
    confirmation_must_exceed: number;
    confirmation_price_cap: number;
    confirmation_window_available: boolean;
    initial_stop_at_price_cap: number;
    base_amount_at_200k_equity: number;
    base_risk_budget_at_200k_equity: number;
  };
}

export interface TrialStartEvaluation {
  as_of: string;
  price_signal: boolean;
  stage: "signal_volume" | "trial_day" | "pullback_low" | "pullback_volume" | "breakout" | "matched";
  failed_conditions: string[];
  score: number;
  conditions: {
    signal_volume_expanding: boolean;
    trial_day_found: boolean;
    minimum_spacing: boolean | null;
    pullback_above_trial_low: boolean | null;
    pullback_volume_below_trial: boolean | null;
    breakout_above_trial_high: boolean | null;
  };
  evidence: {
    close: number;
    signal_volume: number;
    signal_vma5: number;
    signal_volume_ratio_5: number;
    signal_volume_threshold_ratio: number;
    limit_up_volume_relief: boolean;
    trial_date: string | null;
    trading_day_distance: number | null;
    trial_high: number | null;
    trial_low: number | null;
    trial_volume: number | null;
    trial_volume_ratio_5: number | null;
    trial_upper_shadow_ratio: number | null;
    pullback_min_low: number | null;
    pullback_max_volume: number | null;
  };
}

/** 左侧反转研究放宽项：缺省值即生产口径，只允许放宽超卖深度类条件。 */
export interface LeftSideSignalOverrides {
  five_day_decline_pct?: number;
  rsi_max?: number;
  ma20_deviation_pct?: number;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clip(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundLimitPrice(previousClose: number): number {
  return Math.round(previousClose * 1.1 * 100) / 100;
}

function roundPrice(value: number): number {
  return Math.round(value * 100) / 100;
}

function atr14(rows: TrialBar[]): number | null {
  if (rows.length < 15) return null;
  const ranges = rows.slice(-14).map((row, offset) => {
    const index = rows.length - 14 + offset;
    const previousClose = rows[index - 1]?.close;
    if (!Number.isFinite(row.high) || !Number.isFinite(row.low) ||
        previousClose === undefined || !Number.isFinite(previousClose)) return null;
    return Math.max(
      row.high - row.low,
      Math.abs(row.high - previousClose),
      Math.abs(row.low - previousClose),
    );
  });
  return ranges.some((value) => value === null) ? null : average(ranges as number[]);
}

/** 左侧反转信号：复制自生产确定性纯函数；缺失依赖时返回 null。overrides 只放宽超卖深度，形态条件不变。 */
export function evaluateLeftSideSignal(rows: LeftSideSignalBar[], overrides: LeftSideSignalOverrides = {}): LeftSideSignalEvaluation | null {
  const declineThreshold = overrides.five_day_decline_pct ?? 0.06;
  const rsiMax = overrides.rsi_max ?? 35;
  const ma20DeviationThreshold = overrides.ma20_deviation_pct ?? 0.08;
  if (rows.length < 21) return null;
  const current = rows.at(-1)!;
  const previous = rows.at(-2)!;
  const currentIndex = rows.length - 1;
  const volumes = rows.slice(-5).map((row) => row.volume);
  const required = [
    current.open, current.high, current.low, current.close, current.ma20, current.rsi14,
    previous.open, previous.high, previous.low, previous.close,
    rows[currentIndex - 5]!.close, ...volumes,
  ];
  if (current.indicator_status !== "ready" ||
      required.some((value) => value === null || !Number.isFinite(value)) ||
      current.close <= 0 || current.ma20! <= 0 || previous.close <= 0 ||
      volumes.some((value) => value! <= 0)) return null;
  const currentAtr14 = atr14(rows);
  if (currentAtr14 === null) return null;

  const vma5 = average(volumes as number[]);
  const fiveDayReturn = current.close / rows[currentIndex - 5]!.close - 1;
  const dayReturn = current.close / previous.close - 1;
  const ma20Deviation = current.close / current.ma20! - 1;
  const intradayRange = current.high - current.low;
  const closePosition = intradayRange > 0 ? (current.close - current.low) / intradayRange : 0;
  const lowerShadow = Math.min(current.open, current.close) - current.low;
  const lowerShadowRatio = lowerShadow / current.close;
  const body = Math.abs(current.close - current.open);
  const lowerShadowBodyMultiple = body > 0 ? lowerShadow / body : lowerShadow > 0 ? null : 0;
  const volumeRatio = current.volume! / vma5;
  const volumeContracted = volumeRatio <= 1.2;
  const longLowerShadow = volumeContracted && lowerShadowRatio >= 0.01 &&
    lowerShadow >= body * 1.5 && closePosition >= 0.65;
  const bullishEngulfing = previous.close < previous.open && current.close > current.open &&
    current.open <= previous.close && current.close >= previous.open;
  const priorFiveDayLow = Math.min(...rows.slice(currentIndex - 5, currentIndex).map((row) => row.low));
  const priorNearFiveDayLow = previous.low <= priorFiveDayLow * 1.005;
  const twoDayReversal = priorNearFiveDayLow && current.close > current.open && current.close > previous.high;
  const qualityReversal = volumeContracted && (bullishEngulfing || twoDayReversal);
  const conditions = {
    five_day_decline: fiveDayReturn <= -declineThreshold,
    rsi_oversold: current.rsi14! <= rsiMax,
    below_ma20: ma20Deviation <= -ma20DeviationThreshold,
    selloff_absorbed: dayReturn > -0.085,
    volume_contracted: volumeContracted,
    long_lower_shadow: longLowerShadow,
    bullish_engulfing: bullishEngulfing,
    prior_near_five_day_low: priorNearFiveDayLow,
    two_day_reversal: twoDayReversal,
    quality_reversal: qualityReversal,
  };
  const basePassed = conditions.five_day_decline && conditions.rsi_oversold &&
    conditions.below_ma20 && conditions.selloff_absorbed;
  const patternPassed = longLowerShadow || qualityReversal;
  const priceSignal = basePassed && patternPassed;
  const scoreComponents = {
    volume: clip((1.2 - volumeRatio) / 0.7, 0, 1) * 20,
    close_acceptance: clip((closePosition - 0.5) / 0.5, 0, 1) * 20,
    lower_shadow: clip(lowerShadowRatio / 0.05, 0, 1) * 15,
    pattern: Math.min(45, 30 * Number(bullishEngulfing) + 30 * Number(twoDayReversal) + 15 * Number(longLowerShadow)),
    rsi_zone: clip(1 - Math.abs(current.rsi14! - 27.5) / 12.5, 0, 1) * 5,
    ma20_deviation_zone: clip(1 - Math.abs(-ma20Deviation - 0.115) / 0.075, 0, 1) * 5,
  };
  const qualityScore = clip(Object.values(scoreComponents).reduce((sum, score) => sum + score, 0), 0, 100);
  const qualityFactor = 0.5 + qualityScore / 100;
  const confirmationPriceCap = roundPrice(current.close * 1.03);
  const failedConditions = [
    ...Object.entries(conditions).slice(0, 4).filter(([, passed]) => !passed).map(([name]) => name),
    ...(!patternPassed ? ["reversal_pattern"] : []),
  ];
  const pattern = longLowerShadow && qualityReversal
    ? "缩量长下影+止跌组合" as const
    : bullishEngulfing ? "阳包阴" as const
      : twoDayReversal ? "双日止跌" as const
        : longLowerShadow ? "缩量长下影" as const : null;
  return {
    as_of: current.bar_date,
    price_signal: priceSignal,
    stage: !basePassed ? "base_conditions" : !patternPassed ? "reversal_pattern" : "matched",
    failed_conditions: failedConditions,
    pattern,
    quality_score: qualityScore,
    quality_factor: qualityFactor,
    conditions,
    score_components: scoreComponents,
    evidence: {
      close: current.close,
      high: current.high,
      five_day_return: fiveDayReturn,
      day_return: dayReturn,
      rsi14: current.rsi14!,
      ma20: current.ma20!,
      ma20_deviation: ma20Deviation,
      volume_ratio_5: volumeRatio,
      close_position: closePosition,
      lower_shadow_ratio: lowerShadowRatio,
      lower_shadow_body_multiple: lowerShadowBodyMultiple,
      atr14: currentAtr14,
      confirmation_must_exceed: current.high,
      confirmation_price_cap: confirmationPriceCap,
      confirmation_window_available: current.high < confirmationPriceCap,
      initial_stop_at_price_cap: roundPrice(Math.max(confirmationPriceCap - currentAtr14, confirmationPriceCap * 0.93)),
      base_amount_at_200k_equity: roundPrice(40_000 * qualityFactor),
      base_risk_budget_at_200k_equity: roundPrice(3_000 * qualityFactor),
    },
  };
}

/** 试盘启动信号：复制自生产确定性纯函数。 */
export function evaluateTrialStartSignal(rows: TrialBar[]): TrialStartEvaluation {
  const signalIndex = rows.length - 1;
  const signal = rows[signalIndex]!;
  const signalVma5 = average(rows.slice(signalIndex - 4, signalIndex + 1).map((row) => row.volume!));
  const previousClose = rows[signalIndex - 1]!.close;
  const limitUp = signal.close >= roundLimitPrice(previousClose) - 1e-8;
  const volumeThresholdRatio = limitUp ? 0.5 : 1.2;
  const signalVolumeExpanding = signal.volume! > signalVma5 * volumeThresholdRatio;
  let trialIndex: number | null = null;
  let trialVma5: number | null = null;
  let trialUpperShadowRatio: number | null = null;
  for (let index = signalIndex - 2; index >= Math.max(4, signalIndex - 10); index -= 1) {
    const trial = rows[index]!;
    const candidateVma5 = average(rows.slice(index - 4, index + 1).map((row) => row.volume!));
    const upperShadowRatio = trial.close > 0
      ? (trial.high - Math.max(trial.open, trial.close)) / trial.close
      : 0;
    if (trial.volume! > candidateVma5 * 1.2 && upperShadowRatio > 0.02) {
      trialIndex = index;
      trialVma5 = candidateVma5;
      trialUpperShadowRatio = upperShadowRatio;
      break;
    }
  }
  const trial = trialIndex === null ? null : rows[trialIndex]!;
  const pullback = trialIndex === null ? [] : rows.slice(trialIndex + 1, signalIndex);
  const pullbackMinLow = pullback.length > 0 ? Math.min(...pullback.map((row) => row.low)) : null;
  const pullbackMaxVolume = pullback.length > 0 ? Math.max(...pullback.map((row) => row.volume!)) : null;
  const pullbackAboveTrialLow = trial === null || pullbackMinLow === null ? null : pullbackMinLow > trial.low;
  const pullbackVolumeBelowTrial = trial === null || pullbackMaxVolume === null ? null : pullbackMaxVolume < trial.volume!;
  const breakoutAboveTrialHigh = trial === null ? null : signal.close > trial.high;
  const conditions = {
    signal_volume_expanding: signalVolumeExpanding,
    trial_day_found: trial !== null,
    minimum_spacing: trialIndex === null ? null : signalIndex - trialIndex >= 2,
    pullback_above_trial_low: pullbackAboveTrialLow,
    pullback_volume_below_trial: pullbackVolumeBelowTrial,
    breakout_above_trial_high: breakoutAboveTrialHigh,
  };
  const priceSignal = signalVolumeExpanding && trial !== null &&
    pullbackAboveTrialLow === true && pullbackVolumeBelowTrial === true && breakoutAboveTrialHigh === true;
  const failedConditions = Object.entries(conditions)
    .filter(([, passed]) => passed === false)
    .map(([name]) => name);
  const stage = !signalVolumeExpanding ? "signal_volume" as const
    : trial === null ? "trial_day" as const
      : !pullbackAboveTrialLow ? "pullback_low" as const
        : !pullbackVolumeBelowTrial ? "pullback_volume" as const
          : !breakoutAboveTrialHigh ? "breakout" as const : "matched" as const;
  return {
    as_of: signal.bar_date,
    price_signal: priceSignal,
    stage,
    failed_conditions: failedConditions,
    score: 100 * clip(signal.volume! / signalVma5 / 3, 0, 1),
    conditions,
    evidence: {
      close: signal.close,
      signal_volume: signal.volume!,
      signal_vma5: signalVma5,
      signal_volume_ratio_5: signal.volume! / signalVma5,
      signal_volume_threshold_ratio: volumeThresholdRatio,
      limit_up_volume_relief: limitUp,
      trial_date: trial?.bar_date ?? null,
      trading_day_distance: trialIndex === null ? null : signalIndex - trialIndex,
      trial_high: trial?.high ?? null,
      trial_low: trial?.low ?? null,
      trial_volume: trial?.volume ?? null,
      trial_volume_ratio_5: trial && trialVma5 ? trial.volume! / trialVma5 : null,
      trial_upper_shadow_ratio: trialUpperShadowRatio,
      pullback_min_low: pullbackMinLow,
      pullback_max_volume: pullbackMaxVolume,
    },
  };
}
