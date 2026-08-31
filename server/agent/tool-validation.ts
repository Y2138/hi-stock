// Agent 工具零信任边界：LLM 输出只是候选输入，服务端必须独立做严格结构校验。
// pi-agent-core 会在 loop 内校验一次；这里在每个 execute/domain 入口再次校验，
// 同时拒绝未知字段、超大载荷和会造成歧义的宽松对象。
import { Type, validateToolArguments, type Static, type TSchema } from "@earendil-works/pi-ai";
import type {
  DatabaseQueryInput,
  DatabaseSchemaInput,
} from "./database-tools.js";
import type { AgentBacktestRequest, JsonValue } from "../backtest/agent-contract.js";
import {
  HITHINK_DATASET_CAPABILITIES,
  normalizeHithinkDatasetRequest,
  type HithinkDatasetRequest,
} from "../datasource/hithink-datasets.js";
import { WEB_RESEARCH_ALLOWED_DOMAINS, WEB_RESEARCH_CONTRACT_LIMITS } from "./web-research-provider.js";

const IDENTIFIER_PATTERN = "^[a-z][a-z0-9_]{0,62}$";
const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const CODE_PATTERN = "^[A-Za-z0-9._-]{1,32}$";
const HASH_PATTERN = "^[a-f0-9]{64}$";
const MAX_TOOL_ARGUMENT_BYTES = 256 * 1024;

const strictObject = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

/**
 * 工具参数的联合类型必须同时在根节点暴露 properties/required。
 *
 * 部分模型适配器在非严格工具模式下只转发根节点的这两个字段；如果字段只存在于
 * anyOf 分支，模型最终看到的会是空对象 schema，并持续生成 `{}`。根节点保留完整
 * anyOf 供服务端严格校验，同时合并各分支字段供模型发现。重名但不同的字段（主要是
 * action）合并为属性级联合；根节点只要求每个分支共同必填的字段。
 */
const objectRoot = <T extends TSchema>(schema: T): T & { readonly type: "object" } => {
  const branches = (schema as TSchema & {
    anyOf?: Array<TSchema & { properties?: Record<string, TSchema>; required?: string[] }>;
  }).anyOf ?? [];
  const schemasByProperty = new Map<string, TSchema[]>();

  for (const branch of branches) {
    for (const [name, propertySchema] of Object.entries(branch.properties ?? {})) {
      const candidates = schemasByProperty.get(name) ?? [];
      if (!candidates.some((candidate) => JSON.stringify(candidate) === JSON.stringify(propertySchema))) {
        candidates.push(propertySchema);
      }
      schemasByProperty.set(name, candidates);
    }
  }

  const properties = Object.fromEntries(
    [...schemasByProperty].map(([name, candidates]) => [
      name,
      candidates.length === 1 ? candidates[0]! : Type.Union(candidates),
    ]),
  );
  const required = branches.length === 0
    ? []
    : (branches[0]!.required ?? []).filter((name) =>
        branches.every((branch) => (branch.required ?? []).includes(name)),
      );

  return Object.assign(schema, {
    type: "object" as const,
    properties,
    required,
    additionalProperties: false,
  });
};

const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 63,
  pattern: IDENTIFIER_PATTERN,
});

const HashSchema = Type.String({ minLength: 64, maxLength: 64, pattern: HASH_PATTERN });

const FILTER_OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "like",
  "ilike",
  "is_null",
  "not_null",
] as const;

const FilterSchema = strictObject({
  column: IdentifierSchema,
  op: Type.Optional(Type.Union(FILTER_OPERATORS.map((value) => Type.Literal(value)))),
  value: Type.Optional(Type.Unknown()),
});

const SelectSchema = strictObject({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  table: IdentifierSchema,
  schema_hash: HashSchema,
  columns: Type.Optional(Type.Array(IdentifierSchema, { minItems: 1, maxItems: 100 })),
  filters: Type.Optional(Type.Array(FilterSchema, { maxItems: 50 })),
  order_by: Type.Optional(
    Type.Array(
      strictObject({
        column: IdentifierSchema,
        direction: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
      }),
      { maxItems: 20 },
    ),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 500 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
  mode: Type.Optional(Type.Union([Type.Literal("rows"), Type.Literal("count")])),
});

export const DatabaseSchemaSchema = objectRoot(Type.Union([
  strictObject({
    operation: Type.Literal("list_tables"),
    domains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 50 }), { minItems: 1, maxItems: 20 })),
    tables: Type.Optional(Type.Array(IdentifierSchema, { minItems: 1, maxItems: 50 })),
  }),
  strictObject({
    operation: Type.Literal("describe_tables"),
    tables: Type.Array(
      strictObject({ table: IdentifierSchema, schema_hash: HashSchema }),
      { minItems: 1, maxItems: 20 },
    ),
  }),
]));

export const DatabaseQuerySchema = strictObject({
  queries: Type.Array(SelectSchema, { minItems: 1, maxItems: 30 }),
});

const WebResearchDomainSchema = Type.Union(
  WEB_RESEARCH_ALLOWED_DOMAINS.map((domain) => Type.Literal(domain)),
);
export const WebSearchSchema = strictObject({
  query: Type.String({ minLength: 1, maxLength: 500 }),
  domains: Type.Optional(Type.Array(WebResearchDomainSchema, {
    minItems: 1,
    maxItems: WEB_RESEARCH_ALLOWED_DOMAINS.length,
  })),
  recency_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
  max_results: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: WEB_RESEARCH_CONTRACT_LIMITS.maxResults,
  })),
});
export type WebSearchInput = Static<typeof WebSearchSchema>;

const ReasonSchema = Type.String({ minLength: 1, maxLength: 500, description: "用户要求本次变更的原因" });
const CodeSchema = Type.String({ pattern: CODE_PATTERN });
const DateSchema = Type.String({ pattern: DATE_PATTERN });
const PositiveNumberSchema = Type.Number({ exclusiveMinimum: 0 });
const DecisionOriginSchema = Type.Union([
  Type.Literal("strategy_signal"), Type.Literal("planned_discretionary"),
  Type.Literal("unplanned_exception"), Type.Literal("fact_correction"), Type.Literal("unknown"),
]);
const ExecutionComplianceSchema = Type.Union([
  Type.Literal("matched"), Type.Literal("deviated"),
  Type.Literal("not_applicable"), Type.Literal("unknown"),
]);

