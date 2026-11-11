import crypto from "node:crypto";
import { shortlistEntryResult } from "../selection/service.js";
import { attentionValidUntil, strategyAttentionCodes } from "../pools/attention-lifecycle.js";
import type pg from "pg";
import { inServiceTransaction } from "../../db/transaction.js";
import { apiErrors } from "../../http/router.js";
import { executeStrategyEvaluator, getStrategyEvaluatorDefinition } from "./registry.js";
import { shadowSignalEventsEnabled, upsertSignalEvent } from "./signal-events.js";
import type {
  StrategyEvaluationPhase,
  StrategyEvaluationRunSummary,
  StrategyEvaluationStatus,
  StrategyPositionEvaluation,
} from "./types.js";

type Db = pg.Pool;
type JsonRecord = Record<string, unknown>;

interface RuntimeBinding {
  code: string;
  runtime_version: number;
  document_id: string;
  document_sha256: string;
  strategy_snapshot_hash: string;
  evaluator_code: string;
  evaluator_version: number;
}

export interface EnsureStrategyEvaluationInput {
  account_id?: string | null;
  strategy_code: string;
  phase: StrategyEvaluationPhase;
  target_date: string;
  requested_by_job_run_id?: string | null;
}

export interface EnsureStrategyEvaluationResult {
  execution: "executed" | "reused" | "waiting";
  run: StrategyEvaluationRunSummary;
  result: unknown | null;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value ?? null))).digest("hex");
}

function evaluatorField(phase: StrategyEvaluationPhase): "entry_evaluator_code" | "exit_evaluator_code" | "context_evaluator_code" {
  return phase === "entry" ? "entry_evaluator_code" : phase === "exit" ? "exit_evaluator_code" : "context_evaluator_code";
}

async function loadBinding(db: Db, input: EnsureStrategyEvaluationInput): Promise<RuntimeBinding> {
  const field = evaluatorField(input.phase);
  const result = await db.query<{
    code: string;
    runtime_version: number;
    document_id: string;
    document_sha256: string;
    strategy_snapshot_hash: string | null;
    evaluator_code: string | null;
  }>(`SELECT definition.code, definition.runtime_version, document.id::text AS document_id,
            document.sha256 AS document_sha256, state.current_hash AS strategy_snapshot_hash,
            definition.${field} AS evaluator_code
       FROM strategy_definition definition
       JOIN strategy_document document ON document.code=definition.strategy_document_code
       LEFT JOIN strategy_state state ON state.singleton=1
      WHERE definition.code=$1 AND definition.status IN ('active','exit_only')`, [input.strategy_code]);
  const row = result.rows[0];
  if (!row) throw apiErrors.notFound(`策略运行时不存在：${input.strategy_code}`);
  if (!row.evaluator_code) throw apiErrors.badRequest(`策略 ${input.strategy_code} 未配置 ${input.phase} 评估器`);
  const evaluator = getStrategyEvaluatorDefinition(row.evaluator_code);
  if (evaluator.phase !== input.phase) throw apiErrors.conflict(`策略 ${input.strategy_code} 的评估器阶段不匹配`);
  if (evaluator.status !== "ready") throw apiErrors.conflict(`策略评估器尚未就绪：${row.evaluator_code}`);
  let strategySnapshotHash = row.strategy_snapshot_hash;
  if (!strategySnapshotHash) {
    const documents = await db.query<{ code: string; sha256: string }>(
      "SELECT code,sha256 FROM strategy_document ORDER BY injection_order,id",
    );
    strategySnapshotHash = sha256(documents.rows.map((document) => `${document.code}:${document.sha256}`).join("\n"));
  }
  return { ...row, evaluator_code: row.evaluator_code, evaluator_version: evaluator.version,
    strategy_snapshot_hash: strategySnapshotHash };
}

