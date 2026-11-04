// 每周交易复盘：服务端确定性周快照（窗口、持仓与成交、机会标的走势、指数/板块/宽度、缺口）与任务接入。
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareTestDb, seedTestStrategy } from "./helpers.js";
import { buildChatTools } from "../../server/agent/tools.js";
import { executeJobRun } from "../../server/scheduler/runner.js";
import { queueManualJob } from "../../server/scheduler/repo.js";
import {
  buildWeeklyReviewSnapshot,
  loadWeeklyReviewSnapshot,
  renderWeeklyReviewContext,
  saveWeeklyReviewSnapshot,
} from "../../server/modules/weekly-review/service.js";

const prepared = await prepareTestDb();

const TARGET = "2026-10-24"; // 周六：复盘 10-19 至 10-23
const WEEK = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"];
const PREVIOUS_WEEK = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];
const INDEXES = ["000001.SH", "399001.SZ", "399006.SZ", "000300.SH", "000905.SH", "000852.SH"];

async function insertInstrument(pool: pg.Pool, code: string, name: string, kind: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO market_instrument (code, name, kind) VALUES ($1, $2, $3)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id::text`,
    [code, name, kind],
  )).rows[0]!.id;
}

async function insertBars(
  pool: pg.Pool,
  instrumentId: string,
  rows: Array<{ date: string; open?: number; high?: number; low?: number; close: number; turnover?: number }>,
): Promise<void> {
  for (const row of rows) {
    const open = row.open ?? row.close;
    const high = row.high ?? Math.max(open, row.close);
    const low = row.low ?? Math.min(open, row.close);
    await pool.query(
      `INSERT INTO market_bar (instrument_id, freq, bar_date, bar_time, open, high, low, close, turnover, channel)
       VALUES ($1, 'day', $2::date, $2::date::timestamptz, $3, $4, $5, $6, $7, 'test')
       ON CONFLICT (instrument_id, freq, bar_date, bar_time) DO UPDATE SET
         open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
         turnover = EXCLUDED.turnover`,
      [instrumentId, row.date, open, high, low, row.close, row.turnover ?? null],
    );
  }
}

async function textOf(result: { content: unknown }): Promise<Record<string, unknown>> {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find((item) => item.type === "text")?.text ?? "{}") as Record<string, unknown>;
}

describe.skipIf(!prepared)("每周交易复盘周快照", () => {
  let pool: pg.Pool;
  let weeklyPrompt: { code: string; content: string };
  let weeklyDefinition: { cron: string; job_type: string; phase: string; execution_scope: string; trading_day_only: boolean; enabled: boolean; priority: number };
  let stockId: string;
  let snapshotRunId: string;
  let snapshot: Awaited<ReturnType<typeof buildWeeklyReviewSnapshot>>;

  beforeAll(async () => {
    pool = prepared!.pool;
    weeklyPrompt = (await pool.query<{ code: string; content: string }>(
      `SELECT prompt.code, revision.content FROM job_prompt prompt
         JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
        WHERE prompt.code = 'weekly_trading_review'`,
    )).rows[0]!;
    weeklyDefinition = (await pool.query<typeof weeklyDefinition>(
      `SELECT cron, job_type, phase, execution_scope, trading_day_only, enabled, priority
         FROM job_definition WHERE code = 'weekly_trading_review'`,
    )).rows[0]!;

    // 交易日历：上一周、复盘周与下一开市日（用于判定“下周生效”）。
    for (const date of [...PREVIOUS_WEEK, ...WEEK, "2026-10-09", "2026-10-26"]) {
      await pool.query(
        `INSERT INTO market_trading_day (trade_date, is_open, source) VALUES ($1::date, true, 'test')
         ON CONFLICT (trade_date) DO UPDATE SET is_open = true`,
        [date],
      );
    }
    // 指数日线：上周五收盘为周涨跌基准。
    for (const code of INDEXES) {
      const id = await insertInstrument(pool, code, `指数${code}`, "index");
      await insertBars(pool, id, [
        { date: "2026-10-09", close: 3600 },
        ...PREVIOUS_WEEK.map((date, index) => ({ date, close: 3700 + index * 25, turnover: 1000 })),
        ...WEEK.map((date, index) => ({
          date,
          close: code === "000001.SH" ? 3850 + index * 12.5 : 1000 + index * 5,
          turnover: 1100,
        })),
      ]);
    }
    // 881 一级行业板块与成分：给出机会标的的行业归属与板块周涨跌。
    const boardId = await insertInstrument(pool, "881101.TI", "测试行业", "board");
    await pool.query(
      `INSERT INTO market_board (instrument_id, board_type, active) VALUES ($1, 'industry', true)
       ON CONFLICT (instrument_id) DO UPDATE SET active = true`,
      [boardId],
    );
    await insertBars(pool, boardId, [
      { date: "2026-10-09", close: 950 },
      { date: "2026-10-16", close: 1000 },
      ...WEEK.map((date, index) => ({ date, close: 1010 + index * 2 })),
    ]);
    stockId = await insertInstrument(pool, "600001.SH", "甲股", "stock");
    const declineId = await insertInstrument(pool, "600002.SH", "乙股", "stock");
    await pool.query(
      `INSERT INTO market_board_membership (board_instrument_id, member_instrument_id, effective_from)
       VALUES ($1, $2, '2026-01-01') ON CONFLICT DO NOTHING`,
      [boardId, stockId],
    );
    await insertBars(pool, stockId, [
      { date: "2026-10-16", close: 9.5 },
      { date: "2026-10-19", open: 10, high: 10.2, low: 9.9, close: 10 },
      { date: "2026-10-20", open: 10.2, high: 10.6, low: 10.0, close: 10.5 },
      { date: "2026-10-21", open: 10.6, high: 11.5, low: 10.5, close: 11.2 },
      { date: "2026-10-22", open: 11.2, high: 11.3, low: 10.9, close: 11.0 },
      { date: "2026-10-23", open: 11.0, high: 11.2, low: 10.8, close: 11.0 },
    ]);
    await insertBars(pool, declineId, [
      { date: "2026-10-16", close: 20 },
      ...WEEK.map((date) => ({ date, close: 19.5 })),
    ]);
    // 持仓、本周卖出与账户净值。
    await pool.query(
      `INSERT INTO portfolio_position (account_id, instrument_id, quantity, cost_price, opened_at)
       VALUES (1, $1, 1000, 9.5, '2026-09-01')
       ON CONFLICT (account_id, instrument_id) DO UPDATE SET quantity = 1000, cost_price = 9.5`,
      [stockId],
    );
    await pool.query(
      `INSERT INTO portfolio_position_change
         (account_id, instrument_id, change_date, kind, quantity, price, amount, realized_pnl, source, reason)
       VALUES (1, $1, '2026-10-21', 'sell', 100, 10.6, 1060, 60, 'form', '测试减仓')`,
      [stockId],
    );
    await pool.query(
      `INSERT INTO portfolio_equity_daily (account_id, snap_date, cash, market_value, equity) VALUES
         (1, '2026-10-16', 50000, 50000, 100000),
         (1, '2026-10-23', 56000, 49000, 105000)
       ON CONFLICT (account_id, snap_date) DO UPDATE SET equity = EXCLUDED.equity`,
    );
    // 超短 T+1 关注池：10-20 生效，信号日开盘 10.2，窗口末收盘 11。
    await pool.query(
      `INSERT INTO ultra_short_watchlist
         (target_date, data_date, code, name, sources, priority, stage, review_status)
       VALUES ('2026-10-20', '2026-10-19', '600001.SH', '甲股', ARRAY['post_close'], 'P1', '首板', 'pass')
       ON CONFLICT (target_date, code) DO UPDATE SET priority = 'P1'`,
      [],
    );
    // 周五盘后生成的下一交易日关注池：数据日在本周，生效日在下一开市日，本次复盘应判为“未生效”。
    await pool.query(
      `INSERT INTO ultra_short_watchlist
         (target_date, data_date, code, name, sources, priority, stage, review_status)
       VALUES ('2026-10-26', '2026-10-23', '600002.SH', '乙股', ARRAY['post_close'], 'P2', '首板', 'pass')
       ON CONFLICT (target_date, code) DO UPDATE SET priority = 'P2'`,
      [],
    );
    // 盘后策略初筛：最后交易日产出，信号生效日在下一开市日，本次复盘应判为“未生效”。
    const swingRun = (await pool.query<{ id: string }>(
      `INSERT INTO job_run (job_id, target_date, trigger_kind, status, finished_at)
       SELECT id, '2026-10-23', 'cron', 'success', now() FROM job_definition WHERE code = 'swing_signal_scan'
       RETURNING id::text`,
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO strategy_candidate_shortlist
         (source_job_run_id, strategy_code, target_date, data_date, status, payload, input_hash)
       VALUES ($1, 'swing', '2026-10-23', '2026-10-23', 'success', $2::jsonb, repeat('a', 64))
       ON CONFLICT (source_job_run_id) DO UPDATE SET payload = EXCLUDED.payload`,
      [swingRun, JSON.stringify({
        candidates: [{ code: "600002.SH", name: "乙股", industry: "测试行业", status: "qualified" }],
        matches: [], source: {}, status: "success", data_date: "2026-10-23", gaps: [],
      })],
    );
    // 收盘打板任务在 10-20 盘后产出下一交易日观察候选：信号生效日应为 10-21。
    const closeScanRun = (await pool.query<{ id: string }>(
      `INSERT INTO job_run (job_id, target_date, trigger_kind, status, finished_at)
       SELECT id, '2026-10-20', 'cron', 'success', now() FROM job_definition WHERE code = 'limit_up_close_scan'
       RETURNING id::text`,
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO daily_plan_playbook
         (source_job_run_id, target_date, item_kind, instrument_id, code, name, grade, priority,
          action, trigger_kind, headline, status, account_id)
       VALUES ($1, '2026-10-20', 'off_pool_opportunity', $2, '600001.SH', '甲股', 'A', 100,
               'observe', 'open', '测试收盘打板机会', 'active', 1)`,
      [closeScanRun, stockId],
    );
    // 策略关注条目：10-19 生效，与超短来源同标的但来源不同，按来源分别统计。
    await pool.query(
      `INSERT INTO pool_attention_entry
         (instrument_id, source_job, source_type, strategy_code, status, reason, valid_from)
       VALUES ($1, 'swing_signal_scan', 'strategy', 'swing', 'qualified', '测试关注', '2026-10-19')
       ON CONFLICT DO NOTHING`,
      [stockId],
    );
    // 涨跌停事件：每日一次涨停，用于涨停次数与每日宽度；10-21 同时进入超短机会的涨停计数。
    for (const date of WEEK) {
      await pool.query(
        `INSERT INTO market_limit_event (trade_date, event_type, instrument_id, streak_count, source_row_sha256)
         VALUES ($2::date, 'up', $1, 1, 'test-seal-' || $2)
         ON CONFLICT DO NOTHING`,
        [stockId, date],
      );
    }
    snapshot = await buildWeeklyReviewSnapshot(pool, TARGET, { now: new Date("2026-10-24T01:00:00Z") });
    const weeklyJobRun = (await pool.query<{ id: string }>(
      `INSERT INTO job_run (job_id, target_date, trigger_kind, status, finished_at)
       SELECT id, $1::date, 'cron', 'success', now() FROM job_definition WHERE code = 'weekly_trading_review'
       RETURNING id::text`,
      [TARGET],
    )).rows[0]!.id;
    snapshotRunId = weeklyJobRun;
    await saveWeeklyReviewSnapshot(pool, weeklyJobRun, snapshot);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM market_limit_event WHERE source_row_sha256 LIKE 'test-seal%'");
    await pool.end();
  });

  it("迁移写入周六全局复盘任务与数据库提示词", () => {
    expect(weeklyDefinition).toMatchObject({
      cron: "0 9 * * 6", job_type: "agent_flow", phase: "周末",
      execution_scope: "global", trading_day_only: false, enabled: true, priority: 190,
    });
    expect(weeklyPrompt.content).toContain("weekly_review_context_query");
    expect(weeklyPrompt.content).toContain("## 结论摘要");
    expect(weeklyPrompt.content).toContain("不构成买卖建议");
  });

  it("按自然周截取复盘窗口并汇总持仓、成交与账户净值", () => {
    expect(snapshot.week_start).toBe("2026-10-19");
    expect(snapshot.week_end).toBe("2026-10-23");
    expect(snapshot.previous_week_end).toBe("2026-10-16");
    expect(snapshot.trading_days).toEqual(WEEK);
    expect(snapshot.summary).toMatchObject({
      account_count: 1, position_count: 1, trade_count: 1, week_realized_pnl: 60,
    });
    const position = snapshot.positions[0]!;
    expect(position).toMatchObject({ code: "600001.SH", quantity: 1000, close: 11 });
    expect(position.week_start_close).toBe(9.5);
    expect(position.week_pct).toBeCloseTo(15.79, 1);
    expect(position.week_pnl_amount).toBe(1500);
    expect(position.pnl_amount).toBe(1500);
    const account = snapshot.accounts[0]!;
    expect(account.equity_start).toBe(100000);
    expect(account.equity_end).toBe(105000);
    expect(account.equity_change_pct).toBe(5);
    expect(snapshot.realized[0]).toMatchObject({ account_id: "1", realized_pnl: 60, sell_count: 1 });
    expect(snapshot.trades[0]).toMatchObject({ code: "600001.SH", kind: "sell", realized_pnl: 60 });
  });

  it("机会标的按信号生效日开盘计算走势，最后交易日的晚间信号判为未生效", () => {
    const ultra = snapshot.opportunities.find((item) => item.source === "ultra_short" && item.code === "600001.SH")!;
    expect(ultra.signal_date).toBe("2026-10-20");
    expect(ultra.industry).toBe("测试行业");
    expect(ultra.performance.status).toBe("evaluated");
    expect(ultra.performance.entry_price).toBe(10.2);
    expect(ultra.performance.return_pct).toBeCloseTo(7.84, 1);
    expect(ultra.performance.max_gain_pct).toBeCloseTo(12.75, 1);
    expect(ultra.performance.max_drawdown_pct).toBeCloseTo(-1.96, 1);
    // 10-20 至 10-23 每日一次涨停事件。
    expect(ultra.performance.limit_up_days).toBe(4);

    const attention = snapshot.opportunities.find((item) => item.source === "pool_attention" && item.code === "600001.SH")!;
    // 关注条目盘后写入，统一按有效起始日之后的最近开市日作为可执行起点。
    expect(attention.signal_date).toBe("2026-10-20");
    expect(attention.performance.entry_price).toBe(10.2);
    expect(attention.performance.return_pct).toBeCloseTo(7.84, 1);

    const playbook = snapshot.opportunities.find((item) => item.source === "daily_plan" && item.code === "600001.SH")!;
    expect(playbook.source_label).toBe("收盘打板机会");
    expect(playbook.produced_date).toBe("2026-10-20");
    expect(playbook.signal_date).toBe("2026-10-21");
    expect(playbook.performance.entry_price).toBe(10.6);
    expect(playbook.performance.return_pct).toBeCloseTo(3.77, 1);
    expect(snapshot.opportunity_summary.find((item) => item.source === "daily_plan"))
      .toMatchObject({ count: 1, evaluated: 1 });

    const pendingUltra = snapshot.opportunities.find((item) =>
      item.source === "ultra_short" && item.code === "600002.SH")!;
    expect(pendingUltra.produced_date).toBe("2026-10-23");
    expect(pendingUltra.signal_date).toBe("2026-10-26");
    expect(pendingUltra.performance.status).toBe("pending");

    const pending = snapshot.opportunities.find((item) => item.source === "strategy_shortlist")!;
    expect(pending.signal_date).toBe("2026-10-26");
    expect(pending.performance.status).toBe("pending");
    expect(pending.performance.return_pct).toBeNull();

    const summary = snapshot.opportunity_summary.find((item) => item.source === "ultra_short")!;
    expect(summary).toMatchObject({ count: 2, evaluated: 1, wins: 1, win_rate_pct: 100, pending: 1 });
    expect(snapshot.opportunity_summary.find((item) => item.source === "strategy_shortlist"))
      .toMatchObject({ count: 1, evaluated: 0, pending: 1 });
  });

  it("指数、881 板块与每日宽度使用同一交易周口径", () => {
    const index = snapshot.market.indices.find((item) => item.code === "000001.SH")!;
    expect(index.pct_week).toBeCloseTo(2.63, 1);
    expect(index.pct_last_week).toBeCloseTo(5.56, 1);
    expect(index.days).toHaveLength(5);
    expect(index.turnover_week).toBe(5500);
    expect(snapshot.market.indices).toHaveLength(INDEXES.length);
    expect(snapshot.market.sector_summary).toMatchObject({
      active_board_count: 1, covered_board_count: 1, up_count: 1, down_count: 0,
    });
    expect(snapshot.market.sectors[0]).toMatchObject({ code: "881101.TI", name: "测试行业", rank: 1 });
    expect(snapshot.market.sectors[0]!.pct_week).toBeCloseTo(1.8, 1);
    expect(snapshot.market.sectors[0]!.pct_last_week).toBeCloseTo(5.26, 1);
    const day = snapshot.market.breadth.find((item) => item.date === "2026-10-21")!;
    expect(day).toMatchObject({ limit_up: 1, limit_down: 0, break_count: 0, max_streak: 1 });
    expect(day.advancing).toBe(1);
    expect(day.declining).toBe(0);
    expect(day.stock_sample).toBe(2);
    expect(day.median_pct).toBeCloseTo(3.33, 1);
  });

  it("快照持久化按运行覆盖，任务工具与提示词渲染可直接读取", async () => {
    const stored = await loadWeeklyReviewSnapshot(pool, TARGET);
    expect(stored).toMatchObject({ run_id: snapshotRunId, target_date: TARGET, status: snapshot.status });
    expect(stored!.payload.positions[0]!.code).toBe("600001.SH");
    // 同一运行重试覆盖同一行。
    await saveWeeklyReviewSnapshot(pool, snapshotRunId, { ...snapshot, gaps: [] });
    const rows = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM weekly_review_snapshot WHERE run_id = $1", [snapshotRunId],
    );
    expect(rows.rows[0]!.count).toBe(1);

    const rendered = renderWeeklyReviewContext(snapshot);
    expect(rendered).toContain("服务端周复盘事实快照");
    expect(rendered).toContain("复盘窗口 2026-10-19 至 2026-10-23");
    expect(rendered).toContain("本周产出机会标的");
    expect(rendered).toContain("数据缺口");

    const tools = buildChatTools({ pool, sessionId: null }, { kind: "job", jobCode: "weekly_trading_review" });
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "board_query", "fetch_market_data", "market_event_query", "market_snapshot_query",
      "stock_research_query", "strategy_document_query", "web_fetch", "web_search",
      "weekly_review_context_query",
    ].sort());
    const tool = tools.find((item) => item.name === "weekly_review_context_query")!;
    const payload = await textOf(await tool.execute("weekly-context", { date: TARGET }));
    expect(payload).toMatchObject({ run_id: snapshotRunId, target_date: TARGET });
    await expect(tool.execute("weekly-context-missing", { date: "2020-01-04" }))
      .rejects.toThrow("没有周复盘快照");
  });

  it("runner 在模型运行前生成并注入周快照，结果保存为任务结果", async () => {
    await seedTestStrategy(pool);
    const run = await queueManualJob(pool, "weekly_trading_review", TARGET);
    const deps = {
      pool,
      databaseUrl: prepared!.url,
      now: () => new Date("2026-10-24T02:00:00Z"),
      agentFlow: async () =>
        "> AI 生成任务结果，已关联本次任务保存；不代表策略发布或交易执行。\n\n"
        + "# 每周交易复盘\n\n## 结论摘要\n本周测试复盘，无持仓动作。",
    };
    const finished = await executeJobRun(deps, run.id);
    expect(finished).toMatchObject({ status: "success", target_date: TARGET });
    expect(finished!.data_gaps).toEqual([]);
    const prompt = (await pool.query<{ text: string }>(
      `SELECT content #>> '{content,0,text}' AS text FROM chat_message
        WHERE session_id = $1 AND role = 'user' ORDER BY seq LIMIT 1`,
      [run.session_id],
    )).rows[0]!.text;
    expect(prompt).toContain("## 服务端周复盘事实快照");
    expect(prompt).toContain("复盘窗口 2026-10-19 至 2026-10-23");
    expect(prompt).toContain("本周产出机会标的");
    const stored = await pool.query<{ status: string }>(
      "SELECT status FROM weekly_review_snapshot WHERE run_id = $1", [run.id],
    );
    expect(stored.rows).toHaveLength(1);
    const output = (await pool.query<{ output_type: string; markdown: string }>(
      "SELECT output_type, markdown FROM job_run_output WHERE run_id = $1", [run.id],
    )).rows[0]!;
    expect(output.output_type).toBe("weekly_trading_review");
    expect(output.markdown).toContain("## 结论摘要");
  });
});