const PositionChangePortfolioWriteSchema = strictObject({
  action: Type.Optional(Type.Literal("record_position_change")),
  reason: ReasonSchema,
  code: CodeSchema,
  kind: Type.Union([Type.Literal("buy"), Type.Literal("sell"), Type.Literal("adjust"), Type.Literal("note")]),
  quantity: Type.Optional(PositiveNumberSchema),
  price: Type.Optional(PositiveNumberSchema),
  change_date: DateSchema,
  decision_origin: Type.Optional(DecisionOriginSchema),
  execution_compliance: Type.Optional(ExecutionComplianceSchema),
  plan_output_id: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
  attribution_note: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
  deviation_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
});
export const PortfolioWriteSchema = PositionChangePortfolioWriteSchema;
type PositionChangePortfolioWriteInput =
  Omit<Static<typeof PositionChangePortfolioWriteSchema>, "action" | "decision_origin" | "execution_compliance"> & {
    action: "record_position_change";
    decision_origin: Static<typeof DecisionOriginSchema>;
    execution_compliance: Static<typeof ExecutionComplianceSchema>;
  };
export type PortfolioWriteInput = PositionChangePortfolioWriteInput;

const PoolKindSchema = Type.Union([Type.Literal("short"), Type.Literal("long")]);
const PoolMembershipWriteSchema = strictObject({
  reason: ReasonSchema,
  action: Type.Union([Type.Literal("add"), Type.Literal("update"), Type.Literal("remove")]),
  code: CodeSchema,
  pool: PoolKindSchema,
  role: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  grade: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
  score: Type.Optional(Type.Number()),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 100 })),
  stock_character: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  stage: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  evaluation_summary: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
  attention_reason: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()])),
  attention_from: Type.Optional(Type.Union([DateSchema, Type.Null()])),
  attention_until: Type.Optional(Type.Union([DateSchema, Type.Null()])),
  effective_from: DateSchema,
  note: Type.Optional(Type.String({ maxLength: 2_000 })),
});
const PoolBoardOrderSchema = strictObject({
  reason: ReasonSchema,
  action: Type.Literal("set_board_order"),
  pool: PoolKindSchema,
  board_codes: Type.Array(CodeSchema, { maxItems: 200 }),
});
export const PoolWriteSchema = objectRoot(Type.Union([PoolMembershipWriteSchema, PoolBoardOrderSchema]));
export type PoolWriteInput = Static<typeof PoolWriteSchema>;

const ScheduledPoolAttentionMarkSchema = strictObject({
  reason: ReasonSchema,
  action: Type.Literal("mark"),
  code: CodeSchema,
  pool: PoolKindSchema,
  attention_status: Type.Union([Type.Literal("qualified"), Type.Literal("approaching")]),
  attention_reason: Type.String({ minLength: 1, maxLength: 420 }),
  attention_from: DateSchema,
  attention_until: DateSchema,
});
const ScheduledPoolAttentionClearSchema = strictObject({
  reason: ReasonSchema,
  action: Type.Literal("clear"),
  code: CodeSchema,
  pool: PoolKindSchema,
});
export const ScheduledPoolAttentionSchema = objectRoot(Type.Union([
  ScheduledPoolAttentionMarkSchema,
  ScheduledPoolAttentionClearSchema,
]));
export type ScheduledPoolAttentionInput = Static<typeof ScheduledPoolAttentionSchema>;

/** 每日计划盯防预案行：持仓次日执行预案 + 打板机会，写入后由任务成功激活。 */
const PlaybookTextSchema = Type.String({ minLength: 1, maxLength: 2_000 });
const DailyPlanPlaybookItemSchema = strictObject({
  item_kind: Type.Union([Type.Literal("position_action"), Type.Literal("off_pool_opportunity")]),
  code: CodeSchema,
  grade: Type.Optional(Type.Union([Type.Literal("A"), Type.Literal("B")])),
  priority: Type.Optional(Type.Integer({ minimum: 1, maximum: 999 })),
  action: Type.Union([
    Type.Literal("exit"),
    Type.Literal("reduce"),
    Type.Literal("buy"),
    Type.Literal("hold"),
    Type.Literal("observe"),
  ]),
  trigger_kind: Type.Union([
    Type.Literal("open"),
    Type.Literal("price_range"),
    Type.Literal("condition"),
  ]),
  price_lower: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1_000_000 })),
  price_upper: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1_000_000 })),
  headline: Type.String({ minLength: 1, maxLength: 300 }),
  auction_md: Type.Optional(PlaybookTextSchema),
  intraday_md: Type.Optional(PlaybookTextSchema),
  evidence_md: Type.Optional(PlaybookTextSchema),
  missing_md: Type.Optional(PlaybookTextSchema),
  invalidation_md: Type.Optional(PlaybookTextSchema),
  risk_md: Type.Optional(PlaybookTextSchema),
});
export const DailyPlanWriteSchema = strictObject({
  items: Type.Array(DailyPlanPlaybookItemSchema, { minItems: 1, maxItems: 60 }),
});
export type DailyPlanWriteRawInput = Static<typeof DailyPlanWriteSchema>;

const AuctionAssessmentItemSchema = strictObject({
  code: CodeSchema,
  conclusion: Type.Union([
    Type.Literal("observe"),
    Type.Literal("give_up"),
    Type.Literal("unavailable"),
  ]),
  metrics_summary: Type.String({ minLength: 1, maxLength: 1_000 }),
  assessment_summary: Type.String({ minLength: 1, maxLength: 2_000 }),
  benchmark_tags: Type.Optional(Type.Array(
    Type.String({ minLength: 1, maxLength: 100 }),
    { maxItems: 20 },
  )),
  data_status: Type.Union([
    Type.Literal("ready"),
    Type.Literal("not_ready"),
    Type.Literal("missing"),
    Type.Literal("stale"),
  ]),
  data_time: Type.Optional(Type.String({ minLength: 20, maxLength: 40 })),
});
export const AuctionAssessmentWriteSchema = strictObject({
  items: Type.Array(AuctionAssessmentItemSchema, { minItems: 1, maxItems: 4 }),
});
export type AuctionAssessmentWriteInput = Static<typeof AuctionAssessmentWriteSchema>;

