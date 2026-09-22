import type pg from "pg";
import { queryValueRank } from "../value-ranking/service.js";

type Db = Pick<pg.Pool, "query">;
function mean(values: number[]): number | null { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }

export async function queryValueAnchorSignals(db: Db, date: string) {
  const rank = await queryValueRank(db, { asOf: date, limit: 10 });
  if (rank.status !== "success") return { status: "missing", date, rank, qualified: [], near: [], rejected: [], gaps: rank.gaps };
  if (String(rank.rank_date).slice(0, 7) !== new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7)
    && String(rank.rank_date).slice(0, 7) !== date.slice(0, 7)) {
    return { status: "unavailable", date, rank_date: rank.rank_date, qualified: [], near: [], rejected: [],
      gaps: [{ domain: "rank", reason: "月度排名已过期，拒绝使用旧Top" }] };
  }
  const rankItems = rank.items as Array<Record<string, unknown>>;
  const codes = rankItems.map((item) => String(item.code));
  const bars = await db.query<{
    code: string; name: string; industry_name: string | null; bar_date: string;
    open: number; high: number; low: number; close: number;
  }>(
    `WITH ranked AS (
       SELECT instrument.code,instrument.name,industry.name AS industry_name,bar.bar_date::text,
              COALESCE(bar.open_raw,bar.open)::float8 AS open,COALESCE(bar.high_raw,bar.high)::float8 AS high,
              COALESCE(bar.low_raw,bar.low)::float8 AS low,COALESCE(bar.close_raw,bar.close)::float8 AS close,
              row_number() OVER (PARTITION BY instrument.id ORDER BY bar.bar_date DESC,bar.bar_time DESC) AS rn
         FROM market_instrument instrument JOIN market_bar bar ON bar.instrument_id=instrument.id AND bar.freq='day'
         LEFT JOIN LATERAL (
           SELECT board_instrument.name FROM market_board_membership membership
           JOIN market_board board ON board.instrument_id=membership.board_instrument_id AND board.active AND board.board_type='industry'
           JOIN market_instrument board_instrument ON board_instrument.id=board.instrument_id
           WHERE membership.member_instrument_id=instrument.id AND membership.effective_from <= $2::date
             AND (membership.effective_to IS NULL OR membership.effective_to > $2::date)
           ORDER BY membership.effective_from DESC LIMIT 1) industry ON true
        WHERE instrument.code=ANY($1::text[]) AND bar.bar_date <= $2::date)
     SELECT code,name,industry_name,bar_date,open,high,low,close FROM ranked WHERE rn<=250 ORDER BY code,bar_date`,
    [codes, date],
  );
  const byCode = new Map<string, typeof bars.rows>();
  for (const row of bars.rows) byCode.set(row.code, [...(byCode.get(row.code) ?? []), row]);
  const actions = await db.query<{ code: string; ex_date: string; dividend_per_share: number }>(
    `SELECT instrument.code,action.ex_date::text,action.dividend_per_share::float8
       FROM market_corporate_action action JOIN market_instrument instrument ON instrument.id=action.instrument_id
      WHERE instrument.code=ANY($1::text[]) AND action.ex_date <= $2::date
        AND action.ex_date > $2::date-interval '3 years 366 days' ORDER BY instrument.code,action.ex_date`, [codes, date],
  );
  const actionsByCode = new Map<string, typeof actions.rows>();
  for (const row of actions.rows) actionsByCode.set(row.code, [...(actionsByCode.get(row.code) ?? []), row]);
  const qualityRows = await db.query<{ code: string; fundamental_date: string | null; net_profit: number | null; roe: number | null; operating_cashflow: number | null; debt_ratio: number | null }>(
    `SELECT instrument.code,latest.as_of_date::text AS fundamental_date,latest.net_profit::float8,latest.roe::float8,
            latest.operating_cashflow::float8,latest.debt_ratio::float8
       FROM market_instrument instrument LEFT JOIN LATERAL (
         SELECT as_of_date,net_profit,roe,operating_cashflow,debt_ratio FROM fundamental_snapshot
          WHERE instrument_id=instrument.id AND source='hithink' AND as_of_date <= $2::date
          ORDER BY as_of_date DESC,report_period DESC,id DESC LIMIT 1) latest ON true
      WHERE instrument.code=ANY($1::text[])`, [codes, date],
  );
  const qualityByCode = new Map(qualityRows.rows.map((row) => [row.code, row]));
  const actionState = await db.query<{ code: string; last_checked_at: string; status: string }>(
    `SELECT instrument.code,state.last_checked_at::text,state.status
       FROM market_instrument instrument JOIN market_corporate_action_sync_state state
         ON state.instrument_id=instrument.id
      WHERE instrument.code=ANY($1::text[])`, [codes],
  );
  const actionStateByCode = new Map(actionState.rows.map((row) => [row.code, row]));
  const reviewDate = await db.query<{ date: string }>(
    `SELECT trade_date::text AS date FROM market_trading_day WHERE is_open AND trade_date>$1::date ORDER BY trade_date OFFSET 19 LIMIT 1`, [date],
  );
  const qualified: unknown[] = [], near: unknown[] = [], rejected: unknown[] = [], gaps: unknown[] = [];
  const skipped: Array<{ code: string; reason: string }> = [];
  if (!reviewDate.rows[0]) gaps.push({ domain: "calendar", reason: "未来20个开市日尚未确认，复核日期暂缺但不阻断当日扫描" });
  for (const item of rankItems) {
    const code = String(item.code), series = byCode.get(code) ?? [];
    if (series.length < 250 || series.at(-1)?.bar_date !== date) {
      skipped.push({ code, reason: `目标日未复权日线不足250根或数据日不符（${series.at(-1)?.bar_date ?? "无"}）` }); continue;
    }
    const state = actionStateByCode.get(code);
    const lastChecked = state ? state.last_checked_at.slice(0, 10) : null;
    if (!lastChecked || lastChecked > date || Date.parse(`${date}T00:00:00Z`) - Date.parse(`${lastChecked}T00:00:00Z`) > 10 * 86_400_000 || state?.status === "failed") {
      skipped.push({ code, reason: "公司行动数据超过10天未同步" }); continue;
    }
    const quality = qualityByCode.get(code);
    if (!quality || !quality.fundamental_date || quality.fundamental_date < new Date(Date.parse(`${date}T00:00:00Z`) - 540 * 86_400_000).toISOString().slice(0, 10) || quality.net_profit === null || quality.roe === null) {
      skipped.push({ code, reason: "目标日有效期内财务质量缺失" }); continue;
    }
    const current = series.at(-1)!, closes = series.map((row) => row.close);
    const ma250 = mean(closes.slice(-250))!, high20 = Math.max(...closes.slice(-20));
    const return5 = current.close / closes.at(-6)! - 1, drawdown20 = current.close / high20 - 1;
    const actionRows = actionsByCode.get(code) ?? [], now = Date.parse(`${date}T00:00:00Z`);
    const dividendTtm = actionRows.filter((row) => Date.parse(`${row.ex_date}T00:00:00Z`) > now - 366 * 86_400_000)
      .reduce((sum, row) => sum + Number(row.dividend_per_share), 0);
    const dividendYield = current.close > 0 ? dividendTtm / current.close : 0;
    const dividendYears = new Set(actionRows.filter((row) => Number(row.dividend_per_share) > 0)
      .map((row) => row.ex_date.slice(0, 4))).size;
    const cooldown = actionRows.some((row) => {
      const ex = Date.parse(`${row.ex_date}T00:00:00Z`);
      return Number(row.dividend_per_share) > 0 && now >= ex && now - ex <= 3 * 86_400_000;
    });
    const conditions = {
      top10: Number(item.rank_overall) <= 10,
      eligible_adapter: item.adapter !== "csi300_general",
      quality_still_valid: quality.net_profit > 0 && quality.roe > 0
        && (item.adapter === "financial" || ((quality.operating_cashflow ?? -1) > 0 && (quality.debt_ratio ?? 101) <= 85)),
      dividend_yield: dividendYield >= 0.03,
      dividend_continuity: dividendYears >= 3,
      below_ma250: current.close / ma250 - 1 <= -0.10,
      drawdown20: drawdown20 <= -0.10 && drawdown20 > -0.30,
      decline5: return5 <= -0.04,
      ex_dividend_cooldown: !cooldown,
    };
    const failed = Object.entries(conditions).filter(([, passed]) => !passed).map(([name]) => name);
    const evidence = {
      code, name: item.name, industry: item.industry_name ?? current.industry_name,
      rank: item.rank_overall, candidate_level: item.candidate_level,
      rank_date: rank.rank_date, bar_date: current.bar_date,
      dividend_yield_ttm: dividendYield, dividend_years_3y: dividendYears,
      ma250_deviation: current.close / ma250 - 1, drawdown_20: drawdown20, return_5: return5,
      ex_dividend_cooldown: cooldown, conditions, failed_conditions: failed,
      recommended_addon_pct: 0.10, review_date: reviewDate.rows[0]?.date ?? null,
    };
    if (!failed.length) qualified.push(evidence);
    else if (failed.length === 1 && ["below_ma250", "drawdown20", "decline5"].includes(failed[0]!)) near.push(evidence);
    else rejected.push(evidence);
  }
  const completedCount = rankItems.length - skipped.length;
  // 单标的缺数不阻断已完成的候选；全部缺数仍明确返回部分完成，不能伪装成“无机会”。
  if (rankItems.length > 0 && completedCount === 0) gaps.push(...skipped);
  return {
    status: gaps.length ? "partial" : "success", date, rank_date: rank.rank_date,
    scanned_count: rankItems.length, completed_count: completedCount, skipped_count: skipped.length, skipped,
    qualified, near, rejected: rejected.slice(0, 20),
    rejected_count: rejected.length, gaps,
    evidence: "research_only", writes_business_data: false,
  };
}
