// 05 离场与风控纯规则：打板与低吸分开，不共用止损、止盈和持有期。
// 本文件不读库、不发通知；快速层负责提供行情与开板上下文。
import type {
  DataStatus,
  Db,
  ExitAction,
  ExitContext,
  ExitDecision,
  ExitReason,
  TradeLine,
  UltraShortWatchlistRow,
} from "./types.js";

/** 全部阈值先按 05 文档执行，样本积累后回测校准。 */
export const EXIT_RULES = {
  board_stop_pct: 4, // 打板硬止损 4%（待回测）
  low_buy_stop_pct: 4, // 低吸缺少结构位时的兜底止损（待回测）
  board_time_stop_minute: 14 * 60 + 50, // D+1 14:50 未封板清仓（待回测）
  low_buy_time_stop_minute: 14 * 60 + 45, // 低吸时间止损检查时点（待回测）
  weak_open_minute: 14 * 60 + 30, // 尾盘任何开板即清（待回测）
  high_board_streak: 4, // 4 板及以上任何开板即清（待回测）
  strong_reseal_ms: 60_000, // 60 秒内回封算强回封（待回测）
  weak_reseal_ms: 180_000, // 超过 3 分钟未回封算弱转跌（待回测）
  reseal_seal_ratio: 0.7, // 回封封单/开板前 70% 以上算恢复（待回测）
  weak_seal_ratio: 0.3, // 封单低于 30% 直接按炸板（待回测）
  open_volume_ratio: 2, // 开板量超过前 5 分钟均量 2 倍按放量炸板（待回测）
  half_seal_ratio: 0.4, // 弱回封卖一半的封单恢复下限（待回测）
  low_buy_first_target_r: 1.5, // 低吸第一止盈 1.5R（待回测）
  low_buy_second_target_r: 2.5, // 低吸第二止盈 2.5R（待回测）
  low_buy_time_stop_days: 3, // 低吸（除线上阴线）第 3 个交易日仍未启动清仓（待回测）
  online_yin_time_stop_days: 2, // 线上阴线第 2 个交易日未收复均线清仓（待回测）
  time_stop_min_gain_pct: 2, // 时间止损要求涨幅不足 2%（待回测）
} as const;

const BOARD_TAGS = ["打板接力", "一字延续", "换手晋级", "盘中梯队"] as const;
const LOW_BUY_TAGS = ["龙回头", "单阳不破", "N 字结构", "线上阴线买"] as const;

export function resolveTradeLine(row: Pick<UltraShortWatchlistRow, "tags" | "sources">): TradeLine {
  if (row.tags.some((tag) => (BOARD_TAGS as readonly string[]).includes(tag))) return "board";
  if (row.tags.some((tag) => (LOW_BUY_TAGS as readonly string[]).includes(tag))) return "low_buy";
  return row.sources.some((source) => source === "post_close" || source === "intraday_ladder")
    ? "board"
    : "low_buy";
}

function positive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** 止损位：结构位优先，其次按风险模板比例；低吸可用失效位。 */
export function resolveStopPrice(row: UltraShortWatchlistRow, line: TradeLine): number | null {
  const stop = positive(row.key_levels.stop_price);
  if (stop) return stop;
  const invalidation = positive(row.key_levels.invalidation_price);
  if (line === "low_buy" && invalidation) return invalidation;
  const entry = positive(row.entry_price);
  if (!entry) return null;
  const pct = positive(row.risk.stop_pct)
    ?? (line === "board" ? EXIT_RULES.board_stop_pct : EXIT_RULES.low_buy_stop_pct);
  return entry * (1 - pct / 100);
}

export function resolveR(row: UltraShortWatchlistRow): { entry: number; stop: number; r: number } | null {
  const entry = positive(row.entry_price);
  const stop = resolveStopPrice(row, resolveTradeLine(row));
  if (!entry || !stop || entry <= stop) return null;
  return { entry, stop, r: entry - stop };
}

function shanghaiMinuteOfDay(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(map.hour) * 60 + Number(map.minute);
}

function decision(input: {
  action: ExitAction;
  reason: ExitReason | null;
  price: number | null;
  stop: number | null;
  r: number;
  entry: number;
  note: string;
  stage: number;
  data_status?: DataStatus;
}): ExitDecision {
  return {
    action: input.action,
    reason: input.reason,
    price: input.price,
    stop_price: input.stop,
    r_multiple: input.price === null ? null : Number(((input.price - input.entry) / input.r).toFixed(2)),
    note: input.note,
    data_status: input.data_status ?? "ready",
    next_stage: input.stage,
  };
}

