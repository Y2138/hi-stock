// 铜左侧启动策略：江西铜业深度回撤后的恢复入场，以及个股/沪铜/铜股宽度共同破坏退出。
import type pg from "pg";
import type { StrategyPositionEvaluation } from "../strategy-runtime/types.js";

type Db = pg.Pool;
const TARGET = "600362.SH";
const PEERS = ["600362.SH", "000630.SZ", "000878.SZ", "000737.SZ"] as const;
const MACRO_SERIES = ["oecd.g7.cli", "oecd.chn.cli"] as const;

type Bar = { code: string; name: string; date: string; open: number; close: number };
type MacroRow = { series_code: string; period_end: string; published_date: string; value: number };
type InventoryRow = { period_end: string; published_date: string; value: number };

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value: number, digits = 4) => Number(value.toFixed(digits));
function ma(values: number[], index: number, window: number) {
  if (index + 1 < window) return null;
  return mean(values.slice(index - window + 1, index + 1));
}
function rolling(values: number[], index: number, window: number, mode: "min" | "max") {
  if (index + 1 < window) return null;
  let selected = index - window + 1;
  for (let current = selected + 1; current <= index; current++) {
    if ((mode === "min" && values[current]! <= values[selected]!) || (mode === "max" && values[current]! >= values[selected]!)) selected = current;
  }
  return { value: values[selected]!, index: selected };
}
function monthDiff(left: string, right: string) {
  const [ly, lm] = left.slice(0, 7).split("-").map(Number);
  const [ry, rm] = right.slice(0, 7).split("-").map(Number);
  return (ly! - ry!) * 12 + lm! - rm!;
}
function latestMonthly(rows: MacroRow[], code: string) {
  return rows.filter((row) => row.series_code === code).sort((a, b) => a.period_end.localeCompare(b.period_end));
}
function averageAt(values: number[], end: number, window = 3) {
  return end + 1 < window ? null : mean(values.slice(end - window + 1, end + 1));
}

