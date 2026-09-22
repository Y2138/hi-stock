// 波段入场确定性扫描：独立扫描周期行业股票，负责四条件、执行窗口与数据缺口。
import type pg from "pg";

type Db = Pick<pg.Pool | pg.PoolClient, "query">;

export const SWING_CORE_INDUSTRY_CODES = [
  "881105.TI", "881107.TI", "881108.TI", "881112.TI", "881115.TI", "881137.TI", "881148.TI",
  "881168.TI", "881169.TI", "881170.TI", "881180.TI", "881264.TI", "881267.TI",
] as const;

export const SWING_EXPANDED_INDUSTRY_CODES = ["881266.TI", "881279.TI", "881280.TI"] as const;
export const SWING_INDUSTRY_CODES = [...SWING_CORE_INDUSTRY_CODES, ...SWING_EXPANDED_INDUSTRY_CODES] as const;
export const SWING_UNIVERSE_MAX_MEMBERS = 388;

export const SWING_SUBINDUSTRY_REPRESENTATIVE_LIMIT = 10;
export const SWING_NEAR_CANDIDATE_LIMIT = 5;

export interface SwingUniverseMember {
  instrument_id: string;
  code: string;
  name: string;
  industry_code: string;
  industry_name: string;
  source_scope: "core" | "expanded";
  median_turnover_60: number | null;
}

/** 每个细分先保留流动性前10名，其余标的按全域流动性补足，最终总量不超过固定上限。 */
export async function querySwingUniverse(db: Db, date: string): Promise<SwingUniverseMember[]> {
  const result = await db.query<SwingUniverseMember>(
    `WITH primary_members AS (
       SELECT DISTINCT ON (stock.id) stock.id AS instrument_id,stock.code,stock.name,
              industry.code AS industry_code,industry.name AS industry_name,
              COALESCE(secondary.code,industry.code) AS subindustry_code
         FROM market_board_membership relation
         JOIN market_board board ON board.instrument_id=relation.board_instrument_id
         JOIN market_instrument industry ON industry.id=relation.board_instrument_id
         JOIN market_instrument stock ON stock.id=relation.member_instrument_id
         LEFT JOIN LATERAL (
           SELECT child.code
             FROM market_board_membership child_relation
             JOIN market_board child_board ON child_board.instrument_id=child_relation.board_instrument_id
             JOIN market_instrument child ON child.id=child_relation.board_instrument_id
            WHERE child_relation.member_instrument_id=stock.id AND child.code LIKE '884%.TI'
              AND child_board.active=true AND child_board.source='hithink' AND child_board.board_type='industry'
              AND child_relation.effective_from <= $1::date
              AND (child_relation.effective_to IS NULL OR child_relation.effective_to > $1::date)
            ORDER BY child.code LIMIT 1
         ) secondary ON true
        WHERE industry.code=ANY($2::text[]) AND board.active=true AND board.source='hithink' AND board.board_type='industry'
          AND relation.effective_from <= $1::date AND (relation.effective_to IS NULL OR relation.effective_to > $1::date)
          AND stock.kind='stock' AND stock.lifecycle_status='active' AND stock.name !~* '^\\*?ST'
          AND stock.code ~ '^(600|601|603|605|000|001|002|003)'
        ORDER BY stock.id,industry.code
     ), liquidity AS (
       SELECT member.*,recent.median_turnover_60
         FROM primary_members member
         JOIN LATERAL (
           SELECT count(*) AS bar_count FROM (
             SELECT 1 FROM market_bar bar WHERE bar.instrument_id=member.instrument_id
               AND bar.freq='day' AND bar.bar_date <= $1::date
             ORDER BY bar.bar_date DESC,bar.bar_time DESC LIMIT 40
           ) history
         ) history ON history.bar_count=40
         LEFT JOIN LATERAL (
           SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY bars.turnover::float8)::float8 AS median_turnover_60
             FROM (SELECT bar.turnover FROM market_bar bar
                    WHERE bar.instrument_id=member.instrument_id AND bar.freq='day'
                      AND bar.bar_date <= $1::date AND bar.turnover > 0
                    ORDER BY bar.bar_date DESC,bar.bar_time DESC LIMIT 60) bars
         ) recent ON true
     ), ranked AS (
       SELECT liquidity.*,row_number() OVER (PARTITION BY industry_code,subindustry_code
                ORDER BY median_turnover_60 DESC NULLS LAST,code) AS subindustry_rank
         FROM liquidity
     )
     SELECT instrument_id::text,code,name,industry_code,industry_name,
            CASE WHEN industry_code=ANY($3::text[]) THEN 'expanded' ELSE 'core' END AS source_scope,
            median_turnover_60
       FROM ranked
      ORDER BY (subindustry_rank <= $4) DESC,median_turnover_60 DESC NULLS LAST,code
      LIMIT $5`,
    [date, [...SWING_INDUSTRY_CODES], [...SWING_EXPANDED_INDUSTRY_CODES],
     SWING_SUBINDUSTRY_REPRESENTATIVE_LIMIT, SWING_UNIVERSE_MAX_MEMBERS],
  );
  return result.rows;
}

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
    open: number;
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
      open: current.open,
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

