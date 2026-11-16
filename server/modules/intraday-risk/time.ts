// 盘中模块时间口径：给 AI 的时间文本一律使用北京墙钟。
// 数据库存 UTC、toISOString 也是 UTC，模型拿到 02:45 这类钟点会自行换算并写错时段（早盘被表述成午后）。

/** 北京墙钟 HH:mm:ss。 */
export function shanghaiClock(date = new Date()): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false, hourCycle: "h23",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(date);
}

/** 北京墙钟 YYYY-MM-DD HH:mm:ss。 */
export function shanghaiStamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${shanghaiClock(date)}`;
}

/** UTC 时间文本特征：ISO（…Z）或 PostgreSQL timestamptz（…+00）输出。 */
const UTC_TEXT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00(?::?00)?)$/;

/** 把 payload 里所有 UTC 时间文本换成北京墙钟；机器用途字段在清洗前的对象上继续用原值。 */
export function shanghaiPayloadTexts<T>(value: T): T {
  if (typeof value === "string") {
    if (!UTC_TEXT.test(value)) return value;
    const parsed = new Date(value);
    return (Number.isNaN(parsed.getTime()) ? value : shanghaiStamp(parsed)) as T;
  }
  if (Array.isArray(value)) return value.map((item) => shanghaiPayloadTexts(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = shanghaiPayloadTexts(item);
    return out as T;
  }
  return value;
}
