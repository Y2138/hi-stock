// 市场领域只读工具：只经领域 service 读取 PostgreSQL 事实，不接收 SQL、表名、URL 或 datasource 端点。
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import { saveStrategyShortlist, SELECTION_SOURCES } from "../modules/selection/service.js";
import { listBoardConstituents, listBoards } from "../modules/boards/repo.js";
import {
  findInstrumentByCode,
  latestIndicatorStatus,
  listLatestDailyBars,
  listBars,
  searchInstruments,
  type InstrumentKind,
  type MarketFreq,
} from "../modules/market/repo.js";
import {
  MARKET_STRUCTURE_DATASETS,
  queryMarketStructure,
  type MarketStructureDataset,
} from "../modules/market/structure.js";
import type { LimitUpSignalResult } from "../modules/market/limit-up-signals.js";
import { queryDailyPlanContext } from "../modules/plans/daily-context.js";
import { queryStockResearch } from "../modules/market/research.js";
import { queryValueRank } from "../modules/value-ranking/service.js";
import { reconcileStrategyAttention } from "../modules/strategy-runtime/attention.js";
import { executeStrategyEvaluator } from "../modules/strategy-runtime/registry.js";
import { ensureStrategyEvaluation } from "../modules/strategy-runtime/service.js";
import { queryDailyPlanStrategyContext } from "../modules/strategy-runtime/daily-plan.js";
import { limitUpOpportunityItems } from "../modules/strategy-runtime/limit-up-opportunities.js";
import { replaceDraftPlaybook } from "../modules/plans/repo.js";
import { listStrategyRuntimeDefinitions } from "../modules/strategy-runtime/repo.js";
import { strategyForSession } from "./business-context-tools.js";
import { insertToolAudit } from "./repo.js";
import { sha256Json } from "./hash.js";
import { validateToolInput } from "./tool-validation.js";

const Code = Type.String({ minLength: 1, maxLength: 32, pattern: "^[A-Za-z0-9._-]+$" });
const DateString = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const strict = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const InstrumentSearchSchema = strict({
  q: Type.String({ minLength: 1, maxLength: 80 }),
  kind: Type.Optional(Type.Union([
    Type.Literal("stock"), Type.Literal("etf"), Type.Literal("index"),
    Type.Literal("board"), Type.Literal("fund"), Type.Literal("futures"),
  ])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});
const SnapshotSchema = strict({
  codes: Type.Array(Code, { minItems: 1, maxItems: 200 }),
});
const StockResearchSchema = strict({
  codes: Type.Array(Code, { minItems: 1, maxItems: 20, uniqueItems: true }),
  as_of: Type.Optional(DateString),
});
const BoardSchema = strict({
  mode: Type.Union([Type.Literal("list"), Type.Literal("constituents")]),
  type: Type.Optional(Type.Union([
    Type.Literal("industry"), Type.Literal("concept"), Type.Literal("region"), Type.Literal("special"),
  ])),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  code: Type.Optional(Code),
  as_of: Type.Optional(DateString),
});
const MarketEventSchema = strict({
  date: DateString,
  dataset: Type.Union(MARKET_STRUCTURE_DATASETS.map((dataset) => Type.Literal(dataset))),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
  size: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
const LimitUpSignalSchema = strict({ date: DateString });
const DailyPlanContextSchema = strict({ date: DateString });
const DailyPlanStrategySchema = strict({ date: DateString });
const SwingSignalSchema = strict({ date: DateString });
const ValueRankSchema = strict({ as_of: Type.Optional(DateString), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), codes: Type.Optional(Type.Array(Code, { maxItems: 50, uniqueItems: true })) });
const ValueAnchorSignalSchema = strict({ date: DateString });
const TwoYearReversalSignalSchema = strict({ date: DateString });
const StrategyEvaluationSchema = strict({
  date: DateString,
  phase: Type.Union([Type.Literal("entry"), Type.Literal("exit"), Type.Literal("context")]),
  strategy_code: Type.Optional(Type.String({ minLength: 1, maxLength: 96, pattern: "^[a-z][a-z0-9_]*$" })),
});
const IndicatorSchema = strict({
  codes: Type.Array(Code, { minItems: 1, maxItems: 20 }),
  freq: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("30m"), Type.Literal("futures_day")])),
  start: Type.Optional(DateString),
  end: Type.Optional(DateString),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
});

