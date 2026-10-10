import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { storeBars } from "../../server/datasource/service.js";
import { recomputeIndicatorSeries } from "../../server/indicators/service.js";
import { querySwingSignals } from "../../server/modules/plans/swing-signals.js";
import { evaluateStrategyExit } from "../../server/modules/strategy-runtime/exit-evaluators.js";
import { positionGapReasons } from "../../server/modules/plans/evaluation-gaps.js";
import { runMigrations } from "../../server/db/migrate.js";
import { reconcileStrategyAttention } from "../../server/modules/strategy-runtime/attention.js";
import { describeEntryMissingSignals, ensureStrategyEvaluation } from "../../server/modules/strategy-runtime/service.js";
import { ensureStrategyPoolMemberProfile, listStrategyAttentionReviewEntries, listPoolView, listPoolResearch, setPoolAttentionEntry, setPoolSpecialAttention } from "../../server/modules/pools/repo.js";
import type { StrategyEvaluationRunSummary } from "../../server/modules/strategy-runtime/types.js";
import { prepareTestDb, resetSchema } from "./helpers.js";

const prepared = await prepareTestDb();

it("历史缺口按持仓隔离、提取原因并去重", () => {
  expect(positionGapReasons([
    { code: "A", reason: "缺日线" }, JSON.stringify({ code: "A", reason: "缺日线" }),
    JSON.stringify({ code: "B", reason: "他股缺口" }), "公共缺口",
    { gaps: [{ code: "A", reason: "缺规则" }, { code: "B", reason: "他股规则" }] },
  ], "A")).toEqual(["缺日线", "公共缺口", "缺规则"]);
});


it("接近候选缺口包含当前值和目标值", () => {
  expect(describeEntryMissingSignals("swing", {
    failed_conditions: ["rsi_oversold"], evidence: { rsi14: 42.823 },
  }, "approaching")).toEqual(["RSI14：当前 42.82，目标 < 30.00"]);
  expect(describeEntryMissingSignals("two_year_reversal", {
    missing_conditions: ["个股5日跌幅未达8%", "相对行业5日额外落后未达5个百分点"],
    stock_return_5: -0.0671, relative_return_5: -0.0438,
  }, "approaching")).toEqual([
    "个股5日收益：当前 -6.7%，目标 ≤ -8.0%",
    "相对行业5日收益：当前 -4.4%，目标 ≤ -5.0%",
  ]);
  expect(describeEntryMissingSignals("copper_left_launch", {
    failed_conditions: ["low_within_30_days"], evidence: { low_age: 45 },
  }, "approaching")).toEqual(["近60日低点距今：当前 45 个交易日，目标 ≤ 30 个交易日"]);
  expect(describeEntryMissingSignals("value_anchor", {
    failed_conditions: ["below_ma250"], ma250_deviation: -0.082,
  }, "approaching")).toEqual(["相对MA250偏离：当前 -8.2%，目标 ≤ -10.0%"]);
});

