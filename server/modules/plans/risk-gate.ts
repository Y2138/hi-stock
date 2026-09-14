// 风控三件套的每日判定：宽度确认、绝对动量闸门（限广域宇宙）、账户级熔断（连损 / 20 日回撤）。
// 依据：《系统策略优化研究_总结论_终版》采纳层——三者的价值均为「何时不做」，与具体信号解耦。
// 口径与边界：
//   - 宽度确认：881 一级行业当日上涨占比 ≥ 60% 才允许新开仓（回测三窗口一致改善基线 40pp+）；
//   - 绝对动量：881 等权综合指数 60 日收益 < 0 时停止新开仓——**仅适用于与指数同向的广域宇宙，
//     周期行业等逆周期宇宙禁用**（收口终验：周期配置加该闸门三窗一致恶化）；
//   - 连损熔断：最近连续亏损平仓（realized_pnl<0 的卖出事件）≥3 笔暂停新开仓；
//   - 回撤熔断：组合净值 20 日峰值回撤 ≥5% 暂停新开仓；净值快照不足 20 日时该判定为 null（宁缺毋假）。
import type pg from "pg";

type Db = Pick<pg.PoolClient, "query">;

export interface RiskGate {
  /** 881 环境数据日（可能早于请求日：休市或未更新时取最近截面） */
  data_date: string | null;
  /** 881 一级行业当日上涨占比（0~1；板块无前收时不计入分母） */
  industry_rising_ratio: number | null;
  /** 宽度确认是否允许新开仓（占比 ≥ 0.6） */
  breadth_open: boolean | null;
  /** 881 等权综合指数近 60 日收益 */
  composite_return_60d: number | null;
  /** 881 等权综合指数近 120 日收益（更稳的辅助口径，熊段更早转正） */
  composite_return_120d: number | null;
  /** 绝对动量闸门是否允许新开仓（60 日收益 ≥ 0）；仅限广域宇宙使用 */
  absolute_momentum_open: boolean | null;
  /** 最近连续亏损平仓笔数（含部分减仓的亏损卖出） */
  stop_loss_streak: number;
  /** 组合净值 20 日峰值回撤（0~1；快照不足 20 日为 null） */
  drawdown_20d: number | null;
  /** 账户级熔断是否触发（回撤 ≥5% 或连损 ≥3；数据不足的分项为 null 时不参与判定） */
  equity_circuit_open: boolean | null;
  /** 净值快照已积累天数（<20 时回撤判定为 null） */
  equity_snapshot_days: number;
  /** 口径与边界说明（面向计划读者） */
  note: string;
}

/** 物化当日净值快照（幂等）：现金台账 + 持仓最新收盘市值；台账缺行或无持仓行情时跳过并返回 false。 */
export async function recordDailyEquity(db: Db, date: string): Promise<boolean> {
  const ledger = await db.query<{ cash: string }>(
    `SELECT cash FROM portfolio_account_state WHERE id = true`,
  );
  const cashValue = Number(ledger.rows[0]?.cash);
  if (!ledger.rows[0] || !Number.isFinite(cashValue)) return false;
  const holdings = await db.query<{ quantity: string; close: string | null; cost: string }>(
    `SELECT p.quantity::text AS quantity, b.close::text AS close, p.cost_price::text AS cost
     FROM portfolio_position p
     JOIN market_instrument i ON i.id = p.instrument_id
     LEFT JOIN LATERAL (
       SELECT bar.close FROM market_bar bar
       WHERE bar.instrument_id = p.instrument_id AND bar.freq = 'day'
       ORDER BY bar.bar_date DESC LIMIT 1
     ) b ON true
     WHERE p.quantity > 0`,
  );
  let marketValue = 0;
  for (const row of holdings.rows) {
    const price = row.close !== null && Number(row.close) > 0 ? Number(row.close) : Number(row.cost);
    marketValue += Number(row.quantity) * price;
  }
  const equity = cashValue + marketValue;
  if (!Number.isFinite(marketValue) || !Number.isFinite(equity)) return false;
  await db.query(
    `INSERT INTO portfolio_equity_daily (snap_date, cash, market_value, equity)
     VALUES ($1::date, $2, $3, $4)
     ON CONFLICT (snap_date) DO UPDATE
       SET cash = EXCLUDED.cash, market_value = EXCLUDED.market_value, equity = EXCLUDED.equity, updated_at = now()`,
    [date, cashValue, marketValue, equity],
  );
  return true;
}

