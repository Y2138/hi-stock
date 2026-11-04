export type SignalRecord = Record<string, unknown> & { code: string };
export type SignalState = "qualified" | "approaching";
export interface ShortlistCandidate {
  code: string;
  name: string;
  industry_code: string;
  industry: string;
  status: SignalState;
  evidence: SignalRecord;
}

export function records(value: unknown): SignalRecord[] {
  return Array.isArray(value) ? value.filter((item): item is SignalRecord =>
    item !== null && typeof item === "object" && typeof item.code === "string") : [];
}

/** 输入已按本策略排序；这里只管理数量，不比较跨策略技术分。 */
export function simpleShortlist<T extends { code: string; industry_code?: unknown; industry?: unknown }>(
  qualified: T[], approaching: T[], limit = 5,
) {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  const kept: Array<{ item: T; status: SignalState }> = [];
  const deferred: Array<{ item: T; status: SignalState }> = [];
  const add = (item: T, status: SignalState, enabled: boolean) => {
    if (seen.has(item.code)) return;
    seen.add(item.code);
    const industry = String(item.industry_code || item.industry || `unknown:${item.code}`);
    // 未归属条目仍可复核；最终推荐必须有经过核验的一级行业。
    if (!enabled || kept.length >= limit || (counts.get(industry) ?? 0) >= 2) deferred.push({ item, status });
    else { kept.push({ item, status }); counts.set(industry, (counts.get(industry) ?? 0) + 1); }
  };
  qualified.forEach((item) => add(item, "qualified", true));
  const nearEnabled = kept.length < 3;
  let nearCount = 0;
  approaching.forEach((item) => {
    const before = kept.length;
    add(item, "approaching", nearEnabled && nearCount < 2);
    if (kept.length > before) nearCount++;
  });
  return { kept, deferred };
}
