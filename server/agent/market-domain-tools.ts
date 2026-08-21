// 默认关闭的市场领域只读工具：只经领域 service 读取，不接收 SQL、表名、URL 或 datasource 端点。
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type pg from "pg";
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
import { insertToolAudit } from "./repo.js";
import { getAgentSettings } from "./settings.js";
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
const IndicatorSchema = strict({
  codes: Type.Array(Code, { minItems: 1, maxItems: 20 }),
  freq: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("30m"), Type.Literal("futures_day")])),
  start: Type.Optional(DateString),
  end: Type.Optional(DateString),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
});

function toolResult(value: unknown): AgentToolResult<unknown> {
  let text = JSON.stringify(value);
  if (text.length > 60_000) text = `${text.slice(0, 60_000)}…[截断]`;
  return { content: [{ type: "text", text }], details: value };
}

async function assertEnabled(pool: pg.Pool): Promise<void> {
  if (!(await getAgentSettings(pool)).market_domain_tools_enabled) {
    throw new Error("市场领域工具开关已关闭；请使用 database_schema/database_query");
  }
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

async function audited(
  deps: { pool: pg.Pool; sessionId: string | null },
  name: string,
  args: unknown,
  operation: () => Promise<unknown>,
): Promise<AgentToolResult<unknown>> {
  await assertEnabled(deps.pool);
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
      description: "查询最多 20 个标的、每个最多 120 个时点的 MA/MACD，并返回计算版本、复权、status 和 gaps；untrusted 不包装为成功。",
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
                ma5: bar.ma5,
                ma10: bar.ma10,
                ma20: bar.ma20,
                ma60: bar.ma60,
                dif: bar.dif,
                dea: bar.dea,
                macd_hist: bar.macd_hist,
              })),
            });
          }
          return rows;
        });
      },
    },
  ];
}
