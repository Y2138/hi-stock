// datasource 模块测试：通道选择、降级留痕、限流间隔、退避重试、幂等落库、MA 计算、market_fetch_run 记录
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §五、§十二
// 所有外部 HTTP 均 mock（vi.stubGlobal fetch），不依赖真实网络；DB 用例使用 stock_test 库。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { runMigrations } from "../../server/db/migrate.js";
import { prepareTestDb, resetSchema } from "./helpers.js";
import { RateLimiter, withBackoff } from "../../server/datasource/ratelimit.js";
import { HithinkRequestScheduler } from "../../server/datasource/request-scheduler.js";
import {
  HithinkChannel,
  HithinkEnvelopeError,
  fetchKline,
  fetchRawStockDaily,
  fetchSnapshot,
  fetchCorporateActions,
} from "../../server/datasource/hithink.js";
import { fetchAllTickers, fetchTickerPage, fetchTradingDays } from "../../server/datasource/hithink-meta.js";
import { fetchBoardCatalog, fetchBoardConstituents } from "../../server/datasource/hithink-boards.js";
import { fetchDragonTiger, fetchLimitPoolPage } from "../../server/datasource/hithink-special.js";
import {
  HITHINK_DATASET_CAPABILITIES,
  HITHINK_DATASET_SPECS,
  fetchHithinkDataset,
  fetchHithinkDatasetAndStore,
  normalizeHithinkDatasetRequest,
} from "../../server/datasource/hithink-datasets.js";
import { executeHithinkCapability, HITHINK_CAPABILITIES } from "../../server/datasource/hithink-capabilities.js";
import { syncAllBoardMemberships, syncBoardMembership, syncMarketCatalog, upsertTickerIdentities } from "../../server/datasource/catalog-service.js";
import { syncLimitDataset, syncLimitLadder } from "../../server/datasource/special-service.js";
import {
  calculateDefenseRecovery,
  calculateIndicators,
  calculateStockCharacterProfile,
  STOCK_CHARACTER_CALCULATION_VERSION,
} from "../../server/indicators/formulas.js";
import { recomputeIndicatorSeries } from "../../server/indicators/service.js";
import { repairInvalidForwardOhlc } from "../../server/datasource/forward-ohlc-repair.js";
import { buildOnDemandBars } from "../../server/modules/market/routes.js";
import { queryMarketStructure } from "../../server/modules/market/structure.js";
import {
  buildLimitUpFeatureRows,
  empiricalMidrank,
  scoreLimitUpFeatureRows,
  queryLimitUpSignals,
  limitUpBenchmarkSha,
  cleanLimitUpThemes,
  rankLimitUpPkRows,
  type LimitUpBenchmark,
} from "../../server/modules/market/limit-up-signals.js";
import { limitUpPkProfile, sameHeightPkGroups } from "../../server/modules/market/limit-up-pk.js";
import indicatorFixture from "../fixtures/指标金样本.json";
import { fetchFundFlow, fetchSzseCalendarMonth } from "../../server/datasource/akshare.js";
import {
  dailyMarketUpdate,
  ensureInstrument,
  fetchAndStore,
  fillRawStockDaily,
  fetchFinancialAndStore,
  storeBars,
} from "../../server/datasource/service.js";
import type { Bar, Channel, FetchRequest } from "../../server/datasource/types.js";
import {
  recordCommodityFetchRun,
  storeCompanyCommodityMetric,
  storeCompanyCommodityProfile,
  storeFuturesDailyDetail,
  storeFuturesRoll,
  storeMarketFactorObservation,
  upsertFuturesContract,
  upsertMarketFactorSeries,
} from "../../server/datasource/commodity-service.js";
import { fetchShfeCopperWeeklyInventory, fetchShfeDailyContracts } from "../../server/datasource/shfe.js";
import { fetchCoastalPowerCoalHistory } from "../../server/datasource/jin10.js";
import { syncShfeCopperWeeklyInventory, syncShfeFuturesDaily } from "../../server/datasource/shfe-service.js";
import { syncCopperMacroFactors } from "../../server/datasource/copper-macro-service.js";

const noopSleep = async () => {};
const noWait = { limiter: new RateLimiter(0, noopSleep), sleep: noopSleep, apiKey: "test-placeholder" };

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function textResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

describe("打板固定基准评分", () => {
  it("经验中位秩正确处理并列值，路线阈值还必须同时通过当日前2名", () => {
    expect(empiricalMidrank(2, [1, 2, 2, 3])).toBe(0.5);
    const features = {
      theme_share: 1, theme_max_streak: 1, theme_tier_count: 1, market_hhi: 1,
      market_limit_up_count: 0, theme_turnover_log: 0, seal_turnover_ratio: 1,
      seal_minutes: 0, theme_pre5_return: 1, theme_width: 1, stock_pre5_return: 1,
      persistence_5d: 1, above_ma20: 1, promotion_rate: 1, negative_feedback: 0,
      first_board_share: 1, core_position: 1,
    };
    const rows: Parameters<typeof scoreLimitUpFeatureRows>[0] = ["600001.SH", "600002.SH", "600003.SH"].map((code) => ({
      event: {
        date: "2026-08-20", event_type: "up", code, name: code, streak_count: 2,
        open_count: 0, first_event_time: "2026-08-20T01:30:00Z", reason: "机器人",
        is_st: false, is_new: false, seal_money: 100, max_seal_money: 100, turnover: 100,
      },
      mainTheme: "机器人",
      features,
      missingInputs: [],
    }));
    const distributions = Object.fromEntries([
      "theme_share", "theme_max_streak", "theme_tier_count", "market_hhi",
      "market_limit_up_count", "theme_turnover_log", "seal_turnover_ratio", "seal_minutes",
      "theme_pre5_return", "theme_width", "stock_pre5_return",
    ].map((key) => [key, [0, 1]])) as LimitUpBenchmark["distributions"];
    const candidates = scoreLimitUpFeatureRows(rows, {
      code: "test", document_id: "1", training_start: "2025-01-01", training_end: "2025-06-30",
      methodology: "test", distributions, sample_counts: {}, source_summary: {}, sha256: "0".repeat(64),
    });
    expect(candidates.filter((item) => item.signal_grade === "A").map((item) => item.code))
      .toEqual(["600001.SH", "600002.SH"]);
    expect(candidates.find((item) => item.code === "600003.SH")).toMatchObject({
      cluster_rank: 3, momentum_rank: 3, signal_grade: null,
    });
  });

  it("旧趋势基准日缺K线不阻断承接PK，背景缺口仍逐股披露且不传染同题材", async () => {
    const tradingDates = Array.from({ length: 22 }, (_, index) =>
      new Date(Date.UTC(2026, 7, index + 1)).toISOString().slice(0, 10));
    const target = tradingDates.at(-1)!;
    const events = tradingDates.flatMap((date) => ["600001.SH", "600002.SH"].map((code) => ({
      date, event_type: "up" as const, code, name: code, streak_count: 1,
      open_count: 0, first_event_time: `${date}T01:30:00Z`, reason: "机器人",
      is_st: false, is_new: false, seal_money: 100, max_seal_money: 100, turnover: 100,
    })));
    const bars = tradingDates.flatMap((date, index) => ["600001.SH", "600002.SH"]
      .filter((code) => !(code === "600002.SH" && index === tradingDates.length - 7))
      .map((code) => ({ date, code, open: 10, high: 13, low: 9, close: 10 + index / 10, volume: 100, turnover: 100 })));
    const distributions = Object.fromEntries([
      "theme_share", "theme_max_streak", "theme_tier_count", "market_hhi",
      "market_limit_up_count", "theme_turnover_log", "seal_turnover_ratio", "seal_minutes",
      "theme_pre5_return", "theme_width", "stock_pre5_return",
    ].map((key) => [key, [0, 1]])) as LimitUpBenchmark["distributions"];
    const payload: Omit<LimitUpBenchmark, "sha256"> = {
      code: "test", document_id: "1", training_start: "2025-01-01", training_end: "2025-06-30",
      methodology: "test", distributions, sample_counts: {}, source_summary: {},
    };
    const benchmark = { ...payload, sha256: limitUpBenchmarkSha(payload) };
    const db = { query: async (sql: string) => {
      if (sql.includes("FROM strategy_document document")) return { rows: [{ id: "1" }] };
      if (sql.includes("FROM strategy_score_benchmark benchmark")) return { rows: [{ ...benchmark, benchmark_code: benchmark.code }] };
      if (sql.includes("FROM market_limit_event event")) return { rows: events };
      if (sql.includes("FROM market_bar bar JOIN market_instrument")) return { rows: bars };
      if (sql.includes("FROM market_trading_day")) return { rows: tradingDates.map((date) => ({ date })) };
      if (sql.includes("FROM strategy_entry_signal signal")) return { rows: [] };
      if (sql.includes("FROM market_news_item n")) return { rows: [] };
      if (sql.includes("FROM market_special_sync_run")) return { rows: [] };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    } } as unknown as Parameters<typeof queryLimitUpSignals>[0];
    const result = await queryLimitUpSignals(db, target);
    expect(result).toMatchObject({ status: "success", candidate_count: 2, skipped_count: 0, gaps: [], selection_method: "stage_pk_v2" });
    expect(result.skipped).toEqual([]);
    expect(result.candidates.find((item) => item.code === "600002.SH")?.missing_inputs).toContain("stock_pre5_return");
    expect(result.candidates.map((item) => item.code)).toEqual(["600001.SH", "600002.SH"]);
    expect(result.candidates[0]!.features.theme_pre5_return).not.toBeNull();
  });

  it("09:25一字板按0分钟处理，近5日持续性不把T日自身计入且名称可兜底排除ST", () => {
    const tradingDates = ["2026-08-13", "2026-08-14", "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20"];
    const events = tradingDates.map((date, index) => ({
      date, event_type: "up" as const, code: `60000${index + 1}.SH`, name: `样本${index + 1}`,
      streak_count: 1, open_count: 0, first_event_time: `${date}T01:25:00Z`,
      reason: index === 5 ? "机器人" : "旧题材", is_st: false, is_new: false,
      seal_money: 100, max_seal_money: 100, turnover: 100,
    }));
    events.push({ ...events.at(-1)!, code: "600099.SH", name: "*ST样本" });
    const bars = events.map((event) => ({ date: event.date, code: event.code, open: 10, close: 10, turnover: 100 }));
    const rows = buildLimitUpFeatureRows({ events, bars, tradingDates, targetDates: ["2026-08-20"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.features.seal_minutes).toBe(0);
    expect(rows[0]!.features.persistence_5d).toBe(0);
  });

  it("同为三板比较承接，历史高分不能盖过巨量弱封，数据并列不凭代码判胜", () => {
    const input = { code: "600001.SH", streak: 3, seal: 30, maxSeal: 40, turnover: 100,
      minute: 5, volumeRatio: 1, oneWord: false, core: 1, phase: "close" as const };
    const make = (code: string, seal: number, volumeRatio = 1) => ({ code, streak_count: 3,
      pk: limitUpPkProfile({ ...input, code, seal, volumeRatio }), pk_minute: 5, pk_turnover: 100, pk_core: 1 });
    const weak = make("600001.SH", 8, 3);
    const strong = make("600002.SH", 30);
    expect(weak.pk.status).toBe("observe_only");
    expect(sameHeightPkGroups([weak, strong])[0]).toMatchObject({ data_leader: strong.code,
      participation_leader: strong.code, peer_codes: [strong.code, weak.code], source_streak: 3, target_streak: 4 });
    expect(sameHeightPkGroups([strong, make("600003.SH", 30)])[0]?.data_leader).toBeNull();
    expect(sameHeightPkGroups([weak])[0]?.data_leader).toBeNull();
  });

  it("一字强度与参与首位分开，盘中不拿累计量冒充全天缩量，缺值保留未知", () => {
    const base = { code: "600001.SH", streak: 3, seal: 50, maxSeal: 60, turnover: 100,
      minute: 0, volumeRatio: 3, oneWord: true, core: 1, phase: "intraday" as const };
    const pk = limitUpPkProfile(base);
    expect(pk).toMatchObject({ status: "review", volume_ratio_prev: null, execution: "queue_uncertain" });
    const groups = sameHeightPkGroups([{ code: base.code, streak_count: 3, pk, pk_minute: 0, pk_turnover: 100, pk_core: 1 }]);
    expect(groups[0]).toMatchObject({ data_leader: base.code, participation_leader: null });
    expect(limitUpPkProfile({ ...base, seal: null, oneWord: null })).toMatchObject({ status: "insufficient", execution: "unknown", seal_turnover_ratio: null });
  });

  it("主升顺位由同阶段承接决定，旧分数较高的弱封标的仅观察", () => {
    const features = Object.fromEntries(["theme_share", "theme_max_streak", "theme_tier_count", "market_hhi",
      "market_limit_up_count", "theme_turnover_log", "seal_turnover_ratio", "seal_minutes", "theme_pre5_return",
      "theme_width", "stock_pre5_return", "persistence_5d", "above_ma20", "promotion_rate", "negative_feedback",
      "first_board_share", "core_position"].map((key) => [key, 1])) as unknown as Parameters<typeof rankLimitUpPkRows>[0][number]["features"];
    const rows: Parameters<typeof rankLimitUpPkRows>[0] = ["600001.SH", "600002.SH"].map((code, i) => ({
      event: { date: "2026-08-20", event_type: "up", code, name: code, streak_count: 3, open_count: null,
        first_event_time: "2026-08-20T01:30:00Z", reason: "机器人", is_st: false, is_new: false,
        seal_money: i ? 30 : 2, max_seal_money: 40, turnover: 100 }, mainTheme: "机器人", features,
      missingInputs: [], pk: limitUpPkProfile({ code, streak: 3, seal: i ? 30 : 2, maxSeal: 40, turnover: 100,
        minute: 0, volumeRatio: 3, oneWord: false, core: 1, phase: "close" }),
    }));
    const distributions = Object.fromEntries(Object.keys(features).map((key) => [key, [0, 1]])) as LimitUpBenchmark["distributions"];
    const result = rankLimitUpPkRows(rows, { code: "test", document_id: "1", training_start: "2025-01-01", training_end: "2025-06-30",
      methodology: "test", distributions, sample_counts: {}, source_summary: {}, sha256: "0".repeat(64) });
    expect(result.signals.map((item) => item.code)).toEqual(["600002.SH"]);
    expect(result.route_leaders).toEqual({ cluster: "600002.SH", momentum: "600002.SH" });
  });

  it("出版同义与独立事件保留，主标签优先同标的连续驱动而非每日切换", () => {
    expect(cleanLimitUpThemes("教科书发行+图书发行+控制权拟变更+资产重组+回购"))
      .toEqual(["出版传媒", "控制权变更", "资产重组"]);
    const dates = ["2026-08-19", "2026-08-20"];
    const event = { event_type: "up" as const, code: "600001.SH", name: "样本", streak_count: 2,
      open_count: null, first_event_time: "2026-08-20T01:30:00Z", reason: "图书发行", is_st: false, is_new: false,
      seal_money: 100, max_seal_money: 100, turnover: 100 };
    const events = [{ ...event, date: dates[0]! }, { ...event, date: dates[1]!, reason: "教科书发行+机器人" },
      ...["600002.SH", "600003.SH"].map((code) => ({ ...event, code, date: dates[1]!, reason: "机器人" }))];
    const rows = buildLimitUpFeatureRows({ events, bars: [], tradingDates: dates, targetDates: [dates[1]!] });
    expect(rows.find((row) => row.event.code === "600001.SH")?.mainTheme).toBe("出版传媒");
  });
});

/** 构造扶摇 kline 信封：dates 与 closes 等长 */
function klinePayload(dates: string[], closes: number[]): unknown {
  return {
    code: 0,
    message: "success",
    request_id: "test",
    data: {
      item: dates.map((d, i) => ({
        date_ms: Date.parse(`${d}T00:00:00+08:00`),
        open_price: closes[i],
        high_price: closes[i]! + 1,
        low_price: closes[i]! - 1,
        close_price: closes[i],
        volume: 1000 + i,
      })),
    },
  };
}

describe("未复权日线获取", () => {
  it("只补已有日线缺失原价，不改前复权 OHLC；请求失败不写库", async () => {
    let rawLow: number | null = null;
    let updates = 0;
    const db = { query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("SELECT bar.instrument_id")) return { rows: [{ id: "7", missing: rawLow === null, invalid: rawLow !== null && rawLow <= 0 }] };
      if (!sql.includes("UPDATE market_bar")) throw new Error("未预期 SQL");
      updates += 1;
      expect(params.slice(0, 2)).toEqual(["7", "2026-09-17"]);
      rawLow = params[4] as number;
      return { rowCount: 1 };
    }) } as unknown as Pick<pg.Pool, "query">;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(klinePayload(["2026-09-17"], [20]))));
    try {
      expect(await fillRawStockDaily(db, "600489.SH", "2026-09-17", { hithinkDeps: noWait })).toBe(1);
      expect(rawLow).toBe(19);
      expect(await fillRawStockDaily(db, "600489.SH", "2026-09-17", { hithinkDeps: noWait })).toBe(0);
      expect(updates).toBe(1);
      rawLow = null;
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(klinePayload(["2026-09-16"], [20]))));
      await expect(fillRawStockDaily(db, "600489.SH", "2026-09-17", { hithinkDeps: noWait })).rejects.toThrow("未返回");
      expect(updates).toBe(1);
      rawLow = 0;
      await expect(fillRawStockDaily(db, "600489.SH", "2026-09-17", { hithinkDeps: noWait })).rejects.toThrow("已有未复权价非正");
      expect(updates).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it("只请求股票 adjust=none，拒绝错日与无效价格", async () => {
    const code = "600489.SH", date = "2026-09-17";
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      seen.push(url.searchParams.get("adjust") ?? "missing");
      return jsonResponse(klinePayload([date], [20]));
    }));
    try {
      expect(await fetchRawStockDaily(code, date, noWait)).toMatchObject({ date, low: 19, adjustment: "none" });
      expect(seen).toEqual(["none"]);
      await expect(fetchRawStockDaily("881001.TI", date, noWait)).rejects.toThrow("仅支持A股");
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(klinePayload(["2026-09-16"], [20]))));
      await expect(fetchRawStockDaily(code, date, noWait)).rejects.toThrow("未返回");
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(klinePayload([date], [0]))));
      await expect(fetchRawStockDaily(code, date, noWait)).rejects.toThrow("OHLC 无效");
    } finally { vi.unstubAllGlobals(); }
  });
});

