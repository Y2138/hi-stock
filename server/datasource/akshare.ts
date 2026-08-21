// akshare 通道：直连底层公开 HTTP（不经 Python）
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §5.3
// 覆盖扶摇缺失的能力：新浪 30 分钟线、新浪期货主力连续日线、东财个股资金流。
// 接口参数口径引用 数据获取规范.md §二，注释不复制；响应格式以 2026-08-16 实测为准：
//   - 新浪两个接口均为 jsonp 包裹（前缀含一段注释脚本 + "var="），主体是 JSON 数组；
//   - 30m 元素字段 day/open/high/low/close/volume/amount（字符串）；
//   - 期货日线元素字段 d/o/h/l/c/v/p/s（字符串，全历史，客户端按窗口过滤）；
//   - 东财 push2delay 日级 klt=101 实测只返回最近一个交易日（6 列：日期+主力/小单/中单/大单/超大单净额），
//     与规范描述的历史深度不一致，留痕待规范修订。

import { defaultSleep, type SleepFn } from "./ratelimit.js";
import type { Bar, Channel, FetchRequest } from "./types.js";

const SINA_KLINE_URL =
  "https://quotes.sina.cn/cn/api/jsonp_v2.php/var=/CN_MarketDataService.getKLineData";
const SINA_FUTURES_URL =
  "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var=/InnerFuturesNewService.getDailyKLine";
const EASTMONEY_FFLOW_URL = "https://push2delay.eastmoney.com/api/qt/stock/fflow/kline/get";
/** 东财接口固定 ut 参数（公开接口常量，非凭据，见 数据获取规范.md §2.3） */
const EASTMONEY_UT = "b2884a393a59ad64002292a3e90d46a5";

const TICKER_RE = /^\d{6}\.(?:SH|SZ)$/;
const FUTURES_RE = /^[A-Za-z]{1,3}\d+$/;

export interface AkshareDeps {
  sleep?: SleepFn;
  timeoutMs?: number;
}

class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

/** 一次带超时的 GET 文本 */
async function getText(url: URL, timeoutMs: number): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new UpstreamError(`HTTP ${res.status}: ${url.host}${url.pathname}`);
  return res.text();
}

/** 新浪公开接口瞬时错误最多重试 1 次（口径见 数据获取规范.md） */
async function getWithRetry(url: URL, deps: AkshareDeps): Promise<string> {
  const sleep = deps.sleep ?? defaultSleep;
  try {
    return await getText(url, deps.timeoutMs ?? 30_000);
  } catch (err) {
    await sleep(2000);
    try {
      return await getText(url, deps.timeoutMs ?? 30_000);
    } catch {
      throw err instanceof Error ? err : new UpstreamError(String(err));
    }
  }
}

/** 解析新浪 jsonp 包裹：截取首个 "(" 与末个 ")" 之间的 JSON 数组 */
function parseSinaJsonp(text: string): unknown[] {
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  if (start < 0 || end <= start) throw new UpstreamError("新浪响应不是预期的 jsonp 格式");
  const parsed: unknown = JSON.parse(text.slice(start + 1, end));
  if (!Array.isArray(parsed)) throw new UpstreamError("新浪响应主体不是数组");
  return parsed;
}

/** 000636.SZ ↔ sz000636 */
function toSinaSymbol(code: string): string {
  const m = /^(\d{6})\.(SH|SZ)$/.exec(code);
  if (!m) throw new UpstreamError(`代码必须为6位数字并带.SH/.SZ后缀: ${code}`);
  return `${m[2]!.toLowerCase()}${m[1]}`;
}

/** "2026-08-14 15:00:00"（CST）→ ISO 时刻 */
function cstToIso(dayTime: string): string {
  return `${dayTime.replace(" ", "T")}+08:00`;
}

function toNumber(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UpstreamError(`字段 ${field} 不是数值: ${String(value)}`);
  return n;
}

function inRange(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
}

/** 新浪 30 分钟线（period=30、不复权、sh/sz 前缀；datalen=1023 后按窗口过滤） */
export async function fetchSina30m(req: FetchRequest, deps: AkshareDeps = {}): Promise<Bar[]> {
  const url = new URL(SINA_KLINE_URL);
  url.searchParams.set("symbol", toSinaSymbol(req.code));
  url.searchParams.set("scale", "30");
  url.searchParams.set("ma", "no");
  url.searchParams.set("datalen", "1023");
  const rows = parseSinaJsonp(await getWithRetry(url, deps)) as Record<string, unknown>[];
  const bars: Bar[] = [];
  for (const row of rows) {
    const dayTime = String(row.day ?? "");
    const date = dayTime.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dayTime)) {
      throw new UpstreamError(`30分钟线 day 字段格式异常: ${dayTime}`);
    }
    if (!inRange(date, req.start, req.end)) continue;
    bars.push({
      date,
      time: cstToIso(dayTime),
      open: toNumber(row.open, "open"),
      high: toNumber(row.high, "high"),
      low: toNumber(row.low, "low"),
      close: toNumber(row.close, "close"),
      volume: toNumber(row.volume, "volume"),
      adjustment: "none",
    });
  }
  if (bars.length === 0) {
    throw new UpstreamError(`${req.code} 在 ${req.start} 至 ${req.end} 没有30分钟数据`);
  }
  return bars;
}