const RevisionIdSchema = Type.String({ pattern: "^[0-9]+$" });
const ContentTextSchema = Type.String({ minLength: 1, maxLength: 200_000 });
const ChangeSummarySchema = Type.Optional(Type.String({ maxLength: 500 }));

const StrategyDocumentChangeSchema = strictObject({
  document_id: RevisionIdSchema,
  base_revision_id: RevisionIdSchema,
  content: ContentTextSchema,
});

/**
 * 策略发布是独立于普通确认制/YOLO 的真人门禁。
 * session_id 由服务端会话上下文绑定，绝不接受模型自行指定。
 */
export const StrategyPublishRequestSchema = strictObject({
  base_change_seq: RevisionIdSchema,
  base_strategy_hash: HashSchema,
  outline: Type.String({ minLength: 1, maxLength: 4_000 }),
  conclusion: Type.String({ minLength: 1, maxLength: 8_000 }),
  adjustments: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
    minItems: 1,
    maxItems: 30,
  }),
  summary: Type.String({ minLength: 1, maxLength: 2_000 }),
  changes: Type.Array(StrategyDocumentChangeSchema, { minItems: 1, maxItems: 20 }),
  backtest_run_ids: Type.Optional(Type.Array(RevisionIdSchema, { maxItems: 50 })),
});
export type StrategyPublishRequestInput = Static<typeof StrategyPublishRequestSchema>;

const DatasourceJobConfigSchema = strictObject({
  pipeline: Type.Union([
    Type.Literal("daily_market_update"),
    Type.Literal("market_catalog_sync"),
    Type.Literal("board_membership_sync"),
    Type.Literal("daily_market_structure"),
  ]),
  export_volume: Type.Optional(Type.Boolean()),
});
const AgentFlowJobConfigSchema = strictObject({
  pool_attention_write: Type.Optional(Type.Literal(true)),
  daily_plan_write: Type.Optional(Type.Literal(true)),
});
const AnalysisJobConfigSchema = strictObject({
  analysis_type: Type.Union([
    Type.Literal("sector_temperature"),
    Type.Literal("key_levels"),
    Type.Literal("long_valuation"),
  ]),
  request: Type.Optional(strictObject({
    codes: Type.Optional(Type.Array(CodeSchema, { minItems: 1, maxItems: 200 })),
    as_of: Type.Optional(DateSchema),
    lookback: Type.Optional(Type.Integer({ minimum: 20, maximum: 500 })),
  })),
});
const JobConfigSchema = Type.Union([DatasourceJobConfigSchema, AgentFlowJobConfigSchema, AnalysisJobConfigSchema]);
const TimestampSchema = Type.String({ minLength: 20, maxLength: 40 });
const MemoryCategorySchema = Type.Union([
  Type.Literal("research_method"), Type.Literal("evaluation_template"),
  Type.Literal("data_source_knowledge"), Type.Literal("task_playbook"),
  Type.Literal("incident_resolution"), Type.Literal("user_preference"),
]);
const MemoryContentFields = {
  title: Type.String({ minLength: 1, maxLength: 200 }),
  category: MemoryCategorySchema,
  summary: Type.String({ minLength: 1, maxLength: 1_000 }),
  content: Type.String({ minLength: 1, maxLength: 16_000 }),
  tags: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 50 }),
  scope: Type.String({ minLength: 1, maxLength: 500 }),
  source_run_type: Type.Optional(Type.Union([Type.Literal("job"), Type.Literal("backtest"), Type.Literal("analysis"), Type.Literal("tool")])),
  source_run_id: Type.Optional(RevisionIdSchema),
  evidence: Type.String({ minLength: 1, maxLength: 4_000 }),
  last_verified_at: TimestampSchema,
};

export const FinalizeBacktestSchema = strictObject({
  reason: ReasonSchema,
  run_id: RevisionIdSchema,
  conclusion_summary: Type.String({ minLength: 1, maxLength: 4_000 }),
  applicability_boundary: Type.String({ minLength: 1, maxLength: 4_000 }),
});
export type FinalizeBacktestInput = Static<typeof FinalizeBacktestSchema>;

export const MemoryWriteSchema = objectRoot(Type.Union([
  strictObject({ reason: ReasonSchema, action: Type.Literal("create"), ...MemoryContentFields }),
  strictObject({
    reason: ReasonSchema, action: Type.Literal("update"), memory_id: RevisionIdSchema, base_updated_at: TimestampSchema,
    title: Type.Optional(MemoryContentFields.title), category: Type.Optional(MemoryCategorySchema),
    summary: Type.Optional(MemoryContentFields.summary), content: Type.Optional(MemoryContentFields.content),
    tags: Type.Optional(MemoryContentFields.tags), scope: Type.Optional(MemoryContentFields.scope),
    source_run_type: MemoryContentFields.source_run_type, source_run_id: MemoryContentFields.source_run_id,
    evidence: Type.Optional(MemoryContentFields.evidence), last_verified_at: Type.Optional(TimestampSchema),
  }),
  strictObject({
    reason: ReasonSchema, action: Type.Literal("supersede"), memory_id: RevisionIdSchema,
    base_updated_at: TimestampSchema, ...MemoryContentFields,
  }),
  strictObject({
    reason: ReasonSchema, action: Type.Literal("deprecate"), memory_id: RevisionIdSchema,
    base_updated_at: TimestampSchema, evidence: Type.String({ minLength: 1, maxLength: 4_000 }),
  }),
]));
export type MemoryWriteInput = Static<typeof MemoryWriteSchema>;