/** 构造新浪 30 分钟 jsonp 文本（与 2026-08-16 实测格式一致：注释前缀 + var=(...)） */
function sina30mText(times: string[]): string {
  const arr = times.map((t, i) => ({
    day: t,
    open: "10.00",
    high: "11.00",
    low: "9.00",
    close: (10 + i).toFixed(2),
    volume: "1000",
  }));
  return `/*<script>location.href='//sina.com';</script>*/\nvar=(${JSON.stringify(arr)});`;
}

/** 构造新浪期货日线 jsonp 文本 */
function sinaFuturesText(dates: string[]): string {
  const arr = dates.map((d, i) => ({
    d,
    o: "100.0",
    h: "110.0",
    l: "90.0",
    c: (100 + i).toFixed(1),
    v: "5000",
    p: "0",
    s: "0.0",
  }));
  return `/*<script>location.href='//sina.com';</script>*/\nvar=(${JSON.stringify(arr)});`;
}

function snapshotPayload(code: string, date: string, prevClose: number): unknown {
  return {
    code: 0,
    message: "success",
    request_id: "test",
    data: {
      timestamp: Date.parse(`${date}T15:05:00+08:00`),
      item: [
        {
          thscode: code,
          volume: 12345,
          last_price: prevClose + 1,
          open_price: prevClose,
          high_price: prevClose + 2,
          low_price: prevClose - 1,
          prev_price: prevClose,
        },
      ],
    },
  };
}

function makeBars(dates: string[]): Bar[] {
  return dates.map((d, i) => ({
    date: d,
    open: 10 + i,
    high: 11 + i,
    low: 9 + i,
    close: 10 + i,
    volume: 100,
  }));
}

// ---------- 纯单元用例（不需要数据库） ----------