/** 新浪期货主力连续日线（合约拼接序列只表趋势；客户端按窗口过滤） */
export async function fetchSinaFuturesDay(req: FetchRequest, deps: AkshareDeps = {}): Promise<Bar[]> {
  const url = new URL(SINA_FUTURES_URL);
  url.searchParams.set("symbol", req.code.toUpperCase());
  const rows = parseSinaJsonp(await getWithRetry(url, deps)) as Record<string, unknown>[];
  const bars: Bar[] = [];
  for (const row of rows) {
    const date = String(row.d ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new UpstreamError(`期货日线 d 字段格式异常: ${date}`);
    }
    if (!inRange(date, req.start, req.end)) continue;
    bars.push({
      date,
      open: toNumber(row.o, "o"),
      high: toNumber(row.h, "h"),
      low: toNumber(row.l, "l"),
      close: toNumber(row.c, "c"),
      volume: toNumber(row.v, "v"),
      adjustment: "none",
    });
  }
  if (bars.length === 0) {
    throw new UpstreamError(`${req.code} 在 ${req.start} 至 ${req.end} 没有期货日线数据`);
  }
  return bars;
}

/** 东财资金流单日行（klt=101：日期+5 项净额，单位元） */
export interface FundFlowRow {
  date: string;
  main: number;
  small: number;
  medium: number;
  large: number;
  xlarge: number;
}

/**
 * 东财个股资金流（push2delay，参数按 数据获取规范.md §2.3）。
 * 沪市 secid=1.*、深市 secid=0.*。klt=101 实测仅返回最近一个交易日。
 * 本模块只取数解析，资金流暂无对应表（market_bar.freq 不含资金流），由调用方决定用途。
 */
export async function fetchFundFlow(
  code: string,
  klt: 1 | 101 = 101,
  deps: AkshareDeps = {},
): Promise<FundFlowRow[]> {
  if (!TICKER_RE.test(code)) {
    throw new UpstreamError(`资金流代码必须为6位数字并带.SH/.SZ后缀: ${code}`);
  }
  const [ticker, market] = code.split(".");
  const url = new URL(EASTMONEY_FFLOW_URL);
  url.searchParams.set("lmt", "0");
  url.searchParams.set("klt", String(klt));
  url.searchParams.set("secid", `${market === "SH" ? "1" : "0"}.${ticker}`);
  url.searchParams.set("fields1", "f1,f2,f3,f7");
  url.searchParams.set(
    "fields2",
    "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
  );
  url.searchParams.set("ut", EASTMONEY_UT);
  const text = await getWithRetry(url, deps);
  const raw = JSON.parse(text) as { rc?: number; data?: { klines?: unknown } };
  if (raw.rc !== 0 || !Array.isArray(raw.data?.klines)) {
    throw new UpstreamError(`东财资金流响应异常: rc=${String(raw.rc)}`);
  }
  return (raw.data.klines as string[]).map((line) => {
    const cols = line.split(",");
    if (cols.length < 6) throw new UpstreamError(`资金流行列数不足: ${line}`);
    return {
      date: cols[0]!,
      main: toNumber(cols[1], "主力"),
      small: toNumber(cols[2], "小单"),
      medium: toNumber(cols[3], "中单"),
      large: toNumber(cols[4], "大单"),
      xlarge: toNumber(cols[5], "超大单"),
    };
  });
}

/** sina 通道：承接 30m（A 股/指数/ETF）与 futures_day（主力连续）两类请求 */
export class SinaChannel implements Channel {
  readonly name = "sina";

  constructor(private readonly deps: AkshareDeps = {}) {}

  supports(req: FetchRequest): boolean {
    if (req.freq === "30m") return TICKER_RE.test(req.code);
    if (req.freq === "futures_day") return FUTURES_RE.test(req.code);
    return false;
  }

  fetch(req: FetchRequest): Promise<Bar[]> {
    return req.freq === "30m" ? fetchSina30m(req, this.deps) : fetchSinaFuturesDay(req, this.deps);
  }
}