export const MemoryQuerySchema = strictObject({
  keyword: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  category: Type.Optional(MemoryCategorySchema),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20 })),
  status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("review_required"), Type.Literal("superseded"), Type.Literal("deprecated")])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type MemoryQueryInput = Static<typeof MemoryQuerySchema>;
const PromptContentSchema = Type.String({ minLength: 1, maxLength: 200_000 });

export const JobWriteSchema = objectRoot(Type.Union([
  strictObject({
    reason: ReasonSchema,
    action: Type.Literal("create_job"),
    code: IdentifierSchema,
    name: Type.String({ minLength: 1, maxLength: 100 }),
    cron: Type.String({ minLength: 9, maxLength: 100 }),
    job_type: Type.Union([Type.Literal("datasource"), Type.Literal("agent_flow"), Type.Literal("analysis")]),
    config: JobConfigSchema,
    prompt_id: Type.Optional(RevisionIdSchema),
    enabled: Type.Optional(Type.Boolean()),
  }),
  strictObject({
    reason: ReasonSchema,
    action: Type.Literal("update_job"),
    code: IdentifierSchema,
    base_updated_at: TimestampSchema,
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    cron: Type.Optional(Type.String({ minLength: 9, maxLength: 100 })),
    config: Type.Optional(JobConfigSchema),
    prompt_id: Type.Optional(RevisionIdSchema),
    enabled: Type.Optional(Type.Boolean()),
  }),
  strictObject({
    reason: ReasonSchema,
    action: Type.Literal("create_prompt"),
    code: IdentifierSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    content: PromptContentSchema,
    change_summary: ChangeSummarySchema,
  }),
  strictObject({
    reason: ReasonSchema,
    action: Type.Literal("update_prompt"),
    prompt_id: RevisionIdSchema,
    base_revision_id: RevisionIdSchema,
    content: PromptContentSchema,
    change_summary: ChangeSummarySchema,
  }),
  strictObject({
    reason: ReasonSchema,
    action: Type.Literal("set_prompt_status"),
    prompt_id: RevisionIdSchema,
    base_revision_id: RevisionIdSchema,
    status: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
  }),
  strictObject({
    reason: ReasonSchema,
    action: Type.Literal("rollback_prompt"),
    prompt_id: RevisionIdSchema,
    base_revision_id: RevisionIdSchema,
    target_revision_id: RevisionIdSchema,
    change_summary: ChangeSummarySchema,
  }),
]));
export type JobWriteInput = Static<typeof JobWriteSchema>;

const AnalysisTypeSchema = Type.Union([
  Type.Literal("sector_temperature"),
  Type.Literal("key_levels"),
  Type.Literal("long_valuation"),
]);
export const AnalysisRunSchema = strictObject({
  requests: Type.Array(strictObject({
    analysis_type: AnalysisTypeSchema,
    codes: Type.Optional(Type.Array(CodeSchema, { minItems: 1, maxItems: 200 })),
    as_of: Type.Optional(DateSchema),
    lookback: Type.Optional(Type.Integer({ minimum: 20, maximum: 500 })),
  }), { minItems: 1, maxItems: 20 }),
});
export type AnalysisRunInput = Static<typeof AnalysisRunSchema>;

export const RunBacktestSchema = strictObject({
  name: Type.String({ minLength: 1, maxLength: 300 }),
  kind: Type.Optional(Type.Union([Type.Literal("formal"), Type.Literal("research")])),
  research_outline: Type.String({ minLength: 1, maxLength: 4_000 }),
  hypothesis: Type.String({ minLength: 1, maxLength: 4_000 }),
  codes: Type.Array(CodeSchema, { maxItems: 100 }),
  market_event_types: Type.Optional(Type.Array(Type.Union([
    Type.Literal("up"), Type.Literal("down"), Type.Literal("break"),
  ]), { maxItems: 3 })),
  limit_up_universe: Type.Optional(Type.Union([
    Type.Literal("none"), Type.Literal("mainboard"), Type.Literal("all"),
  ])),
  start: DateSchema,
  end: DateSchema,
  initial_cash: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1_000_000_000_000 })),
  parameters: Type.Optional(Type.Record(IdentifierSchema, Type.Unknown())),
  comparison_run_ids: Type.Optional(Type.Array(RevisionIdSchema, { maxItems: 20 })),
  base_source_run_id: Type.Optional(RevisionIdSchema),
  source_code: Type.String({
    minLength: 1,
    maxLength: 65_536,
    description:
      "default export async function run(sdk)。必须返回非空 daily_returns；metrics 最多100项且只能是扁平的有限数值/null；结构化明细写入 conclusion。",
  }),
});
export type RunBacktestInput = AgentBacktestRequest;

export const ReadBacktestSourceSchema = strictObject({
  run_id: RevisionIdSchema,
});
export type ReadBacktestSourceInput = Static<typeof ReadBacktestSourceSchema>;

export const FetchMarketDataSchema = strictObject({
  requests: Type.Optional(Type.Array(
    strictObject({
      code: Type.String({ pattern: CODE_PATTERN, description: "标的代码，如 000636.SZ / CU0" }),
      freq: Type.Union([Type.Literal("day"), Type.Literal("30m"), Type.Literal("futures_day")]),
      start: Type.String({ pattern: DATE_PATTERN }),
      end: Type.String({ pattern: DATE_PATTERN }),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    }),
    { minItems: 1, maxItems: 200 },
  )),
  financial_requests: Type.Optional(Type.Array(
    strictObject({
      code: Type.String({ pattern: "^\\d{6}\\.(?:SH|SZ|BJ)$", description: "A 股完整代码" }),
    }),
    { minItems: 1, maxItems: 100 },
  )),
  continue_on_error: Type.Optional(Type.Boolean({ description: "默认 true" })),
});
export type FetchMarketDataInput = Static<typeof FetchMarketDataSchema>;

