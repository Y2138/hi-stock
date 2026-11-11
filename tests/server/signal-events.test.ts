// 边界 1 验收：风险对象归一、事件去重、五态初值、手工与波段两种来源接入、真实样本回放与零副作用。
// 只读校验通用运行时不含策略名称分支；不改任务与提示词。
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../server/db/migrate.js";
import {
  appendEventTransition,
  conditionHash,
  createObservationPlan,
  initialEventStatus,
  missingPlanParts,
  riskObjectFromItem,
  shadowComparison,
  shadowSignalEventsEnabled,
  upsertSignalEvent,
  upsertSignalOutcome,
} from "../../server/modules/strategy-runtime/signal-events.js";
import { prepareTestDb, resetSchema } from "./helpers.js";

const prepared = await prepareTestDb();

/**
 * 真实样本（artifacts/signal-export-20261111 冻结的 908 条里的原始 6 行）：
 * two_year_reversal / 001309.SZ 德明利，跨 2026-10-13～10-19 五个连续交易日，10-14 同一天有两条。
 * valid_until 逐日顺延、signal_low 逐日漂移，正好用来验证「不续窗口、不覆盖风险锚」。
 */
const REAL_FIVE_DAY_SAMPLE = [
  { id: "493", validFrom: "2026-10-13", validUntil: "2026-10-14", signalLow: 218.03, signalLowRaw: 218.03 },
  { id: "510", validFrom: "2026-10-14", validUntil: "2026-10-15", signalLow: 223.3, signalLowRaw: 223.3 },
  { id: "515", validFrom: "2026-10-14", validUntil: "2026-10-15", signalLow: 223.3, signalLowRaw: 223.3 },
  { id: "533", validFrom: "2026-10-15", validUntil: "2026-10-16", signalLow: 208.61, signalLowRaw: 208.61 },
  { id: "557", validFrom: "2026-10-16", validUntil: "2026-10-19", signalLow: 204.5, signalLowRaw: 204.5 },
  { id: "580", validFrom: "2026-10-19", validUntil: "2026-10-20", signalLow: 206.64, signalLowRaw: 206.64 },
];

