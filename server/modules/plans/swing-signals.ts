// 波段入场确定性扫描：独立扫描周期行业股票，负责四条件、执行窗口与数据缺口。
import type pg from "pg";
import { strategyAttentionCodes } from "../pools/attention-lifecycle.js";

type Db = Pick<pg.Pool | pg.PoolClient, "query">;

export const SWING_CORE_INDUSTRY_CODES = [
  "881105.TI", "881107.TI", "881108.TI", "881112.TI", "881115.TI", "881137.TI", "881148.TI",
  "881168.TI", "881169.TI", "881170.TI", "881180.TI", "881264.TI", "881267.TI",
] as const;

export const SWING_EXPANDED_INDUSTRY_CODES = ["881266.TI", "881279.TI", "881280.TI"] as const;
export const SWING_INDUSTRY_CODES = [...SWING_CORE_INDUSTRY_CODES, ...SWING_EXPANDED_INDUSTRY_CODES] as const;
export const SWING_UNIVERSE_MAX_MEMBERS = 388;

export const SWING_SUBINDUSTRY_REPRESENTATIVE_LIMIT = 10;
/** RSI14 超卖硬阈值：2020-2026 事件研究显示越深越可靠（<25 档七年方向不变），<30 直接削减浅跌弱势信号。 */
export const SWING_RSI_OVERSOLD_LIMIT = 30;
/** 缩量硬阈值：事件研究显示缩量不足且深度不够的信号质量最差；深度标的按或门豁免。 */
export const SWING_VOLUME_DRYNESS_LIMIT = 0.7;
/** 深度豁免与深度评分共用的 MA250 偏离深阈值。 */
export const SWING_DEEP_MA250_DEVIATION = -0.35;
/** 正式信号与接近候选合并按深度评分排序后，每日保留的标的总数。 */
export const SWING_DAILY_SIGNAL_LIMIT = 5;

export interface SwingUniverseMember {
  instrument_id: string;
  code: string;
  name: string;
  industry_code: string;
  industry_name: string;
  source_scope: "core" | "expanded";
  median_turnover_60: number | null;
}