function toolResult(value: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

async function audited(
  deps: { pool: pg.Pool; sessionId: string | null },
  name: string,
  args: unknown,
  operation: () => Promise<unknown>,
): Promise<AgentToolResult<unknown>> {
  const value = stripSourcePayload(await operation());
  await insertToolAudit(deps.pool, {
    session_id: deps.sessionId,
    tool_name: name,
    args,
    result_sha256: sha256Json(value),
    status: "ok",
  });
  return toolResult(value);
}

function stripSourcePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSourcePayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "source_payload")
        .map(([key, child]) => [key, stripSourcePayload(child)]),
    );
  }
  return value;
}

/** 打板评分是当前策略的正式只读执行能力。 */
export function buildLimitUpSignalTool(deps: { pool: pg.Pool; sessionId: string | null }): AgentTool {
  return {
    name: "limit_up_signal_query",
    label: "查询涨停分阶段与同高度PK",
    description: "按目标日完整扫描涨停事件，返回首板、二三板确认、高位续板的承接证据、同高度竞争组、两路线数据顺位和当时可用消息。旧抱团分、主升分仅作背景，不再作为入选线。数据首位仍须核验消息、情绪、竞价与可成交性；不得把顺位或一字强势解释为买入收益。",
    parameters: LimitUpSignalSchema,
    execute: async (_id, raw) => {
      const input = validateToolInput<Static<typeof LimitUpSignalSchema>>("limit_up_signal_query", LimitUpSignalSchema, raw);
      return audited(deps, "limit_up_signal_query", input, async () => {
        const strategy = await strategyForSession(deps);
        const documentId = strategy.documents.find((document) => document.code === "limit_up_board")?.id ?? null;
        const value = await executeStrategyEvaluator<LimitUpSignalResult>("limit_up_observation_v1", {
          pool: deps.pool, targetDate: input.date, strategyDocumentId: documentId,
        });
        return {
          ...value,
          candidates: value.candidates.map((candidate) => ({
            code: candidate.code,
            name: candidate.name,
            main_theme: candidate.main_theme,
            streak_count: candidate.streak_count,
            cluster_score: candidate.cluster_score,
            momentum_score: candidate.momentum_score,
            cluster_rank: candidate.cluster_rank,
            momentum_rank: candidate.momentum_rank,
            signal_grade: candidate.signal_grade,
            data_status: candidate.data_status,
            missing_inputs: candidate.missing_inputs,
            risk_flags: candidate.risk_flags,
            pk: candidate.pk,
          })),
        };
      });
    },
  };
}

