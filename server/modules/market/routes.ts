// 行情与标的档案 HTTP 路由处理
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §十
import type pg from "pg";
import { ApiError, apiErrors } from "../../http/router.js";
import { resolveRemoteTicker } from "../../datasource/catalog-service.js";
import { fetchKline } from "../../datasource/hithink.js";
import { fetchAndStore } from "../../datasource/service.js";
import type { Bar } from "../../datasource/types.js";
import { MARKET_STRUCTURE_DATASETS, queryMarketStructure } from "./structure.js";
import {
  findInstrumentByCode,
  listBars,
  latestIndicatorStatus,
  marketCoverage,
  searchInstruments,
  INSTRUMENT_KINDS,
  MARKET_FREQS,
  type BarRow,
  type InstrumentRow,
  type InstrumentKind,
  type MarketFreq,
} from "./repo.js";

interface Ctx {
  pool: pg.Pool;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

/** query 参数日期（YYYY-MM-DD），非法抛 400 */
function parseDateOpt(raw: string | null, label: string): string | undefined {
  if (raw === null) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    throw apiErrors.badRequest(`${label} 非法：${raw}`);
  }
  return raw;
}

function shiftYears(date: string, years: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCFullYear(value.getUTCFullYear() - years);
  return value.toISOString().slice(0, 10);
}

