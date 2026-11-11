// 边界 1 服务层：把策略评估器产物归一成「独立信号事件 + 观察计划」，不再只取顶层 invalidation。
// 契约：specs/策略产物契约与影子接入/实施契约.md（PM 定稿）。
// 五态 observing/pending/triggered/invalidated/expired；连续命中只更新 last_seen 与证据，不重置首发、风险锚与窗口。
import crypto from "node:crypto";
import type pg from "pg";

export type SignalEventStatus = "observing" | "pending" | "triggered" | "invalidated" | "expired";
export type SignalStatus = "qualified" | "approaching";
export type RiskSource = "evaluator" | "manual" | "none";
export type SourceKind = "strategy" | "manual";
export type EventScope = "personal" | "account" | "shared";

export interface RiskObject {
  initial_stop: number | null;
  signal_low: number | null;
  signal_low_raw: number | null;
  confirmation_must_exceed: number | null;
  confirmation_price_cap: number | null;
  invalidation: number | null;
  risk_source: RiskSource;
}

export interface UpsertSignalEventInput {
  /** 自动来源必填；手工来源为 null，不虚构策略编码。 */
  strategyCode: string | null;
  sourceKind: SourceKind;
  sourceRef?: string | null;
  scope?: EventScope;
  instrumentId: string;
  instrumentCode: string;
  triggerKind: string;
  signalStatus: SignalStatus;
  validFrom: string;
  validUntil: string | null;
  item: Record<string, unknown>;
  missingSignals?: unknown;
  gaps?: unknown;
  evidenceRefs?: unknown;
  producerCode: string;
  producerVersion: number;
  runId: string | null;
  dataAsOf?: string | null;
  availableAt?: string | null;
  inputFingerprint?: string | null;
  ruleHash?: string | null;
}

type Db = Pick<pg.Pool, "query">;

