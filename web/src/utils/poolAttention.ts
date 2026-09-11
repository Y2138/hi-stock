import type { PoolMember } from "../api/types";

type AttentionMember = Pick<PoolMember, "attention_signal" | "code">;

/** 信号完整度分档；不混用研究评分，也不按不同策略的条件条数推断质量。 */
export function compareAttentionQuality(left: AttentionMember, right: AttentionMember): number {
  const rank = (member: AttentionMember) => member.attention_signal?.status === "qualified" ? 0
    : member.attention_signal?.status === "approaching" ? 1 : 2;
  return rank(left) - rank(right) || left.code.localeCompare(right.code);
}

export function attentionSignalLabel(member: AttentionMember): string {
  if (member.attention_signal?.status === "qualified") return "信号已成立";
  if (member.attention_signal?.status === "approaching") return "待补信号 · 次日观察";
  return "信号状态未明确";
}
