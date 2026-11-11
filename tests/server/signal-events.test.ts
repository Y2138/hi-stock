// 边界 1 验收：风险对象归一、事件去重、五态初值、手工与波段两种来源接入。
// 只读校验通用运行时不含策略名称分支；不改任务与提示词。
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../server/db/migrate.js";
import {
  conditionHash,
  createObservationPlan,
  initialEventStatus,
  riskObjectFromItem,
  shadowComparison,
  upsertSignalEvent,
  upsertSignalOutcome,
} from "../../server/modules/strategy-runtime/signal-events.js";
import { prepareTestDb, resetSchema } from "./helpers.js";

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("信号事件与观察计划（边界 1）", () => {
  let pool: pg.Pool;
  let instrumentId: string;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
    instrumentId = (await pool.query<{ id: string }>(
      `INSERT INTO market_instrument (code, name, kind, lifecycle_status)
       VALUES ('990121.SZ', '契约测试股份', 'stock', 'active') RETURNING id::text`,
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  const swingItem = {
    code: "990121.SZ",
    name: "契约测试股份",
    signal: "箱体突破",
    trigger_price_lower: 12.4,
    trigger_price_upper: 13.1,
    evidence: {
      initial_stop: 11.6,
      confirmation_must_exceed: 12.4,
      confirmation_price_cap: 13.1,
      signal: "箱体突破",
    },
  };
  const reversalItem = {
    code: "990121.SZ",
    name: "契约测试股份",
    signal_low: 9.8,
    signal_low_raw: 9.75,
    evidence: { signal_low: 9.8, signal_low_raw: 9.75 },
  };

  async function writeEvent(input: {
    strategyCode: string | null;
    item: Record<string, unknown>;
    signalStatus?: "qualified" | "approaching";
    validFrom?: string;
    sourceKind?: "strategy" | "manual";
    triggerKind?: string;
  }) {
    const kind = input.sourceKind ?? "strategy";
    return upsertSignalEvent(pool, {
      strategyCode: input.strategyCode,
      sourceKind: kind,
      instrumentId,
      instrumentCode: "990121.SZ",
      triggerKind: input.triggerKind ?? (input.item.trigger_price_lower ? "price_range" : "condition"),
      signalStatus: input.signalStatus ?? "qualified",
      validFrom: input.validFrom ?? "2026-11-11",
      validUntil: null,
      item: input.item,
      missingSignals: [],
      producerCode: kind === "manual" ? "manual" : `${input.strategyCode}_entry_v1`,
      producerVersion: 1,
      runId: null,
      dataAsOf: input.validFrom ?? "2026-11-11",
    });
  }

  it("风险对象：波段与两年反转各自的价位都映射到事件字段，不再只取顶层 invalidation", () => {
    const swing = riskObjectFromItem(swingItem);
    expect(swing).toMatchObject({
      initial_stop: 11.6,
      confirmation_must_exceed: 12.4,
      confirmation_price_cap: 13.1,
      risk_source: "evaluator",
    });
    const reversal = riskObjectFromItem(reversalItem);
    expect(reversal).toMatchObject({ signal_low: 9.8, signal_low_raw: 9.75, risk_source: "evaluator" });
    const bare = riskObjectFromItem({ code: "990121.SZ", evidence: {} });
    expect(bare.risk_source).toBe("none");
    expect(bare.initial_stop).toBeNull();
  });

  it("条件指纹稳定：同条件不同价格归一个事件，条件变化才算新事件", () => {
    const base = conditionHash("swing", "990121.SZ", "price_range", swingItem);
    const moved = conditionHash("swing", "990121.SZ", "price_range", {
      ...swingItem, trigger_price_lower: 12.9, trigger_price_upper: 13.6,
      evidence: { ...swingItem.evidence, confirmation_must_exceed: 12.9, confirmation_price_cap: 13.6 },
    });
    expect(moved).toBe(base);
    const changed = conditionHash("swing", "990121.SZ", "price_range", {
      ...swingItem, evidence: { ...swingItem.evidence, signal: "均线回归" },
    });
    expect(changed).not.toBe(base);
  });

  it("连续五日命中：只留一条存续事件与一次首发，最后命中时间向前推进", async () => {
    let firsts = 0;
    let eventId = "";
    for (const day of ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]) {
      const result = await writeEvent({ strategyCode: "swing", item: swingItem, validFrom: day });
      if (result.first) firsts += 1;
      eventId = result.id;
    }
    await createObservationPlan(pool, {
      eventId, sourceKind: "strategy", strategyCode: "swing", producerCode: "swing_entry_v1",
      producerVersion: 2, trigger: { rule: "次日突破", must_exceed: 12.4, cap: 13.1 },
      risk: { initial_stop: 11.6 }, actionable: true,
    });
    const events = await pool.query(
      `SELECT id::text, status, risk_source, initial_stop, first_seen_at, last_seen_at
         FROM strategy_signal_event WHERE strategy_code='swing'`,
    );
    expect(firsts).toBe(1);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ id: eventId, status: "pending", risk_source: "evaluator", initial_stop: "11.6" });
    expect(new Date(String(events.rows[0]!.last_seen_at)).getTime())
      .toBeGreaterThanOrEqual(new Date(String(events.rows[0]!.first_seen_at)).getTime());
  });

  it("事件结束后再次命中算新机会（先失效再重新触发）", async () => {
    await pool.query(`UPDATE strategy_signal_event SET status='invalidated' WHERE strategy_code='swing'`);
    const again = await writeEvent({ strategyCode: "swing", item: swingItem, validFrom: "2026-11-18" });
    expect(again.first).toBe(true);
    const active = await pool.query(
      `SELECT count(*)::int n FROM strategy_signal_event WHERE strategy_code='swing' AND status IN ('observing','pending','triggered')`,
    );
    expect(active.rows[0]!.n).toBe(1);
  });

  it("手工来源：不伪装成系统策略，风险字段为空时 risk_source=none", async () => {
    const manual = await writeEvent({
      strategyCode: null,
      item: { code: "990121.SZ", note: "用户发现的形态，待补价位" },
      signalStatus: "qualified",
      sourceKind: "manual",
      triggerKind: "condition",
    });
    const manualWithRisk = await writeEvent({
      strategyCode: null,
      item: { code: "990121.SZ", invalidation: 9.5, note: "用户给了失效价" },
      signalStatus: "qualified",
      sourceKind: "manual",
      triggerKind: "condition",
    });
    const rows = await pool.query<{ id: string; source_kind: string; risk_source: string; invalidation: string | null }>(
      `SELECT id::text, source_kind, risk_source, invalidation FROM strategy_signal_event
        WHERE id IN ($1::bigint, $2::bigint) ORDER BY id`,
      [manual.id, manualWithRisk.id],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ source_kind: "manual", risk_source: "none" });
    expect(rows.rows[1]).toMatchObject({ source_kind: "manual", risk_source: "manual", invalidation: "9.5" });
  });

  it("事件状态初值：新事件 observing，pending 只由完整计划推进", () => {
    expect(initialEventStatus("qualified")).toBe("observing");
    expect(initialEventStatus("approaching")).toBe("observing");
  });

  it("通用运行时事件路径不按策略名称分支", () => {
    const file = path.join(process.cwd(), "server/modules/strategy-runtime/signal-events.ts");
    const source = fs.readFileSync(file, "utf8");
    expect(source).not.toMatch(/strategyCode\s*===\s*["'](swing|two_year_reversal|limit_up|value_anchor)/);
    expect(source).not.toMatch(/["']nightly_sector["']\s*===|===\s*["']nightly_sector["']/);
  });
  it("影子计划：完整计划发布可执行，缺风险项只留草案；零写池零通知", async () => {
    const poolBefore = (await pool.query<{ n: number }>("SELECT count(*)::int n FROM pool_membership")).rows[0]!.n;
    const attentionBefore = (await pool.query<{ n: number }>("SELECT count(*)::int n FROM pool_attention_entry")).rows[0]!.n;
    const event = await writeEvent({
      strategyCode: null, sourceKind: "manual", triggerKind: "condition",
      item: { code: "990121.SZ", note: "完整手工计划：突破 12 买入，跌破 9.5 取消", invalidation: 9.5 },
    });
    const full = await createObservationPlan(pool, {
      eventId: event.id, sourceKind: "manual", strategyCode: null,
      producerCode: "manual", producerVersion: 1,
      trigger: { rule: "突破 12 买入", window: "2026-11-12..2026-11-18" },
      risk: { invalidation: 9.5, kind: "close_below" },
      actionable: true,
    });
    expect(full).toMatchObject({ lifecycleStatus: "published", actionable: true });
    const draftEvent = await writeEvent({
      strategyCode: null, sourceKind: "manual", triggerKind: "condition",
      item: { code: "990121.SZ", note: "缺项手工计划：只说了形态不错" },
    });
    const draft = await createObservationPlan(pool, {
      eventId: draftEvent.id, sourceKind: "manual", strategyCode: null,
      producerCode: "manual", producerVersion: 1, trigger: {}, risk: {}, actionable: true,
    });
    expect(draft).toMatchObject({ lifecycleStatus: "draft", actionable: false });
    expect(draft.missing).toContain("risk");
    const eventStatus = await pool.query<{ status: string }>(
      `SELECT status FROM strategy_signal_event WHERE id=$1::bigint`, [draftEvent.id],
    );
    expect(eventStatus.rows[0]!.status).toBe("observing");
    // 影子路径不写自选与关注，不产生通知待发送记录。
    expect((await pool.query<{ n: number }>("SELECT count(*)::int n FROM pool_membership")).rows[0]!.n).toBe(poolBefore);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int n FROM pool_attention_entry")).rows[0]!.n).toBe(attentionBefore);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int n FROM notification_delivery")).rows[0]!.n).toBe(0);
    const comparison = await shadowComparison(pool);
    expect(comparison.plans).toBeGreaterThanOrEqual(2);
    expect(comparison.actionable).toBeGreaterThanOrEqual(1);
  });

  it("结果回填：同口径同期限幂等，未成熟与不可成交不记 0 收益", async () => {
    const event = await writeEvent({
      strategyCode: "swing", item: swingItem, validFrom: "2026-11-20", triggerKind: "price_range",
    });
    const first = await upsertSignalOutcome(pool, {
      eventId: event.id, assessmentKind: "forward_diagnostic",
      producerCode: "swing_entry_v1", producerVersion: 2,
      sampleStart: "2026-11-21", sampleEnd: null,
      entryBasis: { kind: "next_open" }, status: "pending",
    });
    const second = await upsertSignalOutcome(pool, {
      eventId: event.id, assessmentKind: "forward_diagnostic",
      producerCode: "swing_entry_v1", producerVersion: 2,
      sampleStart: "2026-11-21", sampleEnd: null,
      entryBasis: { kind: "next_open" }, status: "not_executable",
      notEvaluableReason: "次日一字板无法成交",
    });
    expect(second.id).toBe(first.id);
    const rows = await pool.query<{ n: number; status: string; result: unknown }>(
      `SELECT count(*) OVER ()::int AS n, status, result FROM strategy_signal_outcome WHERE event_id=$1::bigint`,
      [event.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ status: "not_executable", result: null });
  });

});
