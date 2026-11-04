// 超短提醒文案与入队：所有节点只通过这里发消息，保证措辞、去重键和“不自动下单”边界一致。
import type { Db } from "./types.js";
import { enqueueUltraShortAlert } from "../notifications/service.js";
import { AUCTION_BRANCH_LABELS } from "./types.js";

export interface AlertCandidate {
  code: string;
  name: string;
  target_date: string;
  priority?: string | null;
  auction_priority?: string | null;
  auction_branch?: string | null;
  auction_fill_tier?: string | null;
  tags?: string[];
  key_levels?: Record<string, unknown>;
  risk?: Record<string, unknown>;
  auction_metrics?: Record<string, unknown>;
  queue_window?: Record<string, unknown>;
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pct(value: number | null, digits = 2): string {
  return value === null ? "待补" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function price(value: unknown): string {
  const parsed = number(value);
  return parsed === null ? "待补" : parsed.toFixed(2);
}

function shanghaiTime(at: Date): string {
  return at.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function fillTierLabel(tier: string | null | undefined): string {
  if (tier === "high") return "高";
  if (tier === "medium") return "中";
  if (tier === "low") return "低";
  return "无";
}

function branchLabel(branch: string | null | undefined): string {
  return branch && branch in AUCTION_BRANCH_LABELS
    ? AUCTION_BRANCH_LABELS[branch as keyof typeof AUCTION_BRANCH_LABELS]
    : "数据不足";
}

function riskLine(candidate: AlertCandidate): string {
  const stop = price(candidate.key_levels?.stop_price);
  const position = number(candidate.risk?.position_cap_pct);
  return `止损：${stop}｜仓位上限：${position === null ? "按总风控" : `${position.toFixed(0)}%`}`;
}

function footer(): string {
  return "是否买入、买多少由你决定，系统只提醒、不自动下单。";
}

/** 09:20–09:24 一字延续买入提醒。 */
export async function notifyAuctionBuy(
  db: Db,
  candidate: AlertCandidate,
  at: Date,
): Promise<boolean> {
  const metrics = candidate.auction_metrics ?? {};
  const auctionPct = number(metrics.auction_pct);
  const unmatchedRatio = number(metrics.unmatched_ratio);
  const turnover = number(metrics.auction_turnover_pct);
  const limitPrice = price(candidate.key_levels?.limit_up_price);
  const content = [
    `Stock｜超短一字买入提醒｜${shanghaiTime(at)}｜${candidate.target_date}`,
    "",
    `${candidate.name}（${candidate.code}）｜竞价优先级 ${candidate.auction_priority ?? candidate.priority ?? "P3"}`,
    `分支：一字延续｜成交概率：${fillTierLabel(candidate.auction_fill_tier)}`,
    `竞价涨幅：${pct(auctionPct)}｜涨停价：${limitPrice}`,
    `未匹配：${metrics.auction_unmatched ?? "待补"}｜未匹配/竞价量：${unmatchedRatio === null ? "待补" : unmatchedRatio.toFixed(2)}｜竞价换手：${turnover === null ? "待补" : `${turnover.toFixed(2)}%`}`,
    `排队窗口：09:20–09:24，以涨停价 ${limitPrice} 排队；越早挂单越靠前，但不保证成交`,
    riskLine(candidate),
    "风险：未成交不追价、不在开盘后补买；开板、未匹配转负、换手异常时撤单复核。",
    footer(),
  ].join("\n");
  return enqueueUltraShortAlert(db, {
    event_key: `ultra:auction_buy:${candidate.target_date}:${candidate.code}`,
    content,
  });
}

/** 成交概率档或竞价强度明显增强时的升级提醒，每只最多一次。 */
export async function notifyAuctionUpgrade(
  db: Db,
  candidate: AlertCandidate,
  at: Date,
): Promise<boolean> {
  const metrics = candidate.auction_metrics ?? {};
  const content = [
    `Stock｜超短竞价升级提醒｜${shanghaiTime(at)}｜${candidate.target_date}`,
    "",
    `${candidate.name}（${candidate.code}）｜成交概率：${fillTierLabel(candidate.auction_fill_tier)}`,
    `竞价涨幅：${pct(number(metrics.auction_pct))}｜竞价换手：${number(metrics.auction_turnover_pct) === null ? "待补" : `${(number(metrics.auction_turnover_pct) as number).toFixed(2)}%`}`,
    "竞价强度较上次提醒增强，排队成交概率提高；仍需 09:20–09:24 以涨停价排队。",
    riskLine(candidate),
    footer(),
  ].join("\n");
  return enqueueUltraShortAlert(db, {
    event_key: `ultra:auction_upgrade:${candidate.target_date}:${candidate.code}`,
    content,
  });
}

/** 提醒条件恶化：发撤单复核提醒，不再补发买入提醒。 */
export async function notifyAuctionCancel(
  db: Db,
  candidate: AlertCandidate,
  reason: string,
  at: Date,
): Promise<boolean> {
  const content = [
    `Stock｜超短撤单复核提醒｜${shanghaiTime(at)}｜${candidate.target_date}`,
    "",
    `${candidate.name}（${candidate.code}）｜原提醒：${branchLabel(candidate.auction_branch)}`,
    `失效原因：${reason}`,
    "请复核排队或已排队订单；不追价，不补买。",
    footer(),
  ].join("\n");
  return enqueueUltraShortAlert(db, {
    event_key: `ultra:auction_cancel:${candidate.target_date}:${candidate.code}`,
    content,
  });
}

/** 02 盘中唯一首选的排队提醒；只提醒首选，不提醒其余候选。 */
export async function notifyQueuePreferred(
  db: Db,
  input: {
    trade_date: string;
    code: string;
    name: string;
    streak_count: number | null;
    seal_money: number | null;
    auction_strength: string;
    risk_flags: string[];
    limit_price: number | null;
    invalidation: string;
  },
  at: Date,
): Promise<boolean> {
  const strengthLabel = input.auction_strength === "strong" ? "竞价强"
    : input.auction_strength === "neutral" ? "竞价中性" : "竞价待确认";
  const content = [
    `Stock｜盘中排队提醒｜${shanghaiTime(at)}｜${input.trade_date}`,
    "",
    `${input.name}（${input.code}）｜${input.streak_count ?? "?"} 板｜${strengthLabel}`,
    `当前涨停价：${price(input.limit_price)}｜封单：${input.seal_money === null ? "待补" : `${(input.seal_money / 1e8).toFixed(2)} 亿`}`,
    `风险标记：${input.risk_flags.length ? input.risk_flags.join("、") : "无"}`,
    `失效条件：${input.invalidation}`,
    "排队不保证成交；是否排队、买多少由你决定，系统不自动下单。",
  ].join("\n");
  return enqueueUltraShortAlert(db, {
    event_key: `ultra:queue_preferred:${input.trade_date}:${input.code}`,
    content,
  });
}