/** 接近候选按唯一未达条件距阈值的归一化缺口排序，只保留最接近正式信号的前5只。 */
export function selectTopSwingNearCandidates<
  T extends SwingSignalEvaluation & { code: string },
>(items: T[]): Array<T & { signal_quality_score: number }> {
  return items
    .map((item) => {
      const failed = item.failed_conditions[0];
      const evidence = item.evidence;
      const gap = failed === "volume_contracted"
        ? evidence.volume_ratio_5 / 0.85 - 1
        : failed === "reversal_candle"
          ? Math.min(
              Math.max(0, (evidence.open - evidence.close) / evidence.close) / 0.01,
              Math.max(0, 0.005 - evidence.lower_shadow_ratio) / 0.005,
            )
          : failed === "rsi_oversold"
            ? evidence.rsi14 / 40 - 1
            : failed === "reward_risk_acceptable" && evidence.expected_reward_risk !== null
              ? 1 - evidence.expected_reward_risk / 1.8
              : 1;
      return {
        ...item,
        signal_quality_score: Math.round(Math.max(0, 1 - Math.max(0, gap)) * 1000) / 10,
      };
    })
    .sort((left, right) => right.signal_quality_score - left.signal_quality_score || left.code.localeCompare(right.code))
    .slice(0, SWING_NEAR_CANDIDATE_LIMIT);
}

