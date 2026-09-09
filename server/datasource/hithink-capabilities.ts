// 扶摇 REST 能力注册表与临时查询入口。端点路径固定在服务端，Agent 不能传 URL。
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { fetchHithinkDataset, HITHINK_DATASET_SPECS, type HithinkDatasetRequest } from "./hithink-datasets.js";
import { hithinkGet, type HithinkDeps } from "./hithink.js";

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const STOCK_CODE_PATTERN = "^\\d{6}\\.(?:SH|SZ|BJ)$";
const INDEX_CODE_PATTERN = "^\\d{6}\\.(?:TI|SH|SZ)$";
const FUND_CODE_PATTERN = "^\\d{6}\\.(?:SH|SZ|BJ|OF)$";
const ID_PATTERN = "^[A-Za-z0-9._:-]{1,120}$";
const FIELD_PATTERN = "^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)*$";
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

const strictObject = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const date = () => Type.String({ pattern: DATE_PATTERN, description: "YYYY-MM-DD" });
const stockCode = () => Type.String({ pattern: STOCK_CODE_PATTERN });
const indexCode = () => Type.String({ pattern: INDEX_CODE_PATTERN });
const fundCode = () => Type.String({ pattern: FUND_CODE_PATTERN });
const exchangeFundCode = () => Type.String({ pattern: "^\\d{6}\\.(?:SH|SZ)$" });
const id = () => Type.String({ pattern: ID_PATTERN, minLength: 1, maxLength: 120 });
const integer = (minimum: number, maximum: number) => Type.Integer({ minimum, maximum });
const literalUnion = (values: readonly string[]) => Type.Union(values.map((value) => Type.Literal(value)));

export const HITHINK_CAPABILITY_DOMAINS = [
  "meta",
  "market",
  "financial",
  "valuation",
  "calendar",
  "auction",
  "board",
  "fund",
  "special",
  "bulk",
] as const;
export type HithinkCapabilityDomain = (typeof HITHINK_CAPABILITY_DOMAINS)[number];

export interface HithinkCapabilityDefinition {
  name: string;
  label: string;
  domain: HithinkCapabilityDomain;
  description: string;
  path: string;
  parameters: TSchema;
  collections: readonly string[];
  defaultCollection?: string;
  mode: "interactive" | "sync_only";
  execute: (parameters: Record<string, unknown>, deps: HithinkDeps) => Promise<Record<string, unknown>>;
}

