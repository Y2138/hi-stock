const FRACTIONAL_SECONDS = /:\d{2}(?:\.(\d+))?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

function epochMicroseconds(value: string | Date): bigint | null {
  const text = value instanceof Date ? value.toISOString() : value.trim();
  const milliseconds = new Date(text).getTime();
  if (Number.isNaN(milliseconds)) return null;
  const fraction = FRACTIONAL_SECONDS.exec(text)?.[1] ?? "";
  const subMillisecond = fraction.padEnd(6, "0").slice(3, 6);
  return BigInt(milliseconds) * 1_000n + BigInt(subMillisecond || "0");
}

/** Agent 旧查询只暴露毫秒；新查询保留微秒。按调用方实际可见精度比较版本。 */
export function sameTimestampVersion(current: string | Date, supplied: string): boolean {
  const currentMicros = epochMicroseconds(current);
  const suppliedMicros = epochMicroseconds(supplied);
  if (currentMicros === null || suppliedMicros === null) return false;
  const suppliedPrecision = FRACTIONAL_SECONDS.exec(supplied.trim())?.[1]?.length ?? 0;
  return suppliedPrecision <= 3
    ? new Date(current).getTime() === new Date(supplied).getTime()
    : currentMicros === suppliedMicros;
}