export async function querySwingSignals(db: Db, date: string) {
  const universe = await querySwingUniverse(db, date);
  const universeCodes = universe.map((item) => item.code);
  const expandedMemberCount = universe.filter((item) => item.source_scope === "expanded").length;
  const members = await db.query<SwingMember>(
    `SELECT instrument.id::text AS instrument_id,instrument.code,instrument.name,instrument.kind,
            COALESCE(position.quantity,0)::float8 AS quantity,
            metric.as_of_date::text AS metric_date,metric_run.status AS metric_status,metric.defense_recovery_ma10
       FROM market_instrument instrument
       LEFT JOIN portfolio_position position ON position.instrument_id=instrument.id
       LEFT JOIN LATERAL (
         SELECT current.* FROM market_stock_character_metric current
          WHERE current.instrument_id=instrument.id AND current.as_of_date <= $1::date
          ORDER BY current.as_of_date DESC,current.computed_at DESC LIMIT 1
       ) metric ON true
       LEFT JOIN market_indicator_run metric_run ON metric_run.id=metric.indicator_run_id
      WHERE instrument.code=ANY($2::text[]) ORDER BY instrument.code`,
    [date, universeCodes],
  );
  const latest = await db.query<{ data_date: string | null }>(
    `SELECT max(bar.bar_date)::text AS data_date FROM market_bar bar
      JOIN market_instrument instrument ON instrument.id=bar.instrument_id
     WHERE instrument.code=ANY($2::text[]) AND bar.freq='day' AND bar.bar_date <= $1::date`,
    [date, universeCodes],
  );
  const dataDate = latest.rows[0]?.data_date ?? null;
  if (members.rows.length === 0) return {
    requested_date: date,
    scan_scope: "cyclical_industry_representatives" as const,
    industry_codes: [...SWING_INDUSTRY_CODES],
    max_member_count: SWING_UNIVERSE_MAX_MEMBERS,
    expanded_member_count: expandedMemberCount,
    status: "success" as const,
    data_date: dataDate,
    member_count: 0,
    completed_count: 0,
    matched_count: 0,
    signal_count: 0,
    held_matched_count: 0,
    near_candidate_count: 0,
    near_candidate_total_count: 0,
    near_candidate_limit: SWING_NEAR_CANDIDATE_LIMIT,
    signals: [],
    near_candidates: [],
    suppressed_matches: [],
    screened_out: [],
    excluded_count: 0,
    excluded: [],
    gaps: [],
  };

  const bars = await db.query<SwingSignalBar & { code: string }>(
    `WITH ranked AS (
       SELECT instrument.code,bar.bar_date::text,bar.open::float8,bar.high::float8,bar.low::float8,
              bar.close::float8,bar.volume::float8,indicator.rsi14::float8,indicator.status AS indicator_status,
              row_number() OVER (PARTITION BY bar.instrument_id ORDER BY bar.bar_date DESC,bar.bar_time DESC) AS row_no
         FROM market_instrument instrument
         JOIN market_bar bar ON bar.instrument_id=instrument.id AND bar.freq='day' AND bar.bar_date <= $1::date
         LEFT JOIN market_indicator_value indicator
           ON indicator.instrument_id=bar.instrument_id AND indicator.freq=bar.freq
          AND indicator.bar_date=bar.bar_date AND indicator.bar_time=bar.bar_time
        WHERE instrument.code=ANY($2::text[])
     )
     SELECT code,bar_date,open,high,low,close,volume,rsi14,indicator_status
       FROM ranked WHERE row_no <= 40 ORDER BY code,bar_date`,
    [date, universeCodes],
  );
  const byCode = new Map<string, SwingSignalBar[]>();
  for (const bar of bars.rows) byCode.set(bar.code, [...(byCode.get(bar.code) ?? []), bar]);

  const excluded: Array<{ code: string; reason: string }> = [];
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
      excluded.push({ code: member.code, reason: `波段扫描不支持标的类型 ${member.kind}` });
      continue;
    }
    if (rows.length < 40) {
      excluded.push({ code: member.code, reason: `波段扫描至少需要40根日线，当前${rows.length}根` });
      continue;
    }
    if (dataDate && rows.at(-1)!.bar_date !== dataDate) {
      excluded.push({ code: member.code, reason: `最新日线为${rows.at(-1)!.bar_date}，波段数据日为${dataDate}` });
      continue;
    }
    if (member.kind === "stock" && (
      member.metric_date !== dataDate || member.metric_status !== "success" || member.defense_recovery_ma10 === null
    )) {
      excluded.push({ code: member.code, reason: "缺少数据日一致的可信护盘收回率" });
      continue;
    }
    const evaluation = evaluateSwingSignal(rows, member.kind, member.defense_recovery_ma10);
    if (!evaluation) {
      excluded.push({ code: member.code, reason: "波段扫描缺少可信RSI14/OHLCV或止损输入" });
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
  const allNearCandidates = items.filter((item) =>
    !item.held && !item.price_signal && item.passed_count === 3 && item.evidence.confirmation_window_available,
  );
  const nearCandidates = selectTopSwingNearCandidates(allNearCandidates);
  const suppressedMatches = items.filter((item) => item.price_signal && !item.signal);
  const detailedCodes = new Set([...signals, ...nearCandidates, ...suppressedMatches].map((item) => item.code));
  return {
    requested_date: date,
    scan_scope: "cyclical_industry_representatives" as const,
    industry_codes: [...SWING_INDUSTRY_CODES],
    max_member_count: SWING_UNIVERSE_MAX_MEMBERS,
    expanded_member_count: expandedMemberCount,
    status: items.length > 0 ? "success" as const : "partial" as const,
    data_date: dataDate,
    member_count: members.rows.length,
    completed_count: items.length,
    matched_count: items.filter((item) => item.price_signal).length,
    signal_count: signals.length,
    held_matched_count: items.filter((item) => item.price_signal && item.held).length,
    near_candidate_count: nearCandidates.length,
    near_candidate_total_count: allNearCandidates.length,
    near_candidate_limit: SWING_NEAR_CANDIDATE_LIMIT,
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
    excluded_count: excluded.length,
    excluded,
    gaps: items.length ? [] : [{ reason: "候选均因数据不可信被剔除，无法完成有效扫描", excluded_count: excluded.length }],
  };
}
