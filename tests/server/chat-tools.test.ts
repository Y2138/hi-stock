// 渐进式数据库发现、实时结构校验、领域写边界与批量行情测试
// - fetch_market_data 一次调用顺序处理多项并汇报聚合进度
import type { AgentContext } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../server/db/migrate.js";
import { buildChatTools } from "../../server/agent/tools.js";
import { acquireAgentMutationLock } from "../../server/agent/mutation-lock.js";
import { appendMessage, createSession } from "../../server/agent/repo.js";
import { buildSystemPrompt } from "../../server/agent/prompt.js";
import { createOnDemandToolSet } from "../../server/agent/tool-catalog.js";
import { HITHINK_CAPABILITIES } from "../../server/datasource/hithink-capabilities.js";
import { processHithinkResult } from "../../server/agent/hithink-result-processor.js";
import { queryLimitUpSignals } from "../../server/modules/market/limit-up-signals.js";
import { persistAndPublishSessionEvent } from "../../server/agent/events.js";
import { createDeepSeekWebResearchProvider } from "../../server/agent/web-research-provider.js";
import { storeBars } from "../../server/datasource/service.js";
import { recomputeIndicatorSeries } from "../../server/indicators/service.js";
import {
  evaluateLeftSideSignal,
  evaluateRightSideSignal,
  evaluateTrialStartSignal,
  findTrialStartMatch,
  inferStopLossMode,
} from "../../server/modules/plans/daily-context.js";
import { evaluateSwingSignal } from "../../server/modules/plans/swing-signals.js";
import { prepareTestDb, resetSchema, seedTestStrategy } from "./helpers.js";

const prepared = await prepareTestDb();

it("扶摇研究筛选不把未披露估值视为低估，并区分上游响应与全量覆盖", () => {
  const definition = HITHINK_CAPABILITIES.find((item) => item.name === "stock_valuation_snapshot")!;
  const payload = { total: 5000, item: [{ pe: null }, { pe: 8 }, { pe: -3 }, { pe: 20 }] };
  const filtered = processHithinkResult(definition, payload, { where: [{ field: "pe", op: "lt", value: 10 }] });
  expect(filtered.items).toEqual([{ pe: 8 }, { pe: -3 }]);
  expect(filtered).toMatchObject({ complete: true, complete_scope: "current_response", scanned_count: 4 });
  expect(processHithinkResult(definition, payload, { order_by: [{ field: "pe", direction: "asc" }] }).items)
    .toEqual([{ pe: -3 }, { pe: 8 }, { pe: 20 }, { pe: null }]);
  const nested = { item: [{ metrics: { roe: null } }, { metrics: { roe: 15 } }] };
  expect(() => processHithinkResult(definition, nested, { select: ["metrics.roee"] })).toThrow("不存在字段");
  const sparse = { item: [...Array.from({ length: 100 }, () => ({ pe: null })), { pe: 8, roe: 15 }] };
  expect(processHithinkResult(definition, sparse, { where: [{ field: "roe", op: "gt", value: 10 }] }).matched_count).toBe(1);
});

