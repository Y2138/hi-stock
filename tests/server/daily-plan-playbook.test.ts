// 每日计划盯防预案测试（迁移 0047）：draft 写入/替换、激活与替代、看板读取、HTTP 路由。
// 领域规则：position_action 仅限真实持仓，off_pool_opportunity 是池外打板机会且只接受 A/B 兼容评级。
import crypto from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../server/db/migrate.js";
import {
  activateAuctionAssessmentsForRun,
  activatePlaybookForRun,
  getLatestDailyPlanBoard,
  replaceDraftAuctionAssessments,
  replaceDraftPlaybook,
} from "../../server/modules/plans/repo.js";
import {
  validateAuctionAssessmentWriteInput,
  validateDailyPlanWriteInput,
} from "../../server/agent/tool-validation.js";
import { api, prepareTestDb, resetSchema, startTestServer, type TestServer } from "./helpers";

const prepared = await prepareTestDb();

interface SeedIds {
  jobRunId: string;
  outputId: string;
}

async function seedDailyPlanRun(pool: pg.Pool, outputType: string): Promise<SeedIds> {
  await pool.query(
    `INSERT INTO job_definition (code, name, cron, job_type, config)
     VALUES ('daily_plan_flow', '每日交易计划', '0 30 16 * * 1-5', 'agent_flow', '{"daily_plan_write": true}')
     ON CONFLICT (code) DO NOTHING`,
  );
  const jobId = (await pool.query<{ id: string }>("SELECT id::text FROM job_definition WHERE code = 'daily_plan_flow'")).rows[0]!.id;
  const run = await pool.query<{ id: string }>(
    `INSERT INTO job_run (job_id, target_date, trigger_kind, status)
     VALUES ($1, date '2026-08-27', 'manual', 'success') RETURNING id::text`,
    [jobId],
  );
  const markdown = "# 每日交易计划（目标交易日 2026-08-27）\n\n预案正文。";
  const output = await pool.query<{ id: string }>(
    `INSERT INTO job_run_output
       (job_id, run_id, output_type, target_date, markdown, sha256, status, source)
     VALUES ($1, $2, $3, date '2026-08-27', $4, $5, 'generated', 'agent_flow')
     RETURNING id::text`,
    [jobId, run.rows[0]!.id, outputType, markdown, crypto.createHash("sha256").update(markdown).digest("hex")],
  );
  return { jobRunId: run.rows[0]!.id, outputId: output.rows[0]!.id };
}

