// Agent 默认只携带工具元信息；需要时再把选中工具的完整 schema 注入下一轮上下文。
import { Type } from "@earendil-works/pi-ai";
import type { AgentContext, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

const MAX_LOAD_COUNT = 8;
const DATABASE_TOOL_PAIR = ["database_schema", "database_query"] as const;

/** 目录呈现分组：按工具职能归组；未登记的工具落入“其他”组，不会静默丢失。 */
const TOOL_GROUP_REGISTRY: ReadonlyArray<{ title: string; tools: readonly string[] }> = [
  {
    title: "外部原子能力",
    tools: ["hithink_catalog", "hithink_query"],
  },
  {
    title: "本地事实读取",
    tools: [
      "portfolio_context_query",
      "pool_context_query",
      "job_context_query",
      "strategy_document_query",
      "instrument_search",
      "market_snapshot_query",
      "stock_research_query",
      "board_query",
      "market_event_query",
      "indicator_query",
    ],
  },
  {
    title: "策略计算读取",
    tools: ["daily_plan_context_query", "swing_signal_query", "limit_up_signal_query", "analysis_run", "strategy_screen_query"],
  },
  {
    title: "持久同步",
    tools: ["fetch_market_data", "fetch_hithink_data"],
  },
  {
    title: "领域写入",
    tools: [
      "pool_onboard",
      "portfolio_write",
      "pool_write",
      "job_write",
      "memory_write",
      "strategy_publish_request",
      "finalize_backtest",
    ],
  },
  {
    title: "任务流程",
    tools: ["auction_context_query", "auction_assessment_write", "pool_attention_write", "daily_plan_write"],
  },
  {
    title: "研究与回测",
    tools: ["memory_query", "web_search", "read_backtest_source", "run_backtest"],
  },
  {
    title: "系统与排障",
    tools: ["trigger_job", "database_schema", "database_query"],
  },
];

function groupedMetadata(tools: AgentTool[]): string {
  const registered = new Set(TOOL_GROUP_REGISTRY.flatMap((group) => group.tools));
  const lines: string[] = [];
  for (const group of TOOL_GROUP_REGISTRY) {
    const matched = tools.filter((tool) => group.tools.includes(tool.name));
    if (matched.length) {
      lines.push(`${group.title}：${matched.map((tool) => `${tool.name}（${tool.label}）`).join("、")}`);
    }
  }
  const others = tools.filter((tool) => !registered.has(tool.name));
  if (others.length) {
    lines.push(`其他：${others.map((tool) => `${tool.name}（${tool.label}）`).join("、")}`);
  }
  return lines.join("\n");
}

export interface OnDemandToolSet {
  initialTools: AgentTool[];
  currentTools: () => AgentTool[];
  syncContext: (context: AgentContext) => AgentContext | undefined;
}

function result(value: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

function validateNames(raw: unknown, available: Map<string, AgentTool>): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("tool_catalog 参数必须是对象");
  const record = raw as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter((key) => key !== "names");
  if (unknownFields.length) throw new Error(`tool_catalog 包含未知字段：${unknownFields.join("、")}`);
  if (!Array.isArray(record.names) || record.names.length < 1 || record.names.length > MAX_LOAD_COUNT) {
    throw new Error(`tool_catalog.names 每次必须包含 1-${MAX_LOAD_COUNT} 个工具名`);
  }
  if (record.names.some((name) => typeof name !== "string")) throw new Error("tool_catalog.names 只能包含字符串");
  const names = record.names as string[];
  if (new Set(names).size !== names.length) throw new Error("tool_catalog.names 不得重复");
  const unavailable = names.filter((name) => !available.has(name));
  if (unavailable.length) throw new Error(`当前会话没有这些工具：${unavailable.join("、")}`);
  return names;
}

/** 保留原工具对象，只延迟向模型暴露其描述和参数 schema。 */
export function createOnDemandToolSet(tools: AgentTool[], initialNames: readonly string[] = []): OnDemandToolSet {
  const available = new Map<string, AgentTool>();
  for (const tool of tools) {
    if (tool.name === "tool_catalog") throw new Error("领域工具不得占用 tool_catalog 名称");
    if (available.has(tool.name)) throw new Error(`工具名称重复：${tool.name}`);
    available.set(tool.name, tool);
  }
  if (available.size === 0) throw new Error("按需工具目录不能为空");

  for (const name of initialNames) {
    if (!available.has(name)) throw new Error(`预加载工具不在当前授权目录：${name}`);
  }
  const loaded = new Set<string>(initialNames);
  const names = [...available.keys()];
  const metadata = groupedMetadata([...available.values()]);
  const parameters = Type.Object({
    names: Type.Array(Type.Union(names.map((name) => Type.Literal(name))), {
      minItems: 1,
      maxItems: MAX_LOAD_COUNT,
      description: "本轮需要加载完整定义的工具名；同类工具一次合并加载。",
    }),
  }, { additionalProperties: false });
  const catalog: AgentTool = {
    name: "tool_catalog",
    label: "加载工具详情",
    description:
      `目录按职能分组；已出现在工具列表中的能力可直接调用。其余能力按任务需要一次加载最多 ${MAX_LOAD_COUNT} 个工具，下一轮即可直接调用；` +
      `不要加载无关工具。database_schema/database_query 会成对加载，用于纵向工具尚未覆盖的内部只读探索或排障。可用目录：\n${metadata}`,
    parameters,
    executionMode: "sequential",
    execute: async (_id, raw, signal) => {
      if (signal?.aborted) throw new Error("工具加载已中断");
      const requested = validateNames(raw, available);
      const includesDatabaseTool = requested.some((name) => DATABASE_TOOL_PAIR.includes(name as typeof DATABASE_TOOL_PAIR[number]));
      const resolved = includesDatabaseTool
        ? [
            ...requested.filter((name) => !DATABASE_TOOL_PAIR.includes(name as typeof DATABASE_TOOL_PAIR[number])),
            ...DATABASE_TOOL_PAIR.filter((name) => available.has(name)),
          ]
        : requested;
      const newlyLoaded = resolved.filter((name) => !loaded.has(name));
      for (const name of resolved) loaded.add(name);
      return result({
        loaded: resolved,
        newly_loaded: newlyLoaded,
        loaded_count: loaded.size,
        available_count: available.size,
        instruction:
          "工具完整定义已加载；优先使用纵向工具，未覆盖的内部问题可用受控数据库只读查询。现在直接调用所需工具，不要再次查询目录。",
      });
    },
  };

  const currentTools = () => [catalog, ...[...loaded].map((name) => available.get(name)!)];
  return {
    initialTools: currentTools(),
    currentTools,
    syncContext: (context) => {
      const nextTools = currentTools();
      const currentNames = (context.tools ?? []).map((tool) => tool.name);
      if (currentNames.length === nextTools.length && currentNames.every((name, index) => name === nextTools[index]!.name)) {
        return undefined;
      }
      return { ...context, tools: nextTools };
    },
  };
}
