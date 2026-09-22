import crypto from "node:crypto";
import type pg from "pg";
import { fetchCorporateActions, fetchValuationSnapshots } from "../../datasource/hithink.js";
import { fetchBatchIsolated } from "../../datasource/batch-isolation.js";
import { syncBoardMembership } from "../../datasource/catalog-service.js";
import { fetchAndStore, fetchFinancialAndStore, insertFetchRun, storeCorporateActions } from "../../datasource/service.js";

export const VALUE_RANK_VERSION = "value-rank-v2";
export const VALUE_INDUSTRY_CODES = [
  "881145.TI", "881146.TI", "881148.TI", "881155.TI", "881156.TI", "884154.TI", "884268.TI",
] as const;
const CSI300_CODE = "000300.SH";
const MIN_MEDIAN_TURNOVER = 150_000_000;

type Db = Pick<pg.Pool, "query">;
export interface CandidateRow {
  id: string; code: string; name: string; industryCode: string | null; industryName: string | null;
  inValue: boolean; inCsi300: boolean; medianTurnover60: number | null; formal: boolean;
}

function daysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

export async function ensureCsi300Board(db: Db): Promise<void> {
  await db.query(
    `INSERT INTO market_board (instrument_id, board_type, source, active)
     SELECT id, 'special', 'hithink', true FROM market_instrument WHERE code=$1
     ON CONFLICT (instrument_id) DO UPDATE SET board_type='special', source='hithink', active=true, updated_at=now()`,
    [CSI300_CODE],
  );
}

export async function listValueCandidates(db: Db, asOf: string): Promise<CandidateRow[]> {
  const rows = await db.query<{
    id: string; code: string; name: string; industry_code: string | null; industry_name: string | null;
    in_value: boolean; in_csi300: boolean; median_turnover_60: number | null; turnover_count_60: number;
  }>(
    `WITH value_members AS (
       SELECT DISTINCT ON (membership.member_instrument_id)
              membership.member_instrument_id AS instrument_id,
              industry.code AS industry_code, industry.name AS industry_name
         FROM market_board_membership membership
         JOIN market_instrument industry ON industry.id=membership.board_instrument_id
        WHERE industry.code=ANY($1::text[])
          AND membership.effective_from <= $2::date
          AND (membership.effective_to IS NULL OR membership.effective_to > $2::date)
        ORDER BY membership.member_instrument_id,industry.code
     ), csi_members AS (
       SELECT membership.member_instrument_id AS instrument_id
         FROM market_board_membership membership
         JOIN market_instrument board ON board.id=membership.board_instrument_id
        WHERE board.code=$3 AND membership.effective_from <= $2::date
          AND (membership.effective_to IS NULL OR membership.effective_to > $2::date)
     ), universe AS (
       SELECT instrument_id FROM value_members UNION SELECT instrument_id FROM csi_members
     ), turnover AS (
       SELECT universe.instrument_id,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY recent.turnover::float8)::float8 AS median_turnover_60,
              count(recent.turnover)::int AS turnover_count_60
         FROM universe LEFT JOIN LATERAL
           (SELECT bar.turnover FROM market_bar bar
             WHERE bar.instrument_id=universe.instrument_id AND bar.freq='day'
               AND bar.bar_date <= $2::date AND bar.turnover > 0
             ORDER BY bar.bar_date DESC LIMIT 60) recent ON true
        GROUP BY universe.instrument_id
     )
     SELECT instrument.id::text,instrument.code,instrument.name,
            value_members.industry_code,value_members.industry_name,
            value_members.instrument_id IS NOT NULL AS in_value,
            csi_members.instrument_id IS NOT NULL AS in_csi300,
            turnover.median_turnover_60,turnover.turnover_count_60
       FROM universe JOIN market_instrument instrument ON instrument.id=universe.instrument_id
       LEFT JOIN value_members ON value_members.instrument_id=universe.instrument_id
       LEFT JOIN csi_members ON csi_members.instrument_id=universe.instrument_id
       LEFT JOIN turnover ON turnover.instrument_id=universe.instrument_id
      WHERE instrument.kind='stock' AND instrument.lifecycle_status='active'
        AND instrument.name !~* '^\\*?ST' ORDER BY instrument.code`,
    [[...VALUE_INDUSTRY_CODES], asOf, CSI300_CODE],
  );
  const nonCsiTurnovers = rows.rows.filter((row) => row.in_value && !row.in_csi300 && row.median_turnover_60 !== null && row.turnover_count_60 >= 60)
    .map((row) => Number(row.median_turnover_60)).sort((a, b) => a - b);
  const median = nonCsiTurnovers.length ? nonCsiTurnovers[Math.floor((nonCsiTurnovers.length - 1) * 0.5)]! : MIN_MEDIAN_TURNOVER;
  const threshold = Math.max(MIN_MEDIAN_TURNOVER, median);
  return rows.rows.map((row) => ({
    id: row.id, code: row.code, name: row.name, industryCode: row.industry_code, industryName: row.industry_name,
    inValue: row.in_value, inCsi300: row.in_csi300,
    medianTurnover60: row.median_turnover_60 === null ? null : Number(row.median_turnover_60),
    formal: row.in_csi300 || Boolean(row.in_value && row.turnover_count_60 >= 60 && Number(row.median_turnover_60 ?? 0) >= threshold),
  }));
}