function assertRealDate(value: string, field: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} 必须是有效的 YYYY-MM-DD 日期`);
  }
  return value;
}

function shanghaiTimestamp(value: unknown, field: string, endOfDay = false): number {
  const day = assertRealDate(String(value), field);
  const [year, month, dateValue] = day.split("-").map(Number);
  const start = Date.UTC(year!, month! - 1, dateValue!) - CST_OFFSET_MS;
  return endOfDay ? start + 24 * 60 * 60 * 1000 - 1 : start;
}

function assertDateRange(startValue: unknown, endValue: unknown, maximumYears: number): [string, string] {
  const start = assertRealDate(String(startValue), "start");
  const end = assertRealDate(String(endValue), "end");
  if (end < start) throw new Error("end 不能早于 start");
  const lastAllowed = new Date(`${start}T00:00:00Z`);
  lastAllowed.setUTCFullYear(lastAllowed.getUTCFullYear() + maximumYears);
  if (end > lastAllowed.toISOString().slice(0, 10)) {
    throw new Error(`日期范围不能超过${maximumYears}年`);
  }
  return [start, end];
}

function normalizedString(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function normalizedCode(value: unknown, field: string, pattern: RegExp): string {
  const normalized = normalizedString(value, field).toUpperCase();
  if (!pattern.test(normalized)) throw new Error(`${field} 代码格式非法`);
  return normalized;
}

function normalizedCodes(value: unknown, field: string, pattern: RegExp, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new Error(`${field} 必须包含 1-${maximum} 个代码`);
  }
  const result = value.map((item) => normalizedCode(item, field, pattern));
  return [...new Set(result)];
}

function directDefinition(input: {
  name: string;
  label: string;
  domain: HithinkCapabilityDomain;
  description: string;
  path: string;
  parameters: TSchema;
  collections?: readonly string[];
  defaultCollection?: string;
  buildParams?: (parameters: Record<string, unknown>) => Record<string, string | number>;
  execute?: HithinkCapabilityDefinition["execute"];
  mode?: "interactive" | "sync_only";
}): HithinkCapabilityDefinition {
  return {
    ...input,
    collections: input.collections ?? ["item"],
    defaultCollection: input.defaultCollection ?? (input.collections?.[0] ?? "item"),
    mode: input.mode ?? "interactive",
    execute: input.execute ?? (async (parameters, deps) => {
      const data = await hithinkGet(input.path, input.buildParams?.(parameters) ?? parameters as Record<string, string | number>, {
        ...deps,
        priority: deps.priority ?? "interactive",
      });
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error(`${input.name} 响应 data 格式异常`);
      }
      return data as Record<string, unknown>;
    }),
  };
}

function datasetDefinition(input: {
  name: keyof typeof HITHINK_DATASET_SPECS;
  label: string;
  domain: HithinkCapabilityDomain;
  description: string;
  parameters: TSchema;
}): HithinkCapabilityDefinition {
  return directDefinition({
    ...input,
    path: HITHINK_DATASET_SPECS[input.name].path,
    execute: async (parameters, deps) => (await fetchHithinkDataset({
      capability: input.name,
      ...parameters,
    } as HithinkDatasetRequest, deps)).payload,
  });
}

const assetTypes = [
  "a-share", "a-share-index", "forex", "fund-otc", "fund-etf", "fund-lof", "fund-reits",
] as const;
const fundTypes = ["otc", "exchange", "reits"] as const;
const fundBase = {
  fund_type: literalUnion(fundTypes),
  code: fundCode(),
};
const noParameters = strictObject({});
const codeList100 = Type.Array(stockCode(), { minItems: 1, maxItems: 100 });
const anomalyTags = ["LIMIT_UP", "LIMIT_DOWN", "SHARP_RISE", "SHARP_FALL", "RAPID_RALLY", "RAPID_DECLINE"] as const;

const statementParameters = strictObject({
  code: stockCode(),
  period: Type.Optional(literalUnion(["annual", "quarterly"])),
  limit: Type.Optional(integer(1, 20)),
  start: Type.Optional(date()),
  end: Type.Optional(date()),
});

function statementParams(parameters: Record<string, unknown>): Record<string, string | number> {
  const start = parameters.start;
  const end = parameters.end;
  if ((start === undefined) !== (end === undefined)) throw new Error("start 和 end 必须同时提供");
  if (start !== undefined && parameters.limit !== undefined) throw new Error("区间模式不能同时提供 limit");
  const result: Record<string, string | number> = {
    thscode: normalizedCode(parameters.code, "code", /^\d{6}\.(?:SH|SZ|BJ)$/),
    period: String(parameters.period ?? "annual"),
  };
  if (start !== undefined) {
    const [startDate, endDate] = assertDateRange(start, end, 10);
    const startMs = shanghaiTimestamp(startDate, "start");
    const endMs = shanghaiTimestamp(endDate, "end", true);
    result.start = startMs;
    result.end = endMs;
  } else {
    result.limit = Number(parameters.limit ?? 4);
  }
  return result;
}

async function fetchAllOffsetPages(
  path: string,
  initial: Record<string, string | number>,
  pageSize: number,
  deps: HithinkDeps,
): Promise<Record<string, unknown>> {
  const items: unknown[] = [];
  let offset = 0;
  let timestamp: unknown = null;
  let total: unknown = null;
  for (let page = 0; page < 100; page += 1) {
    const data = await hithinkGet(path, { ...initial, limit: pageSize, offset }, {
      ...deps,
      priority: deps.priority ?? "interactive",
    }) as Record<string, unknown>;
    if (!Array.isArray(data?.item)) throw new Error("扶摇分页响应 item 格式异常");
    timestamp = data.timestamp ?? timestamp;
    total = data.total ?? total;
    items.push(...data.item);
    if (data.item.length < pageSize || (typeof total === "number" && items.length >= total)) {
      return { timestamp, total: typeof total === "number" ? total : items.length, item: items };
    }
    offset += pageSize;
  }
  throw new Error("扶摇分页超过 100 页安全上限，请缩小查询范围");
}

const capabilities: HithinkCapabilityDefinition[] = [
  directDefinition({
    name: "ticker_search",
    label: "检索扶摇标的",
    domain: "meta",
    description: "按代码、中英文名称、交易所和资产类别检索标的并消歧。",
    path: "/api/meta/tickers/search",
    parameters: strictObject({
      q: Type.String({ minLength: 1, maxLength: 80 }),
      exchange: Type.Optional(literalUnion(["SH", "SZ", "BJ"])),
      asset_types: Type.Optional(Type.Array(literalUnion(assetTypes), { minItems: 1, maxItems: assetTypes.length })),
      limit: Type.Optional(integer(1, 50)),
    }),
    buildParams: (parameters) => ({
      q: normalizedString(parameters.q, "q"),
      limit: Number(parameters.limit ?? 10),
      ...(parameters.exchange ? { exchange: String(parameters.exchange) } : {}),
      ...(parameters.asset_types ? { asset_type: (parameters.asset_types as string[]).join(",") } : {}),
    }),
  }),
  directDefinition({
    name: "ticker_list",
    label: "查询扶摇标的目录",
    domain: "meta",
    description: "分页列出交易所和资产类别代码表；scan_all 可在内存中扫描全部页供结果处理。",
    path: "/api/meta/tickers/list",
    parameters: strictObject({
      exchanges: Type.Optional(Type.Array(literalUnion(["SH", "SZ", "BJ"]), { minItems: 1, maxItems: 3 })),
      asset_types: Type.Optional(Type.Array(literalUnion(assetTypes), { minItems: 1, maxItems: assetTypes.length })),
      limit: Type.Optional(integer(1, 10_000)),
      offset: Type.Optional(integer(0, 1_000_000)),
      scan_all: Type.Optional(Type.Boolean()),
    }),
    execute: async (parameters, deps) => {
      const base = {
        ...(parameters.exchanges ? { exchange: (parameters.exchanges as string[]).join(",") } : {}),
        ...(parameters.asset_types ? { asset_type: (parameters.asset_types as string[]).join(",") } : {}),
      };
      if (parameters.scan_all === true) return fetchAllOffsetPages("/api/meta/tickers/list", base, 1000, deps);
      return await hithinkGet("/api/meta/tickers/list", {
        ...base,
        limit: Number(parameters.limit ?? 1000),
        offset: Number(parameters.offset ?? 0),
      }, { ...deps, priority: deps.priority ?? "interactive" }) as Record<string, unknown>;
    },
  }),
  directDefinition({
    name: "stock_snapshot",
    label: "查询A股行情快照",
    domain: "market",
    description: "查询指定股票或分页查询全市场最新行情；scan_all 可供临时全市场筛选。",
    path: "/api/a-share/prices/snapshot",
    parameters: strictObject({
      codes: Type.Optional(Type.Array(stockCode(), { minItems: 1, maxItems: 200 })),
      limit: Type.Optional(integer(1, 1000)),
      offset: Type.Optional(integer(0, 1_000_000)),
      scan_all: Type.Optional(Type.Boolean()),
    }),
    execute: async (parameters, deps) => {
      if (parameters.codes !== undefined) {
        if (parameters.scan_all === true || parameters.limit !== undefined || parameters.offset !== undefined) {
          throw new Error("指定 codes 时不能同时使用 scan_all/limit/offset");
        }
        const codes = normalizedCodes(parameters.codes, "codes", /^\d{6}\.(?:SH|SZ|BJ)$/, 200);
        return await hithinkGet("/api/a-share/prices/snapshot", { thscodes: codes.join(",") }, {
          ...deps,
          priority: deps.priority ?? "interactive",
        }) as Record<string, unknown>;
      }
      if (parameters.scan_all === true) return fetchAllOffsetPages("/api/a-share/prices/snapshot", {}, 500, deps);
      return await hithinkGet("/api/a-share/prices/snapshot", {
        limit: Number(parameters.limit ?? 100),
        offset: Number(parameters.offset ?? 0),
      }, { ...deps, priority: deps.priority ?? "interactive" }) as Record<string, unknown>;
    },
  }),
  directDefinition({
    name: "stock_history",
    label: "查询A股历史K线",
    domain: "market",
    description: "查询单只A股最多十年的日K线。",
    path: "/api/a-share/prices/historical",
    parameters: strictObject({
      code: stockCode(), start: date(), end: date(),
      adjust: Type.Optional(literalUnion(["none", "forward", "backward"])),
      offset: Type.Optional(integer(0, 1_000_000)),
    }),
    buildParams: (parameters) => ({
      ...(() => {
        const [start, end] = assertDateRange(parameters.start, parameters.end, 10);
        return { start: shanghaiTimestamp(start, "start"), end: shanghaiTimestamp(end, "end", true) };
      })(),
      thscode: normalizedCode(parameters.code, "code", /^\d{6}\.(?:SH|SZ|BJ)$/),
      interval: "1d",
      adjust: String(parameters.adjust ?? "forward"),
      offset: Number(parameters.offset ?? 0),
    }),
  }),
  directDefinition({
    name: "adjustment_factors",
    label: "查询复权事件",
    domain: "market",
    description: "查询单只A股分红、送股和配股等复权事件流。",
    path: "/api/a-share/corporate-actions/adjustment-factors",
    parameters: strictObject({ code: stockCode(), from: Type.Optional(date()), to: Type.Optional(date()) }),
    buildParams: (parameters) => {
      const from = parameters.from ? assertRealDate(String(parameters.from), "from") : null;
      const to = parameters.to ? assertRealDate(String(parameters.to), "to") : null;
      if (from && to && to < from) throw new Error("to 不能早于 from");
      return {
        thscode: normalizedCode(parameters.code, "code", /^\d{6}\.(?:SH|SZ|BJ)$/),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      };
    },
  }),
  ...([[
    "stock_income_statements", "查询A股利润表", "/api/a-share/financials/income-statements",
  ], [
    "stock_balance_sheets", "查询A股资产负债表", "/api/a-share/financials/balance-sheets",
  ], [
    "stock_cash_flow_statements", "查询A股现金流量表", "/api/a-share/financials/cash-flow-statements",
  ]] as const).map(([name, label, path]) => directDefinition({
    name,
    label,
    domain: "financial",
    description: `${label}的最近若干期或指定日期区间数据。`,
    path,
    parameters: statementParameters,
    buildParams: statementParams,
  })),
  directDefinition({
    name: "stock_financial_indicators",
    label: "查询A股财务指标",
    domain: "financial",
    description: "按报告期查询成长、盈利、偿债、运营和现金流指标。",
    path: "/api/a-share/financials/indicators",
    parameters: strictObject({ code: stockCode(), report: Type.String({ pattern: "^\\d{4}-[1-4]$" }) }),
    collections: ["abilities"],
    buildParams: (parameters) => ({
      thscode: normalizedCode(parameters.code, "code", /^\d{6}\.(?:SH|SZ|BJ)$/),
      report: String(parameters.report),
    }),
  }),
  directDefinition({
    name: "stock_valuation_snapshot",
    label: "查询A股估值快照",
    domain: "valuation",
    description: "批量查询最多100只A股的市盈率、市净率、市销率和市现率。",
    path: "/api/a-share/valuations/snapshot",
    parameters: strictObject({ codes: codeList100 }),
    buildParams: (parameters) => ({
      thscodes: normalizedCodes(parameters.codes, "codes", /^\d{6}\.(?:SH|SZ|BJ)$/, 100).join(","),
    }),
  }),
  directDefinition({
    name: "trading_days",
    label: "查询A股交易日历",
    domain: "calendar",
    description: "查询近一年A股交易日序列。",
    path: "/api/a-share/calendar/trading-days",
    parameters: noParameters,
  }),
  datasetDefinition({
    name: "auction_snapshot", label: "查询集合竞价快照", domain: "auction",
    description: "批量查询最多100只A股的竞价实时或终态快照。",
    parameters: strictObject({ codes: codeList100, stage: Type.Optional(literalUnion(["live", "final"])) }),
  }),
  datasetDefinition({
    name: "auction_short_term_benchmark", label: "查询竞价短线基准", domain: "auction",
    description: "查询指定日期或上海时区当日的竞价短线风向标。",
    parameters: strictObject({ date: Type.Optional(date()) }),
  }),
  directDefinition({
    name: "board_catalog",
    label: "查询同花顺板块目录",
    domain: "board",
    description: "列出概念、行业、区域或特色板块；可在结果层按名称过滤。",
    path: "/api/a-share-index/catalog/ths-index-list",
    parameters: strictObject({ type: Type.Optional(literalUnion(["concept", "industry", "region", "special"])) }),
    buildParams: (parameters) => ({
      tag: ({ concept: "cn_concept", industry: "industry", region: "region", special: "tszs" } as const)[String(parameters.type ?? "concept") as "concept"] ?? "cn_concept",
    }),
  }),
  directDefinition({
    name: "board_constituents",
    label: "查询单个板块成分",
    domain: "board",
    description: "按板块代码或名称查询单个概念、行业、区域、特色板块或标准指数的当前成分。",
    path: "/api/a-share-index/constituents/ths-stock-list",
    parameters: strictObject({
      board: Type.String({ minLength: 1, maxLength: 100, description: "板块/指数代码或名称" }),
      type: Type.Optional(literalUnion(["concept", "industry", "region", "special"])),
    }),
    execute: async (parameters, deps) => {
      const board = normalizedString(parameters.board, "board");
      let code = board.toUpperCase();
      let boardName: string | null = null;
      if (!/^\d{6}\.(?:TI|SH|SZ)$/.test(code)) {
        const type = String(parameters.type ?? "concept") as "concept" | "industry" | "region" | "special";
        const tag = { concept: "cn_concept", industry: "industry", region: "region", special: "tszs" }[type];
        const catalog = await hithinkGet("/api/a-share-index/catalog/ths-index-list", { tag }, {
          ...deps,
          priority: deps.priority ?? "interactive",
        }) as { item?: unknown };
        if (!Array.isArray(catalog.item)) throw new Error("扶摇板块目录 item 格式异常");
        const candidates = catalog.item
          .map((item) => item as Record<string, unknown>)
          .filter((item) => String(item.name ?? "").trim() === board || String(item.name ?? "").includes(board));
        const exact = candidates.filter((item) => String(item.name ?? "").trim() === board);
        const matches = exact.length ? exact : candidates;
        if (matches.length !== 1) {
          const choices = matches.slice(0, 10).map((item) => `${String(item.name)}(${String(item.thscode)})`);
          throw new Error(matches.length === 0
            ? `未找到${type}板块：${board}`
            : `板块名称不唯一，请改用代码：${choices.join("、")}`);
        }
        code = normalizedCode(matches[0]!.thscode, "board", /^\d{6}\.TI$/);
        boardName = String(matches[0]!.name);
      }
      const data = await hithinkGet("/api/a-share-index/constituents/ths-stock-list", { thscode: code }, {
        ...deps,
        priority: deps.priority ?? "interactive",
      }) as Record<string, unknown>;
      return { ...data, board_code: code, ...(boardName ? { board_name: boardName } : {}) };
    },
  }),
  directDefinition({
    name: "index_snapshot",
    label: "查询指数板块快照",
    domain: "board",
    description: "批量查询指数或板块的最新行情。",
    path: "/api/a-share-index/prices/snapshot",
    parameters: strictObject({ codes: Type.Array(indexCode(), { minItems: 1, maxItems: 200 }) }),
    buildParams: (parameters) => ({
      thscodes: normalizedCodes(parameters.codes, "codes", /^\d{6}\.(?:TI|SH|SZ)$/, 200).join(","),
    }),
  }),
  directDefinition({
    name: "index_history",
    label: "查询指数板块历史K线",
    domain: "board",
    description: "查询单个指数或板块最多十年的日K线。",
    path: "/api/a-share-index/prices/historical",
    parameters: strictObject({ code: indexCode(), start: date(), end: date() }),
    buildParams: (parameters) => ({
      ...(() => {
        const [start, end] = assertDateRange(parameters.start, parameters.end, 10);
        return { start: shanghaiTimestamp(start, "start"), end: shanghaiTimestamp(end, "end", true) };
      })(),
      thscode: normalizedCode(parameters.code, "code", /^\d{6}\.(?:TI|SH|SZ)$/),
      interval: "1d",
    }),
  }),
];

const fundDefinitions: HithinkCapabilityDefinition[] = [
  ["fund_profile", "查询基金资料", "查询基金管理人、经理和基本资料。", strictObject(fundBase)],
  ["fund_holdings", "查询基金披露持仓", "查询基金定期披露重仓股，不代表实时组合。", strictObject(fundBase)],
  ["fund_nav", "查询基金净值", "查询基金最新或固定区间净值。", strictObject({
    ...fundBase,
    range: Type.Optional(literalUnion(["week", "month", "tmonth", "hyear", "year", "twoyear", "tyear", "fyear"])),
    nav_type: Type.Optional(literalUnion(["unit", "adj", "unit,adj"])),
  })],
  ["fund_returns", "查询基金区间收益", "查询基金固定区间收益、同类均值和排名。", strictObject(fundBase)],
  ["fund_holders", "查询基金持有人结构", "查询基金披露的机构与个人持有人结构。", strictObject({
    ...fundBase, merge_scope: Type.Optional(literalUnion(["all", "merged", "separate"])),
  })],
  ["fund_industry_allocation", "查询基金行业配置", "查询基金披露的行业配置。", strictObject(fundBase)],
  ["fund_performance_indicators", "查询基金历史业绩指标", "查询日期区间内的基金历史业绩指标。", strictObject({
    ...fundBase, start: date(), end: date(),
  })],
  ["fund_drawdowns", "查询基金回撤", "查询基金固定区间最大回撤。", strictObject(fundBase)],
  ["fund_top_holders", "查询基金前十大持有人", "查询基金披露的前十大持有人。", strictObject({
    ...fundBase, limit: Type.Optional(integer(1, 10)),
  })],
  ["fund_dividends", "查询基金分红", "查询基金历次分红和汇总。", strictObject(fundBase)],
  ["fund_diagnostics", "查询基金诊断", "查询扶摇提供的基金诊断维度。", strictObject(fundBase)],
  ["fund_financial_indicators", "查询基金财务指标", "查询基金披露期财务指标。", strictObject(fundBase)],
  ["fund_income_statements", "查询基金利润表", "查询基金披露期利润表。", strictObject(fundBase)],
  ["fund_balance_sheets", "查询基金资产负债表", "查询基金披露期资产负债表。", strictObject(fundBase)],
  ["fund_news", "查询基金资讯", "查询基金公开资讯元数据。", strictObject({
    ...fundBase, limit: Type.Optional(integer(1, 100)), cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  })],
  ["fund_stock_history", "查询基金历史股票持仓", "按已发现的报告期查询基金股票持仓。", strictObject({
    ...fundBase, report_type: id(), end_date: date(),
  })],
  ["fund_stock_report_dates", "查询基金股票持仓报告期", "查询可用于股票历史持仓的报告期。", strictObject({
    ...fundBase, report_type: Type.Optional(id()),
  })],
  ["fund_bond_history", "查询基金历史债券持仓", "按已发现的报告期查询基金债券持仓。", strictObject({
    ...fundBase, report_type: id(), end_date: date(),
  })],
  ["fund_bond_report_dates", "查询基金债券持仓报告期", "查询可用于债券历史持仓的报告期。", strictObject({
    ...fundBase, report_type: Type.Optional(id()),
  })],
  ["fund_asset_allocation", "查询基金资产配置", "查询基金披露的大类资产配置。", strictObject(fundBase)],
] .map(([name, label, description, parameters]) => datasetDefinition({
  name: name as keyof typeof HITHINK_DATASET_SPECS,
  label: label as string,
  domain: "fund",
  description: description as string,
  parameters: parameters as TSchema,
}));

fundDefinitions.push(
  datasetDefinition({
    name: "fund_company", label: "查询基金公司", domain: "fund", description: "按公司ID查询基金公司详情。",
    parameters: strictObject({ company_id: id() }),
  }),
  ...([[
    "fund_manager_style", "查询基金经理风格", "查询基金经理投资风格。",
  ], [
    "fund_manager_experience", "查询基金经理经历", "查询基金经理从业经历。",
  ], [
    "fund_manager_detail", "查询基金经理详情", "查询基金经理履历和雷达对比。",
  ]] as const).map(([name, label, description]) => datasetDefinition({
    name, label, domain: "fund", description, parameters: strictObject({ manager_id: id() }),
  })),
  datasetDefinition({
    name: "fund_manager_performance", label: "查询基金经理业绩", domain: "fund",
    description: "查询基金经理固定区间业绩。",
    parameters: strictObject({ manager_id: id(), range: literalUnion(["month", "tmonth", "year", "nowyear", "now"]) }),
  }),
  datasetDefinition({
    name: "fund_offerings", label: "查询募集基金", domain: "fund", description: "查询在售或待售基金。",
    parameters: strictObject({ subscribe: literalUnion(["active", "upcoming"]) }),
  }),
  directDefinition({
    name: "fund_market_snapshot", label: "查询场内基金快照", domain: "fund",
    description: "查询单只ETF或LOF场内行情快照。",
    path: "/api/fund/market/snapshot",
    parameters: strictObject({ code: exchangeFundCode() }),
    buildParams: (parameters) => ({ thscode: normalizedCode(parameters.code, "code", /^\d{6}\.(?:SH|SZ)$/) }),
  }),
  directDefinition({
    name: "fund_market_history", label: "查询ETF历史K线", domain: "fund",
    description: "查询单只ETF最多五年的日K线。",
    path: "/api/fund/market/historical",
    parameters: strictObject({ code: exchangeFundCode(), start: date(), end: date() }),
    buildParams: (parameters) => ({
      ...(() => {
        const [start, end] = assertDateRange(parameters.start, parameters.end, 5);
        return { start: shanghaiTimestamp(start, "start"), end: shanghaiTimestamp(end, "end", true) };
      })(),
      thscode: normalizedCode(parameters.code, "code", /^\d{6}\.(?:SH|SZ)$/), interval: "1d",
    }),
  }),
);

const specialDefinitions: HithinkCapabilityDefinition[] = [
  datasetDefinition({
    name: "anomaly_list", label: "查询当日异动列表", domain: "special", description: "查询当日全市场个股异动原因。",
    parameters: strictObject({ tags: Type.Optional(Type.Array(literalUnion(anomalyTags), { minItems: 1, maxItems: 6 })) }),
  }),
  datasetDefinition({
    name: "anomaly_stock", label: "查询个股异动原因", domain: "special", description: "批量查询最多50只股票的当日异动原因。",
    parameters: strictObject({ codes: Type.Array(stockCode(), { minItems: 1, maxItems: 50 }) }),
  }),
  datasetDefinition({
    name: "skyrocket_list", label: "查询飙升榜", domain: "special", description: "查询小时或日维度A股飙升榜。",
    parameters: strictObject({ period: Type.Optional(literalUnion(["day", "hour"])) }),
  }),
  datasetDefinition({
    name: "hot_stock_list", label: "查询当前热股榜", domain: "special", description: "查询小时或24小时热股榜。",
    parameters: strictObject({ period: Type.Optional(literalUnion(["day", "hour"])) }),
  }),
  datasetDefinition({
    name: "hot_stock_history", label: "查询历史热股榜", domain: "special", description: "查询最近一年内指定日期的历史热股榜。",
    parameters: strictObject({ date: date() }),
  }),
  datasetDefinition({
    name: "hot_stock_rank_trend", label: "查询热股排名趋势", domain: "special", description: "查询单只股票在日期区间内的热榜排名趋势。",
    parameters: strictObject({ code: stockCode(), start: date(), end: date() }),
  }),
];

const limitSortFields = {
  limit_up_pool: ["last_price", "continue_day_cnt", "seal_money", "limit_up_time"],
  limit_down_pool: ["last_limit_time", "first_limit_time", "last_price", "price_change_ratio_pct", "turnover_ratio_pct"],
  limit_break_pool: ["price_change_ratio_pct", "open_times", "last_price", "turnover_ratio_pct", "turnover"],
} as const;
for (const [name, label, path] of [[
  "limit_up_pool", "查询涨停池", "/api/a-share/special-data/limit-up-pool",
], [
  "limit_down_pool", "查询跌停池", "/api/a-share/special-data/limit-down-pool",
], [
  "limit_break_pool", "查询炸板池", "/api/a-share/special-data/limit-break-pool",
]] as const) {
  specialDefinitions.push(directDefinition({
    name, label, domain: "special", description: `${label}并保留上游分页信息。`, path,
    parameters: strictObject({
      date: Type.Optional(date()), page: Type.Optional(integer(1, 10_000)), size: Type.Optional(integer(1, 200)),
      sort_field: Type.Optional(literalUnion(limitSortFields[name])),
      sort_dir: Type.Optional(literalUnion(["asc", "desc"])),
    }),
    buildParams: (parameters) => ({
      ...(parameters.date ? { date_ms: shanghaiTimestamp(parameters.date, "date") } : {}),
      page: Number(parameters.page ?? 1), size: Number(parameters.size ?? 50),
      ...(parameters.sort_field ? { sort_field: String(parameters.sort_field) } : {}),
      sort_dir: String(parameters.sort_dir ?? "desc"),
    }),
  }));
}

specialDefinitions.push(
  directDefinition({
    name: "limit_up_ladder", label: "查询连板天梯", domain: "special", description: "查询近30个交易日的连板梯队矩阵。",
    path: "/api/a-share/special-data/limit-up-ladder", parameters: noParameters,
  }),
  directDefinition({
    name: "dragon_tiger_list", label: "查询龙虎榜", domain: "special", description: "查询全部榜、机构榜或游资榜。",
    path: "/api/a-share/special-data/dragon-tiger-list",
    parameters: strictObject({
      board_type: Type.Optional(literalUnion(["all", "org", "hot_money"])), date: Type.Optional(date()),
    }),
    collections: ["stock_items", "hot_money_items"],
    defaultCollection: "stock_items",
    buildParams: (parameters) => ({
      board_type: String(parameters.board_type ?? "all"),
      ...(parameters.date ? { date: assertRealDate(String(parameters.date), "date") } : {}),
    }),
  }),
);

const bulkDefinitions = [[
  "market_dump_daily_k", "全市场十年日K文件", "/api/dump/market-dumps/daily-k/download-url",
], [
  "market_dump_daily_k_10d", "全市场近十日日K文件", "/api/dump/market-dumps/daily-k-10d/download-url",
], [
  "market_dump_adjustment_factors", "全市场复权事件文件", "/api/dump/market-dumps/adjustment-factors/download-url",
]].map(([name, label, path]) => directDefinition({
  name: name!, label: label!, domain: "bulk", path: path!, parameters: noParameters, collections: [], mode: "sync_only",
  description: "大型Parquet下载能力，只允许显式后台同步，不向对话返回预签名URL。",
}));

export const HITHINK_CAPABILITIES = [
  ...capabilities,
  ...fundDefinitions,
  ...specialDefinitions,
  ...bulkDefinitions,
] as const;

const capabilityByName = new Map(HITHINK_CAPABILITIES.map((definition) => [definition.name, definition]));
if (capabilityByName.size !== 59) {
  throw new Error(`扶摇能力注册表应包含59项，实际${capabilityByName.size}项`);
}

export function getHithinkCapability(name: string): HithinkCapabilityDefinition | null {
  return capabilityByName.get(name) ?? null;
}

export function searchHithinkCapabilities(input: {
  query?: string;
  domain?: HithinkCapabilityDomain;
  limit?: number;
}): HithinkCapabilityDefinition[] {
  const query = input.query?.trim().toLowerCase() ?? "";
  const limit = input.limit ?? 10;
  const queryTokens = query
    ? [...new Set([
        ...query.split(/\s+/).filter(Boolean),
        ...Array.from(query).slice(0, -1).map((char, index) => `${char}${Array.from(query)[index + 1]}`),
      ])]
    : [];
  return HITHINK_CAPABILITIES
    .filter((item) => !input.domain || item.domain === input.domain)
    .map((item) => {
      const text = `${item.name} ${item.label} ${item.description}`.toLowerCase();
      const score = !query ? 1 : text === query ? 100 : text.includes(query) ? 20 : queryTokens
        .reduce((sum, token) => sum + (text.includes(token) ? 1 : 0), 0);
      return { item, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.item.name.localeCompare(right.item.name))
    .slice(0, limit)
    .map(({ item }) => item);
}

export async function executeHithinkCapability(
  name: string,
  parameters: Record<string, unknown>,
  deps: HithinkDeps,
): Promise<Record<string, unknown>> {
  const definition = getHithinkCapability(name);
  if (!definition) throw new Error(`未知扶摇能力：${name}`);
  if (definition.mode !== "interactive") {
    throw new Error(`${name} 是大型文件能力，只能通过显式后台同步使用，临时查询不会返回预签名URL`);
  }
  return definition.execute(parameters, deps);
}

export const HITHINK_RESULT_FIELD_PATTERN = FIELD_PATTERN;
