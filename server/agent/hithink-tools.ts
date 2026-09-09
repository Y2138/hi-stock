import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import {
  executeHithinkCapability,
  getHithinkCapability,
  HITHINK_CAPABILITIES,
  HITHINK_CAPABILITY_DOMAINS,
  HITHINK_RESULT_FIELD_PATTERN,
  searchHithinkCapabilities,
  type HithinkCapabilityDomain,
} from "../datasource/hithink-capabilities.js";
import { HITHINK_DATASET_CAPABILITIES } from "../datasource/hithink-datasets.js";
import { sha256Json } from "./hash.js";
import { processHithinkResult, type HithinkResultOptions } from "./hithink-result-processor.js";
import { insertToolAudit } from "./repo.js";
import { validateToolInput } from "./tool-validation.js";

const strictObject = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const CatalogSchema = strictObject({
  action: Type.Union([Type.Literal("search"), Type.Literal("describe")]),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  domain: Type.Optional(Type.Union(HITHINK_CAPABILITY_DOMAINS.map((value) => Type.Literal(value)))),
  names: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 8 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});

const FilterSchema = strictObject({
  field: Type.String({ pattern: HITHINK_RESULT_FIELD_PATTERN }),
  op: Type.Union([
    Type.Literal("eq"), Type.Literal("ne"), Type.Literal("gt"), Type.Literal("gte"),
    Type.Literal("lt"), Type.Literal("lte"), Type.Literal("in"), Type.Literal("contains"),
    Type.Literal("is_null"), Type.Literal("not_null"),
  ]),
  value: Type.Optional(Type.Unknown()),
});