const HithinkDatasetRequestSchema = strictObject({
  capability: Type.Union(HITHINK_DATASET_CAPABILITIES.map((value) => Type.Literal(value))),
  code: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
  codes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { minItems: 1, maxItems: 100 })),
  fund_type: Type.Optional(Type.Union([
    Type.Literal("otc"), Type.Literal("exchange"), Type.Literal("reits"),
  ])),
  stage: Type.Optional(Type.Union([Type.Literal("live"), Type.Literal("final")])),
  date: Type.Optional(Type.String({ pattern: DATE_PATTERN })),
  period: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("hour")])),
  tags: Type.Optional(Type.Array(Type.Union([
    Type.Literal("LIMIT_UP"), Type.Literal("LIMIT_DOWN"), Type.Literal("SHARP_RISE"),
    Type.Literal("SHARP_FALL"), Type.Literal("RAPID_RALLY"), Type.Literal("RAPID_DECLINE"),
  ]), { minItems: 1, maxItems: 6 })),
  start: Type.Optional(Type.String({ pattern: DATE_PATTERN })),
  end: Type.Optional(Type.String({ pattern: DATE_PATTERN })),
  range: Type.Optional(Type.Union([
    Type.Literal("week"), Type.Literal("month"), Type.Literal("tmonth"), Type.Literal("hyear"),
    Type.Literal("year"), Type.Literal("twoyear"), Type.Literal("tyear"), Type.Literal("fyear"),
    Type.Literal("nowyear"), Type.Literal("now"),
  ])),
  nav_type: Type.Optional(Type.Union([Type.Literal("unit"), Type.Literal("adj"), Type.Literal("unit,adj")])),
  merge_scope: Type.Optional(Type.Union([
    Type.Literal("all"), Type.Literal("merged"), Type.Literal("separate"),
  ])),
  manager_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  company_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  subscribe: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("upcoming")])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  report_type: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  end_date: Type.Optional(Type.String({ pattern: DATE_PATTERN })),
});

export const FetchHithinkDataSchema = strictObject({
  requests: Type.Array(HithinkDatasetRequestSchema, { minItems: 1, maxItems: 20 }),
  continue_on_error: Type.Optional(Type.Boolean({ description: "默认 true" })),
});
export interface FetchHithinkDataInput {
  requests: HithinkDatasetRequest[];
  continue_on_error?: boolean;
}

export const TriggerJobSchema = strictObject({
  code: Type.String({ minLength: 1, maxLength: 63, pattern: IDENTIFIER_PATTERN }),
  target_date: Type.Optional(Type.String({ pattern: DATE_PATTERN })),
});
export type TriggerJobInput = Static<typeof TriggerJobSchema>;

const UiRefreshTargetSchema = Type.Union([
  Type.Literal("dashboard"),
  Type.Literal("positions"),
  Type.Literal("jobs"),
  Type.Literal("pools"),
  Type.Literal("market"),
  Type.Literal("strategies"),
  Type.Literal("backtests"),
  Type.Literal("memories"),
  Type.Literal("datasync"),
  Type.Literal("status"),
]);

export const UiRefreshSchema = strictObject({
  targets: Type.Array(UiRefreshTargetSchema, { minItems: 1, maxItems: 10 }),
  reason: Type.String({ minLength: 1, maxLength: 300 }),
});
export type UiRefreshInput = Static<typeof UiRefreshSchema>;

function argumentBytes(input: unknown): number {
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    throw new Error("工具参数必须是可序列化的 JSON");
  }
  if (json === undefined) throw new Error("工具参数必须是 JSON 对象");
  return Buffer.byteLength(json, "utf8");
}

/**
 * 防御性运行时校验。错误只返回 schema 路径，不把完整参数回显到日志/模型，
 * 避免未来工具新增敏感字段后因校验失败而泄漏原值。
 */
export function validateToolInput<T>(toolName: string, schema: TSchema, input: unknown): T {
  const bytes = argumentBytes(input);
  if (bytes > MAX_TOOL_ARGUMENT_BYTES) {
    throw new Error(`工具 ${toolName} 参数过大（${bytes} 字节），上限 ${MAX_TOOL_ARGUMENT_BYTES} 字节`);
  }
  try {
    return validateToolArguments(
      { name: toolName, description: "服务端防御性校验", parameters: schema },
      {
        type: "toolCall",
        id: "server-validation",
        name: toolName,
        arguments: input as Record<string, unknown>,
      },
    ) as T;
  } catch (error) {
    const details = (error as Error).message.split("\n\nReceived arguments:", 1)[0] ?? "参数不符合 schema";
    throw new Error(`工具 ${toolName} 参数校验失败：${details}`);
  }
}

export function validateDatabaseQueryInput(input: unknown): DatabaseQueryInput {
  return validateToolInput<DatabaseQueryInput>("database_query", DatabaseQuerySchema, input);
}

export function validateDatabaseSchemaInput(input: unknown): DatabaseSchemaInput {
  return validateToolInput<DatabaseSchemaInput>("database_schema", DatabaseSchemaSchema, input);
}

export function validateWebSearchInput(input: unknown): WebSearchInput {
  const parsed = validateToolInput<WebSearchInput>("web_search", WebSearchSchema, input);
  const query = parsed.query.trim();
  if (!query) throw new Error("web_search query 不能为空");
  return {
    ...parsed,
    query,
    ...(parsed.domains ? { domains: [...new Set(parsed.domains)] } : {}),
  };
}