describe.skipIf(!prepared)("信号事件与观察计划（边界 1）", () => {
  let pool: pg.Pool;
  let instrumentId: string;
  let realInstrumentId: string;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
    instrumentId = (await pool.query<{ id: string }>(
      `INSERT INTO market_instrument (code, name, kind, lifecycle_status)
       VALUES ('990121.SZ', '契约测试股份', 'stock', 'active') RETURNING id::text`,
    )).rows[0]!.id;
    realInstrumentId = (await pool.query<{ id: string }>(
      `INSERT INTO market_instrument (code, name, kind, lifecycle_status)
       VALUES ('001309.SZ', '德明利', 'stock', 'active') RETURNING id::text`,
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
    validUntil?: string | null;
    sourceKind?: "strategy" | "manual";
    triggerKind?: string;
    resetVerified?: boolean;
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
      validUntil: input.validUntil ?? null,
      item: input.item,
      missingSignals: [],
      producerCode: kind === "manual" ? "manual" : `${input.strategyCode}_entry_v1`,
      producerVersion: 1,
      runId: null,
      dataAsOf: input.validFrom ?? "2026-11-11",
      resetVerified: input.resetVerified,
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

  it("真实 908 条样本回放：连续五个交易日只留一条事件与一次首发，窗口不顺延、风险锚不覆盖", async () => {
    let firsts = 0;
    let eventId = "";
    for (const row of REAL_FIVE_DAY_SAMPLE) {
      const result = await upsertSignalEvent(pool, {
        strategyCode: "two_year_reversal",
        sourceKind: "strategy",
        instrumentId: realInstrumentId,
        instrumentCode: "001309.SZ",
        triggerKind: "condition",
        signalStatus: "qualified",
        validFrom: row.validFrom,
        validUntil: row.validUntil,
        item: {
          code: "001309.SZ",
          name: "德明利",
          evidence: { signal_low: row.signalLow, signal_low_raw: row.signalLowRaw, industry_code: "881121.TI" },
        },
        producerCode: "two_year_reversal_entry_v1",
        producerVersion: 1,
        runId: null,
        dataAsOf: row.validFrom,
      });
      if (result.first) firsts += 1;
      eventId = result.id;
    }
    const events = await pool.query(
      `SELECT id::text, status, valid_from::text AS valid_from, valid_until::text AS valid_until,
              signal_low, signal_low_raw
         FROM strategy_signal_event WHERE instrument_id=$1::bigint`,
      [realInstrumentId],
    );
    expect(firsts).toBe(1);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ id: eventId, status: "observing", valid_from: "2026-10-13" });
    // 六条原始记录的 valid_until 逐日顺延到 2026-10-20，事件只保留最早的 2026-10-14。
    expect(String(events.rows[0]!.valid_until).slice(0, 10)).toBe("2026-10-14");
    // signal_low 逐日漂移 218.03→223.3→208.61→204.5→206.64，只保留首次的价基。
    expect(Number(events.rows[0]!.signal_low)).toBe(218.03);
    expect(Number(events.rows[0]!.signal_low_raw)).toBe(218.03);
  });

  it("连续命中不重置状态：计划已推进到 pending 后，再命中只更新证据不强拉回 observing", async () => {
    const first = await writeEvent({ strategyCode: "swing", item: swingItem, validFrom: "2026-11-11", validUntil: "2026-11-13" });
    expect(first.first).toBe(true);
    const plan = await createObservationPlan(pool, {
      eventId: first.id, sourceKind: "strategy", strategyCode: "swing", producerCode: "swing_entry_v1",
      producerVersion: 1,
      trigger: { rule: "次日突破", must_exceed: 12.4, window: "2026-11-12..2026-11-13" },
      risk: { initial_stop: 11.6 }, actionable: true,
    });
    expect(plan.actionable).toBe(true);
    const before = await pool.query<{ status: string; first_seen_at: Date }>(
      `SELECT status, first_seen_at FROM strategy_signal_event WHERE id=$1::bigint`, [first.id],
    );
    expect(before.rows[0]!.status).toBe("pending");

    const again = await writeEvent({
      strategyCode: "swing", item: swingItem, validFrom: "2026-11-12", validUntil: "2026-11-20",
    });
    expect(again.first).toBe(false);
    const after = await pool.query<{ status: string; first_seen_at: Date; valid_until: string; initial_stop: string }>(
      `SELECT status, first_seen_at, valid_until::text, initial_stop::text
         FROM strategy_signal_event WHERE id=$1::bigint`, [first.id],
    );
    expect(after.rows[0]!.status).toBe("pending");
    expect(after.rows[0]!.first_seen_at).toEqual(before.rows[0]!.first_seen_at);
    // 新的一次 valid_until=2026-11-20 更晚，事件仍保持最早的 2026-11-13。
    expect(String(after.rows[0]!.valid_until).slice(0, 10)).toBe("2026-11-13");
    expect(Number(after.rows[0]!.initial_stop)).toBe(11.6);
  });

  it("事件终结后直接再命中不算新机会，必须带复位证明", async () => {
    const closed = await pool.query<{ id: string }>(
      `SELECT id::text FROM strategy_signal_event WHERE strategy_code='swing'`,
    );
    const moved = await appendEventTransition(pool, {
      eventId: closed.rows[0]!.id, fromStatus: "pending", toStatus: "invalidated",
      reason: "跌破初始风险线", factAt: new Date("2026-11-17T02:00:00Z"), idempotencyKey: "swing-inv-1",
    });
    expect(moved).toMatchObject({ applied: true, moved: 1, logged: 1 });
    const row = await pool.query<{ status: string; closed_at: Date | null }>(
      `SELECT status, closed_at FROM strategy_signal_event WHERE id=$1::bigint`, [closed.rows[0]!.id],
    );
    expect(row.rows[0]!.status).toBe("invalidated");
    expect(row.rows[0]!.closed_at).not.toBeNull();

    const noProof = await writeEvent({ strategyCode: "swing", item: swingItem, validFrom: "2026-11-18" });
    expect(noProof.first).toBe(false);
    expect(noProof.suppressed).toBe("no_reset_proof");
    const active = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM strategy_signal_event
        WHERE strategy_code='swing' AND status IN ('observing','pending','triggered')`,
    );
    expect(active.rows[0]!.n).toBe(0);

    const reopened = await writeEvent({
      strategyCode: "swing", item: swingItem, validFrom: "2026-11-18", resetVerified: true,
    });
    expect(reopened.first).toBe(true);
    expect(reopened.id).not.toBe(closed.rows[0]!.id);
  });

  it("状态转移原子：错位的前置状态不覆盖，重复幂等键只记一条", async () => {
    const event = await writeEvent({
      strategyCode: null, sourceKind: "manual", triggerKind: "condition",
      item: { code: "990121.SZ", invalidation: 9.5, note: "转移原子性" },
    });
    const stale = await appendEventTransition(pool, {
      eventId: event.id, fromStatus: "pending", toStatus: "triggered",
      factAt: new Date("2026-11-12T02:00:00Z"), idempotencyKey: "stale-1",
    });
    expect(stale.applied).toBe(false);
    const status = await pool.query<{ status: string; triggered_at: Date | null }>(
      `SELECT status, triggered_at FROM strategy_signal_event WHERE id=$1::bigint`, [event.id],
    );
    expect(status.rows[0]!.status).toBe("observing");
    expect(status.rows[0]!.triggered_at).toBeNull();

    const ok = await appendEventTransition(pool, {
      eventId: event.id, fromStatus: "observing", toStatus: "triggered",
      factAt: new Date("2026-11-12T02:00:00Z"), idempotencyKey: "trig-1",
    });
    expect(ok).toMatchObject({ applied: true, moved: 1, logged: 1 });
    const replay = await appendEventTransition(pool, {
      eventId: event.id, fromStatus: "observing", toStatus: "triggered",
      factAt: new Date("2026-11-12T02:00:00Z"), idempotencyKey: "trig-1",
    });
    expect(replay.moved).toBe(0);
    const triggered = await pool.query<{ triggered_at: Date | null }>(
      `SELECT triggered_at FROM strategy_signal_event WHERE id=$1::bigint`, [event.id],
    );
    expect(triggered.rows[0]!.triggered_at).not.toBeNull();
    const logs = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM strategy_signal_event_transition WHERE event_id=$1::bigint`, [event.id],
    );
    expect(logs.rows[0]!.n).toBe(1);
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

  it("影子开关默认关闭：旧生产落库路径不会因应用迁移自动写事件", () => {
    expect(shadowSignalEventsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(shadowSignalEventsEnabled({ HISTOCK_SHADOW_SIGNAL_EVENTS: "1" } as NodeJS.ProcessEnv)).toBe(true);
    const file = path.join(process.cwd(), "server/modules/strategy-runtime/service.ts");
    const source = fs.readFileSync(file, "utf8");
    expect(source).toMatch(/if \(shadowSignalEventsEnabled\(\)\) \{\s*\n\s*await upsertSignalEvent/);
  });

  it("通用运行时事件路径不按策略名称分支", () => {
    const file = path.join(process.cwd(), "server/modules/strategy-runtime/signal-events.ts");
    const source = fs.readFileSync(file, "utf8");
    expect(source).not.toMatch(/strategyCode\s*===\s*["'](swing|two_year_reversal|limit_up|value_anchor)/);
    expect(source).not.toMatch(/["']nightly_sector["']\s*===|===\s*["']nightly_sector["']/);
  });

  it("计划完整性：只有对象非空不算完整，risk:{foo:1} 与缺窗口都只能是草案", () => {
    expect(missingPlanParts({
      trigger: { rule: "突破", window: "2026-11-12..2026-11-18" },
      risk: { foo: 1 },
    })).toEqual(expect.arrayContaining(["risk", "cancel_rule"]));
    expect(missingPlanParts({
      trigger: { rule: "突破" }, risk: { initial_stop: 11.6 },
    })).toContain("window");
    expect(missingPlanParts({
      trigger: { rule: "突破", window: "2026-11-12..2026-11-18" },
      risk: { initial_stop: 11.6 },
    })).toEqual([]);
  });

  it("影子计划：完整计划发布可执行，缺项只留草案；零写池零通知", async () => {
    const snapshot = async () => ({
      membership: (await pool.query("SELECT * FROM pool_membership ORDER BY id")).rows,
      attention: (await pool.query("SELECT * FROM pool_attention_entry ORDER BY id")).rows,
      notification: (await pool.query("SELECT * FROM notification_delivery ORDER BY id")).rows,
      email: (await pool.query("SELECT * FROM email_delivery ORDER BY id")).rows,
    });
    const before = await snapshot();
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
    expect(draft.missing).toEqual(expect.arrayContaining(["risk", "trigger_rule", "window", "cancel_rule"]));
    const halfPlan = await createObservationPlan(pool, {
      eventId: draftEvent.id, revision: 2, sourceKind: "manual", strategyCode: null,
      producerCode: "manual", producerVersion: 1,
      trigger: { rule: "突破 12 买入", window: "2026-11-12..2026-11-18" },
      risk: { foo: 1 }, actionable: true,
    });
    expect(halfPlan.actionable).toBe(false);
    const eventStatus = await pool.query<{ status: string }>(
      `SELECT status FROM strategy_signal_event WHERE id=$1::bigint`, [draftEvent.id],
    );
    expect(eventStatus.rows[0]!.status).toBe("observing");
    // 影子路径不写自选、不写关注、不产生任何待发送通知或邮件（逐行内容比对，不只看行数）。
    const after = await snapshot();
    expect(after).toEqual(before);
    const comparison = await shadowComparison(pool);
    expect(comparison.plans).toBeGreaterThanOrEqual(3);
    expect(comparison.actionable).toBeGreaterThanOrEqual(1);
    expect(comparison.drafts).toBeGreaterThanOrEqual(2);
  });

  it("结果回填：1/3/5/10 日各存一行，同期限幂等，未成熟与不可成交不记 0 收益", async () => {
    const event = await writeEvent({
      strategyCode: "swing", item: swingItem, validFrom: "2026-11-20", triggerKind: "price_range",
    });
    const first = await upsertSignalOutcome(pool, {
      eventId: event.id, assessmentKind: "forward_diagnostic",
      producerCode: "swing_entry_v1", producerVersion: 2,
      sampleStart: "2026-11-21", sampleEnd: null,
      entryBasis: { kind: "next_open" }, horizon: { days: 1 }, status: "pending",
    });
    const firstAgain = await upsertSignalOutcome(pool, {
      eventId: event.id, assessmentKind: "forward_diagnostic",
      producerCode: "swing_entry_v1", producerVersion: 2,
      sampleStart: "2026-11-21", sampleEnd: null,
      entryBasis: { kind: "next_open" }, horizon: { days: 1 }, status: "not_executable",
      notEvaluableReason: "次日一字板无法成交",
    });
    expect(firstAgain.id).toBe(first.id);
    for (const days of [3, 5, 10]) {
      await upsertSignalOutcome(pool, {
        eventId: event.id, assessmentKind: "forward_diagnostic",
        producerCode: "swing_entry_v1", producerVersion: 2,
        sampleStart: "2026-11-21", horizon: { days }, status: "pending",
      });
    }
    const rows = await pool.query<{ horizon_key: string; status: string; result: unknown }>(
      `SELECT horizon_key, status, result FROM strategy_signal_outcome WHERE event_id=$1::bigint`,
      [event.id],
    );
    expect(rows.rows).toHaveLength(4);
    const horizons = rows.rows.map((row) => JSON.parse(row.horizon_key)).map((h: { days: number }) => h.days).sort((a, b) => a - b);
    expect(horizons).toEqual([1, 3, 5, 10]);
    const oneDay = rows.rows.find((row) => JSON.parse(row.horizon_key).days === 1)!;
    expect(oneDay).toMatchObject({ status: "not_executable", result: null });
  });
});
