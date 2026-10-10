import type pg from "pg";
import { positionGapReasons } from "../plans/evaluation-gaps.js";
import { queryDailyPlanContext } from "../plans/daily-context.js";
import { getLatestMarketNews, instrumentNews } from "../market-news/repo.js";
import { replaceDraftPlaybook, type DailyPlanKeyLevel, type PlaybookItemInput } from "../plans/repo.js";
import { listPositions } from "../positions/repo.js";
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


export async function queryDailyPlanStrategyContext(
  pool: pg.Pool,
  input: { date: string; requested_by_job_run_id?: string | null; account_id?: string },
) {
  const [definitions, positions, legacyContext, activeAttentions, newsSnapshot] = await Promise.all([
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
  ]);
  const byCode = new Map(definitions.map((definition) => [definition.code, definition]));
  const requests = new Map<string, { strategy: StrategyRuntimeDefinition; phase: "entry" | "exit" | "context" }>();
  const add = (strategy: StrategyRuntimeDefinition, phase: "entry" | "exit" | "context") =>
    requests.set(`${strategy.code}:${phase}`, { strategy, phase });

  const gaps: Record<string, unknown>[] = [];
  for (const position of positions) {
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
        evidence_md: `主策略：${item.primary?.reason ?? "无"}；兜底：${item.fallback?.reason ?? "无"}`,
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