function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validatePortfolioWriteInput(input: unknown): PortfolioWriteInput {
  const parsed = validateToolInput<Static<typeof PortfolioWriteSchema>>("portfolio_write", PortfolioWriteSchema, input);
  const decisionOrigin = parsed.decision_origin ?? (parsed.kind === "note" ? "fact_correction" : undefined);
  const executionCompliance = parsed.execution_compliance ?? (parsed.kind === "note" ? "not_applicable" : undefined);
  if (!decisionOrigin) throw new Error(`${parsed.kind} 必须提供 decision_origin`);
  if (!executionCompliance) throw new Error(`${parsed.kind} 必须提供 execution_compliance`);
  if ((decisionOrigin === "unplanned_exception" || executionCompliance === "deviated") && !parsed.deviation_reason?.trim()) {
    throw new Error("计划外例外或执行偏离必须提供 deviation_reason");
  }
  const normalized: PositionChangePortfolioWriteInput = {
    ...parsed,
    action: "record_position_change",
    code: parsed.code.trim(),
    reason: parsed.reason.trim(),
    decision_origin: decisionOrigin,
    execution_compliance: executionCompliance,
    ...(parsed.attribution_note ? { attribution_note: parsed.attribution_note.trim() } : {}),
    ...(parsed.deviation_reason ? { deviation_reason: parsed.deviation_reason.trim() } : {}),
  };
  if (!isRealDate(normalized.change_date)) throw new Error(`成交日期不是有效日历日期：${normalized.change_date}`);
  if ((normalized.kind === "buy" || normalized.kind === "sell") &&
      (normalized.quantity === undefined || normalized.price === undefined)) {
    throw new Error(`${normalized.kind} 必须携带正数 quantity 与 price`);
  }
  if (normalized.kind === "adjust" && normalized.quantity === undefined && normalized.price === undefined) {
    throw new Error("adjust 需要 quantity 或 price 至少一项");
  }
  if (normalized.kind === "note" && (normalized.quantity !== undefined || normalized.price !== undefined)) {
    throw new Error("note 不允许携带 quantity 或 price");
  }
  return normalized;
}

export function validatePoolWriteInput(input: unknown): PoolWriteInput {
  const parsed = validateToolInput<PoolWriteInput>("pool_write", PoolWriteSchema, input);
  if (parsed.action === "set_board_order") {
    if (new Set(parsed.board_codes).size !== parsed.board_codes.length) throw new Error("pool_write board_codes 不得重复");
    return { ...parsed, reason: parsed.reason.trim(), board_codes: parsed.board_codes.map((code) => code.trim()) };
  }
  if (!isRealDate(parsed.effective_from)) {
    throw new Error(`生效日期不是有效日历日期：${parsed.effective_from}`);
  }
  if (parsed.action === "add") {
    for (const field of ["role", "grade", "score", "tags", "stock_character", "stage", "evaluation_summary"] as const) {
      if (parsed[field] === undefined || parsed[field] === null || parsed[field] === "") throw new Error(`pool_write add 必须提供 ${field}`);
    }
  }
  if (parsed.action === "remove" &&
      [parsed.role, parsed.grade, parsed.score, parsed.tags, parsed.stock_character, parsed.stage,
       parsed.evaluation_summary, parsed.attention_reason,
       parsed.attention_from, parsed.attention_until].some((value) => value !== undefined)) {
    throw new Error("pool_write remove 只允许 code、pool、effective_from 和 reason");
  }
  const tags = parsed.tags?.map((tag) => tag.trim());
  if (tags?.some((tag) => tag.startsWith("板块："))) {
    throw new Error("pool_write tags 不再接受“板块：”本地标签；所属行业只读取同花顺官方关系");
  }
  return {
    ...parsed,
    code: parsed.code.trim(),
    reason: parsed.reason.trim(),
    role: parsed.role?.trim(),
    grade: parsed.grade?.trim(),
    stock_character: parsed.stock_character?.trim(),
    stage: parsed.stage?.trim(),
    evaluation_summary: parsed.evaluation_summary?.trim(),
    tags,
  };
}

export function validateScheduledPoolAttentionInput(input: unknown): ScheduledPoolAttentionInput {
  const parsed = validateToolInput<ScheduledPoolAttentionInput>(
    "pool_attention_write",
    ScheduledPoolAttentionSchema,
    input,
  );
  if (parsed.action === "mark") {
    if (!isRealDate(parsed.attention_from) || !isRealDate(parsed.attention_until)) {
      throw new Error("近期关注起止日期必须是有效日历日期");
    }
    if (parsed.attention_until < parsed.attention_from) throw new Error("近期关注结束日期不得早于开始日期");
    return {
      ...parsed,
      code: parsed.code.trim(),
      reason: parsed.reason.trim(),
      attention_reason: parsed.attention_reason.trim(),
    };
  }
  return { ...parsed, code: parsed.code.trim(), reason: parsed.reason.trim() };
}

function validTimestamp(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

function assertMemoryPayloadSafe(value: MemoryWriteInput): void {
  const text = ["title", "summary", "content", "evidence"]
    .map((key) => key in value ? String(value[key as keyof typeof value] ?? "") : "")
    .join("\n");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(text) ||
      /\b(?:api[_ -]?key|access[_ -]?token|secret[_ -]?key)\b\s*[:=]/i.test(text) ||
      /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/.test(text) || /\bsource_code\b/i.test(text)) {
    throw new Error("memory_write 不得保存密钥、令牌或临时代码");
  }
}

export function validateFinalizeBacktestInput(input: unknown): FinalizeBacktestInput {
  const parsed = validateToolInput<FinalizeBacktestInput>("finalize_backtest", FinalizeBacktestSchema, input);
  return { ...parsed, reason: parsed.reason.trim(), conclusion_summary: parsed.conclusion_summary.trim(), applicability_boundary: parsed.applicability_boundary.trim() };
}

export function validateMemoryWriteInput(input: unknown): MemoryWriteInput {
  const parsed = validateToolInput<MemoryWriteInput>("memory_write", MemoryWriteSchema, input);
  if ("base_updated_at" in parsed && !validTimestamp(parsed.base_updated_at)) throw new Error("base_updated_at 不是有效时间");
  if ("last_verified_at" in parsed && parsed.last_verified_at && !validTimestamp(parsed.last_verified_at)) throw new Error("last_verified_at 不是有效时间");
  if (parsed.action === "update") {
    const changed = [parsed.title, parsed.category, parsed.summary, parsed.content, parsed.tags, parsed.scope,
      parsed.source_run_type, parsed.source_run_id, parsed.evidence, parsed.last_verified_at].some((value) => value !== undefined);
    if (!changed) throw new Error("memory_write update 至少需要一个更新字段");
  }
  if ("source_run_id" in parsed && parsed.source_run_id && !("source_run_type" in parsed && parsed.source_run_type)) {
    throw new Error("source_run_id 必须同时提供 source_run_type");
  }
  if ("tags" in parsed && parsed.tags && new Set(parsed.tags).size !== parsed.tags.length) throw new Error("memory_write tags 不得重复");
  assertMemoryPayloadSafe(parsed);
  return { ...parsed, reason: parsed.reason.trim() } as MemoryWriteInput;
}

