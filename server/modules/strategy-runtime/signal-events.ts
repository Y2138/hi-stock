// 边界 1 服务层：把策略评估器产物归一成「独立信号事件 + 观察计划」，不再只取顶层 invalidation。
// 契约：specs/策略产物契约与影子接入/实施契约.md（PM 定稿）。
// 五态 observing/pending/triggered/invalidated/expired；连续命中只更新证据与 last_seen，不重置状态、首发、风险锚与窗口。
// 本文件只做影子写入：不写自选/关注、不产生通知，调用方需显式开启（见 shadowSignalEventsEnabled）。
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
  /** scope=account 时必填；personal/shared 保持 null，不按持仓反推。 */
  accountId?: string | null;
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
  /**
   * 复位证明：同来源同条件的上一事件已终结、且已观察到条件至少复位一次时传 true。
   * 缺省 false——终结后立刻再命中不算新机会，避免把持续存在当成重新触发。
   */
  resetVerified?: boolean;
}

type Db = Pick<pg.Pool, "query">;

/** 新链路默认关闭：旧生产落库路径不因应用 0195/0196 而自动写影子事件。 */
export function shadowSignalEventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HISTOCK_SHADOW_SIGNAL_EVENTS === "1";
}

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
  /** 上一事件已终结但缺少复位证明时不再新开，本次只更新证据不新建事件。 */
  suppressed?: "no_reset_proof";
}

/**
 * 写入或续存信号事件。
 * 身份与 0197 索引一致：source_kind + COALESCE(strategy_code, producer_code) + instrument_id
 *   + COALESCE(rule_hash, '') + scope + COALESCE(account_id, 0)，只对存续态生效。
 * 单条 INSERT ... ON CONFLICT DO UPDATE 完成，避免并发 SELECT 后 INSERT 撞唯一键。
 * 条件指纹变化只更新证据与指纹，不新开机会；规则版本变化才换事件身份。
 * 命中存续事件时 status / first_seen_at / first_emitted_at / valid_from 不重置，
 * valid_until 取更早者（不续窗口），已写入的风险锚不覆盖。
 */