describe.skipIf(!prepared)("数据库查询与批量动作工具（stock_test 真实库）", () => {
  let pool: pg.Pool;
  let sessionId: string;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
    await seedTestStrategy(pool);
    await pool.query(
      "INSERT INTO market_instrument (code, name, kind) VALUES ('990002.SZ', '只读测试股份', 'stock')",
    );
    await pool.query(
      `INSERT INTO pool_membership (instrument_id, pool, role, effective_from)
       SELECT id, 'short', '观察', '2026-08-01' FROM market_instrument WHERE code = '990002.SZ'`,
    );
    const session = await createSession(pool, "只读测试");
    sessionId = session.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  function textOf(result: { content: { type: string; text?: string }[] }): unknown {
    return JSON.parse(result.content[0]!.text!);
  }

  it("任意标的研究一次返回最新正式画像、财报、估值与缺口，不要求入池且识别待重算", async () => {
    const id = (await pool.query<{ id: string }>(
      "INSERT INTO market_instrument (code,name,kind) VALUES ('990071.SZ','池外研究测试','stock') RETURNING id::text",
    )).rows[0]!.id;
    const bars = Array.from({ length: 80 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 3, 1 + index)).toISOString().slice(0, 10),
      open: 10 + index / 100, high: 10.2 + index / 100, low: 9.8 + index / 100,
      close: 10.1 + index / 100, volume: 100, adjustment: "forward" as const,
    }));
    await storeBars(pool, id, "day", bars, "test");
    const dirty = (await pool.query<{ instrument_id: string; freq: "day"; generation: string }>(
      "SELECT instrument_id::text, freq, generation::text FROM market_indicator_dirty WHERE instrument_id=$1", [id],
    )).rows[0]!;
    await recomputeIndicatorSeries(pool, dirty);
    await pool.query(
      `INSERT INTO fundamental_snapshot (instrument_id,as_of_date,report_period,roe,source,raw_summary)
       VALUES ($1,'2026-06-19','2026-03-31',12,'test','{"private_payload":"excluded"}')`, [id],
    );
    await pool.query(
      "INSERT INTO valuation_snapshot (instrument_id,as_of_date,pe_ttm,source) VALUES ($1,'2026-06-19',NULL,'test')", [id],
    );
    const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === "stock_research_query")!;
    const data = textOf(await tool.execute("research", { codes: ["990071.SZ", "123456.SZ"] })) as { items: Record<string, unknown>[] };
    expect(data.items[0]).toMatchObject({ code: "990071.SZ", status: "ready", profile_status: "ready",
      fundamental: { roe: 12, report_period: "2026-03-31" }, valuation: { pe_ttm: null } });
    expect(data.items[1]).toMatchObject({ code: "123456.SZ", status: "missing" });
    expect(JSON.stringify(data)).not.toContain("private_payload");
    expect((await pool.query("SELECT count(*)::int AS count FROM pool_membership WHERE instrument_id=$1", [id])).rows[0].count).toBe(0);
    await storeBars(pool, id, "day", [{ ...bars.at(-1)!, close: 11 }], "test");
    const stale = textOf(await tool.execute("research-stale", { codes: ["990071.SZ"] })) as { items: Record<string, unknown>[] };
    expect(stale.items[0]).toMatchObject({ status: "partial", profile_status: "stale" });
    await expect(tool.execute("research-invalid", { codes: ["990071.SZ"], sql: "select 1" } as never)).rejects.toThrow("参数校验失败");
  });

  it("试盘启动按近10日试盘、缩量回调和放量突破逐只确定性匹配", () => {
    const rows = Array.from({ length: 15 }, (_, index) => ({
      code: "990003.SZ",
      bar_date: `2026-08-${String(index + 1).padStart(2, "0")}`,
      open: index === 14 ? 11.8 : 10,
      high: index === 5 ? 10.5 : index === 14 ? 12.2 : index === 13 ? 11.7 : 10.2,
      low: index > 5 && index < 14 ? 9.2 : 9,
      close: index === 14 ? 12 : index === 13 ? 11.5 : 10,
      volume: index === 5 ? 300 : index === 14 ? 200 : 100,
    }));
    expect(findTrialStartMatch(rows)).toMatchObject({
      as_of: "2026-08-15",
      trial_date: "2026-08-06",
      close: 12,
      trial_high: 10.5,
      limit_up_volume_relief: false,
    });
    expect(evaluateTrialStartSignal(rows)).toMatchObject({
      price_signal: true,
      stage: "matched",
      conditions: {
        trial_day_found: true,
        pullback_above_trial_low: true,
        pullback_volume_below_trial: true,
        breakout_above_trial_high: true,
      },
      evidence: { trading_day_distance: 9 },
    });
    const touchedTrialLow = rows.map((row, index) => index === 6 ? { ...row, low: 9 } : row);
    expect(evaluateTrialStartSignal(touchedTrialLow)).toMatchObject({
      price_signal: false,
      stage: "pullback_low",
      conditions: { pullback_above_trial_low: false },
    });
  });

  it("左侧反转返回基础条件、形态质量分、确认窗口与ATR止损证据", () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      code: "990003.SZ",
      bar_date: `2026-08-${String(index + 1).padStart(2, "0")}`,
      open: index === 20 ? 8.8 : index === 19 ? 9.05 : 10,
      high: index === 20 ? 9.2 : index === 19 ? 9.1 : 10.2,
      low: index === 20 ? 8.5 : index === 19 ? 8.8 : 9.8,
      close: index === 20 ? 9 : index === 19 ? 9 : 10,
      volume: index === 20 ? 50 : 100,
      ma20: 10,
      rsi14: index === 20 ? 27.5 : 45,
      indicator_status: "ready" as const,
    }));
    const evaluation = evaluateLeftSideSignal(rows);
    expect(evaluation).toMatchObject({
      price_signal: true,
      stage: "matched",
      pattern: "缩量长下影",
      quality_factor: expect.any(Number),
      conditions: {
        five_day_decline: true,
        rsi_oversold: true,
        below_ma20: true,
        selloff_absorbed: true,
        long_lower_shadow: true,
      },
      evidence: {
        confirmation_must_exceed: 9.2,
        confirmation_price_cap: 9.27,
        confirmation_window_available: true,
      },
    });
    expect(evaluation!.evidence.five_day_return).toBeCloseTo(-0.1);
    expect(evaluation!.evidence.ma20_deviation).toBeCloseTo(-0.1);
    expect(evaluation!.quality_score).toBeCloseTo(60.98, 1);
    expect(evaluation!.evidence.atr14).toBeCloseTo(6.7 / 14);
    expect(evaluation!.evidence.initial_stop_at_price_cap).toBeLessThan(9.27);
  });

  it("右侧六条件与旧短线止损档位由服务层返回确定性结论", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      code: "990003.SZ",
      bar_date: `2026-08-${String(index + 1).padStart(2, "0")}`,
      open: index === 4 ? 10.8 : 10,
      high: index === 4 ? 11 : 10.2,
      low: 9.8,
      close: index === 4 ? 11 : 10,
      volume: index === 4 ? 60 : 100,
      ma5: index === 4 ? 10.5 : 9.9,
      ma10: index === 4 ? 10 : 9.8,
      ma20: index === 4 ? 9.5 : 9.4,
      dif: index === 4 ? 0.2 : 0.1,
      macd_hist: index === 4 ? 0.03 : 0.01,
      indicator_status: "ready" as const,
    }));
    expect(evaluateRightSideSignal(rows)).toMatchObject({
      passed_count: 6,
      price_signal: true,
      conditions: { volume_expanding: true },
      evidence: { limit_up: true, volume_threshold_ratio: 0.5 },
    });
    expect(inferStopLossMode("凶狠·快拉·护盘中", [])).toBe("ma5");
    expect(inferStopLossMode(null, ["股性：温和·慢拉·波动小"])).toBe("ma10");
    expect(inferStopLossMode("快拉·慢拉", [])).toBeNull();
  });

  it("波段四条件由独立工具全量扫描并排除已有持仓", async () => {
    const code = "990003.SZ";
    try {
      const rows = Array.from({ length: 40 }, (_, index) => {
        const close = index === 39 ? 11 : 20 - index * 0.25;
        return {
          bar_date: new Date(Date.UTC(2026, 6, 10 + index)).toISOString().slice(0, 10),
          open: index === 39 ? 10.8 : close,
          high: index === 39 ? 11.2 : close + 0.2,
          low: index === 39 ? 10.7 : close - 0.2,
          close,
          volume: index === 39 ? 50 : 100,
          rsi14: index === 39 ? 30 : null,
          indicator_status: "ready" as const,
        };
      });
      expect(evaluateSwingSignal(rows, "stock", 0.4)).toMatchObject({
        passed_count: 4,
        price_signal: true,
        conditions: {
          volume_contracted: true,
          reversal_candle: true,
          rsi_oversold: true,
          reward_risk_acceptable: true,
        },
        evidence: { confirmation_window_available: true },
      });

      const instrument = await pool.query<{ id: string }>(
        `INSERT INTO market_instrument (code, name, kind)
         VALUES ($1, '波段扫描测试股份', 'stock') RETURNING id::text`,
        [code],
      );
      const instrumentId = instrument.rows[0]!.id;
      await pool.query(
        `INSERT INTO pool_membership (instrument_id, pool, role, effective_from)
         VALUES ($1, 'long', '波段', '2026-07-01')`,
        [instrumentId],
      );
      await storeBars(pool, instrumentId, "day", rows.map((row) => ({
        date: row.bar_date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume!,
        adjustment: "forward",
      })), "test");
      const dirty = await pool.query<{ instrument_id: string; freq: "day"; generation: string }>(
        "SELECT instrument_id::text, freq, generation::text FROM market_indicator_dirty WHERE instrument_id = $1 AND freq = 'day'",
        [instrumentId],
      );
      expect(await recomputeIndicatorSeries(pool, dirty.rows[0]!)).toMatchObject({ status: "success", rowCount: 40 });
      await pool.query(
        "UPDATE market_stock_character_metric SET defense_recovery_ma10 = 0.4 WHERE instrument_id = $1",
        [instrumentId],
      );

      const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === "swing_signal_query")!;
      const signal = textOf(await tool.execute("tc-swing-signal", { date: "2026-08-18" })) as {
        status: string;
        member_count: number;
        completed_count: number;
        signal_count: number;
        signals: Array<{ code: string; passed_count: number }>;
      };
      expect(signal).toMatchObject({ status: "success", member_count: 1, completed_count: 1, signal_count: 1 });
      expect(signal.signals).toContainEqual(expect.objectContaining({ code, passed_count: 4 }));

      await pool.query(
        "INSERT INTO portfolio_position (instrument_id, quantity, cost_price, opened_at) VALUES ($1, 100, 11, '2026-08-18')",
        [instrumentId],
      );
      const held = textOf(await tool.execute("tc-swing-held", { date: "2026-08-18" })) as {
        signal_count: number;
        held_matched_count: number;
        suppressed_matches: Array<{ code: string; suppressed_by: string | null }>;
      };
      expect(held).toMatchObject({ signal_count: 0, held_matched_count: 1 });
      expect(held.suppressed_matches).toContainEqual(expect.objectContaining({ code, suppressed_by: "existing_position" }));
      await expect(tool.execute("tc-swing-strict", { date: "2026-08-18", sql: "select 1" } as never))
        .rejects.toThrow("参数校验失败");
    } finally {
      await pool.query(
        "DELETE FROM portfolio_position WHERE instrument_id = (SELECT id FROM market_instrument WHERE code = $1)",
        [code],
      );
      await pool.query(
        "DELETE FROM pool_membership WHERE instrument_id = (SELECT id FROM market_instrument WHERE code = $1)",
        [code],
      );
    }
  });

  it("工具集以纵向业务能力为先、数据库排障能力置后", () => {
    const tools = buildChatTools({ pool, sessionId });
    expect(tools.map((tool) => tool.name)).toEqual([
      "portfolio_context_query",
      "pool_context_query",
      "job_context_query",
      "strategy_document_query",
      "hithink_catalog",
      "hithink_query",
      "instrument_search",
      "stock_research_query",
      "market_snapshot_query",
      "board_query",
      "market_event_query",
      "indicator_query",
      "daily_plan_context_query",
      "swing_signal_query",
      "limit_up_signal_query",
      "memory_query",
      "web_search",
      "pool_onboard",
      "portfolio_write",
      "pool_write",
      "job_write",
      "finalize_backtest",
      "memory_write",
      "strategy_publish_request",
      "analysis_run",
      "strategy_screen_query",
      "read_backtest_source",
      "run_backtest",
      "fetch_market_data",
      "fetch_hithink_data",
      "trigger_job",
      "database_schema",
      "database_query",
    ]);
    expect(tools.every((tool) => {
      const schema = tool.parameters as {
        type?: string;
        properties?: Record<string, unknown>;
        anyOf?: Array<{ type?: string }>;
      };
      return schema.type === "object" && Object.keys(schema.properties ?? {}).length > 0 &&
        (schema.anyOf === undefined || schema.anyOf.every((branch) => branch.type === "object"));
    })).toBe(true);
    const portfolioSchema = tools.find((tool) => tool.name === "portfolio_write")!.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(portfolioSchema.properties ?? {})).toEqual(["reason", "changes"]);
    expect(Object.keys(portfolioSchema.properties ?? {})).not.toEqual(expect.arrayContaining([
      "snap_date",
      "total_asset",
      "cash",
      "closed_pnl",
    ]));
    expect(portfolioSchema.required).toEqual(["reason", "changes"]);
    expect(
      tools
        .filter((tool) => ["pool_onboard", "portfolio_write", "pool_write", "job_write", "finalize_backtest", "memory_write", "pool_attention_write", "daily_plan_write", "auction_assessment_write", "strategy_publish_request", "analysis_run", "strategy_screen_query", "run_backtest", "fetch_market_data", "fetch_hithink_data", "hithink_query", "trigger_job"].includes(tool.name))
        .every((tool) => tool.executionMode === "sequential"),
    ).toBe(true);
    const runBacktest = tools.find((tool) => tool.name === "run_backtest")!;
    expect(runBacktest.description).toContain("daily_returns 必须有 1–50000 个唯一日期项");
    expect(runBacktest.description).toContain("metrics 必须是最多100项的扁平对象");
    expect(runBacktest.description).toContain("limit_up_universe=mainboard/all");
    expect(runBacktest.description).toContain("eventsOn(date,type?)");
    expect(Object.keys((runBacktest.parameters as { properties?: Record<string, unknown> }).properties ?? {}))
      .toEqual(expect.arrayContaining(["market_event_types", "limit_up_universe"]));
    expect((runBacktest.parameters as { properties?: { source_code?: { description?: string } } })
      .properties?.source_code?.description).toContain("必须返回非空 daily_returns");
    expect(tools.find((tool) => tool.name === "pool_onboard")!.description)
      .toContain("当前买入信号不参与入池");
    const poolWriteFields = Object.keys((tools.find((tool) => tool.name === "pool_write")!.parameters as {
      properties?: { operations?: { items?: { properties?: Record<string, unknown> } } };
    }).properties?.operations?.items?.properties ?? {});
    expect(poolWriteFields).toEqual([
      "action", "code", "pool", "attention_reason", "attention_from", "attention_until",
      "effective_from", "note", "board_codes",
    ]);
    const databaseQuery = tools.find((tool) => tool.name === "database_query")!;
    const queryItem = (databaseQuery.parameters as {
      properties?: {
        queries?: { items?: {
          properties?: {
            schema_hash?: { description?: string };
            filters?: { items?: { anyOf?: unknown[]; description?: string } };
          };
          required?: string[];
        } };
      };
    }).properties?.queries?.items;
    const filterSchema = queryItem?.properties?.filters?.items;
    expect(filterSchema?.anyOf).toHaveLength(2);
    expect(filterSchema?.description).toContain("过滤器二选一");
    expect(queryItem?.required).not.toContain("schema_hash");
    expect(queryItem?.properties?.schema_hash?.description).toContain("兼容旧调用");
    expect(databaseQuery.label).toContain("低优先级");
    expect(databaseQuery.description).toContain("最多 5 项、每项 100 行");
    expect(tools.at(-1)?.name).toBe("database_query");
  });

  it("任务会话按提示词声明集裁剪并保留 Web，未知任务不获得专属写入", () => {
    const full = buildChatTools({ pool, sessionId });
    const auction = buildChatTools({ pool, sessionId }, { kind: "job", jobCode: "auction_opportunity_assessment" });
    expect(auction.map((tool) => tool.name)).toEqual([
      "auction_context_query",
      "strategy_document_query",
      "web_search",
      "auction_assessment_write",
      "fetch_hithink_data",
    ]);
    expect(auction.map((tool) => tool.name)).not.toContain("daily_plan_context_query");
    const dailyPlan = buildChatTools({ pool, sessionId }, { kind: "job", jobCode: "daily_plan_flow" });
    expect(dailyPlan.map((tool) => tool.name)).toEqual([
      "job_context_query",
      "strategy_document_query",
      "daily_plan_context_query",
      "swing_signal_query",
      "limit_up_signal_query",
      "web_search",
      "pool_attention_write",
      "daily_plan_write",
    ]);
    const midweek = buildChatTools({ pool, sessionId }, { kind: "job", jobCode: "midweek_check" });
    expect(midweek.map((tool) => tool.name)).toEqual([
      "pool_context_query",
      "job_context_query",
      "strategy_document_query",
      "daily_plan_context_query",
      "web_search",
    ]);
    const weekly = buildChatTools({ pool, sessionId }, { kind: "job", jobCode: "weekly_review" });
    expect(weekly.map((tool) => tool.name)).toEqual([
      "portfolio_context_query",
      "pool_context_query",
      "strategy_document_query",
      "daily_plan_context_query",
      "swing_signal_query",
      "web_search",
      "analysis_run",
    ]);
    const fallback = buildChatTools({ pool, sessionId }, { kind: "job", jobCode: "unknown_flow" });
    expect(fallback.map((tool) => tool.name)).toEqual(full.map((tool) => tool.name));
    expect(fallback.map((tool) => tool.name)).not.toContain("daily_plan_write");
    expect(buildChatTools({ pool, sessionId }, { kind: "job", jobCode: "constructor" }).map((tool) => tool.name))
      .toEqual(full.map((tool) => tool.name));
    const preloaded = createOnDemandToolSet(dailyPlan, dailyPlan.map((tool) => tool.name));
    expect(preloaded.initialTools.map((tool) => tool.name)).toEqual([
      "tool_catalog", ...dailyPlan.map((tool) => tool.name),
    ]);
    expect(() => createOnDemandToolSet(auction, ["daily_plan_write"]))
      .toThrow("预加载工具不在当前授权目录");
  });

  it("按需工具目录初始只暴露元信息并仅加载当前会话授权工具", async () => {
    const tools = buildChatTools({ pool, sessionId });
    const toolSet = createOnDemandToolSet(tools);
    expect(toolSet.initialTools.map((tool) => tool.name)).toEqual(["tool_catalog"]);
    const catalog = toolSet.initialTools[0]!;
    expect(catalog.description).toContain("portfolio_context_query");
    await expect(catalog.execute("tc-catalog-unknown", { names: ["auction_context_query"] }))
      .rejects.toThrow("当前会话没有这些工具");
    await expect(catalog.execute("tc-catalog-duplicate", {
      names: ["portfolio_context_query", "portfolio_context_query"],
    })).rejects.toThrow("不得重复");
    await expect(catalog.execute("tc-catalog-too-many", {
      names: tools.slice(0, 9).map((tool) => tool.name),
    })).rejects.toThrow("1-8");

    expect(textOf(await catalog.execute("tc-catalog-load", {
      names: ["pool_context_query", "strategy_document_query"],
    }))).toMatchObject({ loaded_count: 2, available_count: tools.length });
    const next = toolSet.syncContext({ tools: toolSet.initialTools } as AgentContext)!;
    expect(next.tools?.map((tool) => tool.name)).toEqual([
      "tool_catalog",
      "pool_context_query",
      "strategy_document_query",
    ]);
    expect(toolSet.syncContext(next)).toBeUndefined();

    for (const requested of ["database_schema", "database_query"]) {
      const databaseToolSet = createOnDemandToolSet(tools);
      const loaded = textOf(await databaseToolSet.initialTools[0]!.execute(
        `tc-catalog-${requested}`,
        { names: [requested] },
      ));
      expect(loaded).toMatchObject({
        loaded: expect.arrayContaining(["database_schema", "database_query"]),
        newly_loaded: expect.arrayContaining(["database_schema", "database_query"]),
        loaded_count: 2,
      });
      expect(databaseToolSet.syncContext({ tools: databaseToolSet.initialTools } as AgentContext)!
        .tools?.map((tool) => tool.name)).toEqual([
          "tool_catalog",
          "database_schema",
          "database_query",
        ]);
    }
  });

  it("扶摇目录覆盖59项能力，临时查询处理完整响应且不写快照", async () => {
    const calls: Array<{ capability: string; parameters: Record<string, unknown> }> = [];
    const tools = buildChatTools({
      pool,
      sessionId,
      queryHithink: async (capability, parameters) => {
        calls.push({ capability, parameters });
        return {
          timestamp: 1_786_265_600_000,
          board_code: "885001.TI",
          board_name: "机器人概念",
          item: [
            { thscode: "000001.SZ", ticker: "000001", name: "甲公司", score: 1 },
            { thscode: "000002.SZ", ticker: "000002", name: "乙公司", score: 3 },
            { thscode: "600001.SH", ticker: "600001", name: "丙公司", score: 2 },
          ],
        };
      },
    });
    expect(HITHINK_CAPABILITIES).toHaveLength(59);
    const catalog = tools.find((tool) => tool.name === "hithink_catalog")!;
    const searched = textOf(await catalog.execute("tc-hithink-search", {
      action: "search",
      query: "概念板块成分",
    })) as { total_capabilities: number; capabilities: Array<{ name: string }> };
    expect(searched.total_capabilities).toBe(59);
    expect(searched.capabilities.map((item) => item.name)).toContain("board_constituents");
    const described = textOf(await catalog.execute("tc-hithink-describe", {
      action: "describe",
      names: ["board_constituents"],
    })) as { capabilities: Array<{ persistable: boolean; parameters_schema: { properties: Record<string, unknown> } }>; instruction: string };
    expect(described.capabilities[0]!.persistable).toBe(false);
    expect(described.instruction).toContain("fetch_hithink_data");
    const auctionDescribed = textOf(await catalog.execute("tc-hithink-describe", {
      action: "describe",
      names: ["auction_snapshot"],
    })) as { capabilities: Array<{ persistable: boolean }> };
    expect(auctionDescribed.capabilities[0]!.persistable).toBe(true);
    expect(described.capabilities[0]!.parameters_schema.properties).toHaveProperty("board");

    const before = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM hithink_dataset_snapshot");
    const query = tools.find((tool) => tool.name === "hithink_query")!;
    const queryResponse = await query.execute("tc-hithink-query", {
      capability: "board_constituents",
      parameters: { board: "机器人概念", type: "concept" },
      result: {
        select: ["thscode", "name", "score"],
        where: [{ field: "score", op: "gte", value: 2 }],
        order_by: [{ field: "score", direction: "desc" }],
        limit: 1,
      },
    });
    const result = textOf(queryResponse) as {
      transient: boolean;
      persisted: boolean;
      scanned_count: number;
      matched_count: number;
      returned_count: number;
      complete: boolean;
      next_offset: number;
      items: Array<Record<string, unknown>>;
    };
    expect(queryResponse.details).toMatchObject({
      ephemeral_data_result: true,
      capability: "board_constituents",
      scanned_count: 3,
      returned_count: 1,
    });
    expect(result).toMatchObject({
      transient: true,
      persisted: false,
      scanned_count: 3,
      matched_count: 2,
      returned_count: 1,
      complete: false,
      next_offset: 1,
      items: [{ thscode: "000002.SZ", name: "乙公司", score: 3 }],
    });
    expect(calls).toEqual([{
      capability: "board_constituents",
      parameters: { board: "机器人概念", type: "concept" },
    }]);
    await expect(query.execute("tc-hithink-invalid", {
      capability: "board_constituents",
      parameters: { board: "机器人概念", path: "/api/private" },
    })).rejects.toThrow("参数校验失败");
    expect(calls).toHaveLength(1);

    await expect(query.execute("tc-hithink-sync-only", {
      capability: "market_dump_daily_k",
      parameters: {},
    })).rejects.toThrow("只能通过显式后台同步使用");
    expect(calls).toHaveLength(1);

    const largeQuery = buildChatTools({
      pool,
      sessionId,
      queryHithink: async () => ({
        timestamp: 1_786_265_600_000,
        item: Array.from({ length: 200 }, (_, index) => ({
          thscode: `${String(index).padStart(6, "0")}.SZ`,
          name: `样本${index}`,
          summary: "x".repeat(1000),
        })),
      }),
    }).find((tool) => tool.name === "hithink_query")!;
    const largeResponse = await largeQuery.execute("tc-hithink-large", {
      capability: "board_constituents",
      parameters: { board: "大型概念", type: "concept" },
      result: { limit: 100 },
    });
    const largeResult = textOf(largeResponse) as {
      matched_count: number;
      returned_count: number;
      complete: boolean;
      next_offset: number;
      remaining_count: number;
      truncation_reason: string;
    };
    expect(Buffer.byteLength(JSON.stringify(largeResult), "utf8")).toBeLessThan(64 * 1024);
    expect(largeResult.matched_count).toBe(200);
    expect(largeResult.returned_count).toBeLessThan(100);
    expect(largeResult.complete).toBe(false);
    expect(largeResult.next_offset).toBe(largeResult.returned_count);
    expect(largeResult.remaining_count).toBe(200 - largeResult.returned_count);
    expect(largeResult.truncation_reason).toContain("对象边界缩减");

    await appendMessage(pool, {
      session_id: sessionId,
      seq: 98,
      role: "tool",
      json: {
        role: "toolResult",
        toolCallId: "tc-hithink-large",
        toolName: "hithink_query",
        isError: false,
        content: largeResponse.content,
        details: largeResponse.details,
        timestamp: Date.now(),
      },
    });
    const persisted = await pool.query<{ content: string }>(
      "SELECT content::text FROM chat_message WHERE session_id=$1 AND seq=98",
      [sessionId],
    );
    expect(persisted.rows[0]!.content).not.toContain("样本0");
    expect(persisted.rows[0]!.content).not.toContain("summary");
    expect(persisted.rows[0]!.content).toContain("数据明细不会保存到会话");
    const audits = await pool.query<{ args: unknown }>(
      "SELECT args FROM agent_tool_audit WHERE tool_name='hithink_query' ORDER BY id",
    );
    expect(JSON.stringify(audits.rows)).not.toContain("样本0");
    expect(JSON.stringify(audits.rows)).not.toContain("summary");
    const after = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM hithink_dataset_snapshot");
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it("纵向上下文一次返回组合、标的池、作业与按需策略正文", async () => {
    const tools = buildChatTools({ pool, sessionId });
    await pool.query(
      `INSERT INTO portfolio_position (instrument_id, quantity, cost_price, opened_at)
       SELECT id, 10, 10, '2026-08-01' FROM market_instrument WHERE code = '990002.SZ'
       ON CONFLICT (instrument_id) DO UPDATE SET quantity = 10, cost_price = 10`,
    );
    const portfolio = textOf(await tools.find((tool) => tool.name === "portfolio_context_query")!
      .execute("tc-portfolio-context", { codes: ["990002.SZ"], recent_change_limit: 10 })) as {
        summary: { position_count: number };
      };
    expect(portfolio.summary.position_count).toBe(1);

    const pools = textOf(await tools.find((tool) => tool.name === "pool_context_query")!
      .execute("tc-pool-context", { pools: ["short"], codes: ["990002.SZ"] })) as {
        pools: Array<{ members: Array<{ code: string }> }>;
      };
    expect(pools.pools[0]!.members).toContainEqual(expect.objectContaining({ code: "990002.SZ" }));

    const poolSummary = textOf(await tools.find((tool) => tool.name === "pool_context_query")!
      .execute("tc-pool-context-summary", { pools: ["short"] })) as {
        pools: Array<{ detail_level: string; members: Array<Record<string, unknown>> }>;
      };
    expect(poolSummary.pools[0]!.detail_level).toBe("summary");
    expect(poolSummary.pools[0]!.members[0]).toMatchObject({ detail_available: true });
    expect(poolSummary.pools[0]!.members[0]).not.toHaveProperty("evaluation_summary");

    const jobs = textOf(await tools.find((tool) => tool.name === "job_context_query")!
      .execute("tc-job-context", { job_codes: ["daily_plan_flow"], recent_runs_per_job: 2 })) as {
        jobs: Array<{ definition: { code: string } }>;
      };
    expect(jobs.jobs.map((job) => job.definition.code)).toEqual(["daily_plan_flow"]);

    const strategy = textOf(await tools.find((tool) => tool.name === "strategy_document_query")!
      .execute("tc-strategy-context", { codes: ["test_strategy"] })) as {
        documents: Array<{ code: string; current_content: string }>;
      };
    expect(strategy.documents[0]).toMatchObject({ code: "test_strategy" });
    expect(strategy.documents[0]!.current_content).toContain("# 测试当前策略");
    const currentSignal = textOf(await tools.find((tool) => tool.name === "limit_up_signal_query")!
      .execute("tc-limit-snapshot", { date: "2026-08-18" })) as { strategy_revision_id: string };
    const currentRevision = (await pool.query("SELECT current_revision_id::text FROM strategy_document WHERE code='limit_up_board'")).rows[0]!.current_revision_id;
    expect(currentSignal.strategy_revision_id).toBe(currentRevision);
    expect(await queryLimitUpSignals(pool, "2026-08-18", null)).toMatchObject({
      status: "unavailable", strategy_revision_id: null, signals: [],
    });
  });

  it("database_query 超过总字节预算时返回可续页的明确截断", async () => {
    const prefix = "9988";
    try {
      await pool.query(
        `INSERT INTO market_instrument (code, name, kind)
         SELECT $1 || lpad(value::text, 4, '0') || '.SZ', repeat('完整查询结果', 300), 'stock'
           FROM generate_series(1, 100) value`,
        [prefix],
      );
      const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === "database_query")!;
      const result = await tool.execute("tc-full-query-result", {
        queries: [{
          table: "market_instrument",
          columns: ["code", "name"],
          filters: [{ column: "code", op: "like", value: `${prefix}%` }],
          order_by: [{ column: "code", direction: "asc" }],
          limit: 100,
        }],
      });
      const data = textOf(result) as {
        queries: Array<{ rows: unknown[]; truncated: boolean; next_offset: number; truncation_reason: string }>;
      };
      expect(Buffer.byteLength(result.content[0]!.type === "text" ? result.content[0]!.text : "", "utf8"))
        .toBeLessThanOrEqual(128 * 1024);
      expect(data.queries[0]!.rows.length).toBeLessThan(100);
      expect(data.queries[0]).toMatchObject({ truncated: true, next_offset: data.queries[0]!.rows.length });
      expect(data.queries[0]!.truncation_reason).toContain("使用纵向业务工具");
    } finally {
      await pool.query("DELETE FROM market_instrument WHERE code LIKE $1", [`${prefix}%`]);
    }
  });

  it("web_search 复用 DeepSeek 原生搜索、过滤白名单并隐藏审计中的原始查询", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const provider = createDeepSeekWebResearchProvider({
      resolveApiKey: async () => "test-deepseek-key",
      now: () => new Date("2026-08-20T08:00:00Z"),
      fetchImpl: async (url, init) => {
        expect(url).toBe("https://api.deepseek.com/anthropic/v1/messages");
        expect(new Headers(init?.headers).get("x-api-key")).toBe("test-deepseek-key");
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          content: [
            {
              type: "text",
              citations: [
                { url: "https://www.cninfo.com.cn/new/disclosure/detail", cited_text: "上市公司公告摘要" },
                { url: "https://example.com/untrusted", cited_text: "不应返回" },
              ],
            },
            {
              type: "web_search_tool_result",
              content: [
                {
                  type: "web_search_result",
                  url: "https://www.cninfo.com.cn/new/disclosure/detail",
                  title: "测试公告",
                  page_age: "2026-08-19",
                },
                {
                  type: "web_search_result",
                  url: "https://example.com/untrusted",
                  title: "非白名单来源",
                },
              ],
            },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const tool = buildChatTools({ pool, sessionId, webResearch: provider })
      .find((item) => item.name === "web_search")!;
    const result = textOf(await tool.execute("tc-web-search", {
      query: "测试公司最新公告",
      domains: ["cninfo.com.cn"],
      recency_days: 7,
      max_results: 5,
    })) as { external_untrusted: boolean; sources: Array<{ domain: string; snippet: string }> };
    expect(result.external_untrusted).toBe(true);
    expect(result.sources).toEqual([expect.objectContaining({
      domain: "cninfo.com.cn",
      snippet: "上市公司公告摘要",
    })]);
    expect(requestBody).toMatchObject({
      model: "deepseek-v4-flash",
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    });
    const audit = await pool.query<{ args: unknown }>(
      "SELECT args FROM agent_tool_audit WHERE tool_name='web_search' AND status='ok' ORDER BY id DESC LIMIT 1",
    );
    expect(JSON.stringify(audit.rows[0]!.args)).not.toContain("测试公司最新公告");
    await expect(tool.execute("tc-web-domain", {
      query: "测试",
      domains: ["example.com"],
    } as never)).rejects.toThrow("参数校验失败");
  });

  it("市场领域工具始终注册并按严格参数约束执行", async () => {
    const candidateNames = [
      "instrument_search",
      "stock_research_query",
      "market_snapshot_query",
      "board_query",
      "market_event_query",
      "indicator_query",
    ];
    const tools = buildChatTools({ pool, sessionId });
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(candidateNames));
    expect(tools.map((tool) => tool.name)).not.toContain("web_research");
    expect(tools.map((tool) => tool.name)).toContain("daily_plan_context_query");
    expect(tools.map((tool) => tool.name)).toContain("swing_signal_query");
    expect(tools.map((tool) => tool.name)).toContain("limit_up_signal_query");
    const limitScore = tools.find((tool) => tool.name === "limit_up_signal_query")!;
    expect(textOf(await limitScore.execute("tc-limit-score", { date: "2026-08-17" }))).toMatchObject({
      date: "2026-08-17",
      status: "success",
      candidate_count: 0,
      signal_count: 0,
      candidates: [],
    });
    await expect(limitScore.execute("tc-limit-score-strict", { date: "2026-08-17", page: 1 } as never))
      .rejects.toThrow("参数校验失败");

    const schema = tools.find((tool) => tool.name === "database_schema")!;
    const schemaResult = await schema.execute("tc-pool-memory-schema", { operation: "list_tables" });
    const tableNames = (textOf(schemaResult) as { tables: Array<{ table: string }> }).tables
      .map((table) => table.table);
    expect(tableNames).toContain("pool_membership");
    expect(tableNames).toContain("agent_memory_artifact");
    expect(tableNames).not.toContain("watchlist_entry");
    expect(tableNames).not.toEqual(expect.arrayContaining([
      "portfolio_position_snapshot_daily",
      "portfolio_account_snapshot",
      "portfolio_account_state",
    ]));

    const search = tools.find((tool) => tool.name === "instrument_search")!;
    expect(textOf(await search.execute("tc-market-search", { q: "990002", limit: 5 })))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "990002.SZ" })]));
    await expect(search.execute("tc-market-strict", {
      q: "990002",
      sql: "SELECT * FROM market_instrument",
      url: "https://example.invalid",
    } as never)).rejects.toThrow("参数校验失败");

    const instrument = await pool.query<{ id: string }>(
      "SELECT id::text FROM market_instrument WHERE code = '990002.SZ'",
    );
    const instrumentId = instrument.rows[0]!.id;
    await storeBars(pool, instrumentId, "day", Array.from({ length: 21 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 6, index + 26)).toISOString().slice(0, 10);
      const close = index + 10;
      return { date, open: close, high: close + 1, low: close - 1, close, volume: 1000 + index, adjustment: "forward" };
    }), "test");
    const dirty = await pool.query<{ instrument_id: string; freq: "day"; generation: string }>(
      "SELECT instrument_id::text, freq, generation::text FROM market_indicator_dirty WHERE instrument_id = $1 AND freq = 'day'",
      [instrumentId],
    );
    expect(await recomputeIndicatorSeries(pool, dirty.rows[0]!)).toMatchObject({ status: "success", rowCount: 21 });
    const indicator = tools.find((tool) => tool.name === "indicator_query")!;
    const indicatorResult = textOf(await indicator.execute("tc-market-indicator", {
      codes: ["990002.SZ"],
      freq: "day",
      end: "2026-08-15",
      limit: 10,
    })) as Array<{ status: string; values: Array<{ close: number; volume: number; rsi14: number | null }> }>;
    expect(indicatorResult[0]!.status).toBe("success");
    expect(indicatorResult[0]!.values).toHaveLength(10);
    expect(indicatorResult[0]!.values.at(-1)).toMatchObject({ close: 30, volume: 1020, rsi14: 100 });

    await pool.query(
      `INSERT INTO market_special_sync_run
         (dataset, target_date, status, completed_pages, total_pages, row_count, gaps, finished_at)
       VALUES ('limit_up', '2026-08-18', 'success', 1, 1, 1, '[]', now());
       INSERT INTO market_special_sync_run
         (dataset, target_date, status, completed_pages, total_pages, row_count, gaps, finished_at)
       VALUES ('limit_down', '2026-08-18', 'success', 0, 0, 0, '[]', now());
       INSERT INTO market_limit_event
         (trade_date, event_type, instrument_id, event_price, source_payload, source_row_sha256)
       SELECT '2026-08-18', 'up', id, 12.34,
              '{"provider_secret":"MARKET_PAYLOAD_MUST_NOT_ESCAPE"}'::jsonb,
              'market-tool-test'
         FROM market_instrument WHERE code='990002.SZ'
       ON CONFLICT (trade_date, event_type, instrument_id) DO UPDATE
         SET source_payload=EXCLUDED.source_payload`,
    );
    const dailyContext = tools.find((tool) => tool.name === "daily_plan_context_query")!;
    await pool.query(
      `UPDATE pool_membership
          SET stock_character = '凶狠·快拉·护盘中', tags = '["股性：快拉"]'
        WHERE instrument_id = $1 AND effective_to IS NULL`,
      [instrumentId],
    );
    await pool.query(
      `INSERT INTO portfolio_position (instrument_id, quantity, cost_price, opened_at)
       VALUES ($1, 10, 20, '2026-08-01')
       ON CONFLICT (instrument_id) DO UPDATE SET quantity = 10, cost_price = 20, opened_at = '2026-08-01'`,
      [instrumentId],
    );
    const dailyContextResult = textOf(await dailyContext.execute("tc-daily-context", { date: "2026-08-18" })) as {
      trial_start_scan: {
        stock_member_count: number;
        completed_count: number;
        matches: unknown[];
        near_candidates: unknown[];
        screened_out: unknown[];
      };
      right_side_signal_scan: { stock_member_count: number; completed_count: number };
      left_reversal_scan: {
        stock_member_count: number;
        completed_count: number;
        matches: unknown[];
        near_candidates: unknown[];
        screened_out: unknown[];
        gaps: Array<{ code: string }>;
      };
      signal_selection: { priority: string[]; selected_count: number };
      positions: {
        stop_loss_strategy_count: number;
        items: Array<{ code: string; stop_loss_mode: string; stop_loss_mode_source: string }>;
      };
      market_structure_sync: { datasets: Array<{ dataset: string; valid_empty: boolean }> };
    };
    expect(dailyContextResult.trial_start_scan).toMatchObject({ stock_member_count: 1, completed_count: 1 });
    expect([
      ...dailyContextResult.trial_start_scan.matches,
      ...dailyContextResult.trial_start_scan.near_candidates,
      ...dailyContextResult.trial_start_scan.screened_out,
    ]).toHaveLength(dailyContextResult.trial_start_scan.completed_count);
    expect(dailyContextResult.right_side_signal_scan).toMatchObject({ stock_member_count: 1, completed_count: 0 });
    expect(dailyContextResult.left_reversal_scan).toMatchObject({ stock_member_count: 1, completed_count: 1 });
    expect([
      ...dailyContextResult.left_reversal_scan.matches,
      ...dailyContextResult.left_reversal_scan.near_candidates,
      ...dailyContextResult.left_reversal_scan.screened_out,
    ]).toHaveLength(dailyContextResult.left_reversal_scan.completed_count);
    expect(dailyContextResult.left_reversal_scan.gaps).toEqual([]);
    expect(dailyContextResult.signal_selection.priority).toEqual(["right_side", "left_reversal", "trial_start"]);
    expect(dailyContextResult.signal_selection.selected_count).toBe(0);
    expect(dailyContextResult.positions.stop_loss_strategy_count).toBe(1);
    expect(dailyContextResult.positions.items).toContainEqual(expect.objectContaining({
      code: "990002.SZ",
      stop_loss_mode: "ma5",
      stop_loss_mode_source: "strategy",
    }));
    expect(dailyContextResult.market_structure_sync.datasets).toContainEqual(expect.objectContaining({
      dataset: "limit_down",
      valid_empty: true,
    }));
    await expect(dailyContext.execute("tc-daily-context-strict", { date: "2026-08-18", sql: "select 1" } as never))
      .rejects.toThrow("参数校验失败");
    const event = tools.find((tool) => tool.name === "market_event_query")!;
    const eventResult = await event.execute("tc-market-event", {
      date: "2026-08-18",
      dataset: "limit_up",
      page: 1,
      size: 20,
    });
    expect(JSON.stringify(eventResult)).not.toContain("source_payload");
    expect(JSON.stringify(eventResult)).not.toContain("MARKET_PAYLOAD_MUST_NOT_ESCAPE");
  });

  it("execute 入口独立拒绝未知字段、歧义操作和无效日期", async () => {
    const tools = buildChatTools({ pool, sessionId, fetchMarket: async () => {
      throw new Error("校验失败时不应调用 datasource");
    } });
    const query = tools.find((tool) => tool.name === "database_query")!;
    await expect(
      query.execute("tc-strict-query", {
        sql: "SELECT * FROM market_instrument",
        queries: [],
      } as never),
    ).rejects.toThrow("参数校验失败");
    const cyclic: Record<string, unknown> = { operation: "catalog" };
    cyclic.self = cyclic;
    await expect(query.execute("tc-cyclic", cyclic as never)).rejects.toThrow("可序列化");

    const change = tools.find((tool) => tool.name === "portfolio_write")!;
    await expect(
      change.execute("tc-ambiguous-change", {
        reason: "缺失领域必填参数必须拒绝",
        code: "990002.SZ",
        kind: "buy",
        change_date: "2026-08-17",
        decision_origin: "strategy_signal",
        execution_compliance: "matched",
      }),
    ).rejects.toThrow("必须携带正数 quantity 与 price");
    await expect(change.execute("tc-retired-account-action", {
      action: "upsert_account_snapshot",
      reason: "退役账户动作必须拒绝",
      snap_date: "2026-08-18",
      total_asset: 100,
      cash: 20,
      closed_pnl: 0,
    } as never)).rejects.toThrow("参数校验失败");
    await expect(
      tools.find((tool) => tool.name === "memory_write")!.execute("tc-sensitive-smuggle", {
        reason: "未知敏感字段必须拒绝",
        action: "create",
        title: "敏感字段测试",
        category: "research_method",
        summary: "应被未知字段拒绝",
        content: "无敏感正文",
        tags: [],
        scope: "测试",
        evidence: "测试",
        last_verified_at: "2026-08-19T08:00:00Z",
        api_key: "不得进入领域工具",
      } as never),
    ).rejects.toThrow("参数校验失败");

    const fetch = tools.find((tool) => tool.name === "fetch_market_data")!;
    await expect(
      fetch.execute("tc-invalid-date", {
        requests: [{ code: "A.SZ", freq: "day", start: "2026-02-30", end: "2026-02-01" }],
      }),
    ).rejects.toThrow("有效日历日期");
    await expect(
      fetch.execute("tc-reversed-date", {
        requests: [{ code: "A.SZ", freq: "day", start: "2026-08-03", end: "2026-08-01" }],
      }),
    ).rejects.toThrow("日期范围错误");
    const audit = await pool.query(
      "SELECT args FROM agent_tool_audit WHERE status = 'error' ORDER BY id DESC LIMIT 1",
    );
    expect(audit.rows[0]!.args).toMatchObject({ redacted: true });
    expect(JSON.stringify(audit.rows[0]!.args)).not.toContain("2026-08-03");
  });

  it("数据库级 advisory lock 阻止另一个对话同时执行写工具", async () => {
    const lockClient = await pool.connect();
    const calls: string[] = [];
    try {
      await lockClient.query("BEGIN");
      await acquireAgentMutationLock(lockClient);
      const fetch = buildChatTools({
        pool,
        sessionId,
        fetchMarket: async (request) => {
          calls.push(request.code);
          return {
            code: request.code,
            freq: request.freq,
            channel: "fake",
            rowsWritten: 0,
            fetchRunId: "0",
            firstDate: request.start,
            lastDate: request.end,
          };
        },
      }).find((tool) => tool.name === "fetch_market_data")!;
      const change = buildChatTools({ pool, sessionId }).find((tool) => tool.name === "memory_write")!;
      await expect(
        change.execute("tc-busy-change", {
          reason: "锁占用时不得创建提案或写库",
          action: "create",
          title: "锁测试方法",
          category: "research_method",
          summary: "验证锁占用",
          content: "锁占用时不得写入",
          tags: [],
          scope: "测试",
          evidence: "永久测试",
          last_verified_at: "2026-08-19T08:00:00Z",
        }),
      ).rejects.toThrow("另一对话正在修改当前数据库");
      await expect(
        fetch.execute("tc-busy", {
          requests: [{ code: "A.SZ", freq: "day", start: "2026-08-01", end: "2026-08-01" }],
        }),
      ).rejects.toThrow("另一对话正在修改当前数据库");
      expect(calls).toEqual([]);
      const instrument = await pool.query(
        "SELECT name FROM market_instrument WHERE code = '990002.SZ'",
      );
      expect(instrument.rows[0]!.name).toBe("只读测试股份");
    } finally {
      await lockClient.query("ROLLBACK").catch(() => {});
      lockClient.release();
    }
  });

  it("database_schema 只开放正面清单并隐藏非必要大字段", async () => {
    const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === "database_schema")!;
    await expect(tool.execute("tc-hidden-import", {
      operation: "list_tables",
      tables: [
        "content_legacy_import",
        "portfolio_position_snapshot_daily",
        "portfolio_account_snapshot",
        "portfolio_account_state",
      ],
    })).rejects.toThrow("不在 Agent 排障读取清单");
    const indexResult = await tool.execute("tc-q1-index", {
      operation: "list_tables",
      tables: ["job_run", "portfolio_position", "market_instrument", "pool_membership"],
    });
    const index = (textOf(indexResult) as {
      tables: Array<{ table: string; domain: string; schema_hash: string; columns?: unknown }>;
    }).tables;
    expect(index.every((table) => table.columns === undefined)).toBe(true);
    expect(index.find((table) => table.table === "portfolio_position")?.domain).toBe("持仓");
    const result = await tool.execute("tc-q1-describe", {
      operation: "describe_tables",
      tables: index.map((table) => ({ table: table.table })),
    });
    const data = textOf(result) as {
      tables: {
        table: string;
        primary_key: string[];
        write_policy: string;
        columns: { name: string; enum_values?: string[] }[];
        foreign_keys: Array<{ referenced_table: string }>;
        hidden_sensitive_columns: number;
      }[];
    };
    const jobRun = data.tables.find((table) => table.table === "job_run")!;
    expect(jobRun.columns.map((column) => column.name)).not.toEqual(expect.arrayContaining(["log", "artifacts", "result_md"]));
    expect(jobRun.hidden_sensitive_columns).toBe(3);
    const position = data.tables.find((table) => table.table === "portfolio_position")!;
    expect(position.primary_key).toEqual(["instrument_id"]);
    expect(position.write_policy).toContain("portfolio_write");
    const instrument = data.tables.find((table) => table.table === "market_instrument")!;
    expect(instrument.columns.find((column) => column.name === "kind")?.enum_values).toEqual(
      expect.arrayContaining(["stock", "etf", "index", "futures"]),
    );
    const membership = data.tables.find((table) => table.table === "pool_membership")!;
    expect(membership.foreign_keys.map((key) => key.referenced_table)).toContain("market_instrument");

    const legacyHash = textOf(await tool.execute("tc-q1-legacy-hash", {
      operation: "describe_tables",
      tables: [{ table: "portfolio_position", schema_hash: "0".repeat(64) }],
    })) as { tables: Array<{ table: string }> };
    expect(legacyHash.tables[0]!.table).toBe("portfolio_position");
  });

  it("database_query 一次批量查询多个领域", async () => {
    const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === "database_query")!;
    await pool.query(
      "UPDATE job_definition SET updated_at = '2026-08-20T07:22:56.044952Z' WHERE code = 'daily_market_structure'",
    );
    const result = await tool.execute("tc-q2", {
      queries: [
        {
          name: "标的",
          table: "market_instrument",
          columns: ["code", "name"],
          filters: [{ column: "code", op: "eq", value: "990002.SZ" }],
        },
        {
          name: "池角色",
          table: "pool_membership",
          filters: [{ column: "effective_to", op: "is_null", value: null }],
          mode: "count",
        },
        {
          name: "作业版本",
          table: "job_definition",
          columns: ["code", "updated_at"],
          filters: [{ column: "code", op: "eq", value: "daily_market_structure" }],
        },
      ],
    });
    const data = textOf(result) as {
      total_queries: number;
      queries: [{ rows: { code: string }[] }, { count: number }, { rows: { updated_at: string }[] }];
    };
    expect(data.total_queries).toBe(3);
    expect(data.queries[0]!.rows[0]!.code).toBe("990002.SZ");
    expect(data.queries[1]!.count).toBe(1);
    expect(data.queries[2]!.rows[0]!.updated_at).toBe("2026-08-20T07:22:56.044952Z");
    await expect(tool.execute("tc-q2-invalid-null-filter", {
      queries: [{
        table: "pool_membership",
        filters: [{ column: "effective_to", op: "is_null", value: "unexpected" }],
      }],
    })).rejects.toThrow("参数校验失败");
  });

  it("系统提示词说明分层读取路由、主要数据领域与当前执行模式", async () => {
    await pool.query(
      `INSERT INTO portfolio_position (instrument_id, quantity, cost_price, opened_at)
       SELECT id, 10, 10, '2026-08-01' FROM market_instrument WHERE code = '990002.SZ'
       ON CONFLICT (instrument_id) DO UPDATE SET quantity = 10, cost_price = 10;
       INSERT INTO market_bar
         (instrument_id, freq, bar_date, bar_time, open, high, low, close, volume, channel)
       SELECT id, 'day', '2026-08-18', '2026-08-18T00:00:00Z', 11, 12, 10, 12, 1000, 'migrate'
         FROM market_instrument WHERE code = '990002.SZ'`,
    );
    const normal = await buildSystemPrompt(pool);
    for (const tool of [
      "tool_catalog",
      "portfolio_context_query",
      "pool_context_query",
      "job_context_query",
      "auction_context_query",
      "strategy_document_query",
      "database_schema",
      "database_query",
      "pool_onboard",
      "portfolio_write",
      "pool_write",
      "job_write",
      "finalize_backtest",
      "memory_write",
      "strategy_publish_request",
      "analysis_run",
      "read_backtest_source",
      "fetch_market_data",
      "fetch_hithink_data",
      "hithink_catalog",
      "hithink_query",
      "indicator_query",
      "daily_plan_context_query",
      "swing_signal_query",
      "limit_up_signal_query",
    ]) {
      expect(normal).toContain(tool);
    }
    expect(normal).toContain("分层原则：先纵向聚合工具，一次取齐必要事实");
    expect(normal).toContain("具体参数与用法以工具自身描述为准");
    for (const domain of [
      "market_*",
      "portfolio_position",
      "portfolio_position_change",
      "pool_membership",
      "strategy_document",
      "job_run",
      "agent_memory_artifact",
    ]) {
      expect(normal).toContain(domain);
    }
    expect(normal).toContain("数据库变更模式：确认制");
    expect(normal).toContain("不可信输入");
    expect(normal).toContain("数据库级写锁");
    expect(normal).toContain("不得自动盲重试");
    expect(normal).toContain("内部只读探索索引");
    expect(normal).not.toContain("schema_hash=");
    expect(normal).toContain("单一事实源");
    expect(normal).toContain("目标日交易计划只对它标注的交易日有效");
    expect(normal).toContain("标的入池初始化指引");
    expect(normal).toContain("当前无右侧、左侧、试盘或波段信号不得阻止入池");
    expect(normal).toContain("已明确的可选池别/角色");
    expect(normal).toContain("用 tool_catalog 只加载 pool_onboard，然后调用一次");
    expect(normal).toContain("不得再用行情、指标、分析或 pool_write 拼装入池流程");
    expect(normal).toContain("database_schema/database_query 是受控只读兜底");
    expect(normal).toContain("止损也不是入池字段");
    expect(normal).toContain("content_* 是迁移后冻结的旧内容审计");
    expect(normal).toContain("本轮策略文档轻量目录");
    expect(normal).toContain("测试当前策略｜code=test_strategy");
    expect(normal).not.toContain("# 测试当前策略");
    expect(normal).toContain("迁移证据不是业务事实");
    expect(normal).toContain("不能声称“无法直接写入”");
    expect(normal).toContain("实盘例外");
    expect(normal).toContain("源码只能进入工具参数");
    expect(normal).toContain("YOLO 无权批准");
    expect(normal).toContain("当前持仓摘要（数据库事实，共 1 只）");
    expect(normal).toContain("持仓市值 120 元，浮动盈亏 20 元，收益率 20.00%");
    expect(normal).toContain("当前持仓组合汇总（由上述同一批数据库事实派生）：持仓 1 只，持仓市值 120 元，浮动盈亏 20 元，缺行情 0 只");
    expect(normal).toContain("累计已实现盈亏（历史基线 + 后续卖出事件，未计手续费和税费）");
    expect(normal).not.toContain("当前资金摘要");
    expect(normal).not.toContain("upsert_account_snapshot");
    expect(normal).not.toContain("portfolio_account_snapshot｜");
    expect(normal).not.toContain("portfolio_account_state｜");
    expect(normal).not.toContain("content_legacy_import｜");

    await pool.query("UPDATE agent_setting SET yolo_mode = true WHERE singleton = true");
    try {
      const yolo = await buildSystemPrompt(pool);
      expect(yolo).toContain("数据库变更模式：YOLO 已开启");
      expect(yolo).toContain("不产生待确认卡");
    } finally {
      await pool.query("UPDATE agent_setting SET yolo_mode = false WHERE singleton = true");
    }
  });

  it("run_backtest 只把源码哈希写入审计，消息与事件持久化边界递归脱敏", async () => {
    const sentinel = "BACKTEST_SOURCE_MUST_NOT_PERSIST";
    const sourceCode = `export default async function run(){ const x='${sentinel}'; return x; }`;
    const tool = buildChatTools({
      pool,
      sessionId,
      runAgentBacktest: async () => ({
        id: "88",
        name: "脱敏测试",
        kind: "research",
        execution_status: "success",
        strategy_change_seq: "0",
        strategy_snapshot_hash: "a".repeat(64),
        research_outline: "脱敏",
        hypothesis: "源码不落库",
        comparison_run_ids: [],
        input_summary: { bar_count: 1 },
        metrics_json: { total_return_pct: 1 },
        conclusion_md: "# 结论",
        data_gaps: [],
        worker_version: "worker-test",
        sdk_version: "sdk-test",
        source_sha256: "b".repeat(64),
        source_size_bytes: Buffer.byteLength(sourceCode),
        base_source_run_id: null,
        source_retention_status: "candidate",
        code_cleanup_status: "deleted",
        error_message: null,
      }),
    }).find((item) => item.name === "run_backtest")!;
    const result = await tool.execute("tc-agent-backtest", {
      name: "脱敏测试",
      research_outline: "脱敏",
      hypothesis: "源码不落库",
      codes: ["990002.SZ"],
      start: "2026-08-01",
      end: "2026-08-18",
      source_code: sourceCode,
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    const audit = await pool.query<{ args: unknown }>(
      "SELECT args FROM agent_tool_audit WHERE tool_name='run_backtest' ORDER BY id DESC LIMIT 1",
    );
    expect(audit.rows[0]!.args).toMatchObject({
      source_code_sha256: "b".repeat(64),
      source_size_bytes: Buffer.byteLength(sourceCode),
      source_code_persisted_in_chat: false,
    });
    expect(JSON.stringify(audit.rows[0]!.args)).not.toContain(sentinel);

    await appendMessage(pool, {
      session_id: sessionId,
      seq: 99,
      role: "assistant",
      json: {
        role: "assistant",
        content: [
          { type: "text", text: `准备运行 ${sentinel}` },
          { type: "toolCall", id: "tc", name: "run_backtest", arguments: { source_code: sourceCode } },
        ],
        api: "openai-responses",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    });
    await persistAndPublishSessionEvent(pool, {
      session_id: sessionId,
      event_type: "tool_start",
      data: { name: "run_backtest", args: { source_code: sourceCode } },
    });
    const persisted = await pool.query<{ content: string; data: string }>(
      `SELECT m.content::text, e.data::text
         FROM chat_message m CROSS JOIN chat_session_event e
        WHERE m.session_id=$1 AND m.seq=99 AND e.session_id=$1
        ORDER BY e.id DESC LIMIT 1`,
      [sessionId],
    );
    expect(persisted.rows[0]!.content).not.toContain(sentinel);
    expect(persisted.rows[0]!.content).toContain("source_code_persisted");
    expect(persisted.rows[0]!.data).not.toContain(sentinel);
    expect(persisted.rows[0]!.data).toContain("source_code_sha256");
  });

  it("固化回测无需真人批准，源码只对当前 Agent 工具结果可见", async () => {
    const sentinel = "VERSIONED_SOURCE_TOOL_SENTINEL";
    const run = await pool.query<{ id: string }>(
      `INSERT INTO backtest_run
         (name, kind, status, execution_status, progress, execution_origin, session_id,
          source_sha256, source_size_bytes, code_cleanup_status, conclusion_status)
       VALUES ('直接固化测试', 'research', 'archived', 'success', 100, 'agent_workspace', $1,
               repeat('c', 64), $2, 'deleted', 'working')
       RETURNING id::text`,
      [sessionId, sentinel.length],
    );
    await pool.query(
      "INSERT INTO backtest_run_source (backtest_run_id, source_code) VALUES ($1, $2)",
      [run.rows[0]!.id, `export default async function run(){ return '${sentinel}'; }`],
    );

    const tools = buildChatTools({ pool, sessionId });
    const finalizedResult = await tools.find((item) => item.name === "finalize_backtest")!.execute(
      "tc-finalize-direct",
      {
        run_id: run.rows[0]!.id,
        reason: "验证完成后固化可复用源码",
        conclusion_summary: "已验证源码可作为后续基线",
        applicability_boundary: "仅用于源码固化链路测试",
      },
    );
    expect(textOf(finalizedResult)).toMatchObject({ mode: "direct" });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM agent_confirmation WHERE tool_name = 'finalize_backtest' AND payload->>'run_id' = $1",
      [run.rows[0]!.id],
    )).rows[0]!.count).toBe(0);

    const readResult = await tools.find((item) => item.name === "read_backtest_source")!
      .execute("tc-read-source", { run_id: run.rows[0]!.id });
    expect(JSON.stringify(readResult)).toContain(sentinel);
    await appendMessage(pool, {
      session_id: sessionId,
      seq: 100,
      role: "tool",
      json: {
        role: "toolResult",
        toolCallId: "tc-read-source",
        toolName: "read_backtest_source",
        isError: false,
        content: readResult.content,
        details: readResult.details,
        timestamp: Date.now(),
      },
    });
    const stored = await pool.query<{ content: string }>(
      "SELECT content::text FROM chat_message WHERE session_id=$1 AND seq=100",
      [sessionId],
    );
    expect(stored.rows[0]!.content).not.toContain(sentinel);
    expect(stored.rows[0]!.content).toContain("源码不会保存到会话");
    expect(JSON.stringify((await pool.query(
      "SELECT args FROM agent_tool_audit WHERE tool_name='read_backtest_source' ORDER BY id DESC LIMIT 1",
    )).rows[0]!.args)).not.toContain(sentinel);
  });

  it("database_query 非法表写 error 审计", async () => {
    const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === "database_query")!;
    await expect(
      tool.execute("tc-q3", { queries: [{ table: "missing_table" }] }),
    ).rejects.toThrow("不在 Agent 排障读取清单");
    const audit = await pool.query(
      "SELECT status FROM agent_tool_audit WHERE tool_name = 'database_query'",
    );
    expect(audit.rows.map((r) => r.status)).toContain("error");
  });

  it("database_query 兼容旧 hash，但始终按当前结构实时校验", async () => {
    await pool.query("ALTER TABLE market_instrument ADD COLUMN schema_drift_probe text");
    try {
      const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === "database_query")!;
      const result = textOf(await tool.execute("tc-schema-drift", {
        queries: [{
          table: "market_instrument",
          schema_hash: "已过期的旧值",
          columns: ["code", "schema_drift_probe"],
          filters: [{ column: "code", op: "eq", value: "990002.SZ" }],
        }],
      })) as { queries: Array<{ rows: Array<{ code: string; schema_drift_probe: null }> }> };
      expect(result.queries[0]!.rows[0]).toMatchObject({
        code: "990002.SZ",
        schema_drift_probe: null,
      });
    } finally {
      await pool.query("ALTER TABLE market_instrument DROP COLUMN schema_drift_probe");
    }
  });

  it("fetch_market_data 一次调用处理多项并聚合成功/失败/进度", async () => {
    const calls: string[] = [];
    const financialCalls: string[] = [];
    const updates: unknown[] = [];
    const tool = buildChatTools({
      pool,
      sessionId,
      fetchMarket: async (request) => {
        calls.push(request.code);
        if (request.code === "FAIL.SZ") throw new Error("模拟失败");
        return {
          code: request.code,
          freq: request.freq,
          channel: "fake",
          rowsWritten: 2,
          fetchRunId: String(calls.length),
          firstDate: request.start,
          lastDate: request.end,
        };
      },
      fetchFinancial: async (request) => {
        financialCalls.push(request.code);
        return {
          code: request.code,
          status: "success",
          valuationRows: 1,
          fundamentalRows: 1,
          rowsWritten: 2,
          fetchRunId: "financial-1",
          gaps: [],
        };
      },
    }).find((item) => item.name === "fetch_market_data")!;
    const result = await tool.execute(
      "tc-batch",
      {
        requests: [
          { code: "A.SZ", freq: "day", start: "2026-08-01", end: "2026-08-02" },
          { code: "FAIL.SZ", freq: "day", start: "2026-08-01", end: "2026-08-02" },
          { code: "B.SZ", freq: "30m", start: "2026-08-01", end: "2026-08-02" },
        ],
        financial_requests: [{ code: "600519.SH" }],
      },
      undefined,
      (update) => updates.push(update.details),
    );
    const data = textOf(result) as { summary: { total: number; succeeded: number; failed: number; rows_written: number } };
    expect(calls).toEqual(["A.SZ", "FAIL.SZ", "B.SZ"]);
    expect(financialCalls).toEqual(["600519.SH"]);
    expect(updates).toHaveLength(4);
    expect(data.summary).toMatchObject({ total: 4, succeeded: 3, failed: 1, rows_written: 6 });
  });

  it("fetch_hithink_data 严格校验能力参数并批量汇总成功与失败", async () => {
    const calls: string[] = [];
    const updates: unknown[] = [];
    const tool = buildChatTools({
      pool,
      sessionId,
      fetchHithinkData: async (request) => {
        calls.push(request.capability);
        if (request.capability === "fund_returns") throw new Error("模拟基金收益缺数");
        return {
          capability: request.capability,
          request,
          sourceTimestampMs: Date.parse("2026-08-20T09:25:00+08:00"),
          asOfDate: "2026-08-20",
          dataStatus: null,
          rowCount: 1,
          payload: { item: [{ ok: true }] },
          snapshotId: String(calls.length),
          fetchRunId: String(calls.length),
          rowsWritten: 1,
          fetchedAt: "2026-08-20T01:25:00.000Z",
        };
      },
    }).find((item) => item.name === "fetch_hithink_data")!;
    await expect(tool.execute("tc-hithink-invalid", {
      requests: [{ capability: "fund_profile", fund_type: "exchange", code: "510300.SH", period: "day" }],
    } as never)).rejects.toThrow("不接受参数 period");
    const result = await tool.execute(
      "tc-hithink-batch",
      {
        requests: [
          { capability: "auction_short_term_benchmark", date: "2026-08-20" },
          { capability: "fund_returns", fund_type: "exchange", code: "510300.SH" },
          { capability: "fund_profile", fund_type: "reits", code: "180101.sz" },
        ],
      },
      undefined,
      (update) => updates.push(update.details),
    );
    const data = textOf(result) as { summary: { total: number; succeeded: number; failed: number; rows_written: number } };
    expect(calls).toEqual(["auction_short_term_benchmark", "fund_returns", "fund_profile"]);
    expect(updates).toHaveLength(3);
    expect(data.summary).toEqual({ total: 3, completed: 3, succeeded: 2, failed: 1, rows_written: 2 });
    const audit = await pool.query<{ status: string }>(
      "SELECT status FROM agent_tool_audit WHERE tool_name='fetch_hithink_data' ORDER BY id DESC LIMIT 1",
    );
    expect(audit.rows[0]!.status).toBe("ok");
  });

  it("trigger_job 严格校验目标日并只排队受控作业", async () => {
    const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === "trigger_job")!;
    await expect(
      tool.execute("tc-trigger-bad-date", {
        code: "daily_plan_flow",
        target_date: "2026-02-30",
      }),
    ).rejects.toThrow("不是有效日历日期");
    await expect(
      tool.execute("tc-trigger-unknown", { code: "not_a_real_job" }),
    ).rejects.toMatchObject({ httpStatus: 404 });

    const result = await tool.execute("tc-trigger-ok", {
      code: "daily_plan_flow",
      target_date: "2026-08-18",
    });
    const data = textOf(result) as { job_run_id: string; status: string };
    expect(data.status).toBe("queued");
    const run = await pool.query("SELECT status FROM job_run WHERE id = $1", [data.job_run_id]);
    expect(run.rows[0]!.status).toBe("queued");
    const audit = await pool.query(
      "SELECT status FROM agent_tool_audit WHERE tool_name = 'trigger_job' ORDER BY id DESC LIMIT 1",
    );
    expect(audit.rows[0]!.status).toBe("ok");
  });

  it("页面刷新不暴露给模型并由业务工具自动发布", async () => {
    const tools = buildChatTools({ pool, sessionId });
    expect(tools.map((tool) => tool.name)).not.toContain("ui_refresh");
    await tools.find((tool) => tool.name === "trigger_job")!
      .execute("tc-auto-refresh", { code: "daily_plan_flow", target_date: "2026-08-19" });
    const event = await pool.query(
      "SELECT event_type, data FROM chat_session_event WHERE session_id = $1 AND event_type = 'ui_refresh' ORDER BY id DESC LIMIT 1",
      [sessionId],
    );
    expect(event.rows[0]).toMatchObject({
      event_type: "ui_refresh",
      data: {
        targets: ["jobs", "status"],
        reason: "作业 daily_plan_flow 已排队",
      },
    });
  });

});
