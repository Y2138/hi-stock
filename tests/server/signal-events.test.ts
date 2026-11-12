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
  evaluateShadowOutcome,
  LiveRouteConflict,
  missingPlanParts,
  resolveLiveRoute,
  setLiveRoute,
  shouldWriteSignalEvents,
  ObservationPlanRevisionConflict,
  riskObjectFromItem,
  shadowComparison,
  shadowSignalEventsEnabled,
  upsertSignalEvent,
  upsertSignalOutcome,
} from "../../server/modules/strategy-runtime/signal-events.js";
import { prepareTestDb, resetSchema } from "./helpers.js";

const prepared = await prepareTestDb();

/**
 * 合成样本：五个连续工作日、同一触发条件、窗口逐日推进、事件低点逐日漂移。
 * 不含任何本机运行数据；真实 908 条回放另有用例，只读 ignored 的 artifacts。
 */
const SYNTHETIC_FIVE_DAY = [
  { validFrom: "2026-03-02", validUntil: "2026-03-03", signalLow: 10.5 },
  { validFrom: "2026-03-03", validUntil: "2026-03-04", signalLow: 10.8 },
  { validFrom: "2026-03-04", validUntil: "2026-03-05", signalLow: 10.2 },
  { validFrom: "2026-03-05", validUntil: "2026-03-06", signalLow: 9.9 },
  { validFrom: "2026-03-06", validUntil: "2026-03-09", signalLow: 10.1 },
];
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
    validUntil?: string | null;
    sourceKind?: "strategy" | "manual";
    triggerKind?: string;
    resetVerified?: boolean;
    producerCode?: string;
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
      producerCode: input.producerCode ?? (kind === "manual" ? "manual" : `${input.strategyCode}_entry_v1`),
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

  it("连续五个工作日命中（合成样本）：只留一条事件与一次首发，窗口不顺延、风险锚不覆盖", async () => {
    let firsts = 0;
    let eventId = "";
    for (const row of SYNTHETIC_FIVE_DAY) {
      const result = await writeEvent({
        strategyCode: "synthetic_replay",
        item: { code: "990121.SZ", evidence: { signal_low: row.signalLow, signal_low_raw: row.signalLow } },
        validFrom: row.validFrom,
        validUntil: row.validUntil,
      });
      if (result.first) firsts += 1;
      eventId = result.id;
    }
    const events = await pool.query(
      `SELECT id::text, status, valid_from::text AS valid_from, valid_until::text AS valid_until,
              signal_low, signal_low_raw
         FROM strategy_signal_event WHERE strategy_code='synthetic_replay'`,
    );
    expect(firsts).toBe(1);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ id: eventId, status: "observing", valid_from: SYNTHETIC_FIVE_DAY[0]!.validFrom });
    // 窗口逐日推进到最后一个交易日，事件只保留最早的窗口终点。
    expect(String(events.rows[0]!.valid_until).slice(0, 10)).toBe(SYNTHETIC_FIVE_DAY[0]!.validUntil);
    // 事件低点逐日漂移，只保留首次写入的价基。
    expect(Number(events.rows[0]!.signal_low)).toBe(SYNTHETIC_FIVE_DAY[0]!.signalLow);
  });

  const replayFile = path.join(process.cwd(), "artifacts/signal-export-20261111/strategy_entry_signal.jsonl");
  it.skipIf(!fs.existsSync(replayFile))(
    "真实样本回放（只读本机 artifacts，报告写回 artifacts）：连续命中只留一条事件", async () => {
      type ReplayRow = {
        id: string; strategy_code: string; instrument_code: string; instrument_name: string;
        trigger_kind: string; valid_from: string; valid_until: string | null; evidence: Record<string, unknown>;
      };
      const rows = fs.readFileSync(replayFile, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as ReplayRow);
      // 按「同策略 + 同标的 + 同条件指纹」分组，取命中交易日最多的一组做回放。
      const groups = new Map<string, ReplayRow[]>();
      for (const row of rows) {
        const digest = conditionHash(row.strategy_code, row.instrument_code, row.trigger_kind, { evidence: row.evidence });
        const key = `${row.strategy_code}|${row.instrument_code}|${digest}`;
        const list = groups.get(key) ?? [];
        list.push(row);
        groups.set(key, list);
      }
      const picked = [...groups.entries()]
        .map(([key, list]) => ({ key, list, days: new Set(list.map((row) => row.valid_from)).size }))
        .filter((group) => group.days >= 5)
        .sort((a, b) => b.days - a.days)[0];
      expect(picked).toBeTruthy();
      const sample = picked!.list.sort((a, b) => a.valid_from.localeCompare(b.valid_from));
      const head = sample[0]!;

      const existing = await pool.query<{ id: string }>(
        "SELECT id::text FROM market_instrument WHERE code=$1", [head.instrument_code],
      );
      const instrument = existing.rows[0]?.id ?? (await pool.query<{ id: string }>(
        `INSERT INTO market_instrument (code, name, kind, lifecycle_status)
         VALUES ($1,$2,'stock','active') RETURNING id::text`,
        [head.instrument_code, head.instrument_name],
      )).rows[0]!.id;
      await pool.query("DELETE FROM strategy_signal_event WHERE instrument_id=$1::bigint", [instrument]);

      let firsts = 0;
      for (const row of sample) {
        const result = await upsertSignalEvent(pool, {
          strategyCode: row.strategy_code,
          sourceKind: "strategy",
          instrumentId: instrument,
          instrumentCode: row.instrument_code,
          triggerKind: row.trigger_kind,
          signalStatus: "qualified",
          validFrom: row.valid_from,
          validUntil: row.valid_until,
          item: { code: row.instrument_code, name: row.instrument_name, evidence: row.evidence },
          producerCode: `${row.strategy_code}_entry_v1`,
          producerVersion: 1,
          runId: null,
          dataAsOf: row.valid_from,
        });
        if (result.first) firsts += 1;
      }
      const events = await pool.query<{ id: string; valid_until: string; signal_low: string | null }>(
        `SELECT id::text, valid_until::text AS valid_until, signal_low::text AS signal_low
           FROM strategy_signal_event WHERE instrument_id=$1::bigint`,
        [instrument],
      );
      expect(firsts).toBe(1);
      expect(events.rows).toHaveLength(1);
      // 原始数据窗口逐日顺延，事件必须停在首次窗口终点。
      expect(String(events.rows[0]!.valid_until).slice(0, 10)).toBe(String(head.valid_until).slice(0, 10));

      const reportDir = path.join(process.cwd(), "artifacts/shadow-replay");
      fs.mkdirSync(reportDir, { recursive: true });
      const reportPath = path.join(reportDir, "signal-replay-latest.json");
      fs.writeFileSync(reportPath, JSON.stringify({
        generated_at: new Date().toISOString(),
        source: path.relative(process.cwd(), replayFile),
        sample: {
          strategy_code: head.strategy_code, instrument_code: head.instrument_code,
          rows: sample.length, trading_days: picked!.days,
          first_valid_from: head.valid_from,
          last_valid_until: sample[sample.length - 1]!.valid_until,
        },
        result: {
          events: events.rows.length, first_emissions: firsts,
          kept_valid_until: events.rows[0]!.valid_until, kept_signal_low: events.rows[0]!.signal_low,
        },
      }, null, 2));
      console.log(`[shadow-replay] 报告写入 ${path.relative(process.cwd(), reportPath)}`);
    });

  it("连续命中不重置状态：计划已推进到 pending 后，再命中只更新证据不强拉回 observing", async () => {
    const first = await writeEvent({ strategyCode: "swing", item: swingItem, validFrom: "2026-11-11", validUntil: "2026-11-13" });
    expect(first.first).toBe(true);
    const plan = await createObservationPlan(pool, {
      eventId: first.id, sourceKind: "strategy", strategyCode: "swing", producerCode: "swing_entry_v1",
      producerVersion: 1,
      trigger: {
        rule: "次日突破", must_exceed: 12.4, window: "2026-11-12..2026-11-13",
        price_basis: "前复权", comparison: "close_above",
      },
      risk: { initial_stop: 11.6 }, actionable: true, dataAsOf: "2026-11-11",
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
    const seeded = await writeEvent({ strategyCode: "close_test", item: swingItem, validFrom: "2026-11-10" });
    await createObservationPlan(pool, {
      eventId: seeded.id, sourceKind: "strategy", strategyCode: "close_test", producerCode: "close_test_entry_v1",
      producerVersion: 1,
      trigger: {
        rule: "次日突破", must_exceed: 12.4, window: "2026-11-11..2026-11-12",
        price_basis: "前复权", comparison: "close_above",
      },
      risk: { initial_stop: 11.6 }, actionable: true, dataAsOf: "2026-11-10",
    });
    const moved = await appendEventTransition(pool, {
      eventId: seeded.id, fromStatus: "pending", toStatus: "invalidated",
      reason: "跌破初始风险线", factAt: new Date("2026-11-17T02:00:00Z"), idempotencyKey: "close-test-inv-1",
    });
    expect(moved).toMatchObject({ applied: true, moved: 1, logged: 1 });
    const row = await pool.query<{ status: string; closed_at: Date | null }>(
      `SELECT status, closed_at FROM strategy_signal_event WHERE id=$1::bigint`, [seeded.id],
    );
    expect(row.rows[0]!.status).toBe("invalidated");
    expect(row.rows[0]!.closed_at).not.toBeNull();

    const noProof = await writeEvent({ strategyCode: "close_test", item: swingItem, validFrom: "2026-11-18" });
    expect(noProof.first).toBe(false);
    expect(noProof.suppressed).toBe("no_reset_proof");
    const active = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM strategy_signal_event
        WHERE strategy_code='close_test' AND status IN ('observing','pending','triggered')`,
    );
    expect(active.rows[0]!.n).toBe(0);

    const reopened = await writeEvent({
      strategyCode: "close_test", item: swingItem, validFrom: "2026-11-18", resetVerified: true,
    });
    expect(reopened.first).toBe(true);
    expect(reopened.id).not.toBe(seeded.id);
  });

  it("状态转移原子：错位的前置状态不覆盖，重复幂等键只记一条", async () => {
    const event = await writeEvent({
      strategyCode: null, sourceKind: "manual", triggerKind: "condition", producerCode: "manual_atomic",
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
      producerCode: "manual_discovery_a",
    });
    const manualWithRisk = await writeEvent({
      strategyCode: null,
      item: { code: "990121.SZ", invalidation: 9.5, note: "用户给了失效价" },
      signalStatus: "qualified",
      sourceKind: "manual",
      triggerKind: "condition",
      producerCode: "manual_discovery_b",
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
    expect(source).toMatch(/if \(shouldWriteSignalEvents\(await resolveLiveRoute\(client, strategyCode\)\)\) \{\s*\n\s*await upsertSignalEvent/);
  });

  it("通用运行时事件路径不按策略名称分支", () => {
    const file = path.join(process.cwd(), "server/modules/strategy-runtime/signal-events.ts");
    const source = fs.readFileSync(file, "utf8");
    expect(source).not.toMatch(/strategyCode\s*===\s*["'](swing|two_year_reversal|limit_up|value_anchor)/);
    expect(source).not.toMatch(/["']nightly_sector["']\s*===|===\s*["']nightly_sector["']/);
    // 成熟度必须按上海时区与当日收盘判断，不能退回数据库 CURRENT_DATE。
    expect(source).toContain("AT TIME ZONE 'Asia/Shanghai'");
    expect(source).not.toMatch(/CURRENT_DATE/);
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
      trigger: {
        rule: "突破", window: "2026-11-12..2026-11-18",
        price_basis: "前复权", comparison: "close_above",
      },
      risk: { initial_stop: 11.6 },
      dataAsOf: "2026-11-11",
    })).toEqual([]);
    // 只有追高上限、没有失效条件：不能算有风险口径。
    expect(missingPlanParts({
      trigger: { rule: "突破", window: "2026-11-12..2026-11-18", price_basis: "前复权", comparison: "close_above" },
      risk: { confirmation_price_cap: 13.1 },
      dataAsOf: "2026-11-11",
    })).toEqual(expect.arrayContaining(["risk", "cancel_rule"]));
    // 空对象与空数组不能冒充规则。
    expect(missingPlanParts({
      trigger: { rule: {}, window: [] },
      risk: { initial_stop: 11.6 },
      dataAsOf: "",
    })).toEqual(expect.arrayContaining(["trigger_rule", "window", "as_of"]));
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
      strategyCode: null, sourceKind: "manual", triggerKind: "condition", producerCode: "manual_plan",
      item: { code: "990121.SZ", note: "完整手工计划：突破 12 买入，跌破 9.5 取消", invalidation: 9.5 },
    });
    const full = await createObservationPlan(pool, {
      eventId: event.id, sourceKind: "manual", strategyCode: null,
      producerCode: "manual", producerVersion: 1,
      trigger: {
        rule: "突破 12 买入", window: "2026-11-12..2026-11-18",
        price_basis: "前复权", comparison: "close_above",
      },
      risk: { invalidation: 9.5, kind: "close_below" },
      actionable: true, dataAsOf: "2026-11-11",
    });
    expect(full).toMatchObject({ lifecycleStatus: "published", actionable: true });
    const draftEvent = await writeEvent({
      strategyCode: null, sourceKind: "manual", triggerKind: "condition", producerCode: "manual_draft",
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
      trigger: {
        rule: "突破 12 买入", window: "2026-11-12..2026-11-18",
        price_basis: "前复权", comparison: "close_above",
      },
      risk: { foo: 1 }, actionable: true, dataAsOf: "2026-11-11",
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

  it("条件演化不算新机会：同来源同标的条件变化只更新指纹与证据，不产生第二次首发", async () => {
    const before = await writeEvent({
      strategyCode: "cond_evo", validFrom: "2026-04-01",
      item: { code: "990121.SZ", note: "条件A：回撤达标" },
    });
    expect(before.first).toBe(true);
    const changed = await writeEvent({
      strategyCode: "cond_evo", validFrom: "2026-04-02",
      item: { code: "990121.SZ", note: "条件A：回撤不再达标" },
    });
    expect(changed.first).toBe(false);
    expect(changed.id).toBe(before.id);
    const rows = await pool.query<{ condition_hash: string }>(
      `SELECT condition_hash FROM strategy_signal_event WHERE strategy_code='cond_evo'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.condition_hash)
      .toBe(conditionHash("cond_evo", "990121.SZ", "condition", { note: "条件A：回撤不再达标" }));
  });

  it("规则版本变化算新机会：ruleHash 进入事件身份，续写不覆盖", async () => {
    const base = {
      strategyCode: "rule_ver", sourceKind: "strategy" as const,
      instrumentId, instrumentCode: "990121.SZ", triggerKind: "condition",
      signalStatus: "qualified" as const, validFrom: "2026-04-10", validUntil: null,
      item: { code: "990121.SZ", note: "同一形态" },
      producerCode: "rule_ver_entry_v1", producerVersion: 1, runId: null,
    };
    const first = await upsertSignalEvent(pool, { ...base, ruleHash: "rule-v1" });
    const again = await upsertSignalEvent(pool, { ...base, ruleHash: "rule-v1" });
    const bumped = await upsertSignalEvent(pool, { ...base, ruleHash: "rule-v2" });
    expect(first.first).toBe(true);
    expect(again.first).toBe(false);
    expect(again.id).toBe(first.id);
    expect(bumped.first).toBe(true);
    expect(bumped.id).not.toBe(first.id);
    const firstRow = await pool.query<{ rule_hash: string }>(
      `SELECT rule_hash FROM strategy_signal_event WHERE id=$1::bigint`, [first.id],
    );
    expect(firstRow.rows[0]!.rule_hash).toBe("rule-v1");
  });

  it("计划请求幂等与修订冲突：同 requestKey 复用同一计划，修订号不对直接拒绝", async () => {
    const event = await writeEvent({
      strategyCode: null, sourceKind: "manual", triggerKind: "condition", producerCode: "manual_idem",
      item: { code: "990121.SZ", invalidation: 9.5, note: "幂等计划" },
    });
    const plan = {
      eventId: event.id, sourceKind: "manual" as const, strategyCode: null,
      producerCode: "manual_idem", producerVersion: 1,
      trigger: { rule: "突破 12 买入", window: "2026-11-12..2026-11-18", price_basis: "前复权", comparison: "close_above" },
      risk: { invalidation: 9.5 }, actionable: true, dataAsOf: "2026-11-11",
    };
    const created = await createObservationPlan(pool, { ...plan, requestKey: "req-plan-1" });
    const replayed = await createObservationPlan(pool, { ...plan, requestKey: "req-plan-1" });
    expect(replayed.id).toBe(created.id);
    expect(replayed.revision).toBe(created.revision);
    const plans = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM observation_plan WHERE event_id=$1::bigint`, [event.id],
    );
    expect(plans.rows[0]!.n).toBe(1);
    await expect(createObservationPlan(pool, { ...plan, revision: 99 }))
      .rejects.toBeInstanceOf(ObservationPlanRevisionConflict);
  });

  it("结果按计划与行情算出来：次日开 10 收 11 再下一日收 12，1 日必须 10% 不是 20%", async () => {
    const instrument = (await pool.query<{ id: string }>(
      `INSERT INTO market_instrument (code, name, kind, lifecycle_status)
       VALUES ('990123.SZ', '结果计算样本', 'stock', 'active') RETURNING id::text`,
    )).rows[0]!.id;
    for (const day of ["2026-05-06", "2026-05-07", "2026-05-08", "2026-05-11"]) {
      await pool.query(
        `INSERT INTO market_trading_day (trade_date, is_open, source) VALUES ($1::date, true, 'test')
         ON CONFLICT (trade_date) DO NOTHING`, [day],
      );
    }
    const bars: Array<[string, number, number]> = [
      ["2026-05-06", 10.0, 11.0], ["2026-05-07", 11.0, 12.0],
      ["2026-05-08", 12.0, 10.5], ["2026-05-11", 10.5, 13.0],
    ];
    for (const [date, open, close] of bars) {
      await pool.query(
        `INSERT INTO market_bar (instrument_id, freq, bar_date, bar_time, open, high, low, close, adjustment, channel)
         VALUES ($1::bigint, 'day', $2::date, ($2::date)::timestamp AT TIME ZONE 'UTC', $3, $3, $3, $4, '前复权', 'test')`,
        [instrument, date, open, close],
      );
    }
    const event = await pool.query<{ id: string }>(
      `INSERT INTO strategy_signal_event
         (source_kind, scope, strategy_code, instrument_id, condition_hash, trigger_kind,
          signal_status, status, valid_from, producer_code, producer_version, evidence,
          created_at, available_at)
       VALUES ('strategy','personal','outcome_calc',$1::bigint,$2,'condition','qualified','observing','2026-05-05',
               'outcome_calc_entry_v1',1,'{}'::jsonb,'2026-05-05T08:00:00+08:00','2026-05-05T16:00:00+08:00')
       RETURNING id::text`,
      [instrument, conditionHash("outcome_calc", "990123.SZ", "condition", {})],
    );
    const evaluated = await evaluateShadowOutcome(pool, {
      eventId: event.rows[0]!.id, horizons: [1, 2, 3, 5],
      entryBasis: "next_open", roundTripFeeBps: 10, priceBasis: "前复权",
      producerCode: "outcome_calc_evaluator", producerVersion: 1,
    });
    const one = evaluated.rows.find((row) => row.horizon === 1)!;
    // 次日开盘 10 → 次日收盘 11 = +10%，扣往返 10bp = +9.9%。取成 12 就会变成 20%，是错的。
    expect(one).toMatchObject({ status: "evaluated", entryPrice: 10, exitPrice: 11 });
    expect(one.returnPct).toBeCloseTo(9.9, 4);
    const two = evaluated.rows.find((row) => row.horizon === 2)!;
    expect(two).toMatchObject({ status: "evaluated", exitPrice: 12 });
    expect(two.returnPct).toBeCloseTo(19.9, 4);
    const five = evaluated.rows.find((row) => row.horizon === 5)!;
    expect(five.status).toBe("pending");
    expect(five.returnPct).toBeNull();
    // 价基不符时不得混用：要求原始价而行情是前复权，记缺数。
    const mismatched = await evaluateShadowOutcome(pool, {
      eventId: event.rows[0]!.id, horizons: [1], entryBasis: "next_open",
      roundTripFeeBps: 10, priceBasis: "原始价",
      producerCode: "outcome_calc_evaluator", producerVersion: 1,
    });
    expect(mismatched.rows[0]).toMatchObject({ status: "unavailable", returnPct: null });
    // 固定前瞻诊断没有成交证据，可成交性一律未知。
    const tradability = await pool.query<{ tradability: string }>(
      `SELECT DISTINCT tradability FROM strategy_signal_outcome WHERE event_id=$1::bigint`, [event.rows[0]!.id],
    );
    expect(tradability.rows.map((row) => row.tradability)).toEqual(["unknown"]);
  });

  it("费用或价基缺失一律拒算：不默认免费、不混用价基", async () => {
    const instrument = (await pool.query<{ id: string }>(
      `INSERT INTO market_instrument (code, name, kind, lifecycle_status)
       VALUES ('990125.SZ', '拒算样本', 'stock', 'active') RETURNING id::text`,
    )).rows[0]!.id;
    const eventId = (await pool.query<{ id: string }>(
      `INSERT INTO strategy_signal_event
         (source_kind, scope, strategy_code, instrument_id, condition_hash, trigger_kind,
          signal_status, status, valid_from, producer_code, producer_version, evidence, created_at, available_at)
       VALUES ('strategy','personal','refuse_calc',$1::bigint,$2,'condition','qualified','observing','2026-07-01',
               'refuse_calc_entry_v1',1,'{}'::jsonb,'2026-07-01T08:00:00+08:00','2026-07-01T16:00:00+08:00')
       RETURNING id::text`,
      [instrument, conditionHash("refuse_calc", "990125.SZ", "condition", {})],
    )).rows[0]!.id;
    // 费用缺失：不能默认 0 后声称已扣费。
    const noFee = await evaluateShadowOutcome(pool, {
      eventId, horizons: [1], entryBasis: "next_open", priceBasis: "前复权",
      producerCode: "refuse_calc_evaluator", producerVersion: 1,
    } as never);
    expect(noFee.rows[0]).toMatchObject({ status: "not_configured", returnPct: null });
    expect(noFee.rows[0]!.reason).toContain("round_trip_fee_bps");
    // 价基缺失：不能放行任意口径的行情。
    const noBasis = await evaluateShadowOutcome(pool, {
      eventId, horizons: [1], entryBasis: "next_open", roundTripFeeBps: 10,
      producerCode: "refuse_calc_evaluator", producerVersion: 1,
    });
    expect(noBasis.rows[0]).toMatchObject({ status: "not_configured", returnPct: null });
    expect(noBasis.rows[0]!.reason).toContain("price_basis");
  });

  it("迟到信号按可得时点起算：signal_close 不吃生成前收盘，并标注反事实", async () => {
    const instrument = (await pool.query<{ id: string }>(
      `INSERT INTO market_instrument (code, name, kind, lifecycle_status)
       VALUES ('990126.SZ', '迟到样本', 'stock', 'active') RETURNING id::text`,
    )).rows[0]!.id;
    for (const day of ["2026-08-03", "2026-08-04", "2026-08-05"]) {
      await pool.query(
        `INSERT INTO market_trading_day (trade_date, is_open, source) VALUES ($1::date, true, 'test')
         ON CONFLICT (trade_date) DO NOTHING`, [day],
      );
    }
    for (const [date, close] of [["2026-08-03", 9.0], ["2026-08-04", 10.0], ["2026-08-05", 10.5]] as Array<[string, number]>) {
      await pool.query(
        `INSERT INTO market_bar (instrument_id, freq, bar_date, bar_time, open, high, low, close, adjustment, channel)
         VALUES ($1::bigint, 'day', $2::date, ($2::date)::timestamp AT TIME ZONE 'UTC', $3, $3, $3, $3, '前复权', 'test')`,
        [instrument, date, close],
      );
    }
    // 信号有效日 08-03，但实际 08-04 才可得：起点必须是 08-04，不能用 08-03 的收盘。
    const eventId = (await pool.query<{ id: string }>(
      `INSERT INTO strategy_signal_event
         (source_kind, scope, strategy_code, instrument_id, condition_hash, trigger_kind,
          signal_status, status, valid_from, producer_code, producer_version, evidence, created_at, available_at)
       VALUES ('strategy','personal','late_calc',$1::bigint,$2,'condition','qualified','observing','2026-08-03',
               'late_calc_entry_v1',1,'{}'::jsonb,'2026-08-03T08:00:00+08:00','2026-08-04T16:00:00+08:00')
       RETURNING id::text`,
      [instrument, conditionHash("late_calc", "990126.SZ", "condition", {})],
    )).rows[0]!.id;
    const evaluated = await evaluateShadowOutcome(pool, {
      eventId, horizons: [1], entryBasis: "signal_close", roundTripFeeBps: 0, priceBasis: "前复权",
      producerCode: "late_calc_evaluator", producerVersion: 1,
    });
    expect(evaluated.rows[0]).toMatchObject({ status: "evaluated", entryPrice: 10.0, exitPrice: 10.5 });
    expect(evaluated.rows[0]!.returnPct).toBeCloseTo(5.0, 4);
    const stored = await pool.query<{ result: Record<string, unknown> }>(
      `SELECT result FROM strategy_signal_outcome WHERE event_id=$1::bigint`, [eventId],
    );
    expect(stored.rows[0]!.result).toMatchObject({ counterfactual: true, basis_date: "2026-08-04" });
  });

  it("波段来源端到端：策略产物经同一 service 落事件、出计划、算结果，无策略名分支", async () => {
    const instrument = (await pool.query<{ id: string }>(
      `INSERT INTO market_instrument (code, name, kind, lifecycle_status)
       VALUES ('990127.SZ', '波段来源样本', 'stock', 'active') RETURNING id::text`,
    )).rows[0]!.id;
    for (const day of ["2026-09-01", "2026-09-02", "2026-09-03"]) {
      await pool.query(
        `INSERT INTO market_trading_day (trade_date, is_open, source) VALUES ($1::date, true, 'test')
         ON CONFLICT (trade_date) DO NOTHING`, [day],
      );
    }
    for (const [date, open, close] of [["2026-09-01", 12.0, 12.6], ["2026-09-02", 12.6, 13.2], ["2026-09-03", 13.2, 12.9]] as Array<[string, number, number]>) {
      await pool.query(
        `INSERT INTO market_bar (instrument_id, freq, bar_date, bar_time, open, high, low, close, adjustment, channel)
         VALUES ($1::bigint, 'day', $2::date, ($2::date)::timestamp AT TIME ZONE 'UTC', $3, $3, $3, $4, '前复权', 'test')`,
        [instrument, date, open, close],
      );
    }
    // 波段评估器产物：初始风险线、T+1 突破价、追高上限都由策略自己算好。
    const produced = {
      code: "990127.SZ", name: "波段来源样本", signal: "箱体突破",
      trigger_price_lower: 12.4, trigger_price_upper: 13.1,
      evidence: { initial_stop: 11.6, confirmation_must_exceed: 12.4, confirmation_price_cap: 13.1, signal: "箱体突破" },
    };
    const event = await upsertSignalEvent(pool, {
      strategyCode: "swing", sourceKind: "strategy",
      instrumentId: instrument, instrumentCode: "990127.SZ", triggerKind: "price_range",
      signalStatus: "qualified", validFrom: "2026-08-31", validUntil: "2026-09-04",
      item: produced, producerCode: "swing_entry_v1", producerVersion: 3,
      runId: null, dataAsOf: "2026-08-31", availableAt: "2026-08-31T16:00:00+08:00",
      ruleHash: "swing-rule-v3",
    });
    expect(event.first).toBe(true);
    const mapped = await pool.query<{ initial_stop: string; confirmation_must_exceed: string; confirmation_price_cap: string; risk_source: string }>(
      `SELECT initial_stop::text, confirmation_must_exceed::text, confirmation_price_cap::text, risk_source
         FROM strategy_signal_event WHERE id=$1::bigint`, [event.id],
    );
    expect(mapped.rows[0]).toMatchObject({
      initial_stop: "11.6", confirmation_must_exceed: "12.4", confirmation_price_cap: "13.1", risk_source: "evaluator",
    });
    const plan = await createObservationPlan(pool, {
      eventId: event.id, sourceKind: "strategy", strategyCode: "swing",
      producerCode: "swing_entry_v1", producerVersion: 3,
      trigger: {
        rule: "次日突破 12.4，追高上限 13.1", window: "2026-09-01..2026-09-04",
        price_basis: "前复权", comparison: "close_above",
      },
      risk: { initial_stop: 11.6, confirmation_price_cap: 13.1 },
      actionable: true, dataAsOf: "2026-08-31", requestKey: "swing-e2e-1",
    });
    expect(plan).toMatchObject({ actionable: true, lifecycleStatus: "published" });
    const evaluated = await evaluateShadowOutcome(pool, {
      eventId: event.id, planId: plan.id, planRevision: plan.revision,
      horizons: [1], entryBasis: "next_open", roundTripFeeBps: 0,
      producerCode: "swing_evaluator", producerVersion: 1,
    });
    // 次日开 12.0、次日收 12.6 = +5%，与手工来源走同一条计算链。
    expect(evaluated.rows[0]).toMatchObject({ status: "evaluated", entryPrice: 12.0, exitPrice: 12.6 });
    expect(evaluated.rows[0]!.returnPct).toBeCloseTo(5.0, 4);
  });

  it("写入路由三档：默认 legacy，events_only 可切可回滚，full 未实现被拒", async () => {
    expect(await resolveLiveRoute(pool, "two_year_reversal")).toMatchObject({ mode: "legacy" });
    expect((await resolveLiveRoute(pool, "swing")).mode).toBe("legacy");
    const switched = await setLiveRoute(pool, {
      strategyCode: "two_year_reversal", mode: "events_only", reason: "主管批准切事件写入",
    });
    expect(switched.mode).toBe("events_only");
    expect(switched.generation).toBeGreaterThan(1);
    expect(shouldWriteSignalEvents(switched)).toBe(true);
    // 代次不对时拒绝，避免两个操作互相覆盖。
    await expect(setLiveRoute(pool, {
      strategyCode: "two_year_reversal", mode: "events_only", reason: "旧代次",
      expectedGeneration: switched.generation - 1,
    })).rejects.toBeInstanceOf(LiveRouteConflict);
    // full 要求池与通知一起切，本轮未实现，默认拒绝。
    await expect(setLiveRoute(pool, {
      strategyCode: "two_year_reversal", mode: "full", reason: "想直接全切",
    })).rejects.toBeInstanceOf(LiveRouteConflict);
    // 回滚同样是一条 UPDATE，代次继续递增。
    const rolled = await setLiveRoute(pool, {
      strategyCode: "two_year_reversal", mode: "legacy", reason: "回滚到旧链路",
    });
    expect(rolled).toMatchObject({ mode: "legacy", generation: switched.generation + 1 });
    expect(shouldWriteSignalEvents(rolled)).toBe(false);
  });

  it("events_only 下写事件不影响池与通知：四张表逐行不变", async () => {
    const snapshot = async () => ({
      membership: (await pool.query("SELECT * FROM pool_membership ORDER BY id")).rows,
      attention: (await pool.query("SELECT * FROM pool_attention_entry ORDER BY id")).rows,
      notification: (await pool.query("SELECT * FROM notification_delivery ORDER BY id")).rows,
      email: (await pool.query("SELECT * FROM email_delivery ORDER BY id")).rows,
    });
    await setLiveRoute(pool, { strategyCode: "route_check", mode: "events_only", reason: "零副作用校验" });
    const before = await snapshot();
    const route = await resolveLiveRoute(pool, "route_check");
    expect(shouldWriteSignalEvents(route)).toBe(true);
    await writeEvent({ strategyCode: "route_check", item: swingItem, validFrom: "2026-10-30" });
    expect(await snapshot()).toEqual(before);
  });

  it("手工计划端到端：提交→发布→触发→按行情算 outcome", async () => {
    const instrument = (await pool.query<{ id: string }>(
      `INSERT INTO market_instrument (code, name, kind, lifecycle_status)
       VALUES ('990124.SZ', '端到端样本', 'stock', 'active') RETURNING id::text`,
    )).rows[0]!.id;
    for (const day of ["2026-06-02", "2026-06-03"]) {
      await pool.query(
        `INSERT INTO market_trading_day (trade_date, is_open, source) VALUES ($1::date, true, 'test')
         ON CONFLICT (trade_date) DO NOTHING`, [day],
      );
    }
    for (const [date, open, close] of [["2026-06-02", 20.0, 21.0], ["2026-06-03", 21.0, 22.0]] as Array<[string, number, number]>) {
      await pool.query(
        `INSERT INTO market_bar (instrument_id, freq, bar_date, bar_time, open, high, low, close, adjustment, channel)
         VALUES ($1::bigint, 'day', $2::date, ($2::date)::timestamp AT TIME ZONE 'UTC', $3, $3, $3, $4, '前复权', 'test')`,
        [instrument, date, open, close],
      );
    }
    // 1) 手工来源提交发现：给出标的与失效价。
    const event = await upsertSignalEvent(pool, {
      strategyCode: null, sourceKind: "manual", scope: "personal",
      instrumentId: instrument, instrumentCode: "990124.SZ", triggerKind: "price_range",
      signalStatus: "qualified", validFrom: "2026-06-01", validUntil: "2026-06-05",
      item: { code: "990124.SZ", invalidation: 18.5, note: "突破 20 买入，跌破 18.5 取消" },
      producerCode: "manual_e2e", producerVersion: 1, runId: null,
      dataAsOf: "2026-06-01", availableAt: "2026-06-01T15:00:00+08:00",
    });
    expect(event.first).toBe(true);
    // 2) 计划发布：完整计划把事件推进到 pending。
    const plan = await createObservationPlan(pool, {
      eventId: event.id, sourceKind: "manual", strategyCode: null,
      producerCode: "manual_e2e", producerVersion: 1,
      trigger: {
        rule: "突破 20 买入", window: "2026-06-02..2026-06-05",
        price_basis: "前复权", comparison: "close_above",
      },
      risk: { invalidation: 18.5 },
      actionable: true, dataAsOf: "2026-06-01", requestKey: "e2e-plan-1",
    });
    expect(plan).toMatchObject({ actionable: true, lifecycleStatus: "published" });
    const pending = await pool.query<{ status: string }>(
      `SELECT status FROM strategy_signal_event WHERE id=$1::bigint`, [event.id],
    );
    expect(pending.rows[0]!.status).toBe("pending");
    // 3) 观测触发：pending → triggered，触发不等于成交。
    const triggered = await appendEventTransition(pool, {
      eventId: event.id, fromStatus: "pending", toStatus: "triggered",
      reason: "下一交易日收盘突破 20", factAt: new Date("2026-06-02T07:00:00Z"),
      idempotencyKey: "e2e-trigger-1",
    });
    expect(triggered).toMatchObject({ applied: true, moved: 1 });
    // 4) 结果计算：按计划与行情算 1 日收益并落 outcome。
    const evaluated = await evaluateShadowOutcome(pool, {
      eventId: event.id, planId: plan.id, planRevision: plan.revision,
      horizons: [1], entryBasis: "next_open", roundTripFeeBps: 0,
      producerCode: "manual_e2e_evaluator", producerVersion: 1,
    });
    expect(evaluated.rows[0]).toMatchObject({ horizon: 1, status: "evaluated", entryPrice: 20.0, exitPrice: 21.0 });
    expect(evaluated.rows[0]!.returnPct).toBeCloseTo(5.0, 4);
    const stored = await pool.query<{ status: string; plan_id: string; result: Record<string, unknown> | null }>(
      `SELECT status, plan_id::text, result FROM strategy_signal_outcome WHERE event_id=$1::bigint`, [event.id],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({ status: "evaluated", plan_id: plan.id });
    expect(Number((stored.rows[0]!.result as { return_pct: number }).return_pct)).toBeCloseTo(5.0, 4);
    // 全程没有写池、没有产生通知或邮件。
    expect((await pool.query<{ n: number }>("SELECT count(*)::int n FROM notification_delivery")).rows[0]!.n).toBe(0);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int n FROM email_delivery")).rows[0]!.n).toBe(0);
  });
});
