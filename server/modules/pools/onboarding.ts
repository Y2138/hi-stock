// 标的入池初始化：服务端统一同步数据、重算正式指标，并从版本化画像生成唯一入池提案。
import type pg from "pg";
import {
  fetchAndStore,
  fetchFinancialAndStore,
  type FetchStoreOutcome,
  type FinancialStoreOutcome,
} from "../../datasource/service.js";
import { resolveRemoteTicker, upsertTickerIdentities } from "../../datasource/catalog-service.js";
import { recomputeIndicatorSeries, type IndicatorRunResult } from "../../indicators/service.js";
import { STOCK_CHARACTER_CALCULATION_VERSION, type StockCharacterProfile } from "../../indicators/formulas.js";
import type { PoolChangeInput, PoolKind } from "./repo.js";

type Db = Pick<pg.Pool | pg.PoolClient, "query">;
export type PoolOnboardRole = "短线" | "波段" | "长线";

export interface PoolOnboardRequest {
  instrument: string;
  requested_pool?: PoolKind;
  requested_role?: PoolOnboardRole;
  reason: string;
}

export interface PoolOnboardCommitInput {
  code: string;
  requested_pool?: PoolKind;
  requested_role?: PoolOnboardRole;
  reason: string;
  effective_from: string;
  profile_as_of: string;
  profile_calculation_version: string;
  profile_input_sha256: string;
}

interface ProfileRow {
  instrument_id: string;
  code: string;
  name: string;
  kind: string;
  as_of_date: string;
  calculation_version: string;
  input_sha256: string;
  input_row_count: number;
  input_start_date: string | null;
  input_end_date: string | null;
  indicator_status: string;
  stock_character_profile: StockCharacterProfile;
  stage: string | null;
  research_score: number | null;
  grade: string | null;
  stock_character: string | null;
  tags: string[];
}

interface SnapshotRow {
  as_of_date: string;
  source?: string;
  report_period?: string | null;
  revenue?: number | null;
  net_profit?: number | null;
  operating_cashflow?: number | null;
  roe?: number | null;
  gross_margin?: number | null;
  debt_ratio?: number | null;
  pe_ttm?: number | null;
  pb?: number | null;
  ps_ttm?: number | null;
}

export interface ResolvedPoolOnboarding {
  current: Record<string, unknown> | null;
  preview: Record<string, unknown>;
  change: PoolChangeInput;
}

export interface PoolOnboardingDeps {
  fetchMarket?: (request: { code: string; freq: "day"; start: string; end: string }) => Promise<FetchStoreOutcome>;
  fetchFinancial?: (request: { code: string }) => Promise<FinancialStoreOutcome>;
  recomputeIndicator?: (dirty: { instrument_id: string; freq: "day"; generation: string }) => Promise<IndicatorRunResult>;
  now?: () => Date;
}

function shanghaiDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function findProfile(
  db: Db,
  code: string,
  commit?: PoolOnboardCommitInput,
  lock = false,
): Promise<ProfileRow | null> {
  const result = await db.query<ProfileRow>(
    `SELECT instrument.id::text AS instrument_id, instrument.code, instrument.name, instrument.kind,
            metric.as_of_date::text, metric.calculation_version, run.input_sha256,
            metric.input_row_count, run.input_start_date::text, run.input_end_date::text,
            run.status AS indicator_status, metric.stock_character_profile,
            metric.stage, metric.research_score, metric.grade, metric.stock_character, metric.tags
       FROM market_instrument instrument
       JOIN market_stock_character_metric metric ON metric.instrument_id = instrument.id
       JOIN market_indicator_run run ON run.id = metric.indicator_run_id
      WHERE instrument.code = $1
        AND metric.calculation_version = $2
        AND ($3::date IS NULL OR metric.as_of_date = $3::date)
        AND ($4::text IS NULL OR run.input_sha256 = $4)
      ORDER BY metric.as_of_date DESC, metric.computed_at DESC LIMIT 1${lock ? " FOR UPDATE OF metric, run" : ""}`,
    [
      code,
      commit?.profile_calculation_version ?? STOCK_CHARACTER_CALCULATION_VERSION,
      commit?.profile_as_of ?? null,
      commit?.profile_input_sha256 ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

async function ensureInstrument(pool: pg.Pool, query: string): Promise<{ id: string; code: string; name: string; kind: string }> {
  const normalized = query.trim();
  const existing = await pool.query<{ id: string; code: string; name: string; kind: string }>(
    `SELECT id::text, code, name, kind FROM market_instrument
      WHERE kind IN ('stock','etf')
        AND (upper(code) = upper($1) OR ticker = $1 OR name = $1)
      ORDER BY code`,
    [normalized],
  );
  if (existing.rows.length === 1) return existing.rows[0]!;
  if (existing.rows.length > 1) {
    throw new Error(`标的无法唯一识别：${existing.rows.map((item) => `${item.name}(${item.code})`).join("、")}`);
  }
  const remote = (await resolveRemoteTicker(normalized, { db: pool }))
    .filter((item) => item.assetType === "a-share" || item.assetType === "fund-etf");
  const exact = remote.filter((item) =>
    item.code === normalized.toUpperCase() || item.ticker === normalized || item.name === normalized,
  );
  const candidates = exact.length ? exact : remote;
  if (candidates.length !== 1) {
    const detail = candidates.slice(0, 5).map((item) => `${item.name}(${item.code})`).join("、");
    throw new Error(`扶摇标的目录无法唯一识别“${normalized}”${detail ? `：${detail}` : ""}`);
  }
  const [identity] = candidates;
  await upsertTickerIdentities(pool, [identity!]);
  return (await pool.query<{ id: string; code: string; name: string; kind: string }>(
    "SELECT id::text, code, name, kind FROM market_instrument WHERE code = $1",
    [identity!.code],
  )).rows[0]!;
}

function requestedSelection(
  input: Pick<PoolOnboardRequest, "requested_pool" | "requested_role">,
  profile: ProfileRow,
  fundamental: SnapshotRow | null,
) {
  if (input.requested_role) {
    return {
      pool: input.requested_role === "短线" ? "short" as const : "long" as const,
      role: input.requested_role,
      source: "user" as const,
      reason: "遵从用户明确指定的策略角色",
    };
  }
  if (input.requested_pool === "short") {
    return { pool: "short" as const, role: "短线" as const, source: "user" as const, reason: "遵从用户明确指定的短线池" };
  }
  const dimensions = profile.stock_character_profile.dimensions;
  const strongFundamental = profile.kind === "stock" && fundamental !== null &&
    Number(fundamental.net_profit) > 0 && Number(fundamental.operating_cashflow) > 0 && Number(fundamental.roe) > 0;
  if (input.requested_pool === "long") {
    return strongFundamental
      ? { pool: "long" as const, role: "长线" as const, source: "user" as const, reason: "用户指定长线池且基本面满足长期跟踪口径" }
      : { pool: "long" as const, role: "波段" as const, source: "user" as const, reason: "用户指定长线池，当前资料更适合波段跟踪" };
  }
  if (strongFundamental && dimensions.volatility.score < 60 && (profile.research_score ?? 0) >= 60) {
    return { pool: "long" as const, role: "长线" as const, source: "calculation" as const, reason: "基本面为正、波动可控且研究评分达到长期跟踪阈值" };
  }
  if (["主升", "上升"].includes(profile.stage ?? "") && dimensions.markup.score >= 60) {
    return { pool: "short" as const, role: "短线" as const, source: "calculation" as const, reason: "趋势与拉升维度更适合短周期持续扫描" };
  }
  return { pool: "long" as const, role: "波段" as const, source: "calculation" as const, reason: "未指定池别时按中周期股性归入波段持续扫描" };
}

async function profileFacts(db: Db, profile: ProfileRow, lock = false) {
  const industries = await db.query<{ code: string; name: string }>(
    `SELECT board_instrument.code, board_instrument.name
       FROM market_board_membership relation
       JOIN market_board board ON board.instrument_id = relation.board_instrument_id
       JOIN market_instrument board_instrument ON board_instrument.id = board.instrument_id
      WHERE relation.member_instrument_id = $1 AND relation.effective_to IS NULL
        AND board.active = true AND board.source = 'hithink' AND board.board_type = 'industry'
      ORDER BY board_instrument.code${lock ? " FOR SHARE OF relation, board" : ""}`,
    [profile.instrument_id],
  );
  const fundamental = await db.query<SnapshotRow>(
    `SELECT as_of_date::text, report_period::text, source, revenue::float8, net_profit::float8,
            operating_cashflow::float8, roe::float8, gross_margin::float8, debt_ratio::float8
       FROM fundamental_snapshot WHERE instrument_id = $1 AND source = 'hithink'
      ORDER BY as_of_date DESC, report_period DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [profile.instrument_id],
  );
  const valuation = await db.query<SnapshotRow>(
    `SELECT as_of_date::text, source, pe_ttm::float8, pb::float8, ps_ttm::float8
       FROM valuation_snapshot WHERE instrument_id = $1 AND source = 'hithink'
      ORDER BY as_of_date DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [profile.instrument_id],
  );
  const current = await db.query<Record<string, unknown>>(
    `SELECT id::text, pool, role, grade, score::float8, profile_as_of::text,
            profile_calculation_version, profile_input_sha256, effective_from::text
       FROM pool_membership WHERE instrument_id = $1 AND effective_to IS NULL
      ORDER BY id DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [profile.instrument_id],
  );
  return {
    industries: industries.rows,
    fundamental: fundamental.rows[0] ?? null,
    valuation: valuation.rows[0] ?? null,
    current: current.rows[0] ?? null,
  };
}

export async function resolvePoolOnboarding(
  db: Db,
  input: PoolOnboardCommitInput,
  lock = false,
): Promise<ResolvedPoolOnboarding> {
  const profile = await findProfile(db, input.code, input, lock);
  if (!profile) throw new Error("入池画像已变化或不存在，请重新执行 pool_onboard 初始化");
  if (profile.indicator_status !== "success" || profile.input_row_count < 120 || !profile.stage ||
      profile.research_score === null || !profile.grade || !profile.stock_character) {
    throw new Error("正式日线不足120条或五维画像未完整生成，不能创建入池提案");
  }
  const facts = await profileFacts(db, profile, lock);
  if (profile.kind === "stock" && facts.industries.length === 0) {
    throw new Error("同花顺官方行业关系尚未同步；请先完成板块成分同步后重试 pool_onboard");
  }
  if (profile.kind === "stock" && (!facts.fundamental || !facts.valuation)) {
    throw new Error("A股最新财务或估值快照缺失，不能创建入池提案");
  }
  const selection = requestedSelection(input, profile, facts.fundamental);
  const profileValue = profile.stock_character_profile;
  const industryText = facts.industries.map((item) => item.name).join("、") || "不适用";
  const financialText = profile.kind === "stock"
    ? `财务${facts.fundamental!.report_period ?? facts.fundamental!.as_of_date}，估值${facts.valuation!.as_of_date}`
    : "财务与个股估值不适用";
  const evaluationSummary = [
    `数据截至${profile.as_of_date}`,
    `五维股性${profile.stock_character}`,
    `阶段${profile.stage}，研究评分${profile.research_score}（${profile.grade}）`,
    `官方行业${industryText}`,
    financialText,
    `角色来源：${selection.reason}`,
  ].join("；");
  const change: PoolChangeInput = {
    action: facts.current ? "update" : "add",
    code: profile.code,
    pool: selection.pool,
    role: selection.role,
    grade: profile.grade,
    score: profile.research_score,
    tags: profile.tags,
    stock_character: profile.stock_character,
    stock_character_profile: profileValue,
    stage: profile.stage,
    evaluation_summary: evaluationSummary,
    profile_as_of: profile.as_of_date,
    profile_calculation_version: profile.calculation_version,
    profile_input_sha256: profile.input_sha256,
    effective_from: input.effective_from,
    note: "由 pool_onboard 确定性初始化生成",
  };
  const preview = {
    instrument: { code: profile.code, name: profile.name, kind: profile.kind },
    action: change.action,
    recommendation: selection,
    grade: profile.grade,
    score: profile.research_score,
    stage: profile.stage,
    stock_character: profile.stock_character,
    dimensions: profileValue.dimensions,
    key_levels: profileValue.key_levels,
    industries: facts.industries,
    fundamental: facts.fundamental,
    valuation: facts.valuation,
    data_quality: {
      calculation_version: profile.calculation_version,
      input_sha256: profile.input_sha256,
      input_rows: profile.input_row_count,
      input_start_date: profile.input_start_date,
      input_end_date: profile.input_end_date,
      indicator_status: profile.indicator_status,
    },
    evaluation_summary: evaluationSummary,
  };
  return { current: facts.current, preview, change };
}

export async function initializePoolOnboarding(
  pool: pg.Pool,
  input: PoolOnboardRequest,
  deps: PoolOnboardingDeps = {},
) {
  const instrument = await ensureInstrument(pool, input.instrument);
  if (!["stock", "etf"].includes(instrument.kind)) throw new Error("pool_onboard 只支持A股和ETF");
  const effectiveFrom = shanghaiDate((deps.now ?? (() => new Date()))());
  const market = await (deps.fetchMarket ?? ((request) => fetchAndStore(pool, request)))(
    { code: instrument.code, freq: "day", start: addDays(effectiveFrom, -420), end: effectiveFrom },
  );
  let financial: FinancialStoreOutcome | null = null;
  if (instrument.kind === "stock") {
    financial = await (deps.fetchFinancial ?? ((request) => fetchFinancialAndStore(pool, request)))({ code: instrument.code });
    if (financial.status !== "success") {
      throw new Error(`A股财务与估值同步不完整：${JSON.stringify(financial.gaps)}`);
    }
  }
  const dirty = await pool.query<{ instrument_id: string; freq: "day"; generation: string }>(
    `SELECT instrument_id::text, freq, generation::text FROM market_indicator_dirty
      WHERE instrument_id = $1 AND freq = 'day'`,
    [instrument.id],
  );
  const indicator = dirty.rows[0]
    ? await (deps.recomputeIndicator ?? ((row) => recomputeIndicatorSeries(pool, row)))(dirty.rows[0])
    : null;
  if (!indicator || indicator.status !== "success") {
    throw new Error(`正式日线指标未完成可信重算：${indicator?.status ?? "未生成重算任务"}`);
  }
  const profile = await findProfile(pool, instrument.code);
  if (!profile) throw new Error("五维画像未生成");
  const commit: PoolOnboardCommitInput = {
    code: instrument.code,
    requested_pool: input.requested_pool,
    requested_role: input.requested_role,
    reason: input.reason,
    effective_from: effectiveFrom,
    profile_as_of: profile.as_of_date,
    profile_calculation_version: profile.calculation_version,
    profile_input_sha256: profile.input_sha256,
  };
  const resolved = await resolvePoolOnboarding(pool, commit);
  return {
    commit,
    preview: resolved.preview,
    initialization: {
      market,
      financial,
      indicator,
    },
  };
}
