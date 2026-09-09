// 每日计划确定性上下文：服务层完成机械计算，只向 Agent 返回紧凑结论与覆盖计数。
import type pg from "pg";
import { querySectorTemperature } from "../../analysis/service.js";
import { MARKET_STRUCTURE_DATASETS, type MarketStructureDataset } from "../market/structure.js";

type Db = Pick<pg.Pool | pg.PoolClient, "query">;
type StopLossMode = "ma5" | "ma10" | "fixed_90";

interface SyncRunRow {
  id: string;
  dataset: MarketStructureDataset;
  target_date: string;
  status: "running" | "success" | "partial" | "failed";
  completed_pages: number;
  total_pages: number | null;
  row_count: number;
  gaps: unknown[];
  source_time: string | null;
  finished_at: string | null;
}

interface PoolMember {
  instrument_id: string;
  code: string;
  name: string;
  kind: string;
}

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

interface PositionContextRow {
  code: string;
  name: string;
  kind: string;
  quantity: number;
  cost_price: number;
  opened_at: string | null;
  pool: "short" | "long" | null;
  role: string | null;
  tags: string[];
  stock_character: string | null;
  indicator_date: string | null;
  ma5: number | null;
  ma10: number | null;
  indicator_status: "ready" | "untrusted" | null;
  metric_date: string | null;
  calculation_version: string | null;
  input_row_count: number | null;
  defense_break_count: number | null;
  defense_recovered_count: number | null;
  defense_recovery_ma10: number | null;
  metric_run_status: string | null;
  holding_trade_days: number;
  highest_high: number | null;
  highest_close: number | null;
}

export interface RightSideSignalBar {
  code: string;
  bar_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  dif: number | null;
  macd_hist: number | null;
  indicator_status: "ready" | "untrusted" | null;
}

