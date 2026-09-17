import type pg from "pg";

type Db = Pick<pg.Pool, "query">;
type Bar = { code: string; date: string; close: number; low: number; low_raw?: number | null; board_name?: string; volume: number | null };
type Member = { code: string; name: string; board_code: string; board_name: string; position_quantity: number; in_pool: boolean };
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** 两年结构反转的点时只读扫描；数据缺口不得转换为候选。 */
export async function queryTwoYearReversalCoverage(db: Db, date: string) {
  const coverage = await db.query<{ date: string; stocks: number; boards: number }>(
    `WITH days AS (SELECT trade_date FROM market_trading_day WHERE is_open AND trade_date <= $1::date ORDER BY trade_date DESC LIMIT 30)
     SELECT days.trade_date::text AS date,
            count(DISTINCT bar.instrument_id) FILTER (WHERE instrument.kind='stock' AND instrument.lifecycle_status='active' AND instrument.name !~* '^\\*?ST')::int AS stocks,
            count(DISTINCT bar.instrument_id) FILTER (WHERE board.board_type='industry' AND board.active AND instrument.code ~ '^881[0-9]+\\.TI$')::int AS boards
       FROM days LEFT JOIN market_bar bar ON bar.bar_date=days.trade_date AND bar.freq='day'
       LEFT JOIN market_instrument instrument ON instrument.id=bar.instrument_id
       LEFT JOIN market_board board ON board.instrument_id=instrument.id
      GROUP BY days.trade_date ORDER BY days.trade_date DESC`, [date],
  );
  const peak = Math.max(0, ...coverage.rows.map((row) => row.stocks));
  return coverage.rows.find((row) => peak > 0 && row.stocks >= peak * 0.8 && row.boards >= 80) ?? null;
}

