/** 兼容历史 JSON 字符串；只保留当前标的与公共缺口，统一返回可读原因。 */
export function positionGapReasons(values: unknown[], code: string): string[] {
  const reasons: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return;
      if (text.startsWith("{") || text.startsWith("[")) {
        try { visit(JSON.parse(text)); return; } catch { /* 非 JSON 原文保留 */ }
      }
      reasons.push(text);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const item = value as Record<string, unknown>;
      if (typeof item.code === "string" && item.code !== code) return;
      if (typeof item.reason === "string") visit(item.reason);
      if (Array.isArray(item.gaps)) visit(item.gaps);
    }
  };
  values.forEach(visit);
  return [...new Set(reasons)];
}
