// M3 作业系统：cron 去重/missed、Runner/重试/锁、API 与安全配置回归。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type pg from "pg";
import { setAiRuntimeForTests } from "../../server/agent/ai/runtime.js";
import { buildJobPoolAttentionTool } from "../../server/agent/job-tools.js";
import { acquireAgentMutationLock } from "../../server/agent/mutation-lock.js";
import { acquireMarketMutationLock } from "../../server/datasource/mutation-lock.js";
import { controlAgentRun, getActiveAgentRun } from "../../server/agent/run-control.js";
import { updateSessionStatus } from "../../server/agent/repo.js";
import { runMigrations } from "../../server/db/migrate.js";
import {
  createJobDefinition,
  insertScheduledJobRun,
  listJobDefinitions,
  listJobRuns,
  queueManualJob,
  updateJobDefinition,
} from "../../server/scheduler/repo.js";
import { executeJobRun, resolveDailyUpdateScope } from "../../server/scheduler/runner.js";
import { JobScheduler } from "../../server/scheduler/service.js";
import { cronOccurrences, shanghaiDate } from "../../server/scheduler/time.js";
import { api, prepareTestDb, resetSchema, seedTestStrategy, startTestServer, type TestServer } from "./helpers.js";

const prepared = await prepareTestDb();

function dailySummary(gaps: unknown[] = []) {
  return {
    date: "2026-08-17",
    snapshotRows: 12,
    refetched: [],
    futuresRows: 2,
    minute30Rows: 4,
    gaps,
    fetchRunIds: ["1"],
  };
}

