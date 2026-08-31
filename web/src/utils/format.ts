// 展示格式化小工具：时间、哈希、JSON 美化。空值一律显示「未记录」由调用方决定。

/** ISO 时间 → "YYYY-MM-DD HH:mm"（本机时区）；空值返回 null */
export function fmtTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** ISO 时间 → "YYYY-MM-DD"；空值返回 null */
export function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return iso.slice(0, 10);
}

/** 哈希截断展示（前 10 位） */
export function shortHash(hash: string | null | undefined): string | null {
  if (!hash) return null;
  return hash.slice(0, 10);
}

/** JSON 美化；null/undefined 返回 null（调用方显示「未记录」） */
export function prettyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 数字千分位；空值返回 null */
export function fmtNum(n: number | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  return n.toLocaleString("zh-CN");
}

/** 价格与成本：最多 4 位小数，去掉无意义尾零。 */
export function fmtPrice(n: number | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
}