export interface ValueCandidateSyncSummary {
  sourceCount: number; formalCount: number; financialSynced: number; valuationSynced: number;
  corporateActionSynced: number; barSynced?: number; fetchRunIds: string[]; gaps: Array<{ code: string; domain: string; reason: string }>;
}

export async function syncValueCandidates(
  db: pg.Pool,
  targetDate: string,
  deps: { jobRunId?: string } = {},
): Promise<ValueCandidateSyncSummary> {
  await ensureCsi300Board(db);
  const membership = await syncBoardMembership(db, CSI300_CODE, targetDate, { db, jobRunId: deps.jobRunId });
  const candidates = await listValueCandidates(db, targetDate);
  const gaps: ValueCandidateSyncSummary["gaps"] = [];
  let financialSynced = 0;
  let valuationSynced = 0;
  let corporateActionSynced = 0;
  let barSynced = 0;
  let rateLimited = false;
  const latestOpen = await db.query<{ date: string }>(
    `SELECT max(trade_date)::text AS date FROM market_trading_day WHERE is_open AND trade_date <= $1::date`, [targetDate],
  );
  const barDate = latestOpen.rows[0]?.date;
  if (!barDate) gaps.push({ code: "*", domain: "daily_bar", reason: "缺少已确认交易日，无法校验候选日线" });
  else {
    const missingBars = await db.query<{ code: string }>(
      `SELECT instrument.code FROM market_instrument instrument
        WHERE instrument.id=ANY($1::bigint[]) AND (
          NOT EXISTS (SELECT 1 FROM market_bar bar WHERE bar.instrument_id=instrument.id AND bar.freq='day'
            AND bar.bar_date=$2::date AND bar.close>0)
          OR (SELECT count(DISTINCT bar.bar_date) FROM market_bar bar WHERE bar.instrument_id=instrument.id
            AND bar.freq='day' AND bar.bar_date<=$2::date) < 250)
        ORDER BY instrument.code`, [candidates.map((item) => item.id), barDate],
    );
    for (const [index, row] of missingBars.rows.entries()) {
      try {
        const outcome = await fetchAndStore(db, { code: row.code, freq: "day", start: daysBefore(barDate, 400), end: barDate },
          { jobRunId: deps.jobRunId });
        barSynced += outcome.rowsWritten;
        if (outcome.rowsWritten === 0) gaps.push({ code: row.code, domain: "daily_bar", reason: "日线请求没有返回有效数据" });
      } catch (error) {
        gaps.push({ code: row.code, domain: "daily_bar", reason: (error as Error).message });
        if (/429|4001|request limit exceeded/i.test((error as Error).message)) {
          gaps.push({ code: "*", domain: "daily_bar", reason: `数据源限流，剩余 ${missingBars.rows.length - index - 1} 只待下次补齐` });
          rateLimited = true;
          break;
        }
      }
    }
  }
  const staleFundamental = await db.query<{ code: string }>(
    `SELECT instrument.code FROM market_instrument instrument
      WHERE instrument.id=ANY($1::bigint[]) AND NOT EXISTS (
        SELECT 1 FROM fundamental_snapshot snapshot
         WHERE snapshot.instrument_id=instrument.id AND snapshot.source='hithink'
           AND (snapshot.as_of_date >= $2::date OR snapshot.created_at >= $3::date)) ORDER BY instrument.code`,
    [candidates.map((item) => item.id), daysBefore(targetDate, 180), daysBefore(targetDate, 35)],
  );
  for (const row of rateLimited ? [] : staleFundamental.rows) {
    try {
      const result = await fetchFinancialAndStore(db, { code: row.code }, { jobRunId: deps.jobRunId });
      financialSynced += result.fundamentalRows;
    } catch (error) {
      gaps.push({ code: row.code, domain: "fundamental", reason: (error as Error).message });
      if (/429|4001|request limit exceeded/i.test((error as Error).message)) { rateLimited = true; break; }
    }
  }
  for (let offset = 0; !rateLimited && offset < candidates.length; offset += 100) {
    const batch = candidates.slice(offset, offset + 100);
    let quotes: Awaited<ReturnType<typeof fetchValuationSnapshots>> = [];
    try {
      const isolated = await fetchBatchIsolated(batch.map((item) => item.code), (codes) =>
        fetchValuationSnapshots(codes, { db, priority: "scheduled-low" }));
      quotes = isolated.rows;
      for (const code of isolated.skipped) gaps.push({ code, domain: "valuation", reason: "该标的估值快照不可用" });
      const returned = new Set(quotes.map((quote) => quote.code));
      for (const item of batch) {
        if (!returned.has(item.code) && !isolated.skipped.includes(item.code))
          gaps.push({ code: item.code, domain: "valuation", reason: "批量估值未返回该标的" });
      }
    } catch (error) {
      gaps.push({ code: `batch:${offset}`, domain: "valuation", reason: (error as Error).message });
      if (/429|4001|request limit exceeded/i.test((error as Error).message)) rateLimited = true;
      continue;
    }
    for (const quote of quotes) {
      const instrument = batch.find((item) => item.code === quote.code);
      if (!instrument) continue;
      try {
        const result = await db.query(
          `INSERT INTO valuation_snapshot (instrument_id,as_of_date,pe_ttm,pb,ps_ttm,source,raw_summary)
           VALUES ($1,$2,$3,$4,$5,'hithink',$6)
           ON CONFLICT (instrument_id,as_of_date) DO UPDATE SET pe_ttm=EXCLUDED.pe_ttm,pb=EXCLUDED.pb,
             ps_ttm=EXCLUDED.ps_ttm,source=EXCLUDED.source,raw_summary=EXCLUDED.raw_summary`,
          [instrument.id, quote.asOfDate, quote.peTtm, quote.pb, quote.psTtm, JSON.stringify(quote.rawSummary)],
        );
        valuationSynced += result.rowCount ?? 0;
      } catch {
        gaps.push({ code: quote.code, domain: "valuation", reason: "该标的估值落库失败" });
      }
    }
  }
  const dueActions = await db.query<{ id: string; code: string; latest_ex_date: string | null }>(
    `SELECT instrument.id::text,instrument.code,state.latest_ex_date::text
       FROM market_instrument instrument
       LEFT JOIN market_corporate_action_sync_state state ON state.instrument_id=instrument.id
      WHERE instrument.id=ANY($1::bigint[])
        AND (state.last_checked_at IS NULL OR state.last_checked_at < now()-interval '6 days')
      ORDER BY instrument.code`, [candidates.map((item) => item.id)],
  );
  for (const row of rateLimited ? [] : dueActions.rows) {
    try {
      const from = row.latest_ex_date ? daysBefore(row.latest_ex_date, -1) : "2017-01-01";
      const actions = await fetchCorporateActions(row.code, from, targetDate, { db, priority: "scheduled-low" });
      corporateActionSynced += await storeCorporateActions(db, row.code, actions);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("No adjustment events")) {
        await db.query(
          `INSERT INTO market_corporate_action_sync_state (instrument_id,last_checked_at,status,last_error)
           VALUES ($1,now(),'empty',NULL) ON CONFLICT (instrument_id) DO UPDATE SET last_checked_at=now(),
             status='empty',last_error=NULL,updated_at=now()`, [row.id],
        );
      } else {
        gaps.push({ code: row.code, domain: "corporate_action", reason: message });
        await db.query(
          `INSERT INTO market_corporate_action_sync_state (instrument_id,last_checked_at,status,last_error)
           VALUES ($1,now(),'failed',$2) ON CONFLICT (instrument_id) DO UPDATE SET last_checked_at=now(),
             status='failed',last_error=EXCLUDED.last_error,updated_at=now()`, [row.id, message],
        );
        if (/429|4001|request limit exceeded/i.test(message)) { rateLimited = true; break; }
      }
    }
  }
  if (rateLimited) gaps.push({ code: "*", domain: "provider", reason: "数据源限流，本次同步提前终止，未完成项目待下次补齐" });
  const fetchRunId = await insertFetchRun(db, {
    jobRunId: deps.jobRunId, channel: "hithink",
    scope: { pipeline: "value_candidate_sync", target_date: targetDate, source_count: candidates.length },
    rowsWritten: barSynced + financialSynced + valuationSynced + corporateActionSynced, gaps,
  });
  return {
    sourceCount: candidates.length, formalCount: candidates.filter((item) => item.formal).length,
    financialSynced, valuationSynced, corporateActionSynced, barSynced,
    fetchRunIds: [membership.fetchRunId, fetchRunId], gaps,
  };
}

