// datasource 通道抽象类型
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §5.1

/** 行情频率（与 market_bar.freq CHECK 约束一致） */
export type MarketFreq = "day" | "30m" | "futures_day";

export interface FetchRequest {
  /** 标的代码：A 股/指数/ETF 为 000636.SZ 形式，期货主力连续为 CU0 形式 */
  code: string;
  freq: MarketFreq;
  /** 起始日期 YYYY-MM-DD */
  start: string;
  /** 结束日期 YYYY-MM-DD */
  end: string;
}

export interface Bar {
  /** 交易日 YYYY-MM-DD */
  date: string;
  /**
   * K 线时刻（ISO 8601）：30m 必填；day/futures_day 省略，
   * 落库时按 T6 存 bar_date 当日 00:00:00Z
   */
  time?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  /** 成交额（原始货币）；供应商未提供时留空，不用收盘价×成交量伪造。 */
  turnover?: number;
  /** 复权口径 forward/none；未知则省略（落库为 NULL） */
  adjustment?: "forward" | "none";
  /** 成交量单位；标准回测要求股票日线为 share/shares/股，普通行情通道可省略由落库层按频率补默认值。 */
  volumeUnit?: "share" | "shares" | "股";
}

export interface FetchResult {
  bars: Bar[];
  channel: string;
  /** 降级来源通道名（设计 §5.1：不静默切换，必须留痕） */
  degradedFrom?: string;
}

export interface Channel {
  name: string;
  supports(req: FetchRequest): boolean;
  fetch(req: FetchRequest): Promise<Bar[]>;
}
