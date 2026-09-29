import type pg from "pg";
import { queryPositionCompatibilityContext } from "../plans/daily-context.js";
import type { StrategyPositionEvaluation } from "./types.js";

type CompatibilityContext = Awaited<ReturnType<typeof queryPositionCompatibilityContext>>;
type CompatibilityItem = CompatibilityContext["positions"]["items"][number];

export interface StrategyExitEvaluationContext {
  pool: pg.Pool;
  targetDate: string;
  strategyCode: string;
}

export interface StrategyExitEvaluationResult {
  status: "success" | "partial";
  data_date: string | null;
  coverage: Record<string, unknown>;
  items: StrategyPositionEvaluation[];
  gaps: Array<{ code?: string; reason: string }>;
}

export interface EffectivePositionExitEvaluation {
  code: string;
  name: string;
  strategy_code: string;
  exit_policy_mode: string;
  primary: StrategyPositionEvaluation | null;
  fallback: StrategyPositionEvaluation | null;
  effective_action: StrategyPositionEvaluation["action"];
  effective_source: "primary" | "fallback" | "none";
  effective_reason: string;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalized(
  item: CompatibilityItem,
  strategyCode: string,
  role: "primary" | "fallback",
  action: StrategyPositionEvaluation["action"],
  reason: string,
  evidence: Record<string, unknown>,
  protectionPrice: number | null = null,
  triggerKind = "condition",
): StrategyPositionEvaluation {
  return {
    code: item.code,
    name: item.name,
    strategy_code: strategyCode,
    evaluation_role: role,
    action,
    trigger_kind: triggerKind,
    trigger_price_lower: protectionPrice,
    trigger_price_upper: protectionPrice,
    protection_price: protectionPrice,
    reason,
    evidence,
    missing_items: [],
  };
}

function swingEvaluation(item: CompatibilityItem): StrategyPositionEvaluation {
  const triggers = item.swing_triggers;
  if (!triggers) return normalized(item, "swing", "primary", "observe", "波段触发位尚未完成", {}, null);
  if (triggers.next_open_exit_candidate) {
    const stop = triggers.next_open_exit_candidate === "disaster_stop" ? triggers.disaster_stop : triggers.regular_stop;
    return normalized(item, "swing", "primary", "exit", `波段触发 ${triggers.next_open_exit_candidate}`,
      { triggers }, stop, "open");
  }
  if (triggers.target_price !== null && item.highest_high !== null && item.highest_high >= triggers.target_price) {
    return normalized(item, "swing", "primary", "reduce", "已触及原箱顶×0.95，候选减半", { triggers }, triggers.target_price, "price_range");
  }
  return normalized(item, "swing", "primary", "hold", "波段止损、目标与到期均未触发", { triggers },
    triggers.profit_protection_level ?? triggers.regular_stop);
}

function leftReversalEvaluation(item: CompatibilityItem): StrategyPositionEvaluation {
  const triggers = item.left_reversal_triggers;
  if (!triggers) return normalized(item, "legacy_left_reversal", "primary", "observe", "旧左侧触发位尚未完成", {}, null);
  if (triggers.next_open_exit_candidate) {
    const protection = triggers.after_second_scale_protection ?? triggers.after_first_scale_protection ?? triggers.initial_stop;
    return normalized(item, "legacy_left_reversal", "primary", "exit", `旧左侧触发 ${triggers.next_open_exit_candidate}`,
      { triggers }, protection, "open");
  }
  if (triggers.second_scale_reached || triggers.first_scale_reached) {
    const level = triggers.second_scale_reached ? triggers.second_scale_trigger : triggers.first_scale_trigger;
    return normalized(item, "legacy_left_reversal", "primary", "reduce", "旧左侧分批止盈价已触及，需核对已执行数量",
      { triggers }, level, "price_range");
  }
  return normalized(item, "legacy_left_reversal", "primary", "hold", "旧左侧止损、分批与到期均未触发",
    { triggers }, triggers.initial_stop);
}

function rightSideEvaluation(item: CompatibilityItem): StrategyPositionEvaluation {
  const triggers = item.short_term_triggers;
  if (!triggers) return normalized(item, "legacy_right_side", "primary", "observe", "右侧结构评估尚未完成", {}, null);
  if (triggers.next_open_exit_candidate) {
    return normalized(item, "legacy_right_side", "primary", "exit", `右侧结构触发 ${triggers.next_open_exit_candidate}`,
      { right_side: {
        survival_count: triggers.right_side_survival_count,
        macd_weakness: triggers.macd_weakness_exit_candidate,
        breakdown: triggers.right_side_breakdown_exit_candidate,
        time_fallback: triggers.time_fallback_exit_candidate,
      } }, null, "open");
  }
  return normalized(item, "legacy_right_side", "primary", "hold", "右侧结构未触发崩坏、MACD弱化或时间退出",
    { right_side_survival_count: triggers.right_side_survival_count });
}

function fallbackEvaluation(item: CompatibilityItem): StrategyPositionEvaluation {
  const triggers = item.short_term_triggers;
  if (!triggers) return normalized(item, "portfolio_fallback_exit", "fallback", "observe", "兜底触发位尚未完成", {}, null);
  const close = number(item.current_close);
  const activeStop = number(triggers.active_stop);
  const protection = triggers.cooldown_active ? activeStop : number(triggers.post_first_take_profit_stop_candidate) ?? activeStop;
  if (close !== null && protection !== null && close <= protection) {
    return normalized(item, "portfolio_fallback_exit", "fallback", "exit", "收盘已跌破兜底保护位",
      { triggers, current_close: close }, protection, "open");
  }
  if (triggers.second_take_profit_price_reached) {
    return normalized(item, "portfolio_fallback_exit", "fallback", "reduce", "已触及第二档分批止盈价，需核对已执行数量",
      { triggers }, triggers.second_take_profit, "price_range");
  }
  if (triggers.first_take_profit_price_reached) {
    return normalized(item, "portfolio_fallback_exit", "fallback", "reduce", "已触及第一档分批止盈价，需核对已执行数量",
      { triggers }, triggers.first_take_profit, "price_range");
  }
  return normalized(item, "portfolio_fallback_exit", "fallback", "hold", "兜底止损、分批止盈与移动保护均未触发",
    { triggers, current_close: close }, protection);
}

interface RawBar {
  code: string;
  bar_date: string;
  high: number;
  low: number;
  close: number;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function atr14(rows: RawBar[]): number | null {
  if (rows.length < 15) return null;
  const ranges = rows.slice(-14).map((row, offset) => {
    const index = rows.length - 14 + offset;
    const previous = rows[index - 1];
    return Math.max(row.high - row.low, Math.abs(row.high - previous!.close), Math.abs(row.low - previous!.close));
  });
  return mean(ranges);
}

async function twoYearEvaluations(pool: pg.Pool, targetDate: string): Promise<{
  items: StrategyPositionEvaluation[];
  gaps: Array<{ code: string; reason: string }>;
}> {
  const positions = await pool.query<{
    instrument_id: string; code: string; name: string; cost_price: number; opened_at: string | null; board_code: string | null;
  }>(`SELECT position.instrument_id::text, instrument.code, instrument.name,
            position.cost_price::float8, position.opened_at::text, board.code AS board_code
       FROM portfolio_position position JOIN market_instrument instrument ON instrument.id=position.instrument_id
       LEFT JOIN LATERAL (
         SELECT board_instrument.code FROM market_board_membership membership
         JOIN market_instrument board_instrument ON board_instrument.id=membership.board_instrument_id
        WHERE membership.member_instrument_id=position.instrument_id AND membership.effective_from <= $1::date
          AND (membership.effective_to IS NULL OR membership.effective_to >= $1::date)
          AND board_instrument.code LIKE '881%.TI'
        ORDER BY membership.effective_from DESC LIMIT 1
       ) board ON true
      WHERE position.quantity>0 AND position.strategy_code='two_year_reversal' ORDER BY instrument.code`, [targetDate]);
  if (!positions.rows.length) return { items: [], gaps: [] };
  const bars = await pool.query<RawBar>(
    `WITH ranked AS (
       SELECT instrument.code, bar.bar_date::text,
              COALESCE(bar.high_raw,bar.high)::float8 AS high,
              COALESCE(bar.low_raw,bar.low)::float8 AS low,
              COALESCE(bar.close_raw,bar.close)::float8 AS close,
              row_number() OVER(PARTITION BY instrument.code ORDER BY bar.bar_date DESC,bar.bar_time DESC) AS row_no
         FROM portfolio_position position JOIN market_instrument instrument ON instrument.id=position.instrument_id
         JOIN market_bar bar ON bar.instrument_id=position.instrument_id AND bar.freq='day' AND bar.bar_date <= $1::date
        WHERE position.quantity>0 AND position.strategy_code='two_year_reversal')
     SELECT code,bar_date,high,low,close FROM ranked WHERE row_no<=80 ORDER BY code,bar_date`, [targetDate]);
  const byCode = new Map<string, RawBar[]>();
  for (const bar of bars.rows) byCode.set(bar.code, [...(byCode.get(bar.code) ?? []), bar]);
  const boardCodes = [...new Set(positions.rows.map((row) => row.board_code).filter((code): code is string => code !== null))];
  const boardBars = boardCodes.length ? await pool.query<{ code: string; bar_date: string; close: number }>(
    `WITH ranked AS (
       SELECT instrument.code,bar.bar_date::text,COALESCE(bar.close_raw,bar.close)::float8 AS close,
              row_number() OVER(PARTITION BY instrument.code ORDER BY bar.bar_date DESC,bar.bar_time DESC) AS row_no
         FROM market_instrument instrument JOIN market_bar bar ON bar.instrument_id=instrument.id
        WHERE instrument.code=ANY($1::text[]) AND bar.freq='day' AND bar.bar_date <= $2::date)
     SELECT code,bar_date,close FROM ranked WHERE row_no<=6 ORDER BY code,bar_date`, [boardCodes, targetDate])
    : { rows: [] as Array<{ code: string; bar_date: string; close: number }> };
  const boardByCode = new Map<string, Array<{ bar_date: string; close: number }>>();
  for (const bar of boardBars.rows) boardByCode.set(bar.code, [...(boardByCode.get(bar.code) ?? []), bar]);
  const sellCounts = await pool.query<{ code: string; sell_count: number }>(
    `SELECT instrument.code,count(change.id)::int AS sell_count FROM portfolio_position position
       JOIN market_instrument instrument ON instrument.id=position.instrument_id
       LEFT JOIN portfolio_position_change change ON change.instrument_id=position.instrument_id
        AND change.kind='sell' AND position.opened_at IS NOT NULL AND change.change_date>=position.opened_at
      WHERE position.quantity>0 AND position.strategy_code='two_year_reversal'
      GROUP BY instrument.code`);
  const sold = new Map(sellCounts.rows.map((row) => [row.code, Number(row.sell_count)]));
  const items: StrategyPositionEvaluation[] = [];
  const gaps: Array<{ code: string; reason: string }> = [];
  for (const position of positions.rows) {
    const rows = byCode.get(position.code) ?? [];
    const openedAt = position.opened_at;
    const signalRows = openedAt ? rows.filter((row) => row.bar_date < openedAt) : [];
    const heldRows = openedAt ? rows.filter((row) => row.bar_date >= openedAt) : [];
    const signal = signalRows.at(-1);
    const current = rows.at(-1);
    const ma20 = rows.length >= 20 ? mean(rows.slice(-20).map((row) => row.close)) : null;
    const atr = atr14(rows);
    if (!position.opened_at) gaps.push({ code: position.code, reason: "两年结构反转持仓缺少开仓日期" });
    if (!signal) gaps.push({ code: position.code, reason: "两年结构反转持仓缺少信号日原始价" });
    if (!current || ma20 === null || atr === null) gaps.push({ code: position.code, reason: "两年结构反转持仓缺少MA20或ATR14原始价窗口" });
    const peak = heldRows.length ? Math.max(...heldRows.map((row) => row.close)) : null;
    const ma20Reached = heldRows.length >= 2 && current !== undefined && ma20 !== null && current.close >= ma20;
    const firstReductionExecuted = (sold.get(position.code) ?? 0) > 0;
    const stockReturn5 = rows.length >= 6 ? rows.at(-1)!.close / rows.at(-6)!.close - 1 : null;
    const industryRows = position.board_code ? boardByCode.get(position.board_code) ?? [] : [];
    const industryReturn5 = industryRows.length >= 6 ? industryRows.at(-1)!.close / industryRows.at(-6)!.close - 1 : null;
    const relativeReturn5 = stockReturn5 === null || industryReturn5 === null ? null : stockReturn5 - industryReturn5;
    const relativeRepaired = heldRows.length >= 2 && relativeReturn5 !== null && relativeReturn5 >= -0.01;
    const trailing = peak !== null && atr !== null && peak >= position.cost_price * 1.1
      ? peak - Math.max(peak * 0.08, 3 * atr) : null;
    const protections = [signal?.low ?? null, (ma20Reached || firstReductionExecuted || relativeRepaired) ? position.cost_price : null, trailing]
      .filter((value): value is number => value !== null);
    const protection = protections.length ? Math.max(...protections) : null;
    let action: StrategyPositionEvaluation["action"] = "hold";
    let reason = "两年结构反转风险线、MA20分批和ATR移动止损均未触发";
    if (current && protection !== null && current.close <= protection) {
      action = "exit"; reason = "收盘已跌破两年结构反转有效风险线";
    } else if (ma20Reached && !firstReductionExecuted) {
      action = "reduce"; reason = "首次回到MA20，候选减半并将剩余风险线抬至成本附近";
    }
    items.push({
      code: position.code, name: position.name, strategy_code: "two_year_reversal", evaluation_role: "primary",
      action, trigger_kind: action === "exit" ? "open" : action === "reduce" ? "price_range" : "condition",
      trigger_price_lower: action === "reduce" ? ma20 : protection,
      trigger_price_upper: action === "reduce" ? ma20 : protection,
      protection_price: protection,
      reason,
      evidence: {
        signal_low_raw: signal?.low ?? null, current_close_raw: current?.close ?? null, ma20_raw: ma20,
        atr14_raw: atr, peak_close_raw: peak, trailing_stop: trailing,
        ma20_reached: ma20Reached, first_reduction_executed: firstReductionExecuted,
        industry_code: position.board_code, stock_return_5: stockReturn5, industry_return_5: industryReturn5,
        relative_return_5: relativeReturn5, relative_repaired: relativeRepaired,
      },
      missing_items: gaps.filter((gap) => gap.code === position.code).map((gap) => gap.reason),
    });
  }
  return { items, gaps };
}

function compatibilityEvaluation(item: CompatibilityItem, strategyCode: string): StrategyPositionEvaluation {
  if (strategyCode === "swing") return swingEvaluation(item);
  if (strategyCode === "legacy_left_reversal") return leftReversalEvaluation(item);
  if (strategyCode === "legacy_right_side") return rightSideEvaluation(item);
  return fallbackEvaluation(item);
}

function rank(action: StrategyPositionEvaluation["action"]): number {
  return { hold: 0, observe: 1, reduce: 2, exit: 3 }[action];
}

export function mergeExitEvaluations(
  strategyCode: string,
  exitPolicyMode: string,
  primary: StrategyPositionEvaluation | null,
  fallback: StrategyPositionEvaluation | null,
): EffectivePositionExitEvaluation {
  const effective = !primary ? fallback : !fallback ? primary : rank(primary.action) >= rank(fallback.action) ? primary : fallback;
  return {
    code: effective?.code ?? primary?.code ?? fallback?.code ?? "",
    name: effective?.name ?? primary?.name ?? fallback?.name ?? "",
    strategy_code: strategyCode,
    exit_policy_mode: exitPolicyMode,
    primary,
    fallback,
    effective_action: effective?.action ?? "observe",
    effective_source: effective === primary ? "primary" : effective === fallback ? "fallback" : "none",
    effective_reason: effective?.reason ?? "没有可用出场评估",
  };
}

async function compatibility(pool: pg.Pool, targetDate: string, strategyCode?: string): Promise<CompatibilityContext> {
  return queryPositionCompatibilityContext(pool, targetDate, strategyCode);
}

export async function evaluateStrategyExit(context: StrategyExitEvaluationContext): Promise<StrategyExitEvaluationResult> {
  if (context.strategyCode === "two_year_reversal") {
    const result = await twoYearEvaluations(context.pool, context.targetDate);
    return {
      status: result.gaps.length ? "partial" : "success", data_date: context.targetDate,
      coverage: { strategy_code: context.strategyCode, position_count: result.items.length, completed_count: result.items.length },
      items: result.items, gaps: result.gaps,
    };
  }
  const source = await compatibility(context.pool, context.targetDate, context.strategyCode);
  const selected = source.positions.items.filter((item) => context.strategyCode === "portfolio_fallback_exit"
    ? item.fallback_strategy_code === "portfolio_fallback_exit"
    : item.strategy_code === context.strategyCode);
  const codes = new Set(selected.map((item) => item.code));
  const gaps = source.positions.gaps.filter((gap) => codes.has(gap.code));
  const items = selected.map((item) => {
    const evaluation = compatibilityEvaluation(item, context.strategyCode);
    evaluation.missing_items = gaps.filter((gap) => gap.code === item.code).map((gap) => gap.reason);
    if (evaluation.missing_items.length && evaluation.action === "hold") {
      evaluation.action = "observe";
      evaluation.reason = "绑定策略评估存在缺口，需补齐后复核";
    }
    return evaluation;
  });
  return {
    status: gaps.length ? "partial" : "success",
    data_date: source.data_date,
    coverage: { strategy_code: context.strategyCode, position_count: selected.length, completed_count: items.length },
    items,
    gaps,
  };
}

export async function queryPositionExitEvaluationBundle(pool: pg.Pool, targetDate: string) {
  const source = await compatibility(pool, targetDate);
  const strategyCodes = new Set<string>();
  for (const item of source.positions.items) {
    if (item.strategy_code && item.exit_policy_mode !== "fallback_only") strategyCodes.add(item.strategy_code);
    if (item.fallback_strategy_code && ["fallback_only", "dedicated_plus_fallback"].includes(item.exit_policy_mode ?? "")) strategyCodes.add(item.fallback_strategy_code);
  }
  const evaluations = new Map(await Promise.all([...strategyCodes].map(async (strategyCode) =>
    [strategyCode, await evaluateStrategyExit({ pool, targetDate, strategyCode })] as const)));
  const rows = source.positions.items.map((item) => {
    const primary = item.exit_policy_mode !== "fallback_only"
      ? evaluations.get(item.strategy_code ?? "")?.items.find((row) => row.code === item.code) ?? null : null;
    const fallback = evaluations.get(item.fallback_strategy_code ?? "")?.items.find((row) => row.code === item.code) ?? null;
    return mergeExitEvaluations(item.strategy_code ?? "unassigned", item.exit_policy_mode ?? "none", primary, fallback);
  });
  const gaps = [...evaluations.values()].flatMap((evaluation) => evaluation.gaps);
  return {
    status: gaps.length === 0 ? "success" as const : "partial" as const,
    requested_date: targetDate,
    data_date: source.data_date,
    position_count: rows.length,
    primary_count: rows.filter((row) => row.primary !== null).length,
    fallback_count: rows.filter((row) => row.fallback !== null).length,
    items: rows,
    gaps,
  };
}
