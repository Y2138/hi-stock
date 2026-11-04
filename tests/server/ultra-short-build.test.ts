import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { prepareTestDb } from "./helpers.js";
import {
  buildUltraShortWatchlist,
  capP1Priority,
  evaluateCandidatePriority,
  resolveUltraShortDates,
  selectWatchlistCandidates,
  type PriorityInput,
  type PriorityResult,
} from "../../server/modules/ultra-short/build.js";
import {
  classifyIndexBias,
  classifyLimitUpEmotion,
  classifySystemicRisk,
  evaluateUltraShortEnvironment,
  insufficientEnvironment,
  resolvePoolCap,
  type UltraShortEnvironmentResult,
} from "../../server/modules/ultra-short/environment.js";
import {
  detectLowBuyPatterns,
  lowBuyExclusion,
  queryLowBuyShapes,
  type LowBuyBar,
  type LowBuyPatternInput,
} from "../../server/modules/ultra-short/low-buy.js";
import { listWatchlist } from "../../server/modules/ultra-short/repo.js";

const NOW = new Date("2026-10-20T12:00:00+08:00");
const DATA_DATE = "2026-09-17";
const TARGET_DATE = "2026-09-18";

function bar(date: string, close: number, overrides: Partial<LowBuyBar> = {}): LowBuyBar {
  return {
    date,
    open: overrides.open ?? close,
    high: overrides.high ?? close * 1.01,
    low: overrides.low ?? close * 0.99,
    close,
    volume: overrides.volume ?? 100,
    amount: overrides.amount ?? 2e8,
  };
}

function patternInput(bars: LowBuyBar[], overrides: Partial<LowBuyPatternInput> = {}): LowBuyPatternInput {
  return {
    code: "600001.SH",
    name: "测试标的",
    bars,
    prior_max_streak: 0,
    prior_limit_up_count: 0,
    recent_limit_down_count: 0,
    had_break: false,
    is_st: false,
    is_new: false,
    main_theme: "机器人",
    ...overrides,
  };
}

function mockEnvironment(overrides: {
  rating?: "强" | "中" | "弱" | null;
  bias?: UltraShortEnvironmentResult["index_environment"]["bias"];
  vacuum?: boolean | null;
  highest?: number | null;
  topTheme?: string | null;
} = {}): UltraShortEnvironmentResult {
  const base = insufficientEnvironment(DATA_DATE, []);
  return {
    ...base,
    limit_up_emotion: {
      ...base.limit_up_emotion,
      rating: overrides.rating ?? null,
      highest_streak: overrides.highest ?? null,
    },
    index_environment: { ...base.index_environment, bias: overrides.bias ?? "unknown" },
    mainline: {
      ...base.mainline,
      top_theme: overrides.topTheme ?? null,
      mainline_vacuum: overrides.vacuum ?? null,
    },
    mainline_vacuum: overrides.vacuum ?? null,
  };
}

function priorityInput(overrides: Partial<PriorityInput> = {}): PriorityInput {
  return {
    sources: ["post_close"],
    resonance: false,
    signal_grade: null,
    selected: false,
    stage: "first_board",
    streak_count: 1,
    main_theme: "机器人",
    one_word: null,
    seal_turnover_ratio: null,
    pk_status: null,
    risk_flags: [],
    low_buy_stage: null,
    ...overrides,
  };
}