function hold(price: number | null, note: string, stop: number | null, entry: number, r: number): ExitDecision {
  return decision({ action: "hold", reason: null, price, stop, entry, r, note, stage: 0 });
}

export interface BoardOpenGrade {
  grade: "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
  action: ExitAction;
  reason: ExitReason | null;
  note: string;
  next_stage: number;
}

/**
 * 开板分级：A 强回封持有；B 弱回封卖一半；C/D/E/F/G/H 清仓。
 * 一字板第一次开板只卖一半，第二次开板必清。
 */
export function gradeBoardOpen(
  row: Pick<UltraShortWatchlistRow, "streak_count" | "tags" | "exit_stage">,
  context: ExitContext,
): BoardOpenGrade {
  const minute = shanghaiMinuteOfDay(context.now);
  const duration = context.open_since_ms === null ? 0 : Math.max(0, context.now.getTime() - context.open_since_ms);
  const sealRatio = context.seal_money !== null && context.max_seal_money !== null && context.max_seal_money > 0
    ? context.seal_money / context.max_seal_money
    : null;
  const oneWord = row.tags.includes("一字延续");
  const alreadyHalf = (row.exit_stage ?? 0) >= 1;

  if ((row.streak_count ?? 0) >= EXIT_RULES.high_board_streak) {
    return { grade: "F", action: "sell_all", reason: "board_break", note: "高位板任何开板即清，不给容错", next_stage: 2 };
  }
  if (minute >= EXIT_RULES.weak_open_minute) {
    return { grade: "G", action: "sell_all", reason: "board_break", note: "14:30 后开板没有回封时间，直接清仓", next_stage: 2 };
  }
  if (context.open_count >= 3) {
    return { grade: "H", action: "sell_all", reason: "board_break", note: "当日第三次开板，直接清仓", next_stage: 2 };
  }
  const volumeSpike = context.open_volume_ratio !== null && context.open_volume_ratio > EXIT_RULES.open_volume_ratio;
  const sealCollapsed = sealRatio !== null && sealRatio < EXIT_RULES.weak_seal_ratio;
  if (volumeSpike || sealCollapsed || context.same_height_open
    || (context.market_break_rate !== null && context.market_break_rate > 0.4)) {
    return {
      grade: "D", action: "sell_all", reason: "board_break",
      note: volumeSpike ? "开板放量超过前 5 分钟均量 2 倍，按炸板处理"
        : sealCollapsed ? "封单低于开板前 30%，按炸板处理"
          : context.same_height_open ? "同高度集体开板，按炸板处理"
            : "当日炸板率超过 40%，按炸板处理",
      next_stage: 2,
    };
  }
  if (sealRatio === null) {
    if (alreadyHalf) {
      return { grade: "C", action: "sell_all", reason: "board_break", note: "封单数据缺失且已卖过一半，清剩余", next_stage: 2 };
    }
    return {
      grade: "B", action: "sell_half", reason: "board_open_weak",
      note: "封单数据缺失，无法判断回封强度，先卖一半降低风险", next_stage: 1,
    };
  }
  if (oneWord) {
    if (alreadyHalf) {
      return { grade: "E", action: "sell_all", reason: "board_break", note: "一字板第二次开板，清仓", next_stage: 2 };
    }
    const strong = duration <= EXIT_RULES.strong_reseal_ms
      && sealRatio !== null && sealRatio >= EXIT_RULES.reseal_seal_ratio;
    if (strong) {
      return { grade: "A", action: "hold", reason: null, note: "一字板开板 60 秒内回封且封单恢复，持有观察", next_stage: 0 };
    }
    return {
      grade: "E", action: "sell_half", reason: "board_open_weak",
      note: "一字板第一次开板，先卖一半；60 秒内不回封或封单低于 70% 清剩余", next_stage: 1,
    };
  }
  if (duration <= EXIT_RULES.strong_reseal_ms
    && sealRatio !== null && sealRatio >= EXIT_RULES.reseal_seal_ratio
    && (context.open_volume_ratio === null || context.open_volume_ratio < 1.5)) {
    return { grade: "A", action: "hold", reason: null, note: "开板 60 秒内回封且封单恢复，持有", next_stage: 0 };
  }
  if (duration <= EXIT_RULES.weak_reseal_ms
    && sealRatio !== null && sealRatio >= EXIT_RULES.half_seal_ratio) {
    return {
      grade: "B", action: "sell_half", reason: "board_open_weak",
      note: "开板 1–3 分钟回封但封单恢复不足，先卖一半，剩余看分时均线", next_stage: 1,
    };
  }
  return {
    grade: "C", action: "sell_all", reason: "board_break",
    note: "开板超过 3 分钟未回封或封单恢复不足，清仓", next_stage: 2,
  };
}