function percentile(values: number[], value: number, lowerIsBetter = false): number {
  if (!values.length) return 0;
  const passed = values.filter((item) => lowerIsBetter ? item >= value : item <= value).length;
  return 100 * passed / values.length;
}
function clamp(value: number, minimum = 0, maximum = 100): number { return Math.max(minimum, Math.min(maximum, value)); }

export async function generateValueMonthlyRank(db: Db, analysisRunId: string, rankDate: string) {
  const candidates = await listValueCandidates(db, rankDate);
  if (!candidates.some((item) => item.inCsi300) || !candidates.some((item) => item.inValue)) {
    throw new Error("沪深300或稳定价值行业成员缺失，拒绝生成不完整的月度排名");
  }
  const rows = await db.query<Record<string, unknown>>(
    `SELECT instrument.id::text,instrument.code,instrument.name,
            latest_bar.bar_date::text,latest_bar.close::float8,turnover.median_turnover_60::float8,
            fundamental.as_of_date::text AS fundamental_date,fundamental.net_profit::float8,
            fundamental.operating_cashflow::float8,fundamental.roe::float8,fundamental.debt_ratio::float8,
            previous.net_profit::float8 AS previous_net_profit,
            valuation.as_of_date::text AS valuation_date,valuation.pe_ttm::float8,valuation.pb::float8,valuation.ps_ttm::float8,
            action.latest_ex_date::text,action.dividend_ttm::float8,action.dividend_years_3y::int
       FROM market_instrument instrument
       LEFT JOIN LATERAL (SELECT bar_date,COALESCE(close_raw,close) AS close FROM market_bar WHERE instrument_id=instrument.id AND freq='day'
         AND bar_date <= $2::date ORDER BY bar_date DESC,bar_time DESC LIMIT 1) latest_bar ON true
       LEFT JOIN LATERAL (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY turnover)::float8 AS median_turnover_60
         FROM (SELECT turnover FROM market_bar WHERE instrument_id=instrument.id AND freq='day' AND bar_date <= $2::date
           AND turnover>0 ORDER BY bar_date DESC LIMIT 60) x) turnover ON true
       LEFT JOIN LATERAL (SELECT * FROM fundamental_snapshot WHERE instrument_id=instrument.id AND source='hithink'
         AND as_of_date <= $2::date ORDER BY as_of_date DESC,report_period DESC LIMIT 1) fundamental ON true
       LEFT JOIN LATERAL (SELECT * FROM fundamental_snapshot WHERE instrument_id=instrument.id AND source='hithink'
         AND as_of_date <= $2::date ORDER BY as_of_date DESC,report_period DESC OFFSET 1 LIMIT 1) previous ON true
       LEFT JOIN LATERAL (SELECT * FROM valuation_snapshot WHERE instrument_id=instrument.id AND source='hithink'
         AND as_of_date <= $2::date ORDER BY as_of_date DESC LIMIT 1) valuation ON true
       LEFT JOIN LATERAL (
         SELECT max(ex_date) AS latest_ex_date,
                sum(dividend_per_share) FILTER (WHERE ex_date > $2::date-interval '366 days') AS dividend_ttm,
                count(DISTINCT extract(year FROM ex_date)) FILTER (WHERE ex_date > $2::date-interval '3 years'
                  AND dividend_per_share>0) AS dividend_years_3y
           FROM market_corporate_action WHERE instrument_id=instrument.id AND ex_date <= $2::date) action ON true
      WHERE instrument.id=ANY($1::bigint[]) ORDER BY instrument.code`,
    [candidates.map((item) => item.id), rankDate],
  );
  const formalIds = new Set(candidates.filter((item) => item.formal).map((item) => item.id));
  const currentBars = rows.rows.filter((row) => formalIds.has(String(row.id)) && row.bar_date === rankDate).length;
  if (currentBars < Math.ceil(formalIds.size * 0.9)) {
    throw new Error(`月末行情覆盖不足：${currentBars}/${formalIds.size}，拒绝激活不完整排名`);
  }
  const candidateById = new Map(candidates.map((item) => [item.id, item]));
  const prepared = rows.rows.map((row) => {
    const candidate = candidateById.get(String(row.id))!;
    const industry = candidate.industryName ?? "沪深300通用";
    const adapter = ["银行", "保险"].includes(industry) ? "financial"
      : candidate.inValue ? "stable_cashflow" : "csi300_general";
    const gaps = [] as string[];
    if (row.bar_date !== rankDate) gaps.push("缺少目标日收盘价");
    if (!row.fundamental_date || row.fundamental_date < daysBefore(rankDate, 540)) gaps.push("缺少有效期内财务");
    if (!row.valuation_date || row.valuation_date < daysBefore(rankDate, 35)) gaps.push("缺少近35日估值");
    if (candidate.inValue && row.latest_ex_date === null) gaps.push("缺少历史现金分红");
    if (row.valuation_date && row.pe_ttm === null && row.pb === null && row.ps_ttm === null) gaps.push("估值指标全部为空");
    const close = Number(row.close ?? 0), dividend = Number(row.dividend_ttm ?? 0);
    const dividendYield = close > 0 ? dividend / close : null;
    const profitTrend = Number(row.previous_net_profit ?? 0) > 0
      ? Number(row.net_profit ?? 0) / Number(row.previous_net_profit) - 1 : null;
    const qualityPassed = Number(row.net_profit ?? -1) > 0 && Number(row.roe ?? -1) > 0
      && (adapter === "financial" || (Number(row.operating_cashflow ?? -1) > 0 && Number(row.debt_ratio ?? 101) <= 85));
    const status = gaps.length ? "data_missing" : !candidate.formal ? "liquidity_ineligible"
      : !qualityPassed ? "quality_failed" : "eligible";
    return { row, candidate, industry, adapter, gaps, dividendYield, profitTrend, status };
  });
  const completeFormal = prepared.filter((item) => item.candidate.formal && item.status !== "data_missing").length;
  if (completeFormal < Math.ceil(formalIds.size * 0.9)) {
    throw new Error(`正式候选输入覆盖不足：${completeFormal}/${formalIds.size}，拒绝激活不完整排名`);
  }
  const eligible = prepared.filter((item) => item.status === "eligible");
  const groups = new Map<string, typeof eligible>();
  for (const item of eligible) groups.set(item.adapter, [...(groups.get(item.adapter) ?? []), item]);
  const scores = new Map<string, { quality: number; value: number; total: number; adapterRank: number }>();
  for (const [adapter, items] of groups) {
    const roeValues = items.map((item) => Number(item.row.roe ?? 0));
    const dividendValues = items.map((item) => Number(item.dividendYield ?? 0));
    const peValues = items.map((item) => Number(item.row.pe_ttm ?? 0)).filter((value) => value > 0);
    const pbValues = items.map((item) => Number(item.row.pb ?? 0)).filter((value) => value > 0);
    const temporary = items.map((item) => {
      const roeScore = percentile(roeValues, Number(item.row.roe ?? 0));
      const profitScore = clamp(50 + 100 * Number(item.profitTrend ?? 0));
      const cashScore = adapter === "financial" ? profitScore : (Number(item.row.operating_cashflow ?? 0) > 0 ? 100 : 0);
      const debtScore = adapter === "financial" ? 50 : clamp(100 - Number(item.row.debt_ratio ?? 100));
      const dividendScore = percentile(dividendValues, Number(item.dividendYield ?? 0));
      const peScore = Number(item.row.pe_ttm ?? 0) > 0 ? percentile(peValues, Number(item.row.pe_ttm), true) : 0;
      const pbScore = Number(item.row.pb ?? 0) > 0 ? percentile(pbValues, Number(item.row.pb), true) : 0;
      const quality = adapter === "financial" ? 0.6 * roeScore + 0.4 * profitScore
        : adapter === "stable_cashflow" ? 0.35 * roeScore + 0.3 * cashScore + 0.2 * profitScore + 0.15 * debtScore
          : 0.4 * roeScore + 0.3 * cashScore + 0.3 * profitScore;
      const value = adapter === "financial" ? 0.45 * pbScore + 0.25 * peScore + 0.3 * dividendScore
        : adapter === "stable_cashflow" ? 0.5 * dividendScore + 0.3 * peScore + 0.2 * pbScore
          : 0.45 * peScore + 0.35 * pbScore + 0.2 * dividendScore;
      return { item, quality, value, total: 0.4 * quality + 0.6 * value };
    }).sort((left, right) => right.total - left.total || left.item.candidate.code.localeCompare(right.item.candidate.code));
    temporary.forEach((entry, index) => scores.set(entry.item.candidate.id, {
      quality: entry.quality, value: entry.value, total: entry.total, adapterRank: index + 1,
    }));
  }
  const ranked = eligible.map((item) => ({ item, score: scores.get(item.candidate.id)! }))
    .sort((left, right) => right.score.total - left.score.total || right.score.quality - left.score.quality
      || left.item.candidate.code.localeCompare(right.item.candidate.code));
  const overallRanks = new Map(ranked.map((entry, index) => [entry.item.candidate.id, index + 1]));
  const nextDay = await db.query<{ date: string }>(
    `SELECT trade_date::text AS date FROM market_trading_day WHERE is_open AND trade_date>$1::date ORDER BY trade_date LIMIT 1`, [rankDate],
  );
  if (!nextDay.rows[0]) throw new Error("缺少排名后首个开市日，拒绝提前生效");
  const effectiveFrom = nextDay.rows[0].date;
  const payload = prepared.map((item) => {
    const score = scores.get(item.candidate.id);
    const rank = overallRanks.get(item.candidate.id) ?? null;
    const level = rank === null ? null : rank <= 5 ? "core" : rank <= 10 ? "strong" : rank <= 50 ? "candidate" : "eligible";
    return { item, score, rank, level };
  });
  const inputHash = crypto.createHash("sha256").update(JSON.stringify(payload.map((entry) => ({
    code: entry.item.candidate.code, status: entry.item.status, row: entry.item.row,
  })))).digest("hex");
  for (const entry of payload) {
    const { item } = entry;
    await db.query(
      `INSERT INTO value_rank_snapshot
       (analysis_run_id,rank_date,effective_from,instrument_id,industry_code,industry_name,source_flags,adapter,
        eligibility_status,bar_date,fundamental_date,valuation_date,corporate_action_date,median_turnover_60,
        dividend_yield_ttm,dividend_years_3y,roe,profit_trend,operating_cashflow,debt_ratio,pe_ttm,pb,ps_ttm,
        quality_score,value_score,total_score,rank_in_adapter,rank_overall,candidate_level,data_gaps,
        calculation_version,input_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
               $24,$25,$26,$27,$28,$29,$30,$31,$32)`,
      [analysisRunId, rankDate, effectiveFrom, item.candidate.id, item.candidate.industryCode, item.candidate.industryName,
        JSON.stringify([...(item.candidate.inValue ? ["stable_value"] : []), ...(item.candidate.inCsi300 ? ["csi300"] : [])]),
        item.adapter, item.status, item.row.bar_date ?? null, item.row.fundamental_date ?? null,
        item.row.valuation_date ?? null, item.row.latest_ex_date ?? null, item.candidate.medianTurnover60,
        item.dividendYield, Number(item.row.dividend_years_3y ?? 0), item.row.roe ?? null, item.profitTrend,
        item.row.operating_cashflow ?? null, item.row.debt_ratio ?? null, item.row.pe_ttm ?? null,
        item.row.pb ?? null, item.row.ps_ttm ?? null, entry.score?.quality ?? null, entry.score?.value ?? null,
        entry.score?.total ?? null, entry.score?.adapterRank ?? null, entry.rank, entry.level,
        JSON.stringify(item.gaps), VALUE_RANK_VERSION, inputHash],
    );
  }
  return {
    result: {
      rank_date: rankDate, effective_from: effectiveFrom, source_count: candidates.length,
      formal_count: candidates.filter((item) => item.formal).length, eligible_count: eligible.length,
      skipped: prepared.filter((item) => item.gaps.length).map((item) => ({ code: item.candidate.code, gaps: item.gaps })),
      top50: ranked.slice(0, 50).map((entry, index) => ({
        rank: index + 1, code: entry.item.candidate.code, name: entry.item.candidate.name,
        industry: entry.item.industry, adapter: entry.item.adapter,
        quality_score: Number(entry.score.quality.toFixed(2)), value_score: Number(entry.score.value.toFixed(2)),
        total_score: Number(entry.score.total.toFixed(2)),
      })),
    },
    // 完整覆盖已通过九成门禁；其余单股缺口只保留在快照行和结果的 skipped 中。
    gaps: [],
    input: { source_count: candidates.length, formal_count: candidates.filter((item) => item.formal).length,
      eligible_count: eligible.length, input_sha256: inputHash },
  };
}

