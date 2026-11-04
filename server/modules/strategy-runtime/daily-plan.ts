import type pg from "pg";
import { positionGapReasons } from "../plans/evaluation-gaps.js";
import { queryDailyPlanContext } from "../plans/daily-context.js";
import { getLatestMarketNews, instrumentNews } from "../market-news/repo.js";
import { replaceDraftPlaybook, type DailyPlanKeyLevel, type PlaybookItemInput } from "../plans/repo.js";
import { listPositions } from "../positions/repo.js";
import { EXIT_RULES } from "../ultra-short/exit.js";
import { mergeExitEvaluations } from "./exit-evaluators.js";
import { type StrategyAttentionChange } from "./attention.js";
import { ensureStrategyEvaluation, type EnsureStrategyEvaluationResult } from "./service.js";
import type { StrategyPositionEvaluation, StrategyRuntimeDefinition } from "./types.js";
import { listStrategyRuntimeDefinitions } from "./repo.js";

interface EvaluationRecord {
  strategy: StrategyRuntimeDefinition;
  phase: "entry" | "exit" | "context";
  ensured: EnsureStrategyEvaluationResult;
}

function resultRecord(result: unknown): Record<string, unknown> {
  return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
}

function positionItems(evaluation: EvaluationRecord | undefined): StrategyPositionEvaluation[] {
  const items = resultRecord(evaluation?.ensured.result).items;
  return Array.isArray(items) ? items as StrategyPositionEvaluation[] : [];
}

function gapsForPosition(evaluation: EvaluationRecord | undefined, code: string): string[] {
  return positionGapReasons(evaluation?.ensured.run.gaps ?? [], code);
}

function evaluationGap(evaluation: EvaluationRecord): Record<string, unknown> | null {
  if (evaluation.ensured.execution === "waiting") return {
    strategy_code: evaluation.strategy.code, phase: evaluation.phase, reason: "评估运行中，等待完成",
  };
  if (["partial", "failed"].includes(evaluation.ensured.run.status)) return {
    strategy_code: evaluation.strategy.code, phase: evaluation.phase,
    reason: `评估状态 ${evaluation.ensured.run.status}`, gaps: evaluation.ensured.run.gaps,
  };
  return null;
}

interface PositionTechnicalLevels {
  close: number | null;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  high_10d: number | null;
  low_10d: number | null;
  high_20d: number | null;
  low_20d: number | null;
  prev_high: number | null;
  prev_low: number | null;
  limit_up_price?: number;
  limit_down_price?: number;
}

/** 情景/做T预案的关键点位：全部为技术面机械事实，不引入任何策略判断；同价位只保留首个标签。 */
export function buildKeyLevels(levels: PositionTechnicalLevels | undefined): DailyPlanKeyLevel[] {
  if (!levels) return [];
  const items: DailyPlanKeyLevel[] = [];
  const seen = new Set<string>();
  const push = (kind: DailyPlanKeyLevel["kind"], label: string, price: number | null | undefined) => {
    if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) return;
    const key = price.toFixed(2);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ kind, label, price: Math.round(price * 100) / 100 });
  };
  for (const [label, value] of [["MA5", levels.ma5], ["MA10", levels.ma10], ["MA20", levels.ma20]] as const) {
    push(value !== null && levels.close !== null && value >= levels.close ? "resistance" : "support", label, value);
  }
  push("resistance", "近10日高点", levels.high_10d);
  push("resistance", "近20日高点", levels.high_20d);
  push("support", "近10日低点", levels.low_10d);
  push("support", "近20日低点", levels.low_20d);
  push("resistance", "前日高点", levels.prev_high);
  push("support", "前日低点", levels.prev_low);
  push("limit", "预案日涨停价", levels.limit_up_price ?? null);
  push("limit", "预案日跌停价", levels.limit_down_price ?? null);
  return items;
}


/** 超短关注池持仓事实：05 离场硬规则所需的全部输入，避免每日计划重复调用 limit_up/兜底退出评估器。 */
export interface UltraShortHoldingFacts {
  target_date: string;
  entry_price: number | null;
  position_opened_at: string | null;
  key_levels: Record<string, unknown>;
  tags: string[];
  risk: Record<string, unknown>;
}

const ULTRA_SHORT_LOW_BUY_TAGS = ["龙回头", "单阳不破", "N 字结构", "线上阴线买"] as const;