describe.skipIf(!prepared)("策略评估运行幂等复用", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
  });

  afterAll(async () => pool.end());

  it("已移除的商品仓位策略不可再触发结构化评估", async () => {
    for (const code of ["copper_inventory", "lithium_warehouse"]) {
      await expect(ensureStrategyEvaluation(pool, { strategy_code: code, phase: "context", target_date: "2026-09-17" }))
        .rejects.toThrow("策略运行时不存在");
    }
  });

  it("成功结果复用、失败重试、运行中等待且输入推进生成新运行", async () => {
    const input = { strategy_code: "swing", phase: "entry" as const, target_date: "2026-09-17" };
    const first = await ensureStrategyEvaluation(pool, input);
    expect(first).toMatchObject({ execution: "executed", run: { status: "success", attempt_count: 1 } });
    expect(first.result).toMatchObject({ status: "success", signal_count: 0 });

    const reused = await ensureStrategyEvaluation(pool, input);
    expect(reused).toMatchObject({ execution: "reused", run: { id: first.run.id, attempt_count: 1 } });
    expect(reused.result).toEqual(first.result);

    await pool.query("UPDATE strategy_evaluation_run SET status='failed',result=NULL WHERE id=$1", [first.run.id]);
    const retried = await ensureStrategyEvaluation(pool, input);
    expect(retried).toMatchObject({ execution: "executed", run: { id: first.run.id, status: "success", attempt_count: 2 } });

    await pool.query("UPDATE strategy_evaluation_run SET status='running',finished_at=NULL WHERE id=$1", [first.run.id]);
    const waiting = await ensureStrategyEvaluation(pool, input);
    expect(waiting).toMatchObject({ execution: "waiting", run: { id: first.run.id, status: "running" }, result: null });
    await pool.query("UPDATE strategy_evaluation_run SET started_at=now()-interval '31 minutes' WHERE id=$1", [first.run.id]);
    const recovered = await ensureStrategyEvaluation(pool, input);
    expect(recovered).toMatchObject({ execution: "executed", run: { id: first.run.id, status: "success", attempt_count: 3 } });

    const concurrentInput = { strategy_code: "swing", phase: "entry" as const, target_date: "2026-09-18" };
    const concurrent = await Promise.all([
      ensureStrategyEvaluation(pool, concurrentInput),
      ensureStrategyEvaluation(pool, concurrentInput),
    ]);
    expect(concurrent.map((item) => item.execution)).toContain("executed");
    expect(concurrent.every((item) => item.run.id === concurrent[0]!.run.id)).toBe(true);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM strategy_evaluation_run WHERE strategy_code='swing' AND target_date='2026-09-18'",
    )).rows[0]!.count).toBe(1);

    const instrument = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('990119.SZ','指纹推进样本','stock') RETURNING id::text",
    );
    await pool.query(
      "INSERT INTO pool_membership(instrument_id,pool,role,effective_from) VALUES ($1,'watch','关注','2026-09-17')",
      [instrument.rows[0]!.id],
    );
    const changed = await ensureStrategyEvaluation(pool, input);
    expect(changed.execution).toBe("executed");
    expect(changed.run.id).not.toBe(first.run.id);
    expect(changed.run.input_fingerprint).not.toBe(first.run.input_fingerprint);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM strategy_evaluation_run WHERE strategy_code='swing' AND target_date='2026-09-17'",
    )).rows[0]!.count).toBe(2);
  });

  it("策略信号自动入池时补齐已有五维画像", async () => {
    const instrument = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('990120.SZ','自动画像样本','stock') RETURNING id::text",
    );
    const indicator = await pool.query<{ id: string }>(
      `INSERT INTO market_indicator_run
         (instrument_id,freq,calculation_version,input_sha256,input_row_count,input_start_date,input_end_date,status,finished_at)
       VALUES ($1,'day','标的入池五维画像一版',$2,252,'2025-09-18','2026-09-18','success',now()) RETURNING id::text`,
      [instrument.rows[0]!.id, "1".repeat(64)],
    );
    await pool.query(
      `INSERT INTO market_stock_character_metric
         (instrument_id,as_of_date,calculation_version,indicator_run_id,input_row_count,defense_break_count,
          defense_recovered_count,stock_character_profile,stage,stock_character,tags)
       VALUES ($1,'2026-09-18','标的入池五维画像一版',$2,252,10,6,$3::jsonb,'调整','护盘中·波动高',$4::jsonb)`,
      [instrument.rows[0]!.id, indicator.rows[0]!.id, JSON.stringify({ dimensions: {} }), JSON.stringify(["阶段：调整"])],
    );
    const membership = await pool.query<{ id: string }>(
      `INSERT INTO pool_membership(instrument_id,pool,role,tags,stage,evaluation_summary,effective_from,management_mode)
       VALUES ($1,'watch','关注','["策略自动关注"]'::jsonb,'策略信号','旧自动关注','2026-09-18','strategy') RETURNING id::text`,
      [instrument.rows[0]!.id],
    );
    const run = await pool.query<{ id: string }>(
      `INSERT INTO strategy_evaluation_run
         (strategy_code,phase,target_date,data_date,evaluator_code,evaluator_version,strategy_runtime_version,
          strategy_snapshot_hash,input_fingerprint,status,coverage,gaps,started_at,finished_at,result)
       VALUES ('two_year_reversal','entry','2026-09-18','2026-09-18','two_year_reversal_entry_v1',1,1,
               $1,$2,'success','{}'::jsonb,'[]'::jsonb,now(),now(),'{}'::jsonb) RETURNING id::text`,
      ["2".repeat(64), "3".repeat(64)],
    );
    await pool.query(
      `INSERT INTO strategy_entry_signal
         (run_id,strategy_code,instrument_id,signal_status,reason,missing_signals,valid_from,evidence)
       VALUES ($1,'two_year_reversal',$2,'approaching','接近候选','["尚缺确认"]'::jsonb,'2026-09-18','{"stock_return_5":-0.0671,"relative_return_5":-0.0438}'::jsonb)`,
      [run.rows[0]!.id, instrument.rows[0]!.id],
    );
    await reconcileStrategyAttention(pool, {
      source_job: "daily_plan_flow",
      run: {
        id: run.rows[0]!.id, strategy_code: "two_year_reversal", phase: "entry", target_date: "2026-09-18",
        data_date: "2026-09-18", evaluator_code: "two_year_reversal_entry_v1", evaluator_version: 1,
        strategy_runtime_version: 1, strategy_snapshot_hash: "2".repeat(64), input_fingerprint: "3".repeat(64),
        status: "success", requested_by_job_run_id: null, reused_from_run_id: null, coverage: {}, gaps: [],
        started_at: null, finished_at: null, created_at: new Date().toISOString(), result: {},
        attempt_count: 1, last_requested_at: new Date().toISOString(),
      },
    });
    const research = await listPoolResearch(pool, "990120.SZ", "2026-09-18");
    expect(research).toHaveLength(1);
    expect(research[0]).toMatchObject({
      run_id: run.rows[0]!.id, strategy_code: "two_year_reversal", target_date: "2026-09-18",
      data_date: "2026-09-18", evidence: { stock_return_5: -0.0671, relative_return_5: -0.0438 },
    });
    expect(await listPoolResearch(pool, "990119.SZ", "2026-09-18")).toEqual([]);
    await setPoolAttentionEntry(pool, {
      code: "990120.SZ", source_job: "manual", status: "manual", reason: "个人观察", valid_from: "2026-09-18",
    });
    const manualResearch = (await listPoolResearch(pool, "990120.SZ", "2026-09-18"))
      .find((entry) => entry.strategy_code === null);
    expect(manualResearch).toMatchObject({ reason: "个人观察", run_id: null, evidence: null });
    expect(await listPoolResearch(pool, "990120.SZ", "2026-09-17")).toEqual([]);
    expect((await pool.query(
      `SELECT id::text,stock_character,stage,profile_as_of::text,profile_calculation_version,profile_input_sha256,tags
         FROM pool_membership WHERE instrument_id=$1 AND effective_to IS NULL`,
      [instrument.rows[0]!.id],
    )).rows[0]).toEqual({
      id: membership.rows[0]!.id,
      stock_character: "护盘中·波动高",
      stage: "调整",
      profile_as_of: "2026-09-18",
      profile_calculation_version: "标的入池五维画像一版",
      profile_input_sha256: "1".repeat(64),
      tags: ["阶段：调整", "策略自动关注"],
    });
  });

  it("出场评估持久化结构化持仓动作", async () => {
    const instrument = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('510119.SH','兜底评估样本','etf') RETURNING id::text",
    );
    await pool.query(
      `INSERT INTO portfolio_position
         (instrument_id,quantity,cost_price,opened_at,entry_signal_type,strategy_code,strategy_runtime_version,
          fallback_strategy_code,exit_policy_mode)
       VALUES ($1,100,10,'2026-09-01','discretionary','discretionary',1,'portfolio_fallback_exit','fallback_only')`,
      [instrument.rows[0]!.id],
    );
    const evaluation = await ensureStrategyEvaluation(pool, {
      strategy_code: "portfolio_fallback_exit", phase: "exit", target_date: "2026-09-17",
    });
    expect(evaluation.execution).toBe("executed");
    expect(evaluation.run.status).toBe("partial");
    expect((await pool.query(
      "SELECT strategy_code,evaluation_role,action FROM strategy_position_evaluation WHERE run_id=$1",
      [evaluation.run.id],
    )).rows).toEqual([
      { strategy_code: "portfolio_fallback_exit", evaluation_role: "fallback", action: "observe" },
    ]);
  });
  it("池外持仓按绑定策略评估，冷却期不强求档位，缺口不串到其他策略", async () => {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('990121.SZ','池外持仓样本','stock') RETURNING id::text");
    const id = rows[0]!.id;
    const end = Date.parse("2026-09-17T00:00:00Z");
    await storeBars(pool, id, "day", Array.from({ length: 130 }, (_, index) => ({
      date: new Date(end - (129 - index) * 86400000).toISOString().slice(0, 10),
      open: 10, high: 10.1, low: 9.9, close: 10, volume: 10000, adjustment: "forward",
    })), "test");
    const dirty = await pool.query<{ instrument_id: string; freq: "day"; generation: string }>(
      "SELECT instrument_id::text,freq,generation::text FROM market_indicator_dirty WHERE instrument_id=$1 AND freq='day'", [id]);
    expect(await recomputeIndicatorSeries(pool, dirty.rows[0]!)).toMatchObject({ status: "success" });
    await pool.query(`INSERT INTO portfolio_position
      (instrument_id,quantity,cost_price,opened_at,entry_signal_type,strategy_code,strategy_runtime_version,fallback_strategy_code,exit_policy_mode)
      VALUES ($1,100,10,'2026-09-16','discretionary','discretionary',1,'portfolio_fallback_exit','fallback_only')`, [id]);
    const evaluate = (strategyCode: string) => evaluateStrategyExit({ pool, targetDate: "2026-09-17", strategyCode });
    const early = await evaluate("portfolio_fallback_exit");
    expect(early.items.find((item) => item.code === "990121.SZ")).toMatchObject({ action: "hold", protection_price: 8.8, missing_items: [] });
    expect(early.gaps.filter((gap) => gap.code === "990121.SZ")).toEqual([]);
    await pool.query("UPDATE portfolio_position SET opened_at='2026-09-01' WHERE instrument_id=$1", [id]);
    const later = await evaluate("portfolio_fallback_exit");
    const own = later.items.find((item) => item.code === "990121.SZ")!;
    expect(own.action).toBe("observe");
    expect(own.missing_items).toHaveLength(1);
    expect(own.missing_items[0]).toContain("止损规则缺口");
    expect(JSON.stringify(own)).not.toContain("右侧六条件重算未完成");
    await pool.query(`UPDATE portfolio_position SET strategy_code='legacy_right_side',entry_signal_type='right_side',
      exit_policy_mode='dedicated_plus_fallback' WHERE instrument_id=$1`, [id]);
    const right = await evaluate("legacy_right_side");
    expect(right.items.map((item) => item.code)).toEqual(["990121.SZ"]);
    expect(right.gaps).toEqual([]);
    expect(right.items[0]!.missing_items).toEqual([]);
    expect((await pool.query("SELECT 1 FROM pool_membership WHERE instrument_id=$1", [id])).rows).toEqual([]);
  });

  it("存量复核按标的处理：部分成功清退低质信号，缺数不续期，人工与其他策略独立保留", async () => {
    const codes = ["990130.SZ", "990131.SZ", "990132.SZ", "990133.SZ", "990134.SZ", "990135.SZ"];
    for (const code of codes) {
      const { rows } = await pool.query<{ id: string }>(
        "INSERT INTO market_instrument(code,name,kind) VALUES ($1,'关注复核样本','stock') RETURNING id::text", [code]);
      await pool.query(`INSERT INTO pool_membership(instrument_id,pool,role,effective_from,management_mode)
        VALUES ($1,'watch','关注','2026-09-22',$2)`, [rows[0]!.id, code === "990134.SZ" ? "manual" : "strategy"]);
      await setPoolAttentionEntry(pool, { code, source_job: "swing_signal_scan", strategy_code: "swing",
        status: "qualified", reason: "旧信号", valid_from: "2026-09-22", valid_until: "2026-09-25", data_date: "2026-09-22" });
    }
    await setPoolAttentionEntry(pool, { code: "990132.SZ", source_job: "two_year_reversal_scan", strategy_code: "two_year_reversal",
      status: "qualified", reason: "其他策略仍有效", valid_from: "2026-09-22", valid_until: "2026-10-01" });
    await setPoolAttentionEntry(pool, { code: "990133.SZ", source_job: "manual", status: "manual", reason: "人工持续观察", valid_from: "2026-09-22" });
    await pool.query(`INSERT INTO portfolio_position(instrument_id,quantity,cost_price)
      SELECT id,100,10 FROM market_instrument WHERE code='990135.SZ'`);
    let sequence = 0;
    const run = async (date: string, reviewed: string[], status: "partial" | "success" = "partial") => {
      const result = { reviewed_codes: reviewed, review_gaps: [{ code: "990131.SZ", reason: "缺目标日RSI14" }] };
      const { rows } = await pool.query<{ id: string }>(`INSERT INTO strategy_evaluation_run
        (strategy_code,phase,target_date,data_date,evaluator_code,evaluator_version,strategy_runtime_version,strategy_snapshot_hash,input_fingerprint,status,result)
        VALUES ('swing','entry',$1,$1,'swing_entry_v1',2,1,$2,$3,$4,$5::jsonb) RETURNING id::text`,
        [date, "a".repeat(64), (++sequence).toString(16).padStart(64, "0"), status, JSON.stringify(result)]);
      return { id: rows[0]!.id, strategy_code: "swing", phase: "entry", target_date: date, data_date: date,
        evaluator_code: "swing_entry_v1", evaluator_version: 2, strategy_runtime_version: 1,
        strategy_snapshot_hash: "a".repeat(64), input_fingerprint: "a".repeat(64), status,
        requested_by_job_run_id: null, reused_from_run_id: null, coverage: {}, gaps: [],
        started_at: null, finished_at: null, created_at: date, result, attempt_count: 1, last_requested_at: date } satisfies StrategyEvaluationRunSummary;
    };
    const first = await run("2026-09-23", ["990130.SZ", "990132.SZ", "990133.SZ", "990134.SZ"]);
    const changes = await reconcileStrategyAttention(pool, { run: first, source_job: "swing_signal_scan" });
    expect(changes).toContainEqual(expect.objectContaining({ code: "990130.SZ", action: "clear", pool_removed: true }));
    expect(changes).toContainEqual(expect.objectContaining({ code: "990131.SZ", action: "retain", stale_reason: "缺目标日RSI14" }));
    expect(changes).toContainEqual(expect.objectContaining({ code: "990135.SZ", action: "retain" }));
    const memberships = await pool.query(`SELECT instrument.code,membership.effective_to::text FROM pool_membership membership
      JOIN market_instrument instrument ON instrument.id=membership.instrument_id WHERE instrument.code=ANY($1)`, [codes]);
    for (const code of ["990132.SZ", "990133.SZ", "990134.SZ"]) expect(memberships.rows.find((row) => row.code === code)?.effective_to).toBeNull();
    expect((await pool.query(`SELECT valid_until::text,stale_reason FROM pool_attention_entry entry JOIN market_instrument instrument
      ON instrument.id=entry.instrument_id WHERE instrument.code='990131.SZ'`)).rows[0]).toEqual({ valid_until: "2026-09-25", stale_reason: "缺目标日RSI14" });
    expect((await listPoolView(pool, "2026-09-28")).members.map((row) => row.code)).not.toContain("990131.SZ");
    const later = await run("2026-09-28", []);
    expect(await reconcileStrategyAttention(pool, { run: later, source_job: "swing_signal_scan" }))
      .toContainEqual(expect.objectContaining({ code: "990131.SZ", action: "clear", reason: "关注信号已超过有效期", pool_removed: true }));
    expect(await reconcileStrategyAttention(pool, { run: first, source_job: "swing_signal_scan" })).toEqual([]);
    expect((await pool.query(`SELECT quantity::int FROM portfolio_position position JOIN market_instrument instrument
      ON instrument.id=position.instrument_id WHERE instrument.code='990135.SZ'`)).rows[0]?.quantity).toBe(100);
  });

  it("自动成员同日退出后可恢复；修复人工成员画像不改变人工管理方式", async () => {
    // 复用前例的完整五维画像，检查同日恢复不会触发成员唯一键冲突。
    await pool.query(`UPDATE pool_membership SET effective_to=effective_from WHERE instrument_id=(SELECT id FROM market_instrument WHERE code='990120.SZ')`);
    await expect(ensureStrategyPoolMemberProfile(pool, { code: "990120.SZ", effective_from: "2026-09-18", strategy_name: "两年结构反转" })).resolves.toBe("created");
    await pool.query(`UPDATE pool_membership SET management_mode='manual',stock_character=NULL,stage=NULL,profile_as_of=NULL,
      note='人工保留' WHERE instrument_id=(SELECT id FROM market_instrument WHERE code='990120.SZ') AND effective_to IS NULL`);
    await expect(ensureStrategyPoolMemberProfile(pool, { code: "990120.SZ", effective_from: "2026-09-18", strategy_name: "两年结构反转" })).resolves.toBe("repaired");
    expect((await pool.query(`SELECT management_mode,note,tags FROM pool_membership
      WHERE instrument_id=(SELECT id FROM market_instrument WHERE code='990120.SZ') AND effective_to IS NULL`)).rows[0])
      .toMatchObject({ management_mode: "manual", note: "人工保留", tags: ["阶段：调整"] });
  });

  it("总预算挤出的存量信号保留至到期，不按失效清退", async () => {
    const instrument = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('990140.SZ','预算挤出样本','stock') RETURNING id::text",
    );
    await pool.query(`INSERT INTO pool_membership(instrument_id,pool,role,effective_from,management_mode)
      VALUES ($1,'watch','关注','2026-09-22','strategy')`, [instrument.rows[0]!.id]);
    await setPoolAttentionEntry(pool, { code: "990140.SZ", source_job: "swing_signal_scan", strategy_code: "swing",
      status: "qualified", reason: "旧信号", valid_from: "2026-09-22", valid_until: "2026-10-01", data_date: "2026-09-22" });
    const result = {
      reviewed_codes: ["990140.SZ"],
      review_gaps: [],
      capped_out: [{
        code: "990140.SZ", name: "预算挤出样本", signal_status: "qualified",
        expected_reward_risk: 1.9,
      }],
    };
    const { rows } = await pool.query<{ id: string }>(`INSERT INTO strategy_evaluation_run
      (strategy_code,phase,target_date,data_date,evaluator_code,evaluator_version,strategy_runtime_version,strategy_snapshot_hash,input_fingerprint,status,result)
      VALUES ('swing','entry','2026-09-29','2026-09-29','swing_entry_v1',2,1,$1,$2,'success',$3::jsonb) RETURNING id::text`,
      ["a".repeat(64), "b".repeat(64), JSON.stringify(result)]);
    const changes = await reconcileStrategyAttention(pool, {
      source_job: "swing_signal_scan",
      run: {
        id: rows[0]!.id, strategy_code: "swing", phase: "entry", target_date: "2026-09-29", data_date: "2026-09-29",
        evaluator_code: "swing_entry_v1", evaluator_version: 2, strategy_runtime_version: 1,
        strategy_snapshot_hash: "a".repeat(64), input_fingerprint: "b".repeat(64), status: "success",
        requested_by_job_run_id: null, reused_from_run_id: null, coverage: {}, gaps: [],
        started_at: null, finished_at: null, created_at: "2026-09-29", result, attempt_count: 1,
        last_requested_at: "2026-09-29",
      } satisfies StrategyEvaluationRunSummary,
    });
    expect(changes).toContainEqual(expect.objectContaining({
      code: "990140.SZ", action: "retain",
      stale_reason: "本轮因每日信号总预算未入选，条件仍满足，保留至到期",
    }));
    const entry = await pool.query<{ valid_until: string; stale_reason: string }>(`
      SELECT entry.valid_until::text,entry.stale_reason FROM pool_attention_entry entry
       WHERE entry.instrument_id=$1 AND entry.source_type='strategy'`, [instrument.rows[0]!.id]);
    expect(entry.rows[0]).toEqual({
      valid_until: "2026-10-01",
      stale_reason: "本轮因每日信号总预算未入选，条件仍满足，保留至到期",
    });
  });

  it("特别关注不随每日计划对账清退，取消后恢复常规清退", async () => {
    const instrument = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument(code,name,kind) VALUES ('990141.SZ','特别关注样本','stock') RETURNING id::text",
    );
    await pool.query(`INSERT INTO pool_membership(instrument_id,pool,role,effective_from,management_mode)
      VALUES ($1,'watch','关注','2026-09-22','strategy')`, [instrument.rows[0]!.id]);
    await pool.query("INSERT INTO market_trading_day(trade_date,is_open,source) VALUES ('2026-09-30',true,'test')");
    await setPoolSpecialAttention(pool, { code: "990141.SZ", special: true });
    await setPoolAttentionEntry(pool, { code: "990141.SZ", source_job: "swing_signal_scan", strategy_code: "swing",
      status: "qualified", reason: "旧信号", valid_from: "2026-09-22", valid_until: "2026-09-25", data_date: "2026-09-22" });
    const result = { reviewed_codes: ["990141.SZ"], review_gaps: [] };
    let sequence = 0;
    const run = async (date: string) => {
      const { rows } = await pool.query<{ id: string }>(`INSERT INTO strategy_evaluation_run
        (strategy_code,phase,target_date,data_date,evaluator_code,evaluator_version,strategy_runtime_version,strategy_snapshot_hash,input_fingerprint,status,result)
        VALUES ('swing','entry',$1,$1,'swing_entry_v1',2,1,$2,$3,'success',$4::jsonb) RETURNING id::text`,
        [date, "a".repeat(64), ((++sequence)).toString(16).padStart(64, "0"), JSON.stringify(result)]);
      return {
        id: rows[0]!.id, strategy_code: "swing", phase: "entry", target_date: date, data_date: date,
        evaluator_code: "swing_entry_v1", evaluator_version: 2, strategy_runtime_version: 1,
        strategy_snapshot_hash: "a".repeat(64), input_fingerprint: "a".repeat(64), status: "success",
        requested_by_job_run_id: null, reused_from_run_id: null, coverage: {}, gaps: [],
        started_at: null, finished_at: null, created_at: date, result, attempt_count: 1,
        last_requested_at: date,
      } satisfies StrategyEvaluationRunSummary;
    };
    // 复核已不再满足且已过期：普通标的会清退，特别关注必须保留并按交易日续期。
    const retained = await reconcileStrategyAttention(pool, { run: await run("2026-09-29"), source_job: "swing_signal_scan" });
    expect(retained).toContainEqual(expect.objectContaining({
      code: "990141.SZ", action: "retain",
      stale_reason: "特别关注保留：策略信号到期或不再满足，仅用户手动取消特别关注后才会清退",
    }));
    expect((await pool.query(`SELECT entry.valid_until::text,membership.effective_to::text
        FROM pool_attention_entry entry JOIN pool_membership membership ON membership.instrument_id=entry.instrument_id
       WHERE entry.instrument_id=$1 AND membership.effective_to IS NULL`, [instrument.rows[0]!.id])).rows[0])
      .toEqual({ valid_until: "2026-09-30", effective_to: null });
    expect((await listPoolView(pool, "2026-09-29")).members.find((row) => row.code === "990141.SZ"))
      .toMatchObject({ special_attention: true });
    expect((await listPoolView(pool, "2026-09-29")).special_count).toBe(1);
    // 取消特别关注后，同一复核结论按常规清退。
    await setPoolSpecialAttention(pool, { code: "990141.SZ", special: false });
    const cleared = await reconcileStrategyAttention(pool, { run: await run("2026-09-30"), source_job: "swing_signal_scan" });
    expect(cleared).toContainEqual(expect.objectContaining({
      code: "990141.SZ", action: "clear", reason: "复核后不再满足本策略关注条件", pool_removed: true,
    }));
  });

  it("存量波段标的缺日线时仍进入复核，过期条目可从研究上下文取全", async () => {
    const stock = (await pool.query<{ id: string }>("INSERT INTO market_instrument(code,name,kind,lifecycle_status) VALUES ('000136.SZ','存量缺数样本','stock','active') RETURNING id::text")).rows[0]!.id;
    const board = (await pool.query<{ id: string }>("INSERT INTO market_instrument(code,name,kind) VALUES ('881105.TI','周期行业样本','board') RETURNING id::text")).rows[0]!.id;
    await pool.query("INSERT INTO market_board(instrument_id,board_type,source,active) VALUES ($1,'industry','hithink',true)", [board]);
    await pool.query("INSERT INTO market_board_membership(board_instrument_id,member_instrument_id,effective_from) VALUES ($1,$2,'2026-09-01')", [board, stock]);
    await pool.query("INSERT INTO pool_membership(instrument_id,pool,role,effective_from,management_mode) VALUES ($1,'watch','关注','2026-09-22','strategy')", [stock]);
    await setPoolAttentionEntry(pool, { code: "000136.SZ", source_job: "swing_signal_scan", strategy_code: "swing", status: "qualified", reason: "旧信号", valid_from: "2026-09-22", valid_until: "2026-09-23" });
    const scan = await querySwingSignals(pool, "2026-09-24");
    expect(scan.member_count).toBe(1);
    expect(scan.reviewed_codes).not.toContain("000136.SZ");
    expect(scan.review_gaps).toContainEqual({ code: "000136.SZ", reason: "波段扫描至少需要40根日线，当前0根" });
    expect((await listPoolView(pool, "2026-09-24")).members.map((row) => row.code)).not.toContain("000136.SZ");
    expect(await listStrategyAttentionReviewEntries(pool)).toContainEqual(expect.objectContaining({ code: "000136.SZ", strategy_code: "swing" }));
  });

});
