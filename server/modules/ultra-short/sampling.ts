// 盘中关注池采样（120 秒）：只负责窗口判断和 role='watch' 落库，不参与触发判断。
import { snapshotDate, type SnapshotQuote } from "../../datasource/hithink.js";
import type { Db, UltraShortWatchlistRow } from "./types.js";

const WINDOW_START_MINUTES = 9 * 60 + 30;
const WINDOW_END_MINUTES = 10 * 60 + 30;
const QUOTE_STALE_MS = 90_000;
const QUOTE_FUTURE_MS = 30_000;

function shanghaiMinuteOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(map.hour) * 60 + Number(map.minute);
}

export function isIntradayWindow(now: Date): boolean {
  const minutes = shanghaiMinuteOfDay(now);
  return minutes >= WINDOW_START_MINUTES && minutes < WINDOW_END_MINUTES;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function writeWatchSample(
  db: Db,
  tradeDate: string,
  sampleAt: Date,
  row: UltraShortWatchlistRow,
  quote: SnapshotQuote | null,
): Promise<void> {
  const valid = quote !== null
    && Number.isFinite(quote.timestampMs)
    && [quote.open, quote.high, quote.low, quote.close].every((price) => Number.isFinite(price) && price > 0);
  const dataStatus = !valid
    ? "missing"
    : snapshotDate(quote) !== tradeDate
      || quote.timestampMs > sampleAt.getTime() + QUOTE_FUTURE_MS
      || quote.timestampMs < sampleAt.getTime() - QUOTE_STALE_MS
      ? "stale"
      : "ready";
  await db.query(
    `INSERT INTO intraday_market_sample
      (trade_date, sample_at, source_at, code, name, role, open_price, high_price, low_price,
       last_price, prev_close, volume, turnover, data_status)
     VALUES ($1::date,$2,$3,$4,$5,'watch',$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (trade_date, sample_at, code, role) DO NOTHING`,
    [
      tradeDate, sampleAt, valid ? new Date(quote.timestampMs) : null, row.code, row.name,
      valid ? quote.open : null, valid ? quote.high : null, valid ? quote.low : null,
      valid ? quote.close : null, valid ? finiteNumber(quote.prevClose) : null,
      valid ? finiteNumber(quote.volume) : null, valid ? finiteNumber(quote.turnover) : null,
      dataStatus,
    ],
  );
}