describe.skipIf(!prepared)("每日计划盯防预案", () => {
  let pool: pg.Pool;
  let server: TestServer;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);

    // 三只标的：持仓 / 池内 / 纯池外
    for (const [code, name] of [["600000.SH", "持仓银行"], ["600519.SH", "池内白酒"], ["300750.SZ", "池外电池"]] as const) {
      await pool.query("INSERT INTO market_instrument (code, name, kind) VALUES ($1, $2, 'stock')", [code, name]);
    }
    await pool.query(
      `WITH instrument AS (SELECT id FROM market_instrument WHERE code = '600000.SH')
       INSERT INTO portfolio_position (instrument_id, quantity, cost_price)
       SELECT instrument.id, 1000, 10.5 FROM instrument`,
    );
    await pool.query(
      `INSERT INTO pool_membership (instrument_id, pool, role, effective_from)
       SELECT id, 'short', '观察', '2026-08-01' FROM market_instrument WHERE code = '600519.SH'`,
    );
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  it("draft 写入、全量替换与归属校验", async () => {
    const ids = await seedDailyPlanRun(pool, "daily_plan");
    const base = { source_job_run_id: ids.jobRunId };
    await replaceDraftPlaybook(pool, {
      ...base,
      items: [
        {
          item_kind: "position_action",
          code: "600000.SH",
          action: "exit",
          trigger_kind: "price_range",
          price_lower: 9.8,
          price_upper: 10.2,
          headline: "跌破止损区间即退出",
          auction_md: "低开破位直接开盘退出",
          intraday_md: "首次触及 10 元下方即市价卖出",
          invalidation_md: "全天收于 10.3 上方则维持持有",
        },
        {
          item_kind: "off_pool_opportunity",
          code: "300750.SZ",
          grade: "A",
          priority: 1,
          action: "observe",
          trigger_kind: "condition",
          headline: "涨停+龙虎榜净买共振，待验证候选",
          evidence_md: "涨停 52 家中板块聚集第一，龙虎榜净买 +1.1 亿",
          missing_md: "未做行情六条件复核",
          risk_md: "连板换血期追高风险",
        },
      ],
    });
    // 全量替换：第二次提交只剩持仓一行
    await replaceDraftPlaybook(pool, {
      ...base,
      items: [{
        item_kind: "position_action",
        code: "600000.SH",
        action: "hold",
        trigger_kind: "open",
        headline: "继续持有，观察量能",
      }],
    });
    const drafts = await pool.query("SELECT item_kind, code FROM daily_plan_playbook WHERE status = 'draft'");
    expect(drafts.rows.map((row) => `${row.item_kind}:${row.code}`)).toEqual(["position_action:600000.SH"]);

    // 非持仓不能提交 position_action；池内标的机会被拒绝
    await expect(replaceDraftPlaybook(pool, {
      ...base,
      items: [{ item_kind: "position_action", code: "600519.SH", action: "hold", trigger_kind: "open", headline: "x" }],
    })).rejects.toThrow();
    await expect(replaceDraftPlaybook(pool, {
      ...base,
      items: [{
        item_kind: "off_pool_opportunity",
        code: "600519.SH",
        grade: "B",
        action: "observe",
        trigger_kind: "condition",
        headline: "x",
        evidence_md: "y",
      }],
    })).rejects.toThrow();

    await activatePlaybookForRun(pool, ids.jobRunId, ids.outputId);
    const board = await getLatestDailyPlanBoard(pool);
    expect(board.plan.output_id).toBe(ids.outputId);
    expect(board.position_actions.map((item) => item.code)).toEqual(["600000.SH"]);
    expect(board.opportunities).toEqual([]);
    // 全量替换后仅剩最后一次提交的 hold 行：无价格区间
    expect(board.position_actions[0]!.action).toBe("hold");
    expect(board.position_actions[0]!.price_lower).toBeNull();
  });

  it("新计划激活后旧预案转入 superseded，看板只展示最新一份", async () => {
    const first = await seedDailyPlanRun(pool, "daily_plan");
    await replaceDraftPlaybook(pool, {
      source_job_run_id: first.jobRunId,
      items: [{ item_kind: "position_action", code: "600000.SH", action: "hold", trigger_kind: "open", headline: "旧计划预案" }],
    });
    await activatePlaybookForRun(pool, first.jobRunId, first.outputId);
    const second = await seedDailyPlanRun(pool, "daily_plan");
    await replaceDraftPlaybook(pool, {
      source_job_run_id: second.jobRunId,
      items: [{ item_kind: "position_action", code: "600000.SH", action: "reduce", trigger_kind: "price_range", price_upper: 11.5, headline: "新计划减半" }],
    });
    await activatePlaybookForRun(pool, second.jobRunId, second.outputId);

    const statuses = await pool.query<{ plan_output_id: string; status: string }>(
      "SELECT plan_output_id::text, status FROM daily_plan_playbook ORDER BY id",
    );
    expect(statuses.rows).toContainEqual({ plan_output_id: second.outputId, status: "active" });
    const superseded = statuses.rows.filter((row) => row.status === "superseded");
    expect(superseded.length).toBeGreaterThan(0);
    const board = await getLatestDailyPlanBoard(pool);
    expect(board.plan.output_id).toBe(second.outputId);
    expect(board.position_actions[0]!.headline).toBe("新计划减半");
  });

  it("HTTP 路由返回最新预案形状", async () => {
    server = await startTestServer(pool);
    const result = await api(server.baseUrl, "GET", "/api/plans/latest");
    expect(result.status).toBe(200);
    const data = result.json as unknown as { plan: { target_date: string }; position_actions: unknown[]; opportunities: unknown[] };
    expect(data.plan.target_date).toBe("2026-08-27");
    expect(Array.isArray(data.position_actions)).toBe(true);
    expect(Array.isArray(data.opportunities)).toBe(true);
  });

  it("竞价复核在任务成功后激活到最新打板机会，草稿不会提前展示", async () => {
    const plan = await seedDailyPlanRun(pool, "daily_plan");
    await replaceDraftPlaybook(pool, {
      source_job_run_id: plan.jobRunId,
      items: [{
        item_kind: "off_pool_opportunity",
        code: "300750.SZ",
        grade: "A",
        priority: 1,
        action: "observe",
        trigger_kind: "condition",
        headline: "竞价确认后再判断",
        evidence_md: "市场结构双重证据",
        risk_md: "高开回落风险",
      }],
    });
    await activatePlaybookForRun(pool, plan.jobRunId, plan.outputId);
    await pool.query(
      "INSERT INTO market_trading_day (trade_date, is_open, source) VALUES ('2026-08-28', true, 'test') ON CONFLICT (trade_date) DO UPDATE SET is_open = true",
    );
    const auctionRun = await pool.query<{ id: string }>(
      `INSERT INTO job_run (job_id, target_date, trigger_kind, status)
       SELECT id, '2026-08-28', 'manual', 'running'
         FROM job_definition WHERE code = 'auction_opportunity_assessment'
       RETURNING id::text`,
    );
    const runId = auctionRun.rows[0]!.id;
    await replaceDraftAuctionAssessments(pool, {
      source_job_run_id: runId,
      items: [{
        code: "300750.SZ",
        conclusion: "observe",
        metrics_summary: "竞价涨幅 +2.1%，竞价量比 1.8",
        assessment_summary: "原计划缺失的量能条件已补齐，失效条件未触发",
        benchmark_tags: ["强于短线基准"],
        data_status: "ready",
        data_time: "2026-08-28T09:30:12+08:00",
      }],
    });
    expect((await getLatestDailyPlanBoard(pool)).opportunities[0]!.auction_assessment).toBeNull();

    const markdown = "# 集合竞价机会研判\n\n继续观察。";
    const output = await pool.query<{ id: string }>(
      `INSERT INTO job_run_output
         (job_id, run_id, output_type, target_date, markdown, sha256, status, source)
       SELECT job_id, id, 'auction_opportunity_assessment', target_date, $2, $3, 'generated', 'agent_flow'
         FROM job_run WHERE id = $1
       RETURNING id::text`,
      [runId, markdown, crypto.createHash("sha256").update(markdown).digest("hex")],
    );
    await activateAuctionAssessmentsForRun(pool, runId, output.rows[0]!.id);

    expect((await getLatestDailyPlanBoard(pool)).opportunities[0]!.auction_assessment).toMatchObject({
      output_id: output.rows[0]!.id,
      conclusion: "observe",
      metrics_summary: "竞价涨幅 +2.1%，竞价量比 1.8",
      benchmark_tags: ["强于短线基准"],
      data_status: "ready",
    });
  });

  it("输入校验：评级缺失、priority 规则与触发区间倒挂被拒绝", () => {
    expect(validateDailyPlanWriteInput({
      items: [{
        item_kind: "position_action",
        code: "600000.SH",
        action: "hold",
        trigger_kind: "open",
        headline: "继续持有",
      }],
    })).toBeTruthy();

    expect(() => validateDailyPlanWriteInput({
      items: [{ item_kind: "off_pool_opportunity", code: "300750.SZ", action: "observe", trigger_kind: "condition", headline: "x" }],
    })).toThrow(/A\/B/);

    expect(() => validateDailyPlanWriteInput({
      items: [{ item_kind: "off_pool_opportunity", code: "300750.SZ", grade: "C", priority: 1, action: "observe", trigger_kind: "condition", headline: "x", evidence_md: "y" }],
    })).toThrow();

    expect(() => validateDailyPlanWriteInput({
      items: [{ item_kind: "off_pool_opportunity", code: "300750.SZ", grade: "A", priority: 1, action: "buy", trigger_kind: "condition", headline: "x", evidence_md: "y" }],
    })).toThrow(/只能继续观察/);

    // 打板机会必须有 priority；两条机会 priority 重复被拒
    expect(() => validateDailyPlanWriteInput({
      items: [{ item_kind: "off_pool_opportunity", code: "300750.SZ", grade: "A", action: "observe", trigger_kind: "condition", headline: "x", evidence_md: "y" }],
    })).toThrow(/priority/);
    expect(() => validateDailyPlanWriteInput({
      items: [
        { item_kind: "off_pool_opportunity", code: "300750.SZ", grade: "A", priority: 1, action: "observe", trigger_kind: "condition", headline: "x", evidence_md: "y" },
        { item_kind: "off_pool_opportunity", code: "600519.SH", grade: "B", priority: 1, action: "observe", trigger_kind: "condition", headline: "z", evidence_md: "w" },
      ],
    })).toThrow(/重复 priority/);
    expect(() => validateDailyPlanWriteInput({
      items: [
        { item_kind: "off_pool_opportunity", code: "300750.SZ", grade: "A", priority: 1, action: "observe", trigger_kind: "condition", headline: "x", evidence_md: "y" },
        { item_kind: "off_pool_opportunity", code: "600519.SH", grade: "B", priority: 2, action: "observe", trigger_kind: "condition", headline: "z", evidence_md: "w" },
      ],
    })).not.toThrow();
    expect(() => validateDailyPlanWriteInput({
      items: [
        { item_kind: "off_pool_opportunity", code: "300750.SZ", grade: "A", priority: 1, action: "observe", trigger_kind: "condition", headline: "1", evidence_md: "1" },
        { item_kind: "off_pool_opportunity", code: "600519.SH", grade: "B", priority: 2, action: "observe", trigger_kind: "condition", headline: "2", evidence_md: "2" },
        { item_kind: "off_pool_opportunity", code: "000001.SZ", grade: "B", priority: 3, action: "observe", trigger_kind: "condition", headline: "3", evidence_md: "3" },
        { item_kind: "off_pool_opportunity", code: "000002.SZ", grade: "B", priority: 4, action: "observe", trigger_kind: "condition", headline: "4", evidence_md: "4" },
        { item_kind: "off_pool_opportunity", code: "000333.SZ", grade: "B", priority: 5, action: "observe", trigger_kind: "condition", headline: "5", evidence_md: "5" },
      ],
    })).toThrow(/最多 4 只/);

    // 持仓预案不接受评级/priority 字段
    expect(() => validateDailyPlanWriteInput({
      items: [{ item_kind: "position_action", code: "600000.SH", grade: "A", action: "hold", trigger_kind: "open", headline: "x" }],
    })).toThrow(/不接受打板评级/);

    expect(() => validateDailyPlanWriteInput({
      items: [{
        item_kind: "position_action",
        code: "600000.SH",
        action: "buy",
        trigger_kind: "price_range",
        price_lower: 12,
        price_upper: 10,
        headline: "倒挂区间",
      }],
    })).toThrow(/下限高于上限/);

    expect(() => validateAuctionAssessmentWriteInput({
      items: [{
        code: "300750.SZ",
        conclusion: "observe",
        metrics_summary: "竞价数据缺失",
        assessment_summary: "无法判断",
        data_status: "missing",
      }],
    })).toThrow(/只能标记数据不足/);
  });
});