export function validateMemoryQueryInput(input: unknown): MemoryQueryInput {
  const parsed = validateToolInput<MemoryQueryInput>("memory_query", MemoryQuerySchema, input);
  return { ...parsed, keyword: parsed.keyword?.trim(), tags: parsed.tags?.map((tag) => tag.trim()) };
}

export function validateStrategyPublishRequestInput(input: unknown): StrategyPublishRequestInput {
  const parsed = validateToolInput<StrategyPublishRequestInput>(
    "strategy_publish_request",
    StrategyPublishRequestSchema,
    input,
  );
  const documentIds = parsed.changes.map((change) => change.document_id);
  if (new Set(documentIds).size !== documentIds.length) {
    throw new Error("strategy_publish_request changes 存在重复 document_id");
  }
  const backtestIds = parsed.backtest_run_ids ?? [];
  if (new Set(backtestIds).size !== backtestIds.length) {
    throw new Error("strategy_publish_request backtest_run_ids 存在重复项");
  }
  return {
    ...parsed,
    outline: parsed.outline.trim(),
    conclusion: parsed.conclusion.trim(),
    summary: parsed.summary.trim(),
    adjustments: parsed.adjustments.map((item) => item.trim()),
  };
}

export function validateJobWriteInput(input: unknown): JobWriteInput {
  const parsed = validateToolInput<JobWriteInput>("job_write", JobWriteSchema, input);
  if (parsed.action === "create_job") {
    if (parsed.job_type === "agent_flow" && !parsed.prompt_id) throw new Error("agent_flow 作业必须提供 prompt_id");
    if (parsed.job_type === "datasource" && parsed.prompt_id) throw new Error("datasource 作业不能绑定 prompt_id");
    if (parsed.job_type === "analysis" && parsed.prompt_id) throw new Error("analysis 作业不能绑定 prompt_id");
    if (parsed.job_type === "datasource" && !("pipeline" in parsed.config)) throw new Error("datasource 作业 config 类型不匹配");
    if (parsed.job_type === "agent_flow" && ("pipeline" in parsed.config || "analysis_type" in parsed.config)) throw new Error("agent_flow 作业 config 类型不匹配");
    if (parsed.job_type === "analysis" && !("analysis_type" in parsed.config)) throw new Error("analysis 作业 config 类型不匹配");
  }
  if (parsed.action === "update_job") {
    const changed = [parsed.name, parsed.cron, parsed.config, parsed.prompt_id, parsed.enabled]
      .some((value) => value !== undefined);
    if (!changed) throw new Error("job_write update_job 至少需要一个更新字段");
    if (Number.isNaN(new Date(parsed.base_updated_at).getTime())) throw new Error("base_updated_at 不是有效时间");
  }
  return { ...parsed, reason: parsed.reason.trim() } as JobWriteInput;
}

export function validateAnalysisRunInput(input: unknown): AnalysisRunInput {
  const parsed = validateToolInput<AnalysisRunInput>("analysis_run", AnalysisRunSchema, input);
  for (const request of parsed.requests) {
    if (request.as_of && !isRealDate(request.as_of)) throw new Error(`分析日期不是有效日历日期：${request.as_of}`);
    if (request.analysis_type === "key_levels" && !request.codes?.length) throw new Error("key_levels 必须提供 codes");
    if (request.codes && new Set(request.codes).size !== request.codes.length) throw new Error("分析请求 codes 存在重复项");
  }
  return parsed;
}

export function validateDailyPlanWriteInput(input: unknown): DailyPlanWriteRawInput {
  const parsed = validateToolInput<DailyPlanWriteRawInput>("daily_plan_write", DailyPlanWriteSchema, input);
  const seen = new Set<string>();
  const explicitPriorities: number[] = [];
  for (const item of parsed.items) {
    const key = `${item.item_kind}:${item.code}`;
    if (seen.has(key)) throw new Error(`daily_plan_write items 存在重复条目：${key}`);
    seen.add(key);
    if (item.trigger_kind === "price_range" && item.price_lower !== undefined
      && item.price_upper !== undefined && item.price_lower > item.price_upper) {
      throw new Error(`daily_plan_write ${item.code} 触发区间下限高于上限`);
    }
    if (item.item_kind === "off_pool_opportunity") {
      if (!item.grade) throw new Error(`daily_plan_write 打板机会 ${item.code} 必须标注 A/B 兼容评级`);
      if (item.action !== "observe") throw new Error(`daily_plan_write 打板机会 ${item.code} 在前向验证期只能继续观察`);
      if (!item.evidence_md?.trim()) throw new Error(`daily_plan_write 打板机会 ${item.code} 必须写明策略评分与证据`);
      if (item.priority === undefined) throw new Error(`daily_plan_write 打板机会 ${item.code} 必须写明策略优先级 priority`);
      if (item.auction_md !== undefined || item.intraday_md !== undefined) {
        throw new Error(`daily_plan_write 打板机会 ${item.code} 不接受集合竞价或分时预案字段`);
      }
      explicitPriorities.push(item.priority);
    }
    if (item.item_kind === "position_action") {
      if (item.grade !== undefined) throw new Error(`daily_plan_write 持仓预案 ${item.code} 不接受打板评级字段`);
      if (item.priority !== undefined) throw new Error(`daily_plan_write 持仓预案 ${item.code} 不接受 priority，排序由持仓表顺序决定`);
    }
  }
  if (explicitPriorities.length > 4) throw new Error("daily_plan_write 打板机会最多 4 只");
  if (new Set(explicitPriorities).size !== explicitPriorities.length) {
    throw new Error("daily_plan_write 打板机会存在重复 priority，请使用连续不重复的策略优先级");
  }
  return parsed;
}