function nextDay(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function threeYearWindows(start: string, end: string): Array<{ start: string; end: string }> {
  const result: Array<{ start: string; end: string }> = [];
  let cursor = start;
  while (cursor <= end) {
    const limit = new Date(`${cursor}T00:00:00Z`);
    limit.setUTCFullYear(limit.getUTCFullYear() + 3);
    const windowEnd = limit.toISOString().slice(0, 10) < end ? limit.toISOString().slice(0, 10) : end;
    result.push({ start: cursor, end: windowEnd });
    cursor = nextDay(windowEnd);
  }
  return result;
}

async function fetchOnDemandRange(pool: pg.Pool, code: string, start: string, end: string): Promise<Bar[]> {
  const result: Bar[] = [];
  for (const range of threeYearWindows(start, end)) {
    result.push(...await fetchKline({ code, freq: "day", ...range }, { priority: "interactive", db: pool }));
  }
  return result;
}

function rollingAverage(values: number[], window: number): Array<number | null> {
  let sum = 0;
  return values.map((value, index) => {
    sum += value;
    if (index >= window) sum -= values[index - window]!;
    return index + 1 < window ? null : sum / window;
  });
}

function ema(values: number[], period: number): number[] {
  const factor = 2 / (period + 1);
  return values.reduce<number[]>((result, value, index) => {
    result.push(index === 0 ? value : value * factor + result[index - 1]! * (1 - factor));
    return result;
  }, []);
}

/** 第三方临时 K 线只在响应内补指标，不写 market_instrument / market_bar。 */
export function buildOnDemandBars(bars: Bar[]): BarRow[] {
  const closes = bars.map((bar) => bar.close);
  const ma5 = rollingAverage(closes, 5);
  const ma10 = rollingAverage(closes, 10);
  const ma20 = rollingAverage(closes, 20);
  const ma60 = rollingAverage(closes, 60);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif = closes.map((_, index) => ema12[index]! - ema26[index]!);
  const dea = ema(dif, 9);
  return bars.map((bar, index) => ({
    bar_date: bar.date,
    bar_time: bar.time ?? `${bar.date}T00:00:00Z`,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume ?? null,
    ma5: ma5[index]!,
    ma10: ma10[index]!,
    ma20: ma20[index]!,
    ma60: ma60[index]!,
    dif: dif[index]!,
    dea: dea[index]!,
    macd_hist: (dif[index]! - dea[index]!) * 2,
    adjustment: bar.adjustment ?? null,
    channel: "hithink_on_demand",
  }));
}

function remoteKind(assetType: string): InstrumentKind {
  if (assetType === "a-share-index") return "index";
  if (assetType === "fund-etf") return "etf";
  if (["fund-lof", "fund-otc", "fund-reits"].includes(assetType)) return "fund";
  return "stock";
}

type OnDemandInstrument = Omit<InstrumentRow, "persisted"> & { persisted: false };

async function resolveOnDemandInstrument(pool: pg.Pool, code: string): Promise<OnDemandInstrument | null> {
  const match = (await resolveRemoteTicker(code, { db: pool })).find((item) => item.code === code);
  if (!match) return null;
  return {
    id: "",
    code: match.code,
    name: match.name,
    kind: remoteKind(match.assetType),
    sector_code: null,
    ticker: match.ticker,
    exchange: match.exchange,
    source_asset_type: match.assetType,
    lifecycle_status: "active",
    capabilities: {},
    persisted: false,
  };
}

export const marketRoutes = {
  /** GET /api/instruments?kind=&q=：标的检索（命令面板/选择器） */
  async search({ pool, query }: Ctx) {
    const kindRaw = query.get("kind");
    let kind: InstrumentKind | undefined;
    if (kindRaw !== null) {
      if (!(INSTRUMENT_KINDS as readonly string[]).includes(kindRaw)) {
        throw apiErrors.badRequest(`kind 必须是 ${INSTRUMENT_KINDS.join("/")}`);
      }
      kind = kindRaw as InstrumentKind;
    }
    const q = query.get("q")?.trim() || undefined;
    const assetType = query.get("asset_type")?.trim() || undefined;
    const limitRaw = query.get("limit");
    const limit = limitRaw ? Number(limitRaw) : 50;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
      throw apiErrors.badRequest(`limit 非法：${limitRaw}`);
    }
    return { data: await searchInstruments(pool, { kind, assetType, q, limit }) };
  },

  /** GET /api/instruments/search：本地优先，可选扶摇远程候选。 */
  async searchV2({ pool, query }: Ctx) {
    const kindRaw = query.get("kind");
    if (kindRaw && !(INSTRUMENT_KINDS as readonly string[]).includes(kindRaw)) {
      throw apiErrors.badRequest(`kind 必须是 ${INSTRUMENT_KINDS.join("/")}`);
    }
    const q = query.get("q")?.trim();
    if (!q) throw apiErrors.badRequest("缺少 query 参数 q");
    const assetType = query.get("asset_type")?.trim() || undefined;
    const local = await searchInstruments(pool, {
      kind: kindRaw as InstrumentKind | undefined,
      assetType,
      q,
      limit: 50,
    });
    if (query.get("remote") !== "1" && query.get("remote") !== "true") {
      return { data: { local, remote: [] } };
    }
    try {
      const remoteRows = await resolveRemoteTicker(q, { db: pool });
      const localCodes = new Set(local.map((item) => item.code));
      return {
        data: {
          local,
          remote: remoteRows.filter((item) => !localCodes.has(item.code)).map((item) => ({
            code: item.code,
            name: item.name,
            kind: remoteKind(item.assetType),
            sector_code: null,
            ticker: item.ticker,
            exchange: item.exchange,
            source_asset_type: item.assetType,
            lifecycle_status: "active",
            capabilities: {},
            persisted: false,
          })),
        },
      };
    } catch {
      throw new ApiError(503, "REMOTE_SEARCH_UNAVAILABLE", "远程标的搜索暂不可用，本地结果仍可继续使用", { local });
    }
  },

  /** GET /api/market/bars：板块/指数行情持久化；其他无缓存日线只临时读取。 */
  async bars({ pool, query }: Ctx) {
    const code = query.get("code")?.trim().toUpperCase();
    if (!code) throw apiErrors.badRequest("缺少 query 参数 code");
    const freqRaw = query.get("freq") ?? "day";
    if (!(MARKET_FREQS as readonly string[]).includes(freqRaw)) {
      throw apiErrors.badRequest(`freq 必须是 ${MARKET_FREQS.join("/")}`);
    }
    const start = parseDateOpt(query.get("start"), "start");
    const end = parseDateOpt(query.get("end"), "end");
    if (start && end && start > end) throw apiErrors.badRequest("start 不能晚于 end");
    let instrument: InstrumentRow | OnDemandInstrument | null = await findInstrumentByCode(pool, code);
    const include = new Set((query.get("include") ?? "").split(",").filter(Boolean));
    if ([...include].some((value) => !["ma", "macd"].includes(value))) {
      throw apiErrors.badRequest("include 仅支持 ma,macd");
    }
    let storedBars = instrument
      ? await listBars(pool, {
          instrumentId: instrument.id,
          freq: freqRaw as MarketFreq,
          start,
          end,
          useIndicatorV2: false,
        })
      : [];
    if (!instrument && freqRaw !== "day") throw apiErrors.notFound(`未知标的代码：${code}`);
    if (freqRaw === "day" && (!instrument || storedBars.length === 0)) {
      try {
        instrument ??= await resolveOnDemandInstrument(pool, code);
        if (!instrument) throw apiErrors.notFound(`未知标的代码：${code}`);
        const remoteEnd = end ?? new Date().toISOString().slice(0, 10);
        const remoteStart = start ?? shiftYears(remoteEnd, ["etf", "fund"].includes(instrument.kind) ? 5 : 6);
        if (instrument.persisted && ["index", "board"].includes(instrument.kind)) {
          for (const range of threeYearWindows(remoteStart, remoteEnd)) {
            await fetchAndStore(pool, { code, freq: "day", ...range }, {
              instrumentName: instrument.name,
              hithinkDeps: { priority: "interactive" },
            });
          }
          storedBars = await listBars(pool, {
            instrumentId: instrument.id,
            freq: "day",
            start,
            end,
            useIndicatorV2: false,
          });
        } else {
          const bars = buildOnDemandBars(await fetchOnDemandRange(pool, code, remoteStart, remoteEnd));
          return {
            data: {
              instrument,
              bars,
              data_source: "remote_on_demand",
              indicators: {
                requested: [...include],
                source: "remote_on_demand",
                available: true,
                calculation_version: "remote-on-demand-v1",
                status: "success",
                adjustment: bars.find((bar) => bar.adjustment)?.adjustment ?? null,
                gaps: [],
              },
            },
          };
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, "MARKET_UPSTREAM_UNAVAILABLE", `第三方行情暂不可用：${(error as Error).message}`);
      }
    }
    if (!instrument) throw apiErrors.notFound(`未知标的代码：${code}`);
    const indicator = await latestIndicatorStatus(pool, instrument.id, freqRaw as MarketFreq);
    const v2Requested = include.size > 0 && process.env.INDICATOR_V2_READ === "true";
    const useIndicatorV2 = v2Requested && indicator?.status === "success";
    const bars = useIndicatorV2
      ? await listBars(pool, { instrumentId: instrument.id, freq: freqRaw as MarketFreq, start, end, useIndicatorV2 })
      : storedBars;
    return {
      data: {
        instrument,
        bars,
        data_source: "stored",
        indicators: {
          requested: [...include],
          source: useIndicatorV2 ? "indicator_v2" : "legacy_ma",
          available: indicator?.status === "success",
          calculation_version: indicator?.calculation_version ?? null,
          status: indicator?.status ?? "pending",
          adjustment: indicator?.adjustment ?? null,
          gaps: indicator?.gaps ?? [],
        },
      },
    };
  },

  async structure({ pool, query }: Ctx) {
    const date = parseDateOpt(query.get("date"), "date");
    if (!date) throw apiErrors.badRequest("缺少 query 参数 date");
    const dataset = query.get("dataset");
    if (!dataset || !(MARKET_STRUCTURE_DATASETS as readonly string[]).includes(dataset)) {
      throw apiErrors.badRequest(`dataset 必须是 ${MARKET_STRUCTURE_DATASETS.join("/")}`);
    }
    const page = Number(query.get("page") ?? 1);
    const size = Number(query.get("size") ?? 50);
    if (!Number.isInteger(page) || page < 1) throw apiErrors.badRequest("page 必须是正整数");
    if (!Number.isInteger(size) || size < 1 || size > 200) throw apiErrors.badRequest("size 必须为 1..200");
    return { data: await queryMarketStructure(pool, { date, dataset: dataset as typeof MARKET_STRUCTURE_DATASETS[number], page, size }) };
  },

  /** GET /api/market/coverage：行情覆盖对账摘要（按 freq 分组） */
  async coverage({ pool }: Ctx) {
    return { data: await marketCoverage(pool) };
  },
};
