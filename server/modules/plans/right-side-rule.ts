// 生产与研究共用的右侧日频纯规则；禁止引入配置、数据库、服务或 dotenv 依赖。

export interface RightSideSignalBar {
  code: string;
  bar_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  dif: number | null;
  macd_hist: number | null;
  indicator_status: "ready" | "untrusted" | null;
}

export interface RightSideSignalEvaluation {
  as_of: string;
  passed_count: number;
  price_signal: boolean;
  conditions: {
    dif_positive: boolean;
    ma20_rising: boolean;
    macd_accelerating: boolean;
    bullish_alignment: boolean;
    bullish_body: boolean;
    volume_expanding: boolean;
  };
  evidence: {
    close: number;
    open: number;
    dif: number;
    ma5: number;
    ma10: number;
    ma20: number;
    previous_ma20: number;
    macd_hist: number;
    previous_macd_hist: number;
    macd_hist_delta_ratio: number;
    volume: number;
    vma5: number;
    volume_threshold_ratio: number;
    limit_up: boolean;
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundLimitPrice(previousClose: number): number {
  return Math.round(previousClose * 1.1 * 100) / 100;
}

/** 只接收最近至少五根、按日期升序的可信日线；输出六项布尔结论和复核所需最小证据。 */
export function evaluateRightSideSignal(rows: RightSideSignalBar[]): RightSideSignalEvaluation | null {
  if (rows.length < 5) return null;
  const current = rows.at(-1)!;
  const previous = rows.at(-2)!;
  const volumes = rows.slice(-5).map((row) => row.volume);
  const required = [
    current.open, current.close, current.ma5, current.ma10, current.ma20, current.dif,
    current.macd_hist, previous.close, previous.ma20, previous.macd_hist, ...volumes,
  ];
  if (current.indicator_status !== "ready" || previous.indicator_status !== "ready" ||
      required.some((value) => value === null || !Number.isFinite(value)) ||
      current.open <= 0 || current.close <= 0 || previous.close <= 0 ||
      volumes.some((value) => value! <= 0)) return null;

  const vma5 = average(volumes as number[]);
  const limitUp = current.close >= roundLimitPrice(previous.close) - 1e-8;
  const volumeThresholdRatio = limitUp ? 0.5 : 1.2;
  const macdHistDeltaRatio = (current.macd_hist! - previous.macd_hist!) / current.close;
  const conditions = {
    dif_positive: current.dif! > 0,
    ma20_rising: current.ma20! > previous.ma20!,
    macd_accelerating: current.macd_hist! > 0 && macdHistDeltaRatio > 0.001,
    bullish_alignment: current.close > current.ma5! && current.ma5! > current.ma10!,
    bullish_body: current.close / current.open - 1 >= 0.01,
    volume_expanding: current.volume! > vma5 * volumeThresholdRatio,
  };
  const passedCount = Object.values(conditions).filter(Boolean).length;
  return {
    as_of: current.bar_date,
    passed_count: passedCount,
    price_signal: passedCount === 6,
    conditions,
    evidence: {
      close: current.close,
      open: current.open,
      dif: current.dif!,
      ma5: current.ma5!,
      ma10: current.ma10!,
      ma20: current.ma20!,
      previous_ma20: previous.ma20!,
      macd_hist: current.macd_hist!,
      previous_macd_hist: previous.macd_hist!,
      macd_hist_delta_ratio: macdHistDeltaRatio,
      volume: current.volume!,
      vma5,
      volume_threshold_ratio: volumeThresholdRatio,
      limit_up: limitUp,
    },
  };
}

