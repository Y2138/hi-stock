// 每日计划纳入超短持仓：05 离场硬规则给出结构化动作，每日计划 LLM 只解释不放宽。
// 纯函数覆盖硬止损、低吸 1.5R/2.5R、未触发持有、缺输入观察与 evidence 规则摘要；
// DB 集成覆盖“不再调用 limit_up/兜底退出评估器”和 playbook evidence_md。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { runMigrations } from "../../server/db/migrate.js";
import {
  evaluateUltraShortPositionExit,
  queryDailyPlanStrategyContext,
  type UltraShortHoldingFacts,
} from "../../server/modules/strategy-runtime/daily-plan.js";
import { prepareTestDb, resetSchema, seedTestStrategy } from "./helpers.js";

function holding(overrides: Partial<UltraShortHoldingFacts> = {}): UltraShortHoldingFacts {
  return {
    target_date: "2026-09-17",
    entry_price: 10,
    position_opened_at: "2026-09-17T01:35:00Z",
    key_levels: { stop_price: 9.6, invalidation_price: 9.6 },
    tags: ["打板接力"],
    risk: { stop_pct: 4, position_cap_pct: 30, template: "打板接力" },
    ...overrides,
  };
}

function evaluate(close: number | null, facts: UltraShortHoldingFacts = holding()) {
  return evaluateUltraShortPositionExit({
    code: "600001.SH",
    name: "超短样本",
    close,
    close_date: "2026-09-17",
    holding: facts,
  });
}