describe("datasource 限流与重试", () => {
  it("临时第三方日线在响应内补齐均线和 MACD 且不依赖落库", () => {
    const bars = buildOnDemandBars(Array.from({ length: 60 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
      open: index + 1, high: index + 2, low: index, close: index + 1,
    })));
    expect(bars[4]).toMatchObject({ ma5: 3, ma10: null, channel: "hithink_on_demand" });
    expect(bars[59]).toMatchObject({ ma5: 58, ma60: 30.5 });
    expect(bars[59]!.macd_hist).toBeTypeOf("number");
    expect(bars[59]!.rsi14).toBeTypeOf("number");
  });

  it("正式日线指标三版与 pandas/ta 金样本一致，并按 Wilder 口径计算 RSI14", () => {
    const actual = calculateIndicators(indicatorFixture.input);
    for (const expected of indicatorFixture.expected) {
      const point = actual[expected.index]!;
      for (const key of ["ma5", "ma10", "ma20", "ma60", "dif", "dea"] as const) {
        const reference = expected[key];
        if (reference === null) expect(point[key]).toBeNull();
        else expect(Math.abs(point[key]! - reference)).toBeLessThanOrEqual(1e-10 + 1e-9 * Math.abs(reference));
      }
      const referenceHist = expected.macd_hist;
      if (referenceHist === null) expect(point.macdHist).toBeNull();
      else expect(Math.abs(point.macdHist! - referenceHist)).toBeLessThanOrEqual(1e-10 + 1e-9 * Math.abs(referenceHist));
    }
    const rising = calculateIndicators(Array.from({ length: 15 }, (_, index) => index + 1));
    const falling = calculateIndicators(Array.from({ length: 15 }, (_, index) => 15 - index));
    const flat = calculateIndicators(Array(15).fill(10));
    expect(rising[13]!.rsi14).toBeNull();
    expect(rising[14]!.rsi14).toBe(100);
    expect(falling[14]!.rsi14).toBe(0);
    expect(flat[14]!.rsi14).toBe(50);
  });

  it("五维股性画像与阶段对相同输入稳定且只输出有限数", () => {
    const closes = Array.from({ length: 160 }, (_, index) => 10 + index * 0.02 + Math.sin(index / 6) * 0.4);
    const indicators = calculateIndicators(closes);
    const bars = closes.map((close, index) => ({
      open: close - 0.05,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume: 1_000 + index,
      ma10: indicators[index]!.ma10,
      ma20: indicators[index]!.ma20,
      ma60: indicators[index]!.ma60,
    }));
    const first = calculateStockCharacterProfile(bars);
    expect(calculateStockCharacterProfile(bars)).toEqual(first);
    expect(STOCK_CHARACTER_CALCULATION_VERSION).toBe("标的入池五维画像一版");
    expect(Object.keys(first.dimensions)).toEqual(["washout", "markup", "false_breakout", "defense", "volatility"]);
    expect(first.stage).toBeTypeOf("string");
    // 标的评分机制已退役：画像只保留股性、阶段、标签与关键位。
    expect(first).not.toHaveProperty("score");
    expect(first).not.toHaveProperty("grade");
    for (const dimension of Object.values(first.dimensions)) {
      expect(Number.isFinite(dimension.score)).toBe(true);
      expect(Object.values(dimension.evidence).every((value) => value === null || Number.isFinite(value))).toBe(true);
    }
  });

  it("护盘收回率只统计跌破MA10且已走满三个后续交易日的事件", () => {
    const rows = [
      11, 9, 9, 10.1, 11, 9, 9, 9, 9, 11, 9,
    ].map((close) => ({ close, ma10: 10 }));
    expect(calculateDefenseRecovery(rows)).toEqual({
      inputRowCount: 11,
      eventCount: 2,
      recoveredCount: 1,
      recoveryRate: 0.5,
    });
  });

  it("统一请求队列遵守优先级，连续五个高优先请求后放行低优先请求", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const scheduler = new HithinkRequestScheduler(0, noopSleep);
    const tasks: Promise<unknown>[] = [
      scheduler.schedule("interactive", async () => {
        await firstGate;
        order.push("first");
      }),
    ];
    for (let index = 1; index <= 5; index += 1) {
      tasks.push(scheduler.schedule("interactive", async () => void order.push(`high-${index}`)));
    }
    tasks.push(scheduler.schedule("scheduled-low", async () => void order.push("low")));
    releaseFirst();
    await Promise.all(tasks);
    expect(order).toEqual(["first", "high-1", "high-2", "high-3", "high-4", "low", "high-5"]);
    expect(scheduler.snapshot()).toMatchObject({ running: false, completed: 7, failed: 0 });
  });

  it("扶摇排队和在途 HTTP 请求都响应中断信号", async () => {
    const scheduler = new HithinkRequestScheduler(0, noopSleep);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = scheduler.schedule("interactive", () => firstGate);
    let queuedRan = false;
    const queuedController = new AbortController();
    const queued = scheduler.schedule("interactive", async () => {
      queuedRan = true;
    }, queuedController.signal);
    queuedController.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    releaseFirst();
    await first;
    expect(queuedRan).toBe(false);

    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      markFetchStarted();
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }));
    const requestController = new AbortController();
    const pending = fetchKline({
      code: "000636.SZ",
      freq: "day",
      start: "2026-08-13",
      end: "2026-08-14",
    }, { ...noWait, signal: requestController.signal });
    await fetchStarted;
    requestController.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    vi.unstubAllGlobals();
  });

  it("公司行动按除权日解析现金分红、送股和配股字段", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      code: 0, message: "success", data: { item: [{
        ex_date_ms: Date.parse("2026-07-10T00:00:00Z"), dividend_per_share: 0.5,
        per_share_bonus: 0.1, rights_ratio: 0.2, rights_price: 6.8,
      }] },
    })));
    const rows = await fetchCorporateActions("600000.SH", "2026-01-01", "2026-09-16", noWait);
    expect(rows).toEqual([expect.objectContaining({
      code: "600000.SH", exDate: "2026-07-10", dividendPerShare: 0.5,
      bonusPerShare: 0.1, rightsRatio: 0.2, rightsPrice: 6.8,
    })]);
    vi.unstubAllGlobals();
  });

  it("限流器相邻放行间隔 ≥3 秒（注入 sleep 记录等待时长）", async () => {
    const waits: number[] = [];
    const limiter = new RateLimiter(3000, async (ms) => {
      waits.push(ms);
    });
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    // 首次放行不等待；后两次都必须等满 ~3000ms（注入 sleep 不真实流逝时间）
    expect(waits.length).toBe(2);
    for (const w of waits) expect(w).toBeGreaterThanOrEqual(2990);
  });

  it("withBackoff 指数退避：2s、4s 后成功", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("boom");
        return "ok";
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(waits).toEqual([2000, 4000]);
  });

  it("扶摇信封 code=4001 退避重试最多 2 次", async () => {
    const rateLimited = () =>
      jsonResponse({ code: 4001, message: "频率超限", request_id: "t", data: null });
    const dates = ["2026-08-13", "2026-08-14"];

    // 先 4001 一次后成功：共 2 次调用
    let seq = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        seq += 1;
        return seq === 1 ? rateLimited() : jsonResponse(klinePayload(dates, [10, 11]));
      }),
    );
    const req: FetchRequest = {
      code: "000636.SZ",
      freq: "day",
      start: "2026-08-13",
      end: "2026-08-14",
    };
    const bars = await fetchKline(req, noWait);
    expect(bars.length).toBe(2);
    expect(seq).toBe(2);

    // 持续 4001：首次 + 2 次重试后抛出信封错误
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return rateLimited();
      }),
    );
    await expect(fetchKline(req, noWait)).rejects.toBeInstanceOf(HithinkEnvelopeError);
    expect(calls).toBe(3);
    vi.unstubAllGlobals();
  });

  it("指数和板块快照按 200 个代码分批并校验完整覆盖", async () => {
    const codes = Array.from({ length: 201 }, (_, index) => `${String(880000 + index).padStart(6, "0")}.TI`);
    const batchSizes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const batch = new URL(String(url)).searchParams.get("thscodes")!.split(",");
      batchSizes.push(batch.length);
      return jsonResponse({
        code: 0,
        data: {
          timestamp: Date.parse("2026-08-20T15:00:00+08:00"),
          item: batch.map((code) => ({
            thscode: code,
            open_price: 10,
            high_price: 11,
            low_price: 9,
            last_price: 10.5,
            prev_price: 10,
          })),
        },
      });
    }));
    expect(await fetchSnapshot(codes, noWait, "index")).toHaveLength(201);
    expect(batchSizes).toEqual([200, 1]);
    vi.unstubAllGlobals();
  });

  it("东财资金流解析（mock 实测响应格式）", async () => {
    const mock = vi.fn(async (url: unknown) => {
      const u = String(url);
      expect(u).toContain("push2delay.eastmoney.com");
      expect(u).toContain("secid=0.000636");
      expect(u).toContain("klt=101");
      return jsonResponse({
        rc: 0,
        data: {
          code: "000636",
          klines: ["2026-08-14,265564624.0,-48662960.0,-216901648.0,116529008.0,149035616.0"],
        },
      });
    });
    vi.stubGlobal("fetch", mock);
    const rows = await fetchFundFlow("000636.SZ", 101, { sleep: noopSleep });
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ date: "2026-08-14", main: 265564624, xlarge: 149035616 });
    vi.unstubAllGlobals();
  });

  it("扶摇目录过滤扩展指数后仍按原始页大小继续翻页", async () => {
    const timestamp = Date.parse("2026-08-18T15:40:00+08:00");
    const mock = vi.fn(async (url: unknown) => {
      const offset = Number(new URL(String(url)).searchParams.get("offset"));
      const item = offset === 0
        ? [
            { thscode: "159516.SZ", ticker: "159516", name: "半导体设备ETF国泰", asset_type: "fund-etf", exchange: "SZ" },
            { thscode: "H11077.SH", ticker: "H11077", name: "10年国债", asset_type: "a-share-index", exchange: "SH" },
          ]
        : offset === 2
          ? [
              { thscode: "159516.SZ", ticker: "159516", name: "半导体设备ETF国泰", asset_type: "fund-otc", exchange: "SZ" },
              { thscode: "399001.SZ", ticker: "399001", name: "深证成指", asset_type: "a-share-index", exchange: "SZ" },
            ]
          : [];
      return jsonResponse({ code: 0, message: "success", data: { timestamp, item } });
    });
    vi.stubGlobal("fetch", mock);
    expect(await fetchAllTickers({ assetTypes: ["a-share-index", "fund-etf", "fund-otc"], pageSize: 2 }, noWait)).toMatchObject([
      { code: "159516.SZ", assetType: "fund-etf" },
      { code: "399001.SZ" },
    ]);
    expect(mock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it("扶摇目录、板块、交易日、涨停分页和龙虎榜响应按官方字段解析", async () => {
    const timestamp = Date.parse("2026-08-18T15:40:00+08:00");
    const mock = vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      const envelope = (data: unknown) => jsonResponse({ code: 0, message: "success", data });
      if (parsed.pathname === "/api/meta/tickers/list") {
        expect(parsed.searchParams.get("asset_type")).toBe("a-share,fund-etf");
        return envelope({ timestamp, item: [
          { thscode: "600000.SH", ticker: "600000", name: "浦发银行", asset_type: "a-share", exchange: "SH", currency: "CNY" },
          { thscode: "510300.SH", ticker: "510300", name: "沪深300ETF", asset_type: "fund-etf", exchange: "SH", currency: "CNY" },
          { thscode: "000974.SH", ticker: "1B0974", name: "800金融", asset_type: "a-share-index", exchange: "SH", currency: "CNY" },
          { thscode: "H11077.SH", ticker: "H11077", name: "10年国债", asset_type: "a-share-index", exchange: "SH", currency: "CNY" },
        ] });
      }
      if (parsed.pathname === "/api/a-share/calendar/trading-days") {
        return envelope({ timestamp, item: [{ date: "20260818" }] });
      }
      if (parsed.pathname === "/api/a-share-index/catalog/ths-index-list") {
        expect(parsed.searchParams.get("tag")).toBe("cn_concept");
        return envelope({ timestamp, item: [{ thscode: "885001.TI", name: "测试概念" }] });
      }
      if (parsed.pathname === "/api/a-share-index/constituents/ths-stock-list") {
        expect(parsed.searchParams.get("thscode")).toBe("885001.TI");
        return envelope({ timestamp, item: [{ thscode: "600000.SH", ticker: "600000", name: "浦发银行" }] });
      }
      if (parsed.pathname === "/api/a-share/special-data/limit-up-pool") {
        expect(parsed.searchParams.get("page")).toBe("1");
        return envelope({ timestamp, pagination: { page: 1, pages: 1, total: 1 }, item: [{ thscode: "600000.SH" }] });
      }
      if (parsed.pathname === "/api/a-share/special-data/dragon-tiger-list") {
        expect(parsed.searchParams.get("board_type")).toBe("all");
        return envelope({ timestamp, board_type: "all", trade_date: "2026-08-18", stock_items: [], hot_money_items: [] });
      }
      throw new Error(`未预期的 URL: ${parsed}`);
    });
    vi.stubGlobal("fetch", mock);
    expect(await fetchTickerPage({ assetTypes: ["a-share", "fund-etf"] }, noWait)).toMatchObject([
      { code: "600000.SH", ticker: "600000" },
      { code: "510300.SH", ticker: "510300" },
      { code: "000974.SH", ticker: "000974" },
    ]);
    expect(await fetchTradingDays(noWait)).toEqual([{ date: "2026-08-18", sourceUpdatedAt: new Date(timestamp).toISOString() }]);
    expect(await fetchBoardCatalog("concept", noWait)).toMatchObject([{ code: "885001.TI", boardType: "concept" }]);
    expect(await fetchBoardConstituents("885001.TI", noWait)).toMatchObject([{ code: "600000.SH" }]);
    expect(HITHINK_CAPABILITIES).toHaveLength(59);
    expect(await executeHithinkCapability("board_constituents", {
      board: "测试概念",
      type: "concept",
    }, noWait)).toMatchObject({
      board_code: "885001.TI",
      board_name: "测试概念",
      item: [{ thscode: "600000.SH" }],
    });
    await expect(executeHithinkCapability("adjustment_factors", {
      code: "600000.SH",
      from: "2026-08-19",
      to: "2026-08-18",
    }, noWait)).rejects.toThrow("to 不能早于 from");
    expect(await fetchLimitPoolPage("up", { tradeDate: "2026-08-18", page: 1 }, noWait)).toMatchObject({ page: 1, pages: 1, total: 1 });
    expect(await fetchDragonTiger("all", "2026-08-18", noWait)).toMatchObject({ boardType: "all", tradeDate: "2026-08-18" });
    vi.unstubAllGlobals();
  });

  it("深交所月度日历按 jyrq/jybz 解析整月开休市，未发布月份返回 null", async () => {
    const mock = vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      expect(parsed.host).toBe("www.szse.cn");
      if (parsed.searchParams.get("month") === "2026-10") {
        return jsonResponse({ data: [
          { jyrq: "2026-10-01", jybz: "0" },
          { jyrq: "2026-10-02", jybz: "0" },
          { jyrq: "2026-10-08", jybz: "1" },
          { jyrq: "2026-10-09", jybz: "1" },
          { jyrq: "2026-10-10", jybz: "0" },
        ] });
      }
      if (parsed.searchParams.get("month") === "2027-01") return jsonResponse({ data: [], nowdate: "2026-09-28" });
      throw new Error(`未预期的 URL: ${String(url)}`);
    });
    vi.stubGlobal("fetch", mock);
    const october = await fetchSzseCalendarMonth("2026-10", { sleep: noopSleep });
    expect(october).toEqual([
      { date: "2026-10-01", isOpen: false },
      { date: "2026-10-02", isOpen: false },
      { date: "2026-10-08", isOpen: true },
      { date: "2026-10-09", isOpen: true },
      { date: "2026-10-10", isOpen: false },
    ]);
    // 次年日历未发布：空 data 视为 null 而非失败。
    expect(await fetchSzseCalendarMonth("2027-01", { sleep: noopSleep })).toBeNull();
    await expect(fetchSzseCalendarMonth("2026-13", { sleep: noopSleep })).rejects.toThrow("日历月份");
    vi.unstubAllGlobals();
    const badMonth = vi.fn(async () => jsonResponse({ data: [{ jyrq: "2026-11-01", jybz: "0" }, { jyrq: "2026-12-01", jybz: "1" }] }));
    vi.stubGlobal("fetch", badMonth);
    await expect(fetchSzseCalendarMonth("2026-11", { sleep: noopSleep })).rejects.toThrow("日历行格式异常");
    vi.unstubAllGlobals();
  });

  it("扶摇扩展能力白名单覆盖竞价、热榜/异动和基金研究端点并严格转换参数", async () => {
    expect(HITHINK_DATASET_CAPABILITIES).toHaveLength(34);
    expect(new Set(Object.values(HITHINK_DATASET_SPECS).map((spec) => spec.path)).size).toBe(34);
    const timestamp = Date.parse("2026-08-20T09:25:00+08:00");
    const mock = vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/a-share/auction/snapshot") {
        expect(parsed.searchParams.get("thscodes")).toBe("600519.SH,000001.SZ");
        expect(parsed.searchParams.get("stage")).toBe("final");
        return jsonResponse({
          code: 0,
          message: "success",
          data: {
            timestamp,
            auction_phase: "final",
            data_status: "ready",
            item: [{ thscode: "600519.SH", auction_price: 1500 }],
          },
        });
      }
      if (parsed.pathname === "/api/fund/performance/indicators-historical") {
        expect(parsed.searchParams.get("fund_type")).toBe("exchange");
        expect(parsed.searchParams.get("thscode")).toBe("510300.SH");
        expect(parsed.searchParams.get("start")).toBe(String(Date.parse("2026-01-01T00:00:00+08:00")));
        expect(parsed.searchParams.get("end")).toBe(String(Date.parse("2026-08-20T23:59:59.999+08:00")));
        return jsonResponse({
          code: 0,
          message: "success",
          data: { timestamp, item: [{ date_ms: timestamp, rsi_pct: 52.1 }] },
        });
      }
      throw new Error(`未预期的 URL: ${parsed}`);
    });
    vi.stubGlobal("fetch", mock);
    const auction = await fetchHithinkDataset({
      capability: "auction_snapshot",
      codes: ["600519.sh", "000001.SZ", "600519.SH"],
      stage: "final",
    }, noWait);
    expect(auction).toMatchObject({
      capability: "auction_snapshot",
      asOfDate: "2026-08-20",
      dataStatus: "ready",
      rowCount: 1,
      request: { codes: ["600519.SH", "000001.SZ"] },
    });
    const fund = await fetchHithinkDataset({
      capability: "fund_performance_indicators",
      fund_type: "exchange",
      code: "510300.sh",
      start: "2026-01-01",
      end: "2026-08-20",
    }, noWait);
    expect(fund).toMatchObject({ capability: "fund_performance_indicators", rowCount: 1 });
    expect(() => normalizeHithinkDatasetRequest({
      capability: "fund_profile",
      fund_type: "exchange",
      code: "510300.SH",
      period: "day",
    })).toThrow("不接受参数 period");
    expect(() => normalizeHithinkDatasetRequest({
      capability: "hot_stock_rank_trend",
      code: "600519.SH",
      start: "2025-01-01",
      end: "2026-01-02",
    })).toThrow("不能超过 1 年");
    vi.unstubAllGlobals();
  });

  it("沿海六大电厂公开归档严格解析库存、日耗和存煤可用天数", async () => {
    const list = Array.from({ length: 120 }, (_, index) => {
      const date = new Date(Date.UTC(2016, 0, 1 + index)).toISOString().slice(0, 10).replaceAll("-", "");
      return { date, datas: { "沿海六大电厂库存动态报告": [String(1100 + index), "60", "18.5"] } };
    });
    const fetcher = vi.fn(async () => ({
      ok: true, status: 200, text: async () => `var dataCenter_data = ${JSON.stringify({
        kinds: ["沿海六大电库存", "日耗", "存煤可用天数"], list,
      })};`,
    } as Response));
    const rows = await fetchCoastalPowerCoalHistory({ fetch: fetcher });
    expect(rows).toHaveLength(120);
    expect(rows[0]).toEqual({
      date: "2016-01-01", inventoryTenThousandTonnes: 1100,
      dailyConsumptionTenThousandTonnes: 60, availableDays: 18.5,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("扶摇标的目录识别公募 REITs", async () => {
    const timestamp = Date.parse("2026-08-20T07:00:00+08:00");
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get("asset_type")).toBe("fund-reits");
      return jsonResponse({
        code: 0,
        message: "success",
        data: {
          timestamp,
          item: [{
            thscode: "180101.SZ",
            ticker: "180101",
            name: "测试公募REIT",
            asset_type: "fund-reits",
            exchange: "SZ",
          }],
        },
      });
    }));
    expect(await fetchTickerPage({ assetTypes: ["fund-reits"] }, noWait)).toMatchObject([
      { code: "180101.SZ", assetType: "fund-reits" },
    ]);
    vi.unstubAllGlobals();
  });
});

