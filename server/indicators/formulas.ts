// 生产日线指标纯函数：公式对齐 pandas ewm(adjust=false, min_periods=span)。

export const INDICATOR_CALCULATION_VERSION = "正式日线指标一版";

export interface IndicatorPoint {
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  dif: number | null;
  dea: number | null;
  macdHist: number | null;
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
  return closes.map((_, index) => ({
    ma5: ma5[index]!,
    ma10: ma10[index]!,
    ma20: ma20[index]!,
    ma60: ma60[index]!,
    dif: dif[index]!,
    dea: dea[index]!,
    macdHist: dif[index] === null || dea[index] === null ? null : dif[index]! - dea[index]!,
  }));
}