describe("低吸形态纯函数", () => {
  it("龙回头：前期连板后回踩 MA10 缩量企稳", () => {
    const bars: LowBuyBar[] = [];
    for (let index = 0; index < 21; index += 1) bars.push(bar(`d${index}`, 10.0));
    bars.push(bar("d21", 11.0, { open: 10.5, high: 11.05, low: 10.45, volume: 200 }));
    bars.push(bar("d22", 11.05, { open: 10.95, high: 11.1, low: 10.9, volume: 120 }));
    bars.push(bar("d23", 11.0, { open: 10.9, high: 11.1, low: 10.85, volume: 100 }));
    bars.push(bar("d24", 11.1, { open: 11.0, high: 11.2, low: 10.6, volume: 50 }));
    const shapes = detectLowBuyPatterns(patternInput(bars, { prior_max_streak: 3, prior_limit_up_count: 3 }));
    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.tags).toEqual(["龙回头"]);
    expect(shapes[0]!.stage).toBe("formed");
    expect(shapes[0]!.plan.trigger).toBe("long_huitou");
    expect(shapes[0]!.key_levels.pattern_low).not.toBeNull();
    expect(shapes[0]!.key_levels.invalidation_price).toBeLessThan(shapes[0]!.key_levels.pattern_low!);
  });

  it("单阳不破：放量大阳后小 K 横盘不破大阳低点", () => {
    const bars: LowBuyBar[] = [];
    for (let index = 0; index < 21; index += 1) bars.push(bar(`d${index}`, 10.0));
    bars.push(bar("d21", 10.8, { open: 10.1, high: 10.9, low: 10.05, volume: 300 }));
    bars.push(bar("d22", 10.82, { open: 10.85, high: 10.9, low: 10.7, volume: 100 }));
    bars.push(bar("d23", 10.85, { open: 10.83, high: 10.92, low: 10.75, volume: 100 }));
    bars.push(bar("d24", 10.9, { open: 10.86, high: 10.95, low: 10.8, volume: 100 }));
    const shapes = detectLowBuyPatterns(patternInput(bars));
    expect(shapes.map((shape) => shape.tags[0])).toContain("单阳不破");
    const target = shapes.find((shape) => shape.tags[0] === "单阳不破")!;
    expect(target.stage).toBe("formed");
    expect(target.plan.trigger).toBe("dan_yang_bu_po");
  });

  it("N 字结构：第一波强、缩量回调守住关键位、再放量拉起", () => {
    const bars: LowBuyBar[] = [];
    for (let index = 0; index < 13; index += 1) bars.push(bar(`d${index}`, 10.0));
    bars.push(bar("d13", 10.0, { open: 10.0, high: 10.1, low: 9.95, volume: 100 }));
    bars.push(bar("d14", 10.5, { open: 10.0, high: 10.6, low: 10.0, volume: 150 }));
    bars.push(bar("d15", 11.1, { open: 10.5, high: 11.2, low: 10.45, volume: 200 }));
    bars.push(bar("d16", 10.9, { open: 11.0, high: 11.05, low: 10.7, volume: 120 }));
    bars.push(bar("d17", 10.7, { open: 10.85, high: 10.9, low: 10.6, volume: 100 }));
    bars.push(bar("d18", 10.65, { open: 10.7, high: 10.75, low: 10.55, volume: 90 }));
    bars.push(bar("d19", 11.0, { open: 10.7, high: 11.1, low: 10.7, volume: 200 }));
    const shapes = detectLowBuyPatterns(patternInput(bars));
    expect(shapes.map((shape) => shape.tags[0])).toContain("N 字结构");
    const target = shapes.find((shape) => shape.tags[0] === "N 字结构")!;
    expect(target.stage).toBe("formed");
    expect(target.plan.trigger).toBe("n_structure");
  });

  it("线上阴线买：趋势向上回踩均线收阴、缩量不破位", () => {
    const bars: LowBuyBar[] = [];
    for (let index = 0; index < 23; index += 1) bars.push(bar(`d${index}`, 10 + index * 0.025));
    bars.push(bar("d23", 10.65, { open: 10.75, high: 10.8, low: 10.55, volume: 80 }));
    bars.push(bar("d24", 10.7, { open: 10.75, high: 10.78, low: 10.55, volume: 70 }));
    const shapes = detectLowBuyPatterns(patternInput(bars));
    expect(shapes.map((shape) => shape.tags[0])).toContain("线上阴线买");
    const target = shapes.find((shape) => shape.tags[0] === "线上阴线买")!;
    expect(target.stage).toBe("formed");
    expect(target.plan.trigger).toBe("online_yin");
  });

  it("排除 A 杀、放量破位、连续跌停、ST/新股与非主板", () => {
    const aShaBars: LowBuyBar[] = [];
    for (let index = 0; index < 21; index += 1) aShaBars.push(bar(`d${index}`, 10.0));
    aShaBars.push(bar("d21", 11.0, { open: 10.4, high: 11.1, low: 10.3, volume: 200 }));
    aShaBars.push(bar("d22", 9.0, { open: 10.8, high: 10.8, low: 8.9, volume: 200 }));
    expect(lowBuyExclusion(patternInput(aShaBars))).toContain("A 杀");

    const breakdownBars: LowBuyBar[] = [];
    for (let index = 0; index < 22; index += 1) breakdownBars.push(bar(`d${index}`, 10.0));
    breakdownBars.push(bar("d22", 9.7, { open: 10.0, high: 10.0, low: 9.65, volume: 400 }));
    expect(lowBuyExclusion(patternInput(breakdownBars))).toBe("放量破位");

    const normalBars: LowBuyBar[] = [];
    for (let index = 0; index < 22; index += 1) normalBars.push(bar(`d${index}`, 10.0));
    expect(lowBuyExclusion(patternInput(normalBars, { code: "300001.SZ" }))).toBe("非沪深主板");
    expect(lowBuyExclusion(patternInput(normalBars, { name: "ST测试" }))).toBe("ST");
    expect(lowBuyExclusion(patternInput(normalBars, { recent_limit_down_count: 2 }))).toBe("连续跌停");
    expect(lowBuyExclusion(patternInput(normalBars, { is_new: true }))).toBe("新股未开板");
  });
});

