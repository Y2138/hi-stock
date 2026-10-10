import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createAccount } from "../../server/modules/accounts/repo.js";
import { runMigrations } from "../../server/db/migrate.js";
import { queryDailyPlanStrategyContext } from "../../server/modules/strategy-runtime/daily-plan.js";
import { limitUpOpportunityItems } from "../../server/modules/strategy-runtime/limit-up-opportunities.js";
import { classifyIntradayBoardForm, classifyIntradayLadderRole } from "../../server/modules/market/first-board-advance.js";
import { fetchBatchIsolated } from "../../server/datasource/batch-isolation.js";
import { validateDailyPlanWriteInput, validateDailyPlanScenarioWriteInput } from "../../server/agent/tool-validation.js";
import {
  activatePlaybookForRun,
  getLatestDailyPlanBoard,
  replaceDraftScenarios,
} from "../../server/modules/plans/repo.js";
import { prepareTestDb, resetSchema } from "./helpers.js";

const prepared = await prepareTestDb();

describe("收盘打板候选独立映射", () => {
  it("只从评估结果生成最多四条结构化候选，并保留缺口与风险", () => {
    const signals = Array.from({ length: 5 }, (_, i) => ({ code: `99000${i}.SZ`, name: `样本${i}`,
      signal_grade: i === 0 ? "A" : "B-抱团", main_theme: "题材", risk_flags: ["高位分歧"], missing_inputs: ["竞价待确认"] }));
    const evaluation = { strategy: { code: "limit_up", runtime_version: 3 },
      ensured: { run: { id: "42", status: "success", data_date: "2026-09-17", gaps: [] }, result: { signals } } };
    const items = limitUpOpportunityItems(evaluation as unknown as Parameters<typeof limitUpOpportunityItems>[0]);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ item_kind: "off_pool_opportunity", code: "990000.SZ", grade: "A",
      priority: 1, primary_evaluation_run_id: "42", strategy_code: "limit_up", risk_md: "高位分歧", missing_md: "竞价待确认" });
    expect(items[1]).toMatchObject({ grade: "B", priority: 2 });
    const empty = { ...evaluation, ensured: { ...evaluation.ensured, result: { signals: [] } } };
    expect(limitUpOpportunityItems(empty as unknown as Parameters<typeof limitUpOpportunityItems>[0])).toEqual([]);
  });
});

describe("盘中批量取数隔离", () => {
  it("批次中的一只标的失败时二分后只跳过该标的", async () => {
    const requested: string[][] = [];
    const result = await fetchBatchIsolated(["A", "BAD", "B"], async (codes) => {
      requested.push(codes);
      if (codes.includes("BAD")) throw new Error("源接口单标的异常");
      return codes.map((code) => ({ code }));
    });
    expect(result).toEqual({ rows: [{ code: "A" }, { code: "B" }], skipped: ["BAD"] });
    expect(requested.some((codes) => codes.length === 1 && codes[0] === "BAD")).toBe(true);
    let rateLimitCalls = 0;
    await expect(fetchBatchIsolated(["A", "B"], async () => {
      rateLimitCalls++;
      throw new Error("HTTP 429 throttled");
    })).rejects.toThrow("429");
    expect(rateLimitCalls).toBe(1); // 全局限流不能二分放大请求。
  });
});