function evaluateBoard(
  row: UltraShortWatchlistRow,
  price: number,
  context: ExitContext,
  entry: number,
  stop: number,
  r: number,
): ExitDecision {
  const limit = context.limit_up_price ?? positive(row.key_levels.limit_up_price);
  const sealed = limit !== null && price >= limit - 0.005;
  if (context.holding_days >= 2
    && shanghaiMinuteOfDay(context.now) >= EXIT_RULES.board_time_stop_minute
    && !sealed) {
    return decision({
      action: "sell_all", reason: "time_stop", price, stop, entry, r,
      note: "D+1 14:50 仍未封板，时间止损清仓，不把打板做成中线", stage: 2,
    });
  }
  // D+1 开盘纪律：打板赚的是次日强度，开盘不及预期就按规则走，不把打板拖成中线。
  // 只在“当日尚未封过板”时执行开盘纪律；已经封板后的开板走下面的分级。
  if (context.holding_days === 2 && context.open_pct !== null
    && !context.sealed_before && context.open_count === 0) {
    const minute = shanghaiMinuteOfDay(context.now);
    // 开盘纪律只在固定窗口执行一次，避免 10 点后重复触发。
    if (context.open_pct <= 0 && minute >= 9 * 60 + 30 && minute < 9 * 60 + 33) {
      return decision({
        action: "sell_all", reason: "board_open_weak", price, stop, entry, r,
        note: "D+1 低开，打板不及预期，开盘按纪律卖出", stage: 2,
      });
    }
    if (context.open_pct < 3 && minute >= 9 * 60 + 31 && minute < 9 * 60 + 34) {
      return decision({
        action: "sell_all", reason: "board_open_weak", price, stop, entry, r,
        note: "D+1 高开不足 3%，不及预期，开盘卖出", stage: 2,
      });
    }
    if (context.open_pct >= 3 && context.open_pct <= 5
      && minute >= 9 * 60 + 35 && minute < 9 * 60 + 38 && !sealed) {
      return decision({
        action: "sell_half", reason: "board_open_weak", price, stop, entry, r,
        note: "D+1 高开 3%–5% 但 9:35 仍未封板，先卖一半", stage: 1,
      });
    }
    if (context.open_pct > 5 && minute >= 9 * 60 + 35 && minute < 10 * 60 && !sealed) {
      return decision({
        action: "sell_half", reason: "board_open_weak", price, stop, entry, r,
        note: "D+1 高开 >5% 但冲高不封，先卖一半", stage: 1,
      });
    }
    if (context.open_pct > 5 && minute >= 10 * 60 && minute < 10 * 60 + 3 && !sealed) {
      return decision({
        action: "sell_all", reason: "board_break", price, stop, entry, r,
        note: "D+1 高开 >5% 且 10:00 前未封板，清仓", stage: 2,
      });
    }
  }
  if (context.sealed_before && !sealed && limit !== null) {
    const grade = gradeBoardOpen(row, context);
    if (grade.action === "hold") return hold(price, grade.note, stop, entry, r);
    // 已经因开板卖过一半，再次弱开板不再减半，直接清剩余。
    if (grade.action === "sell_half" && (row.exit_stage ?? 0) >= 1) {
      return decision({
        action: "sell_all", reason: "board_break", price, stop, entry, r,
        note: "已因开板卖过一半，再次弱开板清剩余", stage: 2,
      });
    }
    return decision({
      action: grade.action, reason: grade.reason, price, stop, entry, r,
      note: grade.note, stage: grade.next_stage,
    });
  }
  if (row.exit_status === "exit_triggered" && row.exit_reason === "board_open_weak" && !sealed) {
    return decision({
      action: "sell_all", reason: "board_break", price, stop, entry, r,
      note: "已提示开板卖一半，仍未回封，清剩余", stage: 2,
    });
  }
  return hold(price, sealed ? "封板持有，断板/开板弱转强再处理" : "等待开板或时间止损", stop, entry, r);
}

