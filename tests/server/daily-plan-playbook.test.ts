// 每日计划盯防预案测试（迁移 0047）：draft 写入/替换、激活与替代、看板读取、HTTP 路由。
// 领域规则：position_action 仅限真实持仓，off_pool_opportunity 是池外打板机会且只接受 A/B 兼容评级。
import crypto from "node:crypto";
import { buildChatTools } from "../../server/agent/tools.js";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../server/db/migrate.js";
import {
  activateAuctionAssessmentsForRun,
  activatePlaybookForRun,
  getLatestDailyPlanBoard,
  queryAuctionAssessmentContext,
  queryHistoricalPlanItems,
  replaceDraftAuctionAssessments,
  replaceDraftPlaybook,
} from "../../server/modules/plans/repo.js";
import {
  listPassedLimitUpSignals,
  listPositionChanges,
  recordPositionChange,
} from "../../server/modules/positions/repo.js";
import {
  validateAuctionAssessmentWriteInput,
  validateDailyPlanWriteInput,
} from "../../server/agent/tool-validation.js";
import { api, prepareTestDb, resetSchema, seedTestStrategy, startTestServer, type TestServer } from "./helpers";

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
    await seedTestStrategy(pool);

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
    await server?.close();
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
    const history = await queryHistoricalPlanItems(pool, first.outputId);
    expect(history).toMatchObject({ total_count: 1, complete: true, next_offset: null });
    expect(history.items[0]).toMatchObject({ headline: "旧计划预案", action: "hold", auction_assessment: null });
    expect((await queryHistoricalPlanItems(pool, first.outputId, 1)).items).toEqual([]);
    const tool = buildChatTools({ pool, sessionId: null }).find((item) => item.name === "job_context_query")!;
    const response = await tool.execute("history", {
      job_codes: ["daily_plan_flow"], target_date: "2026-08-27", recent_runs_per_job: 2,
      include_output_content: true, include_plan_items: true,
    });
    const data = JSON.parse(response.content[0]!.type === "text" ? response.content[0]!.text : "{}");
    expect(data.jobs[0].outputs.map((output: { id: string }) => output.id)).toEqual([second.outputId, first.outputId]);
    expect(data.jobs[0].outputs[1].plan_items.items[0].headline).toBe("旧计划预案");
    expect(data.jobs[0].outputs[1].markdown).toContain("预案正文");
    const missing = await tool.execute("history-missing", {
      job_codes: ["daily_plan_flow"], target_date: "2020-01-01", include_plan_items: true,
    });
    expect(JSON.parse(missing.content[0]!.type === "text" ? missing.content[0]!.text : "{}").jobs[0].outputs).toEqual([]);
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
      `INSERT INTO market_trading_day (trade_date, is_open, source)
       VALUES ('2026-08-27', true, 'test'), ('2026-08-28', true, 'test')
       ON CONFLICT (trade_date) DO UPDATE SET is_open = EXCLUDED.is_open`,
    );
    const context = await queryAuctionAssessmentContext(pool, "2026-08-28");
    expect(context.market_day).toMatchObject({ should_run: true, previous_open_date: "2026-08-27" });
    expect(context.plan).toMatchObject({ target_date: "2026-08-27", validity: "valid" });
    expect(context.coverage.opportunity_count).toBe(1);
    expect(context.coverage.candidate_count).toBe(context.candidate_codes.length);
    expect(context.candidate_codes).toContain("300750.SZ");
    expect(Buffer.byteLength(JSON.stringify(context), "utf8")).toBeLessThan(16 * 1024);
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
        conclusion: "signal_passed",
        review_type: "turnover_advance",
        metrics_summary: "竞价涨幅 +2.1%，竞价量比 1.8",
        assessment_summary: "原计划缺失的量能条件已补齐，失效条件未触发",
        benchmark_tags: ["强于短线基准"],
        data_status: "ready",
        data_time: "2026-08-28T09:30:12+08:00",
      }],
    });
    expect((await getLatestDailyPlanBoard(pool)).opportunities[0]!.auction_assessment).toBeNull();

    const markdown = "# 集合竞价机会研判\n\n信号通过。";
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
      conclusion: "signal_passed",
      review_type: "turnover_advance",
      metrics_summary: "竞价涨幅 +2.1%，竞价量比 1.8",
      benchmark_tags: ["强于短线基准"],
      data_status: "ready",
    });

    expect(await listPassedLimitUpSignals(pool, ["300750.SZ"], "2026-08-28")).toMatchObject([{
      assessment_id: expect.any(String),
      code: "300750.SZ",
      signal_date: "2026-08-27",
      assessment_date: "2026-08-28",
      review_type: "turnover_advance",
      plan_output_id: plan.outputId,
    }]);
    const sessionId = (await pool.query<{ id: string }>(
      "INSERT INTO chat_session (title) VALUES ('打板归因测试') RETURNING id::text",
    )).rows[0]!.id;
    const bought = await recordPositionChange(pool, {
      code: "300750.SZ", kind: "buy", quantity: 100, price: 101,
      change_date: "2026-08-28", source: "chat", source_session_id: sessionId,
      decision_origin: "strategy_signal", execution_compliance: "matched",
    });
    expect(bought.change).toMatchObject({
      plan_output_id: plan.outputId,
      entry_auction_assessment_id: expect.any(String),
    });
    const exitPlan = await seedDailyPlanRun(pool, "daily_plan");
    await recordPositionChange(pool, {
      code: "300750.SZ", kind: "sell", quantity: 100, price: 103,
      change_date: "2026-08-29", source: "chat", source_session_id: sessionId,
      decision_origin: "strategy_signal", execution_compliance: "matched",
      plan_output_id: exitPlan.outputId,
    });
    expect((await listPositionChanges(pool, 2, ["300750.SZ"]))).toMatchObject([
      { kind: "sell", plan_output_id: exitPlan.outputId, entry_signal_date: "2026-08-27", entry_assessment_date: "2026-08-28", entry_signal_review_type: "turnover_advance" },
      { kind: "buy", entry_signal_date: "2026-08-27", entry_assessment_date: "2026-08-28", entry_signal_review_type: "turnover_advance" },
    ]);
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
        conclusion: "signal_passed",
        review_type: "turnover_advance",
        metrics_summary: "竞价数据缺失",
        assessment_summary: "无法判断",
        data_status: "missing",
      }],
    })).toThrow(/只能标记数据不足/);
  });
});
