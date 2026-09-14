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
import { createPool } from "../../server/db/client.js";
import { contentHash, standardSeedStart, validateStandardPlan, type StandardBacktestPlan } from "../../server/backtest/contracts.js";
import { decodeStandardChunk } from "../../server/backtest/input.js";
import { StandardBacktestRunner } from "../../server/backtest/runner.js";
import { createStandardWorker } from "../../server/backtest/executor.js";
import { startStandardBacktest, getStandardBacktestStatus, cancelStandardBacktest, claimStandardRun, heartbeatStandardRun, expireStandardLeases, appendStandardDay, attachStandardInput } from "../../server/modules/backtests/runtime.js";
import { createStrategyProposal } from "../../server/modules/strategy/repo.js";
import { verifySettlement } from "../../server/backtest/settlement.js";
import { listBacktestRuns } from "../../server/modules/backtests/repo.js";

import { preflightStandardBacktest, freezeStandardBacktestInput, readFrozenStandardInput } from "../../server/modules/backtests/service.js";
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
    expect(detailResponse.json).not.toHaveProperty("artifacts");
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


const standardPlan: StandardBacktestPlan = {
  name: "标准研究测试", hypothesis: "独立测试库验证输入冻结", codes: ["600000.SH"],
  start: "2026-01-05", end: "2026-01-16", rule: "right_side_daily_v1", price_mode: "raw_research", environment_mode: "none",
  initial_cash: 100000, max_positions: 1, daily_buy_limit: 1, position_fraction: 0.2,
  stop_loss_pct: 0.05, max_holding_days: 20, drawdown_circuit: false, stop_streak_circuit: false,
  costs: { label: "不可用于实盘的测试费用", commission_bps: 3, minimum_commission: 5, sell_tax_bps: 5, slippage_bps: 2, volume_participation: 0.01 },
};

describe("标准回测严格契约", () => {
  it("只接受注册规则和完整显式成本，不接收源码或资格声明", () => {
    expect(validateStandardPlan(standardPlan)).toEqual(standardPlan);
    for (const input of [
      { ...standardPlan, source_code: "secret-do-not-echo" },
      { ...standardPlan, evidence_status: "qualified" },
      { ...standardPlan, rule: "arbitrary_rule" },
      { ...standardPlan, start: "2026-02-30" },
      { ...standardPlan, codes: ["600000.SH", "600000.SH"] },
      { ...standardPlan, costs: {} },
      { ...standardPlan, initial_cash: Infinity },
    ]) expect(() => validateStandardPlan(input)).toThrow();
    try { validateStandardPlan({ ...standardPlan, source_code: "secret-do-not-echo" }); }
    catch (error) { expect(String(error)).not.toContain("secret-do-not-echo"); }
    expect(contentHash({ b: 2, a: 1 })).toBe(contentHash({ a: 1, b: 2 }));
    expect(standardSeedStart("2024-02-29")).toBe("2018-02-28");
    expect(standardSeedStart(standardPlan.start)).toBe("2020-01-05");
  });
});