describe("超短持仓每日计划退出硬规则", () => {
  it("收盘跌破止损价时给出 exit，且止损价作为保护位", () => {
    const evaluation = evaluate(9.5);
    expect(evaluation).toMatchObject({
      code: "600001.SH",
      strategy_code: "ultra_short",
      evaluation_role: "primary",
      action: "exit",
      trigger_kind: "open",
      trigger_price_lower: 9.6,
      trigger_price_upper: 9.6,
      protection_price: 9.6,
      missing_items: [],
    });
    expect(evaluation.reason).toContain("超短硬止损");
    expect(evaluation.evidence).toMatchObject({ entry: 10, stop: 9.6, current_close: 9.5 });
  });

  it("低吸 +1.5R 减半、+2.5R 清仓，止盈按 R 倍数机械计算", () => {
    const lowBuy = holding({ tags: ["龙回头"] });
    const firstTarget = evaluate(10.6, lowBuy);
    expect(firstTarget).toMatchObject({
      action: "reduce", trigger_kind: "price_range", trigger_price_lower: 10.6,
      protection_price: 9.6,
    });
    expect(firstTarget.reason).toContain("第一止盈");
    expect(firstTarget.evidence).toMatchObject({ line: "low_buy", target_1: 10.6, target_2: 11 });

    const betweenTargets = evaluate(10.75, lowBuy);
    expect(betweenTargets.action).toBe("reduce");

    const secondTarget = evaluate(11, lowBuy);
    expect(secondTarget).toMatchObject({ action: "exit", trigger_kind: "price_range", trigger_price_lower: 11 });
    expect(secondTarget.reason).toContain("第二止盈");

    expect(evaluate(11.2, lowBuy).action).toBe("exit");
    // 打板线不设固定止盈，同样的涨幅只按硬止损/开板规则处理。
    expect(evaluate(10.75).action).toBe("hold");
  });

  it("未触发硬止损与止盈时 hold，protection_price 为止损位", () => {
    const evaluation = evaluate(10.2);
    expect(evaluation).toMatchObject({
      action: "hold",
      trigger_kind: "condition",
      trigger_price_lower: 9.6,
      trigger_price_upper: 9.6,
      protection_price: 9.6,
    });
    expect(evaluation.reason).toContain("未跌破硬止损");
  });

  it("缺少入场价或止损/失效位时 observe，不猜测动作", () => {
    const missingEntry = evaluate(9.5, holding({ entry_price: null }));
    expect(missingEntry).toMatchObject({ action: "observe", protection_price: null, missing_items: [] });
    expect(missingEntry.reason).toBe("超短持仓缺少入场价/止损位");

    const missingStop = evaluate(9.5, holding({ key_levels: {} }));
    expect(missingStop.action).toBe("observe");
    expect(missingStop.reason).toBe("超短持仓缺少入场价/止损位");

    // 只有失效位时按失效位执行硬止损。
    const invalidationOnly = evaluate(9.35, holding({ key_levels: { invalidation_price: 9.4 } }));
    expect(invalidationOnly).toMatchObject({ action: "exit", protection_price: 9.4 });
    expect(invalidationOnly.evidence).toMatchObject({ stop: 9.4, invalidation: 9.4 });

    const missingClose = evaluate(null);
    expect(missingClose.action).toBe("observe");
    expect(missingClose.reason).toContain("缺少最新收盘价");
  });

  it("evidence 含硬止损、开板/炸板、D+1 14:50 等超短规则文本", () => {
    const board = evaluate(10.2);
    expect(board.evidence).toMatchObject({
      line: "board", entry: 10, stop: 9.6, invalidation: 9.6,
      target_1: null, target_2: null, close_date: "2026-09-17", target_date: "2026-09-17",
    });
    expect(board.evidence.time_stop).toBeTruthy();
    expect(Object.hasOwn(board.evidence, "time_stop")).toBe(true);
    const boardText = JSON.stringify(board.evidence);
    expect(boardText).toContain("硬止损");
    expect(boardText).toContain("开板/炸板");
    expect(String(board.evidence.time_stop)).toContain("14:50");

    const lowBuy = evaluate(10.2, holding({ tags: ["单阳不破"] }));
    const lowBuyText = JSON.stringify(lowBuy.evidence);
    expect(lowBuy.evidence).toMatchObject({ line: "low_buy", target_1: 10.6, target_2: 11 });
    expect(lowBuyText).toContain("+1.5R");
    expect(lowBuyText).toContain("+2.5R");
    expect(lowBuyText).toContain("时间止损");
  });
});

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("每日计划纳入超短持仓（数据库）", () => {
  let pool: pg.Pool;
  let normalInstrumentId = "";

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
    await seedTestStrategy(pool);
    const ultra = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('600001.SH','超短持仓样本','stock') RETURNING id::text",
    );
    const normal = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('600002.SH','普通持仓样本','stock') RETURNING id::text",
    );
    normalInstrumentId = normal.rows[0]!.id;
    // 超短持仓：归因为打板，配置了显式兜底退出；旧流程会因此请求 limit_up/兜底退出评估器。
    await pool.query(
      `INSERT INTO portfolio_position
         (instrument_id,quantity,cost_price,opened_at,entry_signal_type,strategy_code,strategy_runtime_version,
          fallback_strategy_code,exit_policy_mode)
       VALUES ($1,100,10,'2026-09-17','limit_up','limit_up',1,'portfolio_fallback_exit','fallback_only')`,
      [ultra.rows[0]!.id],
    );
    for (const [date, close] of [["2026-09-15", 9.9], ["2026-09-16", 9.8], ["2026-09-17", 9.5]] as const) {
      await pool.query(
        `INSERT INTO market_bar(instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,channel)
         VALUES ($1,'day',$2::date,$3::timestamptz,$4,10.1,9.4,$4,1000,'test')`,
        [ultra.rows[0]!.id, date, `${date}T00:00:00Z`, close],
      );
    }
    await pool.query(
      `INSERT INTO ultra_short_watchlist
         (target_date,data_date,code,name,sources,tags,key_levels,risk,entry_price,position_opened_at,exit_status)
       VALUES ('2026-09-17','2026-09-16','600001.SH','超短持仓样本','{post_close}','{打板接力}',
               '{"stop_price":9.6,"invalidation_price":9.6,"limit_up_price":10.7}'::jsonb,
               '{"stop_pct":4,"position_cap_pct":30,"template":"打板接力"}'::jsonb,
               10,'2026-09-17T01:35:00Z','holding')`,
    );
  });

  afterAll(async () => pool.end());

  it("超短持仓直接生成 primary 硬规则评估，不再请求原退出评估器", async () => {
    const context = await queryDailyPlanStrategyContext(pool, { date: "2026-09-17" });
    const ultra = context.position_evaluations.find((item) => item.code === "600001.SH")!;
    expect(ultra).toMatchObject({
      strategy_name: "超短策略",
      exit_policy_mode: "dedicated",
      effective_source: "primary",
      effective_action: "exit",
      evaluation_status: "success",
      data_date: "2026-09-17",
      primary_evaluation_run_id: null,
      fallback_evaluation_run_id: null,
      missing_items: [],
    });
    expect(ultra.primary).toMatchObject({
      strategy_code: "ultra_short", evaluation_role: "primary", action: "exit",
      trigger_kind: "open", protection_price: 9.6,
    });
    expect(ultra.primary!.evidence).toMatchObject({ line: "board", entry: 10, stop: 9.6, close_date: "2026-09-17" });

    // 只有超短持仓时不应产生任何策略评估运行，证明没有重复调用 limit_up/兜底评估器。
    expect(context.evaluations).toEqual([]);
    expect(context.strategy_coverage).toMatchObject({
      expected_evaluations: 0,
      executed_evaluations: 0,
      primary_position_count: 1,
      fallback_position_count: 0,
      position_count: 1,
    });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM strategy_evaluation_run WHERE target_date='2026-09-17'",
    )).rows[0]!.count).toBe(0);
  });

  it("普通持仓仍走原有兜底退出评估器，不受超短硬规则影响", async () => {
    await pool.query(
      `INSERT INTO portfolio_position
         (instrument_id,quantity,cost_price,opened_at,entry_signal_type,strategy_code,strategy_runtime_version,
          fallback_strategy_code,exit_policy_mode)
       VALUES ($1,100,10,'2026-09-10','discretionary','discretionary',1,'portfolio_fallback_exit','fallback_only')`,
      [normalInstrumentId],
    );
    const context = await queryDailyPlanStrategyContext(pool, { date: "2026-09-17" });
    const byCode = new Map(context.position_evaluations.map((item) => [item.code, item]));

    const ultra = byCode.get("600001.SH")!;
    expect(ultra).toMatchObject({
      exit_policy_mode: "dedicated", effective_source: "primary", primary_evaluation_run_id: null,
    });
    const normal = byCode.get("600002.SH")!;
    expect(normal.fallback_evaluation_run_id).toEqual(expect.any(String));
    expect(normal.primary).toBeNull();
    expect(context.strategy_coverage).toMatchObject({
      expected_evaluations: 1, primary_position_count: 1, position_count: 2,
    });
  });

  it("playbook evidence_md 带超短规则摘要，供 LLM 写情景与解释", async () => {
    const context = await queryDailyPlanStrategyContext(pool, { date: "2026-09-17" });
    const items = new Map(context.playbook_items.map((item) => [item.code, item]));

    const ultra = items.get("600001.SH")!;
    expect(ultra).toMatchObject({
      item_kind: "position_action",
      action: "exit",
      trigger_kind: "open",
      price_lower: 9.6,
      price_upper: 9.6,
      primary_action: "exit",
      fallback_action: null,
      effective_action: "exit",
      evaluation_status: "success",
      evaluation_data_date: "2026-09-17",
    });
    expect(ultra.evidence_md).toContain("超短确定性硬规则");
    expect(ultra.evidence_md).toContain("硬止损");
    expect(ultra.evidence_md).toContain("D+1 14:50");
    expect(ultra.evidence_md).toContain("9.60");

    const normal = items.get("600002.SH")!;
    expect(normal.evidence_md).not.toContain("超短确定性硬规则");
  });
});
