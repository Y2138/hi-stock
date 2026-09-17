// 每日计划确定性上下文：服务层完成机械计算，只向 Agent 返回紧凑结论与覆盖计数。
// 开仓信号只来自独立的波段扫描（swing_signal_query）；本文件的右侧/试盘扫描是评估性输出：
// 右侧条件存活复核用于持有判断，试盘形态推进用于关注标的上涨概率评估。
import type pg from "pg";
import { evaluateRightSideSignal, type RightSideSignalBar, type RightSideSignalEvaluation } from "./right-side-rule.js";
export { evaluateRightSideSignal, type RightSideSignalBar, type RightSideSignalEvaluation } from "./right-side-rule.js";
import { querySectorTemperature } from "../../analysis/service.js";
import { queryRiskGate, recordDailyEquity } from "./risk-gate.js";
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
  pool: "watch" | null;
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
  entry_signal_type: "right_side" | "left_reversal" | "two_year_reversal" | "trial_start" | "swing" | "limit_up" | "discretionary" | null;
  entry_buy_date: string | null;
  current_close: number | null;
  entry_metric_date: string | null;
  entry_defense_recovery_ma10: number | null;
  entry_metric_status: string | null;
}

/** 波段与左侧持仓触发位的公共输入：买入日前（含信号日）的最近日线窗口。 */
interface EntryWindowBar {
  code: string;
  bar_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface SwingPositionTriggers {
  basis: "每日计划策略 §1.1-1.2";
  holding_trade_days: number;
  observation_window_days: 10;
  observation_active: boolean;
  disaster_stop: number;
  character_stop: number | null;
  box_floor_stop: number | null;
  regular_stop: number | null;
  box_top_40d: number | null;
  target_price: number | null;
  profit_protection_level: number | null;
  max_holding_days: 60;
  time_exit_due: boolean;
  next_open_exit_candidate: "disaster_stop" | "regular_stop" | "time_exit" | null;
  scope: string;
}

export interface LeftReversalPositionTriggers {
  basis: "每日计划策略 §3.2（存量）";
  holding_trade_days: number;
  initial_stop: number | null;
  signal_day_atr14: number | null;
  first_scale_trigger: number;
  second_scale_trigger: number;
  first_scale_reached: boolean;
  second_scale_reached: boolean;
  close_profit_18pct_reached: boolean | null;
  after_first_scale_protection: number | null;
  after_second_scale_protection: number | null;
  max_holding_days: 10;
  time_exit_due: boolean;
  next_open_exit_candidate: "stop_breach" | "time_exit" | null;
  scope: string;
}

export type PositionEvaluationBasis = "swing" | "left_reversal" | "two_year_reversal" | "short_term" | "manual";

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
  return [stockCharacter ?? "", ...(Array.isArray(tags) ? tags : [])].join("·");
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
      WHERE membership.pool = 'watch' AND membership.effective_to IS NULL
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
        WHERE membership.pool = 'watch' AND membership.effective_to IS NULL
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

async function scanRightSideSignals(
  db: Db,
  date: string,
  expectedDataDate: string | null,
) {
  const members = await db.query<PoolMember>(
    `SELECT membership.instrument_id::text, instrument.code, instrument.name, instrument.kind
       FROM pool_membership membership
       JOIN market_instrument instrument ON instrument.id = membership.instrument_id
      WHERE membership.pool = 'watch' AND membership.effective_to IS NULL
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
        WHERE membership.pool = 'watch' AND membership.effective_to IS NULL
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
    });
  }
  return {
    status: gaps.length === 0 ? "success" as const : "partial" as const,
    data_date: expectedDataDate,
    member_count: members.rows.length,
    stock_member_count: stockMembers.length,
    excluded_non_stock_count: members.rows.length - stockMembers.length,
    completed_count: items.length,
    matched_count: items.filter((item) => item.price_signal).length,
    items,
    gaps,
  };
}

/** 波段与左侧持仓共用窗口：买入日（不含）之前最近 40 根日线，末根即信号日（T 日，T+1 买入）。 */
async function loadEntryWindows(
  db: Db,
  targets: Array<{ code: string; buy_date: string }>,
): Promise<Map<string, EntryWindowBar[]>> {
  if (targets.length === 0) return new Map();
  const bars = await db.query<EntryWindowBar>(
    `WITH targets AS (
       SELECT * FROM unnest($1::text[], $2::date[]) AS targets(code, buy_date)
     ), ranked AS (
       SELECT targets.code, bar.bar_date::text,
              bar.open::float8, bar.high::float8, bar.low::float8, bar.close::float8, bar.volume::float8,
              row_number() OVER (PARTITION BY targets.code ORDER BY bar.bar_date DESC, bar.bar_time DESC) AS row_no
         FROM targets
         JOIN market_instrument instrument ON instrument.code = targets.code
         JOIN market_bar bar ON bar.instrument_id = instrument.id AND bar.freq = 'day'
                            AND bar.bar_date < targets.buy_date
     )
     SELECT code, bar_date, open, high, low, close, volume
       FROM ranked WHERE row_no <= 40 ORDER BY code, bar_date`,
    [targets.map((target) => target.code), targets.map((target) => target.buy_date)],
  );
  const byCode = new Map<string, EntryWindowBar[]>();
  for (const bar of bars.rows) byCode.set(bar.code, [...(byCode.get(bar.code) ?? []), bar]);
  return byCode;
}

/** 每日计划策略 §1.1-1.2：波段持仓的观察期、灾难止损、常规止损、箱顶目标与到期。 */
function buildSwingTriggers(
  row: PositionContextRow,
  bars: EntryWindowBar[],
  pushGap: (reason: string) => void,
): { triggers: SwingPositionTriggers; resolved: boolean } {
  const cost = row.cost_price;
  const disasterStop = roundPrice(cost * 0.75);
  const observationActive = row.holding_trade_days <= 10;
  let boxFloor: number | null = null;
  let boxTop: number | null = null;
  if (bars.length >= 40) {
    boxFloor = Math.min(...bars.map((bar) => bar.low));
    boxTop = Math.max(...bars.map((bar) => bar.high));
  } else {
    pushGap(`波段持仓买入日前历史日线不足40根（当前${bars.length}根），箱体边界与目标价无法计算`);
  }
  // 股性止损用入场时点（买入日前最新）护盘收回率；ETF 无股性画像，只取箱体边界分支。
  let characterStop: number | null = null;
  if (row.kind === "stock") {
    if (row.entry_metric_status === "success" && row.entry_defense_recovery_ma10 !== null) {
      characterStop = row.entry_defense_recovery_ma10 >= 0.5 ? cost * 0.9 : cost * 0.93;
    } else {
      pushGap("波段持仓缺少买入日前可信护盘收回率，股性止损无法确定");
    }
  }
  const boxFloorStop = boxFloor === null ? null : roundPrice(boxFloor * 0.97);
  const stopCandidates = [characterStop, boxFloorStop].filter((value): value is number => value !== null);
  const regularStop = stopCandidates.length === 0
    ? null
    : roundPrice(Math.min(cost * 0.99, Math.max(...stopCandidates)));
  const highestCloseRatio = row.highest_close === null ? null : row.highest_close / cost - 1;
  const profitProtection = highestCloseRatio === null ? null
    : highestCloseRatio >= 0.15 ? roundPrice(cost * 1.05)
      : highestCloseRatio >= 0.08 ? roundPrice(cost) : null;
  const timeExitDue = row.holding_trade_days >= 60;
  let nextOpenExitCandidate: SwingPositionTriggers["next_open_exit_candidate"] = null;
  if (row.current_close !== null && observationActive && row.current_close <= disasterStop) {
    nextOpenExitCandidate = "disaster_stop";
  } else if (row.current_close !== null && !observationActive && regularStop !== null && row.current_close <= regularStop) {
    nextOpenExitCandidate = "regular_stop";
  } else if (timeExitDue) {
    nextOpenExitCandidate = "time_exit";
  }
  return {
    triggers: {
      basis: "每日计划策略 §1.1-1.2",
      holding_trade_days: row.holding_trade_days,
      observation_window_days: 10,
      observation_active: observationActive,
      disaster_stop: disasterStop,
      character_stop: characterStop === null ? null : roundPrice(characterStop),
      box_floor_stop: boxFloorStop,
      regular_stop: regularStop,
      box_top_40d: boxTop === null ? null : roundPrice(boxTop),
      target_price: boxTop === null ? null : roundPrice(boxTop * 0.95),
      profit_protection_level: profitProtection,
      max_holding_days: 60,
      time_exit_due: timeExitDue,
      next_open_exit_candidate: nextOpenExitCandidate,
      scope: "收盘破位次日开盘执行；箱顶×0.95 卖剩余一半后浮盈保护位生效；§3.4 突破后移动止盈未机械计算，按策略正文管理",
    },
    resolved: bars.length >= 40 && (row.kind !== "stock" ||
      (row.entry_metric_status === "success" && row.entry_defense_recovery_ma10 !== null)),
  };
}

/** 每日计划策略 §3.2（存量口径）：左侧反转持仓的初始止损、分批触发与到期。 */
function buildLeftReversalTriggers(
  row: PositionContextRow,
  bars: EntryWindowBar[],
  pushGap: (reason: string) => void,
): { triggers: LeftReversalPositionTriggers; resolved: boolean } {
  const cost = row.cost_price;
  const signalDayAtr14 = atr14(bars);
  if (signalDayAtr14 === null) {
    pushGap(`左侧持仓买入日前历史日线不足15根（当前${bars.length}根），信号日ATR14无法计算`);
  }
  const initialStop = signalDayAtr14 === null
    ? null
    : roundPrice(Math.max(cost - signalDayAtr14, cost * 0.93));
  const firstScaleTrigger = roundPrice(cost * 1.06);
  const secondScaleTrigger = roundPrice(cost * 1.16);
  const firstScaleReached = row.highest_high !== null && row.highest_high >= firstScaleTrigger;
  const secondScaleReached = row.highest_high !== null && row.highest_high >= secondScaleTrigger;
  const closeProfit18Reached = row.highest_close === null
    ? null
    : row.highest_close >= cost * 1.18;
  const ma5Available = row.indicator_status === "ready" && row.ma5 !== null;
  if ((firstScaleReached || closeProfit18Reached === true) && !ma5Available) {
    pushGap("左侧持仓已触发分批但缺少可信MA5，触发后保护位无法计算");
  }
  const afterFirstScaleProtection = firstScaleReached && ma5Available
    ? roundPrice(Math.max(cost * 1.02, row.ma5! * 0.98))
    : null;
  const afterSecondScaleProtection = secondScaleReached && ma5Available && row.highest_close !== null
    ? roundPrice(Math.max(
        ...(initialStop === null ? [] : [initialStop]),
        cost * 1.06,
        row.highest_close * 0.9,
        row.ma5! * 0.98,
      ))
    : null;
  const activeProtection = afterSecondScaleProtection ?? afterFirstScaleProtection ?? initialStop;
  const timeExitDue = row.holding_trade_days >= 10;
  let nextOpenExitCandidate: LeftReversalPositionTriggers["next_open_exit_candidate"] = null;
  if (row.current_close !== null && activeProtection !== null && row.current_close <= activeProtection) {
    nextOpenExitCandidate = "stop_breach";
  } else if (timeExitDue) {
    nextOpenExitCandidate = "time_exit";
  }
  return {
    triggers: {
      basis: "每日计划策略 §3.2（存量）",
      holding_trade_days: row.holding_trade_days,
      initial_stop: initialStop,
      signal_day_atr14: signalDayAtr14,
      first_scale_trigger: firstScaleTrigger,
      second_scale_trigger: secondScaleTrigger,
      first_scale_reached: firstScaleReached,
      second_scale_reached: secondScaleReached,
      close_profit_18pct_reached: closeProfit18Reached,
      after_first_scale_protection: afterFirstScaleProtection,
      after_second_scale_protection: afterSecondScaleProtection,
      max_holding_days: 10,
      time_exit_due: timeExitDue,
      next_open_exit_candidate: nextOpenExitCandidate,
      scope: "初始止损与保护位均收盘判定、次日开盘执行；6%/16% 分批按100股取整；18%收盘浮盈启用第二档后移动保护",
    },
    resolved: signalDayAtr14 !== null && (!firstScaleReached || ma5Available),
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
            position.entry_signal_type,
            membership.pool, membership.role, COALESCE(membership.tags, '[]'::jsonb) AS tags, membership.stock_character,
            indicator.bar_date::text AS indicator_date,
            indicator.ma5::float8, indicator.ma10::float8, indicator.status AS indicator_status,
            metric.as_of_date::text AS metric_date, metric.calculation_version,
            metric.input_row_count, metric.defense_break_count, metric.defense_recovered_count,
            metric.defense_recovery_ma10,
            metric_run.status AS metric_run_status,
            COALESCE(holding.holding_trade_days, 0)::int AS holding_trade_days,
            holding.highest_high::float8, holding.highest_close::float8,
            COALESCE(entry_buy.change_date, position.opened_at)::text AS entry_buy_date,
            lastbar.close::float8 AS current_close,
            entry_metric.as_of_date::text AS entry_metric_date,
            entry_metric.defense_recovery_ma10::float8 AS entry_defense_recovery_ma10,
            entry_metric_run.status AS entry_metric_status
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
         SELECT change.change_date
           FROM portfolio_position_change change
          WHERE change.instrument_id = position.instrument_id AND change.kind = 'buy'
            AND position.opened_at IS NOT NULL
            AND change.change_date >= position.opened_at
          ORDER BY change.change_date DESC, change.id DESC LIMIT 1
       ) entry_buy ON true
       LEFT JOIN LATERAL (
         SELECT bar.close
           FROM market_bar bar
          WHERE bar.instrument_id = position.instrument_id AND bar.freq = 'day'
            AND bar.bar_date <= $1::date
          ORDER BY bar.bar_date DESC, bar.bar_time DESC LIMIT 1
       ) lastbar ON true
       LEFT JOIN LATERAL (
         SELECT current.as_of_date, current.defense_recovery_ma10, current.indicator_run_id
           FROM market_stock_character_metric current
          WHERE current.instrument_id = position.instrument_id
            AND COALESCE(entry_buy.change_date, position.opened_at) IS NOT NULL
            AND current.as_of_date < COALESCE(entry_buy.change_date, position.opened_at)
          ORDER BY current.as_of_date DESC, current.computed_at DESC LIMIT 1
       ) entry_metric ON true
       LEFT JOIN market_indicator_run entry_metric_run ON entry_metric_run.id = entry_metric.indicator_run_id
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
  const entryWindows = await loadEntryWindows(db, rows.rows
    .filter((row) => row.entry_signal_type === "swing" || row.entry_signal_type === "left_reversal")
    .map((row) => ({ code: row.code, buy_date: row.entry_buy_date }))
    .filter((target): target is { code: string; buy_date: string } => target.buy_date !== null));
  const gaps: Array<{ code: string; reason: string }> = [];
  const swingItems: Array<{ code: string; resolved: boolean }> = [];
  const leftReversalItems: Array<{ code: string; resolved: boolean }> = [];
  const items = rows.rows.map((row) => {
    if (row.pool === null) gaps.push({ code: row.code, reason: "持仓缺少当前策略角色" });
    // 评估口径由买入信号类型决定：波段与左侧（存量）独立评估；其余回退短线口径做持有评估。
    const evaluationBasis: PositionEvaluationBasis = row.entry_signal_type === "swing"
      ? "swing"
      : row.entry_signal_type === "left_reversal"
        ? "left_reversal"
        : row.entry_signal_type === "two_year_reversal" ? "two_year_reversal" : "short_term";
    if (evaluationBasis === "two_year_reversal") gaps.push({ code: row.code, reason: "两年结构反转新策略持仓按独立策略A方案人工核对风险线、MA20分批与ATR移动止损；旧左侧和短线退出位不适用" });
    const stopRequired = evaluationBasis === "short_term";
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
    const swing = row.entry_signal_type === "swing"
      ? buildSwingTriggers(row, entryWindows.get(row.code) ?? [], (reason) => gaps.push({ code: row.code, reason }))
      : null;
    if (swing) swingItems.push({ code: row.code, resolved: swing.resolved });
    const leftReversal = row.entry_signal_type === "left_reversal"
      ? buildLeftReversalTriggers(row, entryWindows.get(row.code) ?? [], (reason) => gaps.push({ code: row.code, reason }))
      : null;
    if (leftReversal) leftReversalItems.push({ code: row.code, resolved: leftReversal.resolved });
    return {
      code: row.code,
      name: row.name,
      kind: row.kind,
      quantity: row.quantity,
      cost_price: row.cost_price,
      opened_at: row.opened_at,
      entry_signal_type: row.entry_signal_type,
      entry_buy_date: row.entry_buy_date,
      evaluation_basis: evaluationBasis,
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
      swing_triggers: swing?.triggers ?? null,
      left_reversal_triggers: leftReversal?.triggers ?? null,
      indicator_date: row.indicator_date,
      defense_recovery_ma10: metricReady ? row.defense_recovery_ma10 : null,
      defense_break_count: metricReady ? row.defense_break_count : null,
      defense_recovered_count: metricReady ? row.defense_recovered_count : null,
      defense_metric_date: metricReady ? row.metric_date : null,
      defense_metric_input_rows: metricReady ? row.input_row_count : null,
      defense_metric_version: metricReady ? row.calculation_version : null,
    };
  });
  const positionBasis = (row: PositionContextRow): PositionEvaluationBasis =>
    row.entry_signal_type === "swing" ? "swing"
      : row.entry_signal_type === "left_reversal" ? "left_reversal"
        : row.entry_signal_type === "two_year_reversal" ? "two_year_reversal" : "short_term";
  const requiredStops = rows.rows.filter((row) => positionBasis(row) === "short_term");
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
    swing_position_count: swingItems.length,
    swing_stop_resolved_count: swingItems.filter((item) => item.resolved).length,
    left_reversal_position_count: leftReversalItems.length,
    left_reversal_stop_resolved_count: leftReversalItems.filter((item) => item.resolved).length,
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
  const [structure, trial, rightSide] = await Promise.all([
    queryStructureSync(db, date),
    scanTrialSignals(db, date, dataDate),
    scanRightSideSignals(db, date, dataDate),
  ]);
  // 试盘是评估性输出：stage/price_signal 描述形态推进程度，用于关注标的上涨概率评估，不产生开仓信号。
  const finalizedTrialItems = trial.items.map((item) => ({
    ...item,
    next_open_price_cap: roundPrice(item.evidence.close * 1.05),
  }));
  const positions = await queryPositionContext(
    db,
    date,
    dataDate,
    new Map(rightSide.items.map((item) => [item.code, item])),
  );
  const positionCodes = new Set(positions.items.map((item) => item.code));
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
    passed_count_distribution: Object.fromEntries(
      Array.from({ length: 7 }, (_, passedCount) => [
        String(passedCount),
        rightSide.items.filter((item) => item.passed_count === passedCount).length,
      ]),
    ),
    evaluation_note: "右侧为持有评估：存活项数支撑继续持有判断，m<=2 且未触发一档止盈提示崩坏退出；不是开仓信号",
    detailed_selection: "通过项数不少于4，或属于当前持仓",
    items: detailedRightSideItems.map((item) => ({
      code: item.code,
      name: item.name,
      as_of: item.as_of,
      passed_count: item.passed_count,
      price_signal: item.price_signal,
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
  const trialNearCandidates = finalizedTrialItems.filter((item) =>
    !item.price_signal && item.conditions.trial_day_found && item.failed_conditions.length <= 2,
  );
  const trialMatches = finalizedTrialItems.filter((item) => item.price_signal);
  const trialDetailedCodes = new Set([...trialMatches, ...trialNearCandidates].map((item) => item.code));
  const compactTrial = {
    status: trial.status,
    evaluation_note: "试盘为上涨概率评估：形态推进越完整概率越高；不是开仓信号，不单独写入关注",
    data_date: trial.data_date,
    member_count: trial.member_count,
    stock_member_count: trial.stock_member_count,
    excluded_non_stock_count: trial.excluded_non_stock_count,
    completed_count: trial.completed_count,
    pattern_matched_count: trial.pattern_matched_count,
    matched_count: trialMatches.length,
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
  const temperatureStatus = sector.result.average_temperature === null
    ? (sector.input.available_codes > 0 ? "partial" : "unavailable")
    : "success";
  // 风控三件套（采纳层）：生成当日计划时物化净值快照并输出开仓闸门判定。
  await recordDailyEquity(db, date).catch(() => false);
  const riskGate = await queryRiskGate(db, date);
  const gaps = [
    ...sector.gaps.map((gap) => ({ scope: "market", detail: gap })),
    ...structure.datasets.filter((item) => item.status !== "success").map((item) => ({
      scope: "market_structure",
      detail: { dataset: item.dataset, status: item.status, target_date: item.target_date },
    })),
    ...rightSide.gaps.map((gap) => ({ scope: "right_side_evaluation", detail: gap })),
    ...trial.gaps.map((gap) => ({ scope: "trial_evaluation", detail: gap })),
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
    risk_gate: riskGate,
    right_side_evaluation: compactRightSide,
    trial_evaluation: compactTrial,
    positions,
    gaps,
  };
}