const ResultSchema = strictObject({
  collection: Type.Optional(Type.String({ pattern: HITHINK_RESULT_FIELD_PATTERN })),
  select: Type.Optional(Type.Array(Type.String({ pattern: HITHINK_RESULT_FIELD_PATTERN }), {
    minItems: 1,
    maxItems: 50,
  })),
  where: Type.Optional(Type.Array(FilterSchema, { maxItems: 20 })),
  order_by: Type.Optional(Type.Array(strictObject({
    field: Type.String({ pattern: HITHINK_RESULT_FIELD_PATTERN }),
    direction: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
  }), { maxItems: 5 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});

const QuerySchema = strictObject({
  capability: Type.String({ minLength: 1, maxLength: 80 }),
  parameters: Type.Record(
    Type.String({ pattern: "^[a-z][a-z0-9_]{0,62}$" }),
    Type.Unknown(),
    { description: "先用 hithink_catalog describe 取得该能力的精确参数 Schema。" },
  ),
  result: Type.Optional(ResultSchema),
});

interface CatalogInput {
  action: "search" | "describe";
  query?: string;
  domain?: HithinkCapabilityDomain;
  names?: string[];
  limit?: number;
}

interface QueryInput {
  capability: string;
  parameters: Record<string, unknown>;
  result?: HithinkResultOptions;
}

export type HithinkTransientQuery = (
  capability: string,
  parameters: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

function textResult(data: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
}

function transientResult(data: Record<string, unknown>): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    details: {
      ephemeral_data_result: true,
      transient: true,
      persisted: false,
      capability: data.capability,
      collection: data.collection,
      scanned_count: data.scanned_count,
      matched_count: data.matched_count,
      returned_count: data.returned_count,
      complete: data.complete,
      next_offset: data.next_offset,
      remaining_count: data.remaining_count,
    },
  };
}

/** 同一能力的两条路径：hithink_query 临时研究不落库；出现在落库白名单内的能力可经 fetch_hithink_data 持久同步。 */
const PERSISTABLE_CAPABILITIES = new Set<string>(HITHINK_DATASET_CAPABILITIES);

function publicCapability(definition: (typeof HITHINK_CAPABILITIES)[number], includeSchema = false) {
  return {
    name: definition.name,
    label: definition.label,
    domain: definition.domain,
    description: definition.description,
    mode: definition.mode,
    collections: definition.collections,
    default_collection: definition.defaultCollection ?? null,
    persistable: PERSISTABLE_CAPABILITIES.has(definition.name),
    ...(includeSchema ? { parameters_schema: definition.parameters } : {}),
  };
}

export function buildHithinkTools(deps: {
  pool: pg.Pool;
  sessionId: string | null;
  query?: HithinkTransientQuery;
}): AgentTool[] {
  const query = deps.query ?? ((capability, parameters, signal) => executeHithinkCapability(
    capability,
    parameters,
    { db: deps.pool, priority: "interactive", signal },
  ));

  return [
    {
      name: "hithink_catalog",
      label: "发现扶摇数据能力",
      description:
        "扶摇59项REST能力的轻量目录。先 search 搜索能力；调用前用 describe 读取精确参数Schema、结果集合和执行模式。只查询本地注册表，不请求扶摇、不保存市场数据。",
      parameters: CatalogSchema,
      execute: async (_id, raw, signal) => {
        if (signal?.aborted) throw new Error("扶摇能力目录查询已中断");
        const input = validateToolInput<CatalogInput>("hithink_catalog", CatalogSchema, raw);
        if (input.action === "search") {
          if (input.names !== undefined) throw new Error("search 不接受 names");
          const matches = searchHithinkCapabilities({
            query: input.query,
            domain: input.domain,
            limit: input.limit,
          });
          return textResult({
            total_capabilities: HITHINK_CAPABILITIES.length,
            matched_count: matches.length,
            capabilities: matches.map((definition) => publicCapability(definition)),
            instruction: "选择能力后用 describe 读取精确参数，再调用 hithink_query。",
          });
        }
        if (!input.names?.length) throw new Error("describe 必须提供 names");
        if (input.query !== undefined || input.domain !== undefined || input.limit !== undefined) {
          throw new Error("describe 只接受 names");
        }
        const definitions = input.names.map((name) => {
          const definition = getHithinkCapability(name);
          if (!definition) throw new Error(`未知扶摇能力：${name}`);
          return definition;
        });
        return textResult({
          capabilities: definitions.map((definition) => publicCapability(definition, true)),
          result_options: ResultSchema,
          instruction:
            "parameters 必须严格符合 parameters_schema；临时查询不会写入行情、板块、快照或其他业务表。persistable=true 表示同一能力可经 fetch_hithink_data 持久同步；需要落库时改用该工具，不要用临时查询结果冒充已同步数据。",
        });
      },
    },
    {
      name: "hithink_query",
      label: "临时查询扶摇数据",
      description:
        "按 hithink_catalog 描述的能力临时查询扶摇。完整响应只在本次调用内存中参与确定性过滤、排序、字段投影和分页；不写业务表或快照表。大结果必须用 result 缩小，返回 scanned/matched/returned/complete，绝不静默截断。",
      parameters: QuerySchema,
      executionMode: "sequential",
      execute: async (_id, raw, signal) => {
        let capability = "unknown";
        try {
          const input = validateToolInput<QueryInput>("hithink_query", QuerySchema, raw);
          capability = input.capability;
          const definition = getHithinkCapability(input.capability);
          if (!definition) throw new Error(`未知扶摇能力：${input.capability}；请先调用 hithink_catalog search`);
          if (definition.mode !== "interactive") {
            throw new Error(`${definition.name} 是大型文件能力，只能通过显式后台同步使用`);
          }
          const parameters = validateToolInput<Record<string, unknown>>(
            `hithink_query.${definition.name}`,
            definition.parameters,
            input.parameters,
          );
          if (signal?.aborted) throw new Error("扶摇临时查询已中断");
          const payload = await query(definition.name, parameters, signal);
          if (signal?.aborted) throw new Error("扶摇临时查询已中断");
          const processed = processHithinkResult(definition, payload, input.result);
          await insertToolAudit(deps.pool, {
            session_id: deps.sessionId,
            tool_name: "hithink_query",
            args: {
              capability: definition.name,
              parameters,
              result: input.result ?? {},
              transient: true,
            },
            result_sha256: sha256Json(processed),
            status: "ok",
          });
          return transientResult({
            transient: true,
            persisted: false,
            source: "hithink",
            retrieved_at: new Date().toISOString(),
            request: parameters,
            ...(definition.name === "stock_history" ? { adjustment: parameters.adjust ?? "forward" } : {}),
            ...processed,
          });
        } catch (error) {
          await insertToolAudit(deps.pool, {
            session_id: deps.sessionId,
            tool_name: "hithink_query",
            args: {
              capability,
              input_sha256: sha256Json(raw),
              transient: true,
            },
            result_sha256: null,
            status: "error",
          }).catch(() => {});
          throw error;
        }
      },
    },
  ];
}