/** 风控三件套判定（只读；调用方通常先 recordDailyEquity 物化当日快照）。 */
export async function queryRiskGate(db: Db, date: string): Promise<RiskGate> {
  // 1) 宽度：881 一级行业最近截面的上涨占比（每板块最后一根 vs 前一根；DESC 排序下前一日是 lead）。
  const breadth = await db.query<{ data_date: string; rising_ratio: number | null }>(
    `WITH ranked AS (
       SELECT b.bar_date::text AS bar_date, b.close,
              row_number() OVER (PARTITION BY b.instrument_id ORDER BY b.bar_date DESC) AS rn,
              lead(b.close) OVER (PARTITION BY b.instrument_id ORDER BY b.bar_date DESC) AS prev
       FROM market_bar b
       JOIN market_instrument i ON i.id = b.instrument_id
       JOIN market_board mb ON mb.instrument_id = i.id
            AND mb.active AND mb.source = 'hithink' AND mb.board_type = 'industry'
       WHERE i.code LIKE '881%.TI' AND b.freq = 'day' AND b.bar_date <= $1::date
     )
     SELECT max(bar_date) AS data_date,
            count(*) FILTER (WHERE rn = 1 AND prev IS NOT NULL AND close > prev)::float8
              / NULLIF(count(*) FILTER (WHERE rn = 1 AND prev IS NOT NULL), 0) AS rising_ratio
     FROM ranked`,
    [date],
  );
  const dataDate = breadth.rows[0]?.data_date ?? null;
  const risingRatio = breadth.rows[0]?.rising_ratio != null ? Number(breadth.rows[0].rising_ratio) : null;
  const breadthOpen = risingRatio === null ? null : risingRatio >= 0.6;

  // 2) 绝对动量：881 等权综合指数最近 121 个交易日的等权日收益累乘。
  let composite60: number | null = null;
  let composite120: number | null = null;
  const dailyReturns = await db.query<{ r: number }>(
    `WITH rets AS (
       SELECT b.bar_date, b.close / NULLIF(lag(b.close) OVER (PARTITION BY b.instrument_id ORDER BY b.bar_date), 0) - 1 AS r
       FROM market_bar b
       JOIN market_instrument i ON i.id = b.instrument_id
       JOIN market_board mb ON mb.instrument_id = i.id
            AND mb.active AND mb.source = 'hithink' AND mb.board_type = 'industry'
       WHERE i.code LIKE '881%.TI' AND b.freq = 'day' AND b.bar_date <= $1::date
     )
     SELECT avg(r)::float8 AS r FROM rets
     WHERE r IS NOT NULL GROUP BY bar_date HAVING count(*) >= 5 ORDER BY bar_date DESC LIMIT 121`,
    [date],
  );
  const returns = dailyReturns.rows.map(row => Number(row.r)).filter(value => Number.isFinite(value)).reverse();
  const cumulative = (days: number): number | null => {
    if (returns.length < days) return null;
    let product = 1;
    for (let index = returns.length - days; index < returns.length; index += 1) product *= 1 + returns[index]!;
    return product - 1;
  };
  composite60 = cumulative(60);
  composite120 = cumulative(120);
  const absoluteMomentumOpen = composite60 === null ? null : composite60 >= 0;

  // 3) 连损：最近 10 笔平仓（realized_pnl<0 的卖出）里的连续亏损笔数。
  const streak = await db.query<{ pnl: string }>(
    `SELECT realized_pnl::text AS pnl FROM portfolio_position_change
     WHERE kind = 'sell' AND realized_pnl IS NOT NULL
     ORDER BY change_date DESC, id DESC LIMIT 10`,
  );
  let stopStreak = 0;
  for (const row of streak.rows) {
    if (Number(row.pnl) < 0) stopStreak += 1;
    else break;
  }

  // 4) 回撤：净值快照最近 20 个交易日的峰值回撤。
  const equities = await db.query<{ equity: string }>(
    `SELECT equity::text FROM portfolio_equity_daily ORDER BY snap_date DESC LIMIT 20`,
  );
  let drawdown: number | null = null;
  if (equities.rows.length >= 20) {
    let peak = 0;
    let trough = Infinity;
    for (const row of equities.rows) {
      const value = Number(row.equity);
      if (value > peak) peak = value;
      if (value < trough) trough = value;
    }
    if (peak > 0) drawdown = (peak - trough) / peak;
  }
  const circuitOpen = drawdown === null ? (stopStreak >= 3 ? true : null) : drawdown >= 0.05 || stopStreak >= 3;

  return {
    data_date: dataDate,
    industry_rising_ratio: risingRatio,
    breadth_open: breadthOpen,
    composite_return_60d: composite60,
    composite_return_120d: composite120,
    absolute_momentum_open: absoluteMomentumOpen,
    stop_loss_streak: stopStreak,
    drawdown_20d: drawdown,
    equity_circuit_open: circuitOpen,
    equity_snapshot_days: equities.rows.length,
    note: "宽度确认=881行业上涨占比≥60%；绝对动量=881等权综合60日收益≥0（仅限广域宇宙，周期行业等逆周期宇宙禁用）；熔断=净值20日回撤≥5%或连续3笔亏损平仓（快照不足20日时回撤不判定）",
  };
}