export async function queryTwoYearReversalSignals(db: Db, date: string) {
  const selected = await queryTwoYearReversalCoverage(db, date);
  if (!selected) return { status: "unavailable" as const, date, qualified: [], near: [], gaps: ["近30个确认交易日无股票覆盖达近期峰值80%且881一级行业覆盖达80个的共同数据日"] };
  const asOf = selected.date;
  const gaps: string[] = [];
  if (asOf !== date) gaps.push(`目标日行情不完整，使用共同数据日 ${asOf}；滞后数据仅供观察，不形成目标日新开仓信号`);
  const boardBars = await db.query<Bar>(
    `SELECT board.code,board.name AS board_name,history.bar_date::text AS date,history.close::float8,history.low::float8,history.volume::float8
       FROM market_board catalog JOIN market_instrument board ON board.id=catalog.instrument_id
       JOIN LATERAL (SELECT bar_date,close,low,volume FROM market_bar
         WHERE instrument_id=board.id AND freq='day' AND bar_date <= $1::date
         ORDER BY bar_date DESC,bar_time DESC LIMIT 501) history ON true
      WHERE catalog.board_type='industry' AND catalog.active AND board.code ~ '^881[0-9]+\\.TI$'
      ORDER BY board.code,history.bar_date`, [asOf],
  );
  const histories = new Map<string, Bar[]>();
  for (const bar of boardBars.rows) histories.set(bar.code, [...(histories.get(bar.code) ?? []), bar]);
  const completeBoards = [...histories.values()].filter((history) => history.length >= 501
    && history.at(-1)?.date === asOf && history.every((bar) => bar.close > 0)).length;
  if (completeBoards < 80) return { status: "unavailable" as const, date, data_date: asOf, qualified: [], near: [],
    gaps: [...gaps, `881一级行业两年日线不足80个（${completeBoards}个）`] };
  const eligible = new Map<string, { name: string; return500: number; drawdown20: number; deviation500: number }>();
  for (const [code, history] of histories) {
    if (history.length < 501 || history.at(-1)?.date !== asOf || history.some((bar) => bar.close <= 0)) continue;
    const close = history.at(-1)!.close;
    const return500 = close / history[0]!.close - 1;
    const deviation500 = close / mean(history.slice(-500).map((bar) => bar.close)) - 1;
    const drawdown20 = close / Math.max(...history.slice(-20).map((bar) => bar.close)) - 1;
    if (deviation500 >= 0 && return500 > 0 && drawdown20 <= -0.10 && drawdown20 > -0.30) {
      eligible.set(code, { name: history[0]!.board_name ?? code, return500, deviation500, drawdown20 });
    }
  }
  if (!eligible.size) return { status: "success" as const, date, data_date: asOf, coverage: { stocks: selected.stocks, boards: selected.boards, complete_boards: completeBoards, qualified_boards: 0, members: 0, completed: 0 }, eligible_industries: [], qualified: [], qualified_count: 0, near: [], near_count: 0, historical: [], held: [], gaps, evidence: "research_only" };
  const members = await db.query<Member>(
    `SELECT DISTINCT ON (stock.id) stock.code,stock.name,industry.code AS board_code,industry.name AS board_name,
            COALESCE(position.quantity,0)::float8 AS position_quantity, membership_pool.instrument_id IS NOT NULL AS in_pool
       FROM market_board_membership membership
       JOIN market_instrument industry ON industry.id=membership.board_instrument_id
       JOIN market_instrument stock ON stock.id=membership.member_instrument_id
       LEFT JOIN portfolio_position position ON position.instrument_id=stock.id
       LEFT JOIN pool_membership membership_pool ON membership_pool.instrument_id=stock.id AND membership_pool.effective_to IS NULL
      WHERE industry.code=ANY($1::text[]) AND membership.effective_from <= $2::date
        AND (membership.effective_to IS NULL OR membership.effective_to > $2::date)
        AND stock.kind='stock' AND stock.lifecycle_status='active' AND stock.name !~* '^\\*?ST'
      ORDER BY stock.id,industry.code`, [[...eligible.keys()], asOf],
  );
  const bars = await db.query<Bar>(
    `SELECT stock.code,history.bar_date::text AS date,history.close::float8,history.low::float8,history.low_raw::float8,history.volume::float8
       FROM market_instrument stock JOIN LATERAL (
         SELECT bar_date,close,low,low_raw,volume FROM market_bar WHERE instrument_id=stock.id AND freq='day' AND bar_date <= $2::date
         ORDER BY bar_date DESC,bar_time DESC LIMIT 61) history ON true
      WHERE stock.code=ANY($1::text[]) ORDER BY stock.code,history.bar_date`, [members.rows.map((row) => row.code), asOf],
  );
  const stocks = new Map<string, Bar[]>();
  for (const bar of bars.rows) stocks.set(bar.code, [...(stocks.get(bar.code) ?? []), bar]);
  const observations: Array<{ member: Member; ret5: number; drawdown20: number; volumeRatio: number | null; low: number; lowRaw: number }> = [];
  const peers = new Map<string, number[]>();
  for (const member of members.rows) {
    const history = stocks.get(member.code) ?? [];
    if (history.length < 20 || history.at(-1)?.date !== asOf || history.at(-1)!.close <= 0 || history.at(-1)!.low <= 0 || !history.at(-1)!.low_raw || history.at(-6)!.close <= 0) continue;
    const current = history.at(-1)!;
    const ret5 = current.close / history.at(-6)!.close - 1;
    const drawdown20 = current.close / Math.max(...history.slice(-20).map((bar) => bar.close)) - 1;
    const previousVolumes = history.slice(-61, -1).map((bar) => bar.volume).filter((value): value is number => value !== null && value > 0);
    const volumeRatio = previousVolumes.length === 60 && current.volume !== null ? current.volume / mean(previousVolumes) : null;
    observations.push({ member, ret5, drawdown20, volumeRatio, low: current.low, lowRaw: current.low_raw! });
    peers.set(member.board_code, [...(peers.get(member.board_code) ?? []), ret5]);
  }
  if (!members.rows.length || observations.length < members.rows.length * 0.8) {
    return { status: "unavailable" as const, date, data_date: asOf, qualified: [], near: [], gaps: [...gaps, `合格行业成员日线覆盖不足80%（${observations.length}/${members.rows.length}）`] };
  }
  const qualified: Record<string, unknown>[] = [], near: Record<string, unknown>[] = [], historical: Record<string, unknown>[] = [], held: Record<string, unknown>[] = [];
  for (const item of observations) {
    const group = peers.get(item.member.board_code) ?? [];
    if (group.length < 3) continue;
    const relative5 = item.ret5 - mean(group);
    if (item.ret5 > -0.05 || relative5 > -0.03) continue;
    const board = eligible.get(item.member.board_code)!;
    const formal = item.ret5 <= -0.08 && relative5 <= -0.05;
    const volumeScore = item.volumeRatio === null ? 0 : item.volumeRatio >= 2 ? 4 : item.volumeRatio >= 1.5 ? 3 : item.volumeRatio >= 1.2 ? 2 : item.volumeRatio >= 1 ? 1 : 0;
    const evidence = {
      code: item.member.code, name: item.member.name, industry_code: item.member.board_code, industry: item.member.board_name,
      stock_return_5: item.ret5, relative_return_5: relative5, stock_drawdown_20: item.drawdown20,
      industry_return_500: board.return500, industry_ma500_deviation: board.deviation500, industry_drawdown_20: board.drawdown20,
      volume_ratio_60: item.volumeRatio, signal_low: item.low, signal_low_raw: item.lowRaw, in_pool: item.member.in_pool,
      already_held: item.member.position_quantity > 0, reference_fraction: item.drawdown20 <= -0.20 ? 0.25 : item.drawdown20 <= -0.15 ? 0.20 : 0.12,
      score: -relative5 * 100 - item.drawdown20 * 30 + volumeScore * 2,
      missing_conditions: formal ? [] : [
        ...(item.ret5 > -0.08 ? ["个股5日跌幅未达8%"] : []),
        ...(relative5 > -0.05 ? ["相对行业5日额外落后未达5个百分点"] : []),
      ],
    };
    if (formal && asOf !== date) historical.push(evidence);
    else if (formal && !evidence.already_held) qualified.push(evidence);
    else if (formal) held.push(evidence);
    else near.push(evidence);
  }
  const sort = (a: Record<string, unknown>, b: Record<string, unknown>) => Number(b.score) - Number(a.score) || String(a.code).localeCompare(String(b.code));
  qualified.sort(sort); near.sort(sort); historical.sort(sort); held.sort(sort);
  return {
    status: "success" as const, date, data_date: asOf,
    coverage: { stocks: selected.stocks, boards: selected.boards, complete_boards: completeBoards, qualified_boards: eligible.size, members: members.rows.length, completed: observations.length },
    eligible_industries: [...eligible].map(([code, item]) => ({ code, ...item })),
    qualified: qualified.slice(0, 20), qualified_count: qualified.length, near: near.slice(0, 10), near_count: near.length,
    historical: historical.slice(0, 20), held: held.slice(0, 20),
    gaps, evidence: "research_only", writes_business_data: false,
  };
}