async function inputFacts(db: Db, input: EnsureStrategyEvaluationInput, binding: RuntimeBinding): Promise<JsonRecord> {
  const [market, positions, pool, ranks] = await Promise.all([
    db.query(`SELECT
      (SELECT count(*)::int FROM market_bar WHERE bar_date <= $1::date) AS bar_count,
      (SELECT max(fetched_at)::text FROM market_bar WHERE bar_date <= $1::date) AS bar_fetched_at,
      (SELECT max(bar_date)::text FROM market_bar WHERE bar_date <= $1::date) AS bar_date,
      (SELECT count(*)::int FROM market_indicator_value WHERE bar_date <= $1::date) AS indicator_count,
      (SELECT max(computed_at)::text FROM market_indicator_value WHERE bar_date <= $1::date) AS indicator_computed_at,
      (SELECT max(finished_at)::text FROM market_special_sync_run WHERE target_date <= $1::date) AS special_finished_at,
      (SELECT max(captured_at)::text FROM market_news_snapshot WHERE target_date <= $1::date
        AND captured_at <= LEAST(now(),$1::date + interval '1 day')) AS news_captured_at,
      (SELECT count(*)::int FROM market_factor_observation WHERE published_at < $1::date + interval '1 day') AS factor_count,
      (SELECT max(fetched_at)::text FROM market_factor_observation WHERE published_at < $1::date + interval '1 day') AS factor_fetched_at,
      (SELECT max(created_at)::text FROM fundamental_snapshot WHERE as_of_date <= $1::date) AS fundamental_created_at,
      (SELECT max(created_at)::text FROM valuation_snapshot WHERE as_of_date <= $1::date) AS valuation_created_at,
      (SELECT max(fetched_at)::text FROM market_corporate_action WHERE ex_date <= $1::date) AS action_fetched_at,
      (SELECT max(computed_at)::text FROM market_stock_character_metric WHERE as_of_date <= $1::date) AS character_computed_at,
      (SELECT count(*)::int FROM market_board_membership WHERE effective_from <= $1::date
        AND (effective_to IS NULL OR effective_to >= $1::date)) AS board_membership_count,
      (SELECT max(effective_from)::text FROM market_board_membership WHERE effective_from <= $1::date) AS board_membership_effective_from,
      (SELECT max(last_checked_at)::text FROM market_corporate_action_sync_state) AS action_sync_checked_at`,
    [input.target_date]),
    input.phase === "exit"
      ? db.query(`SELECT instrument.code, position.quantity::text, position.cost_price::text,
                         position.opened_at::text, position.strategy_code, position.strategy_runtime_version,
                         position.fallback_strategy_code, position.exit_policy_mode, position.updated_at::text
                    FROM portfolio_position position JOIN market_instrument instrument ON instrument.id=position.instrument_id
                   WHERE position.account_id=$2 AND position.quantity>0 AND (position.strategy_code=$1 OR position.fallback_strategy_code=$1)
                   ORDER BY instrument.code`, [input.strategy_code, input.account_id ?? "1"])
      : Promise.resolve({ rows: [] }),
    input.phase === "entry"
      ? db.query(`SELECT instrument.code, membership.effective_from::text, membership.effective_to::text,
                         membership.profile_input_sha256
                    FROM pool_membership membership JOIN market_instrument instrument ON instrument.id=membership.instrument_id
                   WHERE membership.pool='watch' AND membership.effective_to IS NULL ORDER BY instrument.code`)
      : Promise.resolve({ rows: [] }),
    db.query(`SELECT count(*)::int AS count, max(created_at)::text AS created_at
                FROM value_rank_snapshot WHERE rank_date <= $1::date`, [input.target_date]),
  ]);
  return {
    account_id: input.phase === "entry" ? null : input.account_id ?? "1",
    strategy_code: binding.code,
    runtime_version: binding.runtime_version,
    document_sha256: binding.document_sha256,
    strategy_snapshot_hash: binding.strategy_snapshot_hash,
    evaluator_code: binding.evaluator_code,
    evaluator_version: binding.evaluator_version,
    phase: input.phase,
    target_date: input.target_date,
    market: market.rows[0] ?? {},
    positions: positions.rows,
    pool: pool.rows,
    attention_review_codes: input.phase === "entry" ? await strategyAttentionCodes(db, input.strategy_code) : [],
    value_rank: ranks.rows[0] ?? {},
  };
}

function normalizedStatus(result: unknown): StrategyEvaluationStatus {
  const status = String(record(result).status ?? "success");
  return ["success", "ready"].includes(status) ? "success" : "partial";
}

function dataDate(result: unknown, targetDate: string): string | null {
  const value = record(result).data_date ?? record(result).date ?? record(result).as_of ?? targetDate;
  return typeof value === "string" ? value : null;
}

function gapsOf(result: unknown): unknown[] {
  const gaps = record(result).gaps;
  return Array.isArray(gaps) ? gaps : [];
}

