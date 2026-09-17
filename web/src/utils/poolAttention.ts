import type { PoolAttentionEntry } from "../api/types";

type AttentionEntryLike = Pick<PoolAttentionEntry, "status" | "reason" | "missing_signals" | "valid_from" | "valid_until" | "source_job"> & Partial<Pick<PoolAttentionEntry, "source_type" | "strategy_code" | "strategy_name">>;
type AttentionMember = { attention_entries: AttentionEntryLike[]; code: string };

const STATUS_RANK: Record<AttentionEntryLike["status"], number> = {
  qualified: 0,
  approaching: 1,
  manual: 2,
};

/** 信号完整度分档：已成立 → 待补信号 → 人工关注；不混用不同来源的质量评估。 */
export function compareAttentionQuality(left: AttentionMember, right: AttentionMember): number {
  const rank = (member: AttentionMember) =>
    Math.min(...(member.attention_entries.length ? member.attention_entries.map((entry) => STATUS_RANK[entry.status]) : [3]));
  return rank(left) - rank(right) || left.code.localeCompare(right.code);
}

export function attentionStatusLabel(entry: AttentionEntryLike): string {
  if (entry.status === "qualified") return "信号已成立";
  if (entry.status === "approaching") return "待补信号 · 次日观察";
  return "人工关注";
}

export function attentionSourceLabel(entry: AttentionEntryLike): string {
  if (entry.source_type === "manual" || entry.source_job === "manual") return "人工";
  if (entry.strategy_name || entry.strategy_code) return entry.strategy_name ?? entry.strategy_code!;
  if (entry.source_job === "daily_plan_flow") return "每日计划";
  if (entry.source_job === "nightly_sector_opportunity_scan") return "夜间板块";
  if (entry.source_job === "value_anchor_opportunity_scan") return "价值错杀";
  return entry.source_job;
}

export function memberAttentionLabel(member: AttentionMember): string {
  if (!member.attention_entries.length) return "信号状态未明确";
  return member.attention_entries.map((entry) => attentionStatusLabel(entry)).join("；");
}