describe("盘中涨停梯队角色", () => {
  it("区分高位核心、被带动首板和高位断板后的切换", () => {
    expect(classifyIntradayLadderRole({ streakCount: 4, themeMaxStreak: 4, themeTierCount: 3, brokenMaxStreak: 0 }))
      .toEqual({ role: "theme_leader", highBoardState: "active" });
    expect(classifyIntradayLadderRole({ streakCount: 1, themeMaxStreak: 2, themeTierCount: 2, brokenMaxStreak: 0 }))
      .toEqual({ role: "high_board_follower", highBoardState: "active" });
    expect(classifyIntradayLadderRole({ streakCount: 1, themeMaxStreak: 2, themeTierCount: 2, brokenMaxStreak: 4 }))
      .toEqual({ role: "leadership_switch", highBoardState: "leader_broken" });
  });

  it("一字板和10:30后封板不作资格排除，只标记不同执行风险", () => {
    expect(classifyIntradayBoardForm({ hasTheme: true, oneWord: true, limitMinute: 565 }))
      .toEqual({ eligible: true, consistency: "high", executionRisk: "queue_fill_uncertain" });
    expect(classifyIntradayBoardForm({ hasTheme: true, oneWord: false, limitMinute: 631 }))
      .toEqual({ eligible: true, consistency: "normal", executionRisk: "late_seal" });
  });
});