/** 新样本按细分代表性与流动性限制数量；本策略存量信号额外纳入复核。 */
export async function querySwingUniverse(db: Db, date: string, reviewCodes: string[] = []): Promise<SwingUniverseMember[]> {
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
       SELECT member.*,recent.median_turnover_60,history.bar_count
         FROM primary_members member
         JOIN LATERAL (
           SELECT count(*) AS bar_count FROM (
             SELECT 1 FROM market_bar bar WHERE bar.instrument_id=member.instrument_id
               AND bar.freq='day' AND bar.bar_date <= $1::date
             ORDER BY bar.bar_date DESC,bar.bar_time DESC LIMIT 40
           ) history
         ) history ON history.bar_count=40 OR member.code=ANY($6::text[])
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
     ), discovery AS (
       SELECT code FROM ranked WHERE bar_count=40
        ORDER BY (subindustry_rank <= $4) DESC,median_turnover_60 DESC NULLS LAST,code LIMIT $5
     )
     SELECT instrument_id::text,code,name,industry_code,industry_name,
            CASE WHEN industry_code=ANY($3::text[]) THEN 'expanded' ELSE 'core' END AS source_scope,
            median_turnover_60
       FROM ranked
      WHERE code IN (SELECT code FROM discovery) OR code=ANY($6::text[])
      ORDER BY (subindustry_rank <= $4) DESC,median_turnover_60 DESC NULLS LAST,code`,
    [date, [...SWING_INDUSTRY_CODES], [...SWING_EXPANDED_INDUSTRY_CODES],
     SWING_SUBINDUSTRY_REPRESENTATIVE_LIMIT, SWING_UNIVERSE_MAX_MEMBERS, reviewCodes],
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

/** 使用 T 日收盘价评估四条件；T+1 突破与价格上限作为执行窗口单独返回。
 * ma250Deviation 供缩量或门豁免：深度标的（≤−35%）不满足缩量也算通过；缺数时按严格缩量执行。 */
export function evaluateSwingSignal(
  rows: SwingSignalBar[],
  kind: string,
  defenseRecoveryMa10: number | null,
  ma250Deviation?: number | null,
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
    volume_contracted: current.volume! < volumeMa5 * SWING_VOLUME_DRYNESS_LIMIT
      || (ma250Deviation != null && ma250Deviation <= SWING_DEEP_MA250_DEVIATION),
    reversal_candle: current.close > current.open || lowerShadowRatio > 0.005,
    rsi_oversold: current.rsi14! < SWING_RSI_OVERSOLD_LIMIT,
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

/** 深度评分特征：相对 MA250 偏离、前 60 日跌幅、所属一级行业 20 日动量；缺数计 0 分不阻断。 */
export interface SwingDepthFeatures {
  ma250_dev: number | null;
  ret60: number | null;
  industry_mom20: number | null;
}

/**
 * 深度评分 0–5：MA250 偏离 ≤−35% 记 2 分、−35%~−15% 记 1 分；60 日跌幅 ≤−25% 记 2 分、
 * −25%~−12% 记 1 分；行业 20 日动量为负记 1 分。2020-2026 事件研究：深度家族平均 R 极差
 * MA250 1.04、60 日跌幅 0.44、行业动量 0.48（覆盖期内复验），方向一致且七年未反转。
 */
export function swingDepthScore(features: SwingDepthFeatures): number {
  let score = 0;
  if (features.ma250_dev != null) {
    score += features.ma250_dev <= SWING_DEEP_MA250_DEVIATION ? 2 : features.ma250_dev <= -0.15 ? 1 : 0;
  }
  if (features.ret60 != null) score += features.ret60 <= -0.25 ? 2 : features.ret60 <= -0.12 ? 1 : 0;
  if (features.industry_mom20 != null && features.industry_mom20 < 0) score += 1;
  return score;
}

export interface SwingDailyPoolMember {
  code: string;
  name?: string;
  evidence: { expected_reward_risk: number | null };
  depth: SwingDepthFeatures;
  depth_score: number;
}

function compareDepthRank(left: SwingDailyPoolMember, right: SwingDailyPoolMember): number {
  if (left.depth_score !== right.depth_score) return right.depth_score - left.depth_score;
  const leftDev = left.depth.ma250_dev ?? Number.POSITIVE_INFINITY;
  const rightDev = right.depth.ma250_dev ?? Number.POSITIVE_INFINITY;
  if (leftDev !== rightDev) return leftDev - rightDev;
  return left.code.localeCompare(right.code);
}

/**
 * 正式信号与接近候选合并为深度池，按评分降序、MA250 更深优先、代码升序，
 * 每日只保留前 SWING_DAILY_SIGNAL_LIMIT 个；被挤出但条件仍满足的标的显式单列，
 * 供关注对账保留至到期而不是清退。
 */
export function applySwingDailyDepthLimit<S extends SwingDailyPoolMember, N extends SwingDailyPoolMember>(
  allSignals: S[],
  nearCandidates: N[],
): {
  signals: S[];
  nearCandidates: N[];
  cappedOut: Array<{
    code: string;
    name: string;
    signal_status: "qualified" | "approaching";
    depth_score: number;
    ma250_dev: number | null;
    expected_reward_risk: number | null;
  }>;
} {
  const pool = [
    ...allSignals.map((item) => ({ item, status: "qualified" as const })),
    ...nearCandidates.map((item) => ({ item, status: "approaching" as const })),
  ].sort((left, right) => compareDepthRank(left.item, right.item));
  const kept = pool.slice(0, SWING_DAILY_SIGNAL_LIMIT);
  const rest = pool.slice(SWING_DAILY_SIGNAL_LIMIT);
  return {
    signals: kept.filter((entry) => entry.status === "qualified").map((entry) => entry.item),
    nearCandidates: kept.filter((entry) => entry.status === "approaching").map((entry) => entry.item),
    cappedOut: rest.map(({ item, status }) => ({
      code: item.code,
      name: item.name ?? item.code,
      signal_status: status,
      depth_score: item.depth_score,
      ma250_dev: item.depth.ma250_dev,
      expected_reward_risk: item.evidence.expected_reward_risk,
    })),
  };
}

export async function querySwingSignals(db: Db, date: string, accountId: string | null = "1") {
  const reviewCodes = await strategyAttentionCodes(db, "swing");
  const universe = await querySwingUniverse(db, date, reviewCodes);
  const universeCodes = universe.map((item) => item.code);
  const outsideReviewGaps = reviewCodes.filter((code) => !universeCodes.includes(code))
    .map((code) => ({ code, reason: "未进入当前策略扫描范围，行业归属或标的资格待复核" }));
  const expandedMemberCount = universe.filter((item) => item.source_scope === "expanded").length;
  const members = await db.query<SwingMember>(
    `SELECT instrument.id::text AS instrument_id,instrument.code,instrument.name,instrument.kind,
            COALESCE(position.quantity,0)::float8 AS quantity,
            metric.as_of_date::text AS metric_date,metric_run.status AS metric_status,metric.defense_recovery_ma10
       FROM market_instrument instrument
       LEFT JOIN portfolio_position position ON position.instrument_id=instrument.id AND position.account_id=$3
       LEFT JOIN LATERAL (
         SELECT current.* FROM market_stock_character_metric current
          WHERE current.instrument_id=instrument.id AND current.as_of_date <= $1::date
          ORDER BY current.as_of_date DESC,current.computed_at DESC LIMIT 1
       ) metric ON true
       LEFT JOIN market_indicator_run metric_run ON metric_run.id=metric.indicator_run_id
      WHERE instrument.code=ANY($2::text[]) ORDER BY instrument.code`,
    [date, universeCodes, accountId],
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
    daily_signal_limit: SWING_DAILY_SIGNAL_LIMIT,
    rsi_oversold_limit: SWING_RSI_OVERSOLD_LIMIT,
    volume_dryness_limit: SWING_VOLUME_DRYNESS_LIMIT,
    deep_ma250_deviation: SWING_DEEP_MA250_DEVIATION,
    qualified_total_count: 0,
    capped_out_count: 0,
    capped_out: [],
    industry_headwind_count: 0,
    industry_headwind: [],
    signals: [],
    near_candidates: [],
    suppressed_matches: [],
    screened_out: [],
    excluded_count: 0,
    excluded: [],
    reviewed_codes: [],
    review_gaps: outsideReviewGaps,
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
       FROM ranked WHERE row_no <= 260 ORDER BY code,bar_date`,
    [date, universeCodes],
  );
  const byCode = new Map<string, SwingSignalBar[]>();
  for (const bar of bars.rows) byCode.set(bar.code, [...(byCode.get(bar.code) ?? []), bar]);
  // 深度评分的行业维度：16 个一级行业指数截至目标日的 20 日动量。
  const industryMomentum = new Map<string, number>();
  {
    const boards = await db.query<{ code: string; bar_date: string; close: number }>(
      `WITH ranked AS (
         SELECT instrument.code,bar.bar_date::text,bar.close::float8,
                row_number() OVER (PARTITION BY instrument.id ORDER BY bar.bar_date DESC) AS rn
           FROM market_bar bar JOIN market_instrument instrument ON instrument.id=bar.instrument_id
          WHERE instrument.code=ANY($2::text[]) AND bar.freq='day' AND bar.bar_date<=$1::date
       )
       SELECT code,bar_date,close FROM ranked WHERE rn<=21 ORDER BY code,bar_date`,
      [date, [...SWING_INDUSTRY_CODES]],
    );
    const byBoard = new Map<string, Array<{ bar_date: string; close: number }>>();
    for (const row of boards.rows) {
      const list = byBoard.get(row.code) ?? [];
      list.push({ bar_date: row.bar_date, close: row.close });
      byBoard.set(row.code, list);
    }
    for (const [code, list] of byBoard) {
      if (list.length >= 21) industryMomentum.set(code, list.at(-1)!.close / list.at(-21)!.close - 1);
    }
  }
  const industryOf = new Map(universe.map((item) => [item.code, item.industry_code]));

  const excluded: Array<{ code: string; reason: string }> = [];
  const items: Array<SwingSignalEvaluation & {
    code: string;
    name: string;
    kind: string;
    held: boolean;
    signal: boolean;
    suppressed_by: "existing_position" | "price_cap" | null;
    depth: SwingDepthFeatures;
    depth_score: number;
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
    // 四条件只看最近 40 根；MA250 与 60 日跌幅用 260 根窗口计算，MA250 偏离同时供缩量或门豁免。
    const closes = rows.map((row) => row.close);
    const ma250 = closes.length >= 250 ? closes.slice(-250).reduce((sum, value) => sum + value, 0) / 250 : null;
    const ma250Dev = ma250 !== null && ma250 > 0 ? rows.at(-1)!.close / ma250 - 1 : null;
    const evaluation = evaluateSwingSignal(rows.slice(-40), member.kind, member.defense_recovery_ma10, ma250Dev);
    if (!evaluation) {
      excluded.push({ code: member.code, reason: "波段扫描缺少可信RSI14/OHLCV或止损输入" });
      continue;
    }
    const held = member.quantity > 0;
    const priceCapBlocked = evaluation.price_signal && !evaluation.evidence.confirmation_window_available;
    const depth: SwingDepthFeatures = {
      ma250_dev: ma250Dev,
      ret60: closes.length >= 61 ? evaluation.evidence.close / closes.at(-61)! - 1 : null,
      industry_mom20: industryMomentum.get(industryOf.get(member.code) ?? "") ?? null,
    };
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
      depth,
      depth_score: swingDepthScore(depth),
    });
  }
  // 行业逆风降级：行业 20 日动量非负的候选不进入正式/接近（RSI<30 池内胜率 32.4%、平均 R 为负），
  // 仅列为行业逆风复核；行业动量缺数时不降级，与深度评分缺数口径一致。
  const industryHeadwindOf = (item: (typeof items)[number]) =>
    item.depth.industry_mom20 != null && item.depth.industry_mom20 >= 0;
  const eligibleCandidate = (item: (typeof items)[number]) => item.signal
    || (!item.held && !item.price_signal && item.passed_count === 3 && item.evidence.confirmation_window_available);
  const industryHeadwind = items
    .filter((item) => eligibleCandidate(item) && industryHeadwindOf(item))
    .map((item) => ({
      code: item.code,
      name: item.name,
      signal_status: item.signal ? ("qualified" as const) : ("approaching" as const),
      industry_mom20: item.depth.industry_mom20,
      depth_score: item.depth_score,
      reason: "所属行业20日动量非负，降级为行业逆风复核，不占用每日信号名额",
    }));
  const headwindCodes = new Set(industryHeadwind.map((item) => item.code));
  const allSignals = items.filter((item) => item.signal && !headwindCodes.has(item.code));
  const allNearCandidates = items.filter((item) =>
    !item.held && !item.price_signal && item.passed_count === 3 && item.evidence.confirmation_window_available
    && !headwindCodes.has(item.code));
  // 深度池：正式与接近合并按深度评分排序，每日只保留前 N；挤出者单列供关注对账保留。
  const { signals, nearCandidates, cappedOut } = applySwingDailyDepthLimit(allSignals, allNearCandidates);
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
    daily_signal_limit: SWING_DAILY_SIGNAL_LIMIT,
    rsi_oversold_limit: SWING_RSI_OVERSOLD_LIMIT,
    volume_dryness_limit: SWING_VOLUME_DRYNESS_LIMIT,
    deep_ma250_deviation: SWING_DEEP_MA250_DEVIATION,
    qualified_total_count: allSignals.length,
    capped_out_count: cappedOut.length,
    capped_out: cappedOut,
    industry_headwind_count: industryHeadwind.length,
    industry_headwind: industryHeadwind,
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
    reviewed_codes: items.map((item) => item.code),
    review_gaps: [...excluded, ...outsideReviewGaps],
    excluded_count: excluded.length,
    excluded,
    gaps: items.length ? [] : [{ reason: "候选均因数据不可信被剔除，无法完成有效扫描", excluded_count: excluded.length }],
  };
}