export async function queryValueRank(db: Db, options: { asOf?: string; limit?: number; codes?: string[] } = {}) {
  const limit = Math.min(50, Math.max(1, options.limit ?? 50));
  const run = await db.query<{ id: string; rank_date: string; effective_from: string }>(
    `SELECT analysis_run_id::text AS id,rank_date::text,effective_from::text
       FROM value_rank_snapshot snapshot JOIN analysis_run run ON run.id=snapshot.analysis_run_id
      WHERE snapshot.effective_from <= COALESCE($1::date,current_date)
        AND run.status IN ('success','partial')
       ORDER BY snapshot.effective_from DESC,snapshot.analysis_run_id DESC LIMIT 1`, [options.asOf ?? null],
  );
  if (!run.rows[0]) return { status: "missing" as const, items: [], gaps: ["尚无生效的月度价值排名"] };
  const rows = await db.query<Record<string, unknown>>(
    `SELECT snapshot.rank_overall,snapshot.candidate_level,instrument.code,instrument.name,snapshot.industry_name,
            snapshot.adapter,snapshot.quality_score::float8,snapshot.value_score::float8,snapshot.total_score::float8,
            snapshot.dividend_yield_ttm::float8,snapshot.data_gaps
       FROM value_rank_snapshot snapshot JOIN market_instrument instrument ON instrument.id=snapshot.instrument_id
      WHERE snapshot.analysis_run_id=$1 AND snapshot.rank_overall IS NOT NULL
        AND ($2::text[] IS NULL OR instrument.code=ANY($2::text[]))
      ORDER BY snapshot.rank_overall LIMIT $3`, [run.rows[0].id, options.codes ?? null, limit],
  );
  return { status: "success" as const, ...run.rows[0], items: rows.rows, gaps: [] };
}