describe.skipIf(!prepared)("标准回测只读预检与不可变输入", () => {
  let db: pg.Pool;
  let instrumentId: string;
  beforeAll(async () => {
    db = createPool(prepared!.url);
    await resetSchema(db);
    await runMigrations(db);
    instrumentId = (await db.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('600000.SH','纯合成测试标的','stock') RETURNING id::text",
    )).rows[0]!.id;
    // 明确合成日历与价格，不声称是实际行情。含六年种子与非交易日。
    await db.query(`INSERT INTO market_trading_day(trade_date,is_open,source)
      SELECT d::date, extract(isodow FROM d)<6, 'synthetic_test'
      FROM generate_series('2020-01-05'::date,'2026-01-16'::date,'1 day') d`);
    await db.query(`INSERT INTO market_bar(instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,volume_unit,adjustment,channel)
      SELECT $1,'day',trade_date,trade_date::timestamp AT TIME ZONE 'UTC',10,11,9,10,100000,'shares','none','synthetic_test'
      FROM market_trading_day WHERE is_open`, [instrumentId]);
  }, 30000);
  afterAll(async () => { await db?.end(); });

  it("保留旧部分完成状态和正式锚点约束，新字段不伪造资格", async () => {
    for (const status of ['legacy','partial','preparing','cancelled','rejected']) {
      const row = (await db.query(`INSERT INTO backtest_run(name,kind,execution_status)
        VALUES ('状态测试','research',$1) RETURNING evidence_status,quality_status,engine_type,status`, [status])).rows[0];
      expect(row).toMatchObject({ evidence_status: 'legacy_unverified', quality_status: 'unchecked', engine_type: 'legacy', status: 'archived' });
    }
    await db.query("INSERT INTO backtest_run(name,kind,status) VALUES ('锚点','formal','active')");
    await expect(db.query("INSERT INTO backtest_run(name,kind,status) VALUES ('重复锚点','formal','active')")).rejects.toThrow();
  });

  it("预检仅检查已有库数据，完整种子仍明确限制为研究证据", async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM market_bar')).rows[0].n;
    const report = await preflightStandardBacktest(db, standardPlan);
    expect(report).toMatchObject({ executable: true, evidence_status: 'research_only', manifest: { seed_start: '2020-01-05', environment_codes: [] } });
    expect(report.manifest.row_count).toBe(before);
    expect(report.manifest.chunks[0]!.date).toBe('2020-01-06');
    expect((await db.query('SELECT count(*)::int AS n FROM market_bar')).rows[0].n).toBe(before);
    expect((await db.query('SELECT count(*)::int AS n FROM backtest_input_set')).rows[0].n).toBe(0);
    expect(report.manifest.gaps.every(gap => gap.severity === 'warning')).toBe(true);
  }, 20000);

  it("冻结可重复复用，源数据修改不改变原输入，旧预检不能冻结新数据", async () => {
    const report = await preflightStandardBacktest(db, standardPlan);
    const expected = { plan_hash: report.plan_hash, input_hash: report.input_hash };
    const frozen = await freezeStandardBacktestInput(db, standardPlan, expected);
    expect((await freezeStandardBacktestInput(db, standardPlan, expected)).id).toBe(frozen.id);
    const variantPlan = { ...standardPlan, stop_loss_pct: 0.08 };
    const variantReport = await preflightStandardBacktest(db, variantPlan);
    expect(variantReport.plan_hash).not.toBe(report.plan_hash);
    expect(variantReport.input_hash).toBe(report.input_hash);
    expect((await freezeStandardBacktestInput(db, variantPlan, {plan_hash: variantReport.plan_hash, input_hash: variantReport.input_hash})).id).toBe(frozen.id);
    const original = [];
    for await (const day of readFrozenStandardInput(db, frozen.id, frozen.sha256)) original.push(day);
    await db.query("UPDATE market_bar SET volume=volume+1 WHERE instrument_id=$1 AND bar_date='2026-01-16'", [instrumentId]);
    const unchanged = [];
    for await (const day of readFrozenStandardInput(db, frozen.id, frozen.sha256)) unchanged.push(day);
    expect(unchanged).toEqual(original);
    await expect(freezeStandardBacktestInput(db, standardPlan, expected)).rejects.toThrow('输入已变化');
    await expect(db.query("UPDATE backtest_input_set SET schema_version='tampered' WHERE id=$1", [frozen.id])).rejects.toThrow('不可修改');
    await expect(db.query("UPDATE backtest_input_chunk SET sha256=repeat('f',64) WHERE input_set_id=$1", [frozen.id])).rejects.toThrow('不可修改');
    const row = (await db.query("SELECT payload,encoding,raw_bytes,sha256,trade_date::text FROM backtest_input_chunk WHERE input_set_id=$1 ORDER BY seq LIMIT 1", [frozen.id])).rows[0];
    expect(() => decodeStandardChunk({ ...row, sha256: 'f'.repeat(64) })).toThrow();
    expect(() => decodeStandardChunk({ ...row, raw_bytes: 9 * 1024 * 1024 })).toThrow();
    expect((await db.query('SELECT count(*)::int AS n FROM backtest_input_set')).rows[0].n).toBe(1);
  }, 30000);

  it("缺日历、种子行情、单位或环境时显式阻止，取消不遗留输入", async () => {
    const report = await preflightStandardBacktest(db, { ...standardPlan, drawdown_circuit: true, environment_mode: "current_881" });
    expect(report.executable).toBe(false);
    expect(report.manifest.gaps.some(gap => gap.domain === 'environment' && gap.severity === 'error')).toBe(true);
    await db.query("UPDATE market_bar SET volume_unit=NULL WHERE instrument_id=$1 AND bar_date='2020-01-06'", [instrumentId]);
    const missing = await preflightStandardBacktest(db, standardPlan);
    expect(missing.executable).toBe(false);
    expect(missing.manifest.gaps.some(gap => gap.code === 'DATA_INVALID')).toBe(true);
    const controller = new AbortController(); controller.abort();
    await expect(freezeStandardBacktestInput(db, standardPlan, {plan_hash: contentHash(standardPlan), input_hash: missing.input_hash}, controller.signal)).rejects.toThrow('取消');
    expect((await db.query('SELECT count(*)::int AS n FROM backtest_input_set')).rows[0].n).toBe(1);
    await db.query("UPDATE market_bar SET volume_unit='shares' WHERE instrument_id=$1", [instrumentId]);
    await db.query("DELETE FROM market_trading_day WHERE trade_date='2020-01-05'");
    expect((await preflightStandardBacktest(db, standardPlan)).executable).toBe(false);
  }, 20000);
});