export function validateAuctionAssessmentWriteInput(input: unknown): AuctionAssessmentWriteInput {
  const parsed = validateToolInput<AuctionAssessmentWriteInput>(
    "auction_assessment_write",
    AuctionAssessmentWriteSchema,
    input,
  );
  const codes = parsed.items.map((item) => item.code);
  if (new Set(codes).size !== codes.length) throw new Error("auction_assessment_write 存在重复标的");
  for (const item of parsed.items) {
    if (item.data_time && Number.isNaN(new Date(item.data_time).getTime())) {
      throw new Error(`竞价数据时间非法：${item.code}`);
    }
    if (item.data_status === "ready" && item.conclusion === "unavailable") {
      throw new Error(`竞价数据已就绪时不得标记数据不足：${item.code}`);
    }
    if (item.data_status !== "ready" && item.conclusion !== "unavailable") {
      throw new Error(`竞价数据未就绪时只能标记数据不足：${item.code}`);
    }
  }
  return parsed;
}

export function validateRunBacktestInput(input: unknown): RunBacktestInput {
  const parsed = validateToolInput<Static<typeof RunBacktestSchema>>("run_backtest", RunBacktestSchema, input);
  if (!isRealDate(parsed.start) || !isRealDate(parsed.end) || parsed.start > parsed.end) {
    throw new Error(`回测日期范围非法：${parsed.start} 至 ${parsed.end}`);
  }
  if (new Set(parsed.codes).size !== parsed.codes.length) throw new Error(`回测 ${parsed.name} 的 codes 存在重复项`);
  if (parsed.codes.length === 0 && (parsed.limit_up_universe ?? "none") === "none") {
    throw new Error("回测必须提供 codes，或把 limit_up_universe 设为 mainboard/all");
  }
  if (new Set(parsed.market_event_types ?? []).size !== (parsed.market_event_types ?? []).length) {
    throw new Error("market_event_types 存在重复项");
  }
  const comparisonIds = parsed.comparison_run_ids ?? [];
  if (new Set(comparisonIds).size !== comparisonIds.length) throw new Error("comparison_run_ids 存在重复项");
  const parameters = (parsed.parameters ?? {}) as Record<string, JsonValue>;
  const parameterBytes = Buffer.byteLength(JSON.stringify(parameters), "utf8");
  if (parameterBytes > 32 * 1024) throw new Error("parameters 超过 32 KiB 上限");
  return {
    name: parsed.name.trim(),
    kind: parsed.kind ?? "research",
    research_outline: parsed.research_outline.trim(),
    hypothesis: parsed.hypothesis.trim(),
    codes: parsed.codes,
    market_event_types: parsed.market_event_types ?? [],
    limit_up_universe: parsed.limit_up_universe ?? "none",
    start: parsed.start,
    end: parsed.end,
    initial_cash: parsed.initial_cash ?? 1_000_000,
    parameters,
    comparison_run_ids: comparisonIds,
    base_source_run_id: parsed.base_source_run_id ?? null,
    source_code: parsed.source_code,
  };
}

export function validateReadBacktestSourceInput(input: unknown): ReadBacktestSourceInput {
  return validateToolInput<ReadBacktestSourceInput>("read_backtest_source", ReadBacktestSourceSchema, input);
}

/** 行情请求除 schema 外再校验真实日历、区间方向与重复项。 */
export function validateFetchMarketDataInput(input: unknown): FetchMarketDataInput {
  const parsed = validateToolInput<FetchMarketDataInput>(
    "fetch_market_data",
    FetchMarketDataSchema,
    input,
  );
  if (!parsed.requests?.length && !parsed.financial_requests?.length) {
    throw new Error("fetch_market_data 至少需要 requests 或 financial_requests 一项");
  }
  const seen = new Set<string>();
  for (const request of parsed.requests ?? []) {
    if (!isRealDate(request.start) || !isRealDate(request.end)) {
      throw new Error(`行情日期不是有效日历日期：${request.start} 至 ${request.end}`);
    }
    if (request.start > request.end) {
      throw new Error(`行情日期范围错误：start ${request.start} 晚于 end ${request.end}`);
    }
    const key = `${request.code}\u0000${request.freq}\u0000${request.start}\u0000${request.end}`;
    if (seen.has(key)) throw new Error(`批量行情请求存在重复项：${request.code} ${request.freq}`);
    seen.add(key);
  }
  const financialCodes = parsed.financial_requests?.map((request) => request.code) ?? [];
  if (new Set(financialCodes).size !== financialCodes.length) {
    throw new Error("批量财务估值请求存在重复代码");
  }
  return parsed;
}

export function validateFetchHithinkDataInput(input: unknown): FetchHithinkDataInput {
  const parsed = validateToolInput<FetchHithinkDataInput>(
    "fetch_hithink_data",
    FetchHithinkDataSchema,
    input,
  );
  const requests = parsed.requests.map(normalizeHithinkDatasetRequest);
  const keys = requests.map((request) => JSON.stringify(request));
  if (new Set(keys).size !== keys.length) throw new Error("扶摇扩展数据请求存在重复项");
  return { ...parsed, requests };
}

export function validateTriggerJobInput(input: unknown): TriggerJobInput {
  const parsed = validateToolInput<TriggerJobInput>("trigger_job", TriggerJobSchema, input);
  if (parsed.target_date && !isRealDate(parsed.target_date)) {
    throw new Error(`作业目标日不是有效日历日期：${parsed.target_date}`);
  }
  return parsed;
}

export function validateUiRefreshInput(input: unknown): UiRefreshInput {
  const parsed = validateToolInput<UiRefreshInput>("ui_refresh", UiRefreshSchema, input);
  if (new Set(parsed.targets).size !== parsed.targets.length) {
    throw new Error("ui_refresh targets 存在重复项");
  }
  return { ...parsed, reason: parsed.reason.trim() };
}
