// 生产日线指标纯函数：公式对齐 pandas ewm(adjust=false, min_periods=span)。

export const INDICATOR_CALCULATION_VERSION = "正式日线指标三版";
export const STOCK_CHARACTER_CALCULATION_VERSION = "标的入池五维画像一版";

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

export interface StockCharacterBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
}

export interface StockCharacterDimension {
  score: number;
  label: string;
  evidence: Record<string, number | null>;
}

export interface StockCharacterProfile extends Record<string, unknown> {
  dimensions: {
    washout: StockCharacterDimension;
    markup: StockCharacterDimension;
    false_breakout: StockCharacterDimension;
    defense: StockCharacterDimension;
    volatility: StockCharacterDimension;
  };
  stage: string | null;
  score: number | null;
  grade: string | null;
  stock_character: string;
  tags: string[];
  key_levels: {
    close: number | null;
    support_20d: number | null;
    resistance_20d: number | null;
    ma20: number | null;
    ma60: number | null;
  };
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

function clampScore(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100;
}

function ratioOrNeutral(success: number, total: number): number {
  return total > 0 ? success / total : 0.5;
}

function strengthLabel(score: number): string {
  return score >= 70 ? "强" : score >= 40 ? "中" : "弱";
}

function riskLabel(score: number): string {
  return score >= 60 ? "高" : score >= 30 ? "中" : "低";
}

/** 最近252日五维股性、阶段和研究评分；纯函数保证相同输入与版本得到相同输出。 */
export function calculateStockCharacterProfile(input: StockCharacterBar[]): StockCharacterProfile {
  const rows = input.slice(-252);
  if (rows.some((row) =>
    ![row.open, row.high, row.low, row.close].every((value) => Number.isFinite(value) && value > 0) ||
    [row.ma10, row.ma20, row.ma60].some((value) => value !== null && !Number.isFinite(value)))) {
    throw new Error("五维股性输入包含非有限或非正价格");
  }
  let washoutEvents = 0;
  let washoutRecovered = 0;
  let breakoutEvents = 0;
  let falseBreakouts = 0;
  // 洗盘与突破都需要当前日后的三个完整交易日，尾部未成熟事件不进入分母。
  for (let index = 20; index <= rows.length - 4; index += 1) {
    const row = rows[index]!;
    const previousClose = rows[index - 1]!.close;
    if (row.low / previousClose - 1 <= -0.03) {
      washoutEvents += 1;
      if (rows.slice(index, index + 4).some((next) => next.close >= previousClose)) washoutRecovered += 1;
    }
    const previousHigh = Math.max(...rows.slice(index - 20, index).map((item) => item.high));
    if (row.high > previousHigh) {
      breakoutEvents += 1;
      if (!rows.slice(index, index + 4).some((next) => next.close >= previousHigh)) falseBreakouts += 1;
    }
  }

  const defense = calculateDefenseRecovery(rows.map((row) => ({
    close: row.close,
    ma10: row.ma10,
  })));
  const latest = rows.at(-1);
  const return20 = rows.length >= 21 ? latest!.close / rows.at(-21)!.close - 1 : 0;
  const return60 = rows.length >= 61 ? latest!.close / rows.at(-61)!.close - 1 : 0;
  const washoutScore = clampScore(ratioOrNeutral(washoutRecovered, washoutEvents) * 100);
  const markupScore = clampScore(
    50 + return20 * 120 + return60 * 60 +
    (latest?.ma20 && latest.close >= latest.ma20 ? 10 : -10) +
    (latest?.ma20 && latest.ma60 && latest.ma20 >= latest.ma60 ? 10 : -10),
  );
  const falseBreakoutScore = clampScore(ratioOrNeutral(falseBreakouts, breakoutEvents) * 100);
  const defenseScore = clampScore((defense.recoveryRate ?? 0.5) * 100);
  const volatilityRows = rows.slice(-121);
  const returns = volatilityRows.slice(1).map((row, index) => row.close / volatilityRows[index]!.close - 1);
  const averageReturn = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((sum, value) => sum + (value - averageReturn) ** 2, 0) / (returns.length - 1)
    : 0;
  const annualizedVolatility = Math.sqrt(variance * 252);
  const volatilityScore = clampScore((annualizedVolatility - 0.1) / 0.4 * 100);
  const stabilityScore = 100 - Math.abs(volatilityScore - 45);
  const score = rows.length >= 60
    ? clampScore(
      washoutScore * 0.2 + markupScore * 0.25 + (100 - falseBreakoutScore) * 0.2 +
      defenseScore * 0.2 + stabilityScore * 0.15,
    )
    : null;
  const grade = score === null ? null : score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : "D";
  const ma20 = latest?.ma20 ?? null;
  const ma60 = latest?.ma60 ?? null;
  const high60 = rows.length ? Math.max(...rows.slice(-60).map((row) => row.high)) : null;
  const stage = !latest || ma20 === null || ma60 === null
    ? null
    : latest.close > ma20 && ma20 > ma60
      ? return20 >= 0.08 && high60 !== null && latest.close >= high60 * 0.95 ? "主升" : "上升"
      : latest.close < ma20 && ma20 < ma60
        ? "下行"
        : latest.close < ma20 && latest.close >= ma60 ? "调整" : "震荡筑底";
  const washoutLabel = strengthLabel(washoutScore);
  const markupLabel = strengthLabel(markupScore);
  const falseBreakoutLabel = riskLabel(falseBreakoutScore);
  const defenseLabel = strengthLabel(defenseScore);
  const volatilityLabel = riskLabel(volatilityScore);
  const stockCharacter = `洗盘恢复${washoutLabel}·拉升${markupLabel}·假突破风险${falseBreakoutLabel}·护盘${defenseLabel}·波动${volatilityLabel}`;

  return {
    dimensions: {
      washout: {
        score: washoutScore,
        label: washoutLabel,
        evidence: { events: washoutEvents, recovered: washoutRecovered, recovery_rate: washoutEvents ? washoutRecovered / washoutEvents : null },
      },
      markup: {
        score: markupScore,
        label: markupLabel,
        evidence: { return_20d: return20, return_60d: return60 },
      },
      false_breakout: {
        score: falseBreakoutScore,
        label: falseBreakoutLabel,
        evidence: { events: breakoutEvents, failed: falseBreakouts, failure_rate: breakoutEvents ? falseBreakouts / breakoutEvents : null },
      },
      defense: {
        score: defenseScore,
        label: defenseLabel,
        evidence: { events: defense.eventCount, recovered: defense.recoveredCount, recovery_rate: defense.recoveryRate },
      },
      volatility: {
        score: volatilityScore,
        label: volatilityLabel,
        evidence: { annualized_volatility: annualizedVolatility },
      },
    },
    stage,
    score,
    grade,
    stock_character: stockCharacter,
    tags: [
      `画像版本：${STOCK_CHARACTER_CALCULATION_VERSION}`,
      `洗盘：${washoutLabel}`,
      `拉升：${markupLabel}`,
      `假突破风险：${falseBreakoutLabel}`,
      `护盘：${defenseLabel}`,
      `波动：${volatilityLabel}`,
    ],
    key_levels: {
      close: latest?.close ?? null,
      support_20d: rows.length ? Math.min(...rows.slice(-20).map((row) => row.low)) : null,
      resistance_20d: rows.length ? Math.max(...rows.slice(-20).map((row) => row.high)) : null,
      ma20,
      ma60,
    },
  };
}