export interface RightSideSignalEvaluation {
  as_of: string;
  passed_count: number;
  price_signal: boolean;
  conditions: {
    dif_positive: boolean;
    ma20_rising: boolean;
    macd_accelerating: boolean;
    bullish_alignment: boolean;
    bullish_body: boolean;
    volume_expanding: boolean;
  };
  evidence: {
    close: number;
    open: number;
    dif: number;
    ma5: number;
    ma10: number;
    ma20: number;
    previous_ma20: number;
    macd_hist: number;
    previous_macd_hist: number;
    macd_hist_delta_ratio: number;
    volume: number;
    vma5: number;
    volume_threshold_ratio: number;
    limit_up: boolean;
  };
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

function stockCharacterText(stockCharacter: string | null, tags: string[]): string {
  return [stockCharacter ?? "", ...tags].join("·");
}

/** 每日按当前策略可识别的股性语义选择止损档位。 */
export function inferStopLossMode(stockCharacter: string | null, tags: string[]): StopLossMode | null {
  const text = stockCharacterText(stockCharacter, tags);
  if (/止损[:：]?MA5/i.test(text)) return "ma5";
  if (/止损[:：]?MA10/i.test(text)) return "ma10";
  if (/止损[:：]?(买入价[×x*])?0[.]90/i.test(text)) return "fixed_90";
  const fast = text.includes("快拉");
  const slow = text.includes("慢拉") || text.includes("温吞");
  if (fast !== slow) return fast ? "ma5" : "ma10";
  return null;
}

function isFastPullUp(stockCharacter: string | null, tags: string[]): boolean {
  const text = stockCharacterText(stockCharacter, tags);
  return text.includes("快拉") && !text.includes("慢拉") && !text.includes("温吞");
}

/** 只接收最近至少五根、按日期升序的可信日线；输出六项布尔结论和复核所需最小证据。 */
export function evaluateRightSideSignal(rows: RightSideSignalBar[]): RightSideSignalEvaluation | null {
  if (rows.length < 5) return null;
  const current = rows.at(-1)!;
  const previous = rows.at(-2)!;
  const volumes = rows.slice(-5).map((row) => row.volume);
  const required = [
    current.open, current.close, current.ma5, current.ma10, current.ma20, current.dif,
    current.macd_hist, previous.close, previous.ma20, previous.macd_hist, ...volumes,
  ];
  if (current.indicator_status !== "ready" || previous.indicator_status !== "ready" ||
      required.some((value) => value === null || !Number.isFinite(value)) ||
      current.open <= 0 || current.close <= 0 || previous.close <= 0 ||
      volumes.some((value) => value! <= 0)) return null;

  const vma5 = average(volumes as number[]);
  const limitUp = current.close >= roundLimitPrice(previous.close) - 1e-8;
  const volumeThresholdRatio = limitUp ? 0.5 : 1.2;
  const macdHistDeltaRatio = (current.macd_hist! - previous.macd_hist!) / current.close;
  const conditions = {
    dif_positive: current.dif! > 0,
    ma20_rising: current.ma20! > previous.ma20!,
    macd_accelerating: current.macd_hist! > 0 && macdHistDeltaRatio > 0.001,
    bullish_alignment: current.close > current.ma5! && current.ma5! > current.ma10!,
    bullish_body: current.close / current.open - 1 >= 0.01,
    volume_expanding: current.volume! > vma5 * volumeThresholdRatio,
  };
  const passedCount = Object.values(conditions).filter(Boolean).length;
  return {
    as_of: current.bar_date,
    passed_count: passedCount,
    price_signal: passedCount === 6,
    conditions,
    evidence: {
      close: current.close,
      open: current.open,
      dif: current.dif!,
      ma5: current.ma5!,
      ma10: current.ma10!,
      ma20: current.ma20!,
      previous_ma20: previous.ma20!,
      macd_hist: current.macd_hist!,
      previous_macd_hist: previous.macd_hist!,
      macd_hist_delta_ratio: macdHistDeltaRatio,
      volume: current.volume!,
      vma5,
      volume_threshold_ratio: volumeThresholdRatio,
      limit_up: limitUp,
    },
  };
}

/** 与 V26.5 正式引擎一致地计算左侧反转；仅使用信号日及此前数据。 */
export function evaluateLeftSideSignal(rows: LeftSideSignalBar[]): LeftSideSignalEvaluation | null {
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
    five_day_decline: fiveDayReturn <= -0.06,
    rsi_oversold: current.rsi14! <= 35,
    below_ma20: ma20Deviation <= -0.08,
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

/** 返回试盘形态的全部阶段证据，便于区分“没有信号”和“没有核验”。 */
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

export function findTrialStartMatch(rows: TrialBar[]) {
  const evaluation = evaluateTrialStartSignal(rows);
  if (!evaluation.price_signal) return null;
  return {
    as_of: evaluation.as_of,
    trial_date: evaluation.evidence.trial_date,
    close: evaluation.evidence.close,
    trial_high: evaluation.evidence.trial_high,
    signal_volume_ratio_5: evaluation.evidence.signal_volume_ratio_5,
    trial_volume_ratio_5: evaluation.evidence.trial_volume_ratio_5,
    limit_up_volume_relief: evaluation.evidence.limit_up_volume_relief,
  };
}

async function queryStructureSync(db: Db, date: string) {
  const rows = await db.query<SyncRunRow>(
    `SELECT DISTINCT ON (dataset)
            id::text, dataset, target_date::text, status, completed_pages, total_pages,
            row_count, gaps, source_time::text, finished_at::text
       FROM market_special_sync_run
      WHERE target_date <= $1::date
      ORDER BY dataset, target_date DESC, id DESC`,
    [date],
  );
  const byDataset = new Map(rows.rows.map((row) => [row.dataset, row]));
  const datasets = MARKET_STRUCTURE_DATASETS.map((dataset) => {
    const row = byDataset.get(dataset);
    if (!row) return { dataset, status: "missing" as const, target_date: null, valid_empty: false };
    return {
      dataset,
      run_id: row.id,
      target_date: row.target_date,
      status: row.status,
      completed_pages: row.completed_pages,
      total_pages: row.total_pages,
      row_count: row.row_count,
      valid_empty: row.status === "success" && row.completed_pages === 0 && row.total_pages === 0 && row.row_count === 0,
      gaps: row.gaps,
      source_time: row.source_time,
      finished_at: row.finished_at,
    };
  });
  return {
    expected_count: MARKET_STRUCTURE_DATASETS.length,
    resolved_count: datasets.filter((item) => item.status !== "missing").length,
    success_count: datasets.filter((item) => item.status === "success").length,
    datasets,
  };
}

async function scanTrialSignals(db: Db, date: string, expectedDataDate: string | null) {
  const members = await db.query<PoolMember>(
    `SELECT membership.instrument_id::text, instrument.code, instrument.name, instrument.kind
       FROM pool_membership membership
       JOIN market_instrument instrument ON instrument.id = membership.instrument_id
      WHERE membership.pool = 'short' AND membership.effective_to IS NULL
      ORDER BY instrument.code`,
  );
  const stockMembers = members.rows.filter((member) => member.kind === "stock");
  const bars = await db.query<TrialBar>(
    `WITH ranked AS (
       SELECT instrument.code, bar.bar_date::text,
              bar.open::float8, bar.high::float8, bar.low::float8, bar.close::float8,
              bar.volume::float8,
              row_number() OVER (
                PARTITION BY bar.instrument_id ORDER BY bar.bar_date DESC, bar.bar_time DESC
              ) AS row_no
         FROM pool_membership membership
         JOIN market_instrument instrument ON instrument.id = membership.instrument_id AND instrument.kind = 'stock'
         JOIN market_bar bar ON bar.instrument_id = membership.instrument_id
                            AND bar.freq = 'day' AND bar.bar_date <= $1::date
        WHERE membership.pool = 'short' AND membership.effective_to IS NULL
     )
     SELECT code, bar_date, open, high, low, close, volume
       FROM ranked WHERE row_no <= 15 ORDER BY code, bar_date`,
    [date],
  );
  const byCode = new Map<string, TrialBar[]>();
  for (const bar of bars.rows) byCode.set(bar.code, [...(byCode.get(bar.code) ?? []), bar]);
  const gaps: Array<{ code: string; reason: string }> = [];
  const items: Array<TrialStartEvaluation & { code: string; name: string }> = [];
  for (const member of stockMembers) {
    const rows = byCode.get(member.code) ?? [];
    if (rows.length < 15) {
      gaps.push({ code: member.code, reason: `试盘扫描至少需要15根日线，当前${rows.length}根` });
      continue;
    }
    if (expectedDataDate && rows.at(-1)!.bar_date !== expectedDataDate) {
      gaps.push({ code: member.code, reason: `最新日线为${rows.at(-1)!.bar_date}，市场数据日为${expectedDataDate}` });
      continue;
    }
    if (rows.some((row) => row.volume === null || !Number.isFinite(row.volume) || row.volume <= 0)) {
      gaps.push({ code: member.code, reason: "近15根日线存在无效成交量" });
      continue;
    }
    items.push({ code: member.code, name: member.name, ...evaluateTrialStartSignal(rows) });
  }
  return {
    status: items.length === stockMembers.length ? "success" as const : "partial" as const,
    data_date: expectedDataDate,
    member_count: members.rows.length,
    stock_member_count: stockMembers.length,
    excluded_non_stock_count: members.rows.length - stockMembers.length,
    completed_count: items.length,
    pattern_matched_count: items.filter((item) => item.price_signal).length,
    items,
    gaps,
  };
}

async function scanLeftSideSignals(db: Db, date: string, expectedDataDate: string | null) {
  const members = await db.query<PoolMember>(
    `SELECT membership.instrument_id::text, instrument.code, instrument.name, instrument.kind
       FROM pool_membership membership
       JOIN market_instrument instrument ON instrument.id = membership.instrument_id
      WHERE membership.pool = 'short' AND membership.effective_to IS NULL
      ORDER BY instrument.code`,
  );
  const stockMembers = members.rows.filter((member) => member.kind === "stock");
  const bars = await db.query<LeftSideSignalBar>(
    `WITH ranked AS (
       SELECT instrument.code, bar.bar_date::text,
              bar.open::float8, bar.high::float8, bar.low::float8, bar.close::float8,
              bar.volume::float8, indicator.ma20::float8, indicator.rsi14::float8,
              indicator.status AS indicator_status,
              row_number() OVER (
                PARTITION BY bar.instrument_id ORDER BY bar.bar_date DESC, bar.bar_time DESC
              ) AS row_no
         FROM pool_membership membership
         JOIN market_instrument instrument ON instrument.id = membership.instrument_id AND instrument.kind = 'stock'
         JOIN market_bar bar ON bar.instrument_id = membership.instrument_id
                            AND bar.freq = 'day' AND bar.bar_date <= $1::date
         LEFT JOIN market_indicator_value indicator
           ON indicator.instrument_id = bar.instrument_id AND indicator.freq = bar.freq
          AND indicator.bar_date = bar.bar_date AND indicator.bar_time = bar.bar_time
        WHERE membership.pool = 'short' AND membership.effective_to IS NULL
     )
     SELECT code, bar_date, open, high, low, close, volume, ma20, rsi14, indicator_status
       FROM ranked WHERE row_no <= 21 ORDER BY code, bar_date`,
    [date],
  );
  const byCode = new Map<string, LeftSideSignalBar[]>();
  for (const bar of bars.rows) byCode.set(bar.code, [...(byCode.get(bar.code) ?? []), bar]);
  const gaps: Array<{ code: string; reason: string }> = [];
  const items: Array<LeftSideSignalEvaluation & { code: string; name: string }> = [];
  for (const member of stockMembers) {
    const rows = byCode.get(member.code) ?? [];
    if (rows.length < 21) {
      gaps.push({ code: member.code, reason: `左侧反转至少需要21根日线和可信指标，当前${rows.length}根` });
      continue;
    }
    if (expectedDataDate && rows.at(-1)!.bar_date !== expectedDataDate) {
      gaps.push({ code: member.code, reason: `左侧反转最新日线为${rows.at(-1)!.bar_date}，市场数据日为${expectedDataDate}` });
      continue;
    }
    const evaluation = evaluateLeftSideSignal(rows);
    if (!evaluation) {
      gaps.push({ code: member.code, reason: "左侧反转缺少可信RSI14/MA20/OHLCV或ATR14输入" });
      continue;
    }
    items.push({ code: member.code, name: member.name, ...evaluation });
  }
  return {
    status: items.length === stockMembers.length ? "success" as const : "partial" as const,
    data_date: expectedDataDate,
    member_count: members.rows.length,
    stock_member_count: stockMembers.length,
    excluded_non_stock_count: members.rows.length - stockMembers.length,
    completed_count: items.length,
    pattern_matched_count: items.filter((item) => item.price_signal).length,
    items,
    gaps,
  };
}

async function scanRightSideSignals(
  db: Db,
  date: string,
  expectedDataDate: string | null,
  environmentPassed: boolean | null,
) {
  const members = await db.query<PoolMember>(
    `SELECT membership.instrument_id::text, instrument.code, instrument.name, instrument.kind
       FROM pool_membership membership
       JOIN market_instrument instrument ON instrument.id = membership.instrument_id
      WHERE membership.pool = 'short' AND membership.effective_to IS NULL
      ORDER BY instrument.code`,
  );
  const stockMembers = members.rows.filter((member) => member.kind === "stock");
  const bars = await db.query<RightSideSignalBar>(
    `WITH ranked AS (
       SELECT instrument.code, bar.bar_date::text,
              bar.open::float8, bar.high::float8, bar.low::float8, bar.close::float8,
              bar.volume::float8,
              indicator.ma5::float8, indicator.ma10::float8, indicator.ma20::float8,
              indicator.dif::float8, indicator.macd_hist::float8,
              indicator.status AS indicator_status,
              row_number() OVER (
                PARTITION BY bar.instrument_id ORDER BY bar.bar_date DESC, bar.bar_time DESC
              ) AS row_no
         FROM pool_membership membership
         JOIN market_instrument instrument ON instrument.id = membership.instrument_id AND instrument.kind = 'stock'
         JOIN market_bar bar ON bar.instrument_id = membership.instrument_id
                            AND bar.freq = 'day' AND bar.bar_date <= $1::date
         LEFT JOIN market_indicator_value indicator
           ON indicator.instrument_id = bar.instrument_id AND indicator.freq = bar.freq
          AND indicator.bar_date = bar.bar_date AND indicator.bar_time = bar.bar_time
        WHERE membership.pool = 'short' AND membership.effective_to IS NULL
     )
     SELECT code, bar_date, open, high, low, close, volume,
            ma5, ma10, ma20, dif, macd_hist, indicator_status
       FROM ranked WHERE row_no <= 5 ORDER BY code, bar_date`,
    [date],
  );
  const byCode = new Map<string, RightSideSignalBar[]>();
  for (const bar of bars.rows) byCode.set(bar.code, [...(byCode.get(bar.code) ?? []), bar]);
  const gaps: Array<{ code: string; reason: string }> = [];
  const items: Array<RightSideSignalEvaluation & {
    code: string;
    name: string;
    environment_passed: boolean | null;
    signal: boolean | null;
  }> = [];
  for (const member of stockMembers) {
    const rows = byCode.get(member.code) ?? [];
    if (rows.length < 5) {
      gaps.push({ code: member.code, reason: `右侧六条件至少需要5根日线和可信指标，当前${rows.length}根` });
      continue;
    }
    if (expectedDataDate && rows.at(-1)!.bar_date !== expectedDataDate) {
      gaps.push({ code: member.code, reason: `右侧六条件最新日线为${rows.at(-1)!.bar_date}，市场数据日为${expectedDataDate}` });
      continue;
    }
    const evaluation = evaluateRightSideSignal(rows);
    if (!evaluation) {
      gaps.push({ code: member.code, reason: "右侧六条件缺少可信MA/MACD/OHLCV输入" });
      continue;
    }
    items.push({
      code: member.code,
      name: member.name,
      ...evaluation,
      environment_passed: environmentPassed,
      signal: !evaluation.price_signal ? false : environmentPassed,
    });
  }
  return {
    status: gaps.length === 0 && environmentPassed !== null ? "success" as const : "partial" as const,
    data_date: expectedDataDate,
    member_count: members.rows.length,
    stock_member_count: stockMembers.length,
    excluded_non_stock_count: members.rows.length - stockMembers.length,
    completed_count: items.length,
    matched_count: items.filter((item) => item.signal === true).length,
    environment_passed: environmentPassed,
    items,
    gaps,
  };
}

async function queryPositionContext(
  db: Db,
  date: string,
  expectedDataDate: string | null,
  rightSideByCode: Map<string, RightSideSignalEvaluation>,
) {
  const rows = await db.query<PositionContextRow>(
    `SELECT instrument.code, instrument.name, instrument.kind,
            position.quantity::float8, position.cost_price::float8, position.opened_at::text,
            membership.pool, membership.role, membership.tags, membership.stock_character,
            indicator.bar_date::text AS indicator_date,
            indicator.ma5::float8, indicator.ma10::float8, indicator.status AS indicator_status,
            metric.as_of_date::text AS metric_date, metric.calculation_version,
            metric.input_row_count, metric.defense_break_count, metric.defense_recovered_count,
            metric.defense_recovery_ma10,
            metric_run.status AS metric_run_status,
            COALESCE(holding.holding_trade_days, 0)::int AS holding_trade_days,
            holding.highest_high::float8, holding.highest_close::float8
       FROM portfolio_position position
       JOIN market_instrument instrument ON instrument.id = position.instrument_id
       LEFT JOIN pool_membership membership
         ON membership.instrument_id = position.instrument_id AND membership.effective_to IS NULL
       LEFT JOIN LATERAL (
         SELECT value.bar_date, value.ma5, value.ma10, value.status
           FROM market_indicator_value value
          WHERE value.instrument_id = position.instrument_id AND value.freq = 'day'
            AND value.bar_date <= $1::date
          ORDER BY value.bar_date DESC, value.bar_time DESC LIMIT 1
       ) indicator ON true
       LEFT JOIN LATERAL (
         SELECT current.*
           FROM market_stock_character_metric current
          WHERE current.instrument_id = position.instrument_id AND current.as_of_date <= $1::date
          ORDER BY current.as_of_date DESC, current.computed_at DESC LIMIT 1
       ) metric ON true
       LEFT JOIN market_indicator_run metric_run ON metric_run.id = metric.indicator_run_id
       LEFT JOIN LATERAL (
         SELECT count(DISTINCT bar.bar_date)::int AS holding_trade_days,
                max(bar.high) AS highest_high, max(bar.close) AS highest_close
           FROM market_bar bar
          WHERE bar.instrument_id = position.instrument_id AND bar.freq = 'day'
            AND position.opened_at IS NOT NULL
            AND bar.bar_date BETWEEN position.opened_at AND $1::date
       ) holding ON true
      WHERE position.quantity > 0
      ORDER BY instrument.code`,
    [date],
  );
  const gaps: Array<{ code: string; reason: string }> = [];
  const items = rows.rows.map((row) => {
    if (row.pool === null) gaps.push({ code: row.code, reason: "持仓缺少当前策略角色" });
    const stopRequired = row.pool === "short";
    const stopLossMode = inferStopLossMode(row.stock_character, row.tags);
    const stopLossModeSource = stopLossMode === null ? "missing" as const : "strategy" as const;
    if (stopRequired && stopLossMode === null) gaps.push({ code: row.code, reason: "每日评估无法按当前策略与股性确定止损档位" });
    let stopReference: number | null = null;
    const indicatorReady = row.indicator_status === "ready" && (!expectedDataDate || row.indicator_date === expectedDataDate);
    if (stopLossMode === "fixed_90") stopReference = row.cost_price * 0.9;
    if (stopLossMode === "ma5" && indicatorReady) stopReference = row.ma5;
    if (stopLossMode === "ma10" && indicatorReady) stopReference = row.ma10;
    if (stopRequired && stopLossMode !== null && stopReference === null) {
      gaps.push({ code: row.code, reason: `止损档位 ${stopLossMode} 缺少可信指标值` });
    }
    const fastPullUp = isFastPullUp(row.stock_character, row.tags);
    const cooldownTradingDays = fastPullUp ? 2 : 3;
    const cooldownActive = stopRequired && row.holding_trade_days <= cooldownTradingDays;
    const technicalStop = stopReference === null
      ? null
      : roundPrice(Math.min(Math.max(stopReference, row.cost_price * 0.88), row.cost_price * 0.95));
    const firstTakeProfit = roundPrice(row.cost_price * (fastPullUp ? 1.08 : 1.12));
    const secondTakeProfit = roundPrice(row.cost_price * 1.28);
    const firstTakeProfitPriceReached = row.highest_high !== null && row.highest_high >= firstTakeProfit;
    const highestCloseRatio = row.highest_close === null ? null : row.highest_close / row.cost_price - 1;
    const fixedProtection = highestCloseRatio === null ? null
      : highestCloseRatio >= 0.5 ? row.cost_price * 1.35
        : highestCloseRatio >= 0.3 ? row.cost_price * 1.2
          : highestCloseRatio >= 0.15 ? row.cost_price * 1.1
            : highestCloseRatio >= 0.08 ? row.cost_price * 1.08 : null;
    const currentClose = rightSideByCode.get(row.code)?.evidence.close ?? null;
    const ma5Protection = indicatorReady && row.ma5 !== null && currentClose !== null && currentClose / row.cost_price - 1 > 0.08
      ? row.ma5 * 0.99
      : null;
    const postTakeProfitCandidates = [technicalStop, fixedProtection, ma5Protection]
      .filter((value): value is number => value !== null);
    const postFirstTakeProfitStop = postTakeProfitCandidates.length > 0
      ? roundPrice(Math.max(...postTakeProfitCandidates))
      : null;
    const rightSide = rightSideByCode.get(row.code) ?? null;
    if (stopRequired && rightSide === null) {
      gaps.push({ code: row.code, reason: "短线持仓右侧六条件重算未完成" });
    }
    const macdWeaknessExit = rightSide !== null && !cooldownActive &&
      rightSide.evidence.previous_macd_hist > 0 && rightSide.evidence.macd_hist < 0 &&
      rightSide.evidence.close < rightSide.evidence.ma10;
    const breakdownExit = rightSide !== null && !cooldownActive && !firstTakeProfitPriceReached &&
      rightSide.passed_count <= 2;
    const timeFallbackExit = stopRequired && !cooldownActive && !firstTakeProfitPriceReached &&
      row.holding_trade_days >= 5;
    const nextOpenExitCandidate = macdWeaknessExit
      ? "macd_weakness" as const
      : breakdownExit ? "right_side_breakdown" as const
        : timeFallbackExit ? "time_fallback" as const : null;
    const metricReady = row.kind !== "stock" || (
      row.metric_date !== null && row.metric_run_status === "success" && (!expectedDataDate || row.metric_date === expectedDataDate)
    );
    if (!metricReady) gaps.push({
      code: row.code,
      reason: row.metric_date && expectedDataDate && row.metric_date !== expectedDataDate
        ? `护盘收回率数据日为${row.metric_date}，市场数据日为${expectedDataDate}`
        : "护盘收回率尚未完成可信重算",
    });
    return {
      code: row.code,
      name: row.name,
      kind: row.kind,
      quantity: row.quantity,
      cost_price: row.cost_price,
      opened_at: row.opened_at,
      pool: row.pool,
      role: row.role,
      stop_loss_mode: stopLossMode,
      stop_loss_mode_source: stopLossModeSource,
      stop_reference: stopReference,
      technical_stop: technicalStop,
      short_term_triggers: stopRequired ? {
        pace: fastPullUp ? "fast" as const : "other" as const,
        holding_trade_days: row.holding_trade_days,
        cooldown_trading_days: cooldownTradingDays,
        cooldown_active: cooldownActive,
        active_stop: cooldownActive ? roundPrice(row.cost_price * 0.88) : technicalStop,
        first_take_profit: firstTakeProfit,
        second_take_profit: secondTakeProfit,
        first_take_profit_price_reached: firstTakeProfitPriceReached,
        post_first_take_profit_stop_candidate: postFirstTakeProfitStop,
        right_side_survival_count: rightSide?.passed_count ?? null,
        macd_weakness_exit_candidate: macdWeaknessExit,
        right_side_breakdown_exit_candidate: breakdownExit,
        time_fallback_exit_candidate: timeFallbackExit,
        next_open_exit_candidate: nextOpenExitCandidate,
        exit_candidate_scope: "仅适用于右侧主升或试盘启动持仓，实际成交与入场归属仍须核对",
      } : null,
      indicator_date: row.indicator_date,
      defense_recovery_ma10: metricReady ? row.defense_recovery_ma10 : null,
      defense_break_count: metricReady ? row.defense_break_count : null,
      defense_recovered_count: metricReady ? row.defense_recovered_count : null,
      defense_metric_date: metricReady ? row.metric_date : null,
      defense_metric_input_rows: metricReady ? row.input_row_count : null,
      defense_metric_version: metricReady ? row.calculation_version : null,
    };
  });
  const requiredStops = rows.rows.filter((row) => row.pool === "short");
  const requiredMetrics = rows.rows.filter((row) => row.kind === "stock");
  return {
    status: gaps.length === 0 ? "success" as const : "partial" as const,
    position_count: rows.rows.length,
    stop_loss_required_count: requiredStops.length,
    stop_loss_strategy_count: requiredStops.filter((row) =>
      inferStopLossMode(row.stock_character, row.tags) !== null,
    ).length,
    stop_loss_resolved_count: requiredStops.filter((row) =>
      inferStopLossMode(row.stock_character, row.tags) !== null,
    ).length,
    defense_metric_required_count: requiredMetrics.length,
    defense_metric_resolved_count: requiredMetrics.filter((row) =>
      row.metric_date !== null && row.metric_run_status === "success" && (!expectedDataDate || row.metric_date === expectedDataDate),
    ).length,
    items,
    gaps,
  };
}

export async function queryDailyPlanContext(db: Db, date: string) {
  const sector = await querySectorTemperature(db, { analysis_type: "sector_temperature", as_of: date });
  const dataDate = sector.input.latest_date;
  const regime = sector.result.market_regime;
  const environmentPassed = regime.status !== "success"
    ? null
    : regime.state === "熊市"
      ? sector.result.average_temperature === null ? null : sector.result.average_temperature >= 30
      : true;
  const [structure, trial, rightSide, leftSide] = await Promise.all([
    queryStructureSync(db, date),
    scanTrialSignals(db, date, dataDate),
    scanRightSideSignals(db, date, dataDate, environmentPassed),
    scanLeftSideSignals(db, date, dataDate),
  ]);
  const rightSideByCode = new Map(rightSide.items.map((item) => [item.code, item]));
  const finalizedLeftItems = leftSide.items.map((item) => {
    const rightSideItem = rightSideByCode.get(item.code);
    const signal = !item.price_signal
      ? false
      : rightSideItem?.signal === true ? false
        : rightSideItem === undefined || rightSideItem.signal === null ? null : true;
    return {
      ...item,
      signal,
      suppressed_by: item.price_signal && rightSideItem?.signal === true
        ? "right_side" as const
        : item.price_signal && signal === null ? "right_side_unresolved" as const : null,
    };
  });
  const leftSideByCode = new Map(finalizedLeftItems.map((item) => [item.code, item]));
  const finalizedTrialItems = trial.items.map((item) => {
    const rightSideItem = rightSideByCode.get(item.code);
    const leftSideItem = leftSideByCode.get(item.code);
    let signal: boolean | null = false;
    let suppressedBy: "environment" | "right_side" | "left_reversal" | "priority_unresolved" | null = null;
    if (item.price_signal) {
      if (environmentPassed === null) {
        signal = null;
        suppressedBy = "priority_unresolved";
      } else if (!environmentPassed) {
        suppressedBy = "environment";
      } else if (rightSideItem?.signal === true) {
        suppressedBy = "right_side";
      } else if (leftSideItem?.signal === true) {
        suppressedBy = "left_reversal";
      } else if (rightSideItem === undefined || leftSideItem === undefined ||
                 rightSideItem.signal === null || leftSideItem.signal === null) {
        signal = null;
        suppressedBy = "priority_unresolved";
      } else {
        signal = true;
      }
    }
    return {
      ...item,
      environment_passed: environmentPassed,
      signal,
      suppressed_by: suppressedBy,
      next_open_price_cap: roundPrice(item.evidence.close * 1.05),
    };
  });
  const positions = await queryPositionContext(
    db,
    date,
    dataDate,
    new Map(rightSide.items.map((item) => [item.code, item])),
  );
  const positionCodes = new Set(
    positions.items.filter((item) => item.pool === "short").map((item) => item.code),
  );
  const detailedRightSideItems = rightSide.items.filter((item) =>
    item.passed_count >= 4 || positionCodes.has(item.code),
  );
  const compactRightSide = {
    status: rightSide.status,
    data_date: rightSide.data_date,
    member_count: rightSide.member_count,
    stock_member_count: rightSide.stock_member_count,
    excluded_non_stock_count: rightSide.excluded_non_stock_count,
    completed_count: rightSide.completed_count,
    matched_count: rightSide.matched_count,
    environment_passed: rightSide.environment_passed,
    passed_count_distribution: Object.fromEntries(
      Array.from({ length: 7 }, (_, passedCount) => [
        String(passedCount),
        rightSide.items.filter((item) => item.passed_count === passedCount).length,
      ]),
    ),
    detailed_selection: "通过项数不少于4，或属于当前短线持仓",
    items: detailedRightSideItems.map((item) => ({
      code: item.code,
      name: item.name,
      as_of: item.as_of,
      passed_count: item.passed_count,
      price_signal: item.price_signal,
      environment_passed: item.environment_passed,
      signal: item.signal,
      conditions: item.conditions,
      key_values: {
        close: item.evidence.close,
        next_open_price_cap: roundPrice(item.evidence.close * 1.05),
        dif: item.evidence.dif,
        ma20_change: item.evidence.ma20 - item.evidence.previous_ma20,
        macd_hist_delta_ratio: item.evidence.macd_hist_delta_ratio,
        body_change_ratio: item.evidence.close / item.evidence.open - 1,
        volume_ratio_5: item.evidence.volume / item.evidence.vma5,
        volume_threshold_ratio: item.evidence.volume_threshold_ratio,
        limit_up: item.evidence.limit_up,
      },
    })),
    screened_out: rightSide.items
      .filter((item) => !detailedRightSideItems.includes(item))
      .map((item) => ({ code: item.code, passed_count: item.passed_count })),
    gaps: rightSide.gaps,
  };
  const leftNearCandidates = finalizedLeftItems.filter((item) =>
    !item.price_signal && (item.stage === "reversal_pattern" || item.failed_conditions.length <= 1),
  );
  const leftMatches = finalizedLeftItems.filter((item) => item.signal === true);
  const leftDetailedCodes = new Set([...leftMatches, ...leftNearCandidates].map((item) => item.code));
  const compactLeftSide = {
    status: leftSide.status === "success" && finalizedLeftItems.every((item) => item.signal !== null)
      ? "success" as const : "partial" as const,
    data_date: leftSide.data_date,
    member_count: leftSide.member_count,
    stock_member_count: leftSide.stock_member_count,
    excluded_non_stock_count: leftSide.excluded_non_stock_count,
    completed_count: leftSide.completed_count,
    pattern_matched_count: leftSide.pattern_matched_count,
    matched_count: finalizedLeftItems.filter((item) => item.signal === true).length,
    near_candidate_count: leftNearCandidates.length,
    stage_distribution: Object.fromEntries(
      ["base_conditions", "reversal_pattern", "matched"].map((stage) => [
        stage,
        finalizedLeftItems.filter((item) => item.stage === stage).length,
      ]),
    ),
    matches: leftMatches,
    near_candidates: leftNearCandidates.map((item) => ({
      code: item.code,
      name: item.name,
      stage: item.stage,
      failed_conditions: item.failed_conditions,
      pattern: item.pattern,
      quality_score: item.quality_score,
    })),
    screened_out: finalizedLeftItems
      .filter((item) => !leftDetailedCodes.has(item.code))
      .map((item) => ({
        code: item.code,
        name: item.name,
        stage: item.stage,
        failed_conditions: item.failed_conditions,
        quality_score: item.quality_score,
      })),
    gaps: leftSide.gaps,
  };
  const trialNearCandidates = finalizedTrialItems.filter((item) =>
    !item.price_signal && item.conditions.trial_day_found && item.failed_conditions.length <= 2,
  );
  const trialMatches = finalizedTrialItems.filter((item) => item.signal === true);
  const trialDetailedCodes = new Set([...trialMatches, ...trialNearCandidates].map((item) => item.code));
  const compactTrial = {
    status: trial.status === "success" && environmentPassed !== null &&
      finalizedTrialItems.every((item) => item.signal !== null)
      ? "success" as const : "partial" as const,
    data_date: trial.data_date,
    member_count: trial.member_count,
    stock_member_count: trial.stock_member_count,
    excluded_non_stock_count: trial.excluded_non_stock_count,
    completed_count: trial.completed_count,
    pattern_matched_count: trial.pattern_matched_count,
    matched_count: finalizedTrialItems.filter((item) => item.signal === true).length,
    near_candidate_count: trialNearCandidates.length,
    stage_distribution: Object.fromEntries(
      ["signal_volume", "trial_day", "pullback_low", "pullback_volume", "breakout", "matched"].map((stage) => [
        stage,
        finalizedTrialItems.filter((item) => item.stage === stage).length,
      ]),
    ),
    matches: trialMatches,
    near_candidates: trialNearCandidates.map((item) => ({
      code: item.code,
      name: item.name,
      stage: item.stage,
      failed_conditions: item.failed_conditions,
      score: item.score,
      trial_date: item.evidence.trial_date,
    })),
    screened_out: finalizedTrialItems
      .filter((item) => !trialDetailedCodes.has(item.code))
      .map((item) => ({
        code: item.code,
        name: item.name,
        stage: item.stage,
        failed_conditions: item.failed_conditions,
        score: item.score,
      })),
    gaps: trial.gaps,
  };
  const selectedSignals = [
    ...rightSide.items.filter((item) => item.signal === true).map((item) => ({
      code: item.code,
      name: item.name,
      signal: "right_side" as const,
      score: 100 + 100 * clip(item.evidence.macd_hist_delta_ratio / 0.003, 0, 1),
    })),
    ...finalizedLeftItems.filter((item) => item.signal === true).map((item) => ({
      code: item.code,
      name: item.name,
      signal: "left_reversal" as const,
      score: item.quality_score,
    })),
    ...finalizedTrialItems.filter((item) => item.signal === true).map((item) => ({
      code: item.code,
      name: item.name,
      signal: "trial_start" as const,
      score: item.score,
    })),
  ].sort((left, right) => right.score - left.score || left.code.localeCompare(right.code));
  const unresolvedSelectionCount = rightSide.items.filter((item) => item.price_signal && item.signal === null).length +
    finalizedLeftItems.filter((item) => item.price_signal && item.signal === null).length +
    finalizedTrialItems.filter((item) => item.price_signal && item.signal === null).length;
  const temperatureStatus = sector.result.average_temperature === null
    ? (sector.input.available_codes > 0 ? "partial" : "unavailable")
    : "success";
  const gaps = [
    ...sector.gaps.map((gap) => ({ scope: "market", detail: gap })),
    ...structure.datasets.filter((item) => item.status !== "success").map((item) => ({
      scope: "market_structure",
      detail: { dataset: item.dataset, status: item.status, target_date: item.target_date },
    })),
    ...rightSide.gaps.map((gap) => ({ scope: "right_side_signal", detail: gap })),
    ...leftSide.gaps.map((gap) => ({ scope: "left_reversal_signal", detail: gap })),
    ...trial.gaps.map((gap) => ({ scope: "trial_signal", detail: gap })),
    ...positions.gaps.map((gap) => ({ scope: "position", detail: gap })),
  ];
  return {
    requested_date: date,
    status: gaps.length === 0 ? "success" as const : "partial" as const,
    market: {
      data_date: dataDate,
      temperature: {
        status: temperatureStatus,
        value: sector.result.average_temperature,
        state: sector.result.state,
        expected_boards: sector.input.requested_codes,
        available_boards: sector.input.available_codes,
      },
      regime: sector.result.market_regime,
    },
    market_structure_sync: structure,
    right_side_signal_scan: compactRightSide,
    left_reversal_scan: compactLeftSide,
    trial_start_scan: compactTrial,
    signal_selection: {
      status: unresolvedSelectionCount === 0 ? "success" as const : "partial" as const,
      priority: ["right_side", "left_reversal", "trial_start"],
      selected_count: selectedSignals.length,
      unresolved_count: unresolvedSelectionCount,
      items: selectedSignals,
    },
    positions,
    gaps,
  };
}