async function state(db: Db, targetDate: string) {
  const [barsResult, cuResult, macroResult, inventoryResult, calendarResult, positionResult] = await Promise.all([
    db.query<Bar>(
      `WITH ranked AS (
         SELECT instrument.code,instrument.name,bar.bar_date::text date,bar.open::float8,bar.close::float8,
                row_number() OVER(PARTITION BY instrument.code ORDER BY bar.bar_date DESC) rank
           FROM market_bar bar JOIN market_instrument instrument ON instrument.id=bar.instrument_id
          WHERE instrument.code=ANY($1::text[]) AND bar.freq='day' AND bar.adjustment='forward'
            AND bar.bar_date <= $2::date AND bar.close>0)
       SELECT code,name,date,open,close FROM ranked WHERE rank<=320 ORDER BY code,date DESC`, [PEERS, targetDate],
    ),
    db.query<{ date: string; close: number }>(
      `SELECT bar.bar_date::text date,bar.close::float8
         FROM market_bar bar JOIN market_instrument instrument ON instrument.id=bar.instrument_id
        WHERE instrument.code='CU0' AND bar.freq='futures_day' AND bar.bar_date <= $1::date AND bar.close>0
        ORDER BY bar.bar_date DESC LIMIT 320`, [targetDate],
    ),
    db.query<MacroRow>(
      `WITH latest AS (
         SELECT series.series_code,observation.period_end::text,observation.value::float8,
                (observation.published_at AT TIME ZONE 'Asia/Shanghai')::date::text published_date,
                row_number() OVER(PARTITION BY series.series_code,observation.period_end ORDER BY observation.published_at DESC,observation.revision_no DESC) rank
           FROM market_factor_observation observation JOIN market_factor_series series ON series.id=observation.series_id
          WHERE series.series_code=ANY($1::text[]) AND observation.published_at < $2::date + interval '1 day')
       SELECT series_code,period_end,published_date,value FROM latest WHERE rank=1 ORDER BY series_code,period_end`,
      [MACRO_SERIES, targetDate],
    ),
    db.query<InventoryRow>(
      `WITH latest AS (
         SELECT observation.period_end::text,observation.value::float8,
                (observation.published_at AT TIME ZONE 'Asia/Shanghai')::date::text published_date,
                row_number() OVER(PARTITION BY observation.period_end ORDER BY observation.published_at DESC,observation.revision_no DESC) rank
           FROM market_factor_observation observation JOIN market_factor_series series ON series.id=observation.series_id
          WHERE series.series_code='shfe.cu.inventory.total' AND observation.published_at < $1::date + interval '1 day')
       SELECT period_end,published_date,value FROM latest WHERE rank=1 ORDER BY period_end`, [targetDate],
    ),
    db.query<{ date: string }>("SELECT max(trade_date)::text date FROM market_trading_day WHERE is_open=true AND trade_date <= $1::date", [targetDate]),
    db.query<{ quantity: number }>(
      `SELECT COALESCE(position.quantity,0)::float8 quantity FROM market_instrument instrument
       LEFT JOIN portfolio_position position ON position.instrument_id=instrument.id
       WHERE instrument.code=$1`, [TARGET],
    ),
  ]);
  const gaps: Array<{ code?: string; reason: string }> = [];
  const byCode = new Map<string, Bar[]>();
  for (const row of barsResult.rows.reverse()) {
    if (!byCode.has(row.code)) byCode.set(row.code, []);
    byCode.get(row.code)!.push(row);
  }
  const target = byCode.get(TARGET) ?? [];
  const expectedDate = calendarResult.rows[0]?.date ?? null;
  const dataDate = target.at(-1)?.date ?? null;
  if (target.length < 252) gaps.push({ code: TARGET, reason: `江西铜业日线不足252个交易日（${target.length}）` });
  if (expectedDate && dataDate !== expectedDate) gaps.push({ code: TARGET, reason: `江西铜业最新日线为${dataDate ?? "无"}，应为${expectedDate}` });
  for (const code of PEERS) if ((byCode.get(code)?.length ?? 0) < 60) gaps.push({ code, reason: "铜股宽度缺少60日窗口" });
  const cu = cuResult.rows.reverse();
  if (cu.length < 60) gaps.push({ code: "CU0", reason: "沪铜主力缺少60日窗口" });
  const macro = Object.fromEntries(MACRO_SERIES.map((code) => [code, latestMonthly(macroResult.rows, code)])) as Record<string, MacroRow[]>;
  for (const code of MACRO_SERIES) if (macro[code]!.length < 6) gaps.push({ code, reason: "宏观月度序列不足6个月" });
  if (inventoryResult.rows.length < 13) gaps.push({ code: "shfe.cu.inventory.total", reason: "SHFE铜库存不足13个周度观测" });
  const latestMacroPeriod = macro["oecd.chn.cli"]?.at(-1)?.period_end;
  if (latestMacroPeriod && monthDiff(targetDate, latestMacroPeriod) > 5) gaps.push({ code: "oecd.chn.cli", reason: `中国CLI最新报告期${latestMacroPeriod}已过期` });
  if (inventoryResult.rows.at(-1)?.published_date && Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${inventoryResult.rows.at(-1)!.published_date}T00:00:00Z`) > 21 * 86400_000) {
    gaps.push({ code: "shfe.cu.inventory.total", reason: `SHFE铜库存最新发布时间${inventoryResult.rows.at(-1)!.published_date}已超过21天` });
  }
  if (gaps.length) return { status: "partial" as const, dataDate, gaps, target, byCode, cu, macro, inventory: inventoryResult.rows, quantity: positionResult.rows[0]?.quantity ?? 0, feature: null };

  const closes = target.map((row) => row.close);
  const index = closes.length - 1;
  const low = rolling(closes, index, 60, "min")!;
  const high = rolling(closes, index, 252, "max")!;
  const g7 = macro["oecd.g7.cli"]!;
  const china = macro["oecd.chn.cli"]!;
  const g7Index = g7.length - 1;
  const chinaValues = china.map((row) => row.value);
  const chinaAverage = averageAt(chinaValues, chinaValues.length - 1)!;
  const chinaAverageOld = averageAt(chinaValues, chinaValues.length - 4)!;
  const growth = g7[g7Index]!.value >= 99.5 || g7[g7Index]!.value >= g7[g7Index - 3]!.value;
  const demand = chinaAverage >= 99 || chinaAverage >= chinaAverageOld;
  const inventories = inventoryResult.rows.map((row) => row.value);
  const currentInventory = inventories.at(-1)!;
  const inventoryChange12 = currentInventory / inventories[inventories.length - 13]! - 1;
  const inventoryHistory = inventories.slice(-156);
  const inventoryRank = inventoryHistory.filter((value) => value <= currentInventory).length / inventoryHistory.length;
  const supply = inventoryChange12 <= 0.25 || inventoryRank <= 0.7;
  const macroOkCount = [growth, demand, supply].filter(Boolean).length;
  const peerAbove = PEERS.map((code) => {
    const rows = byCode.get(code)!;
    const values = rows.map((row) => row.close);
    const currentIndex = values.length - 1;
    return values[currentIndex]! > ma(values, currentIndex, 60)!;
  });
  const cuCloses = cu.map((row) => row.close);
  const feature = {
    close: closes[index]!, open: target[index]!.open, low60: low.value, low_age: index - low.index,
    high252: high.value, drawdown252: closes[index]! / high.value - 1, rebound60: closes[index]! / low.value - 1,
    stock_ma60: ma(closes, index, 60)!, stock_ma120: ma(closes, index, 120)!,
    cu_close: cuCloses.at(-1)!, cu_ma60: ma(cuCloses, cuCloses.length - 1, 60)!,
    breadth_ma60: peerAbove.filter(Boolean).length / peerAbove.length,
    macro: {
      growth, demand, supply, ok_count: macroOkCount, ok: macroOkCount >= 2,
      g7_cli: g7[g7Index]!.value, china_cli_3m: chinaAverage,
      inventory_12w_change: inventoryChange12, inventory_rank_3y: inventoryRank,
    },
  };
  return { status: "success" as const, dataDate, gaps, target, byCode, cu, macro, inventory: inventoryResult.rows, quantity: positionResult.rows[0]?.quantity ?? 0, feature };
}

export async function queryCopperLeftLaunchEntry(db: Db, targetDate: string) {
  const current = await state(db, targetDate);
  if (!current.feature) return { status: "partial", data_date: current.dataDate, coverage: { target_count: 1, completed_count: 0 }, signals: [], near_candidates: [], gaps: current.gaps };
  const f = current.feature;
  const conditions = {
    drawdown_15_to_40: f.drawdown252 <= -0.15 && f.drawdown252 >= -0.4,
    rebound_8_to_15: f.rebound60 >= 0.08 && f.rebound60 <= 0.15,
    low_within_30_days: f.low_age <= 30,
    macro_two_of_three: f.macro.ok,
  };
  const failed = Object.entries(conditions).filter(([, passed]) => !passed).map(([name]) => name);
  const item = {
    code: TARGET, name: "江西铜业", conditions, failed_conditions: failed,
    invalidation: `收盘跌回近60日低点${round(f.low60, 2)}元以下，或反弹超过15%后不再追入`,
    evidence: {
      close: round(f.close, 2), high_252: round(f.high252, 2), drawdown_252: round(f.drawdown252),
      low_60: round(f.low60, 2), low_age: f.low_age, rebound_60: round(f.rebound60),
      macro: f.macro, next_execution: "下一交易日开盘", position_suppressed: current.quantity > 0,
    },
  };
  const qualified = failed.length === 0 && current.quantity <= 0;
  return {
    status: "success", data_date: current.dataDate,
    coverage: { target_count: 1, completed_count: 1, peer_count: PEERS.length },
    signals: qualified ? [item] : [],
    near_candidates: !qualified && current.quantity <= 0 && failed.length === 1 ? [item] : [],
    suppressed: current.quantity > 0 && failed.length === 0 ? [{ ...item, reason: "江西铜业已有持仓，不重复形成入场信号" }] : [],
    gaps: [],
  };
}

export async function queryCopperLeftLaunchExit(db: Db, targetDate: string) {
  const positions = await db.query<{ code: string; name: string }>(
    `SELECT instrument.code,instrument.name FROM portfolio_position position
     JOIN market_instrument instrument ON instrument.id=position.instrument_id
     WHERE position.quantity>0 AND position.strategy_code='copper_left_launch' ORDER BY instrument.code`,
  );
  if (!positions.rows.length) return { status: "success", data_date: targetDate, coverage: { strategy_code: "copper_left_launch", position_count: 0, completed_count: 0 }, items: [], gaps: [] };
  const current = await state(db, targetDate);
  if (!current.feature) return { status: "partial", data_date: current.dataDate, coverage: { strategy_code: "copper_left_launch", position_count: positions.rows.length, completed_count: 0 }, items: [], gaps: current.gaps };
  const targetRows = current.target;
  const dates = targetRows.map((row) => row.date);
  const closes = targetRows.map((row) => row.close);
  let consecutive = 0;
  const dailyEvidence: Array<{ date: string; stock_below_ma60: boolean; cu_below_ma60: boolean; breadth_below_half: boolean }> = [];
  for (let index = Math.max(59, dates.length - 30); index < dates.length; index++) {
    const date = dates[index]!;
    const stockBelow = closes[index]! < ma(closes, index, 60)!;
    const cuValues = current.cu.filter((row) => row.date <= date).map((row) => row.close);
    const cuBelow = cuValues.length >= 60 && cuValues.at(-1)! < ma(cuValues, cuValues.length - 1, 60)!;
    let available = 0; let above = 0;
    for (const code of PEERS) {
      const rows = current.byCode.get(code)!.filter((row) => row.date <= date);
      if (rows.length < 60) continue;
      available++;
      const values = rows.map((row) => row.close);
      if (values.at(-1)! > ma(values, values.length - 1, 60)!) above++;
    }
    const breadthBelow = available === PEERS.length && above / available < 0.5;
    const broken = stockBelow && cuBelow && breadthBelow;
    consecutive = broken ? consecutive + 1 : 0;
    dailyEvidence.push({ date, stock_below_ma60: stockBelow, cu_below_ma60: cuBelow, breadth_below_half: breadthBelow });
  }
  const exit = consecutive >= 10;
  const items: StrategyPositionEvaluation[] = positions.rows.map((position) => ({
    code: position.code, name: position.name, strategy_code: "copper_left_launch", evaluation_role: "primary",
    action: exit ? "exit" : "hold", trigger_kind: exit ? "open" : "condition",
    trigger_price_lower: null, trigger_price_upper: null, protection_price: null,
    reason: exit ? "江西铜业、CU0与铜股MA60宽度已连续10个交易日共同破坏" : `价格结构共同破坏连续${consecutive}/10个交易日`,
    evidence: { consecutive_break_days: consecutive, current: current.feature, recent_structure: dailyEvidence.slice(-10) }, missing_items: [],
  }));
  return { status: "success", data_date: current.dataDate, coverage: { strategy_code: "copper_left_launch", position_count: items.length, completed_count: items.length }, items, gaps: [] };
}