describe("环境与优先级纯函数", () => {
  it("连板情绪按高度、涨停家数、炸板率、昨日溢价分档", () => {
    expect(classifyLimitUpEmotion({
      highest_streak: 5, limit_up_count: 70, break_rate: 0.2, yesterday_limit_up_premium: 3,
    }).rating).toBe("强");
    expect(classifyLimitUpEmotion({
      highest_streak: 1, limit_up_count: 10, break_rate: 0.6, yesterday_limit_up_premium: -3,
    }).rating).toBe("弱");
    const insufficient = classifyLimitUpEmotion({
      highest_streak: null, limit_up_count: null, break_rate: null, yesterday_limit_up_premium: null,
    });
    expect(insufficient.rating).toBeNull();
    expect(insufficient.gaps.length).toBeGreaterThanOrEqual(4);
  });

  it("关注池规模遵循连板情绪优先、系统性风险归零", () => {
    expect(resolvePoolCap({ rating: "强", index_bias: "favorable", systemic_risk: false, mainline_vacuum: true }))
      .toMatchObject({ min: 4, max: 6 });
    expect(resolvePoolCap({ rating: "强", index_bias: "dispersing", systemic_risk: false, mainline_vacuum: null }))
      .toMatchObject({ min: 3, max: 5 });
    expect(resolvePoolCap({ rating: "中", index_bias: "neutral", systemic_risk: false, mainline_vacuum: null }))
      .toMatchObject({ min: 2, max: 4 });
    expect(resolvePoolCap({ rating: "弱", index_bias: "favorable", systemic_risk: false, mainline_vacuum: null }))
      .toMatchObject({ min: 2, max: 3 });
    expect(resolvePoolCap({ rating: "强", index_bias: "favorable", systemic_risk: true, mainline_vacuum: true }))
      .toMatchObject({ min: 0, max: 0 });
  });

  it("指数/广度与系统性风险按确定性阈值判定", () => {
    expect(classifyIndexBias({
      systemic_risk: false, advancing_ratio: 0.7, below_ma20_ratio: 0.5, amount_ratio_5d: 1.2, mainline_vacuum: false,
    })).toBe("dispersing");
    expect(classifyIndexBias({
      systemic_risk: false, advancing_ratio: 0.3, below_ma20_ratio: 0.1, amount_ratio_5d: 0.8, mainline_vacuum: null,
    })).toBe("favorable");
    expect(classifyIndexBias({
      systemic_risk: null, advancing_ratio: null, below_ma20_ratio: null, amount_ratio_5d: null, mainline_vacuum: null,
    })).toBe("unknown");
    expect(classifySystemicRisk({
      market_pct_1d: -3, amount_ratio_5d: 1.3, advancing_ratio: 0.15, limit_down_count: null,
    }).risk).toBe(true);
    expect(classifySystemicRisk({
      market_pct_1d: null, amount_ratio_5d: null, advancing_ratio: null, limit_down_count: null,
    }).risk).toBeNull();
  });

  it("优先级同时考虑共振、阶段、封单与环境", () => {
    const strong = evaluateCandidatePriority(priorityInput({
      resonance: true,
      signal_grade: "A",
      selected: true,
      stage: "high_board",
      streak_count: 5,
      seal_turnover_ratio: 0.2,
      pk_status: "review",
    }), mockEnvironment({ rating: "强", bias: "favorable", vacuum: true, highest: 5 }));
    expect(strong.priority).toBe("P1");
    expect(strong.priority_reason).toContain("来源共振");
    expect(strong.priority_reason).toContain("主线真空");

    const weak = evaluateCandidatePriority(priorityInput({
      stage: "low_buy",
      low_buy_stage: "pending",
      risk_flags: ["低吸形态待触发"],
    }), mockEnvironment({ rating: "弱", bias: "dispersing" }));
    expect(weak.priority).toBe("P3");

    // 一字板不占 P1：成交不确定由 01 成交概率档表达。
    const oneWord = evaluateCandidatePriority(priorityInput({
      resonance: true, signal_grade: "A", selected: true,
      stage: "confirmation", streak_count: 2, pk_status: "review",
      seal_turnover_ratio: 0.2, one_word: true,
    }), mockEnvironment({ rating: "强", bias: "favorable", vacuum: true, highest: 4 }));
    expect(oneWord.priority).toBe("P2");
    expect(oneWord.priority_reason).toContain("一字板成交不确定");

    // 只保留 1–2 只 P1：超出上限的 P1 降为 P2。
    const ranked: Array<{ priority: PriorityResult }> = [
      { priority: { score: 9, priority: "P1", priority_reason: "a" } },
      { priority: { score: 8, priority: "P1", priority_reason: "b" } },
      { priority: { score: 7, priority: "P1", priority_reason: "c" } },
      { priority: { score: 6, priority: "P2", priority_reason: "d" } },
    ];
    expect(capP1Priority(ranked, 2).map((item) => item.priority.priority)).toEqual(["P1", "P1", "P2", "P2"]);
  });

  it("同题材最多 2 只、总量按环境上限、空池允许", () => {
    const candidates = [
      { code: "600001.SH", main_theme: "机器人", score: 10 },
      { code: "600002.SH", main_theme: "机器人", score: 9 },
      { code: "600003.SH", main_theme: "机器人", score: 8 },
      { code: "600004.SH", main_theme: "算力", score: 7 },
    ];
    const selected = selectWatchlistCandidates(candidates, { total_cap: 6, theme_cap: 2 });
    expect(selected.map((item) => item.code)).toEqual(["600001.SH", "600002.SH", "600004.SH"]);
    expect(selectWatchlistCandidates(candidates, { total_cap: 2, theme_cap: 2 })).toHaveLength(2);
    expect(selectWatchlistCandidates(candidates, { total_cap: 0, theme_cap: 2 })).toEqual([]);
    expect(selectWatchlistCandidates([], { total_cap: 6, theme_cap: 2 })).toEqual([]);
  });
});

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("03 盘后关注池确定性引擎（数据库）", () => {
  if (!prepared) return;
  let pool: pg.Pool;

  async function seedTradingDays(dates: string[]): Promise<void> {
    for (const date of dates) {
      await pool.query(
        "INSERT INTO market_trading_day (trade_date,is_open,source) VALUES ($1,true,'test') ON CONFLICT DO NOTHING",
        [date],
      );
    }
  }

  async function instrumentId(code: string, name: string, kind: "stock" | "index"): Promise<string> {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO market_instrument (code,name,kind) VALUES ($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id::text`,
      [code, name, kind],
    );
    return row.rows[0]!.id;
  }

  async function insertStockBar(input: {
    code: string;
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
    amount?: number | null;
    prevClose?: number | null;
    ma20?: number | null;
    ma60?: number | null;
  }): Promise<void> {
    const id = await instrumentId(input.code, input.code, "stock");
    await pool.query(
      `INSERT INTO market_bar
         (instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,turnover,
          prev_close,ma20,ma60,channel)
       VALUES ($1,'day',$2::date,$2::date::timestamp AT TIME ZONE 'UTC',$3,$4,$5,$6,$7,$8,$9,$10,$11,'test')
       ON CONFLICT (instrument_id,freq,bar_date,bar_time) DO UPDATE SET
         open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,
         volume=EXCLUDED.volume,turnover=EXCLUDED.turnover,prev_close=EXCLUDED.prev_close,
         ma20=EXCLUDED.ma20,ma60=EXCLUDED.ma60`,
      [id, input.date, input.open, input.high, input.low, input.close,
        input.volume ?? 1000, input.amount === undefined ? 2e8 : input.amount,
        input.prevClose ?? null, input.ma20 ?? null, input.ma60 ?? null],
    );
  }

  async function insertIndexBar(input: { code: string; name: string; date: string; close: number }): Promise<void> {
    const id = await instrumentId(input.code, input.name, "index");
    await pool.query(
      `INSERT INTO market_bar (instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,turnover,channel)
       VALUES ($1,'day',$2::date,$2::date::timestamp AT TIME ZONE 'UTC',$3,$3,$3,$3,1000,1e12,'test')
       ON CONFLICT (instrument_id,freq,bar_date,bar_time) DO UPDATE SET close=EXCLUDED.close,turnover=EXCLUDED.turnover`,
      [id, input.date, input.close],
    );
  }

  async function insertLimitEvent(input: {
    date: string;
    code: string;
    name: string;
    streak: number;
    reason: string;
    eventType?: "up" | "down" | "break";
    sealMoney?: number | null;
    turnover?: number | null;
    firstEventTime?: string | null;
  }): Promise<void> {
    const id = await instrumentId(input.code, input.name, "stock");
    await pool.query(
      `INSERT INTO market_limit_event
         (trade_date,event_type,instrument_id,streak_count,open_count,first_event_time,
          reason,is_st,is_new,seal_money,max_seal_money,turnover,source_row_sha256)
       VALUES ($1::date,$2,$3,$4,0,$5,$6,false,false,$7,$8,$9,$10)
       ON CONFLICT (trade_date,event_type,instrument_id) DO UPDATE SET
         streak_count=EXCLUDED.streak_count,reason=EXCLUDED.reason,seal_money=EXCLUDED.seal_money,
         max_seal_money=EXCLUDED.max_seal_money,turnover=EXCLUDED.turnover`,
      [input.date, input.eventType ?? "up", id, input.streak, input.firstEventTime ?? null, input.reason,
        input.sealMoney ?? 5e7, input.sealMoney === undefined ? 6e7 : (input.sealMoney ?? 5e7) * 1.2,
        input.turnover ?? 2e8, `sha-${input.date}-${input.code}-${input.eventType ?? "up"}`],
    );
  }

  async function insertSyncRun(dataset: string, date: string): Promise<void> {
    await pool.query(
      `INSERT INTO market_special_sync_run (dataset,target_date,status) VALUES ($1,$2::date,'success')`,
      [dataset, date],
    );
  }

  beforeAll(async () => {
    pool = prepared.pool;
    // 核心市场夹具：交易日、4 个核心指数、10 只主板股、连板事件、同步状态。
    await seedTradingDays(["2026-09-16", DATA_DATE]);
    const indexCloses: Array<[string, string, number[]]> = [
      ["000001.SH", "上证指数", [3000, 3000, 3000, 3000, 3000, 3000]],
      ["000300.SH", "沪深300", [4600, 4590, 4580, 4570, 4560, 4500]],
      ["000905.SH", "中证500", [6000, 6010, 6020, 6030, 6040, 6070]],
      ["000852.SH", "中证1000", [6500, 6510, 6520, 6530, 6540, 6600]],
    ];
    const indexDates = ["2026-09-10", "2026-09-11", "2026-09-14", "2026-09-15", "2026-09-16", DATA_DATE];
    for (const [code, name, closes] of indexCloses) {
      for (let offset = 0; offset < indexDates.length; offset += 1) {
        await insertIndexBar({ code, name, date: indexDates[offset]!, close: closes[offset]! });
      }
    }
    // 10 只主板股：60 根日线自算 MA20/MA60；前 4 只上涨，8 只在 MA20 下方，含 1 只低位首板。
    for (let offset = 1; offset <= 10; offset += 1) {
      const code = `6000${String(offset).padStart(2, "0")}.SH`;
      const finalClose = offset <= 2 ? 10.5 : offset === 3 ? 9.995 : offset === 4 ? 9.998 : 9.8;
      const prevClose = offset === 3 || offset === 4 ? 9.9 : 10;
      const id = await instrumentId(code, code, "stock");
      await pool.query(
        `INSERT INTO market_bar
           (instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,turnover,prev_close,channel)
         SELECT $1,'day', $2::date - (59 - n), ($2::date - (59 - n))::timestamp AT TIME ZONE 'UTC',
                CASE WHEN n = 59 THEN $3::numeric ELSE 10 END,
                CASE WHEN n = 59 THEN $3::numeric ELSE 10 END,
                CASE WHEN n = 59 THEN $3::numeric ELSE 10 END,
                CASE WHEN n = 59 THEN $3::numeric ELSE 10 END,
                1000, 2e8, CASE WHEN n = 59 THEN $4::numeric ELSE NULL END, 'test'
           FROM generate_series(0,59) n`,
        [id, DATA_DATE, finalClose, prevClose],
      );
    }
    await insertLimitEvent({
      date: DATA_DATE, code: "600001.SH", name: "测试一", streak: 5, reason: "机器人概念",
      firstEventTime: "2026-09-17T01:35:00Z",
    });
    await insertLimitEvent({
      date: DATA_DATE, code: "600002.SH", name: "测试二", streak: 2, reason: "机器人概念",
      firstEventTime: "2026-09-17T02:10:00Z",
    });
    await insertLimitEvent({
      date: DATA_DATE, code: "600003.SH", name: "测试三", streak: 1, reason: "算力概念",
      firstEventTime: "2026-09-17T05:30:00Z",
    });
    await insertLimitEvent({
      date: "2026-09-16", code: "600001.SH", name: "测试一", streak: 4, reason: "机器人概念",
      firstEventTime: "2026-09-16T01:40:00Z",
    });
    await insertSyncRun("limit_up", DATA_DATE);
    await insertSyncRun("limit_break", DATA_DATE);
    await insertSyncRun("limit_down", DATA_DATE);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("环境判定：强连板情绪 + 缩量集中 → 4–6 只关注池", async () => {
    const environment = await evaluateUltraShortEnvironment(pool, DATA_DATE);
    expect(environment.data_status).toBe("ready");
    expect(environment.limit_up_emotion.rating).toBe("强");
    expect(environment.limit_up_emotion.highest_streak).toBe(5);
    expect(environment.limit_up_emotion.limit_up_count).toBe(3);
    expect(environment.limit_up_emotion.break_rate).toBe(0);
    expect(environment.limit_up_emotion.yesterday_limit_up_premium).toBeGreaterThan(0);
    expect(environment.low_position_spread.advancing_ratio).toBe(0.4);
    expect(environment.low_position_spread.low_first_board_ratio).toBe(1);
    expect(environment.mainline_vacuum).toBe(true);
    expect(environment.index_environment.bias).toBe("favorable");
    expect(environment.systemic_risk).toBe(false);
    expect(environment.pool_cap).toEqual({ min: 4, max: 6 });
  });

  it("构建关注池：收盘打板候选经过滤、同题材上限写入同一份 T+1 池", async () => {
    await seedTradingDays([TARGET_DATE]);
    const result = await buildUltraShortWatchlist(pool, { targetDate: TARGET_DATE, now: NOW });
    expect(result.target_date).toBe(TARGET_DATE);
    expect(result.data_date).toBe(DATA_DATE);
    expect(result.environment.limit_up_emotion.rating).toBe("强");
    expect(result.rows.length).toBeGreaterThan(0);
    const themeCounts = new Map<string, number>();
    for (const row of result.rows) {
      const theme = String(row.t_facts.main_theme ?? "");
      themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1);
      expect(row.priority).toMatch(/^P[123]$/u);
      expect(row.priority_reason.length).toBeGreaterThan(0);
      expect(["pass", "flag"]).toContain(row.review_status);
      expect(row.key_levels.limit_up_price).not.toBeNull();
    }
    for (const count of themeCounts.values()) expect(count).toBeLessThanOrEqual(2);
    const stored = await listWatchlist(pool, TARGET_DATE);
    expect(stored.map((row) => row.code).sort()).toEqual(result.rows.map((row) => row.code).sort());
    expect(stored.every((row) => row.data_date === DATA_DATE)).toBe(true);
  });

  it("构建关注池：没有合格标的时写空池并清除旧行", async () => {
    await seedTradingDays(["2026-09-24", "2026-09-25"]);
    await pool.query(
      `INSERT INTO ultra_short_watchlist (target_date,data_date,code,name)
       VALUES ('2026-09-25','2026-09-24','600099.SH','旧标的')
       ON CONFLICT (target_date,code) DO NOTHING`,
    );
    const result = await buildUltraShortWatchlist(pool, { dataDate: "2026-09-24", now: NOW });
    expect(result.target_date).toBe("2026-09-25");
    expect(result.rows).toEqual([]);
    expect(result.status).toBe("partial");
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(await listWatchlist(pool, "2026-09-25")).toEqual([]);
  });

  it("构建关注池：盘中等候快照中的非主板、ST 与观察级候选被过滤，同题材最多 2 只", async () => {
    await seedTradingDays(["2026-10-08", "2026-10-09"]);
    const snapshotCodes: Array<[string, string, number, string, string]> = [
      ["600001.SH", "测试一", 2, "机器人", "review"],
      ["600002.SH", "测试二", 1, "机器人", "review"],
      ["600003.SH", "测试三", 3, "机器人", "review"],
      ["300001.SZ", "创业板测试", 2, "机器人", "review"],
      ["600004.SH", "观察级测试", 2, "算力", "observe_only"],
    ];
    for (const [code] of snapshotCodes) {
      await insertStockBar({
        code, date: "2026-10-08", open: 10, high: 10.3, low: 9.9, close: 10.2,
        prevClose: 10, ma20: 10.1, ma60: 10.1,
      });
    }
    const candidates = snapshotCodes.map(([code, name, streak, theme, status]) => ({
      code, name, streak_count: streak, main_theme: theme, eligible: true,
      one_word: false, ladder_role: "theme_leader", theme_width_1045: 1,
      seal_money: 5e7, seal_retention: 0.8, auction_pct: 1, auction_strength: "strong",
      current_price: 10.2, execution_risk: "normal", limit_minute: 600,
      pk: { status, stage: streak === 1 ? "first_board" : streak <= 3 ? "confirmation" : "high_board", one_word: false, flags: [] },
      evidence: { captured_at: "2026-10-08T02:45:00Z" },
      invalidation: "收盘未封住",
    }));
    candidates[0] = {
      ...candidates[0]!,
      one_word: true,
      pk: { ...candidates[0]!.pk, one_word: true },
    };
    await pool.query(
      `INSERT INTO first_board_intraday_snapshot
         (scan_date,captured_at,source_timestamp,limit_up_count,limit_break_count,payload)
       VALUES ('2026-10-08', now(), now(), 5, 1, $1::jsonb)`,
      [JSON.stringify({ candidates, signals: candidates.slice(0, 1), theme_contexts: [], gaps: [] })],
    );
    const result = await buildUltraShortWatchlist(pool, { targetDate: "2026-10-09", now: NOW });
    expect(result.rows).toHaveLength(2);
    const codes = result.rows.map((row) => row.code);
    expect(codes).not.toContain("300001.SZ");
    expect(codes).not.toContain("600004.SH");
    expect(codes.every((code) => code.startsWith("600"))).toBe(true);
    expect(codes).toContain("600001.SH");
    const themeCounts = new Map<string, number>();
    for (const row of result.rows) {
      const theme = String(row.t_facts.main_theme ?? "");
      themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1);
    }
    for (const count of themeCounts.values()) expect(count).toBeLessThanOrEqual(2);
    const oneWordRow = result.rows.find((row) => row.code === "600001.SH")!;
    expect(oneWordRow.tags).toContain("一字延续");
    expect(oneWordRow.auction_expect.branch).toBe("one_word");
    expect(oneWordRow.risk_level).not.toBe("high");
    expect(oneWordRow.risk_flags).not.toContain("一字板，成交不确定");
    expect(await listWatchlist(pool, "2026-10-09")).toHaveLength(2);
  });

  it("低吸池：只从近 10 个交易日涨停/炸板池取候选并识别龙回头", async () => {
    await seedTradingDays(["2026-10-14", "2026-10-15"]);
    await insertLimitEvent({
      date: "2026-10-14", code: "600001.SH", name: "测试一", streak: 3, reason: "机器人概念",
      firstEventTime: "2026-10-14T02:00:00Z",
    });
    await pool.query(
      `INSERT INTO market_limit_event
         (trade_date,event_type,instrument_id,streak_count,reason,is_st,is_new,source_row_sha256)
       SELECT '2026-10-14'::date,'up',id,2,'机器人概念',false,false,'sha-restricted-300001'
         FROM market_instrument WHERE code='300001.SZ'
       ON CONFLICT DO NOTHING`,
    );
    const id = await instrumentId("600001.SH", "测试一", "stock");
    await pool.query(
      `INSERT INTO market_bar
         (instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,turnover,prev_close,channel)
       SELECT $1,'day', d, d::timestamp AT TIME ZONE 'UTC',
              CASE WHEN n=24 THEN 11.0 WHEN n=23 THEN 10.6 WHEN n<19 THEN 10.0+n*0.02 ELSE 10.3+(n-19)*0.02 END,
              CASE WHEN n=24 THEN 11.2 WHEN n=23 THEN 11.05 WHEN n<19 THEN 10.05+n*0.02 ELSE 10.35+(n-19)*0.02 END,
              CASE WHEN n=24 THEN 10.6 WHEN n=23 THEN 10.55 WHEN n<19 THEN 9.95+n*0.02 ELSE 10.25+(n-19)*0.02 END,
              CASE WHEN n=24 THEN 11.1 WHEN n=23 THEN 11.0 WHEN n<19 THEN 10.0+n*0.02 ELSE 10.3+(n-19)*0.02 END,
              CASE WHEN n=24 THEN 50 WHEN n=23 THEN 200 ELSE 100 END,
              2e8,
              CASE WHEN n=24 THEN 11.0 WHEN n=23 THEN 10.42 ELSE NULL END,
              'test'
         FROM (SELECT $2::date - (24 - n) AS d, n FROM generate_series(0,24) n) series
       ON CONFLICT (instrument_id,freq,bar_date,bar_time) DO UPDATE SET
         open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,
         volume=EXCLUDED.volume,turnover=EXCLUDED.turnover,prev_close=EXCLUDED.prev_close`,
      [id, "2026-10-15"],
    );
    await pool.query(
      `INSERT INTO market_limit_event
         (trade_date,event_type,instrument_id,streak_count,reason,is_st,is_new,source_row_sha256)
       SELECT '2026-10-14'::date,'up',id,1,'机器人概念',false,false,'sha-missing-bar-600005'
         FROM market_instrument WHERE code='600005.SH'
       ON CONFLICT DO NOTHING`,
    );
    const result = await queryLowBuyShapes(pool, "2026-10-15");
    const dragon = result.shapes.filter((shape) => shape.tags.includes("龙回头"));
    expect(dragon.length).toBeGreaterThan(0);
    expect(dragon[0]!.code).toBe("600001.SH");
    expect(dragon[0]!.stage).toBe("formed");
    expect(dragon[0]!.plan.trigger).toBe("long_huitou");
    expect(dragon[0]!.key_levels.pattern_low).not.toBeNull();
    expect(result.shapes.every((shape) => shape.code !== "300001.SZ")).toBe(true);
    expect(result.gaps.some((gap) => gap.includes("600005.SH"))).toBe(true);
  });

  it("日期解析：缺省 targetDate/dataDate 时按交易日历互推，缺日则 unavailable", async () => {
    const resolved = await resolveUltraShortDates(pool, { dataDate: "2026-09-17", now: NOW });
    expect(resolved.dates).toEqual({ target_date: TARGET_DATE, data_date: DATA_DATE });
    expect(resolved.gaps).toEqual([]);
    const back = await resolveUltraShortDates(pool, { targetDate: "2026-09-18", now: NOW });
    expect(back.dates).toEqual({ target_date: TARGET_DATE, data_date: DATA_DATE });
    const unavailable = await buildUltraShortWatchlist(pool, {});
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.gaps.length).toBeGreaterThan(0);
  });
});
