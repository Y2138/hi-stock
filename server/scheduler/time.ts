import { Cron } from "croner";
import type { Db } from "./types.js";

export const SCHEDULER_TIMEZONE = "Asia/Shanghai";

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SCHEDULER_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const shanghaiClockFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: SCHEDULER_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export type DailyMarketMode = "snapshot" | "historical";

export type DailyMarketGate =
  | { action: "run"; mode: DailyMarketMode }
  | { action: "skip"; reason: string }
  | { action: "reject"; reason: string };

/** Date 对应的上海自然日（YYYY-MM-DD），不依赖服务器本地时区。 */
export function shanghaiDate(date: Date): string {
  return shanghaiDateFormatter.format(date);
}

function shanghaiMinuteOfDay(date: Date): number {
  const parts = Object.fromEntries(
    shanghaiClockFormatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return Number(parts.hour) * 60 + Number(parts.minute);
}

/** 日更快照只处理已收盘的当前交易日；历史目标日改走历史 K 线。 */
export async function dailyMarketGate(db: Db, targetDate: string, now: Date): Promise<DailyMarketGate> {
  const today = shanghaiDate(now);
  if (targetDate > today) {
    return { action: "reject", reason: `目标日 ${targetDate} 晚于当前上海日期 ${today}` };
  }
  const calendar = await db.query<{ is_open: boolean }>(
    "SELECT is_open FROM market_trading_day WHERE trade_date = $1",
    [targetDate],
  );
  if (!calendar.rows[0]) {
    return { action: "reject", reason: `目标日 ${targetDate} 缺少交易日历，请先运行市场目录同步` };
  }
  if (!calendar.rows[0].is_open) {
    return { action: "skip", reason: `目标日 ${targetDate} 为非交易日` };
  }
  if (targetDate === today && shanghaiMinuteOfDay(now) < 15 * 60 + 30) {
    return { action: "reject", reason: `目标日 ${targetDate} 尚未收盘，请在 15:30 后运行` };
  }
  return { action: "run", mode: targetDate === today ? "snapshot" : "historical" };
}

/** 只接受传统 5 段 cron，所有匹配固定按 Asia/Shanghai。 */
export function assertCron(expression: unknown): string {
  if (typeof expression !== "string" || expression.trim().split(/\s+/).length !== 5) {
    throw new Error("cron 必须是 5 段表达式（分 时 日 月 周）");
  }
  const cron = expression.trim();
  try {
    new Cron(cron, {
      paused: true,
      timezone: SCHEDULER_TIMEZONE,
      mode: "5-part",
    });
  } catch (error) {
    throw new Error(`cron 非法：${(error as Error).message}`);
  }
  return cron;
}

/** 枚举 (after, through] 内的 cron 时刻；上限防止坏配置造成启动扫描失控。 */
export function cronOccurrences(
  expression: string,
  after: Date,
  through: Date,
  limit = 1_000,
): Date[] {
  const cron = new Cron(assertCron(expression), {
    paused: true,
    timezone: SCHEDULER_TIMEZONE,
    mode: "5-part",
  });
  const result: Date[] = [];
  let cursor = after;
  while (result.length < limit) {
    const next = cron.nextRun(cursor);
    if (!next || next.getTime() > through.getTime()) break;
    result.push(next);
    cursor = next;
  }
  if (result.length === limit) {
    const next = cron.nextRun(cursor);
    if (next && next.getTime() <= through.getTime()) {
      throw new Error(`cron ${expression} 在扫描区间内超过 ${limit} 次，拒绝继续`);
    }
  }
  return result;
}

export function nextCronRun(expression: string, after = new Date()): Date | null {
  const cron = new Cron(assertCron(expression), {
    paused: true,
    timezone: SCHEDULER_TIMEZONE,
    mode: "5-part",
  });
  return cron.nextRun(after);
}
