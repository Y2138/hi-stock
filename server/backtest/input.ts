import { gzipSync, gunzipSync } from "node:zlib";
import type pg from "pg";
import {
  canonicalJson, contentHash, standardSeedStart, STANDARD_CHUNK_BYTES, STANDARD_INPUT_VERSION, STANDARD_MAX_ROWS,
  type BacktestGap, type StandardBacktestPlan, type StandardBar, type StandardDay, type StandardInputManifest,
  type StandardMarketFactors,
} from "./contracts.js";

type Db = Pick<pg.PoolClient, "query">;
export interface PreparedChunk { day: string; hash: string; rawBytes: number; rows: number; payload: Buffer }
export interface StandardPreflight {
  executable: boolean;
  plan: StandardBacktestPlan;
  plan_hash: string;
  manifest: StandardInputManifest;
  input_hash: string;
  estimated_compressed_bytes: number;
  evidence_status: "research_only";
}
const INPUT_BYTES_LIMIT = 128 * 1024 * 1024;
const ADX_PERIOD = 14;
/** Wilder ADX14 的逐日状态：首个观测日只登记价格，其后累积 TR/DM，收敛前返回 null。 */
interface IndustryAdxState {
  previousHigh: number; previousLow: number; previousClose: number;
  smoothedTr: number; smoothedPlusDm: number; smoothedMinusDm: number;
  dxWindow: number[]; adx: number | null; samples: number;
}
function advanceIndustryAdx(states: Map<string, IndustryAdxState>, bar: StandardBar): number | null {
  let state = states.get(bar.code);
  if (!state) {
    states.set(bar.code, { previousHigh: bar.high, previousLow: bar.low, previousClose: bar.close,
      smoothedTr: 0, smoothedPlusDm: 0, smoothedMinusDm: 0, dxWindow: [], adx: null, samples: 0 });
    return null;
  }
  const upMove = bar.high - state.previousHigh;
  const downMove = state.previousLow - bar.low;
  const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
  const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
  const trueRange = Math.max(bar.high - bar.low, Math.abs(bar.high - state.previousClose), Math.abs(bar.low - state.previousClose));
  state.samples += 1;
  if (state.samples <= ADX_PERIOD) {
    state.smoothedTr += trueRange; state.smoothedPlusDm += plusDm; state.smoothedMinusDm += minusDm;
  } else {
    state.smoothedTr = state.smoothedTr - state.smoothedTr / ADX_PERIOD + trueRange;
    state.smoothedPlusDm = state.smoothedPlusDm - state.smoothedPlusDm / ADX_PERIOD + plusDm;
    state.smoothedMinusDm = state.smoothedMinusDm - state.smoothedMinusDm / ADX_PERIOD + minusDm;
  }
  state.previousHigh = bar.high; state.previousLow = bar.low; state.previousClose = bar.close;
  if (state.samples < ADX_PERIOD || state.smoothedTr <= 0) return null;
  const plusDi = 100 * state.smoothedPlusDm / state.smoothedTr;
  const minusDi = 100 * state.smoothedMinusDm / state.smoothedTr;
  const directionalSum = plusDi + minusDi;
  const dx = directionalSum > 0 ? 100 * Math.abs(plusDi - minusDi) / directionalSum : 0;
  if (state.adx === null) {
    state.dxWindow.push(dx);
    if (state.dxWindow.length < ADX_PERIOD) return null;
    state.adx = state.dxWindow.reduce((sum, value) => sum + value, 0) / ADX_PERIOD;
    state.dxWindow = [];
  } else {
    state.adx = (state.adx * (ADX_PERIOD - 1) + dx) / ADX_PERIOD;
  }
  return state.adx;
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** 不抓取、下载或写入行情；不读取设置、持仓、池或策略正文。调用方须提供一致读事务。 */
export async function inspectStandardInput(db: Db, plan: StandardBacktestPlan, retainChunks = false, signal?: AbortSignal): Promise<{ report: StandardPreflight; chunks: PreparedChunk[] }> {
  const seed = standardSeedStart(plan.start);
  const gaps: BacktestGap[] = [
    { code: "POINT_IN_TIME_UNVERIFIED", domain: "universe", severity: "warning", message: "固定标的集历史研究；未证明当时股票池、上市退市与行业资格" },
    { code: "POINT_IN_TIME_UNVERIFIED", domain: "execution", severity: "warning", message: "仅研究：100股、前收±10%保守开盘限制；历史制度、停牌和公司行为尚未接入，不具备正式收益证据资格" },
    { code: "POINT_IN_TIME_UNVERIFIED", domain: "indicator_seed", severity: "warning", message: "种子固定为正式起点前六年；与生产当前批次按最新日回看六年的锚点可能不同，未宣称数值与当前缓存完全一致" },
    { code: "POINT_IN_TIME_UNVERIFIED", domain: "costs", severity: "warning", message: "费用与滑点是显式实验假设，未核验对应历史有效期" },
  ];
  if (plan.price_mode === "forward_research") gaps.push({ code: "POINT_IN_TIME_UNVERIFIED", domain: "price", severity: "warning", message: "使用前复权研究价格模拟账本，不能解释为历史真实成交和含公司行为的实际收益" });
  const addGap = (gap: BacktestGap) => { if (gaps.length < 200) gaps.push(gap); };
  const deadline = Date.now() + 15 * 60_000;
  const aborted = () => {
    if (signal?.aborted) throw new Error("标准回测输入准备已取消");
    if (Date.now() > deadline) throw new Error("标准回测冻结超过十五分钟预算");
  };
  aborted();
  const calendar = await db.query<{ date: string; is_open: boolean }>(
    `SELECT trade_date::text AS date, is_open FROM market_trading_day WHERE trade_date BETWEEN $1 AND $2 ORDER BY trade_date LIMIT 10001`, [seed, plan.end],
  );
  const expectedDays = Math.floor((Date.parse(plan.end) - Date.parse(seed)) / 86_400_000) + 1;
  if (calendar.rows.length !== expectedDays || expectedDays > 10000) addGap({ code: "DATA_MISSING", domain: "calendar", severity: "error", message: "六年种子至结束日需要完整自然日交易日历（含非交易日），不可推断缺失日期为休市" });
  const dates = calendar.rows.filter(row => row.is_open).map(row => row.date);
  if (!dates.some(date => date >= plan.start)) addGap({ code: "DATA_MISSING", domain: "calendar", severity: "error", message: "正式区间没有已确认交易日" });
  if (dates.filter(date => date < plan.start).length < 35) addGap({ code: "DATA_MISSING", domain: "warmup", severity: "error", message: "共同种子窗口不足以完成右侧递归指标预热" });
  const useEnvironment = plan.environment_mode !== "none";
  const startIndex = dates.findIndex(function(date) { return Boolean(date.localeCompare(plan.start) + 1); });
  const environmentWarmupDays = Math.max(20, plan.environment_warmup_days ?? 20,
    (plan.absolute_momentum?.days ?? 0) + 1, (plan.residual_momentum?.days ?? 0) + 1, (plan.industry_momentum?.days ?? 0) + 1);
  let environmentStart = plan.start;
  if (useEnvironment) {
    const warmupDelta = startIndex - environmentWarmupDays;
    if (warmupDelta === Math.abs(warmupDelta)) {
      const candidate = dates[warmupDelta];
      if (candidate) environmentStart = candidate;
    } else {
      addGap({ code: "DATA_MISSING", domain: "environment", severity: "error", message: "881环境预热交易日不足" });
    }
  }
  const instruments = await db.query
<{ code: string; kind: string }>(`SELECT code, kind FROM market_instrument WHERE code = ANY($1::text[]) ORDER BY code`, [plan.codes]);
  for (const code of plan.codes) {
    if (!instruments.rows.some(row => row.code === code && row.kind === "stock")) addGap({ code: "RULE_UNSUPPORTED", domain: "instrument", severity: "error", instrument: code, message: "标准日频首版只支持已登记股票" });
  }
  if (plan.benchmark_code && !(await db.query("SELECT id FROM market_instrument WHERE code=$1 AND kind='index'",[plan.benchmark_code])).rowCount) addGap({code:"DATA_MISSING",domain:"benchmark",severity:"error",message:"基准须为数据库已有的指数日线"});
  if (!plan.benchmark_code) gaps.push({code:"POINT_IN_TIME_UNVERIFIED",domain:"benchmark",severity:"warning",message:"未指定基准，本次不提供超额收益结论"});
  const environmentCodes = useEnvironment ? (await db.query<{ code: string }>(
    plan.environment_mode === "synthetic_881"
      ? `SELECT code FROM market_instrument WHERE kind='board' AND code LIKE '881%.SY' ORDER BY code`
      : `SELECT i.code FROM market_board board JOIN market_instrument i ON i.id=board.instrument_id
          WHERE board.active AND board.source='hithink' AND board.board_type='industry' AND i.code LIKE '881%' ORDER BY i.code`,
  )).rows.map(row => row.code) : [];
  if (useEnvironment && !environmentCodes.length) addGap({ code: "DATA_MISSING", domain: "environment", severity: "error", message: "环境模式依赖881全集，数据库没有可用板块目录" });
  if (environmentCodes.length && plan.environment_mode === "synthetic_881") {
    gaps.push({ code: "POINT_IN_TIME_UNVERIFIED", domain: "environment", severity: "warning", message: "881环境序列为等权合成数据（当前成分外推、个股等权日收益累乘，与真实881自由流通加权口径不同）；仅限研究" });
  } else if (environmentCodes.length) {
    gaps.push({ code: "POINT_IN_TIME_UNVERIFIED", domain: "environment", severity: "warning", message: "881参与集合按当前目录冻结；未证明历史时点集合" });
  }
  if (dates.length * (plan.codes.length + environmentCodes.length + (plan.benchmark_code ? 1 : 0)) > STANDARD_MAX_ROWS) addGap({ code: "CAPACITY_EXCEEDED", domain: "input", severity: "error", message: "六年种子与研究行情总量超过300万行预算；不会静默裁剪数据" });
  const manifest: StandardInputManifest = {
    version: STANDARD_INPUT_VERSION,
    data_request_hash: contentHash({ codes: plan.codes, start: plan.start, end: plan.end, price_mode: plan.price_mode, seed_start: seed, environment_codes: environmentCodes, environment_start: useEnvironment ? environmentStart : null, benchmark_code: plan.benchmark_code ?? null }),
    environment_codes: environmentCodes, ...(plan.benchmark_code ? {benchmark_code:plan.benchmark_code}:{}),
    seed_start: seed, start: plan.start, end: plan.end, codes: plan.codes, row_count: 0, day_count: 0, chunks: [], gaps,
  };
  const chunks: PreparedChunk[] = [];
  let bytes = 0;
  const requestedCodes = new Set(plan.codes);
  const allCodes = [...plan.codes, ...environmentCodes, ...(plan.benchmark_code ? [plan.benchmark_code] : [])];
  // 停牌近似：先取每个标的在本区间内的首末行情日；区间内部的缺行或零量日按停牌处理，不再整体拒绝。
  const spanRows = await db.query<{ code: string; first: string; last: string }>(
    `SELECT i.code, min(b.bar_date)::text AS first, max(b.bar_date)::text AS last
     FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id
     WHERE i.code = ANY($1::text[]) AND b.freq='day' GROUP BY i.code`, [allCodes]);
  const spans = new Map(spanRows.rows.map(row => [row.code, row]));
  let suspensionDays = 0;
  let priorBoardCloses = new Map<string, number>();
  const composite: number[] = [];
  const adxStates = new Map<string, IndustryAdxState>();
  // 没有合格日历、目录或容量时不做数千次无意义查询。
  if (!gaps.some(gap => gap.severity === "error")) for (const date of dates) {
    aborted();
    const result = await db.query<StandardBar & { adjustment: string | null; volume_unit: string | null }>(
      `SELECT i.code, b.bar_date::text AS date,
              (CASE WHEN i.kind='stock' AND $3='raw_research' THEN COALESCE(b.open_raw,CASE WHEN b.adjustment='none' THEN b.open END) ELSE b.open END)::float8 AS open,
              (CASE WHEN i.kind='stock' AND $3='raw_research' THEN COALESCE(b.high_raw,CASE WHEN b.adjustment='none' THEN b.high END) ELSE b.high END)::float8 AS high,
              (CASE WHEN i.kind='stock' AND $3='raw_research' THEN COALESCE(b.low_raw,CASE WHEN b.adjustment='none' THEN b.low END) ELSE b.low END)::float8 AS low,
              (CASE WHEN i.kind='stock' AND $3='raw_research' THEN COALESCE(b.close_raw,CASE WHEN b.adjustment='none' THEN b.close END) ELSE b.close END)::float8 AS close,
              b.volume::float8,
              CASE WHEN i.kind='stock' AND $3='raw_research' AND b.open_raw IS NOT NULL AND b.high_raw IS NOT NULL AND b.low_raw IS NOT NULL AND b.close_raw IS NOT NULL THEN 'none' ELSE b.adjustment END AS adjustment,
              b.volume_unit
       FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id
       WHERE i.code=ANY($1::text[]) AND b.freq='day' AND b.bar_date=$2::date ORDER BY i.code, b.bar_time`, [allCodes, date, plan.price_mode],
    );
    const seen = new Set<string>();
    const suspensionSeen = new Set<string>();
    const stockBars: StandardBar[] = [];
    const boardBars: StandardBar[] = [];
    let benchmark: StandardDay["benchmark"];
    let invalid = false;
    for (const row of result.rows) {
      const stock = requestedCodes.has(row.code);
      // 零量/空量股票日线视为停牌观测：跳过且不计入交易序列，不做假K线。
      if (stock && (row.volume === null || row.volume <= 0)) {
        if (!suspensionSeen.has(row.code)) { suspensionSeen.add(row.code); suspensionDays += 1; }
        continue;
      }
      const expectedAdjustment = stock && plan.price_mode === "forward_research" ? "forward" : "none";
      if (seen.has(row.code) || row.adjustment !== expectedAdjustment ||
          ![row.open, row.high, row.low, row.close].every(value => Number.isFinite(value) && value > 0 && value <= 1_000_000) ||
          row.low > Math.min(row.open, row.close) || row.high < Math.max(row.open, row.close) ||
          (stock && (!Number.isSafeInteger(row.volume) || row.volume <= 0 || !["share", "shares", "股"].includes(row.volume_unit ?? "")))) {
        addGap({ code: "DATA_INVALID", domain: "bars", severity: "error", instrument: row.code, date, message: "日线重复、复权口径不符、OHLC或股数单位成交量非法；零量不自动认定停牌" });
        invalid = true;
      }
      seen.add(row.code);
      const { adjustment: _adjustment, volume_unit: _volumeUnit, ...bar } = row;
      if (row.code===plan.benchmark_code) {benchmark={code:row.code,close:row.close};continue;}
      (stock ? stockBars : boardBars).push({ ...bar, volume: stock ? bar.volume : 0 });
    }
    const requiredCodes = useEnvironment
      ? (Boolean(date.localeCompare(environmentStart) + 1) ? allCodes : plan.codes)
      : (Boolean(date.localeCompare(plan.start) + 1) ? allCodes : plan.codes);
    for (const code of requiredCodes) if (seen.has(code) === false && !suspensionSeen.has(code)) {
      const span = spans.get(code);
      if (requestedCodes.has(code) && span && date >= span.first && date <= span.last) {
        // 标的首末行情日之间的缺行按停牌近似；研究近似，不证明当时停牌状态。
        suspensionDays += 1;
        continue;
      }
      if (!requestedCodes.has(code) || !span) {
        // 板块、基准缺行仍显式拒绝；从未出现过的标的视为未上市，不进入当日集合。
        addGap({ code: "DATA_MISSING", domain: "bars", severity: "error", instrument: code, date, message: "环境板块或基准缺日线；系统不负责全市场同步，请通过外部流程补齐 PostgreSQL" });
        invalid = true;
      }
    }
    if (invalid) break;
    let marketRecovery: boolean | null = null;
    let marketFactors: StandardMarketFactors | null = null;
    // 环境序列自 881 板块首个完整观测日开始累积，正式窗口开始前完成 MA20/斜率与 ADX 预热；
    // 新增板块首个观测日按零收益进入连续基准，分母保持当日板块数。
    if (useEnvironment && boardBars.length) {
      const dailyReturn = priorBoardCloses.size
        ? boardBars.reduce((sum, bar) => {
            const prior = priorBoardCloses.get(bar.code);
            return prior !== undefined && prior > 0 ? sum + bar.close / prior - 1 : sum;
          }, 0) / boardBars.length
        : 0;
      const next = (composite.at(-1) ?? 100) * (1 + dailyReturn);
      if (!Number.isFinite(next) || next <= 0) { addGap({ code: "DATA_INVALID", domain: "environment", severity: "error", date, message: "综合指数无法形成有限正值" }); break; }
      composite.push(next);
      if (composite.length > 40) composite.shift();
      if (composite.length >= 21) marketRecovery = composite.at(-1)! >= composite.at(-21)!;
      let rising = 0;
      let common = 0;
      const adxValues: number[] = [];
      for (const bar of boardBars) {
        const prior = priorBoardCloses.get(bar.code);
        if (prior !== undefined && prior > 0) { common += 1; if (bar.close > prior) rising += 1; }
        const adx = advanceIndustryAdx(adxStates, bar);
        if (adx !== null) adxValues.push(adx);
      }
      const compositeMa20 = composite.length >= 20 ? composite.slice(-20).reduce((sum, value) => sum + value, 0) / 20 : null;
      const previousMa20 = composite.length >= 21 ? composite.slice(-21, -1).reduce((sum, value) => sum + value, 0) / 20 : null;
      marketFactors = {
        composite_close: next,
        composite_ma20: compositeMa20,
        composite_slope: compositeMa20 !== null && previousMa20 !== null && previousMa20 > 0 ? compositeMa20 / previousMa20 - 1 : null,
        industry_rising_ratio: common > 0 ? rising / common : null,
        industry_adx14_median: adxValues.length ? median(adxValues) : null,
      };
      priorBoardCloses = new Map(boardBars.map(bar => [bar.code, bar.close]));
    }
    const day: StandardDay = { date, bars: stockBars, market_recovery: marketRecovery,
      ...(marketFactors ? { market_factors: marketFactors } : {}), environment_bars: boardBars, ...(benchmark ? {benchmark} : {}) };
    const json = canonicalJson(day);
    const rawBytes = Buffer.byteLength(json);
    if (rawBytes > STANDARD_CHUNK_BYTES) { addGap({ code: "CAPACITY_EXCEEDED", domain: "chunk", severity: "error", date, message: "日输入超过8MiB预算" }); break; }
    const payload = gzipSync(json);
    bytes += payload.length;
    if (bytes > INPUT_BYTES_LIMIT) { addGap({ code: "CAPACITY_EXCEEDED", domain: "input", severity: "error", message: "首批冻结输入压缩后超过128MiB预算" }); break; }
    const hash = contentHash(day);
    manifest.row_count += result.rows.length;
    manifest.day_count++;
    manifest.chunks.push({ date, sha256: hash, bytes: rawBytes, rows: result.rows.length });
    if (retainChunks) chunks.push({ day: date, hash, rawBytes, rows: result.rows.length, payload });
  }
  aborted();
  if (suspensionDays > 0) {
    addGap({ code: "POINT_IN_TIME_UNVERIFIED", domain: "suspension", severity: "warning",
      message: `缺失或零量日线按停牌近似处理（区间内共 ${suspensionDays} 例）；未区分真实停牌与数据缺口，未接入历史停牌状态` });
  }
  const report: StandardPreflight = {
    executable: !gaps.some(gap => gap.severity === "error"), plan, plan_hash: contentHash(plan), manifest,
    input_hash: contentHash(manifest), estimated_compressed_bytes: bytes, evidence_status: "research_only",
  };
  return { report, chunks };
}

/** 每块在公开给内核之前校验编码、大小、哈希和日期；不信任数据库中被替换的载荷。 */
export function decodeStandardChunk(row: { payload: Buffer; encoding: string; raw_bytes: number; sha256: string; trade_date: string }): StandardDay {
  if (row.encoding !== "gzip-json-v1" || row.raw_bytes < 1 || row.raw_bytes > STANDARD_CHUNK_BYTES || row.payload.length > STANDARD_CHUNK_BYTES) throw new Error("冻结输入块预算或编码非法");
  const raw = gunzipSync(row.payload, { maxOutputLength: STANDARD_CHUNK_BYTES });
  if (raw.length !== row.raw_bytes) throw new Error("冻结输入块大小不符");
  const day = JSON.parse(raw.toString("utf8")) as StandardDay;
  if (contentHash(day) !== row.sha256 || day.date !== row.trade_date || !Array.isArray(day.bars)) throw new Error("冻结输入块内容校验失败");
  return day;
}
