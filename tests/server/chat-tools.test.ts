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

  it("工具集由渐进式读取、领域写工具、独立策略提案与系统动作组成", () => {
    const tools = buildChatTools({ pool, sessionId });
    expect(tools.map((tool) => tool.name)).toEqual([
      "database_schema",
      "database_query",
      "memory_query",
      "web_search",
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
      "ui_refresh",
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
    expect(Object.keys(portfolioSchema.properties ?? {})).toEqual(expect.arrayContaining([
      "action",
      "reason",
      "code",
      "kind",
      "change_date",
      "decision_origin",
      "execution_compliance",
    ]));
    expect(Object.keys(portfolioSchema.properties ?? {})).not.toEqual(expect.arrayContaining([
      "snap_date",
      "total_asset",
      "cash",
      "closed_pnl",
    ]));
    expect(portfolioSchema.required).toEqual(["reason", "code", "kind", "change_date"]);
    expect(
      tools
        .filter((tool) => ["portfolio_write", "pool_write", "job_write", "finalize_backtest", "memory_write", "strategy_publish_request", "analysis_run", "run_backtest", "fetch_market_data", "fetch_hithink_data", "trigger_job", "ui_refresh"].includes(tool.name))
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

      await pool.query(
        `INSERT INTO market_special_sync_run
           (dataset, target_date, status, completed_pages, total_pages, row_count, gaps, finished_at)
         VALUES ('limit_up', '2026-08-18', 'success', 1, 1, 1, '[]', now());
         INSERT INTO market_limit_event
           (trade_date, event_type, instrument_id, event_price, source_payload, source_row_sha256)
         SELECT '2026-08-18', 'up', id, 12.34,
                '{"provider_secret":"MARKET_PAYLOAD_MUST_NOT_ESCAPE"}'::jsonb,
                'market-tool-test'
           FROM market_instrument WHERE code='990002.SZ'
         ON CONFLICT (trade_date, event_type, instrument_id) DO UPDATE
           SET source_payload=EXCLUDED.source_payload`,
      );
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

  it("database_schema 先返回轻量索引，再按 hash 返回完整结构并隐藏密钥列", async () => {
    const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === "database_schema")!;
    await expect(tool.execute("tc-hidden-import", {
      operation: "list_tables",
      tables: [
        "content_legacy_import",
        "portfolio_position_snapshot_daily",
        "portfolio_account_snapshot",
        "portfolio_account_state",
      ],
    })).rejects.toThrow("已退役");
    const indexResult = await tool.execute("tc-q1-index", {
      operation: "list_tables",
      tables: ["llm_provider", "portfolio_position", "market_instrument", "pool_membership"],
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
    const provider = data.tables.find((table) => table.table === "llm_provider")!;
    expect(provider.columns.map((column) => column.name)).not.toContain("api_key");
    expect(provider.hidden_sensitive_columns).toBe(1);
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
        { name: "池角色", table: "pool_membership", schema_hash: hash("pool_membership"), mode: "count" },
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
      "ui_refresh",
    ]) {
      expect(normal).toContain(tool);
    }
    for (const domain of ["market_*", "portfolio_position", "portfolio_position_change", "pool_*", "strategy_*", "job_*", "agent_memory_artifact"]) {
      expect(normal).toContain(domain);
    }
    expect(normal).toContain("数据库变更模式：确认制");
    expect(normal).toContain("不可信输入");
    expect(normal).toContain("数据库级写锁");
    expect(normal).toContain("不得自动盲重试");
    expect(normal).toContain("数据库轻量表索引");
    expect(normal).toContain("schema_hash=");
    expect(normal).toContain("单一事实源");
    expect(normal).toContain("目标日交易计划只对它标注的交易日有效");
    expect(normal).toContain("标的入池评估指引");
    expect(normal).toContain("当前页面只能作为待验证假设");
    expect(normal).toContain("只有数据库无法提供故事性、催化剂、产业变化、公告或外部风险证据时才使用 web_search");
    expect(normal).toContain("短线池·短线、长线池·波段、长线池·长线，或暂不入池");
    expect(normal).toContain("content_* 是迁移后冻结的旧内容审计");
    expect(normal).toContain("当前最终策略与核心指引");
    expect(normal).toContain("# 测试当前策略");
    expect(normal).toContain("迁移证据不是业务事实");
    expect(normal).toContain("不能声称“无法直接写入”");
    expect(normal).toContain("实盘例外");
    expect(normal).toContain("源码只能放在工具参数");
    expect(normal).toContain("YOLO 无权绕过");
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
    ).rejects.toThrow("不存在");
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

  it("ui_refresh 只接受白名单模块并持久化可重放刷新事件", async () => {
    const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === "ui_refresh")!;
    await expect(tool.execute("tc-ui-refresh-unknown", {
      targets: ["positions", "browser_click"],
      reason: "未知浏览器动作必须拒绝",
    } as never)).rejects.toThrow("参数校验失败");
    await expect(tool.execute("tc-ui-refresh-duplicate", {
      targets: ["positions", "positions"],
      reason: "重复模块必须拒绝",
    })).rejects.toThrow("存在重复项");

    const result = await tool.execute("tc-ui-refresh-ok", {
      targets: ["positions", "dashboard", "status"],
      reason: "持仓已更新",
    });
    expect(textOf(result)).toMatchObject({
      targets: ["positions", "dashboard", "status"],
    });
    const event = await pool.query(
      "SELECT event_type, data FROM chat_session_event WHERE session_id = $1 AND event_type = 'ui_refresh' ORDER BY id DESC LIMIT 1",
      [sessionId],
    );
    expect(event.rows[0]).toMatchObject({
      event_type: "ui_refresh",
      data: {
        targets: ["positions", "dashboard", "status"],
        reason: "持仓已更新",
      },
    });
    const audit = await pool.query(
      "SELECT status FROM agent_tool_audit WHERE session_id = $1 AND tool_name = 'ui_refresh' ORDER BY id DESC LIMIT 1",
      [sessionId],
    );
    expect(audit.rows[0]!.status).toBe("ok");
  });

});