// ---------- 数据库用例（stock_test；无库时整体 skip） ----------

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("datasource 服务（stock_test）", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await pool.end();
  });

  it("扶摇扩展数据按规范化请求幂等缓存并记录 fetch run", async () => {
    let unitNav = 1.1;
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/api/fund/profile/detail");
      expect(parsed.searchParams.get("fund_type")).toBe("reits");
      expect(parsed.searchParams.get("thscode")).toBe("180101.SZ");
      return jsonResponse({
        code: 0,
        message: "success",
        data: {
          timestamp: Date.parse("2026-08-20T15:00:00+08:00"),
          item: [{ thscode: "180101.SZ", fund_name: "测试公募REIT", unit_nav: unitNav }],
        },
      });
    }));
    const request = { capability: "fund_profile", fund_type: "reits", code: "180101.SZ" } as const;
    const first = await fetchHithinkDatasetAndStore(pool, request, noWait);
    unitNav = 1.2;
    const second = await fetchHithinkDatasetAndStore(pool, request, noWait);
    expect(second.snapshotId).toBe(first.snapshotId);
    const stored = await pool.query<{ count: number; unit_nav: number }>(
      `SELECT count(*)::int AS count,
              max((payload->'item'->0->>'unit_nav')::numeric)::float8 AS unit_nav
         FROM hithink_dataset_snapshot WHERE capability = 'fund_profile'`,
    );
    expect(stored.rows[0]).toEqual({ count: 1, unit_nav: 1.2 });
    const runs = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM market_fetch_run
        WHERE scope->>'pipeline' = 'hithink_dataset' AND scope->>'capability' = 'fund_profile'`,
    );
    expect(runs.rows[0]!.count).toBe(2);
    vi.unstubAllGlobals();
  });

  it("通道选择：日线请求路由到 hithink（fuyao 域名）", async () => {
    const dates = ["2026-08-12", "2026-08-13", "2026-08-14"];
    const mock = vi.fn(async (url: unknown) => {
      const u = String(url);
      expect(u).toContain("fuyao.aicubes.cn/api/a-share/prices/historical");
      return jsonResponse(klinePayload(dates, [10, 11, 12]));
    });
    vi.stubGlobal("fetch", mock);
    const outcome = await fetchAndStore(
      pool,
      { code: "000636.SZ", freq: "day", start: "2026-08-12", end: "2026-08-14" },
      { channels: [new HithinkChannel(noWait)] },
    );
    expect(outcome.channel).toBe("hithink");
    expect(outcome.degradedFrom).toBeUndefined();
    expect(outcome.rowsWritten).toBe(3);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("幂等 upsert：同一窗口重复拉取不重复建行", async () => {
    const dates = ["2026-08-12", "2026-08-13", "2026-08-14"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(klinePayload(dates, [10, 11, 12]))),
    );
    const req: FetchRequest = {
      code: "000636.SZ",
      freq: "day",
      start: "2026-08-12",
      end: "2026-08-14",
    };
    await fetchAndStore(pool, req, { channels: [new HithinkChannel(noWait)] });
    await fetchAndStore(pool, req, { channels: [new HithinkChannel(noWait)] });
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM market_bar mb
       JOIN market_instrument i ON i.id = mb.instrument_id
       WHERE i.code = '000636.SZ' AND mb.freq = 'day'`,
    );
    expect(r.rows[0]!.n).toBe(3);
  });

  it("财务与估值直连扶摇并按共同报告期幂等落库", async () => {
    const reportPeriodMs = Date.parse("2025-12-31T00:00:00+08:00");
    const reportDateMs = Date.parse("2026-03-31T00:00:00+08:00");
    const valuationDateMs = Date.parse("2026-08-18T15:00:00+08:00");
    const mock = vi.fn(async (url: unknown) => {
      const value = String(url);
      const common = {
        thscode: "600519.SH",
        period: "quarterly",
        fiscal_year: 2025,
        fiscal_period: "Q4",
        report_date_ms: reportDateMs,
        period_end_ms: reportPeriodMs,
      };
      if (value.includes("/valuations/snapshot")) {
        return jsonResponse({
          code: 0,
          data: {
            timestamp: valuationDateMs,
            item: [{ thscode: "600519.SH", name: "贵州茅台", pe_ttm: 20, pb_mrq: 7, ps_ttm: 10, pcf_ttm: 18 }],
          },
        });
      }
      if (value.includes("/income-statements")) {
        return jsonResponse({ code: 0, data: { item: [{ ...common, operating_income: 1000, operating_costs: 400, net_profit: 200 }] } });
      }
      if (value.includes("/balance-sheets")) {
        return jsonResponse({ code: 0, data: { item: [{ ...common, assets_total: 2000, total_debt: 500, holder_equity_total: 1000 }] } });
      }
      if (value.includes("/cash-flow-statements")) {
        return jsonResponse({ code: 0, data: { item: [{ ...common, act_cash_flow_net: 180 }] } });
      }
      throw new Error(`未预期的扶摇 URL：${value}`);
    });
    vi.stubGlobal("fetch", mock);
    const first = await fetchFinancialAndStore(pool, { code: "600519.SH" }, { hithinkDeps: noWait });
    const second = await fetchFinancialAndStore(pool, { code: "600519.SH" }, { hithinkDeps: noWait });
    expect(first).toMatchObject({ status: "success", valuationRows: 1, fundamentalRows: 1, rowsWritten: 2 });
    expect(second).toMatchObject({ status: "success", rowsWritten: 2 });
    const valuation = await pool.query(
      `SELECT pe_ttm::float, pb::float, ps_ttm::float, as_of_date::text
         FROM valuation_snapshot v JOIN market_instrument i ON i.id = v.instrument_id
        WHERE i.code = '600519.SH'`,
    );
    expect(valuation.rows).toEqual([{ pe_ttm: 20, pb: 7, ps_ttm: 10, as_of_date: "2026-08-18" }]);
    const fundamental = await pool.query(
      `SELECT revenue::float, net_profit::float, operating_cashflow::float,
              roe::float, gross_margin::float, debt_ratio::float, report_period::text
         FROM fundamental_snapshot f JOIN market_instrument i ON i.id = f.instrument_id
        WHERE i.code = '600519.SH'`,
    );
    expect(fundamental.rows).toEqual([{
      revenue: 1000,
      net_profit: 200,
      operating_cashflow: 180,
      roe: 20,
      gross_margin: 60,
      debt_ratio: 25,
      report_period: "2025-12-31",
    }]);
    expect(mock).toHaveBeenCalledTimes(8);
  });

  it("商品期货点时数据通过领域服务幂等保存且历史修订不被覆盖", async () => {
    await upsertFuturesContract(pool, {
      code: "CU0", name: "沪铜主力", exchange: "SHFE", commodityCode: "CU",
      contractKind: "main_continuous", multiplier: 5, priceUnit: "人民币/吨", currency: "CNY", source: "test",
    });
    await upsertFuturesContract(pool, {
      code: "CU2610", name: "沪铜2610", exchange: "SHFE", commodityCode: "CU",
      contractKind: "listed", contractMonth: "202610", multiplier: 5, priceUnit: "人民币/吨",
      currency: "CNY", lastTradeDate: "2026-10-15", source: "test",
    });
    await storeFuturesDailyDetail(pool, {
      code: "CU2610", tradeDate: "2026-09-14", settlement: 80120, prevSettlement: 79800,
      openInterest: 123456, upperLimit: 86000, lowerLimit: 74000, source: "test",
    });
    await storeFuturesRoll(pool, {
      continuousCode: "CU0", underlyingCode: "CU2610", tradeDate: "2026-09-14",
      methodCode: "open_interest_v1", adjustmentFactor: 1, source: "test",
    });

    await upsertMarketFactorSeries(pool, {
      seriesCode: "test.cu.inventory.total", commodityCode: "CU", market: "SHFE", metricCode: "inventory",
      frequency: "weekly", unit: "吨", source: "SHFE", revisionPolicy: "revisable",
    });
    const firstObservation = await storeMarketFactorObservation(pool, {
      seriesCode: "test.cu.inventory.total", periodStart: "2026-09-07", periodEnd: "2026-09-11",
      publishedAt: "2026-09-11T15:30:00+08:00", value: 98765, sourceRef: "test://shfe/2026-09-11",
    });
    expect(await storeMarketFactorObservation(pool, {
      seriesCode: "test.cu.inventory.total", periodStart: "2026-09-07", periodEnd: "2026-09-11",
      publishedAt: "2026-09-11T15:30:00+08:00", value: 98765, sourceRef: "test://shfe/2026-09-11",
    })).toBe(firstObservation);
    await expect(storeMarketFactorObservation(pool, {
      seriesCode: "test.cu.inventory.total", periodStart: "2026-09-07", periodEnd: "2026-09-11",
      publishedAt: "2026-09-11T15:30:00+08:00", value: 1, sourceRef: "test://shfe/2026-09-11",
    })).rejects.toThrow("已存在不同值");
    await storeMarketFactorObservation(pool, {
      seriesCode: "test.cu.inventory.total", periodStart: "2026-09-07", periodEnd: "2026-09-11",
      publishedAt: "2026-09-12T09:00:00+08:00", revisionNo: 1, value: 98760, sourceRef: "test://shfe/revision",
    });

    await ensureInstrument(pool, "600362.SH", "江西铜业", "day");
    const profileId = await storeCompanyCommodityProfile(pool, {
      code: "600362.SH", commodityCode: "CU", role: "integrated", effectiveFrom: "2025-01-01",
      publishedAt: "2026-03-30T18:00:00+08:00", sourceRef: "test://filing/profile",
    });
    expect(await storeCompanyCommodityProfile(pool, {
      code: "600362.SH", commodityCode: "CU", role: "integrated", effectiveFrom: "2025-01-01",
      publishedAt: "2026-03-30T18:00:00+08:00", sourceRef: "test://filing/profile",
    })).toBe(profileId);
    const metricId = await storeCompanyCommodityMetric(pool, {
      code: "600362.SH", commodityCode: "CU", reportPeriod: "2025-12-31",
      publishedAt: "2026-03-30T18:00:00+08:00", metricCode: "equity_production",
      value: 20.5, unit: "万吨", sourceRef: "test://filing/metric",
    });
    expect(await storeCompanyCommodityMetric(pool, {
      code: "600362.SH", commodityCode: "CU", reportPeriod: "2025-12-31",
      publishedAt: "2026-03-30T18:00:00+08:00", metricCode: "equity_production",
      value: 20.5, unit: "万吨", sourceRef: "test://filing/metric",
    })).toBe(metricId);
    await expect(storeCompanyCommodityMetric(pool, {
      code: "600362.SH", commodityCode: "CU", reportPeriod: "2025-12-31",
      publishedAt: "2026-03-30T18:00:00+08:00", metricCode: "equity_production",
      value: 99, unit: "万吨", sourceRef: "test://filing/metric",
    })).rejects.toThrow("已存在不同值");

    const fetchRunId = await recordCommodityFetchRun(pool, {
      channel: "test", scope: { commodity: "CU", date: "2026-09-14" }, rowsWritten: 7,
    });
    const stored = await pool.query<{ contracts: number; observations: number; profiles: number; metrics: number; pipeline: string }>(
      `SELECT
         (SELECT count(*)::int FROM market_futures_contract) AS contracts,
         (SELECT count(*)::int FROM market_factor_observation) AS observations,
         (SELECT count(*)::int FROM company_commodity_profile) AS profiles,
         (SELECT count(*)::int FROM company_commodity_metric) AS metrics,
         (SELECT scope->>'pipeline' FROM market_fetch_run WHERE id=$1) AS pipeline`,
      [fetchRunId],
    );
    expect(stored.rows[0]).toEqual({ contracts: 2, observations: 2, profiles: 1, metrics: 1, pipeline: "commodity_research" });
  });

  it("上期所官方日行情过滤小计并保存真实合约、结算持仓和主力映射", async () => {
    const payload = {
      report_date: "20260915",
      o_curinstrument: [
        { PRODUCTID: "cu_f    ", PRODUCTNAME: "铜", DELIVERYMONTH: "2609", OPENPRICE: 80000,
          HIGHESTPRICE: 81000, LOWESTPRICE: 79500, CLOSEPRICE: 80500, SETTLEMENTPRICE: 80300,
          PRESETTLEMENTPRICE: 79800, VOLUME: 2000, OPENINTEREST: 3000, OPENINTERESTCHG: -100, TURNOVER: 123 },
        { PRODUCTGROUPID: "cu", PRODUCTNAME: "铜", DELIVERYMONTH: "2610", OPENPRICE: 80100,
          HIGHESTPRICE: 81200, LOWESTPRICE: 80000, CLOSEPRICE: 81000, SETTLEMENTPRICE: 80800,
          PRESETTLEMENTPRICE: 79900, VOLUME: 5000, OPENINTEREST: 9000, OPENINTERESTCHG: 200, TURNOVER: 456 },
        { PRODUCTGROUPID: "cu", PRODUCTNAME: "铜", DELIVERYMONTH: "小计", OPENPRICE: "",
          HIGHESTPRICE: "", LOWESTPRICE: "", CLOSEPRICE: "", SETTLEMENTPRICE: "",
          PRESETTLEMENTPRICE: "", VOLUME: 7000, OPENINTEREST: 12000 },
        { PRODUCTGROUPID: "al", PRODUCTNAME: "铝", DELIVERYMONTH: "2610", OPENPRICE: 20000,
          HIGHESTPRICE: 20100, LOWESTPRICE: 19900, CLOSEPRICE: 20050, SETTLEMENTPRICE: 20020,
          PRESETTLEMENTPRICE: 19980, VOLUME: 100, OPENINTEREST: 200 },
      ],
    };
    const mockedFetch = vi.fn(async () => jsonResponse(payload));
    expect(await fetchShfeDailyContracts("2026-09-15", "CU", { fetch: mockedFetch, sleep: noopSleep })).toHaveLength(2);
    const result = await syncShfeFuturesDaily(pool, "2026-09-15", "CU", { fetch: mockedFetch, sleep: noopSleep });
    expect(result).toMatchObject({ contractCount: 2, mainContractCode: "CU2610", gaps: [] });
    const stored = await pool.query<{ code: string; close: number; settlement: number; open_interest: number }>(
      `SELECT instrument.code,bar.close::float8,detail.settlement::float8,detail.open_interest::float8
         FROM market_futures_daily_detail detail
         JOIN market_instrument instrument ON instrument.id=detail.instrument_id
         JOIN market_bar bar ON bar.instrument_id=detail.instrument_id AND bar.freq='futures_day'
          AND bar.bar_date=detail.trade_date
        WHERE detail.trade_date='2026-09-15' ORDER BY instrument.code`,
    );
    expect(stored.rows).toEqual([
      { code: "CU2609", close: 80500, settlement: 80300, open_interest: 3000 },
      { code: "CU2610", close: 81000, settlement: 80800, open_interest: 9000 },
    ]);
    expect((await pool.query(
      `SELECT continuous.code AS continuous_code,underlying.code AS underlying_code,roll.method_code
         FROM market_futures_roll roll
         JOIN market_instrument continuous ON continuous.id=roll.continuous_instrument_id
         JOIN market_instrument underlying ON underlying.id=roll.underlying_instrument_id
        WHERE roll.trade_date='2026-09-15'`,
    )).rows).toEqual([{ continuous_code: "CU0", underlying_code: "CU2610", method_code: "open_interest_v1" }]);
    vi.unstubAllGlobals();
  });

  it("铜宏观因子按月频可获得时间落库并保持幂等", async () => {
    const csv = [
      "REF_AREA,TIME_PERIOD,OBS_VALUE,OBS_STATUS",
      ...["2026-01","2026-02","2026-03","2026-04","2026-05","2026-06"].flatMap((month, index) => [
        `G7,${month},${99.5 + index / 10},A`,
        `CHN,${month},${98.5 + index / 10},A`,
      ]),
    ].join("\n");
    const fetchImpl = vi.fn(async () => textResponse(csv));
    const first = await syncCopperMacroFactors(pool, "2026-09-20", { fetchImpl: fetchImpl as typeof fetch, now: new Date("2026-09-20T10:00:00Z") });
    const second = await syncCopperMacroFactors(pool, "2026-09-20", { fetchImpl: fetchImpl as typeof fetch, now: new Date("2026-09-20T10:00:00Z") });
    expect(first).toMatchObject({ rowsWritten: 12, gaps: [] });
    expect(second).toMatchObject({ rowsWritten: 0, gaps: [] });
    const stored = await pool.query<{ code: string; count: number }>(
      `SELECT series.series_code code,count(*)::int count FROM market_factor_observation observation
       JOIN market_factor_series series ON series.id=observation.series_id
       WHERE series.series_code=ANY($1::text[]) GROUP BY series.series_code ORDER BY series.series_code`,
      [["oecd.g7.cli","oecd.chn.cli"]],
    );
    expect(stored.rows).toEqual([
      { code: "oecd.chn.cli", count: 6 }, { code: "oecd.g7.cli", count: 6 },
    ]);
  });

  it("上期所铜库存周报兼容历史JSON和当前HTML并按发布时间落库", async () => {
    const legacy = {
      o_tradingday: "20260911", o_issueno: "35", update_date: "20260911 16:20:00",
      o_cursor: [{
        VARID: "cu", VARNAME: "铜$$COPPER", WHABBRNAME: "总计$$Total",
        PRESPOTWGHTS: 63000, PREWRTWGHTS: 25781, SPOTWGHTS: 54780, WRTWGHTS: 20854,
      }],
    };
    const legacyFetch = vi.fn(async () => jsonResponse(legacy));
    const parsed = await fetchShfeCopperWeeklyInventory("2026-09-11", { fetch: legacyFetch });
    expect(parsed).toMatchObject({
      inventory: 54780, previousInventory: 63000, warehouseWarrant: 20854,
      publishedAt: "2026-09-11T16:20:00+08:00",
    });
    const synced = await syncShfeCopperWeeklyInventory(pool, "2026-09-11", { fetch: legacyFetch });
    expect(synced).toMatchObject({ inventory: 54780, previousInventory: 63000, rowsWritten: 1, gaps: [] });
    const stored = await pool.query<{ value: number; published_at: string; source_ref: string }>(
      `SELECT observation.value::float8,observation.published_at::text,observation.source_ref
         FROM market_factor_observation observation
         JOIN market_factor_series series ON series.id=observation.series_id
        WHERE series.series_code='shfe.cu.inventory.total'`,
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.value).toBe(54780);
    expect(stored.rows[0]!.source_ref).toContain("20260911weeklystock.dat");

    const html = `<html><body>2026-09-12<table><tr class="special_row_type"><td><div class="cell">铜</div></td><td>单位：吨</td></tr>
      <tr class="isTotal"><td colspan="2">总计</td><td>54,780</td><td>20,854</td><td>60,000</td><td>25,000</td><td>5,220</td><td>4,146</td></tr>
      <tr class="special_row_type"><td><div class="cell">铝</div></td></tr></table></body></html>`;
    let calls = 0;
    const htmlFetch = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? ({ status: 404, text: async () => "not found" } as Response)
        : ({ status: 200, text: async () => html } as Response);
    });
    expect(await fetchShfeCopperWeeklyInventory("2026-09-12", { fetch: htmlFetch })).toMatchObject({
      previousInventory: 54780, previousWarehouseWarrant: 20854, inventory: 60000, warehouseWarrant: 25000,
    });
  });

  it("MA5/10/20/60 补算：构造 61 根等差收盘价验证数值，窗口不足留空", async () => {
    // 61 个连续自然日（测试不关心是否真实交易日），收盘价 1..61
    const dates: string[] = [];
    const closes: number[] = [];
    for (let i = 60; i >= 0; i--) {
      const t = Date.parse("2026-08-14T00:00:00Z") - i * 86400_000;
      dates.push(new Date(t).toISOString().slice(0, 10));
      closes.push(61 - i);
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(klinePayload(dates, closes))),
    );
    await fetchAndStore(
      pool,
      { code: "000001.SH", freq: "day", start: dates[0]!, end: dates[60]! },
      { channels: [new HithinkChannel(noWait)] },
    );
    const last = await pool.query<Record<string, string | null>>(
      `SELECT ma5::float8 AS ma5, ma10::float8 AS ma10, ma20::float8 AS ma20, ma60::float8 AS ma60
       FROM market_bar mb JOIN market_instrument i ON i.id = mb.instrument_id
       WHERE i.code = '000001.SH' AND mb.freq = 'day' AND mb.bar_date = $1`,
      [dates[60]],
    );
    // 收盘 1..61：MA5=(57+58+59+60+61)/5=59，MA10=56.5，MA20=51.5，MA60=31.5
    expect(Number(last.rows[0]!.ma5)).toBeCloseTo(59, 9);
    expect(Number(last.rows[0]!.ma10)).toBeCloseTo(56.5, 9);
    expect(Number(last.rows[0]!.ma20)).toBeCloseTo(51.5, 9);
    expect(Number(last.rows[0]!.ma60)).toBeCloseTo(31.5, 9);
    const first = await pool.query<Record<string, string | null>>(
      `SELECT ma5, ma20 FROM market_bar mb JOIN market_instrument i ON i.id = mb.instrument_id
       WHERE i.code = '000001.SH' AND mb.freq = 'day' AND mb.bar_date = $1`,
      [dates[0]],
    );
    expect(first.rows[0]!.ma5).toBeNull();
    expect(first.rows[0]!.ma20).toBeNull();
  });

  it("降级留痕：高优先级通道失败后降级并写 market_fetch_run.degraded_from", async () => {
    const failing: Channel = {
      name: "fake-primary",
      supports: () => true,
      fetch: async () => {
        throw new Error("模拟主通道失败");
      },
    };
    const backup: Channel = {
      name: "fake-secondary",
      supports: () => true,
      fetch: async () => makeBars(["2026-08-14"]),
    };
    const outcome = await fetchAndStore(
      pool,
      { code: "600000.SH", freq: "day", start: "2026-08-14", end: "2026-08-14" },
      { channels: [failing, backup] },
    );
    expect(outcome.channel).toBe("fake-secondary");
    expect(outcome.degradedFrom).toBe("fake-primary");
    const run = await pool.query<{ degraded_from: string | null; rows_written: number }>(
      "SELECT degraded_from, rows_written FROM market_fetch_run WHERE id = $1",
      [outcome.fetchRunId],
    );
    expect(run.rows[0]!.degraded_from).toBe("fake-primary");
    expect(run.rows[0]!.rows_written).toBe(1);
  });

  it("全部通道失败：写 market_fetch_run（gaps 留痕、0 行）后抛错", async () => {
    const failing: Channel = {
      name: "fake-only",
      supports: () => true,
      fetch: async () => {
        throw new Error("模拟失败");
      },
    };
    await expect(
      fetchAndStore(
        pool,
        { code: "000063.SZ", freq: "day", start: "2026-08-14", end: "2026-08-14" },
        { channels: [failing] },
      ),
    ).rejects.toThrow("全部通道失败");
    const run = await pool.query<{ rows_written: number; gaps: unknown[]; scope: { instruments: string[] } }>(
      `SELECT rows_written, gaps, scope FROM market_fetch_run
       WHERE scope->'instruments' = '["000063.SZ"]'::jsonb ORDER BY id DESC LIMIT 1`,
    );
    expect(run.rows[0]!.rows_written).toBe(0);
    expect(run.rows[0]!.gaps.length).toBe(1);
  });

  it("market_fetch_run 记录：scope/rows_written/channel 与请求一致", async () => {
    const dates = ["2026-08-14"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(klinePayload(dates, [10]))),
    );
    const outcome = await fetchAndStore(
      pool,
      { code: "399001.SZ", freq: "day", start: "2026-08-14", end: "2026-08-14" },
      { channels: [new HithinkChannel(noWait)] },
    );
    const run = await pool.query<{
      channel: string;
      rows_written: number;
      scope: { instruments: string[]; freq: string; range: { start: string; end: string } };
      gaps: unknown[];
      finished_at: string | null;
    }>("SELECT channel, rows_written, scope, gaps, finished_at FROM market_fetch_run WHERE id = $1", [
      outcome.fetchRunId,
    ]);
    const row = run.rows[0]!;
    expect(row.channel).toBe("hithink");
    expect(row.rows_written).toBe(1);
    expect(row.scope.instruments).toEqual(["399001.SZ"]);
    expect(row.scope.freq).toBe("day");
    expect(row.scope.range).toEqual({ start: "2026-08-14", end: "2026-08-14" });
    expect(row.gaps).toEqual([]);
    expect(row.finished_at).not.toBeNull();
  });

  it("30m 与期货请求路由到 sina 通道，30m 落库存实际时刻", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes("quotes.sina.cn")) {
          expect(u).toContain("symbol=sz000636");
          expect(u).toContain("scale=30");
          return textResponse(sina30mText(["2026-08-14 14:30:00", "2026-08-14 15:00:00"]));
        }
        if (u.includes("stock2.finance.sina.com.cn")) {
          expect(u).toContain("symbol=CU0");
          return textResponse(sinaFuturesText(["2026-08-13", "2026-08-14"]));
        }
        throw new Error(`未预期的 URL: ${u}`);
      }),
    );
    const deps = { akshareDeps: { sleep: noopSleep } };
    const m30 = await fetchAndStore(
      pool,
      { code: "000636.SZ", freq: "30m", start: "2026-08-14", end: "2026-08-14" },
      deps,
    );
    expect(m30.channel).toBe("sina");
    expect(m30.rowsWritten).toBe(2);
    const t = await pool.query<{ bt: string }>(
      `SELECT to_char(bar_time AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS bt
       FROM market_bar mb JOIN market_instrument i ON i.id = mb.instrument_id
       WHERE i.code = '000636.SZ' AND mb.freq = '30m' ORDER BY bar_time DESC LIMIT 1`,
    );
    // 15:00 CST = 07:00 UTC
    expect(t.rows[0]!.bt).toBe("2026-08-14 07:00:00");

    const fut = await fetchAndStore(
      pool,
      { code: "CU0", freq: "futures_day", start: "2026-08-13", end: "2026-08-14" },
      deps,
    );
    expect(fut.channel).toBe("sina");
    expect(fut.rowsWritten).toBe(2);
    const ft = await pool.query<{ bt: string }>(
      `SELECT to_char(bar_time AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS bt
       FROM market_bar mb JOIN market_instrument i ON i.id = mb.instrument_id
       WHERE i.code = 'CU0' AND mb.freq = 'futures_day' AND mb.bar_date = '2026-08-14'`,
    );
    // futures_day 的 bar_time 存当日 00:00:00Z（T6）
    expect(ft.rows[0]!.bt).toBe("2026-08-14 00:00:00");
  });

  it("dailyMarketUpdate 链路：快照追加（无历史→kline 重拉）→ MA → 期货 → 30 分钟", async () => {
    const klineDates = [
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes("/api/a-share/prices/snapshot")) {
          return jsonResponse(snapshotPayload("002594.SZ", "2026-08-14", 13));
        }
        if (u.includes("/api/a-share/prices/historical")) {
          return jsonResponse(klinePayload(klineDates, [10, 11, 12, 13, 14]));
        }
        if (u.includes("quotes.sina.cn")) {
          return textResponse(sina30mText(["2026-08-14 15:00:00"]));
        }
        if (u.includes("stock2.finance.sina.com.cn")) {
          return textResponse(sinaFuturesText(["2026-08-14"]));
        }
        throw new Error(`未预期的 URL: ${u}`);
      }),
    );
    const summary = await dailyMarketUpdate(
      pool,
      {
        codes: ["002594.SZ"],
        futures: ["CU1"],
        minute30: ["002594.SZ"],
        date: "2026-08-14",
      },
      { hithinkDeps: noWait, akshareDeps: { sleep: noopSleep } },
    );
    expect(summary.gaps).toEqual([]);
    expect(summary.refetched).toEqual(["002594.SZ"]); // 无既有日线触发初始化重拉
    expect(summary.snapshotRows).toBe(5);
    expect(summary.futuresRows).toBe(1);
    expect(summary.minute30Rows).toBe(1);
    expect(summary.fetchRunIds.length).toBeGreaterThanOrEqual(4); // 快照/重拉/期货/30m 各留痕
    const day = await pool.query<{ n: number; ma5: string | null }>(
      `SELECT count(*)::int AS n,
              (SELECT ma5::float8 FROM market_bar mb2 JOIN market_instrument i2 ON i2.id = mb2.instrument_id
               WHERE i2.code = '002594.SZ' AND mb2.freq = 'day' AND mb2.bar_date = '2026-08-14') AS ma5
       FROM market_bar mb JOIN market_instrument i ON i.id = mb.instrument_id
       WHERE i.code = '002594.SZ' AND mb.freq = 'day'`,
    );
    expect(day.rows[0]!.n).toBe(5);
    // 收盘 10..14 → MA5 = 12
    expect(Number(day.rows[0]!.ma5)).toBeCloseTo(12, 9);
  });

  it("dailyMarketUpdate 按交易日历回补中间缺口且不把周末当缺口", async () => {
    const targetDate = "2026-09-07";
    const missingCode = "600093.SH";
    const continuousCode = "600094.SH";
    await pool.query(
      `INSERT INTO market_trading_day (trade_date, is_open, source) VALUES
         ('2026-09-03', true, 'test'),
         ('2026-09-04', true, 'test'),
         ($1, true, 'test')
       ON CONFLICT (trade_date) DO UPDATE SET is_open = EXCLUDED.is_open`,
      [targetDate],
    );
    for (const [code, previousDate] of [[missingCode, "2026-09-03"], [continuousCode, "2026-09-04"]] as const) {
      const instrument = await pool.query<{ id: string }>(
        `INSERT INTO market_instrument (code, name, kind) VALUES ($1, $1, 'stock')
         ON CONFLICT (code) DO UPDATE SET kind = 'stock' RETURNING id::text`,
        [code],
      );
      await pool.query(
        `INSERT INTO market_bar
           (instrument_id, freq, bar_date, bar_time, open, high, low, close, volume, channel)
         VALUES ($1, 'day', $2, $3, 10, 11, 9, 10, 1000, 'test')`,
        [instrument.rows[0]!.id, previousDate, `${previousDate}T00:00:00Z`],
      );
    }
    const fetchMock = vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/a-share/prices/snapshot") {
        return jsonResponse({
          code: 0,
          message: "success",
          data: {
            timestamp: Date.parse(`${targetDate}T15:05:00+08:00`),
            item: [missingCode, continuousCode].map((code) => ({
              thscode: code,
              open_price: 10,
              high_price: 12,
              low_price: 9,
              last_price: 11,
              prev_price: code === missingCode ? 10.5 : 10,
              volume: 1000,
            })),
          },
        });
      }
      if (parsed.pathname === "/api/a-share/prices/historical") {
        expect(parsed.searchParams.get("thscode")).toBe(missingCode);
        return jsonResponse(klinePayload(["2026-09-04", targetDate], [10.5, 11]));
      }
      throw new Error(`未预期的 URL: ${parsed}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await dailyMarketUpdate(
      pool,
      { codes: [missingCode, continuousCode], date: targetDate },
      { hithinkDeps: noWait },
    );

    expect(summary.gaps).toEqual([]);
    expect(summary.refetched).toEqual([missingCode]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/historical"))).toHaveLength(1);
    expect(Number((await pool.query(
      `SELECT count(*) FROM market_bar bar JOIN market_instrument instrument ON instrument.id = bar.instrument_id
        WHERE instrument.code = $1 AND bar.freq = 'day' AND bar.bar_date = '2026-09-04'`,
      [missingCode],
    )).rows[0]!.count)).toBe(1);
  });

  it("dailyMarketUpdate 历史目标日跳过快照并只补目标日缺口", async () => {
    const targetDate = "2026-08-20";
    const fetchMock = vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/snapshot")) throw new Error("历史模式不应请求快照");
      if (parsed.pathname === "/api/a-share/prices/historical") {
        return jsonResponse(klinePayload([targetDate], [10]));
      }
      throw new Error(`未预期的 URL: ${parsed}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await dailyMarketUpdate(
      pool,
      { codes: ["000636.SZ"], date: targetDate, dayMode: "historical" },
      { hithinkDeps: noWait },
    );

    expect(summary.gaps).toEqual([]);
    expect(summary.refetched).toEqual(["000636.SZ"]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/snapshot"))).toBe(false);
    expect(Number((await pool.query(
      `SELECT count(*) FROM market_bar b JOIN market_instrument i ON i.id = b.instrument_id
        WHERE i.code = '000636.SZ' AND b.freq = 'day' AND b.bar_date = $1 AND b.close > 0`,
      [targetDate],
    )).rows[0]!.count)).toBe(1);
  });

  it("dailyMarketUpdate 快照日期错配时记缺口并跳过，不放大为历史请求", async () => {
    const targetDate = "2026-08-20";
    const observedDate = "2026-08-21";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === "/api/a-share/prices/snapshot") {
          return jsonResponse(snapshotPayload("000333.SZ", observedDate, 11));
        }
        throw new Error(`未预期的 URL: ${parsed}`);
      }),
    );

    const summary = await dailyMarketUpdate(
      pool,
      { codes: ["000333.SZ"], date: targetDate },
      { hithinkDeps: noWait },
    );

    expect(summary.gaps).toEqual([
      { code: "000333.SZ", freq: "day", reason: `快照交易日 ${observedDate} 与目标日 ${targetDate} 不一致` },
    ]);
    expect(summary.refetched).toEqual([]);
    const stored = await pool.query<{ bar_date: string }>(
      `SELECT bar_date::text FROM market_bar b JOIN market_instrument i ON i.id = b.instrument_id
        WHERE i.code = '000333.SZ' AND b.freq = 'day' ORDER BY bar_date`,
    );
    expect(stored.rows).toEqual([]);
  });

  it("dailyMarketUpdate 将板块与指数同组持久化，坏标的单独跳过", async () => {
    const targetDate = "2026-08-18";
    const previousDate = "2026-08-17";
    const assets = [
      { code: "600000.SH", name: "测试股票", kind: "stock" },
      { code: "000300.SH", name: "测试指数", kind: "index" },
      { code: "889999.TI", name: "测试板块", kind: "board" },
      { code: "159516.SZ", name: "测试ETF", kind: "etf" },
    ] as const;
    for (const asset of assets) {
      const instrument = await pool.query<{ id: string }>(
        `INSERT INTO market_instrument (code, name, kind) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind
         RETURNING id::text`,
        [asset.code, asset.name, asset.kind],
      );
      await pool.query(
        `INSERT INTO market_bar
           (instrument_id, freq, bar_date, bar_time, open, high, low, close, volume, channel)
         VALUES ($1, 'day', $2, $3, 10, 11, 9, 10, 1000, 'test')
         ON CONFLICT (instrument_id, freq, bar_date, bar_time) DO UPDATE SET close = 10`,
        [instrument.rows[0]!.id, previousDate, `${previousDate}T00:00:00Z`],
      );
    }

    const fetchMock = vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/a-share/prices/snapshot") {
        expect(parsed.searchParams.get("thscodes")).toBe("600000.SH");
        return jsonResponse(snapshotPayload("600000.SH", targetDate, 10));
      }
      if (parsed.pathname === "/api/a-share-index/prices/snapshot") {
        expect(parsed.searchParams.get("thscodes")).toBe("000300.SH,889999.TI");
        return jsonResponse({
          code: 0,
          message: "success",
          data: {
            timestamp: Date.parse(`${targetDate}T15:05:00+08:00`),
            item: [
              { thscode: "000300.SH", open_price: 10, high_price: 12, low_price: 9, last_price: 11, prev_price: 10 },
              { thscode: "889999.TI", open_price: 0, high_price: 0, low_price: 0, last_price: 0, prev_price: 10 },
            ],
          },
        });
      }
      if (parsed.pathname === "/api/fund/market/snapshot") {
        expect(parsed.searchParams.get("thscode")).toBe("159516.SZ");
        return jsonResponse(snapshotPayload("159516.SZ", targetDate, 10));
      }
      throw new Error(`未预期的 URL: ${parsed}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await dailyMarketUpdate(
      pool,
      { codes: assets.map((asset) => asset.code), date: targetDate },
      { hithinkDeps: noWait },
    );
    expect(summary.gaps).toEqual([
      { code: "889999.TI", freq: "day", reason: "快照存在非正或非有限 OHLC" },
    ]);
    expect(summary.refetched).toEqual([]);
    expect(summary.snapshotRows).toBe(3);
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname).filter((path) => path.endsWith("/snapshot")))
      .toEqual([
        "/api/a-share/prices/snapshot",
        "/api/a-share-index/prices/snapshot",
        "/api/fund/market/snapshot",
      ]);
    const stored = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM market_bar b JOIN market_instrument i ON i.id = b.instrument_id
        WHERE i.code = ANY($1::text[]) AND b.freq = 'day' AND b.bar_date = $2`,
      [assets.map((asset) => asset.code), targetDate],
    );
    expect(stored.rows[0]!.count).toBe(3);
    const degraded = await pool.query<{ gaps: unknown[] }>(
      `SELECT gaps FROM market_fetch_run
        WHERE scope->>'op' = 'snapshot' AND scope->>'kind' = 'index'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(degraded.rows[0]!.gaps).toHaveLength(1);
  });

  it("dailyMarketUpdate ETF 组内单只基金不支持行情只记该标的缺口，不拖垮同组", async () => {
    const targetDate = "2026-08-14";
    for (const [code, name] of [["159516.SZ", "好ETF"], ["560450.SH", "坏基金"]] as const) {
      const instrument = await pool.query<{ id: string }>(
        `INSERT INTO market_instrument (code, name, kind) VALUES ($1, $2, 'etf')
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id::text`,
        [code, name],
      );
      await pool.query(
        `INSERT INTO market_bar
           (instrument_id, freq, bar_date, bar_time, open, high, low, close, volume, channel)
         VALUES ($1, 'day', '2026-08-13', '2026-08-13T00:00:00Z', 10, 11, 9, 10, 1000, 'test')`,
        [instrument.rows[0]!.id],
      );
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === "/api/fund/market/snapshot") {
          const code = parsed.searchParams.get("thscode");
          if (code === "560450.SH") {
            return jsonResponse({ code: 3004, message: "This fund does not support market data" });
          }
          return jsonResponse(snapshotPayload(code!, targetDate, 10));
        }
        throw new Error(`未预期的 URL: ${parsed}`);
      }),
    );

    const summary = await dailyMarketUpdate(
      pool,
      { codes: ["159516.SZ", "560450.SH"], date: targetDate },
      { hithinkDeps: noWait },
    );
    expect(summary.gaps).toEqual([
      { code: "560450.SH", freq: "day", reason: expect.stringContaining("ETF 快照不可用") },
    ]);
    expect(summary.snapshotRows).toBe(1);
    const stored = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM market_bar b JOIN market_instrument i ON i.id = b.instrument_id
        WHERE i.code = ANY($1::text[]) AND b.freq = 'day' AND b.bar_date = $2`,
      [["159516.SZ", "560450.SH"], targetDate],
    );
    expect(stored.rows[0]!.n).toBe(1);
  });

  it("dailyMarketUpdate 隔离批量坏代码和单标的补拉错误，后续标的仍落库", async () => {
    const targetDate = "2026-09-02";
    const previousDate = "2026-09-01";
    const codes = ["118058.SZ", "600091.SH", "600092.SH"];
    for (const code of codes) {
      const instrument = await pool.query<{ id: string }>(
        `INSERT INTO market_instrument (code, name, kind) VALUES ($1, $1, 'stock')
         ON CONFLICT (code) DO UPDATE SET kind = 'stock' RETURNING id::text`,
        [code],
      );
      if (code === "600092.SH") {
        await pool.query(
          `INSERT INTO market_bar
             (instrument_id, freq, bar_date, bar_time, open, high, low, close, volume, channel)
           VALUES ($1, 'day', $2, $3, 10, 11, 9, 10, 1000, 'test')`,
          [instrument.rows[0]!.id, previousDate, `${previousDate}T00:00:00Z`],
        );
      }
    }
    const snapshotBatches: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/a-share/prices/snapshot") {
        const batch = parsed.searchParams.get("thscodes")!;
        snapshotBatches.push(batch);
        if (batch.includes("118058.SZ")) {
          return jsonResponse({ code: 3004, message: "Unknown thscode: 118058.SZ" });
        }
        return jsonResponse({
          code: 0,
          message: "success",
          data: {
            timestamp: Date.parse(`${targetDate}T15:05:00+08:00`),
            item: batch.split(",").map((code) => ({
              thscode: code,
              open_price: 10,
              high_price: 12,
              low_price: 9,
              last_price: 11,
              prev_price: 10,
              volume: 1000,
            })),
          },
        });
      }
      if (parsed.pathname.endsWith("/historical") && parsed.searchParams.get("thscode") === "600091.SH") {
        return jsonResponse({ code: 3004, message: "模拟单标的历史数据错误" });
      }
      throw new Error(`未预期的 URL: ${parsed}`);
    }));

    const summary = await dailyMarketUpdate(
      pool,
      { codes, date: targetDate },
      { hithinkDeps: noWait, channels: [new HithinkChannel(noWait)] },
    );

    expect(snapshotBatches).toEqual([
      "118058.SZ,600091.SH,600092.SH",
      "118058.SZ",
      "600091.SH,600092.SH",
    ]);
    expect(summary.snapshotRows).toBe(1);
    expect(summary.gaps).toEqual([
      { code: "118058.SZ", freq: "day", reason: expect.stringContaining("Unknown thscode: 118058.SZ") },
      { code: "600091.SH", freq: "day", reason: expect.stringContaining("日线处理失败") },
    ]);
    expect(Number((await pool.query(
      `SELECT count(*) FROM market_bar b JOIN market_instrument i ON i.id = b.instrument_id
        WHERE i.code = '600092.SH' AND b.freq = 'day' AND b.bar_date = $1`,
      [targetDate],
    )).rows[0]!.count)).toBe(1);
    const run = await pool.query<{ rows_written: number; gaps: Array<{ code: string }> }>(
      `SELECT rows_written, gaps FROM market_fetch_run
        WHERE scope->>'op' = 'snapshot' AND scope->>'kind' = 'stock'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(run.rows[0]).toMatchObject({ rows_written: 1 });
    expect(run.rows[0]!.gaps.map((gap) => gap.code)).toEqual(["118058.SZ", "600091.SH"]);
  });

  it("单板块成分请求失败时保留上一版有效关系", async () => {
    await upsertTickerIdentities(pool, [
      {
        code: "881001.TI",
        ticker: "881001",
        name: "测试行业",
        exchange: null,
        assetType: "a-share-index",
        currency: "CNY",
        sourceUpdatedAt: "2026-08-17T07:00:00.000Z",
      },
      {
        code: "600000.SH",
        ticker: "600000",
        name: "浦发银行",
        exchange: "SH",
        assetType: "a-share",
        currency: "CNY",
        sourceUpdatedAt: "2026-08-17T07:00:00.000Z",
      },
    ], new Set(["881001.TI"]));
    await pool.query(
      `INSERT INTO market_board (instrument_id, board_type, active)
       SELECT id, 'industry', true FROM market_instrument WHERE code = '881001.TI'
       ON CONFLICT (instrument_id) DO UPDATE SET active = true`,
    );
    await pool.query(
      `INSERT INTO market_board_membership (board_instrument_id, member_instrument_id, effective_from)
       SELECT board.id, member.id, '2026-08-17'
         FROM market_instrument board, market_instrument member
        WHERE board.code = '881001.TI' AND member.code = '600000.SH'`,
    );
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: 2003, message: "无板块成分权限", data: null })));
    await expect(syncBoardMembership(pool, "881001.TI", "2026-08-18", noWait)).rejects.toThrow("code=2003");
    const all = await syncAllBoardMemberships(pool, "2026-08-18", noWait);
    expect(all.completed).toHaveLength(0);
    expect(all.gaps).toMatchObject([{ code: "881001.TI" }]);
    const current = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM market_board_membership WHERE effective_to IS NULL",
    );
    expect(current.rows[0]!.n).toBe(1);
  });

  it("market_catalog_sync 同步交易所月度日历：写入整月开休市，当年缺月记缺口", async () => {
    const timestamp = Date.parse("2026-09-28T07:10:00+08:00");
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      const envelope = (data: unknown) => jsonResponse({ code: 0, message: "success", data });
      if (parsed.pathname === "/api/a-share-index/catalog/ths-index-list") {
        return envelope({ timestamp, item: [] });
      }
      if (parsed.pathname === "/api/meta/tickers/list") {
        return envelope({ timestamp, item: [
          { thscode: "600990.SH", ticker: "600990", name: "日历测试股", asset_type: "a-share", exchange: "SH", currency: "CNY" },
        ] });
      }
      if (parsed.pathname === "/api/a-share/calendar/trading-days") {
        return envelope({ timestamp, item: [{ date: "20260928" }] });
      }
      throw new Error(`未预期的 URL: ${String(url)}`);
    }));
    // 同步窗口固定为 2026-08..2027-01（now=2026-09-28）：9 月模拟失败、11 月未返回、次年 1 月未发布。
    const exchangeCalendar = async (month: string) => {
      if (month === "2026-09") throw new Error("模拟当年月份失败");
      if (month === "2026-11" || month === "2027-01") return null;
      if (month === "2026-08") {
        return [
          { date: "2026-08-28", isOpen: true },
          { date: "2026-08-29", isOpen: false },
        ];
      }
      if (month === "2026-10") {
        return [
          { date: "2026-10-01", isOpen: false },
          { date: "2026-10-08", isOpen: true },
        ];
      }
      return [{ date: "2026-12-31", isOpen: false }];
    };
    try {
      const summary = await syncMarketCatalog(pool, {
        ...noWait,
        exchangeCalendar,
        now: () => new Date("2026-09-28T02:00:00Z"),
      });
      expect(summary.calendarMonthCount).toBe(3);
      expect(summary.calendarGaps.map((gap) => gap.code).sort())
        .toEqual(["szse_calendar.2026-09", "szse_calendar.2026-11"]);
      expect(summary.fetchRunIds).toHaveLength(2);
      const rows = await pool.query<{ is_open: boolean }>(
        "SELECT is_open FROM market_trading_day WHERE trade_date = ANY($1::date[]) ORDER BY trade_date",
        [["2026-09-28", "2026-10-01", "2026-10-08", "2026-12-31"]],
      );
      // 扶摇开市行保留，交易所日历补齐节假日休市行（国庆 10-01 休、10-08 开、12-31 周四休）。
      expect(rows.rows.map((row) => row.is_open)).toEqual([true, false, true, false]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("涨停分页中途失败保留成功页并记 partial，补跑保持幂等", async () => {
    const targetDate = "2026-08-18";
    const timestamp = Date.parse(`${targetDate}T15:40:00+08:00`);
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      const page = Number(parsed.searchParams.get("page"));
      if (page === 1) {
        return jsonResponse({
          code: 0,
          message: "success",
          data: {
            timestamp,
            pagination: { page: 1, pages: 2, total: 2 },
            item: [{
              thscode: "600000.SH",
              ticker: "600000",
              name: "浦发银行",
              last_price: 12.34,
              continue_day_cnt: 1,
              open_times: 0,
              limit_up_time: "09:31",
              industry_name: "银行",
              limit_up_reason: "测试",
            }],
          },
        });
      }
      return jsonResponse({ code: 5000, message: "测试分页失败", data: null });
    }));
    const first = await syncLimitDataset(pool, "up", targetDate, noWait);
    const second = await syncLimitDataset(pool, "up", targetDate, noWait);
    expect(first).toMatchObject({ status: "partial", rows: 1, completedPages: 1, totalPages: 2 });
    expect(second).toMatchObject({ status: "partial", rows: 1, completedPages: 1, totalPages: 2 });
    const events = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM market_limit_event WHERE trade_date = $1 AND event_type = 'up'",
      [targetDate],
    );
    expect(events.rows[0]!.n).toBe(1);
    const runs = await pool.query<{ n: number; partial: number }>(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE status = 'partial')::int AS partial
         FROM market_special_sync_run WHERE dataset = 'limit_up' AND target_date = $1`,
      [targetDate],
    );
    expect(runs.rows[0]).toEqual({ n: 2, partial: 2 });
  });

  it("涨跌停池允许供应商用 pages=0 表示目标日空结果", async () => {
    const targetDate = "2026-08-18";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      code: 0,
      message: "success",
      data: {
        timestamp: Date.parse(`${targetDate}T15:40:00+08:00`),
        pagination: { page: 1, pages: 0, total: 0 },
        item: [],
      },
    })));
    expect(await syncLimitDataset(pool, "down", targetDate, noWait)).toMatchObject({
      status: "success",
      rows: 0,
      completedPages: 0,
      totalPages: 0,
      gaps: [],
    });
  });

  it("连板天梯兼容两种供应商日期格式且仍严格校验目标日", async () => {
    const timestamp = Date.parse("2026-08-20T15:40:00+08:00");
    let dateList = ["2026-08-20", "2026-08-19"];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      code: 0,
      message: "success",
      data: {
        timestamp,
        window: { length: 2, date_list: dateList, board_caps: {} },
        item: [{
          date: dateList[0],
          boards: {
            two_board: [{ name: "测试二板", thscode: "000001.SZ", board_num: 2 }],
            three_board: [{ name: "测试三板", thscode: "600001.SH", board_num: 3 }],
          },
        }],
      },
    })));

    expect(await syncLimitLadder(pool, "2026-08-20", noWait)).toMatchObject({ status: "success", rows: 1 });
    dateList = ["20260820", "20260819"];
    expect(await syncLimitLadder(pool, "2026-08-20", noWait)).toMatchObject({ status: "success", rows: 1 });

    const snapshots = await pool.query<{ coverage_start: string; coverage_end: string }>(
      `SELECT coverage_start::text, coverage_end::text
         FROM market_limit_ladder_snapshot WHERE target_date = '2026-08-20'`,
    );
    expect(snapshots.rows).toHaveLength(2);
    expect(snapshots.rows).toEqual(expect.arrayContaining([
      { coverage_start: "2026-08-19", coverage_end: "2026-08-20" },
    ]));
    expect(await queryMarketStructure(pool, {
      date: "2026-08-20", dataset: "limit_ladder", page: 1, size: 200,
    })).toMatchObject({
      coverage: { row_count: 2 },
      items: [
        { name: "测试二板", thscode: "000001.SZ", tier: "2板" },
        { name: "测试三板", thscode: "600001.SH", tier: "3板" },
      ],
      counts: { limit_ladder: 2 },
    });

    const mismatch = await syncLimitLadder(pool, "2026-08-21", noWait);
    expect(mismatch).toMatchObject({
      status: "failed",
      gaps: [{ reason: "连板天梯截止日 2026-08-20 与目标日 2026-08-21 不一致" }],
    });
  });

  it("行情 upsert 与指标 dirty 原子提交，generation 递增后按近六年窗口全量重算", async () => {
    const instrumentId = await ensureInstrument(pool, "601999.SH", "指标测试股票", "day");
    await pool.query(
      `INSERT INTO market_bar
         (instrument_id, freq, bar_date, bar_time, open, high, low, close, volume, adjustment, channel)
       VALUES ($1, 'day', '2019-01-02', '2019-01-02T00:00:00Z', 10, 11, 9, 10, 1000, 'none', 'legacy_test')`,
      [instrumentId],
    );
    const bars = indicatorFixture.input.map((close, index) => {
      const date = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
      return { date, open: close, high: close + 1, low: close - 1, close, volume: 1000, adjustment: "forward" as const };
    });
    await storeBars(pool, instrumentId, "day", bars, "test");
    const firstDirty = await pool.query<{ generation: string; earliest_date: string }>(
      "SELECT generation::text, earliest_date::text FROM market_indicator_dirty WHERE instrument_id = $1 AND freq = 'day'",
      [instrumentId],
    );
    expect(firstDirty.rows[0]).toEqual({ generation: "1", earliest_date: bars[0]!.date });
    await storeBars(pool, instrumentId, "day", [{ ...bars[10]!, close: bars[10]!.close + 0.01 }], "revision");
    const dirty = await pool.query<{ instrument_id: string; freq: "day"; generation: string }>(
      "SELECT instrument_id::text, freq, generation::text FROM market_indicator_dirty WHERE instrument_id = $1 AND freq = 'day'",
      [instrumentId],
    );
    expect(dirty.rows[0]!.generation).toBe("2");
    const run = await recomputeIndicatorSeries(pool, dirty.rows[0]!);
    expect(run).toMatchObject({ status: "success", rowCount: indicatorFixture.input.length });
    expect(Number((await pool.query(
      "SELECT count(*) FROM market_indicator_value WHERE instrument_id = $1 AND freq = 'day'",
      [instrumentId],
    )).rows[0]!.count)).toBe(indicatorFixture.input.length);
    expect(Number((await pool.query(
      "SELECT rsi14 FROM market_indicator_value WHERE instrument_id = $1 AND freq = 'day' ORDER BY bar_date DESC LIMIT 1",
      [instrumentId],
    )).rows[0]!.rsi14)).toBeGreaterThanOrEqual(0);
    expect((await pool.query(
      `SELECT calculation_version, input_row_count, defense_break_count, defense_recovered_count,
              stock_character_profile, stage, stock_character, tags
         FROM market_stock_character_metric WHERE instrument_id = $1`,
      [instrumentId],
    )).rows[0]).toMatchObject({
      calculation_version: "标的入池五维画像一版",
      input_row_count: indicatorFixture.input.length,
      defense_break_count: expect.any(Number),
      defense_recovered_count: expect.any(Number),
      stock_character_profile: {
        dimensions: {
          washout: { score: expect.any(Number) },
          markup: { score: expect.any(Number) },
          false_breakout: { score: expect.any(Number) },
          defense: { score: expect.any(Number) },
          volatility: { score: expect.any(Number) },
        },
      },
      stage: expect.any(String),
      stock_character: expect.any(String),
      tags: expect.arrayContaining(["画像版本：标的入池五维画像一版"]),
    });
    expect(Number((await pool.query(
      "SELECT count(*) FROM market_indicator_dirty WHERE instrument_id = $1 AND freq = 'day'",
      [instrumentId],
    )).rows[0]!.count)).toBe(0);

    const wideInstrumentId = await ensureInstrument(pool, "601998.SH", "宽域快照股票", "day");
    await expect(storeBars(pool, wideInstrumentId, "day", [{
      date: "2026-09-17", open: 10, high: 10.5, low: 9.8, close: 10.2, volume: 1000, adjustment: "forward",
    }], "hithink", { markIndicator: false })).resolves.toBe(1);
    expect(Number((await pool.query(
      "SELECT count(*) FROM market_indicator_dirty WHERE instrument_id = $1 AND freq = 'day'",
      [wideInstrumentId],
    )).rows[0]!.count)).toBe(0);
  });

  it("按公司行为修复负前复权比率导致的倒置 OHLC，不更改收盘价或原始价", async () => {
    const code = "600488.SH";
    const instrumentId = await ensureInstrument(pool, code, "复权修复样本", "day");
    await pool.query(
      `INSERT INTO market_bar
         (instrument_id,freq,bar_date,bar_time,open,high,low,close,
          open_raw,high_raw,low_raw,close_raw,adjustment,channel)
       VALUES ($1,'day','2020-01-02','2020-01-02T00:00:00Z',-1,-1.04,-0.96,-1,
               5,5.2,4.8,5,'forward','hithink_dump'),
              ($1,'day','2026-01-02','2026-01-02T00:00:00Z',10,10.2,9.8,10,
               10,10.2,9.8,10,'forward','hithink_dump')`,
      [instrumentId],
    );
    const events = [{ ex_date: "2024-01-02", dividend: 6, bonus: 0, rights_ratio: 0, rights_price: 0 }];
    await expect(repairInvalidForwardOhlc(pool, [{ code, events: [] }])).rejects.toThrow("不完整");
    expect(await repairInvalidForwardOhlc(pool, [{ code, events }])).toEqual([{ code, repaired: 1 }]);
    expect((await pool.query(
      `SELECT open::float8,high::float8,low::float8,close::float8,high_raw::float8
         FROM market_bar WHERE instrument_id=$1 AND bar_date='2020-01-02'`, [instrumentId],
    )).rows[0]).toEqual({ open: -1, high: -0.8, low: -1.2, close: -1, high_raw: 5.2 });
    expect((await pool.query(
      "SELECT reason FROM market_indicator_dirty WHERE instrument_id=$1 AND freq='day'", [instrumentId],
    )).rows[0]).toEqual({ reason: "前复权 OHLC 修复" });
    expect(await repairInvalidForwardOhlc(pool, [{ code, events }])).toEqual([{ code, repaired: 0 }]);
  });

  it("历史零价日线标为不可信且不阻塞指标队列", async () => {
    const instrumentId = await ensureInstrument(pool, "600487.SH", "零价测试股票", "day");
    await storeBars(pool, instrumentId, "day", [{
      date: "2026-08-21", open: 0, high: 0, low: 0, close: 0, volume: 0, adjustment: "forward",
    }], "legacy_test");
    const dirty = await pool.query<{ instrument_id: string; freq: "day"; generation: string }>(
      "SELECT instrument_id::text, freq, generation::text FROM market_indicator_dirty WHERE instrument_id = $1 AND freq = 'day'",
      [instrumentId],
    );

    expect(await recomputeIndicatorSeries(pool, dirty.rows[0]!)).toMatchObject({
      status: "untrusted",
      gaps: [{ reason: "2026-08-21 五维股性 OHLC 包含非有限或非正数值" }],
    });
    expect(Number((await pool.query(
      "SELECT count(*) FROM market_indicator_dirty WHERE instrument_id = $1 AND freq = 'day'",
      [instrumentId],
    )).rows[0]!.count)).toBe(0);
    expect(Number((await pool.query(
      "SELECT count(*) FROM market_stock_character_metric WHERE instrument_id = $1",
      [instrumentId],
    )).rows[0]!.count)).toBe(0);
  });

});