describe.skipIf(!prepared)("每日计划策略统一编排", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
  });

  afterAll(async () => pool.end());

  it("无持仓时不运行入场与打板扫描", async () => {
    const first = await queryDailyPlanStrategyContext(pool, { date: "2026-09-17" });
    expect(first.strategy_coverage).toMatchObject({
      expected_evaluations: 0,
      position_count: 0,
      attributed_position_count: 0,
      executed_evaluations: 0,
    });
    expect(first.required_strategy_documents).toEqual(expect.arrayContaining([
      "daily_plan_strategy",

    ]));
    expect(first.playbook_items).toEqual([]);
    // 当日盘前消息快照缺失时显式列为缺口，情景预案缺少消息面输入。
    expect(first.market_news).toBeNull();
    expect(first.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "market_news", reason: expect.stringContaining("盘前消息快照缺失") }),
    ]));
    const second = await queryDailyPlanStrategyContext(pool, { date: "2026-09-17" });
    expect(second.strategy_coverage.reused_evaluations).toBe(0);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM strategy_evaluation_run WHERE target_date='2026-09-17'",
    )).rows[0]!.count).toBe(0);
  });

  it("持仓自动调用兜底策略并生成可原样写入的结构化预案", async () => {
    const instrument = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('510120.SH','统筹持仓样本','etf') RETURNING id::text",
    );
    await pool.query(
      `INSERT INTO portfolio_position
         (instrument_id,quantity,cost_price,opened_at,entry_signal_type,strategy_code,strategy_runtime_version,
          fallback_strategy_code,exit_policy_mode)
       VALUES ($1,100,10,'2026-09-01','discretionary','discretionary',1,'portfolio_fallback_exit','fallback_only')`,
      [instrument.rows[0]!.id],
    );
    const run = await pool.query<{ id: string }>(
      `INSERT INTO job_run(job_id,target_date,trigger_kind,status)
       SELECT id,'2026-09-17','manual','running' FROM job_definition WHERE code='daily_plan_flow'
       RETURNING id::text`,
    );
    const context = await queryDailyPlanStrategyContext(pool, {
      date: "2026-09-17", requested_by_job_run_id: run.rows[0]!.id,
    });
    expect(context.position_evaluations).toEqual([
      expect.objectContaining({
        code: "510120.SH", strategy_code: "discretionary", exit_policy_mode: "fallback_only",
        primary: null, fallback: expect.objectContaining({ evaluation_role: "fallback", action: "observe" }),
        effective_action: "observe", effective_source: "none", evaluation_status: "partial",
      }),
    ]);
    expect(context.strategy_coverage).toMatchObject({
      position_count: 1, attributed_position_count: 1, fallback_position_count: 1,
    });
    // key_levels 是服务端写入字段，不在旧 daily_plan_write 工具面内；回环校验只对代理可见字段。
    const items = validateDailyPlanWriteInput({
      items: context.playbook_items.map(({ key_levels: _keyLevels, ...rest }) => rest),
    }).items;
    expect(items).toEqual([
      expect.objectContaining({
        item_kind: "position_action", code: "510120.SH", action: "observe",
        strategy_code: "discretionary", fallback_action: "observe", effective_action: "observe",
        fallback_evaluation_run_id: expect.any(String),
      }),
    ]);
    expect(context.playbook_write).toEqual({ replaced: 1 });
    expect((await pool.query(
      `SELECT strategy_code,strategy_runtime_version,primary_action,fallback_action,effective_action,
              fallback_evaluation_run_id::text,evaluation_status,evaluation_missing
         FROM daily_plan_playbook WHERE source_job_run_id=$1`, [run.rows[0]!.id],
    )).rows[0]).toMatchObject({
      strategy_code: "discretionary", strategy_runtime_version: 1, primary_action: null,
      fallback_action: "observe", effective_action: "observe", fallback_evaluation_run_id: expect.any(String),
    });
  });

  it("一个持仓退出评估失败时仍完成其他持仓，异常仓位改为待复核", async () => {
    const inserted = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('600999.SH','缺数持仓','stock') RETURNING id::text",
    );
    await pool.query(`INSERT INTO portfolio_position
      (instrument_id,quantity,cost_price,opened_at,strategy_code,strategy_runtime_version,exit_policy_mode)
      VALUES ($1,100,10,'2026-09-01','two_year_reversal',1,'dedicated')`, [inserted.rows[0]!.id]);
    await pool.query("UPDATE strategy_definition SET exit_evaluator_code='unregistered_exit_v1' WHERE code='two_year_reversal'");
    try {
      const context = await queryDailyPlanStrategyContext(pool, { date: "2026-09-17" });
      expect(context.position_evaluations).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "510120.SH", effective_action: "observe", evaluation_status: "partial" }),
        expect.objectContaining({ code: "600999.SH", effective_action: "observe", evaluation_status: "partial",
          missing_items: expect.arrayContaining(["主策略退出评估不可用"]) }),
      ]));
      expect(context.gaps).toEqual(expect.arrayContaining([
        expect.objectContaining({ strategy_code: "two_year_reversal", phase: "exit" }),
      ]));
    } finally {
      await pool.query("UPDATE strategy_definition SET exit_evaluator_code='two_year_reversal_exit_v1' WHERE code='two_year_reversal'");
      await pool.query("DELETE FROM portfolio_position WHERE instrument_id=$1", [inserted.rows[0]!.id]);
      await pool.query("DELETE FROM market_instrument WHERE id=$1", [inserted.rows[0]!.id]);
    }
  });

  it("关键点位由服务端写入，情景与做T预案结构化落库并随看板返回", async () => {
    // 情景写入要求覆盖本次运行全部持仓；清掉先前用例遗留持仓，保证覆盖口径唯一。
    await pool.query("DELETE FROM portfolio_position");
    const instrument = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('600777.SH','情景预案样本','stock') RETURNING id::text",
    );
    const instrumentId = instrument.rows[0]!.id;
    await pool.query(
      `INSERT INTO portfolio_position
         (instrument_id,quantity,cost_price,opened_at,entry_signal_type,strategy_code,strategy_runtime_version,
          fallback_strategy_code,exit_policy_mode)
       VALUES ($1,200,10,'2026-09-10','discretionary','discretionary',1,'portfolio_fallback_exit','fallback_only')`,
      [instrumentId],
    );
    // 六根日线：最新 09-17 收 11.5，前日 09-16 高低 10.7/10.4，近10日高低 11.8/9.8；价位互不相同避免去重合并。
    const bars: Array<[string, number, number, number, number]> = [
      ["2026-09-10", 9.9, 10.1, 9.8, 10.0],
      ["2026-09-11", 10.0, 10.3, 9.9, 10.2],
      ["2026-09-12", 10.2, 10.5, 10.1, 10.4],
      ["2026-09-15", 10.4, 11.2, 10.3, 11.0],
      ["2026-09-16", 10.5, 10.7, 10.4, 10.6],
      ["2026-09-17", 11.0, 11.8, 10.9, 11.5],
    ];
    for (const [barDate, open, high, low, close] of bars) {
      await pool.query(
        `INSERT INTO market_bar(instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,channel)
         VALUES ($1,'day',$2::date,$3::timestamptz,$4,$5,$6,$7,1000,'test')`,
        [instrumentId, `${barDate}T00:00:00Z`, `${barDate}T00:00:00Z`, open, high, low, close],
      );
    }
    const run = await pool.query<{ id: string }>(
      `INSERT INTO job_run(job_id,target_date,trigger_kind,status)
       SELECT id,'2026-09-17','manual','running' FROM job_definition WHERE code='daily_plan_flow'
       RETURNING id::text`,
    );
    const runId = run.rows[0]!.id;

    // 盘前消息面：当日快照 + 逐持仓消息关联进入统筹查询结果；非当日采集会显式列为缺口。
    const newsRun = await pool.query<{ id: string }>(
      `INSERT INTO job_run(job_id,target_date,trigger_kind,status)
       SELECT id,'2026-09-17','cron','partial' FROM job_definition WHERE code='pre_market_news_scan'
       RETURNING id::text`,
    );
    const snapshot = await pool.query<{ id: string }>(
      `INSERT INTO market_news_snapshot(target_date,market_bias,summary,run_id,checked_codes,gaps,status)
       VALUES ('2026-09-17','positive','样本摘要',$1,$2::jsonb,'[]'::jsonb,'partial') RETURNING id::text`,
      [newsRun.rows[0]!.id, JSON.stringify(["600777.SH"])],
    );
    const newsItem = await pool.query<{ id: string }>(
      `INSERT INTO market_news_item(snapshot_id,title,summary,category,scope,direction,impact_level,relation_type,
         source_level,source_name,source_url,published_at,fetched_at,facts,impact_note,expires_at)
       VALUES ($1,'样本利好','摘要','company','instrument','positive','medium','direct',
         'professional','样本来源','https://example.com/news/1',now()-interval '1 hour',now()-interval '55 minutes',
         '事实','影响说明',now()+interval '2 hours') RETURNING id::text`,
      [snapshot.rows[0]!.id],
    );
    await pool.query(
      "INSERT INTO market_news_item_instrument(item_id,instrument_id) VALUES ($1,$2)",
      [newsItem.rows[0]!.id, instrumentId],
    );

    const context = await queryDailyPlanStrategyContext(pool, {
      date: "2026-09-17", requested_by_job_run_id: runId,
    });
    expect(context.market_news).toMatchObject({
      target_date: "2026-09-17", market_bias: "positive",
      positions: [expect.objectContaining({
        // 固定历史目标日使快照整体 stale，逐持仓方向与条目仍然透传。
        code: "600777.SH", direction: "positive", status: "stale",
        items: [expect.objectContaining({ title: "样本利好", source_name: "样本来源" })],
      })],
    });
    expect(context.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "market_news", reason: expect.stringContaining("盘前消息快照已过期") }),
    ]));
    expect(context.playbook_write).toEqual({ replaced: 1 });
    expect(context.position_boards.items).toEqual([
      expect.objectContaining({ code: "600777.SH", industries: [], concepts: [] }),
    ]);
    expect((await pool.query(
      "SELECT key_levels FROM daily_plan_playbook WHERE source_job_run_id=$1", [runId],
    )).rows[0]!.key_levels).toEqual(expect.arrayContaining([
      { kind: "resistance", label: "近10日高点", price: 11.8 },
      { kind: "support", label: "近10日低点", price: 9.8 },
      { kind: "resistance", label: "前日高点", price: 10.7 },
      { kind: "support", label: "前日低点", price: 10.4 },
      { kind: "limit", label: "预案日涨停价", price: 12.65 },
      { kind: "limit", label: "预案日跌停价", price: 10.35 },
    ]));

    const scenarioItems = validateDailyPlanScenarioWriteInput({
      items: [{
        code: "600777.SH",
        auction_md: "高开超 2% 直接按兑现区间核对",
        t_plan: {
          buy_lower: 10.6, buy_upper: 10.9, sell_lower: 11.6, sell_upper: 12.0,
          confirm_md: "回踩不破前日低点 10.4 且缩量", cancel_md: "收盘跌破 10.35",
        },
        scenarios: [
          { scenario_kind: "open_plunge", observable_md: "开盘低于 10.4", response_md: "观察跌停位 10.35 承接，不追加", invalidation_md: "盘中收回 10.6 上方" },
          { scenario_kind: "wide_swing", observable_md: "全天在 10.4~11.8 区间震荡", response_md: "低吸 10.6~10.9，兑现 11.6~12.0", invalidation_md: "跌破 10.35" },
        ],
      }],
    }).items;
    const write = await replaceDraftScenarios(pool, { source_job_run_id: runId, items: scenarioItems });
    expect(write).toEqual({ replaced_items: 1, replaced_scenarios: 2 });
    expect((await pool.query(
      "SELECT auction_md, t_plan FROM daily_plan_playbook WHERE source_job_run_id=$1", [runId],
    )).rows[0]).toMatchObject({ auction_md: "高开超 2% 直接按兑现区间核对", t_plan: expect.objectContaining({ buy_lower: 10.6 }) });

    // 覆盖不完整（缺持仓 / 多余标的）都必须显式失败。
    await expect(replaceDraftScenarios(pool, {
      source_job_run_id: runId,
      items: [{ code: "000001.SZ", t_plan: { skip_reason: "非持仓" }, scenarios: scenarioItems[0]!.scenarios }],
    })).rejects.toThrow("情景预案覆盖不完整");

    // 重复情景与倒挂的做T区间在工具入口被拒绝。
    expect(() => validateDailyPlanScenarioWriteInput({
      items: [{ code: "600777.SH", t_plan: { skip_reason: "停牌" },
        scenarios: [scenarioItems[0]!.scenarios[0]!, scenarioItems[0]!.scenarios[0]!] }],
    })).toThrow("重复");
    expect(() => validateDailyPlanScenarioWriteInput({
      items: [{ code: "600777.SH",
        t_plan: { buy_lower: 11.7, buy_upper: 11.8, sell_lower: 11.6, sell_upper: 12.0, confirm_md: "x", cancel_md: "y" },
        scenarios: scenarioItems[0]!.scenarios }],
    })).toThrow("低吸区间上沿应低于兑现区间下沿");

    // 重新执行统筹查询会整体替换草稿行：旧情景随之级联清理，需要重新提交。
    await queryDailyPlanStrategyContext(pool, { date: "2026-09-17", requested_by_job_run_id: runId });
    expect((await pool.query("SELECT count(*)::int AS count FROM daily_plan_scenario")).rows[0]!.count).toBe(0);
    await replaceDraftScenarios(pool, { source_job_run_id: runId, items: scenarioItems });

    const output = await pool.query<{ id: string }>(
      `INSERT INTO job_run_output(job_id,run_id,output_type,target_date,markdown,sha256,source)
       SELECT id,$1,'daily_plan','2026-09-17','# 样本',encode(sha256(convert_to('# 样本','UTF8')),'hex'),'agent_flow'
         FROM job_definition WHERE code='daily_plan_flow'
       RETURNING id::text`,
      [runId],
    );
    await pool.query("UPDATE job_run SET status='success' WHERE id=$1", [runId]);
    expect(await activatePlaybookForRun(pool, runId, output.rows[0]!.id)).toBe(1);

    const board = await getLatestDailyPlanBoard(pool);
    expect(board.position_actions).toEqual([
      expect.objectContaining({
        code: "600777.SH",
        key_levels: expect.arrayContaining([{ kind: "limit", label: "预案日涨停价", price: 12.65 }]),
        t_plan: expect.objectContaining({ buy_lower: 10.6, sell_upper: 12 }),
        scenarios: [
          expect.objectContaining({ scenario_kind: "open_plunge", observable_md: "开盘低于 10.4" }),
          expect.objectContaining({ scenario_kind: "wide_swing", response_md: "低吸 10.6~10.9，兑现 11.6~12.0" }),
        ],
      }),
    ]);

    await pool.query("DELETE FROM daily_plan_scenario");
    await pool.query("DELETE FROM daily_plan_playbook WHERE source_job_run_id=$1", [runId]);
    await pool.query("DELETE FROM job_run_output WHERE run_id=$1", [runId]);
    await pool.query("DELETE FROM job_run WHERE id=$1", [runId]);
    await pool.query("DELETE FROM portfolio_position WHERE instrument_id=$1", [instrumentId]);
    await pool.query("DELETE FROM strategy_position_evaluation WHERE instrument_id=$1", [instrumentId]);
    await pool.query("DELETE FROM market_bar WHERE instrument_id=$1", [instrumentId]);
    await pool.query("DELETE FROM market_instrument WHERE id=$1", [instrumentId]);
  });
  it("两账户共享市场事实但拥有不同退出评估与激活预案", async () => {
    const accounts = await Promise.all([createAccount(pool,"计划账户甲"),createAccount(pool,"计划账户乙")]);
    const instrument = (await pool.query<{id:string}>(`INSERT INTO market_instrument(code,name,kind)
      VALUES('990999.SZ','跨账户样本','stock') RETURNING id::text`)).rows[0]!.id;
    for (const [index,account] of accounts.entries()) {
      await pool.query(`INSERT INTO portfolio_position(account_id,instrument_id,quantity,cost_price,opened_at,
        strategy_code,strategy_runtime_version,fallback_strategy_code,exit_policy_mode)
        VALUES($1,$2,100,$3,'2026-09-28','discretionary',1,'portfolio_fallback_exit','fallback_only')`,[account.id,instrument,10+index*10]);
    }
    const runs: string[] = [];
    for (const account of accounts) {
      runs.push((await pool.query<{id:string}>(`INSERT INTO job_run(job_id,account_id,target_date,trigger_kind,status)
        SELECT id,$1,'2026-09-29','manual','running' FROM job_definition WHERE code='daily_plan_flow' RETURNING id::text`,[account.id])).rows[0]!.id);
    }
    const results = await Promise.all(accounts.map((account,index) => queryDailyPlanStrategyContext(pool,{
      date:"2026-09-29",account_id:account.id,requested_by_job_run_id:runs[index]})));
    expect(results[0]!.market).toEqual(results[1]!.market);
    expect(results.map(result=>result.position_evaluations.map(item=>item.code))).toEqual([["990999.SZ"],["990999.SZ"]]);
    expect(results[0]!.evaluations[0]!.run.id).not.toBe(results[1]!.evaluations[0]!.run.id);
    expect((await pool.query("SELECT count(*)::int AS count FROM daily_plan_market_context WHERE target_date='2026-09-29'")).rows[0].count).toBe(1);
    const outputIds: string[]=[];
    for (const [index,account] of accounts.entries()) {
      const output=(await pool.query<{id:string}>(`INSERT INTO job_run_output(job_id,run_id,account_id,output_type,target_date,markdown,sha256,source)
        SELECT job_id,id,account_id,'daily_plan',target_date,'账户计划',repeat('a',64),'agent_flow' FROM job_run WHERE id=$1 RETURNING id::text`,[runs[index]])).rows[0]!.id;
      outputIds.push(output);
      await activatePlaybookForRun(pool,runs[index]!,output);
      expect((await getLatestDailyPlanBoard(pool,account.id)).plan.output_id).toBe(output);
    }
    expect((await getLatestDailyPlanBoard(pool,accounts[0]!.id)).plan.output_id).toBe(outputIds[0]);
    expect((await pool.query("SELECT count(*)::int AS count FROM daily_plan_playbook WHERE source_job_run_id=ANY($1::bigint[]) AND status='active'",[runs])).rows[0].count).toBe(2);
  });

});