export function buildStrategyEvaluationTool(deps: {
  pool: pg.Pool;
  sessionId: string | null;
  jobCode?: string;
  accountId?: string | null;
}): AgentTool {
  return {
    name: "strategy_evaluation_query",
    label: "查询策略结构化评估",
    description: "按策略、阶段和目标日确保一次结构化评估运行；相同输入成功结果直接复用，运行中请求返回 waiting，失败或部分结果可重试。独立入场任务会按结构化结果自动对账本策略关注来源。任务会话只能执行任务绑定的策略与阶段，不得借此查询其他策略。",
    parameters: StrategyEvaluationSchema,
    execute: async (_id, raw) => {
      const input = validateToolInput<Static<typeof StrategyEvaluationSchema>>(
        "strategy_evaluation_query", StrategyEvaluationSchema, raw,
      );
      let strategyCode = input.strategy_code ?? null;
      let requestedByJobRunId: string | null = null;
      let jobAgentRole: string | null = null;
      if (deps.jobCode) {
        const binding = await deps.pool.query<{
          strategy_code: string | null;
          agent_role: string | null;
          strategy_type: string | null;
        }>(`SELECT definition.strategy_code,definition.agent_role,strategy.strategy_type
              FROM job_definition definition
              LEFT JOIN strategy_definition strategy ON strategy.code=definition.strategy_code
             WHERE definition.code=$1`, [deps.jobCode]);
        const row = binding.rows[0];
        if (!row) throw new Error(`未知任务：${deps.jobCode}`);
        jobAgentRole = row.agent_role;
        if (row.strategy_code) {
          if (strategyCode && strategyCode !== row.strategy_code) throw new Error(`任务 ${deps.jobCode} 只能评估策略 ${row.strategy_code}`);
          strategyCode = row.strategy_code;
          const expectedPhase = row.strategy_type === "portfolio_overlay" ? "context"
            : row.agent_role === "strategy_exit_report" ? "exit" : "entry";
          if (input.phase !== expectedPhase) throw new Error(`任务 ${deps.jobCode} 只能执行 ${expectedPhase} 评估`);
        }
        if (deps.sessionId) {
          requestedByJobRunId = (await deps.pool.query<{ id: string }>(
            `SELECT run.id::text FROM job_run run JOIN job_definition definition ON definition.id=run.job_id
              WHERE run.session_id=$1 AND definition.code=$2 AND run.status IN ('queued','running')
              ORDER BY run.id DESC LIMIT 1`, [deps.sessionId, deps.jobCode],
          )).rows[0]?.id ?? null;
        }
      }
      if (!strategyCode) throw new Error("strategy_evaluation_query 必须提供 strategy_code");
      if (deps.accountId === null && input.phase !== "entry") throw new Error("全局研究不评估个人持仓，请进入账户页面");
      return audited(deps, "strategy_evaluation_query", { ...input, strategy_code: strategyCode }, async () => {
        const ensured = await ensureStrategyEvaluation(deps.pool, {
          strategy_code: strategyCode!, phase: input.phase, target_date: input.date,
          requested_by_job_run_id: requestedByJobRunId,
          account_id: deps.accountId,
        });
        if (requestedByJobRunId && input.phase === "entry" && ensured.execution !== "waiting"
          && deps.jobCode && Object.hasOwn(SELECTION_SOURCES, deps.jobCode)) {
          await saveStrategyShortlist(deps.pool, requestedByJobRunId, strategyCode!, input.date, ensured.result,
            { evaluation_run_id: ensured.run.id, evaluator_version: ensured.run.evaluator_version,
              strategy_snapshot_hash: ensured.run.strategy_snapshot_hash }, ensured.run.status, ensured.run.gaps);
        }
        let opportunityWrite: { replaced: number } | null = null;
        if (deps.jobCode === "limit_up_close_scan" && input.phase === "entry"
          && requestedByJobRunId && ensured.execution !== "waiting" && ensured.run.status === "success") {
          const strategy = (await listStrategyRuntimeDefinitions(deps.pool)).find((item) => item.code === "limit_up");
          if (!strategy) throw new Error("收盘打板策略定义不可用");
          opportunityWrite = await replaceDraftPlaybook(deps.pool, {
            source_job_run_id: requestedByJobRunId, items: limitUpOpportunityItems({ strategy, ensured }),
          });
        }
        const attentionChanges = deps.jobCode && jobAgentRole === "strategy_entry_report"
          && input.phase === "entry" && ensured.execution !== "waiting"
          ? await reconcileStrategyAttention(deps.pool, { run: ensured.run, source_job: deps.jobCode })
          : [];
        const native = ensured.result && typeof ensured.result === "object" && !Array.isArray(ensured.result)
          ? ensured.result as Record<string, unknown> : null;
        if (native?.shortlisted) {
          // 完整命中登记供统一精选读取，策略报告只展开初筛，减少模型重复阅读。
          const { shortlist_matches: _matches, ...reportResult } = native;
          return { ...ensured, result: reportResult, run: { ...ensured.run, result: reportResult },
            attention_changes: attentionChanges, opportunity_write: opportunityWrite };
        }
        return { ...ensured, attention_changes: attentionChanges, opportunity_write: opportunityWrite };
      });
    },
  };
}