describe.skipIf(!prepared)("M3 作业调度与 Runner", () => {
  let pool: pg.Pool;
  let server: TestServer;

  beforeAll(async () => {
    pool = prepared!.pool;
    server = await startTestServer(pool);
  });

  beforeEach(async () => {
    await resetSchema(pool);
    await runMigrations(pool);
    await seedTestStrategy(pool);
    await pool.query(
      `INSERT INTO market_trading_day (trade_date, is_open, source) VALUES
         ('2026-08-17', true, 'test'), ('2026-08-18', true, 'test'),
         ('2026-08-19', true, 'test'), ('2026-08-20', true, 'test'),
         ('2026-08-21', true, 'test')`,
    );
  });

  afterAll(async () => {
    setAiRuntimeForTests(null);
    await server.close();
    await pool.end();
  });

  it("迁移初始化八个受控作业，新增市场作业默认关闭，cron 固定按上海时区解析", async () => {
    const jobs = await listJobDefinitions(pool);
    expect(jobs.map((job) => job.code)).toEqual([
      "auction_opportunity_assessment",
      "board_membership_sync",
      "daily_data_update",
      "daily_market_structure",
      "daily_plan_flow",
      "market_catalog_sync",
      "midweek_check",
      "weekly_review",
    ]);
    expect(jobs.find((job) => job.code === "midweek_check")?.cron).toBe("30 17 * * 2");
    expect(jobs.find((job) => job.code === "weekly_review")?.cron).toBe("0 20 * * 0");
    expect(jobs.find((job) => job.code === "auction_opportunity_assessment")?.cron).toBe("30 9 * * 1-5");
    expect(jobs.find((job) => job.code === "daily_plan_flow")?.config).toEqual({
      daily_plan_write: true,
      pool_attention_write: true,
    });
    expect(jobs.filter((job) => job.job_type === "agent_flow" && job.code !== "daily_plan_flow")
      .every((job) => Object.keys(job.config).length === 0)).toBe(true);
    expect(
      jobs
        .filter((job) => ["market_catalog_sync", "board_membership_sync", "daily_market_structure"].includes(job.code))
        .every((job) => job.enabled === false),
    ).toBe(true);
    const prompts = await pool.query<{ code: string; content: string }>(
      `SELECT p.code, r.content FROM job_prompt p JOIN job_prompt_revision r ON r.id = p.current_revision_id ORDER BY p.code`,
    );
    expect(prompts.rows).toHaveLength(4);
    expect(prompts.rows.every((row) => row.content.includes("当前最终策略"))).toBe(true);
    expect(prompts.rows.every((row) => row.content.includes("job_run_output"))).toBe(true);
    expect(prompts.rows.every((row) => !row.content.includes(".md"))).toBe(true);
    expect(prompts.rows.some((row) => row.content.includes("## 近期关注维护"))).toBe(true);
    expect(prompts.rows.every((row) => !row.content.includes("## 策略模拟账户信号"))).toBe(true);
    const auctionPrompt = prompts.rows.find((row) => row.code === "auction_opportunity_assessment")!.content;
    expect(auctionPrompt).toContain("auction_short_term_benchmark");
    expect(auctionPrompt).toContain("auction_snapshot");
    expect(auctionPrompt).toContain("stage='final'");
    expect(auctionPrompt).toContain("延续确认·一字排队观察");
    expect(auctionPrompt).toContain("延续确认·换手晋级观察");
    expect(auctionPrompt).toContain("不得对打板候选使用 `worth_entering`");
    expect(auctionPrompt).not.toContain("放弃（非排队口径）");
    expect(auctionPrompt).toContain("不得自动买入、自动入池或自动标记近期关注");
    expect(shanghaiDate(new Date("2026-08-16T16:30:00Z"))).toBe("2026-08-17");
    expect(
      cronOccurrences(
        "0 9 * * 1",
        new Date("2026-08-16T00:00:00Z"),
        new Date("2026-08-17T02:00:00Z"),
      ).map((date) => date.toISOString()),
    ).toEqual(["2026-08-17T01:00:00.000Z"]);
  });

  it("日更范围包含核心指数、官方行业和当日池外市场结构候选，不跟随全量目录膨胀", async () => {
    await pool.query(
      `INSERT INTO market_instrument (code,name,kind,lifecycle_status) VALUES
         ('000300.SH','沪深300','index','active'),
         ('000851.SH','非核心指数','index','active'),
         ('881101.TI','同花顺一级行业','board','active'),
         ('884001.TI','同花顺二级行业','board','active'),
         ('885001.TI','同花顺概念板块','board','active'),
         ('881102.TI','失效一级行业','board','inactive'),
         ('600001.SH','普通池外股票','stock','active'),
         ('600002.SH','涨停池外候选','stock','active'),
         ('600003.SH','龙虎榜池外候选','stock','active')`,
    );
    await pool.query(
      `INSERT INTO market_board (instrument_id,board_type,source,active)
       SELECT id,
              CASE WHEN code = '885001.TI' THEN 'concept' ELSE 'industry' END,
              'hithink', true
         FROM market_instrument WHERE kind = 'board'`,
    );
    await pool.query(
      `INSERT INTO market_limit_event
         (trade_date,event_type,instrument_id,streak_count,source_row_sha256)
       SELECT '2026-08-20','up',id,2,repeat('a',64)
         FROM market_instrument WHERE code='600002.SH';
       INSERT INTO market_dragon_tiger_entry
         (trade_date,dataset_type,instrument_id,net_amount,source_row_sha256)
       SELECT '2026-08-20','org',id,1000000,repeat('b',64)
         FROM market_instrument WHERE code='600003.SH'`,
    );
    const scope = await resolveDailyUpdateScope(pool, "2026-08-20");
    expect(scope.codes).toEqual(["000300.SH", "600002.SH", "600003.SH", "881101.TI", "884001.TI"]);
    expect(scope.minute30).toEqual(["000300.SH"]);
  });

  it("同一 job/scheduled_for 并发 tick 只插入一条", async () => {
    const job = (await listJobDefinitions(pool))[0]!;
    const at = new Date("2026-08-17T07:45:00Z");
    const [left, right] = await Promise.all([
      insertScheduledJobRun(pool, job.id, at, "queued"),
      insertScheduledJobRun(pool, job.id, at, "queued"),
    ]);
    expect([left, right].filter(Boolean)).toHaveLength(1);
    const count = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM job_run WHERE job_id = $1 AND scheduled_for = $2",
      [job.id, at],
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  it("运行记录按创建时间倒序，不把文本 ID 当排序键", async () => {
    await pool.query("ALTER TABLE job_run ALTER COLUMN id RESTART WITH 9");
    const older = await queueManualJob(pool, "daily_plan_flow", "2026-08-18");
    const newer = await queueManualJob(pool, "daily_plan_flow", "2026-08-19");
    await pool.query(
      `UPDATE job_run SET created_at = CASE id
         WHEN $1 THEN '2026-08-18T09:00:00Z'::timestamptz
         ELSE '2026-08-19T09:00:00Z'::timestamptz END
       WHERE id IN ($1, $2)`,
      [older.id, newer.id],
    );
    expect((await listJobRuns(pool, older.job_id, 10)).map((run) => run.id))
      .toEqual([newer.id, older.id]);
  });

  it("启动扫描把停机期间计划时刻记为 missed，复扫幂等且不补跑", async () => {
    await pool.query("UPDATE job_definition SET enabled = false");
    const job = await createJobDefinition(pool, {
      code: "missed_probe",
      name: "漏跑探针",
      cron: "0 9 * * *",
      job_type: "agent_flow",
      config: {},
      prompt_id: (await pool.query<{ id: string }>("SELECT id::text FROM job_prompt WHERE code = 'daily_plan_flow'")).rows[0]!.id,
    });
    await pool.query(
      "UPDATE job_definition SET created_at = $2, updated_at = $2 WHERE id = $1",
      [job.id, "2026-08-15T00:00:00Z"],
    );
    const scheduler = new JobScheduler({
      pool,
      databaseUrl: prepared!.url,
      now: () => new Date("2026-08-17T02:00:00Z"),
    });
    expect(await scheduler.recoverMissed(new Date("2026-08-17T02:00:00Z"))).toBe(3);
    expect(await scheduler.recoverMissed(new Date("2026-08-17T02:00:00Z"))).toBe(0);
    const rows = await pool.query("SELECT status, attempt_count FROM job_run ORDER BY id");
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.every((row) => row.status === "missed" && row.attempt_count === 0)).toBe(true);
    expect(Number((await pool.query("SELECT count(*) FROM chat_session WHERE session_type = 'job'")).rows[0]!.count)).toBe(0);
  });

  it("Agent 作业排队时原子关联唯一 session，非 Agent 与 missed 不创建伪 session", async () => {
    const manual = await queueManualJob(pool, "daily_plan_flow", "2026-08-18");
    expect(manual.session_id).toBeTruthy();
    const session = await pool.query(
      "SELECT session_type, session_status, source FROM chat_session WHERE id = $1",
      [manual.session_id],
    );
    expect(session.rows[0]).toEqual({
      session_type: "job",
      session_status: "queued",
      source: "manual_job",
    });

    const datasource = await queueManualJob(
      pool,
      "daily_data_update",
      "2026-08-18",
      new Date("2026-08-19T08:00:00Z"),
    );
    expect(datasource.session_id).toBeNull();

    const flow = (await listJobDefinitions(pool)).find((job) => job.code === "daily_plan_flow")!;
    const missed = await insertScheduledJobRun(
      pool,
      flow.id,
      new Date("2026-08-18T09:15:00Z"),
      "missed",
    );
    expect(missed?.session_id).toBeNull();

    const scheduledAt = new Date("2026-08-19T09:15:00Z");
    const [left, right] = await Promise.all([
      insertScheduledJobRun(pool, flow.id, scheduledAt, "queued"),
      insertScheduledJobRun(pool, flow.id, scheduledAt, "queued"),
    ]);
    const scheduled = [left, right].filter((item) => item !== null);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.session_id).toBeTruthy();
    expect(
      Number((await pool.query(
        `SELECT count(*) FROM chat_session s
          WHERE s.session_type = 'job'
            AND s.id = (SELECT session_id FROM job_run WHERE job_id = $1 AND scheduled_for = $2)`,
        [flow.id, scheduledAt],
      )).rows[0]!.count),
    ).toBe(1);
  });

  it("Agent session 创建失败时排队事务整体回滚，不留下可执行 job_run", async () => {
    await pool.query(`
      CREATE FUNCTION test_reject_job_session() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.session_type = 'job' THEN RAISE EXCEPTION '测试：拒绝任务 session'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_reject_job_session_trigger
      BEFORE INSERT ON chat_session FOR EACH ROW EXECUTE FUNCTION test_reject_job_session();
    `);
    const before = Number((await pool.query("SELECT count(*) FROM job_run")).rows[0]!.count);
    try {
      await expect(queueManualJob(pool, "daily_plan_flow", "2026-08-18")).rejects.toThrow(
        "测试：拒绝任务 session",
      );
      expect(Number((await pool.query("SELECT count(*) FROM job_run")).rows[0]!.count)).toBe(before);
    } finally {
      await pool.query("DROP TRIGGER test_reject_job_session_trigger ON chat_session");
      await pool.query("DROP FUNCTION test_reject_job_session()");
    }
  });

  it("日更手动入口拒绝盘前快照，历史目标日仍可排队并切换历史模式", async () => {
    await expect(
      queueManualJob(pool, "daily_data_update", undefined, new Date("2026-08-21T01:00:00Z")),
    ).rejects.toMatchObject({ message: expect.stringContaining("尚未收盘") });
    expect(Number((await pool.query("SELECT count(*) FROM job_run")).rows[0]!.count)).toBe(0);

    const historical = await queueManualJob(
      pool,
      "daily_data_update",
      "2026-08-20",
      new Date("2026-08-21T01:00:00Z"),
    );
    expect(historical.target_date).toBe("2026-08-20");
  });

  it("每日计划窄权限工具只维护池内自动关注且不覆盖人工关注", async () => {
    await pool.query("INSERT INTO market_instrument (code,name,kind) VALUES ('990088.SZ','关注工具测试','stock')");
    await pool.query(
      `INSERT INTO pool_membership (instrument_id,pool,role,effective_from)
       SELECT id,'short','观察','2026-08-01' FROM market_instrument WHERE code='990088.SZ'`,
    );
    const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-18");
    const tool = buildJobPoolAttentionTool({ pool, sessionId: run.session_id! });
    await tool.execute("tc-attention-mark", {
      reason: "每日计划识别出接近完整条件",
      action: "mark",
      code: "990088.SZ",
      pool: "short",
      attention_status: "approaching",
      attention_reason: "仍缺放量站稳关键位",
      attention_from: "2026-08-18",
      attention_until: "2026-08-25",
    });
    expect((await pool.query(
      "SELECT attention_reason,attention_from::text,attention_until::text FROM pool_membership WHERE effective_to IS NULL",
    )).rows[0]).toEqual({
      attention_reason: "每日计划·即将符合：仍缺放量站稳关键位",
      attention_from: "2026-08-18",
      attention_until: "2026-08-25",
    });
    await pool.query("UPDATE pool_membership SET attention_reason='人工持续跟踪' WHERE effective_to IS NULL");
    await expect(tool.execute("tc-attention-clear", {
      reason: "本轮已不接近条件",
      action: "clear",
      code: "990088.SZ",
      pool: "short",
    })).rejects.toThrow("不得清除");
    expect((await pool.query("SELECT attention_reason FROM pool_membership WHERE effective_to IS NULL")).rows[0]!.attention_reason)
      .toBe("人工持续跟踪");
  });

  it("调度器最多并行三个任务，且 datasource 保持单路执行", async () => {
    await pool.query("UPDATE job_definition SET enabled = false");
    for (const code of ["parallel_data_a", "parallel_data_b"]) {
      await createJobDefinition(pool, {
        code,
        name: code,
        cron: "0 0 * * *",
        job_type: "datasource",
        config: { pipeline: "daily_market_update", export_volume: false },
      });
    }
    for (const code of ["parallel_analysis_a", "parallel_analysis_b"]) {
      await createJobDefinition(pool, {
        code,
        name: code,
        cron: "0 0 * * *",
        job_type: "analysis",
        config: { analysis_type: "sector_temperature" },
      });
    }
    const runs = [];
    for (const code of ["parallel_data_a", "parallel_data_b", "parallel_analysis_a", "parallel_analysis_b"]) {
      runs.push(await queueManualJob(pool, code, "2026-08-20"));
    }

    let active = 0;
    let maxActive = 0;
    let activeDatasource = 0;
    let maxActiveDatasource = 0;
    let started = 0;
    let release!: () => void;
    let threeStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { threeStarted = resolve; });
    const enter = async (datasource: boolean): Promise<void> => {
      active += 1;
      started += 1;
      maxActive = Math.max(maxActive, active);
      if (datasource) {
        activeDatasource += 1;
        maxActiveDatasource = Math.max(maxActiveDatasource, activeDatasource);
      }
      if (started === 3) threeStarted();
      await gate;
      active -= 1;
      if (datasource) activeDatasource -= 1;
    };
    const scheduler = new JobScheduler({
      pool,
      databaseUrl: prepared!.url,
      dailyUpdate: async () => {
        await enter(true);
        return dailySummary();
      },
      analysisRun: async () => {
        await enter(false);
        return { id: "1", status: "success", data_gaps: [] };
      },
    });
    const starting = scheduler.start();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("三个任务未并行启动")), 2_000);
        }),
      ]);
      expect(maxActive).toBe(3);
      expect(maxActiveDatasource).toBe(1);
      release();
      for (let index = 0; index < 100; index += 1) {
        const terminal = await pool.query<{ status: string }>(
          "SELECT status FROM job_run WHERE id = ANY($1::bigint[])",
          [runs.map((run) => run.id)],
        );
        if (terminal.rows.every((row) => row.status === "success")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      release();
      await starting;
      await scheduler.stop();
    }
    const statuses = await pool.query<{ status: string }>(
      "SELECT status FROM job_run WHERE id = ANY($1::bigint[]) ORDER BY id",
      [runs.map((run) => run.id)],
    );
    expect(statuses.rows.map((row) => row.status)).toEqual(["success", "success", "success", "success"]);
  });

  it("长任务运行时仍按时扫描并启动其他 cron 任务", async () => {
    await pool.query("UPDATE job_definition SET enabled = false");
    await createJobDefinition(pool, {
      code: "slow_datasource",
      name: "慢数据任务",
      cron: "0 16 * * *",
      job_type: "datasource",
      config: { pipeline: "daily_market_update", export_volume: false },
    });
    await createJobDefinition(pool, {
      code: "independent_analysis",
      name: "独立分析任务",
      cron: "1 16 * * *",
      job_type: "analysis",
      config: { analysis_type: "sector_temperature" },
    });
    let now = new Date("2026-08-17T08:00:00Z");
    let releaseSlow!: () => void;
    let markSlowStarted!: () => void;
    let markFastStarted!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const slowStarted = new Promise<void>((resolve) => { markSlowStarted = resolve; });
    const fastStarted = new Promise<void>((resolve) => { markFastStarted = resolve; });
    const scheduler = new JobScheduler({
      pool,
      databaseUrl: prepared!.url,
      tickMs: 300_000,
      now: () => now,
      dailyUpdate: async () => {
        markSlowStarted();
        await slowGate;
        return dailySummary();
      },
      analysisRun: async () => {
        markFastStarted();
        return { id: "1", status: "success", data_gaps: [] };
      },
    });
    await scheduler.start();
    try {
      await slowStarted;
      now = new Date("2026-08-17T08:01:00Z");
      scheduler.wake();
      await Promise.race([
        fastStarted,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("独立任务被慢任务阻塞")), 2_000)),
      ]);
    } finally {
      releaseSlow();
      await scheduler.stop();
    }
    const statuses = await pool.query<{ code: string; status: string }>(
      `SELECT d.code, r.status FROM job_run r JOIN job_definition d ON d.id = r.job_id
        WHERE d.code IN ('slow_datasource', 'independent_analysis') ORDER BY d.code`,
    );
    expect(statuses.rows).toEqual([
      { code: "independent_analysis", status: "success" },
      { code: "slow_datasource", status: "success" },
    ]);
  });

  it("30 秒调度循环在命中时刻自动执行 datasource，且结果成功入账", async () => {
    await pool.query("UPDATE job_definition SET enabled = false");
    await createJobDefinition(pool, {
      code: "tick_datasource",
      name: "tick 数据源",
      cron: "0 16 * * *",
      job_type: "datasource",
      config: { pipeline: "daily_market_update", export_volume: false },
    });
    const dailyUpdate = vi.fn(async () => dailySummary());
    const scheduler = new JobScheduler({
      pool,
      databaseUrl: prepared!.url,
      now: () => new Date("2026-08-17T08:00:00Z"),
      tickMs: 30_000,
      dailyUpdate,
    });
    await scheduler.start();
    await scheduler.stop();
    expect(dailyUpdate).toHaveBeenCalledTimes(1);
    const run = await pool.query("SELECT status, target_date::text FROM job_run");
    expect(run.rows).toEqual([{ status: "success", target_date: "2026-08-17" }]);
  });

  it("datasource 串起行情与 scheduled 数据卷，存在缺口时记 partial", async () => {
    await updateJobDefinition(pool, "daily_data_update", {
      config: { pipeline: "daily_market_update", export_volume: true },
    });
    const run = await queueManualJob(
      pool,
      "daily_data_update",
      "2026-08-17",
      new Date("2026-08-18T08:00:00Z"),
    );
    const volumeExport = vi.fn(async () => ({
      dumpPath: "/tmp/test.dump",
      manifestPath: "/tmp/test.manifest.json",
    }) as never);
    const finished = await executeJobRun(
      {
        pool,
        databaseUrl: prepared!.url,
        dailyUpdate: async () => dailySummary([{ code: "000001.SH", reason: "测试缺口" }]),
        volumeExport,
      },
      run.id,
    );
    expect(finished?.status).toBe("partial");
    expect(finished?.data_gaps).toHaveLength(1);
    expect(finished?.artifacts).toEqual([
      expect.objectContaining({ kind: "volume_snapshot", path: expect.any(String) }),
    ]);
    expect(volumeExport).toHaveBeenCalledTimes(1);
  });

  it("市场域写锁争用时 datasource 零调用并进入一次重试，不盲目并发写库", async () => {
    await updateJobDefinition(pool, "daily_data_update", {
      config: { pipeline: "daily_market_update", export_volume: false },
    });
    const run = await queueManualJob(
      pool,
      "daily_data_update",
      "2026-08-17",
      new Date("2026-08-18T08:00:00Z"),
    );
    const lockClient = await pool.connect();
    const dailyUpdate = vi.fn(async () => dailySummary());
    try {
      await lockClient.query("BEGIN");
      await acquireMarketMutationLock(lockClient);
      const result = await executeJobRun(
        { pool, databaseUrl: prepared!.url, dailyUpdate },
        run.id,
      );
      expect(result?.status).toBe("queued");
      expect(result?.attempt_count).toBe(1);
      expect(dailyUpdate).not.toHaveBeenCalled();
    } finally {
      await lockClient.query("ROLLBACK");
      lockClient.release();
    }
  });

  it("市场作业不占 Agent 写锁，目录、板块和结构 pipeline 分别入账", async () => {
    const lockClient = await pool.connect();
    try {
      await lockClient.query("BEGIN");
      await acquireAgentMutationLock(lockClient);

      const catalogJob = await createJobDefinition(pool, {
        code: "catalog_probe",
        name: "目录探针",
        cron: "0 0 * * *",
        job_type: "datasource",
        config: { pipeline: "market_catalog_sync", export_volume: false },
      });
      const catalogRun = await queueManualJob(pool, catalogJob.code, "2026-08-17");
      const catalog = await executeJobRun({
        pool,
        databaseUrl: prepared!.url,
        catalogSync: async () => ({ tickerCount: 10, boardCount: 4, tradingDayCount: 2, fetchRunIds: ["9"] }),
      }, catalogRun.id);
      expect(catalog).toMatchObject({ status: "success", artifacts: [{ kind: "market_fetch_run", id: "9" }] });

      const boardJob = await createJobDefinition(pool, {
        code: "board_probe",
        name: "板块探针",
        cron: "0 0 * * *",
        job_type: "datasource",
        config: { pipeline: "board_membership_sync", export_volume: false },
      });
      const boardRun = await queueManualJob(pool, boardJob.code, "2026-08-17");
      const board = await executeJobRun({
        pool,
        databaseUrl: prepared!.url,
        boardMembershipSync: async () => ({
          completed: [{ memberCount: 12, opened: 2, closed: 1 }],
          gaps: [{ code: "885001.TI", reason: "测试缺口" }],
        }),
      }, boardRun.id);
      expect(board).toMatchObject({ status: "partial", data_gaps: [{ code: "885001.TI" }] });

      const structureJob = await createJobDefinition(pool, {
        code: "structure_probe",
        name: "结构探针",
        cron: "0 0 * * *",
        job_type: "datasource",
        config: { pipeline: "daily_market_structure", export_volume: false },
      });
      const structureRun = await queueManualJob(pool, structureJob.code, "2026-08-17");
      const structure = await executeJobRun({
        pool,
        databaseUrl: prepared!.url,
        marketStructureSync: async () => ({
          datasets: [{
            dataset: "limit_up",
            targetDate: "2026-08-17",
            status: "success",
            rows: 8,
            completedPages: 1,
            totalPages: 1,
            gaps: [],
            runId: "21",
          }],
          gaps: [],
        }),
      }, structureRun.id);
      expect(structure).toMatchObject({
        status: "success",
        artifacts: [{ kind: "market_special_sync_run", id: "21", dataset: "limit_up" }],
      });
    } finally {
      await lockClient.query("ROLLBACK");
      lockClient.release();
    }
  });

  it("失败只自动重试一次，第二次失败进入 failed", async () => {
    const job = await createJobDefinition(pool, {
      code: "retry_analysis",
      name: "重试分析",
      cron: "0 0 * * *",
      job_type: "analysis",
      config: { analysis_type: "sector_temperature", request: {} },
    });
    const run = await queueManualJob(pool, job.code, "2026-08-17");
    let now = new Date("2026-08-17T01:00:00Z");
    const deps = {
      pool,
      databaseUrl: prepared!.url,
      retryDelayMs: 1_000,
      now: () => now,
      analysisRun: async () => { throw new Error("固定失败"); },
    };
    const first = await executeJobRun(deps, run.id);
    expect(first).toMatchObject({ status: "queued", attempt_count: 1 });
    expect(await executeJobRun(deps, run.id)).toBeNull();
    now = new Date(now.getTime() + 1_000);
    const second = await executeJobRun(deps, run.id);
    expect(second).toMatchObject({ status: "failed", attempt_count: 2 });
    expect(second?.log).toContain("已达到重试上限");
  });

  it("agent_flow 自动重试复用同一普通对话，并在对话中保留失败、重试和结果入口", async () => {
    const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
    const sessionId = run.session_id!;
    let now = new Date("2026-08-17T01:00:00Z");
    let calls = 0;
    const deps = {
      pool,
      databaseUrl: prepared!.url,
      retryDelayMs: 1_000,
      now: () => now,
      agentFlow: async () => {
        calls += 1;
        if (calls === 1) throw new Error("第一次固定失败");
        return "> AI 生成预览，未经用户确认，不是交易建议，也未写入内容库或业务表。\n\n# 第二次成功";
      },
    };
    const first = await executeJobRun(deps, run.id);
    expect(first).toMatchObject({ status: "queued", attempt_count: 1, session_id: sessionId });
    now = new Date(now.getTime() + 1_000);
    const second = await executeJobRun(deps, run.id);
    expect(second).toMatchObject({ status: "success", attempt_count: 2, session_id: sessionId });
    const session = await pool.query(
      "SELECT session_status FROM chat_session WHERE id = $1",
      [sessionId],
    );
    expect(session.rows[0]!.session_status).toBe("success");
    const output = await pool.query<{ id: string; session_id: string }>(
      "SELECT id::text, session_id::text FROM job_run_output WHERE run_id = $1",
      [run.id],
    );
    expect(output.rows[0]!.session_id).toBe(sessionId);
    const messages = await pool.query<{ role: string; text: string }>(
      "SELECT role, content #>> '{content,0,text}' AS text FROM chat_message WHERE session_id = $1 ORDER BY seq",
      [sessionId],
    );
    expect(messages.rows.map((row) => row.role)).toEqual([
      "user", "assistant", "user", "assistant", "assistant",
    ]);
    expect(messages.rows[0]!.text).toContain("以下是数据库内固化的流程提示词");
    expect(messages.rows[1]!.text).toContain("第一次固定失败");
    expect(messages.rows[2]!.text).toContain("系统正在重试作业");
    expect(messages.rows[4]!.text).toContain(
      `[查看任务结果 #${output.rows[0]!.id}](/?result=job-output:${output.rows[0]!.id})`,
    );
  });

  it("真实 agent_flow 与交互对话共用 AgentSessionRunner、普通工具权限和结果入口", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = models.getModels("faux")[0]!;
    setAiRuntimeForTests({
      models,
      model,
      provider: "faux",
      providerName: "Faux",
      modelId: model.id,
    });
    try {
      let releaseFinal!: () => void;
      const finalGate = new Promise<void>((resolve) => {
        releaseFinal = resolve;
      });
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("memory_query", { limit: 1 })],
          { stopReason: "toolUse" },
        ),
        async () => {
          await finalGate;
          return fauxAssistantMessage([
            fauxText("> AI 生成预览，未经用户确认，不是交易建议，也未写入内容库或业务表。\n\n# 统一执行器"),
          ]);
        },
      ]);
      const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
      const execution = executeJobRun(
        { pool, databaseUrl: prepared!.url },
        run.id,
      );
      let runningMessages: Array<{ role: string }> = [];
      for (let index = 0; index < 100; index += 1) {
        runningMessages = (await pool.query<{ role: string }>(
          "SELECT role FROM chat_message WHERE session_id = $1 ORDER BY seq",
          [run.session_id],
        )).rows;
        if (runningMessages.length >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const runningStatus = (await pool.query<{ session_status: string }>(
        "SELECT session_status FROM chat_session WHERE id = $1",
        [run.session_id],
      )).rows[0]!.session_status;
      releaseFinal();
      const finished = await execution;
      expect(runningMessages).toEqual([
        { role: "user" },
        { role: "assistant" },
        { role: "tool" },
      ]);
      expect(runningStatus).toBe("running");
      expect(finished).toMatchObject({ status: "success", session_id: run.session_id });
      const messages = await pool.query(
        "SELECT role FROM chat_message WHERE session_id = $1 ORDER BY seq",
        [run.session_id],
      );
      expect(messages.rows).toEqual([
        { role: "user" },
        { role: "assistant" },
        { role: "tool" },
        { role: "assistant" },
        { role: "assistant" },
      ]);
      const events = await pool.query<{ event_type: string }>(
        "SELECT event_type FROM chat_session_event WHERE session_id = $1 ORDER BY id",
        [run.session_id],
      );
      expect(events.rows.map((row) => row.event_type)).toEqual(
        expect.arrayContaining(["session_status", "message_completed", "ui_refresh"]),
      );
      expect((await pool.query(
        "SELECT session_id::text FROM agent_tool_audit WHERE tool_name = 'memory_query' ORDER BY id DESC LIMIT 1",
      )).rows[0]!.session_id).toBe(run.session_id);
    } finally {
      setAiRuntimeForTests(null);
    }
  });

  it("集合竞价任务成功后激活结构化判断并刷新打板机会", async () => {
    await pool.query("INSERT INTO market_instrument (code,name,kind) VALUES ('990091.SZ','竞价机会测试','stock')");
    const planRun = await queueManualJob(pool, "daily_plan_flow", "2026-08-18");
    const planOutput = (await pool.query<{ id: string }>(
      `INSERT INTO job_run_output
         (job_id, run_id, session_id, output_type, target_date, markdown, sha256, status, source,
          strategy_change_seq, strategy_snapshot_hash)
       SELECT job_id, id, session_id, 'daily_plan', target_date, '# 每日计划', repeat('a', 64),
              'generated', 'agent_flow', strategy_change_seq, strategy_snapshot_hash
         FROM job_run WHERE id = $1
       RETURNING id::text`,
      [planRun.id],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO daily_plan_playbook
         (source_job_run_id, plan_output_id, target_date, item_kind, instrument_id, code, name,
          grade, priority, action, trigger_kind, headline, evidence_md, risk_md, status)
       SELECT $1, $2, '2026-08-18', 'off_pool_opportunity', id, code, name,
              'A', 1, 'observe', 'condition', '竞价确认后再决定是否入场', '原计划证据', '高开回落风险', 'active'
         FROM market_instrument WHERE code = '990091.SZ'`,
      [planRun.id, planOutput],
    );

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = models.getModels("faux")[0]!;
    setAiRuntimeForTests({
      models,
      model,
      provider: "faux",
      providerName: "Faux",
      modelId: model.id,
    });
    try {
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("auction_assessment_write", {
            items: [{
              code: "990091.SZ",
              conclusion: "observe",
              metrics_summary: "竞价涨幅 2.1%，竞价量比 1.8",
              assessment_summary: "原计划条件已由最终竞价数据确认，失效条件未触发",
              benchmark_tags: ["情绪回暖"],
              data_status: "ready",
              data_time: "2026-08-19T01:30:05.000Z",
            }],
          })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([
          fauxText("> AI 生成预览，未经用户确认，不是交易建议，也未写入内容库或业务表。\n\n# 集合竞价研判完成"),
        ]),
      ]);
      const run = await queueManualJob(pool, "auction_opportunity_assessment", "2026-08-19");
      const finished = await executeJobRun({ pool, databaseUrl: prepared!.url }, run.id);
      expect(finished).toMatchObject({ status: "success", session_id: run.session_id });

      const assessment = await pool.query<{
        status: string;
        output_id: string | null;
        conclusion: string;
      }>(
        `SELECT assessment.status, assessment.assessment_output_id::text AS output_id, assessment.conclusion
           FROM daily_plan_auction_assessment assessment
          WHERE assessment.source_job_run_id = $1`,
        [run.id],
      );
      const output = await pool.query<{ id: string }>(
        "SELECT id::text FROM job_run_output WHERE run_id = $1",
        [run.id],
      );
      expect(assessment.rows).toEqual([{
        status: "active",
        output_id: output.rows[0]!.id,
        conclusion: "observe",
      }]);

      const board = await api(server.baseUrl, "GET", "/api/plans/latest");
      expect(board.status).toBe(200);
      expect(board.json).toMatchObject({
        opportunities: [{
          code: "990091.SZ",
          auction_assessment: {
            output_id: output.rows[0]!.id,
            conclusion: "observe",
            benchmark_tags: ["情绪回暖"],
          },
        }],
      });
      const refresh = await pool.query<{ data: { targets: string[] } }>(
        `SELECT data FROM chat_session_event
          WHERE session_id = $1 AND event_type = 'ui_refresh'
          ORDER BY id DESC LIMIT 1`,
        [run.session_id],
      );
      expect(refresh.rows[0]!.data.targets).toContain("dashboard");
    } finally {
      setAiRuntimeForTests(null);
    }
  });

  it("用户中断任务 Agent 后任务与普通对话收敛为 cancelled 且不自动重试", async () => {
    const faux = fauxProvider({ tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = models.getModels("faux")[0]!;
    setAiRuntimeForTests({
      models,
      model,
      provider: "faux",
      providerName: "Faux",
      modelId: model.id,
    });
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxText("任务仍在运行。".repeat(100))]),
      ]);
      const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
      const execution = executeJobRun({ pool, databaseUrl: prepared!.url }, run.id);
      let active = null;
      for (let index = 0; index < 100; index += 1) {
        active = getActiveAgentRun(run.session_id!);
        if (active) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(active).not.toBeNull();
      controlAgentRun({
        sessionId: run.session_id!,
        expectedRunId: active!.runId,
        action: "abort",
      });
      const finished = await execution;
      expect(finished).toMatchObject({ status: "cancelled", attempt_count: 1 });
      expect(finished?.next_retry_at).toBeNull();
      expect(
        (await pool.query("SELECT session_status FROM chat_session WHERE id = $1", [run.session_id])).rows[0]!.session_status,
      ).toBe("cancelled");
    } finally {
      setAiRuntimeForTests(null);
    }
  }, 15_000);

  it("服务重启把遗留 running 任务收敛为同一对话的待重试状态", async () => {
    await pool.query("UPDATE job_definition SET enabled = false");
    const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
    const sessionId = run.session_id!;
    const now = new Date("2026-08-17T02:00:00Z");
    await pool.query(
      "UPDATE job_run SET status = 'running', attempt_count = 1, started_at = $2 WHERE id = $1",
      [run.id, new Date("2026-08-17T01:59:00Z")],
    );
    await updateSessionStatus(pool, sessionId, {
      status: "running",
      at: new Date("2026-08-17T01:59:00Z"),
    });

    const scheduler = new JobScheduler({
      pool,
      databaseUrl: prepared!.url,
      now: () => now,
      retryDelayMs: 60_000,
    });
    await scheduler.start();
    await scheduler.stop();

    const recovered = await pool.query(
      "SELECT status, attempt_count, session_id::text, next_retry_at FROM job_run WHERE id = $1",
      [run.id],
    );
    expect(recovered.rows[0]).toMatchObject({
      status: "queued",
      attempt_count: 1,
      session_id: sessionId,
    });
    expect(new Date(recovered.rows[0]!.next_retry_at).toISOString()).toBe("2026-08-17T02:01:00.000Z");
    expect(
      (await pool.query("SELECT session_status FROM chat_session WHERE id = $1", [sessionId])).rows[0]!.session_status,
    ).toBe("queued");
    expect(
      (await pool.query("SELECT content #>> '{content,0,text}' AS text FROM chat_message WHERE session_id = $1 ORDER BY seq DESC LIMIT 1", [sessionId])).rows[0]!.text,
    ).toContain("服务重启");
  });

  it("外部 script 作业已拒绝；agent_flow Markdown 原子归入任务结果", async () => {
    await expect(
      createJobDefinition(pool, {
        code: "unsafe_script",
        name: "非法脚本",
        cron: "0 0 * * *",
        job_type: "script",
        config: { command_id: "python3 -c 'boom'" },
      }),
    ).rejects.toMatchObject({ httpStatus: 400 });

    const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
    expect(run.session_id).toBeTruthy();
    const finished = await executeJobRun(
      {
        pool,
        databaseUrl: prepared!.url,
        agentFlow: async () => "> AI 生成预览，未经用户确认，不是交易建议，也未写入内容库或业务表。\n\n# 测试结果",
      },
      run.id,
    );
    expect(finished).toMatchObject({ status: "success", task_run_id: null });
    expect(finished?.result_md).toBeNull();
    const output = await pool.query(
      "SELECT output_type, markdown, strategy_change_seq::text, strategy_snapshot_hash FROM job_run_output WHERE run_id = $1",
      [run.id],
    );
    expect(output.rows[0]).toMatchObject({ output_type: "daily_plan", strategy_change_seq: "0" });
    expect(output.rows[0]!.markdown).toContain("# 测试结果");
    expect(output.rows[0]!.strategy_snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Number((await pool.query("SELECT count(*) FROM task_run")).rows[0]!.count)).toBe(0);
  });

  it("结果已事务入账后，对话链接同步失败不会把成功任务反写为重试", async () => {
    const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
    await pool.query(`
      CREATE FUNCTION test_reject_result_link() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.content #>> '{content,0,text}' LIKE '任务结果已保存%' THEN
          RAISE EXCEPTION '测试：拒绝结果链接消息';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_reject_result_link_trigger
      BEFORE INSERT ON chat_message FOR EACH ROW EXECUTE FUNCTION test_reject_result_link();
    `);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const finished = await executeJobRun(
        {
          pool,
          databaseUrl: prepared!.url,
          agentFlow: async () => "# 已完成结果",
        },
        run.id,
      );
      expect(finished).toMatchObject({ status: "success", attempt_count: 1 });
      expect((await pool.query("SELECT status FROM job_run WHERE id = $1", [run.id])).rows[0]!.status).toBe("success");
      expect(Number((await pool.query("SELECT count(*) FROM job_run_output WHERE run_id = $1", [run.id])).rows[0]!.count)).toBe(1);
      expect((await pool.query("SELECT session_status FROM chat_session WHERE id = $1", [run.session_id])).rows[0]!.session_status).toBe("success");
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("已入账"), expect.anything());
    } finally {
      errorLog.mockRestore();
      await pool.query("DROP TRIGGER test_reject_result_link_trigger ON chat_message");
      await pool.query("DROP FUNCTION test_reject_result_link()");
    }
  });

  it("作业页面 API 只保留启停、手动触发、历史和详情", async () => {
    const rejectedCreate = await api(server.baseUrl, "POST", "/api/jobs", {
      code: "api_flow", name: "API 流程", cron: "5 18 * * 1-5", job_type: "agent_flow", config: {},
    });
    expect(rejectedCreate.status).toBe(404);
    const code = "daily_plan_flow";
    await pool.query(
      "UPDATE job_definition SET updated_at = '2026-08-18T08:09:10.123456Z' WHERE code = $1",
      [code],
    );
    const listed = await api(server.baseUrl, "GET", "/api/jobs");
    const listedJob = (listed.json as unknown as Array<{ code: string; updated_at: string }>)
      .find((job) => job.code === code);
    expect(listedJob?.updated_at).toBe("2026-08-18T08:09:10.123456Z");
    const oldUpdate = await api(server.baseUrl, "PATCH", `/api/jobs/${code}`, {
      base_updated_at: listedJob!.updated_at, enabled: false,
    });
    expect(oldUpdate.status).toBe(404);
    const paused = await api(server.baseUrl, "PATCH", `/api/jobs/${code}/control`, {
      base_updated_at: listedJob!.updated_at,
      enabled: false,
    });
    expect(paused.status).toBe(200);
    expect(paused.json.enabled).toBe(false);
    expect(paused.json.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const staleUpdate = await api(server.baseUrl, "PATCH", `/api/jobs/${code}/control`, {
      base_updated_at: listedJob!.updated_at,
      enabled: true,
    });
    expect(staleUpdate.status).toBe(409);
    expect((staleUpdate.json.error as { code: string }).code).toBe("CONFLICT");

    const triggered = await api(server.baseUrl, "POST", `/api/jobs/${code}/trigger`, {
      target_date: "2026-08-18",
    });
    expect(triggered.status).toBe(202);
    expect(triggered.json.status).toBe("queued");
    expect(triggered.json.session_id).toBeTruthy();
    const runId = String(triggered.json.id);

    const runs = await api(server.baseUrl, "GET", `/api/jobs/${code}/runs?limit=5`);
    expect(runs.status).toBe(200);
    expect(runs.json).toEqual([expect.objectContaining({ id: runId })]);
    const detail = await api(server.baseUrl, "GET", `/api/job-runs/${runId}`);
    expect(detail.status).toBe(200);
    expect((detail.json.job as { code: string }).code).toBe(code);
    expect(detail.json.outputs).toEqual([]);

  });
});
