// 渐进式数据库发现、哈希查询、领域写边界与批量行情测试
// - fetch_market_data 一次调用顺序处理多项并汇报聚合进度
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../server/db/migrate.js";
import { buildChatTools } from "../../server/agent/tools.js";
import { acquireAgentMutationLock } from "../../server/agent/mutation-lock.js";
import { appendMessage, createSession } from "../../server/agent/repo.js";
import { buildSystemPrompt } from "../../server/agent/prompt.js";
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
import { prepareTestDb, resetSchema, seedTestStrategy } from "./helpers.js";

const prepared = await prepareTestDb();

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

  async function schemaIndex(tables?: string[]): Promise<Array<{ table: string; schema_hash: string }>> {
    const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === "database_schema")!;
    const result = await tool.execute("tc-schema-index", {
      operation: "list_tables",
      ...(tables ? { tables } : {}),
    });
    return (textOf(result) as { tables: Array<{ table: string; schema_hash: string }> }).tables;
  }

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

  it("工具集以纵向业务能力为先、数据库排障能力置后", () => {
    const tools = buildChatTools({ pool, sessionId });
    expect(tools.map((tool) => tool.name)).toEqual([
      "portfolio_context_query",
      "pool_context_query",
      "job_context_query",
      "strategy_document_query",
      "daily_plan_context_query",
      "limit_up_signal_query",
      "memory_query",
      "web_search",
      "portfolio_write",
      "pool_write",
      "job_write",
      "finalize_backtest",
      "memory_write",
      "pool_attention_write",
      "daily_plan_write",
      "auction_assessment_write",
      "strategy_publish_request",
      "analysis_run",
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
        .filter((tool) => ["portfolio_write", "pool_write", "job_write", "finalize_backtest", "memory_write", "pool_attention_write", "daily_plan_write", "auction_assessment_write", "strategy_publish_request", "analysis_run", "run_backtest", "fetch_market_data", "fetch_hithink_data", "trigger_job"].includes(tool.name))
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
    expect(tools.find((tool) => tool.name === "pool_write")!.description)
      .toContain("标的入池评估指引");
    const databaseQuery = tools.find((tool) => tool.name === "database_query")!;
    const filterSchema = (databaseQuery.parameters as {
      properties?: {
        queries?: { items?: { properties?: { filters?: { items?: { anyOf?: unknown[]; description?: string } } } } };
      };
    }).properties?.queries?.items?.properties?.filters?.items;
    expect(filterSchema?.anyOf).toHaveLength(2);
    expect(filterSchema?.description).toContain("过滤器二选一");
    expect(databaseQuery.label).toContain("低优先级");
    expect(databaseQuery.description).toContain("最多 5 项、每项 100 行");
    expect(tools.at(-1)?.name).toBe("database_query");
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
      const [entry] = await schemaIndex(["market_instrument"]);
      const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === "database_query")!;
      const result = await tool.execute("tc-full-query-result", {
        queries: [{
          table: "market_instrument",
          schema_hash: entry!.schema_hash,
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

  it("市场领域工具默认不注册，开启后仍按执行时开关和严格参数约束", async () => {
    const candidateNames = [
      "instrument_search",
      "market_snapshot_query",
      "board_query",
      "market_event_query",
      "indicator_query",
    ];
    const defaults = buildChatTools({ pool, sessionId });
    expect(defaults.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(candidateNames));
    expect(defaults.map((tool) => tool.name)).not.toContain("web_research");
    expect(defaults.map((tool) => tool.name)).toContain("daily_plan_context_query");
    expect(defaults.map((tool) => tool.name)).toContain("limit_up_signal_query");
    const limitScore = defaults.find((tool) => tool.name === "limit_up_signal_query")!;
    expect(textOf(await limitScore.execute("tc-limit-score", { date: "2026-08-17" }))).toMatchObject({
      date: "2026-08-17",
      status: "success",
      candidate_count: 0,
      signal_count: 0,
      candidates: [],
    });
    await expect(limitScore.execute("tc-limit-score-strict", { date: "2026-08-17", page: 1 } as never))
      .rejects.toThrow("参数校验失败");

    const schema = defaults.find((tool) => tool.name === "database_schema")!;
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

    await pool.query("UPDATE agent_setting SET market_domain_tools_enabled=true WHERE singleton=true");
    try {
      const tools = buildChatTools({ pool, sessionId, marketDomainToolsEnabled: true });
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(candidateNames));
      expect(tools.map((tool) => tool.name)).not.toContain("web_research");

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
            SET stock_character = '凶狠·快拉·护盘中', tags = '["股性：快拉"]', stop_loss_mode = NULL
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
        trial_start_scan: { stock_member_count: number; completed_count: number; items: Array<{ stage: string }> };
        right_side_signal_scan: { stock_member_count: number; completed_count: number };
        left_reversal_scan: { stock_member_count: number; completed_count: number; gaps: Array<{ code: string }> };
        signal_selection: { priority: string[]; selected_count: number };
        positions: {
          stop_loss_inferred_count: number;
          items: Array<{ code: string; stop_loss_mode: string; stop_loss_mode_source: string }>;
        };
        market_structure_sync: { datasets: Array<{ dataset: string; valid_empty: boolean }> };
      };
      expect(dailyContextResult.trial_start_scan).toMatchObject({ stock_member_count: 1, completed_count: 1 });
      expect(dailyContextResult.trial_start_scan.items).toHaveLength(1);
      expect(dailyContextResult.right_side_signal_scan).toMatchObject({ stock_member_count: 1, completed_count: 0 });
      expect(dailyContextResult.left_reversal_scan).toMatchObject({ stock_member_count: 1, completed_count: 1 });
      expect(dailyContextResult.left_reversal_scan.gaps).toEqual([]);
      expect(dailyContextResult.signal_selection.priority).toEqual(["right_side", "left_reversal", "trial_start"]);
      expect(dailyContextResult.signal_selection.selected_count).toBe(0);
      expect(dailyContextResult.positions.stop_loss_inferred_count).toBe(1);
      expect(dailyContextResult.positions.items).toContainEqual(expect.objectContaining({
        code: "990002.SZ",
        stop_loss_mode: "ma5",
        stop_loss_mode_source: "inferred",
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

      await pool.query("UPDATE agent_setting SET market_domain_tools_enabled=false WHERE singleton=true");
      await expect(search.execute("tc-market-disabled", { q: "990002" }))
        .rejects.toThrow("市场领域工具开关已关闭");
    } finally {
      await pool.query("UPDATE agent_setting SET market_domain_tools_enabled=false WHERE singleton=true");
    }
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
      tables: index.map((table) => ({ table: table.table, schema_hash: table.schema_hash })),
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

    const refreshed = textOf(await tool.execute("tc-q1-refresh", {
      operation: "describe_tables",
      tables: [{ table: "portfolio_position", schema_hash: "0".repeat(64) }],
    })) as { refreshed_tables: string[]; tables: Array<{ table: string; schema_hash: string }> };
    expect(refreshed.refreshed_tables).toEqual(["portfolio_position"]);
    expect(refreshed.tables[0]!.schema_hash).toBe(
      index.find((table) => table.table === "portfolio_position")!.schema_hash,
    );
  });

  it("database_query 一次批量查询多个领域", async () => {
    const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === "database_query")!;
    await pool.query(
      "UPDATE job_definition SET updated_at = '2026-08-20T07:22:56.044952Z' WHERE code = 'daily_market_structure'",
    );
    const index = await schemaIndex(["market_instrument", "pool_membership", "job_definition"]);
    const hash = (table: string) => index.find((item) => item.table === table)!.schema_hash;
    const jobDefinitionHash = hash("job_definition");
    const result = await tool.execute("tc-q2", {
      queries: [
        {
          name: "标的",
          table: "market_instrument",
          schema_hash: hash("market_instrument"),
          columns: ["code", "name"],
          filters: [{ column: "code", op: "eq", value: "990002.SZ" }],
        },
        {
          name: "池角色",
          table: "pool_membership",
          schema_hash: hash("pool_membership"),
          filters: [{ column: "effective_to", op: "is_null", value: null }],
          mode: "count",
        },
        {
          name: "作业版本",
          table: "job_definition",
          columns: ["code", "updated_at"],
          filters: [{ column: "code", op: "eq", value: "daily_market_structure" }],
          // 长不透明值的尾部可能被模型抄错；前 128 位一致仍代表同一 Schema 版本。
          schema_hash: `${jobDefinitionHash.slice(0, 32)}${"0".repeat(32)}`,
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
        schema_hash: hash("pool_membership"),
        filters: [{ column: "effective_to", op: "is_null", value: "unexpected" }],
      }],
    })).rejects.toThrow("参数校验失败");
  });

  it("系统提示词说明全部工具、主要数据领域与当前执行模式", async () => {
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
      "portfolio_context_query",
      "pool_context_query",
      "job_context_query",
      "strategy_document_query",
      "database_schema",
      "database_query",
      "memory_query",
      "portfolio_write",
      "pool_write",
      "job_write",
      "finalize_backtest",
      "memory_write",
      "strategy_publish_request",
      "analysis_run",
      "read_backtest_source",
      "run_backtest",
      "fetch_market_data",
      "fetch_hithink_data",
      "trigger_job",
    ]) {
      expect(normal).toContain(tool);
    }
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
    expect(normal).toContain("低优先级数据库排障索引");
    expect(normal).toContain("schema_hash=");
    expect(normal).toContain("单一事实源");
    expect(normal).toContain("目标日交易计划只对它标注的交易日有效");
    expect(normal).toContain("标的入池评估指引");
    expect(normal).toContain("当前页面只能作为待验证假设");
    expect(normal).toContain("只有数据库无法提供故事性、催化剂、产业变化、公告或外部风险证据时才使用 web_search");
    expect(normal).toContain("短线池·短线、长线池·波段、长线池·长线，或暂不入池");
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
      tool.execute("tc-q3", { queries: [{ table: "missing_table", schema_hash: "a".repeat(64) }] }),
    ).rejects.toThrow("不在 Agent 排障读取清单");
    const audit = await pool.query(
      "SELECT status FROM agent_tool_audit WHERE tool_name = 'database_query'",
    );
    expect(audit.rows.map((r) => r.status)).toContain("error");
  });

  it("database_query 在执行前拒绝已漂移的 schema_hash", async () => {
    const [entry] = await schemaIndex(["market_instrument"]);
    await pool.query("ALTER TABLE market_instrument ADD COLUMN schema_drift_probe text");
    try {
      const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === "database_query")!;
      await expect(tool.execute("tc-schema-drift", {
        queries: [{ table: "market_instrument", schema_hash: entry!.schema_hash, columns: ["code"] }],
      })).rejects.toThrow("Schema 已变化");
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