function evaluateLowBuy(
  row: UltraShortWatchlistRow,
  price: number,
  context: ExitContext,
  entry: number,
  stop: number,
  r: number,
): ExitDecision {
  if (price >= entry + EXIT_RULES.low_buy_second_target_r * r) {
    return decision({
      action: "sell_all", reason: "target_2", price, stop, entry, r,
      note: `达到第二止盈 ${EXIT_RULES.low_buy_second_target_r}R，清仓落袋`, stage: 2,
    });
  }
  if ((row.exit_stage ?? 0) < 1 && price >= entry + EXIT_RULES.low_buy_first_target_r * r) {
    return decision({
      action: "sell_half", reason: "target_1", price, stop, entry, r,
      note: `达到第一止盈 ${EXIT_RULES.low_buy_first_target_r}R，先卖一半，剩余移动保护`, stage: 1,
    });
  }
  if ((row.exit_stage ?? 0) >= 1 && price <= entry) {
    return decision({
      action: "sell_all", reason: "take_profit_weak", price, stop, entry, r,
      note: "已触发第一止盈后回落至成本，清剩余，不让盈利变亏损", stage: 2,
    });
  }
  const timeStopDays = row.tags.includes("线上阴线买")
    ? EXIT_RULES.online_yin_time_stop_days
    : EXIT_RULES.low_buy_time_stop_days;
  if (context.holding_days >= timeStopDays
    && shanghaiMinuteOfDay(context.now) >= EXIT_RULES.low_buy_time_stop_minute
    && price < entry * (1 + EXIT_RULES.time_stop_min_gain_pct / 100)) {
    return decision({
      action: "sell_all", reason: "time_stop", price, stop, entry, r,
      note: `持有第 ${context.holding_days} 个交易日仍未启动，时间止损清仓`, stage: 2,
    });
  }
  return hold(price, "低吸形态未失效，等待止盈或时间止损", stop, entry, r);
}

/**
 * 单行退出判定：
 * 1) 未持仓/已清仓不处理；
 * 2) 缺行情标 insufficient，不猜；
 * 3) 硬止损优先；
 * 4) 打板看开板分级与 D+1 时间止损；低吸看 1.5R/2.5R 与时间止损。
 */
export function evaluateExit(
  row: UltraShortWatchlistRow,
  quote: { close: number } | null,
  context: ExitContext,
): ExitDecision {
  if (row.exit_status === "none" || row.exit_status === "closed") {
    return {
      action: "hold", reason: null, price: quote?.close ?? null, stop_price: null,
      r_multiple: null, note: "未持仓或已清仓", data_status: "ready", next_stage: 0,
    };
  }
  const resolved = resolveR(row);
  if (!resolved) {
    return {
      action: "hold", reason: null, price: quote?.close ?? null, stop_price: null,
      r_multiple: null, note: "缺少入场价或有效止损位，暂不判定",
      data_status: "insufficient", next_stage: 0,
    };
  }
  if (!quote || !Number.isFinite(quote.close)) {
    return {
      action: "hold", reason: null, price: null, stop_price: resolved.stop,
      r_multiple: null, note: "行情缺失，暂不触发退出", data_status: "insufficient", next_stage: 0,
    };
  }
  const price = quote.close;
  const { entry, stop, r } = resolved;
  if (price <= stop) {
    return decision({
      action: "sell_all", reason: "hard_stop", price, stop, entry, r,
      note: `跌破止损位 ${stop.toFixed(2)}，硬止损优先`, stage: 2,
    });
  }
  return resolveTradeLine(row) === "board"
    ? evaluateBoard(row, price, context, entry, stop, r)
    : evaluateLowBuy(row, price, context, entry, stop, r);
}

/**
 * 熔断：只统计归因到 limit_up 的当日亏损卖出。亏损卖出是可用代理，
 * 不等同于严格“止损”，但足以在连续两笔后停止新开仓。
 */
export async function countTodayStopLosses(db: Db, tradeDate: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM portfolio_position_change
      WHERE kind='sell' AND change_date=$1::date AND strategy_code='limit_up'
        AND realized_pnl IS NOT NULL AND realized_pnl < 0`,
    [tradeDate],
  );
  return Number(result.rows[0]?.count ?? 0);
}