export function buildDailyPlanStrategyTool(deps: {
  pool: pg.Pool;
  sessionId: string | null;
  jobCode?: string;
  accountId?: string | null;
}): AgentTool {
  return {
    name: "daily_plan_strategy_query",
    label: "查询每日计划策略统筹",
    description: "按目标日复用共享市场上下文，只评估绑定账户持仓的主策略与兜底策略，由服务端写入该账户的结构化预案；返回账户持仓动作、覆盖门禁、playbook_items 与 playbook_write。不得再调用 daily_plan_write 或逐工具手工拼装每日计划。",
    parameters: DailyPlanStrategySchema,
    execute: async (_id, raw) => {
      const input = validateToolInput<Static<typeof DailyPlanStrategySchema>>(
        "daily_plan_strategy_query", DailyPlanStrategySchema, raw,
      );
      if (deps.jobCode !== "daily_plan_flow") throw new Error("daily_plan_strategy_query 只允许每日计划任务使用");
      let runId: string | null = null;
      if (deps.sessionId && deps.jobCode === "daily_plan_flow") {
        runId = (await deps.pool.query<{ id: string }>(
          `SELECT run.id::text FROM job_run run JOIN job_definition definition ON definition.id=run.job_id
            WHERE run.session_id=$1 AND definition.code='daily_plan_flow' AND run.status IN ('queued','running')
            ORDER BY run.id DESC LIMIT 1`, [deps.sessionId],
        )).rows[0]?.id ?? null;
      }
      return audited(deps, "daily_plan_strategy_query", input, () => queryDailyPlanStrategyContext(deps.pool, {
        date: input.date, requested_by_job_run_id: runId, account_id: deps.accountId ?? undefined,
      }));
    },
  };
}

/** 旧每日计划兼容上下文：保留交互排障和结果对比，正式每日计划使用 daily_plan_strategy_query。 */
export function buildDailyPlanContextTool(deps: { pool: pg.Pool; sessionId: string | null; accountId?: string | null }): AgentTool {
  return {
    name: "daily_plan_context_query",
    label: "查询旧每日计划兼容上下文",
    description: "按目标日一次性返回完整881一级行业市场状态与温度、七类市场结构同步、关注池逐只右侧六条件存活与试盘形态推进的评估性证据；同时返回每笔持仓的 entry_signal_type 与 evaluation_basis：波段持仓的 swing_triggers（观察期、灾难止损、常规止损、箱顶目标、到期）、存量左侧反转持仓的 left_reversal_triggers（初始止损、6%/16%分批、10日到期）、其余持仓的止损档位、冷却期、止盈/止损位、退出候选，以及 MA10 护盘收回率。右侧与试盘只用于持有和概率评估，不产生开仓信号；开仓信号只认 swing_signal_query。只返回结论和必要数值证据，不返回原始行情序列；正式每日计划使用 daily_plan_strategy_query；本工具仅供兼容查询和排障，不得用通用数据库工具手算。",
    parameters: DailyPlanContextSchema,
    execute: async (_id, raw) => {
      const input = validateToolInput<Static<typeof DailyPlanContextSchema>>("daily_plan_context_query", DailyPlanContextSchema, raw);
      if (deps.accountId === null) throw new Error("持仓上下文需要选择账户，请进入持仓页面");
      return audited(deps, "daily_plan_context_query", input, () => queryDailyPlanContext(deps.pool, input.date, deps.accountId ?? "1"));
    },
  };
}

/** 波段四条件扫描兼容查询；正式运行由独立策略任务调用结构化评估。 */
export function buildSwingSignalTool(deps: { pool: pg.Pool; sessionId: string | null; accountId?: string | null }): AgentTool {
  return {
    name: "swing_signal_query",
    label: "查询波段确定性信号",
    description: "按目标日覆盖16个周期及新能源设备行业、从全部行业细分筛选高活跃代表标的并把总量固定在388只以内，返回40日箱体、缩量/反转形态/RSI14/预期盈亏比四条件、T+1突破与价格上限、已有持仓抑制、正式信号、按唯一未达条件距阈值的信号质量排序后前5只接近候选和逐只数据缺口；正式运行由波段独立任务负责，不得用关注池或通用查询手工限定扫描范围。",
    parameters: SwingSignalSchema,
    execute: async (_id, raw) => {
      const input = validateToolInput<Static<typeof SwingSignalSchema>>("swing_signal_query", SwingSignalSchema, raw);
      return audited(deps, "swing_signal_query", input, () => executeStrategyEvaluator("swing_entry_v1", {
        pool: deps.pool, targetDate: input.date, accountId: deps.accountId === undefined ? "1" : deps.accountId,
      }));
    },
  };
}

export function buildValueRankTool(deps: { pool: pg.Pool; sessionId: string | null }): AgentTool {
  return {
    name: "value_rank_query", label: "查询月度价值排名",
    description: "读取当前或指定日期已生效的月度价值Top5/Top10/Top50及质量分、价值分、总分和缺口；只读，不入池、不写持仓。",
    parameters: ValueRankSchema,
    execute: async (_id, raw) => {
      const input = validateToolInput<Static<typeof ValueRankSchema>>("value_rank_query", ValueRankSchema, raw);
      return audited(deps, "value_rank_query", input, () => queryValueRank(deps.pool, input));
    },
  };
}

