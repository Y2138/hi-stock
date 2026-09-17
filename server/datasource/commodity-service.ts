// 商品与期货研究数据领域服务：统一期货元数据、点时因子和公司商品暴露的受控写入。
import { ensureInstrument, insertFetchRun, type Db } from "./service.js";

export const FUTURES_CONTRACT_KINDS = ["listed", "main_continuous", "nearby_continuous"] as const;
export type FuturesContractKind = (typeof FUTURES_CONTRACT_KINDS)[number];

export const MARKET_FACTOR_METRIC_CODES = [
  "inventory", "warehouse_warrant", "cancelled_warrant", "spot_premium", "treatment_charge",
  "mine_production", "refined_production", "refined_usage", "import_volume", "export_volume",
  "pmi", "industrial_production", "real_rate", "exchange_rate", "inventory_days",
] as const;
export type MarketFactorMetricCode = (typeof MARKET_FACTOR_METRIC_CODES)[number];

export const COMPANY_COMMODITY_ROLES = [
  "upstream_producer", "integrated", "smelter", "processor", "service", "other",
] as const;
export type CompanyCommodityRole = (typeof COMPANY_COMMODITY_ROLES)[number];

export const COMPANY_COMMODITY_METRIC_CODES = [
  "equity_production", "sales_volume", "cash_cost", "all_in_sustaining_cost", "reserves", "resources",
  "hedge_ratio", "capital_expenditure", "commodity_revenue_share", "commodity_profit_share",
  "recovery_rate", "ore_grade",
] as const;
export type CompanyCommodityMetricCode = (typeof COMPANY_COMMODITY_METRIC_CODES)[number];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMMODITY_RE = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const SERIES_RE = /^[a-z0-9][a-z0-9._-]{2,119}$/;

function text(value: string, field: string, max = 1000): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${field} 必须为1-${max}个字符`);
  return normalized;
}

function date(value: string, field: string): string {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(`${field} 必须为YYYY-MM-DD`);
  return value;
}

function timestamp(value: string, field: string): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${field} 必须为带时区的有效时间`);
  return value;
}

function finite(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new Error(`${field} 必须为有限数值`);
  return value;
}

function nonNegative(value: number | null | undefined, field: string): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} 必须为空或非负有限数值`);
  return value;
}

function positive(value: number | null | undefined, field: string): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} 必须为空或正有限数值`);
  return value;
}

function commodityCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!COMMODITY_RE.test(normalized)) throw new Error("commodityCode 格式非法");
  return normalized;
}

async function instrumentId(db: Db, code: string, expectedKind: "futures" | "stock"): Promise<string> {
  const result = await db.query<{ id: string; kind: string }>(
    "SELECT id::text, kind FROM market_instrument WHERE code=$1",
    [text(code, "code", 80)],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`标的不存在：${code}`);
  if (row.kind !== expectedKind) throw new Error(`${code} 必须是 ${expectedKind} 标的`);
  return row.id;
}

export interface FuturesContractInput {
  code: string;
  name?: string;
  exchange: string;
  commodityCode: string;
  contractKind: FuturesContractKind;
  contractMonth?: string | null;
  multiplier?: number | null;
  priceUnit?: string | null;
  currency?: string | null;
  lastTradeDate?: string | null;
  source: string;
  rawSummary?: Record<string, unknown>;
}

export async function upsertFuturesContract(db: Db, input: FuturesContractInput): Promise<string> {
  const contractMonth = input.contractMonth?.trim() || null;
  if ((input.contractKind === "listed") !== (contractMonth !== null)) {
    throw new Error("真实合约必须填写contractMonth，连续合约不得填写contractMonth");
  }
  if (contractMonth && !/^\d{6}$/.test(contractMonth)) throw new Error("contractMonth 必须为YYYYMM");
  const id = await ensureInstrument(db, text(input.code, "code", 80), input.name, "futures_day");
  await instrumentId(db, input.code, "futures");
  await db.query(
    `INSERT INTO market_futures_contract
       (instrument_id,exchange,commodity_code,contract_kind,contract_month,multiplier,price_unit,currency,last_trade_date,source,raw_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (instrument_id) DO UPDATE SET
       exchange=EXCLUDED.exchange, commodity_code=EXCLUDED.commodity_code, contract_kind=EXCLUDED.contract_kind,
       contract_month=EXCLUDED.contract_month, multiplier=EXCLUDED.multiplier, price_unit=EXCLUDED.price_unit,
       currency=EXCLUDED.currency, last_trade_date=EXCLUDED.last_trade_date, source=EXCLUDED.source,
       raw_summary=EXCLUDED.raw_summary, updated_at=now()`,
    [
      id, text(input.exchange, "exchange", 24).toUpperCase(), commodityCode(input.commodityCode), input.contractKind,
      contractMonth, positive(input.multiplier, "multiplier"), input.priceUnit ? text(input.priceUnit, "priceUnit", 40) : null,
      input.currency ? text(input.currency, "currency", 3).toUpperCase() : null,
      input.lastTradeDate ? date(input.lastTradeDate, "lastTradeDate") : null, text(input.source, "source", 80),
      JSON.stringify(input.rawSummary ?? {}),
    ],
  );
  return id;
}