function positive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 风险对象归一：策略自己算好的价位从 evidence 映射到事件字段，缺失保持 null 而不补造。 */
export function riskObjectFromItem(
  item: Record<string, unknown>,
  source: SourceKind = "strategy",
): RiskObject {
  const evidence = record(item.evidence);
  const initialStop = positive(evidence.initial_stop);
  const signalLow = positive(evidence.signal_low) ?? positive(item.signal_low);
  const signalLowRaw = positive(evidence.signal_low_raw) ?? positive(item.signal_low_raw);
  const mustExceed = positive(evidence.confirmation_must_exceed) ?? positive(item.trigger_price_lower);
  const priceCap = positive(evidence.confirmation_price_cap) ?? positive(item.trigger_price_upper);
  const invalidation = positive(item.invalidation);
  const known = [initialStop, signalLow, signalLowRaw, mustExceed, priceCap, invalidation].some((value) => value !== null);
  return {
    initial_stop: initialStop,
    signal_low: signalLow,
    signal_low_raw: signalLowRaw,
    confirmation_must_exceed: mustExceed,
    confirmation_price_cap: priceCap,
    invalidation,
    risk_source: known ? (source === "manual" ? "manual" : "evaluator") : "none",
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => String(item)).sort();
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

/** 触发条件指纹：只取稳定条件标识，价格与当日证据不参与，避免每天一个新事件。 */
export function conditionHash(
  strategyCode: string | null,
  instrumentCode: string,
  triggerKind: string,
  item: Record<string, unknown>,
): string {
  const evidence = record(item.evidence);
  const conditions = evidence.conditions ?? evidence.signal ?? evidence.cluster_signal
    ?? item.signal ?? item.condition_text ?? item.note ?? null;
  const payload = JSON.stringify({
    strategy: strategyCode,
    code: instrumentCode,
    trigger: triggerKind,
    conditions: stableValue(conditions),
  });
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * 扫描状态到五态初值：新事件一律 observing（只发现或条件不足）。
 * pending 需要「完整计划且 actionable」，由 createObservationPlan 推进；触发与失效由观测模块推进。
 */
export function initialEventStatus(_signalStatus: SignalStatus): Extract<SignalEventStatus, "observing"> {
  return "observing";
}

export interface UpsertResult {
  id: string;
  first: boolean;
  status: SignalEventStatus;
  conditionHash: string;
}

/**
 * 写入或续存信号事件。
 * 唯一键：COALESCE(strategy_code, producer_code) + instrument_id + condition_hash + scope（仅存续态）。
 * 命中存续事件时只更新证据、last_seen、风险线与窗口终点；first_seen / first_emitted / valid_from 不重置。
 */
export async function upsertSignalEvent(db: Db, input: UpsertSignalEventInput): Promise<UpsertResult> {
  const risk = riskObjectFromItem(input.item, input.sourceKind);
  const eventStatus = initialEventStatus(input.signalStatus);
  const scope = input.scope ?? "personal";
  const hash = conditionHash(input.strategyCode, input.instrumentCode, input.triggerKind, input.item);
  const existing = await db.query<{ id: string; status: SignalEventStatus }>(
    `SELECT id::text, status FROM strategy_signal_event
      WHERE COALESCE(strategy_code, producer_code)=COALESCE($1::text, producer_code)
        AND instrument_id=$2::bigint AND condition_hash=$3 AND scope=$4
        AND status IN ('observing','pending','triggered')
      FOR UPDATE`,
    [input.strategyCode, input.instrumentId, hash, scope],
  );
  if (existing.rows[0]) {
    await db.query(
      `UPDATE strategy_signal_event SET
         last_seen_at=now(), signal_status=$2, status=$3,
         valid_until=COALESCE($4::date, valid_until),
         initial_stop=COALESCE($5, initial_stop),
         signal_low=COALESCE($6, signal_low),
         signal_low_raw=COALESCE($7, signal_low_raw),
         confirmation_must_exceed=COALESCE($8, confirmation_must_exceed),
         confirmation_price_cap=COALESCE($9, confirmation_price_cap),
         invalidation=COALESCE($10, invalidation),
         risk_source=CASE WHEN risk_source='none' AND $11<>'none' THEN $11 ELSE risk_source END,
         evidence=$12::jsonb, missing_signals=$13::jsonb,
         gaps=$14::jsonb, evidence_refs=$15::jsonb,
         producer_code=$16, producer_version=$17, run_id=$18::bigint,
         data_as_of=COALESCE($19::date, data_as_of),
         available_at=COALESCE($20::timestamptz, available_at),
         input_fingerprint=COALESCE($21, input_fingerprint),
         rule_hash=COALESCE($22, rule_hash),
         updated_at=now()
       WHERE id=$1::bigint`,
      [existing.rows[0].id, input.signalStatus, eventStatus, input.validUntil,
        risk.initial_stop, risk.signal_low, risk.signal_low_raw, risk.confirmation_must_exceed,
        risk.confirmation_price_cap, risk.invalidation, risk.risk_source,
        JSON.stringify(input.item), JSON.stringify(input.missingSignals ?? []),
        JSON.stringify(input.gaps ?? []), JSON.stringify(input.evidenceRefs ?? []),
        input.producerCode, input.producerVersion, input.runId,
        input.dataAsOf ?? null, input.availableAt ?? null,
        input.inputFingerprint ?? null, input.ruleHash ?? null],
    );
    return { id: existing.rows[0].id, first: false, status: eventStatus, conditionHash: hash };
  }
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO strategy_signal_event
       (source_kind, source_ref, scope, strategy_code, instrument_id, condition_hash, trigger_kind,
        signal_status, status, first_emitted_at, valid_from, valid_until,
        initial_stop, signal_low, signal_low_raw, confirmation_must_exceed, confirmation_price_cap,
        invalidation, risk_source, producer_code, producer_version, data_as_of, available_at,
        input_fingerprint, rule_hash, evidence, evidence_refs, gaps, missing_signals, run_id, current_revision)
     VALUES ($1,$2,$3,$4,$5::bigint,$6,$7,$8,$9,now(),$10::date,$11::date,
             $12,$13,$14,$15,$16,$17,$18,$19,$20,$21::date,$22::timestamptz,
             $23,$24,$25::jsonb,$26::jsonb,$27::jsonb,$28::jsonb,$29::bigint,1)
     RETURNING id::text`,
    [input.sourceKind, input.sourceRef ?? null, scope, input.strategyCode, input.instrumentId, hash,
      input.triggerKind, input.signalStatus, eventStatus, input.validFrom, input.validUntil,
      risk.initial_stop, risk.signal_low, risk.signal_low_raw, risk.confirmation_must_exceed,
      risk.confirmation_price_cap, risk.invalidation, risk.risk_source,
      input.producerCode, input.producerVersion, input.dataAsOf ?? null, input.availableAt ?? null,
      input.inputFingerprint ?? null, input.ruleHash ?? null,
      JSON.stringify(input.item), JSON.stringify(input.evidenceRefs ?? []),
      JSON.stringify(input.gaps ?? []), JSON.stringify(input.missingSignals ?? []), input.runId],
  );
  return { id: inserted.rows[0]!.id, first: true, status: eventStatus, conditionHash: hash };
}

/** 追加状态转移：前后状态、原因、事实时间、执行者与幂等键；同一幂等键只记一次。 */
export async function appendEventTransition(
  db: Db,
  input: {
    eventId: string;
    fromStatus: SignalEventStatus | null;
    toStatus: SignalEventStatus;
    reason?: string | null;
    factAt: Date;
    actor?: string | null;
    runId?: string | null;
    idempotencyKey: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO strategy_signal_event_transition
       (event_id, from_status, to_status, reason, fact_at, actor, run_id, idempotency_key)
     VALUES ($1::bigint,$2,$3,$4,$5,$6,$7::bigint,$8)
     ON CONFLICT (event_id, idempotency_key) DO NOTHING`,
    [input.eventId, input.fromStatus, input.toStatus, input.reason ?? null, input.factAt,
      input.actor ?? null, input.runId ?? null, input.idempotencyKey],
  );
}

export interface CreateObservationPlanInput {
  eventId: string;
  revision?: number;
  sourceKind: SourceKind;
  sourceRef?: string | null;
  scope?: EventScope;
  strategyCode: string | null;
  producerCode: string;
  producerVersion: number;
  trigger: Record<string, unknown>;
  risk: Record<string, unknown>;
  observationPolicy?: Record<string, unknown>;
  evaluationPolicy?: Record<string, unknown> | null;
  priceLevels?: unknown[];
  /** 调用方声明是否具备明确触发窗口、触发规则与取消规则；缺项时强制降为草案。 */
  actionable: boolean;
  dataAsOf?: string | null;
  availableAt?: string | null;
}

export interface CreateObservationPlanResult {
  id: string;
  revision: number;
  lifecycleStatus: "draft" | "published";
  actionable: boolean;
  missing: string[];
}

/** 影子计划：execution_mode 固定 shadow；缺触发/风险项只能保存为草案且不可执行。 */
export async function createObservationPlan(
  db: Db,
  input: CreateObservationPlanInput,
): Promise<CreateObservationPlanResult> {
  const missing: string[] = [];
  if (!input.trigger || Object.keys(input.trigger).length === 0) missing.push("trigger");
  if (!input.risk || Object.keys(input.risk).length === 0) missing.push("risk");
  if (!input.trigger || Object.keys(input.trigger).length === 0) missing.push("cancel_rule");
  const actionable = input.actionable && missing.length === 0;
  const lifecycleStatus = actionable ? "published" : "draft";
  const revision = input.revision ?? 1;
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO observation_plan
       (event_id, revision, source_kind, source_ref, scope, strategy_code, lifecycle_status, actionable,
        producer_code, producer_version, trigger, risk, observation_policy, evaluation_policy,
        price_levels, data_as_of, available_at, generated_at)
     VALUES ($1::bigint,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,
             $15::jsonb,$16::date,$17::timestamptz,now())
     RETURNING id::text`,
    [input.eventId, revision, input.sourceKind, input.sourceRef ?? null, input.scope ?? "personal",
      input.strategyCode, lifecycleStatus, actionable, input.producerCode, input.producerVersion,
      JSON.stringify(input.trigger), JSON.stringify(input.risk),
      JSON.stringify(input.observationPolicy ?? {}),
      input.evaluationPolicy ? JSON.stringify(input.evaluationPolicy) : null,
      JSON.stringify(input.priceLevels ?? []),
      input.dataAsOf ?? null, input.availableAt ?? null],
  );
  const planId = inserted.rows[0]!.id;
  await db.query(
    `UPDATE strategy_signal_event SET plan_id=$2::bigint, current_revision=$3,
       status=CASE WHEN $4::boolean AND status='observing' THEN 'pending' ELSE status END,
       updated_at=now()
     WHERE id=$1::bigint`,
    [input.eventId, planId, revision, actionable],
  );
  return { id: planId, revision, lifecycleStatus, actionable, missing };
}

export interface UpsertOutcomeInput {
  eventId: string;
  planId?: string | null;
  planRevision?: number | null;
  signalId?: string | null;
  assessmentKind: "forward_diagnostic" | "execution_simulation";
  producerCode: string;
  producerVersion: number;
  sampleStart?: string | null;
  sampleEnd?: string | null;
  entryBasis?: Record<string, unknown>;
  tradability?: "tradable" | "untradable" | "unknown" | null;
  feeAssumption?: Record<string, unknown>;
  horizon?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  benchmarkCoverage?: Record<string, unknown>;
  status: "pending" | "unavailable" | "not_executable" | "not_configured" | "evaluated";
  notEvaluableReason?: string | null;
}

/** outcome 回填：同一事件/修订/口径/期限幂等；未成熟与不可成交不记 0 收益。 */
export async function upsertSignalOutcome(db: Db, input: UpsertOutcomeInput): Promise<{ id: string }> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO strategy_signal_outcome
       (event_id, plan_id, plan_revision, signal_id, assessment_kind, producer_code, producer_version,
        sample_start, sample_end, entry_basis, tradability, fee_assumption, horizon, result,
        benchmark_coverage, status, not_evaluable_reason)
     VALUES ($1::bigint,$2::bigint,$3,$4::bigint,$5,$6,$7,$8::date,$9::date,$10::jsonb,$11,$12::jsonb,
             $13::jsonb,$14::jsonb,$15::jsonb,$16,$17)
     ON CONFLICT (event_id, plan_revision, producer_code, producer_version, assessment_kind)
     DO UPDATE SET
       sample_start=COALESCE(EXCLUDED.sample_start, strategy_signal_outcome.sample_start),
       sample_end=COALESCE(EXCLUDED.sample_end, strategy_signal_outcome.sample_end),
       entry_basis=EXCLUDED.entry_basis, tradability=EXCLUDED.tradability,
       fee_assumption=EXCLUDED.fee_assumption, horizon=EXCLUDED.horizon, result=EXCLUDED.result,
       benchmark_coverage=EXCLUDED.benchmark_coverage, status=EXCLUDED.status,
       not_evaluable_reason=EXCLUDED.not_evaluable_reason, updated_at=now()
     RETURNING id::text`,
    [input.eventId, input.planId ?? null, input.planRevision ?? 0, input.signalId ?? null,
      input.assessmentKind, input.producerCode, input.producerVersion,
      input.sampleStart ?? null, input.sampleEnd ?? null,
      JSON.stringify(input.entryBasis ?? {}), input.tradability ?? null,
      JSON.stringify(input.feeAssumption ?? {}), JSON.stringify(input.horizon ?? {}),
      input.result ? JSON.stringify(input.result) : null,
      JSON.stringify(input.benchmarkCoverage ?? {}), input.status, input.notEvaluableReason ?? null],
  );
  return { id: result.rows[0]!.id };
}

export interface ShadowComparison {
  events: number;
  pending: number;
  observing: number;
  triggered: number;
  invalidated: number;
  expired: number;
  plans: number;
  actionable: number;
  drafts: number;
  outcomes: number;
}

/** 影子对照只读汇总：不写业务池、不产生通知。 */
export async function shadowComparison(db: Db): Promise<ShadowComparison> {
  const events = await db.query<ShadowComparison>(
    `SELECT count(*)::int AS events,
            count(*) FILTER (WHERE status='pending')::int AS pending,
            count(*) FILTER (WHERE status='observing')::int AS observing,
            count(*) FILTER (WHERE status='triggered')::int AS triggered,
            count(*) FILTER (WHERE status='invalidated')::int AS invalidated,
            count(*) FILTER (WHERE status='expired')::int AS expired,
            (SELECT count(*)::int FROM observation_plan) AS plans,
            (SELECT count(*)::int FROM observation_plan WHERE actionable) AS actionable,
            (SELECT count(*)::int FROM observation_plan WHERE lifecycle_status='draft') AS drafts,
            (SELECT count(*)::int FROM strategy_signal_outcome) AS outcomes
       FROM strategy_signal_event`,
  );
  return events.rows[0]!;
}