export function buildValueAnchorSignalTool(deps: { pool: pg.Pool; sessionId: string | null }): AgentTool {
  return {
    name: "value_anchor_signal_query", label: "查询A级价值错杀",
    description: "按目标日读取当前月度Top50并执行固定的A级价值错杀条件，返回正式、接近、筛除项、建议10%增配比例和第20个交易日复核日期；研究只读，不入池、不写持仓。",
    parameters: ValueAnchorSignalSchema,
    execute: async (_id, raw) => {
      const input = validateToolInput<Static<typeof ValueAnchorSignalSchema>>("value_anchor_signal_query", ValueAnchorSignalSchema, raw);
      return audited(deps, "value_anchor_signal_query", input, () => executeStrategyEvaluator("value_anchor_entry_v1", {
        pool: deps.pool, targetDate: input.date,
      }));
    },
  };
}

export function buildTwoYearReversalSignalTool(deps: { pool: pg.Pool; sessionId: string | null; accountId?: string | null }): AgentTool {
  return {
    name: "two_year_reversal_signal_query", label: "查询两年结构反转新开仓信号",
    description: "按目标日由服务端固定规则扫描881一级行业与所属股票，返回覆盖、正式新开仓信号、接近候选和缺口；只读，供人工决策。",
    parameters: TwoYearReversalSignalSchema,
    execute: async (_id, raw) => {
      const input = validateToolInput<Static<typeof TwoYearReversalSignalSchema>>("two_year_reversal_signal_query", TwoYearReversalSignalSchema, raw);
      return audited(deps, "two_year_reversal_signal_query", input, () => executeStrategyEvaluator("two_year_reversal_entry_v1", {
        pool: deps.pool, targetDate: input.date, accountId: deps.accountId === undefined ? "1" : deps.accountId,
      }));
    },
  };
}