export interface FuturesDailyDetailInput {
  code: string;
  tradeDate: string;
  settlement?: number | null;
  prevSettlement?: number | null;
  openInterest?: number | null;
  upperLimit?: number | null;
  lowerLimit?: number | null;
  source: string;
  rawSummary?: Record<string, unknown>;
}

export async function storeFuturesDailyDetail(db: Db, input: FuturesDailyDetailInput): Promise<void> {
  const id = await instrumentId(db, input.code, "futures");
  const upper = positive(input.upperLimit, "upperLimit");
  const lower = positive(input.lowerLimit, "lowerLimit");
  if (upper !== null && lower !== null && upper < lower) throw new Error("upperLimit 不得低于 lowerLimit");
  await db.query(
    `INSERT INTO market_futures_daily_detail
       (instrument_id,trade_date,settlement,prev_settlement,open_interest,upper_limit,lower_limit,source,raw_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (instrument_id,trade_date) DO UPDATE SET
       settlement=EXCLUDED.settlement, prev_settlement=EXCLUDED.prev_settlement,
       open_interest=EXCLUDED.open_interest,
       upper_limit=EXCLUDED.upper_limit, lower_limit=EXCLUDED.lower_limit,
       source=EXCLUDED.source, raw_summary=EXCLUDED.raw_summary, fetched_at=now()`,
    [id, date(input.tradeDate, "tradeDate"), positive(input.settlement, "settlement"),
      positive(input.prevSettlement, "prevSettlement"), nonNegative(input.openInterest, "openInterest"),
      upper, lower, text(input.source, "source", 80),
      JSON.stringify(input.rawSummary ?? {})],
  );
}

export interface FuturesRollInput {
  continuousCode: string;
  underlyingCode: string;
  tradeDate: string;
  rollReason?: string | null;
  methodCode?: string;
  adjustmentFactor?: number;
  source: string;
  rawSummary?: Record<string, unknown>;
}

export async function storeFuturesRoll(db: Db, input: FuturesRollInput): Promise<void> {
  const continuousId = await instrumentId(db, input.continuousCode, "futures");
  const underlyingId = await instrumentId(db, input.underlyingCode, "futures");
  if (continuousId === underlyingId) throw new Error("连续合约和真实合约不得相同");
  const kinds = await db.query<{ id: string; contract_kind: FuturesContractKind }>(
    "SELECT instrument_id::text AS id, contract_kind FROM market_futures_contract WHERE instrument_id=ANY($1::bigint[])",
    [[continuousId, underlyingId]],
  );
  const byId = new Map(kinds.rows.map((row) => [row.id, row.contract_kind]));
  if (!byId.get(continuousId)?.endsWith("continuous") || byId.get(underlyingId) !== "listed") {
    throw new Error("换月映射必须由连续合约指向真实合约");
  }
  await db.query(
    `INSERT INTO market_futures_roll
       (continuous_instrument_id,trade_date,underlying_instrument_id,roll_reason,method_code,adjustment_factor,source,raw_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (continuous_instrument_id,trade_date,method_code) DO UPDATE SET
       underlying_instrument_id=EXCLUDED.underlying_instrument_id, roll_reason=EXCLUDED.roll_reason,
       adjustment_factor=EXCLUDED.adjustment_factor, source=EXCLUDED.source,
       raw_summary=EXCLUDED.raw_summary, fetched_at=now()`,
    [continuousId, date(input.tradeDate, "tradeDate"), underlyingId,
      input.rollReason ? text(input.rollReason, "rollReason", 120) : null,
      text(input.methodCode ?? "official", "methodCode", 80).toLowerCase(),
      positive(input.adjustmentFactor ?? 1, "adjustmentFactor"), text(input.source, "source", 80),
      JSON.stringify(input.rawSummary ?? {})],
  );
}

export interface MarketFactorSeriesInput {
  seriesCode: string;
  commodityCode?: string | null;
  market?: string | null;
  metricCode: MarketFactorMetricCode;
  frequency: "daily" | "weekly" | "monthly" | "quarterly" | "annual" | "event";
  unit: string;
  source: string;
  sourceTimezone?: string;
  revisionPolicy?: "none" | "revisable";
  active?: boolean;
}