function coverageOf(result: unknown): JsonRecord {
  const value = record(result);
  if (value.coverage && typeof value.coverage === "object" && !Array.isArray(value.coverage)) return value.coverage as JsonRecord;
  if (value.data_summary && typeof value.data_summary === "object" && !Array.isArray(value.data_summary)) return value.data_summary as JsonRecord;
  return Object.fromEntries(Object.entries(value).filter(([key, child]) =>
    /(?:count|total|completed)$/.test(key) && typeof child === "number"));
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter((item) => typeof item.code === "string") : [];
}

function entryItems(strategyCode: string, result: unknown): Array<{ item: JsonRecord; status: "qualified" | "approaching" }> {
  const value = record(result);
  if (["swing", "copper_left_launch"].includes(strategyCode)) return [
    ...records(value.signals).map((item) => ({ item, status: "qualified" as const })),
    ...records(value.near_candidates).map((item) => ({ item, status: "approaching" as const })),
  ];
  if (["two_year_reversal", "value_anchor"].includes(strategyCode)) return [
    ...records(value.qualified).map((item) => ({ item, status: "qualified" as const })),
    ...records(value.near).map((item) => ({ item, status: "approaching" as const })),
  ];
  if (["limit_up", "first_board_advance"].includes(strategyCode)) return records(value.signals)
    .map((item) => ({ item, status: "qualified" as const }));
  return [];
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function decimal(value: unknown, digits = 2): string | null {
  const number = finiteNumber(value);
  return number === null ? null : number.toFixed(digits);
}

function percent(value: unknown, digits = 1): string | null {
  const number = finiteNumber(value);
  return number === null ? null : `${(number * 100).toFixed(digits)}%`;
}

/** 关注池缺口统一带当前值和目标值；无法识别的新条件保留评估器原文。 */
export function describeEntryMissingSignals(
  strategyCode: string,
  item: JsonRecord,
  status: "qualified" | "approaching",
): string[] {
  if (status === "qualified") return [];
  let raw: string[] = [];
  for (const key of ["failed_conditions", "missing_conditions", "missing_signals"]) {
    const values = item[key] ?? record(item.evidence)[key];
    if (Array.isArray(values)) {
      raw = values.map(String).filter(Boolean);
      if (raw.length) break;
    }
  }
  if (!raw.length) return ["尚未满足全部策略条件（当前值和目标值待评估器补充）"];
  const evidence = record(item.evidence);
  return raw.map((condition) => {
    if (strategyCode === "swing") {
      if (condition === "volume_contracted") {
        const current = decimal(evidence.volume_ratio_5, 3);
        if (current) return `5日量比：当前 ${current}，目标 < 0.700，或 MA250 偏离 ≤ -35.0% 豁免`;
      }
      if (condition === "rsi_oversold") {
        const current = decimal(evidence.rsi14);
        if (current) return `RSI14：当前 ${current}，目标 < 30.00`;
      }
      if (condition === "reward_risk_acceptable") {
        const current = decimal(evidence.expected_reward_risk);
        if (current) return `预期盈亏比：当前 ${current}，目标 ≥ 1.80`;
      }
      if (condition === "reversal_candle") {
        const open = decimal(evidence.open);
        const close = decimal(evidence.close);
        const shadow = percent(evidence.lower_shadow_ratio, 2);
        if (open && close && shadow) return `反转形态：当前开盘/收盘 ${open}/${close}、下影线 ${shadow}，目标 收盘>开盘或下影线>0.50%`;
      }
    }
    if (strategyCode === "two_year_reversal") {
      if (condition.includes("个股5日跌幅")) {
        const current = percent(item.stock_return_5);
        if (current) return `个股5日收益：当前 ${current}，目标 ≤ -8.0%`;
      }
      if (condition.includes("相对行业5日额外落后")) {
        const current = percent(item.relative_return_5);
        if (current) return `相对行业5日收益：当前 ${current}，目标 ≤ -5.0%`;
      }
    }
    if (strategyCode === "copper_left_launch") {
      if (condition === "low_within_30_days") {
        const current = decimal(evidence.low_age, 0);
        if (current) return `近60日低点距今：当前 ${current} 个交易日，目标 ≤ 30 个交易日`;
      }
      if (condition === "rebound_8_to_15") {
        const current = percent(evidence.rebound_60);
        if (current) return `较近60日低点反弹：当前 ${current}，目标 8.0%–15.0%`;
      }
      if (condition === "drawdown_15_to_40") {
        const current = percent(evidence.drawdown_252);
        if (current) return `较近252日高点回撤：当前 ${current}，目标 -40.0%–-15.0%`;
      }
      if (condition === "macro_two_of_three") {
        const current = decimal(record(evidence.macro).ok_count, 0);
        if (current) return `宏观满足项：当前 ${current}/3，目标 ≥ 2/3`;
      }
    }
    if (strategyCode === "value_anchor") {
      if (condition === "below_ma250") {
        const current = percent(item.ma250_deviation);
        if (current) return `相对MA250偏离：当前 ${current}，目标 ≤ -10.0%`;
      }
      if (condition === "drawdown20") {
        const current = percent(item.drawdown_20);
        if (current) return `20日回撤：当前 ${current}，目标 > -30.0% 且 ≤ -10.0%`;
      }
      if (condition === "decline5") {
        const current = percent(item.return_5);
        if (current) return `5日收益：当前 ${current}，目标 ≤ -4.0%`;
      }
    }
    return condition;
  });
}

async function persistEntrySignals(
  client: pg.PoolClient,
  runId: string,
  strategyCode: string,
  targetDate: string,
  result: unknown,
  evaluatorCode: string,
  evaluatorVersion: number,
): Promise<void> {
  const items = entryItems(strategyCode, result);
  if (!items.length) return;
  const validUntil = await attentionValidUntil(client, targetDate);
  const codes = [...new Set(items.map(({ item }) => String(item.code).toUpperCase()))];
  const instruments = await client.query<{ id: string; code: string }>(
    "SELECT id::text,code FROM market_instrument WHERE code=ANY($1::text[])", [codes],
  );
  const ids = new Map(instruments.rows.map((row) => [row.code, row.id]));
  for (const { item, status } of items) {
    const code = String(item.code).toUpperCase();
    const instrumentId = ids.get(code);
    if (!instrumentId) continue;
    const evidence = record(item.evidence);
    const lower = evidence.confirmation_must_exceed ?? item.trigger_price_lower ?? null;
    const upper = evidence.confirmation_price_cap ?? item.trigger_price_upper ?? null;
    const triggerKind = lower != null || upper != null ? "price_range" : "condition";
    const missing = describeEntryMissingSignals(strategyCode, item, status);
    await client.query(
      `INSERT INTO strategy_entry_signal
         (run_id,strategy_code,instrument_id,signal_status,trigger_kind,trigger_price_lower,
          trigger_price_upper,invalidation,reason,evidence,missing_signals,valid_from,valid_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13)`,
      [runId, strategyCode, instrumentId, status, triggerKind,
       lower, upper, item.invalidation ?? null,
       `${strategyCode} ${status === "qualified" ? "正式信号" : "接近候选"}`,
       JSON.stringify(item), JSON.stringify(missing), targetDate, validUntil],
    );
    // 影子事件映射：仅在显式开启时写入，默认不写——旧链路继续是唯一业务写入方。
    // 风险对象映射回事件：initial_stop / signal_low / T+1 突破价 / 追高上限不再只依赖顶层 invalidation。
    if (shadowSignalEventsEnabled()) {
      await upsertSignalEvent(client, {
        strategyCode,
        sourceKind: "strategy",
        instrumentId,
        instrumentCode: code,
        triggerKind,
        signalStatus: status,
        validFrom: targetDate,
        validUntil,
        item,
        missingSignals: missing,
        producerCode: evaluatorCode,
        producerVersion: evaluatorVersion,
        runId,
        dataAsOf: targetDate,
      });
    }
  }
}

async function persistPositionEvaluations(
  client: pg.PoolClient,
  runId: string,
  strategyCode: string,
  result: unknown,
): Promise<void> {
  const items = record(result).items;
  if (!Array.isArray(items) || !items.length) return;
  const normalized = items as StrategyPositionEvaluation[];
  const codes = [...new Set(normalized.map((item) => item.code))];
  const instruments = await client.query<{ id: string; code: string; opened_at: string | null }>(
    `SELECT instrument.id::text,instrument.code,position.opened_at::text
       FROM market_instrument instrument LEFT JOIN portfolio_position position ON position.instrument_id=instrument.id
        AND position.account_id=(SELECT account_id FROM strategy_evaluation_run WHERE id=$2)
      WHERE instrument.code=ANY($1::text[])`, [codes,runId],
  );
  const byCode = new Map(instruments.rows.map((row) => [row.code, row]));
  for (const item of normalized) {
    const instrument = byCode.get(item.code);
    if (!instrument) continue;
    await client.query(
      `INSERT INTO strategy_position_evaluation
         (run_id,strategy_code,instrument_id,position_opened_at,evaluation_role,action,trigger_kind,
          trigger_price_lower,trigger_price_upper,protection_price,reason,evidence,missing_items)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)`,
      [runId, strategyCode, instrument.id, instrument.opened_at, item.evaluation_role, item.action,
       item.trigger_kind, item.trigger_price_lower, item.trigger_price_upper, item.protection_price,
       item.reason, JSON.stringify(item.evidence), JSON.stringify(item.missing_items)],
    );
  }
}

function toRun(row: JsonRecord): StrategyEvaluationRunSummary {
  return {
    id: String(row.id), strategy_code: String(row.strategy_code), phase: row.phase as StrategyEvaluationPhase,
    target_date: String(row.target_date), data_date: row.data_date === null ? null : String(row.data_date),
    evaluator_code: String(row.evaluator_code), evaluator_version: Number(row.evaluator_version),
    strategy_runtime_version: Number(row.strategy_runtime_version), strategy_snapshot_hash: String(row.strategy_snapshot_hash),
    input_fingerprint: String(row.input_fingerprint), status: row.status as StrategyEvaluationStatus,
    requested_by_job_run_id: row.requested_by_job_run_id === null ? null : String(row.requested_by_job_run_id),
    reused_from_run_id: row.reused_from_run_id === null ? null : String(row.reused_from_run_id),
    coverage: record(row.coverage), gaps: Array.isArray(row.gaps) ? row.gaps : [],
    started_at: row.started_at === null ? null : String(row.started_at),
    finished_at: row.finished_at === null ? null : String(row.finished_at), created_at: String(row.created_at),
    result: row.result ?? null, attempt_count: Number(row.attempt_count), last_requested_at: String(row.last_requested_at),
  };
}

const RUN_RETURNING = `id::text,strategy_code,phase,target_date::text,data_date::text,evaluator_code,evaluator_version,
  strategy_runtime_version,strategy_snapshot_hash,input_fingerprint,status,requested_by_job_run_id::text,
  reused_from_run_id::text,coverage,gaps,started_at::text,finished_at::text,created_at::text,
  result,attempt_count,last_requested_at::text`;

export async function ensureStrategyEvaluation(
  db: Db,
  input: EnsureStrategyEvaluationInput,
): Promise<EnsureStrategyEvaluationResult> {
  if (input.requested_by_job_run_id) {
    const source=(await db.query<{account_id:string|null}>("SELECT account_id::text FROM job_run WHERE id=$1",[input.requested_by_job_run_id])).rows[0];
    if (source?.account_id && input.phase === "entry") throw apiErrors.badRequest("账户任务不能执行全局入场扫描");
    if (source?.account_id && source.account_id !== (input.account_id ?? "1")) throw apiErrors.badRequest("评估账户与任务账户不一致");
  }
  const binding = await loadBinding(db, input);
  const fingerprint = sha256(await inputFacts(db, input, binding));
  const claim = await inServiceTransaction(db, async (client) => {
    const inserted = await client.query<JsonRecord>(
      `INSERT INTO strategy_evaluation_run
         (account_id,strategy_code,phase,target_date,evaluator_code,evaluator_version,strategy_runtime_version,
          strategy_snapshot_hash,input_fingerprint,status,requested_by_job_run_id,started_at,last_requested_at)
       VALUES ($10,$1,$2,$3,$4,$5,$6,$7,$8,'running',$9,now(),now())
       ON CONFLICT DO NOTHING RETURNING ${RUN_RETURNING}`,
      [binding.code, input.phase, input.target_date, binding.evaluator_code, binding.evaluator_version,
       binding.runtime_version, binding.strategy_snapshot_hash, fingerprint, input.requested_by_job_run_id ?? null, input.phase === "entry" ? null : input.account_id ?? "1"],
    );
    if (inserted.rows[0]) return { mode: "execute" as const, row: inserted.rows[0] };
    const existing = await client.query<JsonRecord>(
      `SELECT ${RUN_RETURNING} FROM strategy_evaluation_run
        WHERE strategy_code=$1 AND phase=$2 AND target_date=$3 AND evaluator_code=$4
          AND evaluator_version=$5 AND input_fingerprint=$6 AND account_id IS NOT DISTINCT FROM $7::bigint FOR UPDATE`,
      [binding.code, input.phase, input.target_date, binding.evaluator_code, binding.evaluator_version, fingerprint,input.phase === "entry" ? null : input.account_id ?? "1"],
    );
    const row = existing.rows[0]!;
    if (row.status === "success") {
      const reused = await client.query<JsonRecord>(
        `UPDATE strategy_evaluation_run SET last_requested_at=now() WHERE id=$1 RETURNING ${RUN_RETURNING}`, [row.id],
      );
      return { mode: "reuse" as const, row: reused.rows[0]! };
    }
    if (row.status === "running") {
      const startedAt = row.started_at ? new Date(String(row.started_at)).getTime() : Date.now();
      if (Date.now() - startedAt < 30 * 60_000) {
        const waiting = await client.query<JsonRecord>(
          `UPDATE strategy_evaluation_run SET last_requested_at=now() WHERE id=$1 RETURNING ${RUN_RETURNING}`, [row.id],
        );
        return { mode: "wait" as const, row: waiting.rows[0]! };
      }
    }
    await client.query("DELETE FROM strategy_entry_signal WHERE run_id=$1", [row.id]);
    await client.query("DELETE FROM strategy_position_evaluation WHERE run_id=$1", [row.id]);
    const retried = await client.query<JsonRecord>(
      `UPDATE strategy_evaluation_run SET status='running',data_date=NULL,result=NULL,coverage='{}'::jsonb,gaps='[]'::jsonb,
              requested_by_job_run_id=COALESCE($2,requested_by_job_run_id),started_at=now(),finished_at=NULL,
              attempt_count=attempt_count+1,last_requested_at=now()
        WHERE id=$1 RETURNING ${RUN_RETURNING}`,
      [row.id, input.requested_by_job_run_id ?? null],
    );
    return { mode: "execute" as const, row: retried.rows[0]! };
  });
  if (claim.mode === "reuse") return { execution: "reused", run: toRun(claim.row), result: claim.row.result ?? null };
  if (claim.mode === "wait") return { execution: "waiting", run: toRun(claim.row), result: null };
  const runId = String(claim.row.id);
  try {
    const raw = await executeStrategyEvaluator(binding.evaluator_code, {
      pool: db, targetDate: input.target_date, strategyDocumentId: binding.document_id, accountId: input.phase === "entry" ? null : input.account_id ?? "1",
    });
    const result = input.phase === "entry" ? await shortlistEntryResult(db, binding.code, input.target_date, raw) : raw;
    const status = normalizedStatus(result);
    const persisted = await inServiceTransaction(db, async (client) => {
      await client.query("DELETE FROM strategy_entry_signal WHERE run_id=$1", [runId]);
      await client.query("DELETE FROM strategy_position_evaluation WHERE run_id=$1", [runId]);
      if (input.phase === "entry") await persistEntrySignals(client, runId, binding.code, input.target_date, result, binding.evaluator_code, binding.evaluator_version);
      if (input.phase === "exit") await persistPositionEvaluations(client, runId, binding.code, result);
      const updated = await client.query<JsonRecord>(
        `UPDATE strategy_evaluation_run SET status=$2,data_date=$3,result=$4::jsonb,coverage=$5::jsonb,gaps=$6::jsonb,
                finished_at=now(),last_requested_at=now()
          WHERE id=$1 RETURNING ${RUN_RETURNING}`,
        [runId, status, dataDate(result, input.target_date), JSON.stringify(result), JSON.stringify(coverageOf(result)),
         JSON.stringify(gapsOf(result))],
      );
      return updated.rows[0]!;
    });
    return { execution: "executed", run: toRun(persisted), result };
  } catch (error) {
    await db.query(
      `UPDATE strategy_evaluation_run SET status='failed',gaps=$2::jsonb,finished_at=now(),last_requested_at=now()
        WHERE id=$1`, [runId, JSON.stringify([{ reason: (error as Error).message }])],
    ).catch(() => {});
    throw error;
  }
}
