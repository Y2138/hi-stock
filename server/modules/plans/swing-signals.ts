// 波段入场确定性扫描：只负责长线池“波段”角色的四条件、执行窗口与数据缺口。
import type pg from "pg";

type Db = Pick<pg.Pool | pg.PoolClient, "query">;

interface SwingMember {
  instrument_id: string;
  code: string;
  name: string;
  kind: string;
  quantity: number;
  metric_date: string | null;
  metric_status: string | null;
  defense_recovery_ma10: number | null;
}

export interface SwingSignalBar {
  bar_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  rsi14: number | null;
  indicator_status: "ready" | "untrusted" | null;
}

export interface SwingSignalEvaluation {
  as_of: string;
  passed_count: number;
  price_signal: boolean;
  failed_conditions: string[];
  conditions: {
    volume_contracted: boolean;
    reversal_candle: boolean;
    rsi_oversold: boolean;
    reward_risk_acceptable: boolean;
  };
  evidence: {
    close: number;
    high: number;
    volume: number;
    volume_ma5: number;
    volume_ratio_5: number;
    lower_shadow_ratio: number;
    rsi14: number;
    box_top_40d: number;
    target_price: number;
    box_floor_20d: number;
    defense_recovery_ma10: number | null;
    stock_character_stop: number | null;
    initial_stop: number;
    expected_reward_risk: number | null;
    confirmation_must_exceed: number;
    confirmation_price_cap: number;
    confirmation_window_available: boolean;
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundPrice(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 使用 T 日收盘价评估四条件；T+1 突破与价格上限作为执行窗口单独返回。 */
export function evaluateSwingSignal(
  rows: SwingSignalBar[],
  kind: string,
  defenseRecoveryMa10: number | null,
): SwingSignalEvaluation | null {
  if (rows.length < 40 || !["stock", "etf"].includes(kind)) return null;
  const current = rows.at(-1)!;
  const recentVolumes = rows.slice(-5).map((row) => row.volume);
  const required = [current.open, current.high, current.low, current.close, current.rsi14, ...recentVolumes];
  if (current.indicator_status !== "ready" || required.some((value) => value === null || !Number.isFinite(value)) ||
      current.close <= 0 || recentVolumes.some((value) => value! <= 0) ||
      (kind === "stock" && (defenseRecoveryMa10 === null || !Number.isFinite(defenseRecoveryMa10)))) return null;

  const volumeMa5 = average(recentVolumes as number[]);
  const lowerShadowRatio = (Math.min(current.open, current.close) - current.low) / current.close;
  const boxTop = Math.max(...rows.map((row) => row.high));
  const boxFloor = Math.min(...rows.slice(-20).map((row) => row.low));
  const targetPrice = roundPrice(boxTop * 0.95);
  const stockCharacterStop = kind === "stock"
    ? roundPrice(current.close * (defenseRecoveryMa10! >= 0.5 ? 0.9 : 0.93))
    : null;
  const boxStop = roundPrice(boxFloor * 0.97);
  const initialStop = kind === "etf"
    ? boxStop
    : roundPrice(Math.min(current.close * 0.99, Math.max(stockCharacterStop!, boxStop)));
  const risk = current.close - initialStop;
  const expectedRewardRisk = risk > 0 ? (targetPrice - current.close) / risk : null;
  const conditions = {
    volume_contracted: current.volume! < volumeMa5 * 0.85,
    reversal_candle: current.close > current.open || lowerShadowRatio > 0.005,
    rsi_oversold: current.rsi14! < 40,
    reward_risk_acceptable: expectedRewardRisk !== null && expectedRewardRisk >= 1.8,
  };
  const failedConditions = Object.entries(conditions)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const confirmationPriceCap = roundPrice(current.close * 1.05);
  return {
    as_of: current.bar_date,
    passed_count: 4 - failedConditions.length,
    price_signal: failedConditions.length === 0,
    failed_conditions: failedConditions,
    conditions,
    evidence: {
      close: current.close,
      high: current.high,
      volume: current.volume!,
      volume_ma5: volumeMa5,
      volume_ratio_5: current.volume! / volumeMa5,
      lower_shadow_ratio: lowerShadowRatio,
      rsi14: current.rsi14!,
      box_top_40d: boxTop,
      target_price: targetPrice,
      box_floor_20d: boxFloor,
      defense_recovery_ma10: kind === "stock" ? defenseRecoveryMa10 : null,
      stock_character_stop: stockCharacterStop,
      initial_stop: initialStop,
      expected_reward_risk: expectedRewardRisk,
      confirmation_must_exceed: current.high,
      confirmation_price_cap: confirmationPriceCap,
      confirmation_window_available: current.high < confirmationPriceCap,
    },
  };
}

export async function querySwingSignals(db: Db, date: string) {
  const members = await db.query<SwingMember>(
    `SELECT membership.instrument_id::text, instrument.code, instrument.name, instrument.kind,
            COALESCE(position.quantity, 0)::float8 AS quantity,
            metric.as_of_date::text AS metric_date, metric_run.status AS metric_status,
            metric.defense_recovery_ma10
       FROM pool_membership membership
       JOIN market_instrument instrument ON instrument.id = membership.instrument_id
       LEFT JOIN portfolio_position position ON position.instrument_id = membership.instrument_id
       LEFT JOIN LATERAL (
         SELECT current.*
           FROM market_stock_character_metric current
          WHERE current.instrument_id = membership.instrument_id AND current.as_of_date <= $1::date
          ORDER BY current.as_of_date DESC, current.computed_at DESC LIMIT 1
       ) metric ON true
       LEFT JOIN market_indicator_run metric_run ON metric_run.id = metric.indicator_run_id
      WHERE membership.pool = 'long' AND membership.role = '波段' AND membership.effective_to IS NULL
      ORDER BY instrument.code`,
    [date],
  );
  const latest = await db.query<{ data_date: string | null }>(
    `SELECT max(bar.bar_date)::text AS data_date
       FROM pool_membership membership
       JOIN market_bar bar ON bar.instrument_id = membership.instrument_id
                          AND bar.freq = 'day' AND bar.bar_date <= $1::date
      WHERE membership.pool = 'long' AND membership.role = '波段' AND membership.effective_to IS NULL`,
    [date],
  );
  const dataDate = latest.rows[0]?.data_date ?? null;
  if (members.rows.length === 0) return {
    requested_date: date,
    status: "success" as const,
    data_date: dataDate,
    member_count: 0,
    completed_count: 0,
    matched_count: 0,
    signal_count: 0,
    held_matched_count: 0,
    near_candidate_count: 0,
    signals: [],
    near_candidates: [],
    suppressed_matches: [],
    screened_out: [],
    gaps: [],
  };

  const bars = await db.query<SwingSignalBar & { code: string }>(
    `WITH ranked AS (
       SELECT instrument.code, bar.bar_date::text,
              bar.open::float8, bar.high::float8, bar.low::float8, bar.close::float8,
              bar.volume::float8, indicator.rsi14::float8, indicator.status AS indicator_status,
              row_number() OVER (
                PARTITION BY bar.instrument_id ORDER BY bar.bar_date DESC, bar.bar_time DESC
              ) AS row_no
         FROM pool_membership membership
         JOIN market_instrument instrument ON instrument.id = membership.instrument_id
         JOIN market_bar bar ON bar.instrument_id = membership.instrument_id
                            AND bar.freq = 'day' AND bar.bar_date <= $1::date
         LEFT JOIN market_indicator_value indicator
           ON indicator.instrument_id = bar.instrument_id AND indicator.freq = bar.freq
          AND indicator.bar_date = bar.bar_date AND indicator.bar_time = bar.bar_time
        WHERE membership.pool = 'long' AND membership.role = '波段' AND membership.effective_to IS NULL
     )
     SELECT code, bar_date, open, high, low, close, volume, rsi14, indicator_status
       FROM ranked WHERE row_no <= 40 ORDER BY code, bar_date`,
    [date],
  );
  const byCode = new Map<string, SwingSignalBar[]>();
  for (const bar of bars.rows) byCode.set(bar.code, [...(byCode.get(bar.code) ?? []), bar]);

  const gaps: Array<{ code: string; reason: string }> = [];
  const items: Array<SwingSignalEvaluation & {
    code: string;
    name: string;
    kind: string;
    held: boolean;
    signal: boolean;
    suppressed_by: "existing_position" | "price_cap" | null;
  }> = [];
  for (const member of members.rows) {
    const rows = byCode.get(member.code) ?? [];
    if (!["stock", "etf"].includes(member.kind)) {
      gaps.push({ code: member.code, reason: `波段扫描不支持标的类型 ${member.kind}` });
      continue;
    }
    if (rows.length < 40) {
      gaps.push({ code: member.code, reason: `波段扫描至少需要40根日线，当前${rows.length}根` });
      continue;
    }
    if (dataDate && rows.at(-1)!.bar_date !== dataDate) {
      gaps.push({ code: member.code, reason: `最新日线为${rows.at(-1)!.bar_date}，波段数据日为${dataDate}` });
      continue;
    }
    if (member.kind === "stock" && (
      member.metric_date !== dataDate || member.metric_status !== "success" || member.defense_recovery_ma10 === null
    )) {
      gaps.push({ code: member.code, reason: "缺少数据日一致的可信护盘收回率" });
      continue;
    }
    const evaluation = evaluateSwingSignal(rows, member.kind, member.defense_recovery_ma10);
    if (!evaluation) {
      gaps.push({ code: member.code, reason: "波段扫描缺少可信RSI14/OHLCV或止损输入" });
      continue;
    }
    const held = member.quantity > 0;
    const priceCapBlocked = evaluation.price_signal && !evaluation.evidence.confirmation_window_available;
    items.push({
      code: member.code,
      name: member.name,
      kind: member.kind,
      held,
      ...evaluation,
      signal: evaluation.price_signal && !held && !priceCapBlocked,
      suppressed_by: evaluation.price_signal
        ? held ? "existing_position" : priceCapBlocked ? "price_cap" : null
        : null,
    });
  }
  const signals = items.filter((item) => item.signal);
  const nearCandidates = items.filter((item) =>
    !item.held && !item.price_signal && item.passed_count === 3 && item.evidence.confirmation_window_available,
  );
  const suppressedMatches = items.filter((item) => item.price_signal && !item.signal);
  const detailedCodes = new Set([...signals, ...nearCandidates, ...suppressedMatches].map((item) => item.code));
  return {
    requested_date: date,
    status: gaps.length === 0 ? "success" as const : "partial" as const,
    data_date: dataDate,
    member_count: members.rows.length,
    completed_count: items.length,
    matched_count: items.filter((item) => item.price_signal).length,
    signal_count: signals.length,
    held_matched_count: items.filter((item) => item.price_signal && item.held).length,
    near_candidate_count: nearCandidates.length,
    signals,
    near_candidates: nearCandidates,
    suppressed_matches: suppressedMatches,
    screened_out: items
      .filter((item) => !detailedCodes.has(item.code))
      .map((item) => ({
        code: item.code,
        name: item.name,
        passed_count: item.passed_count,
        failed_conditions: item.failed_conditions,
      })),
    gaps,
  };
}