export async function upsertMarketFactorSeries(db: Db, input: MarketFactorSeriesInput): Promise<string> {
  const seriesCode = input.seriesCode.trim().toLowerCase();
  if (!SERIES_RE.test(seriesCode)) throw new Error("seriesCode 格式非法");
  if (!(MARKET_FACTOR_METRIC_CODES as readonly string[]).includes(input.metricCode)) throw new Error("metricCode 不在白名单");
  const normalized = {
    commodityCode: input.commodityCode ? commodityCode(input.commodityCode) : null,
    market: input.market ? text(input.market, "market", 40) : null,
    metricCode: input.metricCode,
    frequency: input.frequency,
    unit: text(input.unit, "unit", 40),
    source: text(input.source, "source", 80),
    sourceTimezone: text(input.sourceTimezone ?? "Asia/Shanghai", "sourceTimezone", 80),
    revisionPolicy: input.revisionPolicy ?? "revisable",
    active: input.active ?? true,
  };
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO market_factor_series
       (series_code,commodity_code,market,metric_code,frequency,unit,source,source_timezone,revision_policy,active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (series_code) DO NOTHING RETURNING id::text`,
    [seriesCode, normalized.commodityCode, normalized.market, normalized.metricCode, normalized.frequency,
      normalized.unit, normalized.source, normalized.sourceTimezone, normalized.revisionPolicy, normalized.active],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = (await db.query<{
    id: string; commodity_code: string | null; market: string | null; metric_code: string; frequency: string;
    unit: string; source: string; source_timezone: string; revision_policy: string; active: boolean;
  }>(`SELECT id::text,commodity_code,market,metric_code,frequency,unit,source,source_timezone,revision_policy,active
       FROM market_factor_series WHERE series_code=$1`, [seriesCode])).rows[0]!;
  const incompatible = existing.commodity_code !== normalized.commodityCode || existing.market !== normalized.market ||
    existing.metric_code !== normalized.metricCode || existing.frequency !== normalized.frequency ||
    existing.unit !== normalized.unit || existing.source !== normalized.source ||
    existing.source_timezone !== normalized.sourceTimezone || existing.revision_policy !== normalized.revisionPolicy;
  if (incompatible) throw new Error(`${seriesCode} 已存在不同序列定义；请使用新的seriesCode`);
  if (existing.active !== normalized.active) {
    await db.query("UPDATE market_factor_series SET active=$2,updated_at=now() WHERE id=$1", [existing.id, normalized.active]);
  }
  return existing.id;
}

export interface MarketFactorObservationInput {
  seriesCode: string;
  periodStart: string;
  periodEnd: string;
  publishedAt: string;
  revisionNo?: number;
  value: number;
  sourceRef: string;
  rawSummary?: Record<string, unknown>;
}

export async function storeMarketFactorObservation(db: Db, input: MarketFactorObservationInput): Promise<string> {
  const seriesCode = input.seriesCode.trim().toLowerCase();
  const series = (await db.query<{ id: string; revision_policy: "none" | "revisable" }>(
    "SELECT id::text, revision_policy FROM market_factor_series WHERE series_code=$1",
    [seriesCode],
  )).rows[0];
  if (!series) throw new Error(`研究序列不存在：${seriesCode}`);
  const revisionNo = input.revisionNo ?? 0;
  if (!Number.isInteger(revisionNo) || revisionNo < 0) throw new Error("revisionNo 必须为非负整数");
  if (series.revision_policy === "none" && revisionNo !== 0) throw new Error(`${seriesCode} 不允许修订版本`);
  const periodStart = date(input.periodStart, "periodStart");
  const periodEnd = date(input.periodEnd, "periodEnd");
  if (periodEnd < periodStart) throw new Error("periodEnd 不得早于 periodStart");
  const publishedAt = timestamp(input.publishedAt, "publishedAt");
  const value = finite(input.value, "value");
  const sourceRef = text(input.sourceRef, "sourceRef");
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO market_factor_observation
       (series_id,period_start,period_end,published_at,revision_no,value,source_ref,raw_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (series_id,period_start,period_end,published_at,revision_no) DO NOTHING
     RETURNING id::text`,
    [series.id, periodStart, periodEnd, publishedAt, revisionNo, value, sourceRef, JSON.stringify(input.rawSummary ?? {})],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = (await db.query<{ id: string; value: number; source_ref: string }>(
    `SELECT id::text,value::float8,source_ref FROM market_factor_observation
      WHERE series_id=$1 AND period_start=$2 AND period_end=$3 AND published_at=$4 AND revision_no=$5`,
    [series.id, periodStart, periodEnd, publishedAt, revisionNo],
  )).rows[0]!;
  if (existing.value !== value || existing.source_ref !== sourceRef) throw new Error("同一点时观测已存在不同值；请增加revisionNo或修正发布时间");
  return existing.id;
}

export interface CompanyCommodityProfileInput {
  code: string;
  commodityCode: string;
  role: CompanyCommodityRole;
  effectiveFrom: string;
  effectiveTo?: string | null;
  publishedAt: string;
  sourceRef: string;
  rawSummary?: Record<string, unknown>;
}

export async function storeCompanyCommodityProfile(db: Db, input: CompanyCommodityProfileInput): Promise<string> {
  const instrument = await instrumentId(db, input.code, "stock");
  const commodity = commodityCode(input.commodityCode);
  const effectiveFrom = date(input.effectiveFrom, "effectiveFrom");
  const effectiveTo = input.effectiveTo ? date(input.effectiveTo, "effectiveTo") : null;
  if (effectiveTo && effectiveTo <= effectiveFrom) throw new Error("effectiveTo 必须晚于 effectiveFrom");
  const publishedAt = timestamp(input.publishedAt, "publishedAt");
  const sourceRef = text(input.sourceRef, "sourceRef");
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO company_commodity_profile
       (instrument_id,commodity_code,role,effective_from,effective_to,published_at,source_ref,raw_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (instrument_id,commodity_code,effective_from,published_at) DO NOTHING
     RETURNING id::text`,
    [instrument, commodity, input.role, effectiveFrom, effectiveTo, publishedAt, sourceRef,
      JSON.stringify(input.rawSummary ?? {})],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = (await db.query<{ id: string; role: string; effective_to: string | null; source_ref: string }>(
    `SELECT id::text,role,effective_to::text,source_ref FROM company_commodity_profile
      WHERE instrument_id=$1 AND commodity_code=$2 AND effective_from=$3 AND published_at=$4`,
    [instrument, commodity, effectiveFrom, publishedAt],
  )).rows[0]!;
  if (existing.role !== input.role || existing.effective_to !== effectiveTo || existing.source_ref !== sourceRef) {
    throw new Error("同一点时公司商品画像已存在不同内容；请使用新的披露时间或修正原始输入");
  }
  return existing.id;
}

export interface CompanyCommodityMetricInput {
  code: string;
  commodityCode: string;
  reportPeriod: string;
  publishedAt: string;
  revisionNo?: number;
  metricCode: CompanyCommodityMetricCode;
  value: number;
  unit: string;
  sourceRef: string;
  rawSummary?: Record<string, unknown>;
}

export async function storeCompanyCommodityMetric(db: Db, input: CompanyCommodityMetricInput): Promise<string> {
  const instrument = await instrumentId(db, input.code, "stock");
  if (!(COMPANY_COMMODITY_METRIC_CODES as readonly string[]).includes(input.metricCode)) throw new Error("metricCode 不在白名单");
  const revisionNo = input.revisionNo ?? 0;
  if (!Number.isInteger(revisionNo) || revisionNo < 0) throw new Error("revisionNo 必须为非负整数");
  const commodity = commodityCode(input.commodityCode);
  const reportPeriod = date(input.reportPeriod, "reportPeriod");
  const publishedAt = timestamp(input.publishedAt, "publishedAt");
  const value = finite(input.value, "value");
  const unit = text(input.unit, "unit", 40);
  const sourceRef = text(input.sourceRef, "sourceRef");
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO company_commodity_metric
       (instrument_id,commodity_code,report_period,published_at,revision_no,metric_code,value,unit,source_ref,raw_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (instrument_id,commodity_code,report_period,published_at,revision_no,metric_code) DO NOTHING
     RETURNING id::text`,
    [instrument, commodity, reportPeriod, publishedAt, revisionNo, input.metricCode, value, unit, sourceRef,
      JSON.stringify(input.rawSummary ?? {})],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = (await db.query<{ id: string; value: number; unit: string; source_ref: string }>(
    `SELECT id::text,value::float8,unit,source_ref FROM company_commodity_metric
      WHERE instrument_id=$1 AND commodity_code=$2 AND report_period=$3 AND published_at=$4
        AND revision_no=$5 AND metric_code=$6`,
    [instrument, commodity, reportPeriod, publishedAt, revisionNo, input.metricCode],
  )).rows[0]!;
  if (existing.value !== value || existing.unit !== unit || existing.source_ref !== sourceRef) {
    throw new Error("同一点时公司商品指标已存在不同值；请增加revisionNo或修正发布时间");
  }
  return existing.id;
}

export async function recordCommodityFetchRun(
  db: Db,
  input: { channel: string; scope: Record<string, unknown>; rowsWritten: number; gaps?: unknown[]; jobRunId?: string },
): Promise<string> {
  return insertFetchRun(db, {
    channel: text(input.channel, "channel", 80),
    scope: { ...input.scope, pipeline: "commodity_research" },
    rowsWritten: input.rowsWritten,
    gaps: input.gaps,
    jobRunId: input.jobRunId,
  });
}
