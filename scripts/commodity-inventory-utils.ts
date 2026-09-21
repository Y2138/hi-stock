// 仅供存量铝、锌、动力煤研究脚本复现的库存仓位算术；不属于运行策略。
export function inventoryInversePercentile(value: number, history: number[]): number {
  if (!history.length) return 0.5;
  let less = 0;
  let equal = 0;
  for (const item of history) {
    if (item < value) less++;
    else if (item === value) equal++;
  }
  return Math.max(0, Math.min(1, 1 - (less + equal / 2) / history.length));
}
export function copperInventoryTargetExposure(score: number): number {
  return 0.5 + 0.5 * Math.max(0, Math.min(1, score));
}