export async function upsertSignalEvent(db: Db, input: UpsertSignalEventInput): Promise<UpsertResult> {
  const risk = riskObjectFromItem(input.item, input.sourceKind);
  const eventStatus = initialEventStatus(input.signalStatus);
  const scope = input.scope ?? "personal";
  const accountId = scope === "account" ? input.accountId ?? null : null;
  const hash = conditionHash(input.strategyCode, input.instrumentCode, input.triggerKind, input.item);
  const producer = input.strategyCode ?? input.producerCode;

  if (input.resetVerified !== true) {
    const closed = await db.query<{ id: string }>(
      `SELECT id::text FROM strategy_signal_event
        WHERE source_kind=$1 AND COALESCE(strategy_code, producer_code)=$2
          AND instrument_id=$3::bigint AND COALESCE(rule_hash, '')=COALESCE($4::text, '')
          AND scope=$5 AND COALESCE(account_id, 0)=COALESCE($6::bigint, 0)
          AND status IN ('invalidated', 'expired')
        ORDER BY closed_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [input.sourceKind, producer, input.instrumentId, input.ruleHash ?? null, scope, accountId],
    );
    if (closed.rows[0]) {
      return { id: closed.rows[0].id, first: false, status: "invalidated", conditionHash: hash, suppressed: "no_reset_proof" };
    }
  }

  const written = await db.query<{ id: string; inserted: boolean; status: SignalEventStatus }>(
    `INSERT INTO strategy_signal_event
       (source_kind, source_ref, scope, account_id, strategy_code, instrument_id, condition_hash, trigger_kind,
        signal_status, status, first_emitted_at, valid_from, valid_until,
        initial_stop, signal_low, signal_low_raw, confirmation_must_exceed, confirmation_price_cap,
        invalidation, risk_source, producer_code, producer_version, data_as_of, available_at,
        input_fingerprint, rule_hash, evidence, evidence_refs, gaps, missing_signals, run_id, current_revision)
     VALUES ($1,$2,$3,$4::bigint,$5,$6::bigint,$7,$8,
             $9,$10,now(),$11::date,$12::date,
             $13,$14,$15,$16,$17,$18,$19,$20,$21,$22::date,$23::timestamptz,
             $24,$25,$26::jsonb,$27::jsonb,$28::jsonb,$29::jsonb,$30::bigint,1)
     ON CONFLICT (source_kind, COALESCE(strategy_code, producer_code), instrument_id,
                  COALESCE(rule_hash, ''), scope, COALESCE(account_id, 0))
       WHERE status IN ('observing','pending','triggered')
     DO UPDATE SET
       last_seen_at=now(),
       condition_hash=EXCLUDED.condition_hash,
       trigger_kind=EXCLUDED.trigger_kind,
       signal_status=EXCLUDED.signal_status,
       valid_until=LEAST(strategy_signal_event.valid_until, EXCLUDED.valid_until),
       initial_stop=COALESCE(strategy_signal_event.initial_stop, EXCLUDED.initial_stop),
       signal_low=COALESCE(strategy_signal_event.signal_low, EXCLUDED.signal_low),
       signal_low_raw=COALESCE(strategy_signal_event.signal_low_raw, EXCLUDED.signal_low_raw),
       confirmation_must_exceed=COALESCE(strategy_signal_event.confirmation_must_exceed, EXCLUDED.confirmation_must_exceed),
       confirmation_price_cap=COALESCE(strategy_signal_event.confirmation_price_cap, EXCLUDED.confirmation_price_cap),
       invalidation=COALESCE(strategy_signal_event.invalidation, EXCLUDED.invalidation),
       risk_source=CASE WHEN strategy_signal_event.risk_source='none' THEN EXCLUDED.risk_source
                        ELSE strategy_signal_event.risk_source END,
       evidence=EXCLUDED.evidence,
       missing_signals=EXCLUDED.missing_signals,
       gaps=EXCLUDED.gaps,
       evidence_refs=EXCLUDED.evidence_refs,
       producer_version=EXCLUDED.producer_version,
       run_id=EXCLUDED.run_id,
       data_as_of=COALESCE(EXCLUDED.data_as_of, strategy_signal_event.data_as_of),
       available_at=COALESCE(EXCLUDED.available_at, strategy_signal_event.available_at),
       input_fingerprint=COALESCE(EXCLUDED.input_fingerprint, strategy_signal_event.input_fingerprint),
       updated_at=now()
     RETURNING id::text, (xmax = 0) AS inserted, status`,
    [input.sourceKind, input.sourceRef ?? null, scope, accountId, input.strategyCode, input.instrumentId, hash,
      input.triggerKind, input.signalStatus, eventStatus, input.validFrom, input.validUntil,
      risk.initial_stop, risk.signal_low, risk.signal_low_raw, risk.confirmation_must_exceed,
      risk.confirmation_price_cap, risk.invalidation, risk.risk_source,
      input.producerCode, input.producerVersion, input.dataAsOf ?? null, input.availableAt ?? null,
      input.inputFingerprint ?? null, input.ruleHash ?? null,
      JSON.stringify(input.item), JSON.stringify(input.evidenceRefs ?? []),
      JSON.stringify(input.gaps ?? []), JSON.stringify(input.missingSignals ?? []), input.runId],
  );
  const row = written.rows[0]!;
  return { id: row.id, first: row.inserted, status: row.status, conditionHash: hash };
}

/**
 * 追加状态转移并原子改事件状态：状态改写、triggered_at/closed_at 与转移日志同一条语句完成，
 * 且以 fromStatus 做乐观校验——状态已被别人推进时不覆盖，只返回 applied=false。
 * 幂等键重复时只保留一条转移记录。
 */
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
): Promise<{ applied: boolean; moved: number; logged: number }> {
  if (input.fromStatus === null) {
    const logged = await db.query<{ logged: number }>(
      `WITH logged AS (
         INSERT INTO strategy_signal_event_transition
           (event_id, from_status, to_status, reason, fact_at, actor, run_id, idempotency_key)
         SELECT $1::bigint, NULL, $2, $3, $4::timestamptz, $5, $6::bigint, $7
          WHERE EXISTS (SELECT 1 FROM strategy_signal_event WHERE id=$1::bigint)
         ON CONFLICT (event_id, idempotency_key) DO NOTHING
         RETURNING 1 AS one
       )
       SELECT count(*)::int AS logged FROM logged`,
      [input.eventId, input.toStatus, input.reason ?? null, input.factAt, input.actor ?? null,
        input.runId ?? null, input.idempotencyKey],
    );
    return { applied: (logged.rows[0]?.logged ?? 0) > 0, moved: 0, logged: logged.rows[0]?.logged ?? 0 };
  }

  const result = await db.query<{ moved: number; logged: number }>(
    `WITH moved AS (
       UPDATE strategy_signal_event SET
         status=$3,
         triggered_at=CASE WHEN $3='triggered' THEN COALESCE(triggered_at, $5::timestamptz) ELSE triggered_at END,
         closed_at=CASE WHEN $3 IN ('invalidated','expired') THEN COALESCE(closed_at, $5::timestamptz) ELSE closed_at END,
         updated_at=now()
       WHERE id=$1::bigint AND status=$2
       RETURNING id
     ), logged AS (
       INSERT INTO strategy_signal_event_transition
         (event_id, from_status, to_status, reason, fact_at, actor, run_id, idempotency_key)
       SELECT $1::bigint, $2, $3, $4, $5::timestamptz, $6, $7::bigint, $8 FROM moved
       ON CONFLICT (event_id, idempotency_key) DO NOTHING
       RETURNING 1 AS one
     )
     SELECT (SELECT count(*)::int FROM moved) AS moved, (SELECT count(*)::int FROM logged) AS logged`,
    [input.eventId, input.fromStatus, input.toStatus, input.reason ?? null, input.factAt,
      input.actor ?? null, input.runId ?? null, input.idempotencyKey],
  );
  const row = result.rows[0]!;
  return { applied: row.moved > 0, moved: row.moved, logged: row.logged };
}

export interface CreateObservationPlanInput {
  eventId: string;
  revision?: number;
  sourceKind: SourceKind;
  sourceRef?: string | null;
  scope?: EventScope;
  accountId?: string | null;
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
  /** 请求幂等键：同事件同键重试返回同一份计划，不新建修订。 */
  requestKey?: string | null;
}

export interface CreateObservationPlanResult {
  id: string;
  revision: number;
  lifecycleStatus: "draft" | "published";
  actionable: boolean;
  missing: string[];
}

/** 非空判定：空对象、空数组、空串都不算有值，避免 {} 冒充触发规则。 */
function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

/**
 * 计划完整性校验：actionable 必须同时具备
 * 触发规则、观察窗口、取消规则、真实风险价位、价格口径、判定方式与数据截止时间。
 * 只看对象非空不够——risk:{foo:1} 不能算有风险口径；
 * 追高上限与 T+1 突破价属于执行价格，顶替不了失效条件。
 */
export function missingPlanParts(input: Pick<
  CreateObservationPlanInput,
  "trigger" | "risk" | "observationPolicy" | "priceLevels" | "dataAsOf"
>): string[] {
  const trigger = record(input.trigger);
  const risk = record(input.risk);
  const policy = record(input.observationPolicy);
  const missing: string[] = [];

  const triggerRule = trigger.rule ?? trigger.condition ?? trigger.conditions ?? trigger.signal
    ?? trigger.price ?? trigger.price_range ?? trigger.threshold ?? trigger.must_exceed;
  if (!nonEmpty(triggerRule) && !nonEmpty(input.priceLevels)) missing.push("trigger_rule");

  const window = trigger.window ?? trigger.valid_until ?? trigger.validUntil ?? trigger.until
    ?? policy.window ?? policy.window_days ?? policy.max_wait_days ?? policy.expires_at;
  if (!nonEmpty(window)) missing.push("window");

  const cancelRule = trigger.cancel_rule ?? trigger.cancelRule ?? trigger.cancel
    ?? risk.invalidation ?? risk.initial_stop ?? risk.cancel_rule;
  if (!nonEmpty(cancelRule)) missing.push("cancel_rule");

  // 只有失效价、初始风险线与事件低点算风险价位；突破价和追高上限不算。
  const riskLevels = [risk.initial_stop, risk.signal_low, risk.signal_low_raw, risk.invalidation];
  if (!riskLevels.some((value) => positive(value) !== null)) missing.push("risk");

  const priceBasis = trigger.price_basis ?? trigger.priceBasis ?? risk.price_basis
    ?? (Array.isArray(input.priceLevels) ? record(input.priceLevels[0]).basis : null);
  if (!nonEmpty(priceBasis)) missing.push("price_basis");

  const comparison = trigger.comparison ?? trigger.kind ?? trigger.operator
    ?? risk.comparison ?? risk.kind;
  if (!nonEmpty(comparison)) missing.push("comparison");

  if (!nonEmpty(input.dataAsOf)) missing.push("as_of");

  return missing;
}

/** 修订号冲突：调用方指定的 revision 不是下一个可用修订时抛出，不做静默覆盖。 */
export class ObservationPlanRevisionConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservationPlanRevisionConflict";
  }
}

/**
 * 影子计划：execution_mode 固定 shadow；缺触发/风险项只能保存为草案且不可执行。
 * 插入计划与推进事件状态用同一语句完成；requestKey 相同直接复用，
 * 显式指定 revision 时必须等于下一个修订号，避免并发覆盖。
 */
export async function createObservationPlan(
  db: Db,
  input: CreateObservationPlanInput,
): Promise<CreateObservationPlanResult> {
  const missing = missingPlanParts(input);
  const actionable = input.actionable && missing.length === 0;
  const lifecycleStatus = actionable ? "published" : "draft";
  const revision = input.revision ?? null;
  const scope = input.scope ?? "personal";
  const accountId = scope === "account" ? input.accountId ?? null : null;

  if (input.requestKey) {
    const existing = await db.query<{ id: string; revision: number; lifecycle_status: string; actionable: boolean }>(
      `SELECT id::text, revision, lifecycle_status, actionable
         FROM observation_plan WHERE event_id=$1::bigint AND request_key=$2`,
      [input.eventId, input.requestKey],
    );
    if (existing.rows[0]) {
      return {
        id: existing.rows[0].id, revision: existing.rows[0].revision,
        lifecycleStatus: existing.rows[0].lifecycle_status as "draft" | "published",
        actionable: existing.rows[0].actionable, missing,
      };
    }
  }

  const inserted = await db.query<{ id: string; revision: number; lifecycle_status: string; actionable: boolean }>(
    `WITH next AS (
       SELECT COALESCE(MAX(revision), 0) + 1 AS revision
         FROM observation_plan WHERE event_id=$1::bigint
     ), allowed AS (
       SELECT revision FROM next
        WHERE $2::int IS NULL OR next.revision = $2::int
     ), inserted AS (
       INSERT INTO observation_plan
         (event_id, revision, source_kind, source_ref, scope, account_id, strategy_code, lifecycle_status,
          actionable, producer_code, producer_version, trigger, risk, observation_policy, evaluation_policy,
          price_levels, data_as_of, available_at, request_key, generated_at)
       SELECT $1::bigint, allowed.revision, $3, $4, $5, $6::bigint, $7, $8, $9, $10, $11,
              $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb,
              $17::date, $18::timestamptz, $19, now()
         FROM allowed
       ON CONFLICT (event_id, revision) DO NOTHING
       RETURNING id, revision, lifecycle_status, actionable
     ), touched AS (
       UPDATE strategy_signal_event event SET
         plan_id=inserted.id,
         current_revision=inserted.revision,
         status=CASE WHEN $9::boolean AND event.status='observing' THEN 'pending' ELSE event.status END,
         updated_at=now()
       FROM inserted
       WHERE event.id=$1::bigint
     )
     SELECT id::text, revision, lifecycle_status, actionable FROM inserted`,
    [input.eventId, revision, input.sourceKind, input.sourceRef ?? null, scope, accountId,
      input.strategyCode, lifecycleStatus, actionable, input.producerCode, input.producerVersion,
      JSON.stringify(input.trigger), JSON.stringify(input.risk),
      JSON.stringify(input.observationPolicy ?? {}),
      input.evaluationPolicy ? JSON.stringify(input.evaluationPolicy) : null,
      JSON.stringify(input.priceLevels ?? []),
      input.dataAsOf ?? null, input.availableAt ?? null, input.requestKey ?? null],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new ObservationPlanRevisionConflict(
      `计划修订冲突：事件 ${input.eventId} 的下一个修订号已不是 ${revision ?? "(自动)"}，未写入任何计划`,
    );
  }
  return {
    id: row.id, revision: row.revision,
    lifecycleStatus: row.lifecycle_status as "draft" | "published",
    actionable: row.actionable, missing,
  };
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
  /** 期限归一化键；缺省由 horizon 稳定序列化得到，1/3/5/10 日各自成行。 */
  horizonKey?: string | null;
  result?: Record<string, unknown> | null;
  benchmarkCoverage?: Record<string, unknown>;
  status: "pending" | "unavailable" | "not_executable" | "not_configured" | "evaluated";
  notEvaluableReason?: string | null;
}

/** outcome 回填：同一事件/修订/口径/期限幂等；未成熟与不可成交不记 0 收益。 */
export async function upsertSignalOutcome(db: Db, input: UpsertOutcomeInput): Promise<{ id: string }> {
  const horizonKey = input.horizonKey ?? JSON.stringify(stableValue(input.horizon ?? {}));
  const result = await db.query<{ id: string }>(
    `INSERT INTO strategy_signal_outcome
       (event_id, plan_id, plan_revision, signal_id, assessment_kind, producer_code, producer_version,
        sample_start, sample_end, entry_basis, tradability, fee_assumption, horizon, horizon_key, result,
        benchmark_coverage, status, not_evaluable_reason)
     VALUES ($1::bigint,$2::bigint,$3,$4::bigint,$5,$6,$7,$8::date,$9::date,$10::jsonb,$11,$12::jsonb,
             $13::jsonb,$14,$15::jsonb,$16::jsonb,$17,$18)
     ON CONFLICT (event_id, plan_revision, producer_code, producer_version, assessment_kind, horizon_key)
     DO UPDATE SET
       sample_start=COALESCE(EXCLUDED.sample_start, strategy_signal_outcome.sample_start),
       sample_end=COALESCE(EXCLUDED.sample_end, strategy_signal_outcome.sample_end),
       entry_basis=EXCLUDED.entry_basis, tradability=EXCLUDED.tradability,
       fee_assumption=EXCLUDED.fee_assumption, horizon=EXCLUDED.horizon, horizon_key=EXCLUDED.horizon_key,
       result=EXCLUDED.result, benchmark_coverage=EXCLUDED.benchmark_coverage, status=EXCLUDED.status,
       not_evaluable_reason=EXCLUDED.not_evaluable_reason, updated_at=now()
     RETURNING id::text`,
    [input.eventId, input.planId ?? null, input.planRevision ?? 0, input.signalId ?? null,
      input.assessmentKind, input.producerCode, input.producerVersion,
      input.sampleStart ?? null, input.sampleEnd ?? null,
      JSON.stringify(input.entryBasis ?? {}), input.tradability ?? null,
      JSON.stringify(input.feeAssumption ?? {}), JSON.stringify(input.horizon ?? {}), horizonKey,
      input.result ? JSON.stringify(input.result) : null,
      JSON.stringify(input.benchmarkCoverage ?? {}), input.status, input.notEvaluableReason ?? null],
  );
  return { id: result.rows[0]!.id };
}

export interface ShadowOutcomeInput {
  eventId: string;
  planId?: string | null;
  planRevision?: number | null;
  /** 固定前瞻期限（交易日数）。 */
  horizons: number[];
  /** 起算口径：next_open=下一交易日开盘；signal_close=信号日收盘。 */
  entryBasis?: "next_open" | "signal_close";
  /** 往返总费用（买入+卖出，含滑点），单位 bp；必须显式给出，不为 0 才不扣费。 */
  roundTripFeeBps?: number;
  /** 行情价格口径；缺省从计划 trigger.price_basis 读取，不一致记缺数而不是混用。 */
  priceBasis?: string | null;
  producerCode: string;
  producerVersion: number;
}

export interface ShadowOutcomeRow {
  horizon: number;
  status: "pending" | "unavailable" | "evaluated";
  entryPrice: number | null;
  exitPrice: number | null;
  returnPct: number | null;
  reason: string | null;
}

/**
 * 影子结果计算：按事件、交易日历、日线行情、起算口径、价基与往返费用算固定前瞻收益。
 *
 * 口径：
 * - 起点取 max(valid_from, 实际可得日)：历史补跑不会吃到信号生成之前的涨幅。
 * - 期限按交易日历数交易日；目标交易日已到但缺行情记 unavailable，日历还没覆盖记 pending，
 *   都不顺延成更晚的交易日。
 * - next_open：下一交易日开盘起算，第 N 个交易日收盘结束（N=1 即次日开→次日收）。
 * - signal_close：信号日收盘起算，第 N 个交易日收盘结束。
 * - 需要价基时比对 market_bar.adjustment，口径不符记 unavailable。
 * - 固定前瞻诊断不假设能成交，tradability 一律 unknown。
 */
export async function evaluateShadowOutcome(
  db: Db,
  input: ShadowOutcomeInput,
): Promise<{ rows: ShadowOutcomeRow[] }> {
  const event = await db.query<{
    instrument_id: string;
    valid_from: string;
    start_from: string;
    plan_id: string | null;
    today: string;
  }>(
    `SELECT instrument_id::text, valid_from::text,
            GREATEST(valid_from, (COALESCE(available_at, created_at) AT TIME ZONE 'Asia/Shanghai')::date)::text AS start_from,
            plan_id::text,
            (CURRENT_DATE)::text AS today
       FROM strategy_signal_event WHERE id=$1::bigint`,
    [input.eventId],
  );
  const subject = event.rows[0];
  if (!subject) throw new Error(`信号事件不存在: ${input.eventId}`);

  const planId = input.planId ?? subject.plan_id;
  let priceBasis = input.priceBasis ?? null;
  if (!priceBasis && planId) {
    const plan = await db.query<{ trigger: Record<string, unknown> }>(
      "SELECT trigger FROM observation_plan WHERE id=$1::bigint", [planId],
    );
    priceBasis = (plan.rows[0]?.trigger?.price_basis as string | undefined) ?? null;
  }

  const entryBasis = input.entryBasis ?? "next_open";
  const feeBps = input.roundTripFeeBps ?? 0;

  // 交易日历：起点之后已开市的交易日，按时间顺序。
  const tradingDays = (await db.query<{ trade_date: string }>(
    `SELECT trade_date::text FROM market_trading_day
      WHERE is_open AND trade_date > $1::date
      ORDER BY trade_date`,
    [subject.start_from],
  )).rows.map((row) => row.trade_date);
  // 行情：只取同一价格口径的日线，口径不符不混用。
  const bars = await db.query<{ bar_date: string; open: string; close: string; adjustment: string | null }>(
    `SELECT bar_date::text, open::text, close::text, adjustment
       FROM market_bar
      WHERE instrument_id=$1::bigint AND freq='day' AND bar_date > $2::date
        AND ($3::text IS NULL OR adjustment = $3::text)`,
    [subject.instrument_id, subject.start_from, priceBasis],
  );
  const barByDate = new Map(bars.rows.map((bar) => [bar.bar_date, bar]));
  const signalBar = entryBasis === "signal_close"
    ? (await db.query<{ close: string; adjustment: string | null }>(
      `SELECT close::text, adjustment FROM market_bar
        WHERE instrument_id=$1::bigint AND freq='day' AND bar_date=$2::date
          AND ($3::text IS NULL OR adjustment = $3::text)`,
      [subject.instrument_id, subject.valid_from, priceBasis],
    )).rows[0]
    : undefined;

  const rows: ShadowOutcomeRow[] = [];
  for (const horizon of input.horizons) {
    let status: ShadowOutcomeRow["status"] = "pending";
    let entryPrice: number | null = null;
    let exitPrice: number | null = null;
    let returnPct: number | null = null;
    let reason: string | null = null;
    let sampleStart: string | null = null;
    let sampleEnd: string | null = null;

    // 第 horizon 个交易日；目标日还没到（或日历未覆盖）记未成熟。
    const targetDay = tradingDays[horizon - 1];
    const entryDay = tradingDays[0];
    if (!targetDay || targetDay > subject.today) {
      status = "pending";
      reason = `第 ${horizon} 个交易日尚未走完`;
    } else if (entryBasis === "signal_close") {
      if (!signalBar) {
        status = "unavailable";
        reason = priceBasis ? `信号日缺少「${priceBasis}」口径的日线` : "信号日缺少日线";
      } else {
        entryPrice = Number(signalBar.close);
        sampleStart = subject.valid_from;
      }
    } else if (!entryDay) {
      status = "pending";
      reason = "下一交易日尚未出现";
    } else {
      const entryBar = barByDate.get(entryDay);
      if (!entryBar) {
        status = "unavailable";
        reason = "下一交易日缺少行情";
      } else {
        entryPrice = Number(entryBar.open);
        sampleStart = entryDay;
      }
    }

    if (!entryPrice || entryPrice <= 0) {
      if (!reason) reason = "缺少起算价";
      if (status !== "pending") status = "unavailable";
    } else {
      const exitBar = barByDate.get(targetDay!);
      if (!exitBar) {
        status = "unavailable";
        reason = `第 ${horizon} 个交易日（${targetDay}）缺少行情`;
      } else {
        exitPrice = Number(exitBar.close);
        sampleEnd = targetDay!;
        returnPct = Number((((exitPrice / entryPrice) - 1) * 100 - feeBps / 100).toFixed(4));
        status = "evaluated";
        reason = null;
      }
    }

    await upsertSignalOutcome(db, {
      eventId: input.eventId,
      planId: planId ?? null,
      planRevision: input.planRevision ?? null,
      assessmentKind: "forward_diagnostic",
      producerCode: input.producerCode,
      producerVersion: input.producerVersion,
      sampleStart,
      sampleEnd,
      entryBasis: { kind: entryBasis, price_basis: priceBasis },
      // 固定前瞻诊断没有成交约束证据，可成交性一律未知。
      tradability: "unknown",
      feeAssumption: { kind: "round_trip", bps: feeBps },
      horizon: { days: horizon },
      result: status === "evaluated"
        ? { return_pct: returnPct, entry_price: entryPrice, exit_price: exitPrice, price_basis: priceBasis }
        : null,
      benchmarkCoverage: {},
      status,
      notEvaluableReason: status === "evaluated" ? null : reason,
    });
    rows.push({ horizon, status, entryPrice, exitPrice, returnPct, reason });
  }
  return { rows };
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
