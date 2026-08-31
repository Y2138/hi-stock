// 当前分析、Agent 自驱回测安全边界与只读回测 API 测试。
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  compileAgentBacktestSource,
  failInterruptedAgentBacktests,
  formatAgentBacktestWorkerError,
  runAgentBacktest,
  validateAgentBacktestWorkerResult,
} from "../../server/backtest/agent-workspace.js";
import {
  AGENT_BACKTEST_INPUT_LIMIT,
  AGENT_BACKTEST_MAX_ROWS,
  AGENT_BACKTEST_MEMORY_LIMIT,
  AGENT_BACKTEST_TIMEOUT_MS,
  AGENT_BACKTEST_WORKER_VERSION,
} from "../../server/backtest/agent-contract.js";
import { runMigrations } from "../../server/db/migrate.js";
import { createSession } from "../../server/agent/repo.js";
import { finalizeBacktest } from "../../server/modules/backtests/repo.js";
import {
  api,
  prepareTestDb,
  resetSchema,
  seedTestStrategy,
  startTestServer,
  type TestServer,
} from "./helpers.js";

const prepared = await prepareTestDb();

async function runWorkerContractFixture(sourceCode: string): Promise<Record<string, unknown>> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "stock-worker-contract-"));
  const inputPath = path.join(workspace, "input.json");
  const strategyPath = path.join(workspace, "strategy.mjs");
  const outputPath = path.join(workspace, "result.json");
  try {
    await Promise.all([
      fs.writeFile(inputPath, JSON.stringify({
        sdk_version: "stock-backtest-sdk-v2",
        meta: {
          codes: ["SRV001.SZ"],
          start: "2026-01-01",
          end: "2026-01-01",
          initial_cash: 1_000_000,
          parameters: {},
        },
        bars: [{
          code: "SRV001.SZ",
          date: "2026-01-01",
          open: 10,
          high: 10,
          low: 10,
          close: 10,
          volume: 1_000,
        }],
        market_events: [{
          date: "2026-01-01",
          type: "up",
          code: "SRV001.SZ",
          event_price: 10,
          streak_count: 2,
          open_count: 0,
          first_event_time: "2026-01-01T01:35:00.000Z",
          last_event_time: "2026-01-01T01:35:00.000Z",
          industry_name: "测试题材",
          reason: "测试涨停",
        }],
      })),
      fs.writeFile(strategyPath, sourceCode),
    ]);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        path.join(import.meta.dirname, "../../server/backtest/worker-runner.mjs"),
        inputPath,
        strategyPath,
        outputPath,
      ], { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
    return JSON.parse(await fs.readFile(outputPath, "utf8")) as Record<string, unknown>;
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

describe("隔离回测工作器结果诊断", () => {
  it("把返回契约问题标成固定安全错误码，不再伪装成策略运行故障", async () => {
    expect(await runWorkerContractFixture(`
      export default async function run() {
        return { daily_returns: [], metrics: {}, conclusion: "探测", data_gaps: [] };
      }
    `)).toMatchObject({
      ok: false,
      error: { kind: "result_contract", code: "daily_returns_count" },
    });
    expect(await runWorkerContractFixture(`
      export default async function run() {
        return {
          daily_returns: [{ date: "2026-01-01", return: 0 }],
          metrics: { nested: { value: 1 } },
          conclusion: "探测",
          data_gaps: [],
        };
      }
    `)).toMatchObject({
      ok: false,
      error: { kind: "result_contract", code: "metrics_value" },
    });
  });

  it("把策略运行错误分类为可自动纠错的安全错误码，不泄露自定义异常正文", async () => {
    const reference = await runWorkerContractFixture(`
      export default async function run() {
        return missingBacktestValue;
      }
    `);
    expect(reference).toMatchObject({
      ok: false,
      error: { kind: "runtime", code: "reference_error", phase: "execute_strategy" },
    });
    expect(JSON.stringify(reference)).not.toContain("missingBacktestValue is not defined");

    expect(await runWorkerContractFixture(`
      export default async function run() {
        const recurse = () => recurse();
        return recurse();
      }
    `)).toMatchObject({
      ok: false,
      error: { kind: "runtime", code: "stack_overflow", phase: "execute_strategy" },
    });
  });

  it("SDK 可按类型和日期读取数据库市场事件", async () => {
    expect(await runWorkerContractFixture(`
      export default async function run(sdk) {
        return {
          daily_returns: [{ date: "2026-01-01", return: 0 }],
          metrics: {
            all_events: sdk.events().length,
            up_events: sdk.events("up").length,
            date_events: sdk.eventsOn("2026-01-01").length,
            date_up_events: sdk.eventsOn("2026-01-01", "up").length
          },
          conclusion: "市场事件 SDK 可用",
          data_gaps: []
        };
      }
    `)).toMatchObject({
      ok: true,
      result: {
        metrics: { all_events: 1, up_events: 1, date_events: 1, date_up_events: 1 },
      },
    });
  });
});

describe.skipIf(!prepared)("回测验证与只读 API", () => {
  let pool: pg.Pool;
  let server: TestServer;
  let sessionId: string;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
    await seedTestStrategy(pool);
    sessionId = (await createSession(pool, "Agent 回测测试")).id;
    server = await startTestServer(pool);
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  async function seedServiceBars(): Promise<void> {
    await pool.query(
      `INSERT INTO market_instrument (code, name, kind)
       VALUES ('SRV001.SZ', 'Agent 回测样本', 'stock')
       ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `WITH instrument AS (SELECT id FROM market_instrument WHERE code = 'SRV001.SZ'),
            points AS (SELECT generate_series(0, 29) AS offset)
       INSERT INTO market_bar
         (instrument_id, freq, bar_date, bar_time, open, high, low, close, volume, channel)
       SELECT instrument.id, 'day', date '2026-01-01' + points.offset,
              (date '2026-01-01' + points.offset)::timestamp AT TIME ZONE 'UTC',
              10 + points.offset * 0.1, 10.5 + points.offset * 0.1,
              9.5 + points.offset * 0.1, 10 + points.offset * 0.1,
              1000 + points.offset * 10, 'test'
         FROM instrument CROSS JOIN points
       ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      `WITH instrument AS (SELECT id FROM market_instrument WHERE code = 'SRV001.SZ'),
            points AS (SELECT generate_series(0, 9) AS offset)
       INSERT INTO market_bar
         (instrument_id, freq, bar_date, bar_time, open, high, low, close, volume, channel)
       SELECT instrument.id, '30m', date '2026-01-30',
              timestamptz '2026-01-30 01:30:00+00' + points.offset * interval '30 minutes',
              12 + points.offset * 0.02, 12.2 + points.offset * 0.02,
              11.8 + points.offset * 0.02, 12 + points.offset * 0.02,
              500 + points.offset * 5, 'test'
         FROM instrument CROSS JOIN points
       ON CONFLICT DO NOTHING`,
    );
  }

  async function seedLimitEventBacktestData(): Promise<void> {
    await pool.query(
      `INSERT INTO market_instrument (code, name, kind) VALUES
         ('000001.SZ', '主板有行情样本', 'stock'),
         ('000002.SZ', '主板缺行情样本', 'stock'),
         ('300001.SZ', '创业板背景样本', 'stock')
       ON CONFLICT (code) DO NOTHING;
       INSERT INTO market_bar
         (instrument_id, freq, bar_date, bar_time, open, high, low, close, volume, channel)
       SELECT id, 'day', point.day, point.day::timestamp AT TIME ZONE 'UTC',
              10, 11, 9.5, 10.5, 1000, 'test'
         FROM market_instrument
         CROSS JOIN (VALUES (date '2026-02-02'), (date '2026-02-03')) AS point(day)
        WHERE code = '000001.SZ'
       ON CONFLICT DO NOTHING;
       INSERT INTO market_limit_event
         (trade_date, event_type, instrument_id, event_price, streak_count, open_count,
          first_event_time, last_event_time, industry_name, reason, source_row_sha256)
       SELECT date '2026-02-02', item.event_type, instrument.id, 11, item.streak_count, 0,
              timestamptz '2026-02-02 01:35:00+00', timestamptz '2026-02-02 01:35:00+00',
              '测试题材', '数据库事件回测测试', 'backtest-market-event-' || item.event_type || '-' || instrument.code
         FROM (VALUES
           ('000001.SZ', 'up', 2),
           ('000002.SZ', 'up', 1),
           ('300001.SZ', 'up', 1),
           ('300001.SZ', 'down', NULL),
           ('000001.SZ', 'break', 2)
         ) AS item(code, event_type, streak_count)
         JOIN market_instrument instrument ON instrument.code = item.code
       ON CONFLICT (trade_date, event_type, instrument_id) DO NOTHING`,
    );
  }

  it("未知回测 id → 404，旧 HTTP 创建与激活入口均退役", async () => {
    expect((await api(server.baseUrl, "GET", "/api/backtests/999999")).status).toBe(404);
    expect((await api(server.baseUrl, "GET", "/api/backtests/999999/source")).status).toBe(404);
    expect((await api(server.baseUrl, "POST", "/api/backtests/run", {})).status).toBe(404);
    expect((await api(server.baseUrl, "POST", "/api/backtests/1/activate", {})).status).toBe(404);
    expect((await api(server.baseUrl, "POST", "/api/backtests", {})).status).toBe(404);
  });

  it("复合分析只读数据库行情，关键位组合日线与 30 分钟线，估值缺口显式留痕", async () => {
    await seedServiceBars();
    const sector = await api(server.baseUrl, "POST", "/api/analysis/run", {
      analysis_type: "sector_temperature",
      codes: ["SRV001.SZ"],
      as_of: "2026-01-30",
    });
    expect(sector.status).toBe(201);
    expect(sector.json).toMatchObject({ status: "success", analysis_type: "sector_temperature", data_gaps: [] });

    const levels = await api(server.baseUrl, "POST", "/api/analysis/run", {
      analysis_type: "key_levels",
      codes: ["SRV001.SZ"],
      as_of: "2026-01-30",
    });
    expect(levels.status).toBe(201);
    expect(levels.json).toMatchObject({ status: "success", analysis_type: "key_levels", data_gaps: [] });
    expect((levels.json as { input_summary: { daily_rows: number; minute30_rows: number } }).input_summary)
      .toMatchObject({ daily_rows: 30, minute30_rows: 10 });

    const valuation = await api(server.baseUrl, "POST", "/api/analysis/run", {
      analysis_type: "long_valuation",
      codes: ["SRV001.SZ"],
      as_of: "2026-01-30",
    });
    expect(valuation.status).toBe(201);
    expect(valuation.json).toMatchObject({ status: "partial", analysis_type: "long_valuation" });
    expect((valuation.json as { data_gaps: unknown[] }).data_gaps).toHaveLength(2);
  });

  it("临时代码编译拒绝 import，工作器结果必须通过严格契约", () => {
    expect(() => compileAgentBacktestSource("import fs from 'node:fs'; export default async () => ({})"))
      .toThrow("不允许 import");
    expect(() => compileAgentBacktestSource("export const x = 1"))
      .toThrow("必须 default export");
    expect(() => validateAgentBacktestWorkerResult({
      metrics: { total_return_pct: Number.POSITIVE_INFINITY },
      conclusion: "无效",
      data_gaps: [],
      observations: 1,
    })).toThrow("metrics");
    expect(validateAgentBacktestWorkerResult({
      metrics: { total_return_pct: 1.25 },
      conclusion: "契约有效",
      data_gaps: [],
      observations: 29,
    })).toMatchObject({ observations: 29 });
    expect(formatAgentBacktestWorkerError({
      kind: "result_contract",
      code: "metrics_value",
    })).toContain("metrics 键只能使用小写字母");
    expect(formatAgentBacktestWorkerError({
      kind: "runtime",
      code: "reference_error",
      phase: "execute_strategy",
      location: ["12", "8"],
    })).toBe("回测策略运行失败：[STRATEGY_REFERENCE_ERROR] 阶段=执行策略；引用了未定义变量（策略模块第 12 行第 8 列）");
  });

  it("按数据库涨停事件解析主板候选并注入完整市场事件，缺日线时标记 partial", async () => {
    await seedLimitEventBacktestData();
    const run = await runAgentBacktest(pool, sessionId, {
      name: "数据库涨停候选回测",
      kind: "research",
      research_outline: "验证主板涨停候选与全市场事件输入",
      hypothesis: "主板候选可由涨停事件解析，非主板仍保留为市场背景",
      codes: [],
      market_event_types: ["down", "break"],
      limit_up_universe: "mainboard",
      start: "2026-02-02",
      end: "2026-02-03",
      initial_cash: 1_000_000,
      parameters: {},
      comparison_run_ids: [],
      base_source_run_id: null,
      source_code: "export default async function run(){ return {}; }",
    }, {
      execute: async (input) => {
        expect(input.meta.codes).toEqual(["000001.SZ", "000002.SZ"]);
        expect(input.bars).toHaveLength(2);
        expect(input.market_events).toHaveLength(5);
        expect(input.market_events).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "300001.SZ", type: "up" }),
          expect.objectContaining({ code: "300001.SZ", type: "down" }),
        ]));
        return {
          result: {
            metrics: { candidate_count: input.meta.codes.length },
            conclusion: "数据库市场事件输入有效",
            data_gaps: [],
            observations: 1,
          },
          error: null,
          timedOut: false,
          aborted: false,
        };
      },
    });
    expect(run).toMatchObject({
      execution_status: "partial",
      input_summary: {
        codes_requested: 0,
        codes_resolved: 2,
        codes_available: 1,
        market_event_count: 5,
        market_event_counts: { up: 3, down: 1, break: 1 },
        market_event_coverage_start: "2026-02-02",
        market_event_coverage_end: "2026-02-02",
      },
    });
    expect(run.data_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "000002.SZ", reason: "请求区间没有日线" }),
    ]));
  });

  it("Agent 回测暂存候选源码，最终化后固化并支持后续继承", async () => {
    await seedServiceBars();
    const prior = await pool.query<{ id: string }>(
      `INSERT INTO backtest_run
         (name, kind, status, execution_status, progress, execution_origin,
          research_outline, hypothesis, conclusion_md, metrics_json,
          conclusion_status, conclusion_summary, applicability_boundary, finalized_at)
       VALUES ('历史对比样本', 'research', 'archived', 'success', 100, 'agent_workspace',
               '旧思路', '旧假设', '# 旧结论', '{"total_return_pct":0.5}',
               'final', '旧结论摘要', '旧结论边界', now())
       RETURNING id::text`,
    );
    const sourceSentinel = "VERSIONED_BACKTEST_SOURCE_SENTINEL";
    const sourceCode = `
      export default async function run(sdk: any) {
        const marker = "${sourceSentinel}";
        const bars = sdk.bars("SRV001.SZ");
        return {
          daily_returns: bars.slice(1).map((bar: any) => ({ date: bar.date, return: marker ? 0.001 : 0 })),
          metrics: { trade_count: 1 }, conclusion: "样本内假设成立", data_gaps: []
        };
      }
    `;
    const run = await runAgentBacktest(pool, sessionId, {
      name: "Agent 隔离回测",
      kind: "research",
      research_outline: "验证单调样本中的日收益聚合",
      hypothesis: "固定小幅日收益应得到正总收益",
      codes: ["SRV001.SZ"],
      start: "2026-01-01",
      end: "2026-01-30",
      initial_cash: 1_000_000,
      parameters: { fee_rate: 0 },
      comparison_run_ids: [prior.rows[0]!.id],
      base_source_run_id: null,
      source_code: sourceCode,
    }, {
      execute: async (input, javascript) => {
        expect(input.bars).toHaveLength(30);
        expect(javascript).toContain(sourceSentinel);
        return {
          result: {
            metrics: { total_return_pct: 2.94, max_drawdown_pct: 0 },
            conclusion: "样本内假设成立",
            data_gaps: [],
            observations: 29,
          },
          error: null,
          timedOut: false,
          aborted: false,
        };
      },
    });

    expect(run).toMatchObject({
      execution_status: "success",
      research_outline: "验证单调样本中的日收益聚合",
      hypothesis: "固定小幅日收益应得到正总收益",
      comparison_run_ids: [prior.rows[0]!.id],
      code_cleanup_status: "deleted",
      source_size_bytes: Buffer.byteLength(sourceCode, "utf8"),
      source_retention_status: "candidate",
      session_id: sessionId,
    });
    expect(run.source_sha256).toMatch(/^[0-9a-f]{64}$/);

    const persisted = await pool.query<{ row: string }>(
      "SELECT row_to_json(r)::text AS row FROM backtest_run r WHERE id = $1",
      [run.id],
    );
    expect(persisted.rows[0]!.row).not.toContain(sourceSentinel);
    expect(persisted.rows[0]!.row).not.toContain("source_code");
    expect((await pool.query(
      "SELECT source_code, retention_status FROM backtest_run_source WHERE backtest_run_id = $1",
      [run.id],
    )).rows[0]).toMatchObject({ source_code: expect.stringContaining(sourceSentinel), retention_status: "candidate" });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM backtest_run_comparison WHERE run_id = $1 AND compared_run_id = $2",
      [run.id, prior.rows[0]!.id],
    )).rows[0]!.count).toBe(1);

    const workingListResponse = await api(server.baseUrl, "GET", "/api/backtests");
    expect(workingListResponse.status).toBe(200);
    expect(workingListResponse.json).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: run.id }),
    ]));
    expect((await api(server.baseUrl, "GET", `/api/backtests/${run.id}`)).status).toBe(404);

    const hiddenPrior = await pool.query<{ id: string }>(
      `INSERT INTO backtest_run (name, kind, status, execution_status, execution_origin)
       VALUES ('未确认中间运行', 'research', 'archived', 'partial', 'agent_workspace')
       RETURNING id::text`,
    );
    await pool.query(
      `INSERT INTO backtest_run_comparison (run_id, compared_run_id)
       VALUES ($1, $2)`,
      [run.id, hiddenPrior.rows[0]!.id],
    );

    const finalized = await finalizeBacktest(pool, {
      session_id: sessionId,
      run_id: run.id,
      conclusion_summary: "单调样本中固定小幅日收益形成正累计收益",
      applicability_boundary: "仅适用于当前单标的日线样本与零费率参数",
    });
    expect(finalized).toMatchObject({
      id: run.id,
      conclusion_status: "final",
      source_retention_status: "versioned",
      conclusion_summary: "单调样本中固定小幅日收益形成正累计收益",
      applicability_boundary: "仅适用于当前单标的日线样本与零费率参数",
    });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM backtest_run_comparison WHERE run_id = $1 AND compared_run_id = $2",
      [run.id, hiddenPrior.rows[0]!.id],
    )).rows[0]!.count).toBe(0);

    const listResponse = await api(server.baseUrl, "GET", "/api/backtests");
    expect(listResponse.status).toBe(200);
    expect(listResponse.json).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: run.id, comparison_run_ids: [prior.rows[0]!.id], source_sha256: run.source_sha256 }),
    ]));
    const detailResponse = await api(server.baseUrl, "GET", `/api/backtests/${run.id}`);
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.json).toMatchObject({
      id: run.id,
      source_retention_status: "versioned",
      comparisons: [expect.objectContaining({ id: prior.rows[0]!.id, hypothesis: "旧假设" })],
    });
    const sourceResponse = await api(server.baseUrl, "GET", `/api/backtests/${run.id}/source`);
    expect(sourceResponse.status).toBe(200);
    expect(sourceResponse.json).toMatchObject({
      backtest_run_id: run.id,
      source_code: expect.stringContaining(sourceSentinel),
      source_sha256: run.source_sha256,
      conclusion_status: "final",
    });

    const replacement = await runAgentBacktest(pool, sessionId, {
      name: "Agent 隔离回测复核",
      kind: "research",
      research_outline: "复核单调样本中的收益聚合",
      hypothesis: "复核运行应替代同会话旧结论",
      codes: ["SRV001.SZ"],
      start: "2026-01-01",
      end: "2026-01-30",
      initial_cash: 1_000_000,
      parameters: { fee_rate: 0.001 },
      comparison_run_ids: [run.id],
      base_source_run_id: run.id,
      source_code: sourceCode,
    }, {
      execute: async () => ({
        result: {
          metrics: { total_return_pct: 2.6, max_drawdown_pct: 0.1 },
          conclusion: "计入费率后结论仍成立",
          data_gaps: [],
          observations: 29,
        },
        error: null,
        timedOut: false,
        aborted: false,
      }),
    });
    await finalizeBacktest(pool, {
      session_id: sessionId,
      run_id: replacement.id,
      conclusion_summary: "计入费率后仍为正收益，复核结论替代初次结论",
      applicability_boundary: "仅适用于当前单标的日线样本与给定费率",
    });

    expect((await pool.query(
      "SELECT conclusion_status, superseded_by_run_id::text FROM backtest_run WHERE id = $1",
      [run.id],
    )).rows[0]).toMatchObject({
      conclusion_status: "superseded",
      superseded_by_run_id: replacement.id,
    });
    const replacedList = await api(server.baseUrl, "GET", "/api/backtests");
    expect(replacedList.json).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: replacement.id, conclusion_status: "final" }),
    ]));
    expect(replacedList.json).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: run.id }),
    ]));
    expect((await api(server.baseUrl, "GET", `/api/backtests/${run.id}`)).status).toBe(404);
    const supersededSource = await api(server.baseUrl, "GET", `/api/backtests/${run.id}/source`);
    expect(supersededSource.status).toBe(200);
    expect(supersededSource.json).toMatchObject({ backtest_run_id: run.id, conclusion_status: "superseded" });
    expect((await pool.query(
      "SELECT base_source_run_id::text, retention_status FROM backtest_run JOIN backtest_run_source ON backtest_run_source.backtest_run_id = backtest_run.id WHERE backtest_run.id = $1",
      [replacement.id],
    )).rows[0]).toMatchObject({ base_source_run_id: run.id, retention_status: "versioned" });
  });

  it("Docker 工作器声明无网、只读、非 root、权限模型、50万行资源与文件上限", async () => {
    const source = await fs.readFile(
      path.join(import.meta.dirname, "../../server/backtest/agent-workspace.ts"),
      "utf8",
    );
    for (const boundary of [
      '"--network", "none"',
      '"--read-only"',
      '"--cap-drop", "ALL"',
      '"--security-opt", "no-new-privileges"',
      '"--pids-limit", "32"',
      '"--memory", AGENT_BACKTEST_MEMORY_LIMIT',
      '"--cpus", "1"',
      '"--ulimit"',
      '"--user", "65534:65534"',
      '"node", "--permission"',
      '"--allow-fs-read=/input"',
      '"--allow-fs-write=/output"',
    ]) expect(source).toContain(boundary);
    expect(source).toContain("AGENT_BACKTEST_TIMEOUT_MS");
    expect(source).toContain("fsp.rm(workspace, { recursive: true, force: true })");
    expect(AGENT_BACKTEST_WORKER_VERSION).toBe("agent-backtest-worker-v3");
    expect(AGENT_BACKTEST_MAX_ROWS).toBe(500_000);
    expect(AGENT_BACKTEST_INPUT_LIMIT).toBe(128 * 1024 * 1024);
    expect(AGENT_BACKTEST_MEMORY_LIMIT).toBe("1g");
    expect(AGENT_BACKTEST_TIMEOUT_MS).toBe(60_000);
  });

  it("源码候选保存失败时结果不采纳且运行收敛为 failed", async () => {
    await seedServiceBars();
    const marker = "REJECT_SOURCE_PERSISTENCE";
    await pool.query(
      `ALTER TABLE backtest_run_source
       ADD CONSTRAINT backtest_run_source_test_reject
       CHECK (source_code NOT LIKE '%${marker}%')`,
    );
    try {
      const run = await runAgentBacktest(pool, sessionId, {
        name: "源码保存失败测试",
        kind: "research",
        research_outline: "验证源码保存故障终态",
        hypothesis: "源码未保存时不能采纳回测结果",
        codes: ["SRV001.SZ"],
        start: "2026-01-01",
        end: "2026-01-30",
        initial_cash: 1_000_000,
        parameters: {},
        comparison_run_ids: [],
        base_source_run_id: null,
        source_code: `export default async function run(){ /* ${marker} */ return {}; }`,
      }, {
        execute: async () => ({
          result: {
            metrics: { total_return_pct: 1 },
            conclusion: "该结果不应被采纳",
            data_gaps: [],
            observations: 1,
          },
          error: null,
          timedOut: false,
          aborted: false,
        }),
      });
      expect(run).toMatchObject({
        execution_status: "failed",
        source_retention_status: "none",
        code_cleanup_status: "deleted",
        error_message: "回测源码保存失败，结果未采纳",
      });
    } finally {
      await pool.query(
        "ALTER TABLE backtest_run_source DROP CONSTRAINT IF EXISTS backtest_run_source_test_reject",
      );
    }
  });

  it("服务重启把无法恢复源码的运行标记失败", async () => {
    const interrupted = await pool.query<{ id: string }>(
      `INSERT INTO backtest_run
         (name, kind, status, execution_status, progress, execution_origin,
          code_cleanup_status, source_sha256, source_size_bytes)
       VALUES ('中断样本', 'research', 'archived', 'running', 10, 'agent_workspace',
               'not_applicable', repeat('a', 64), 10)
       RETURNING id::text`,
    );
    expect(await failInterruptedAgentBacktests(pool)).toBe(1);
    expect((await pool.query(
      "SELECT execution_status, progress, code_cleanup_status, error_message FROM backtest_run WHERE id=$1",
      [interrupted.rows[0]!.id],
    )).rows[0]).toMatchObject({
      execution_status: "failed",
      progress: 100,
      code_cleanup_status: "deleted",
    });
  });
});
