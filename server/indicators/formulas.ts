// 生产日线指标纯函数：公式对齐 pandas ewm(adjust=false, min_periods=span)。

export const INDICATOR_CALCULATION_VERSION = "正式日线指标三版";
export const STOCK_CHARACTER_CALCULATION_VERSION = "最近252日股性指标一版";

export interface IndicatorPoint {
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  dif: number | null;
  dea: number | null;
  macdHist: number | null;
  rsi14: number | null;
}

export interface DefenseRecoveryMetric {
  inputRowCount: number;
  eventCount: number;
  recoveredCount: number;
  recoveryRate: number | null;
}

function sma(values: number[], window: number): Array<number | null> {
  const result: Array<number | null> = [];
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index]!;
    if (index >= window) sum -= values[index - window]!;
    result.push(index + 1 < window ? null : sum / window);
  }
  return result;
}

/** null 不参与有效样本计数，内部递推仍从首个有限输入开始。 */
function ema(values: Array<number | null>, span: number): Array<number | null> {
  const alpha = 2 / (span + 1);
  let state: number | null = null;
  let validCount = 0;
  return values.map((value) => {
    if (value === null || !Number.isFinite(value)) return null;
    state = state === null ? value : alpha * value + (1 - alpha) * state;
    validCount += 1;
    return validCount < span ? null : state;
  });
}

/** Wilder RSI：首个值使用 14 个涨跌额的算术平均，之后按 alpha=1/14 平滑。 */
function rsi(values: number[], period: number): Array<number | null> {
  const result = Array<number | null>(values.length).fill(null);
  if (values.length <= period) return result;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index]! - values[index - 1]!;
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }
  averageGain /= period;
  averageLoss /= period;
  const value = () => averageLoss === 0
    ? (averageGain === 0 ? 50 : 100)
    : 100 - 100 / (1 + averageGain / averageLoss);
  result[period] = value();
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index]! - values[index - 1]!;
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = value();
  }
  return result;
}

export function calculateIndicators(closes: number[]): IndicatorPoint[] {
  if (closes.some((value) => !Number.isFinite(value))) throw new Error("指标输入包含非有限收盘价");
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif = closes.map((_, index) =>
    ema12[index] === null || ema26[index] === null ? null : ema12[index]! - ema26[index]!,
  );
  const dea = ema(dif, 9);
  const rsi14 = rsi(closes, 14);
  return closes.map((_, index) => ({
    ma5: ma5[index]!,
    ma10: ma10[index]!,
    ma20: ma20[index]!,
    ma60: ma60[index]!,
    dif: dif[index]!,
    dea: dea[index]!,
    macdHist: dif[index] === null || dea[index] === null ? null : dif[index]! - dea[index]!,
    rsi14: rsi14[index]!,
  }));
}

/** 跌破 MA10 后三个交易日内重新站回；未走满三个交易日的事件不进入分母。 */
export function calculateDefenseRecovery(
  rows: Array<{ close: number; ma10: number | null }>,
  window = 252,
): DefenseRecoveryMetric {
  const start = Math.max(1, rows.length - window);
  let eventCount = 0;
  let recoveredCount = 0;
  for (let index = start; index <= rows.length - 4; index += 1) {
    const previous = rows[index - 1]!;
    const current = rows[index]!;
    if (previous.ma10 === null || current.ma10 === null || previous.close < previous.ma10 || current.close >= current.ma10) continue;
    eventCount += 1;
    if (rows.slice(index + 1, index + 4).some((row) => row.ma10 !== null && row.close >= row.ma10)) {
      recoveredCount += 1;
    }
  }
  return {
    inputRowCount: Math.min(window, rows.length),
    eventCount,
    recoveredCount,
    recoveryRate: eventCount > 0 ? recoveredCount / eventCount : null,
  };
}