function positivePrice(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function roundedPrice(value: number): number {
  return Math.round(value * 100) / 100;
}

function priceText(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(2);
}

/**
 * 超短持仓的每日计划退出判定：只做确定性硬规则，不做 LLM 可放宽的解释。
 * 硬止损优先；低吸按 +1.5R 减半、+2.5R 清仓；打板不设固定目标，断板/炸板与 D+1 14:50 由盘中监控执行。
 */
export function evaluateUltraShortPositionExit(input: {
  code: string;
  name: string;
  close: number | null;
  close_date: string | null;
  holding: UltraShortHoldingFacts;
}): StrategyPositionEvaluation {
  const { code, name, close, close_date, holding } = input;
  const line: "board" | "low_buy" = holding.tags.some((tag) =>
    (ULTRA_SHORT_LOW_BUY_TAGS as readonly string[]).includes(tag)) ? "low_buy" : "board";
  const entry = positivePrice(holding.entry_price);
  const invalidation = positivePrice(holding.key_levels.invalidation_price);
  const stop = positivePrice(holding.key_levels.stop_price) ?? invalidation;
  const r = entry !== null && stop !== null && entry > stop ? entry - stop : null;
  const targetOne = line === "low_buy" && entry !== null && r !== null
    ? roundedPrice(entry + EXIT_RULES.low_buy_first_target_r * r) : null;
  const targetTwo = line === "low_buy" && entry !== null && r !== null
    ? roundedPrice(entry + EXIT_RULES.low_buy_second_target_r * r) : null;
  const timeStop = line === "board"
    ? "D+1 14:50 仍未封板清仓；开板/炸板按 A–H 分级，弱回封卖一半，炸板或二次开板清仓"
    : "低吸持有第 3 个交易日（线上阴线第 2 个）仍未涨过买入价 +2% 则清仓";
  const hardRules = line === "board" ? [
    "硬止损：收盘跌破止损价即清仓，LLM 不得放宽",
    "开板/炸板：弱回封卖一半，炸板、尾盘开板或二次开板清仓",
    "时间止损：D+1 14:50 仍未封板清仓，不把打板做成中线",
  ] : [
    "硬止损：收盘跌破结构位/失效位即清仓，LLM 不得放宽",
    "第一止盈：买入价 +1.5R 卖出一半",
    "第二止盈：买入价 +2.5R 清仓落袋",
    "时间止损：D+2/D+3 仍未启动（未涨过买入价 +2%）清仓",
  ];
  const evidence: Record<string, unknown> = {
    line,
    entry,
    stop,
    invalidation,
    target_1: targetOne,
    target_2: targetTwo,
    current_close: close,
    close_date,
    target_date: holding.target_date,
    position_opened_at: holding.position_opened_at,
    r_multiple: close !== null && entry !== null && r !== null
      ? Number(((close - entry) / r).toFixed(2)) : null,
    time_stop: timeStop,
    hard_rules: hardRules,
    risk: holding.risk,
  };
  const evaluation = (
    action: StrategyPositionEvaluation["action"],
    reason: string,
    triggerKind: string,
    triggerPrice: number | null,
    protectionPrice: number | null,
  ): StrategyPositionEvaluation => ({
    code, name, strategy_code: "ultra_short", evaluation_role: "primary",
    action, trigger_kind: triggerKind,
    trigger_price_lower: triggerPrice, trigger_price_upper: triggerPrice,
    protection_price: protectionPrice, reason, evidence, missing_items: [],
  });

  if (entry === null || stop === null) {
    return evaluation("observe", "超短持仓缺少入场价/止损位", "condition", null, null);
  }
  if (entry <= stop) {
    return evaluation("observe", "超短持仓止损位不低于入场价，无法计算 R 倍数", "condition", null, null);
  }
  if (close === null) {
    return evaluation("observe", "超短持仓缺少最新收盘价，无法按硬规则判定", "condition", null, stop);
  }
  if (close <= stop) {
    return evaluation("exit",
      `超短硬止损：收盘 ${priceText(close)} 已跌破止损位 ${priceText(stop)}，清仓（硬规则，不得放宽）`,
      "open", stop, stop);
  }
  if (targetTwo !== null && close >= targetTwo) {
    return evaluation("exit",
      `低吸第二止盈：收盘 ${priceText(close)} 达到买入价 +${EXIT_RULES.low_buy_second_target_r}R（${priceText(targetTwo)}），清仓落袋`,
      "price_range", targetTwo, stop);
  }
  if (targetOne !== null && close >= targetOne) {
    return evaluation("reduce",
      `低吸第一止盈：收盘 ${priceText(close)} 达到买入价 +${EXIT_RULES.low_buy_first_target_r}R（${priceText(targetOne)}），先卖出一半`,
      "price_range", targetOne, stop);
  }
  return evaluation("hold", line === "board"
    ? `超短打板持仓未跌破硬止损 ${priceText(stop)}；封住持有，断板/炸板与 D+1 14:50 未封板由盘中监控清仓`
    : `超短低吸持仓未跌破硬止损 ${priceText(stop)}，也未触及 +${EXIT_RULES.low_buy_first_target_r}R/+${EXIT_RULES.low_buy_second_target_r}R 止盈；时间止损由盘中监控执行`,
  "condition", stop, stop);
}

/** 每日计划 LLM 只解释超短规则，不得改写结构化动作或放宽硬止损。 */
function ultraShortPlaybookEvidence(primary: StrategyPositionEvaluation): string {
  const evidence = resultRecord(primary.evidence);
  const rules = Array.isArray(evidence.hard_rules) ? evidence.hard_rules.map(String) : [];
  const price = (value: unknown): string =>
    typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";
  return [
    `超短确定性硬规则（服务端计算，LLM 只解释不放宽）：${rules.join("；")}`,
    `当前判定：${primary.reason}`,
    `入场 ${price(evidence.entry)}｜止损 ${price(evidence.stop)}｜第一止盈 ${price(evidence.target_1)}｜第二止盈 ${price(evidence.target_2)}｜失效 ${price(evidence.invalidation)}`,
    `时间止损：${String(evidence.time_stop ?? "—")}`,
  ].join("\n");
}

export async function queryDailyPlanStrategyContext(
  pool: pg.Pool,
  input: { date: string; requested_by_job_run_id?: string | null; account_id?: string },
) {
  const [definitions, positions, legacyContext, activeAttentions, newsSnapshot, ultraShortHoldings] = await Promise.all([
    listStrategyRuntimeDefinitions(pool),
    listPositions(pool, input.account_id),
    queryDailyPlanContext(pool, input.date, input.account_id),
    pool.query<{
      code: string; name: string; strategy_code: string; strategy_name: string; status: string; reason: string;
      missing_signals: string[]; data_date: string | null; stale_reason: string | null;
    }>(
      `SELECT instrument.code,instrument.name,entry.strategy_code,strategy.name AS strategy_name,
              entry.status,entry.reason,entry.missing_signals,entry.data_date::text,entry.stale_reason
         FROM pool_attention_entry entry
         JOIN market_instrument instrument ON instrument.id=entry.instrument_id
         JOIN strategy_definition strategy ON strategy.code=entry.strategy_code
        WHERE entry.source_type='strategy' AND entry.valid_from <= $1::date
          AND (entry.valid_until IS NULL OR entry.valid_until >= $1::date)
        ORDER BY strategy.name,instrument.code`,
      [input.date],
    ),
    getLatestMarketNews(pool, input.date),
    // 超短持仓由 05 离场硬规则在每日计划内直接判定；这里只取每代码最新一行持仓事实。
    pool.query<UltraShortHoldingFacts & { code: string }>(
      `SELECT DISTINCT ON (code) code, target_date::text AS target_date,
              entry_price::float8 AS entry_price, position_opened_at::text,
              key_levels, tags, risk
         FROM ultra_short_watchlist
        WHERE exit_status IN ('holding','exit_triggered') AND target_date >= $1::date - 10
        ORDER BY code, target_date DESC, id DESC`,
      [input.date],
    ),
  ]);
  const ultraShortByCode = new Map(ultraShortHoldings.rows.map((row) => [row.code, row]));
  const byCode = new Map(definitions.map((definition) => [definition.code, definition]));
  const requests = new Map<string, { strategy: StrategyRuntimeDefinition; phase: "entry" | "exit" | "context" }>();
  const add = (strategy: StrategyRuntimeDefinition, phase: "entry" | "exit" | "context") =>
    requests.set(`${strategy.code}:${phase}`, { strategy, phase });

  const gaps: Record<string, unknown>[] = [];
  for (const position of positions) {
    // 超短持仓不再调用原 limit_up/兜底退出评估器，避免两套规则重复分析同一持仓。
    if (ultraShortByCode.has(position.code)) continue;
    if (!position.strategy_code) {
      gaps.push({ code: position.code, scope: "position", reason: "当前持仓尚未归因运行时策略" });
      continue;
    }
    const strategy = byCode.get(position.strategy_code);
    if (!strategy) {
      gaps.push({ code: position.code, scope: "position", reason: `持仓策略不存在：${position.strategy_code}` });
      continue;
    }
    const mode = position.exit_policy_mode ?? strategy.exit_policy_mode;
    if (mode !== "fallback_only" && strategy.exit_evaluator_code) add(strategy, "exit");
    if (["fallback_only", "dedicated_plus_fallback"].includes(mode) && position.fallback_strategy_code) {
      const fallback = byCode.get(position.fallback_strategy_code);
      if (fallback?.exit_evaluator_code) add(fallback, "exit");
      else gaps.push({ code: position.code, scope: "fallback", reason: `兜底策略不可用：${position.fallback_strategy_code}` });
    }
  }

  const requested = [...requests.values()];
  const settled = await Promise.allSettled(requested.map(async ({ strategy, phase }): Promise<EvaluationRecord> => ({
    strategy,
    phase,
    ensured: await ensureStrategyEvaluation(pool, {
      strategy_code: strategy.code,
      phase,
      account_id: input.account_id ?? "1",
      target_date: input.date,
      requested_by_job_run_id: input.requested_by_job_run_id ?? null,
    }),
  })));
  const evaluations = settled.flatMap((result, index) => {
    if (result.status === "fulfilled") return [result.value];
    gaps.push({ strategy_code: requested[index]!.strategy.code, phase: requested[index]!.phase,
      reason: "策略评估不可用；对应持仓仅展示为待复核" });
    return [];
  });
  const evaluationByKey = new Map(evaluations.map((evaluation) => [`${evaluation.strategy.code}:${evaluation.phase}`, evaluation]));
  for (const evaluation of evaluations) {
    const gap = evaluationGap(evaluation);
    if (gap) gaps.push(gap);
  }

  const attentionChanges: StrategyAttentionChange[] = [];
  const technicalByCode = new Map(legacyContext.positions.items.map((item) => [item.code, item.technical_levels]));
  const boardsByCode = new Map(legacyContext.position_boards.items.map((item) => [item.code, item]));
  const positionEvaluations = positions.map((position) => {
    const ultraShort = ultraShortByCode.get(position.code);
    if (ultraShort) {
      // 超短持仓：05 硬规则直接给出结构化动作，作为 primary，explanation 交给每日计划 LLM。
      const primary = evaluateUltraShortPositionExit({
        code: position.code, name: position.name, close: position.close,
        close_date: position.close_date, holding: ultraShort,
      });
      return {
        code: position.code, name: position.name,
        strategy_code: position.strategy_code ?? "ultra_short",
        strategy_name: "超短策略", exit_policy_mode: "dedicated" as const,
        primary, fallback: null,
        effective_action: primary.action, effective_source: "primary" as const,
        effective_reason: primary.reason,
        primary_evaluation_run_id: null, fallback_evaluation_run_id: null,
        evaluation_status: "success" as const, data_date: position.close_date,
        missing_items: [] as string[], strategy_runtime_version: position.strategy_runtime_version ?? null,
        key_levels: buildKeyLevels(technicalByCode.get(position.code)),
        boards: boardsByCode.get(position.code) ?? null,
      };
    }
    if (!position.strategy_code || !byCode.has(position.strategy_code)) return {
      code: position.code, name: position.name, strategy_code: position.strategy_code, strategy_name: null,
      exit_policy_mode: null, primary: null, fallback: null,
      effective_action: "observe" as const, effective_source: "none" as const,
      effective_reason: "持仓策略未归因或不可用，无法选择出场策略",
      primary_evaluation_run_id: null, fallback_evaluation_run_id: null,
      evaluation_status: "partial" as const, data_date: legacyContext.market.data_date,
      missing_items: ["持仓策略未归因或不可用"], strategy_runtime_version: null,
      key_levels: buildKeyLevels(technicalByCode.get(position.code)),
      boards: boardsByCode.get(position.code) ?? null,
    };
    const strategy = byCode.get(position.strategy_code)!;
    const mode = position.exit_policy_mode ?? strategy.exit_policy_mode;
    const primaryRequired = mode !== "fallback_only" && Boolean(strategy.exit_evaluator_code);
    const fallbackRequired = ["fallback_only", "dedicated_plus_fallback"].includes(mode);
    const primaryRun = primaryRequired ? evaluationByKey.get(`${strategy.code}:exit`) : undefined;
    const fallbackRun = fallbackRequired && position.fallback_strategy_code
      ? evaluationByKey.get(`${position.fallback_strategy_code}:exit`) : undefined;
    const primary = positionItems(primaryRun).find((item) => item.code === position.code) ?? null;
    const fallback = positionItems(fallbackRun).find((item) => item.code === position.code) ?? null;
    const merged = mergeExitEvaluations(position.strategy_code, position.exit_policy_mode ?? strategy.exit_policy_mode, primary, fallback);
    const missingItems = positionGapReasons([
      ...(primaryRequired && !primaryRun ? ["主策略退出评估不可用"] : []),
      ...(fallbackRequired && !fallbackRun ? ["兜底退出评估不可用"] : []),
      ...(primaryRequired && primaryRun && !primary ? ["主策略未返回该持仓评估"] : []),
      ...(fallbackRequired && fallbackRun && !fallback ? ["兜底策略未返回该持仓评估"] : []),
      ...(primary?.missing_items ?? []), ...(fallback?.missing_items ?? []),
      ...gapsForPosition(primaryRun, position.code), ...gapsForPosition(fallbackRun, position.code),
    ], position.code);
    const incomplete = Boolean(missingItems.length) || [primaryRun, fallbackRun]
      .some((run) => run && ["failed", "running", "queued"].includes(run.ensured.run.status));
    const evaluationStatus = primaryRun?.ensured.execution === "waiting" || fallbackRun?.ensured.execution === "waiting"
      ? "waiting" as const : incomplete ? "partial" as const : "success" as const;
    const uncertain = evaluationStatus !== "success" && ["hold", "observe"].includes(merged.effective_action);
    return {
      ...merged,
      code: position.code,
      name: position.name,
      ...(uncertain ? {
        effective_action: "observe" as const,
        effective_source: "none" as const,
        effective_reason: "退出评估不完整，不能判断继续持有；需人工复核",
      } : {}),
      strategy_name: strategy.name,
      strategy_runtime_version: position.strategy_runtime_version ?? strategy.runtime_version,
      primary_evaluation_run_id: primaryRun?.ensured.run.id ?? null,
      fallback_evaluation_run_id: fallbackRun?.ensured.run.id ?? null,
      evaluation_status: evaluationStatus,
      data_date: primaryRun?.ensured.run.data_date ?? fallbackRun?.ensured.run.data_date ?? legacyContext.market.data_date,
      missing_items: missingItems,
      // 情景/做T预案输入：技术面关键点位与板块归属，与策略评估解耦。
      key_levels: buildKeyLevels(technicalByCode.get(position.code)),
      boards: boardsByCode.get(position.code) ?? null,
    };
  });

  const playbookItems: PlaybookItemInput[] = [
    ...positionEvaluations.map((item): PlaybookItemInput => {
      const effective = item.effective_source === "primary" ? item.primary : item.effective_source === "fallback" ? item.fallback : null;
      const triggerKind: PlaybookItemInput["trigger_kind"] =
        effective?.trigger_kind === "open" || effective?.trigger_kind === "price_range"
          ? effective.trigger_kind : "condition";
      return {
        item_kind: "position_action" as const,
        code: item.code,
        action: item.effective_action,
        trigger_kind: triggerKind,
        ...(effective?.trigger_price_lower !== null && effective?.trigger_price_lower !== undefined
          ? { price_lower: effective.trigger_price_lower } : {}),
        ...(effective?.trigger_price_upper !== null && effective?.trigger_price_upper !== undefined
          ? { price_upper: effective.trigger_price_upper } : {}),
        headline: `${item.strategy_name ?? "待归因"}｜${item.effective_reason}`,
        evidence_md: item.primary?.strategy_code === "ultra_short" && item.primary
          ? ultraShortPlaybookEvidence(item.primary)
          : `主策略：${item.primary?.reason ?? "无"}；兜底：${item.fallback?.reason ?? "无"}`,
        key_levels: item.key_levels,
        ...(item.missing_items.length ? { missing_md: item.missing_items.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("；") } : {}),
        ...(item.strategy_code ? { strategy_code: item.strategy_code } : {}),
        ...(item.strategy_runtime_version ? { strategy_runtime_version: item.strategy_runtime_version } : {}),
        primary_evaluation_run_id: item.primary_evaluation_run_id,
        fallback_evaluation_run_id: item.fallback_evaluation_run_id,
        primary_action: item.primary?.action ?? null,
        fallback_action: item.fallback?.action ?? null,
        effective_action: item.effective_action,
        evaluation_status: item.evaluation_status,
        evaluation_data_date: item.data_date,
        evaluation_missing: item.missing_items.map((value) => typeof value === "string" ? value : JSON.stringify(value)),
      };
    }),
  ];

  const playbookWrite = input.requested_by_job_run_id
    ? await replaceDraftPlaybook(pool, { source_job_run_id: input.requested_by_job_run_id, items: playbookItems })
    : null;

  // 盘前消息面：任务已移至盘前运行，情景/开盘预案结合当日快照；缺失或过期必须列为缺口。
  const marketNews = newsSnapshot ? {
    target_date: newsSnapshot.target_date,
    captured_at: newsSnapshot.captured_at,
    market_bias: newsSnapshot.market_bias,
    summary: newsSnapshot.summary,
    stale: newsSnapshot.stale,
    positions: positionEvaluations.map((item) => {
      const news = instrumentNews(newsSnapshot, item.code);
      return {
        code: item.code,
        direction: news.direction,
        status: news.status,
        items: news.items.map((entry) => ({
          title: entry.title,
          direction: entry.direction,
          impact_level: entry.impact_level,
          published_at: entry.published_at,
          source_name: entry.source_name,
        })),
      };
    }),
  } : null;
  const newsGaps: Record<string, unknown>[] = newsSnapshot
    ? (newsSnapshot.stale
      ? [{ scope: "market_news", reason: `盘前消息快照已过期（采集于 ${newsSnapshot.captured_at}）` }]
      : [])
    : [{ scope: "market_news", reason: "当日盘前消息快照缺失，开盘情景缺少消息面输入" }];

  const requiredDocuments = new Set<string>(["daily_plan_strategy"]);
  const portfolioDocuments = await pool.query<{ code: string }>(
    "SELECT code FROM strategy_document WHERE role='portfolio' ORDER BY injection_order,id",
  );
  for (const document of portfolioDocuments.rows) requiredDocuments.add(document.code);
  for (const evaluation of evaluations) requiredDocuments.add(evaluation.strategy.strategy_document_code);
  const waitingCount = evaluations.filter((item) => item.ensured.execution === "waiting").length;
  const status = gaps.length || newsGaps.length || legacyContext.status !== "success" || waitingCount
    ? "partial" as const : "success" as const;
  return {
    requested_date: input.date,
    status,
    strategy_snapshot_hash: evaluations[0]?.ensured.run.strategy_snapshot_hash ?? null,
    market: legacyContext.market,
    market_structure_sync: legacyContext.market_structure_sync,
    risk_gate: legacyContext.risk_gate,
    trial_evaluation: legacyContext.trial_evaluation,
    strategy_coverage: {
      expected_evaluations: requests.size,
      completed_evaluations: evaluations.filter((item) => item.ensured.execution !== "waiting").length,
      waiting_evaluations: waitingCount,
      executed_evaluations: evaluations.filter((item) => item.ensured.execution === "executed").length,
      reused_evaluations: evaluations.filter((item) => item.ensured.execution === "reused").length,
      position_count: positions.length,
      attributed_position_count: positions.filter((position) => position.strategy_code !== null).length,
      primary_position_count: positionEvaluations.filter((item) => item.primary !== null).length,
      fallback_position_count: positionEvaluations.filter((item) => item.fallback !== null).length,
      attention_count: activeAttentions.rows.length,
      attention_change_count: attentionChanges.length,
    },
    required_strategy_documents: [...requiredDocuments],
    evaluations: evaluations.map((item) => ({
      strategy_code: item.strategy.code, strategy_name: item.strategy.name, phase: item.phase,
      execution: item.ensured.execution, run: item.ensured.run, result: item.ensured.result,
    })),
    position_evaluations: positionEvaluations,
    position_boards: legacyContext.position_boards,
    board_day_ranking: legacyContext.board_day_ranking,
    market_news: marketNews,
    active_attentions: activeAttentions.rows,
    attention_changes: attentionChanges,
    playbook_items: playbookItems,
    playbook_write: playbookWrite,
    gaps: [...legacyContext.gaps, ...gaps, ...newsGaps],
  };
}