describe.skipIf(!prepared)("标准回测异步运行闭环（独立库与真实子进程）",()=>{
  let db:pg.Pool;
  let sessionId:string;
  let server:TestServer;
  let runner:StandardBacktestRunner;
  const priorEnabled=process.env.STANDARD_BACKTEST_ENABLED;
  const plan:StandardBacktestPlan={...standardPlan,max_holding_days:2,end:"2026-01-09",benchmark_code:"000300.SH"};
  const request=async(key:string,variant=plan)=>{
    const report=await preflightStandardBacktest(db,variant);
    expect(report.executable).toBe(true);
    return {plan:variant,plan_hash:report.plan_hash,input_hash:report.input_hash,idempotency_key:key};
  };
  beforeAll(async()=>{
    process.env.STANDARD_BACKTEST_ENABLED='true';
    db=createPool(prepared!.url);await resetSchema(db);await runMigrations(db);await seedTestStrategy(db);
    sessionId=(await createSession(db,{title:'标准运行研究',session_type:'backtest'})).id;
    await db.query(`INSERT INTO market_instrument(code,name,kind) VALUES('600000.SH','合成股票','stock'),('000300.SH','合成基准','index')`);
    await db.query(`INSERT INTO market_trading_day(trade_date,is_open,source)
      SELECT d::date,extract(isodow FROM d)<6,'synthetic_test' FROM generate_series('2020-01-05'::date,'2026-01-09'::date,'1 day')d`);
    await db.query(`INSERT INTO market_bar(instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,volume_unit,adjustment,channel)
      SELECT i.id,'day',t.trade_date,t.trade_date::timestamp AT TIME ZONE 'UTC',10,13,9,10,100000,'shares','none','synthetic_test'
      FROM market_instrument i CROSS JOIN market_trading_day t WHERE t.is_open`);
    await db.query(`UPDATE market_bar SET open=10.5,close=11,volume=200000 WHERE instrument_id=(SELECT id FROM market_instrument WHERE code='600000.SH') AND bar_date='2026-01-05'`);
    await db.query(`UPDATE market_bar SET open=11,close=11 WHERE instrument_id=(SELECT id FROM market_instrument WHERE code='600000.SH') AND bar_date>'2026-01-05'`);
    await db.query(`UPDATE market_bar SET open=11,close=11 WHERE instrument_id=(SELECT id FROM market_instrument WHERE code='000300.SH') AND bar_date>'2026-01-05'`);
    runner=new StandardBacktestRunner(db);server=await startTestServer(db);
  },30000);
  afterAll(async()=>{await runner?.stop();await server?.close();await db?.end();if(priorEnabled===undefined)delete process.env.STANDARD_BACKTEST_ENABLED;else process.env.STANDARD_BACKTEST_ENABLED=priorEnabled;});
  it('真实子进程不继承数据库凭据、停止信号可中断，且不依赖Docker',async()=>{
    const controller=new AbortController();const worker=createStandardWorker(controller.signal);
    try{await worker.init(standardPlan);controller.abort();await expect(worker.finish()).rejects.toThrow();}finally{await worker.close();}
    const source=await fs.readFile(path.join(import.meta.dirname,'../../server/backtest/executor.ts'),'utf8');
    expect(source).not.toContain('...process.env');expect(source).not.toContain('DATABASE_URL');
    expect(source).toContain("NODE_ENV:'production'");
  });
  it('排队幂等、真实运行、逐日核账、基准、分页与研究最终化',async()=>{
    const input=await request('first');
    const created=await startStandardBacktest(db,sessionId,input);
    expect(created).toMatchObject({execution_status:'queued',evidence_status:'research_only'});
    expect((await startStandardBacktest(db,sessionId,input)).id).toBe(created.id);
    await expect(startStandardBacktest(db,sessionId,{...input,plan:{...plan,name:'冲突'},plan_hash:contentHash({...plan,name:'冲突'})})).rejects.toThrow('幂等键');
    await runner.tick();
    const status=(await getStandardBacktestStatus(db,created.id))!;
    expect(status).toMatchObject({execution_status:'success',quality_status:'complete',evidence_status:'research_only',replay_status:'exact'});
    expect(status.metrics_json!.trade_count).toBeGreaterThan(0);
    expect(status.metrics_json!.benchmark_return).toBeCloseTo(0.1);
    const runtime=await api(server.baseUrl,'GET',`/api/backtests/${created.id}?view=runtime`);
    expect(runtime.status).toBe(200);expect(JSON.stringify(runtime.json)).not.toContain('lease_token');
    const equity=await api(server.baseUrl,'GET',`/api/backtests/${created.id}?view=equity&limit=2`);
    expect((equity.json as {items:unknown[]}).items).toHaveLength(2);
    expect((equity.json as {next_cursor:string}).next_cursor).toBeTruthy();
    const event=await api(server.baseUrl,'GET',`/api/backtests/${created.id}?view=events&limit=1`);
    expect((event.json as {items:unknown[]}).items).toHaveLength(1);
    expect((await listBacktestRuns(db)).some(r=>r.id===created.id)).toBe(false);
    expect((await listBacktestRuns(db,{scope:'working'})).some(r=>r.id===created.id)).toBe(true);
    await finalizeBacktest(db,{session_id:sessionId,run_id:created.id,conclusion_summary:'只读研究总结',applicability_boundary:'固定样本和日频近似'});
    expect((await listBacktestRuns(db)).some(r=>r.id===created.id)).toBe(true);
    const publishing=(await createSession(db,{title:'证据门槛验证',session_type:'interactive'})).id;
    const state=(await db.query('SELECT change_seq::text,current_hash FROM strategy_state WHERE singleton=1')).rows[0];
    const doc=(await db.query("SELECT id::text,sha256 FROM strategy_document WHERE code='test_strategy'")).rows[0];
    await expect(createStrategyProposal(db,{session_id:publishing,base_change_seq:state.change_seq,base_strategy_hash:state.current_hash,
      outline:'研究不能伪装正式证据',conclusion:'必须拒绝',adjustments:['保持资格边界'],summary:'测试拒绝研究证据',
      changes:[{document_id:doc.id,base_sha256:doc.sha256,content:'# 测试候选'}],backtest_run_ids:[created.id]})).rejects.toThrow('证据');
    expect((await api(server.baseUrl,'GET',`/api/backtests/${created.id}?view=equity&limit=0`)).status).toBe(400);
    const rows=(await db.query('SELECT payload FROM backtest_equity_daily WHERE run_id=$1 ORDER BY trade_date',[created.id])).rows;
    expect(rows).toHaveLength(5);
    expect(rows.every(r=>r.payload.cash_cents+r.payload.market_value_cents===r.payload.equity_cents)).toBe(true);
    const variant={...plan,stop_loss_pct:0.08};const second=await startStandardBacktest(db,sessionId,{...await request('variant',variant),comparison_run_ids:[created.id]});
    await runner.tick();
    expect((await getStandardBacktestStatus(db,second.id))!.comparisons).toEqual([{run_id:created.id,comparable:true,reasons:[],parameter_differences:['stop_loss_pct']}]);
  },60000);
  it('排队取消、失效租约与错误代次不能写入；重复取消不改终态',async()=>{
    const queued=await startStandardBacktest(db,sessionId,await request('cancel'));
    expect((await cancelStandardBacktest(db,queued.id,'用户取消',sessionId)).execution_status).toBe('cancelled');
    expect((await cancelStandardBacktest(db,queued.id,'重复取消',sessionId)).execution_status).toBe('cancelled');
    const input=await request('lease');const next=await startStandardBacktest(db,sessionId,input);
    const claim=(await claimStandardRun(db))!;expect(claim.id).toBe(next.id);
    expect(await claimStandardRun(db)).toBeNull();
    expect(await heartbeatStandardRun(db,{...claim,lease_token:'00000000-0000-0000-0000-000000000000'})).toBe(false);
    const frozen=await freezeStandardBacktestInput(db,plan,input);await attachStandardInput(db,claim,frozen);
    await cancelStandardBacktest(db,claim.id,'运行中取消',sessionId);
    await expect(appendStandardDay(db,claim,{date:plan.start,bars:[],market_recovery:null},{events:[],equity:{date:plan.start,cash_cents:1,market_value_cents:0,equity_cents:1,fees_cents:0,daily_return:0,drawdown:0,paused:false,positions:[]}})).rejects.toThrow('LEASE_LOST');
    const expired=await startStandardBacktest(db,sessionId,await request('expire'));const lease=(await claimStandardRun(db))!;expect(lease.id).toBe(expired.id);
    await db.query("UPDATE backtest_run SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);
    await expireStandardLeases(db);
    expect((await getStandardBacktestStatus(db,expired.id))!.execution_status).toBe('failed');
    expect(await heartbeatStandardRun(db,lease)).toBe(false);
  },30000);
  it('运行中真实取消与停止领取竞争均不会留下仍执行的任务',async()=>{
    const run=await startStandardBacktest(db,sessionId,await request('live-cancel'));
    const execution=runner.tick();
    let running=false;
    for(let i=0;i<100;i++){
      const state=(await getStandardBacktestStatus(db,run.id))!;
      if(state.execution_status==='running'){running=true;break;}
      if(['failed','success','rejected'].includes(state.execution_status))break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    expect(running).toBe(true);
    await cancelStandardBacktest(db,run.id,'停止真实工作器',sessionId);await execution;
    expect((await getStandardBacktestStatus(db,run.id))!.execution_status).toBe('cancelled');
    const race=await startStandardBacktest(db,sessionId,await request('stop-race'));
    const other=new StandardBacktestRunner(db);const ticking=other.tick();await other.stop();await ticking;
    expect(['queued','failed']).toContain((await getStandardBacktestStatus(db,race.id))!.execution_status);
    await cancelStandardBacktest(db,race.id,'清理排队验证',sessionId);
  },30000);
  it('原始价列与前复权列并存时按计划选取，不用复权价冒充原价',async()=>{
    const original=await preflightStandardBacktest(db,plan);
    await db.query(`UPDATE market_bar SET open_raw=open,high_raw=high,low_raw=low,close_raw=close,
      open=open/2,high=high/2,low=low/2,close=close/2,adjustment='forward'
      WHERE instrument_id=(SELECT id FROM market_instrument WHERE code='600000.SH')`);
    const raw=await preflightStandardBacktest(db,plan);
    expect(raw.executable).toBe(true);expect(raw.input_hash).toBe(original.input_hash);
    const forward=await preflightStandardBacktest(db,{...plan,price_mode:'forward_research'});
    expect(forward.executable).toBe(true);expect(forward.input_hash).not.toBe(raw.input_hash);
  },20000);
  it('预检过期拒绝而不是读取新行情，关闭开关不创建运行',async()=>{
    const input=await request('stale');
    await db.query("UPDATE market_bar SET volume=volume+1 WHERE bar_date='2026-01-09'");
    const started=await startStandardBacktest(db,sessionId,input);await runner.tick();
    expect((await getStandardBacktestStatus(db,started.id))!).toMatchObject({execution_status:'rejected',error_message:'INPUT_CHANGED'});
    process.env.STANDARD_BACKTEST_ENABLED='false';await expect(startStandardBacktest(db,sessionId,input)).rejects.toThrow('未开启');process.env.STANDARD_BACKTEST_ENABLED='true';
  },30000);
  it('父进程独立拒绝自报权益和伪造现金',()=>{
    expect(()=>verifySettlement(plan,{date:plan.start,bars:[],market_recovery:null},{events:[],equity:{date:plan.start,cash_cents:1,market_value_cents:0,equity_cents:1,fees_cents:0,daily_return:0,drawdown:0,paused:false,positions:[]}},null,0)).toThrow('LEDGER_MISMATCH');
  });
});
describe("标准组合契约", () => {
  it("组合计划从策略集合派生标的并拒绝重叠代码", () => {
    const strategy = { rule: "right_side_daily_v1", codes: ["600000.SH"], allocation_pct: 0.5, max_positions: 1, daily_buy_limit: 1, position_fraction: 0.2, stop_loss_pct: 0.05, max_holding_days: 20 };
    const parsed = validateStandardPlan({ ...standardPlan, codes: ["600000.SH", "600001.SZ"], rule: "portfolio_daily_v1", strategies: [strategy, { ...strategy, rule: "swing_box_daily_v1", codes: ["600001.SZ"] }] });
    expect(parsed.codes).toEqual(["600000.SH", "600001.SZ"]);
    expect(parsed.strategies).toHaveLength(2);
    expect(() => validateStandardPlan({ ...standardPlan, codes: ["600000.SH", "600001.SZ"], rule: "portfolio_daily_v1", strategies: [strategy, { ...strategy, codes: ["600000.SH"] }] })).toThrow("组合内同一标的不得重复分配给多个策略");
  });
});