export function buildMarketDomainTools(deps: { pool: pg.Pool; sessionId: string | null }): AgentTool[] {
  return [
    {
      name: "instrument_search",
      label: "检索标的目录",
      description: "本地检索标准代码、名称和别名，最多返回 20 个候选及 kind、capabilities、persisted；不发起远程请求。",
      parameters: InstrumentSearchSchema,
      execute: async (_id, raw) => {
        const input = validateToolInput<Static<typeof InstrumentSearchSchema>>("instrument_search", InstrumentSearchSchema, raw);
        return audited(deps, "instrument_search", input, () => searchInstruments(deps.pool, {
          q: input.q,
          kind: input.kind as InstrumentKind | undefined,
          limit: input.limit ?? 20,
        }));
      },
    },
    {
      name: "stock_research_query",
      label: "查询标的研究证据",
      description: "一次读取最多20个本地标的在as_of目标日及此前的日线、正式股性、财报和估值。任务内自动绑定任务目标日，普通对话默认今日；财报按数据截至的报告日（最近一份包含该报告期的财报日期，不是首次披露日）和报告期双重过滤，都不晚于目标日。不要求在池内，不同步、不入池；返回日期、计算版本和缺口。本地缺失用扶摇补证，新闻用 web_search。",
      parameters: StockResearchSchema,
      execute: async (_id, raw) => {
        const input = validateToolInput<Static<typeof StockResearchSchema>>("stock_research_query", StockResearchSchema, raw);
        const codes = [...new Set(input.codes.map((code) => code.toUpperCase()))];
        const run = deps.sessionId ? (await deps.pool.query<{ target_date: string }>(
          "SELECT target_date::text FROM job_run WHERE session_id=$1 AND status='running' ORDER BY id DESC LIMIT 1",
          [deps.sessionId],
        )).rows[0] : undefined;
        if (run && input.as_of && input.as_of !== run.target_date) throw new Error("研究日期必须与任务目标日一致");
        const asOf = run?.target_date ?? input.as_of;
        return audited(deps, "stock_research_query", { codes, as_of: asOf }, () => queryStockResearch(deps.pool, codes, asOf));
      },
    },
    {
      name: "market_snapshot_query",
      label: "查询最新日线快照",
      description: "查询最多 200 个标的的最新日线收盘、前收、涨跌幅、数据日期和来源；不提供盘中或实时行情。",
      parameters: SnapshotSchema,
      execute: async (_id, raw) => {
        const input = validateToolInput<Static<typeof SnapshotSchema>>("market_snapshot_query", SnapshotSchema, raw);
        const codes = [...new Set(input.codes.map((code) => code.toUpperCase()))];
        return audited(deps, "market_snapshot_query", input, async () => ({
          as_of: new Date().toISOString(),
          frequency: "daily",
          bars: await listLatestDailyBars(deps.pool, codes),
        }));
      },
    },
    {
      name: "board_query",
      label: "查询板块与成分",
      description: "查询最多 20 个板块或某板块目标日最多 200 个有效成分，始终保留同步截止时间、状态和 gaps。",
      parameters: BoardSchema,
      execute: async (_id, raw) => {
        const input = validateToolInput<Static<typeof BoardSchema>>("board_query", BoardSchema, raw);
        return audited(deps, "board_query", input, async () => {
          if (input.mode === "list") return listBoards(deps.pool, { type: input.type, q: input.q, limit: 20 });
          if (!input.code || !input.as_of) throw new Error("constituents 模式必须提供 code 和 as_of");
          const result = await listBoardConstituents(deps.pool, input.code.toUpperCase(), input.as_of);
          if (!result) throw new Error(`未知板块：${input.code}`);
          const value = result as { constituents?: unknown[] };
          return { ...value, constituents: value.constituents?.slice(0, 200) ?? [] };
        });
      },
    },
    {
      name: "market_event_query",
      label: "查询市场结构",
      description: "分页查询目标交易日的涨跌停、炸板、连板或龙虎榜摘要，最多 200 行；返回 dataset status、覆盖和 gaps，不返回供应商原始 payload。",
      parameters: MarketEventSchema,
      execute: async (_id, raw) => {
        const input = validateToolInput<Static<typeof MarketEventSchema>>("market_event_query", MarketEventSchema, raw);
        return audited(deps, "market_event_query", input, () => queryMarketStructure(deps.pool, {
          date: input.date,
          dataset: input.dataset as MarketStructureDataset,
          page: input.page ?? 1,
          size: input.size ?? 50,
        }));
      },
    },
    {
      name: "indicator_query",
      label: "查询可信行情指标",
      description: "查询最多 20 个标的、每个最多 120 个实际行情时点的 OHLCV、MA/MACD/RSI14，并返回计算版本、复权、status 和 gaps；limit 表示每只标的最近 N 根，不是自然日数，untrusted 不包装为成功。",
      parameters: IndicatorSchema,
      execute: async (_id, raw) => {
        const input = validateToolInput<Static<typeof IndicatorSchema>>("indicator_query", IndicatorSchema, raw);
        return audited(deps, "indicator_query", input, async () => {
          const freq = (input.freq ?? "day") as MarketFreq;
          const rows = [];
          for (const code of [...new Set(input.codes.map((value) => value.toUpperCase()))]) {
            const instrument = await findInstrumentByCode(deps.pool, code);
            if (!instrument) {
              rows.push({ code, status: "missing", values: [] });
              continue;
            }
            const status = await latestIndicatorStatus(deps.pool, instrument.id, freq);
            const bars = await listBars(deps.pool, {
              instrumentId: instrument.id,
              freq,
              start: input.start,
              end: input.end,
              useIndicatorV2: status?.status === "success",
            });
            rows.push({
              code,
              calculation_version: status?.calculation_version ?? null,
              adjustment: status?.adjustment ?? null,
              status: status?.status ?? "pending",
              gaps: status?.gaps ?? [],
              values: bars.slice(-(input.limit ?? 120)).map((bar) => ({
                bar_date: bar.bar_date,
                bar_time: bar.bar_time,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
                turnover: bar.turnover,
                ma5: bar.ma5,
                ma10: bar.ma10,
                ma20: bar.ma20,
                ma60: bar.ma60,
                dif: bar.dif,
                dea: bar.dea,
                macd_hist: bar.macd_hist,
                rsi14: bar.rsi14,
              })),
            });
          }
          return rows;
        });
      },
    },
  ];
}
