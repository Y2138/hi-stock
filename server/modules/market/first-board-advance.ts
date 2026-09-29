import type pg from "pg";
import { fetchHithinkDataset } from "../../datasource/hithink-datasets.js";
import { fetchBatchIsolated } from "../../datasource/batch-isolation.js";
import { fetchSnapshot } from "../../datasource/hithink.js";
import { fetchLimitPoolPage } from "../../datasource/hithink-special.js";
import { cleanLimitUpThemes } from "./limit-up-signals.js";

type Db = Pick<pg.Pool, "query">;
type Raw = Record<string, unknown>;
export type IntradayLadderRole = "theme_leader" | "ladder_middle" | "theme_initiator"
  | "high_board_follower" | "ladder_replenishment" | "leadership_switch";
export type IntradayHighBoardState = "none" | "active" | "mixed" | "leader_broken";
export type IntradayExecutionRisk = "queue_fill_uncertain" | "late_seal" | "normal";

interface ThemeContext {
  width: number;
  maxStreak: number;
  tiers: Set<number>;
  leaderCodes: string[];
  brokenMaxStreak: number;
  brokenCodes: string[];
}

function shanghaiDate(ms = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
function number(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function timeMinute(value: unknown): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
function isMainBoard(code: string): boolean { return /^(600|601|603|605|000|001|002|003)\d{3}\.(SH|SZ)$/.test(code); }
async function allPool(kind: "up" | "break", date: string, db: Db) {
  const first = await fetchLimitPoolPage(kind, { tradeDate: date, page: 1, size: 200 }, { db, priority: "interactive" });
  const items = [...first.items];
  for (let page = 2; page <= first.pages; page += 1) {
    items.push(...(await fetchLimitPoolPage(kind, { tradeDate: date, page, size: 200 }, { db, priority: "interactive" })).items);
  }
  return { ...first, items };
}

export function classifyIntradayLadderRole(input: {
  streakCount: number;
  themeMaxStreak: number;
  themeTierCount: number;
  brokenMaxStreak: number;
}): { role: IntradayLadderRole; highBoardState: IntradayHighBoardState } {
  const highBoardState: IntradayHighBoardState = input.brokenMaxStreak > input.themeMaxStreak
    ? "leader_broken"
    : input.brokenMaxStreak >= 2
      ? "mixed"
      : input.themeMaxStreak >= 2 ? "active" : "none";
  if (input.streakCount >= 2) {
    return { role: input.streakCount === input.themeMaxStreak ? "theme_leader" : "ladder_middle", highBoardState };
  }
  if (highBoardState === "leader_broken") return { role: "leadership_switch", highBoardState };
  if (input.themeMaxStreak <= 1) return { role: "theme_initiator", highBoardState };
  if (input.themeTierCount >= 3 || input.themeMaxStreak >= 3) return { role: "ladder_replenishment", highBoardState };
  return { role: "high_board_follower", highBoardState };
}

export function classifyIntradayBoardForm(input: { hasTheme: boolean; oneWord: boolean; limitMinute: number | null }): {
  eligible: boolean; consistency: "high" | "normal"; executionRisk: IntradayExecutionRisk;
} {
  return {
    eligible: input.hasTheme,
    consistency: input.oneWord ? "high" : "normal",
    executionRisk: input.oneWord ? "queue_fill_uncertain" : input.limitMinute !== null && input.limitMinute > 630 ? "late_seal" : "normal",
  };
}

export interface IntradayLimitLadderResult {
  date: string;
  data_date: string;
  status: "success" | "partial" | "unavailable";
  captured_at: string;
  coverage: Record<string, number>;
  market: Record<string, number>;
  theme_contexts?: Raw[];
  signals: Raw[];
  candidates: Raw[];
  skipped: Array<{ code: string; reason: string }>;
  gaps: string[];
}

/** 10:45 单点前瞻扫描；覆盖完整涨停梯队，只保存独立快照，不写收盘市场结构事实。 */
export async function queryIntradayLimitLadder(db: Db, date: string): Promise<IntradayLimitLadderResult> {
  if (date !== shanghaiDate()) return { date, data_date: date, status: "unavailable", captured_at: new Date().toISOString(), coverage: {}, market: {}, signals: [], candidates: [], skipped: [], gaps: ["涨停梯队先手只允许扫描上海时区当前交易日"] };
  const shanghai = new Date(Date.now() + 8 * 60 * 60_000);
  const minuteOfDay = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes();
  if (minuteOfDay < 10 * 60 + 40 || minuteOfDay > 11 * 60 + 15) return { date, data_date: date, status: "unavailable", captured_at: new Date().toISOString(), coverage: {}, market: {}, signals: [], candidates: [], skipped: [], gaps: ["涨停梯队先手只允许在10:40至11:15执行，正式调度时间为10:45"] };
  const gaps: string[] = [];
  const [up, broken] = await Promise.all([allPool("up", date, db), allPool("break", date, db)]);
  const sourceTimestamp = Math.min(up.timestampMs, broken.timestampMs);
  const sourceDate = shanghaiDate(sourceTimestamp);
  if (sourceDate !== date) gaps.push(`供应商数据日 ${sourceDate} 与目标日 ${date} 不一致`);

  const rawCandidates = up.items.filter((item) => Number(item.continue_day_cnt) >= 1 && item.is_st === false && item.is_new === false
    && isMainBoard(String(item.thscode ?? "")));
  const codes = rawCandidates.map((item) => String(item.thscode));
  const quoteByCode = new Map<string, Awaited<ReturnType<typeof fetchSnapshot>>[number]>();
  const auctionByCode = new Map<string, Raw>();
  for (let index = 0; index < codes.length; index += 100) {
    const batch = codes.slice(index, index + 100);
    const quotes = await fetchBatchIsolated(batch, (part) => fetchSnapshot(part, { db, priority: "interactive" }));
    for (const quote of quotes.rows) quoteByCode.set(quote.code, quote);
    const auctions = await fetchBatchIsolated(batch, async (part) => {
      const response = await fetchHithinkDataset({ capability: "auction_snapshot", codes: part, stage: "final" }, { db, priority: "interactive" });
      return response.payload.item as Raw[];
    });
    for (const auction of auctions.rows) auctionByCode.set(String(auction.thscode), auction);
  }
  const skipped = rawCandidates.flatMap((item) => {
    const code = String(item.thscode);
    return !quoteByCode.has(code) || !auctionByCode.has(code)
      ? [{ code, reason: !quoteByCode.has(code) ? "行情快照缺失" : "竞价快照缺失" }] : [];
  });
  const skippedCodes = new Set(skipped.map((item) => item.code));
  const usableCandidates = rawCandidates.filter((item) => !skippedCodes.has(String(item.thscode)));

  const themesByCode = new Map<string, string[]>();
  const themeContext = new Map<string, ThemeContext>();
  for (const item of up.items) {
    const code = String(item.thscode ?? "");
    if (skippedCodes.has(code)) continue;
    const streak = Math.max(1, Number(item.continue_day_cnt) || 1);
    const themes = cleanLimitUpThemes(typeof item.limit_up_reason === "string" ? item.limit_up_reason : null);
    themesByCode.set(code, themes);
    for (const theme of themes) {
      const context = themeContext.get(theme) ?? { width: 0, maxStreak: 0, tiers: new Set<number>(), leaderCodes: [], brokenMaxStreak: 0, brokenCodes: [] };
      context.width += 1 / Math.max(1, themes.length);
      context.tiers.add(streak);
      if (streak > context.maxStreak) { context.maxStreak = streak; context.leaderCodes = [code]; }
      else if (streak === context.maxStreak) context.leaderCodes.push(code);
      themeContext.set(theme, context);
    }
  }
  for (const item of broken.items) {
    const code = String(item.thscode ?? "");
    const streak = Math.max(1, Number(item.continue_day_cnt) || 1);
    const themes = cleanLimitUpThemes(typeof item.limit_up_reason === "string" ? item.limit_up_reason : null);
    for (const theme of themes) {
      const context = themeContext.get(theme) ?? { width: 0, maxStreak: 0, tiers: new Set<number>(), leaderCodes: [], brokenMaxStreak: 0, brokenCodes: [] };
      if (streak > context.brokenMaxStreak) { context.brokenMaxStreak = streak; context.brokenCodes = [code]; }
      else if (streak === context.brokenMaxStreak) context.brokenCodes.push(code);
      themeContext.set(theme, context);
    }
  }

  const rolePriority: Record<IntradayLadderRole, number> = {
    theme_leader: 6, leadership_switch: 5, theme_initiator: 4,
    ladder_replenishment: 3, ladder_middle: 2, high_board_follower: 1,
  };
  const rows = usableCandidates.map((item) => {
    const code = String(item.thscode); const quote = quoteByCode.get(code); const auction = auctionByCode.get(code);
    const streakCount = Math.max(1, Number(item.continue_day_cnt) || 1);
    const minute = timeMinute(item.limit_up_time); const themes = themesByCode.get(code) ?? [];
    const mainTheme = [...themes].sort((left, right) => {
      const a = themeContext.get(left); const b = themeContext.get(right);
      return (b?.width ?? 0) - (a?.width ?? 0) || (b?.maxStreak ?? 0) - (a?.maxStreak ?? 0) || left.localeCompare(right, "zh-CN");
    })[0] ?? null;
    const context = mainTheme ? themeContext.get(mainTheme) : null;
    const { role, highBoardState } = classifyIntradayLadderRole({
      streakCount, themeMaxStreak: context?.maxStreak ?? streakCount,
      themeTierCount: context?.tiers.size ?? 1, brokenMaxStreak: context?.brokenMaxStreak ?? 0,
    });
    const seal = number(item.seal_money); const maxSeal = number(item.max_seal_money); const floatCap = number(auction?.float_market_cap);
    const oneWord = Boolean(quote && quote.open === quote.high && quote.high === quote.low && quote.close === quote.high);
    // 当前涨停池就是点时梯队事实；一字板和10:30后封板只影响排序、成交风险，不应被硬排除。
    const boardForm = classifyIntradayBoardForm({ hasTheme: Boolean(mainTheme), oneWord, limitMinute: minute });
    const auctionVolume = number(auction?.auction_volume); const unmatched = number(auction?.auction_unmatched);
    const themeWidth = context?.width ?? 0;
    const sealRetention = seal !== null && maxSeal && maxSeal > 0 ? seal / maxSeal : null;
    const sealFloatRatio = seal !== null && floatCap && floatCap > 0 ? seal / floatCap : null;
    const selectionScore = rolePriority[role] * 100 + Math.min(streakCount, 5) * 10 + Math.min(themeWidth, 10)
      + (sealRetention ?? 0) * 3 + Math.min((sealFloatRatio ?? 0) * 500, 5) + (oneWord ? 3 : 0);
    return {
      code, name: String(item.name ?? code), streak_count: streakCount, next_stage: `${streakCount}进${streakCount + 1}`,
      main_theme: mainTheme, themes, ladder_role: role, high_board_state: highBoardState,
      theme_max_streak: context?.maxStreak ?? streakCount, distance_to_leader: Math.max(0, (context?.maxStreak ?? streakCount) - streakCount),
      theme_tier_count: context?.tiers.size ?? 1, theme_tiers: [...(context?.tiers ?? new Set([streakCount]))].sort((a, b) => a - b),
      theme_leader_codes: context?.leaderCodes ?? [code], broken_leader_codes: context?.brokenCodes ?? [],
      limit_up_time: item.limit_up_time ?? null, limit_minute: minute,
      theme_width_1045: Number(themeWidth.toFixed(4)), seal_money: seal, max_seal_money: maxSeal,
      seal_retention: sealRetention === null ? null : Number(sealRetention.toFixed(4)),
      seal_float_ratio: sealFloatRatio === null ? null : Number(sealFloatRatio.toFixed(6)),
      auction_pct: number(auction?.auction_pct), auction_yesterday_ratio_pct: number(auction?.auction_yesterday_ratio_pct),
      auction_unmatched_ratio: unmatched !== null && auctionVolume && auctionVolume > 0 ? Number((unmatched / auctionVolume).toFixed(4)) : null,
      one_word: oneWord,
      intraday_consistency: boardForm.consistency,
      execution_risk: boardForm.executionRisk,
      eligible: boardForm.eligible, selection_score: Number(selectionScore.toFixed(4)),
      evidence: { captured_at: new Date(sourceTimestamp).toISOString(), current_turnover: quote?.turnover ?? null, current_low: quote?.low ?? null },
      invalidation: "11点前已炸板、收盘未封住，题材高位核心转弱，或次日竞价出现明确卖方未匹配与题材共振转弱",
    };
  }).sort((left, right) => Number(right.eligible) - Number(left.eligible)
    || right.selection_score - left.selection_score
    || (left.limit_minute ?? 9999) - (right.limit_minute ?? 9999)
    || left.code.localeCompare(right.code));

  const eligibleRows = rows.filter((row) => row.eligible);
  const selected: typeof rows = [];
  const themeCounts = new Map<string, number>();
  const add = (row: typeof rows[number] | undefined) => {
    if (!row || selected.includes(row)) return;
    const theme = row.main_theme ?? "";
    if ((themeCounts.get(theme) ?? 0) >= 2) return;
    selected.push(row); themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1);
  };
  add(eligibleRows.find((row) => row.streak_count >= 2));
  add(eligibleRows.find((row) => row.streak_count === 1));
  for (const row of eligibleRows) { if (selected.length >= 4) break; add(row); }
  selected.sort((left, right) => rows.indexOf(left) - rows.indexOf(right));
  const signals = selected.map((row, index) => ({
    ...row, priority: index + 1, signal_grade: index === 0 ? "A" : "B",
    route: row.streak_count === 1 ? "early_first_board" : "intraday_relay",
    reason: `10:45${row.next_stage}候选：${row.main_theme ?? "题材待核"} / ${row.ladder_role}`,
  }));
  const themeContexts = [...themeContext.entries()].map(([theme, context]) => ({
    theme, width_1045: Number(context.width.toFixed(4)), max_streak: context.maxStreak,
    tiers: [...context.tiers].sort((a, b) => a - b), leader_codes: context.leaderCodes,
    broken_max_streak: context.brokenMaxStreak, broken_codes: context.brokenCodes,
  })).sort((left, right) => right.width_1045 - left.width_1045 || right.max_streak - left.max_streak || left.theme.localeCompare(right.theme, "zh-CN"));
  if (rawCandidates.length > 0 && !usableCandidates.length) gaps.push("全部候选缺少可用的行情或竞价快照");
  const capturedAt = new Date(sourceTimestamp).toISOString();
  await db.query(`INSERT INTO first_board_intraday_snapshot
      (scan_date,captured_at,source_timestamp,limit_up_count,limit_break_count,payload)
    VALUES ($1,now(),$2,$3,$4,$5::jsonb)`, [date, capturedAt, up.total, broken.total, JSON.stringify({ candidates: rows, signals, theme_contexts: themeContexts, skipped })]);
  return {
    date, data_date: date, status: gaps.length ? "partial" : "success", captured_at: capturedAt,
    coverage: {
      limit_up_count: up.total, limit_break_count: broken.total, ladder_candidate_count: rawCandidates.length,
      first_board_count: rows.filter((row) => row.streak_count === 1).length,
      high_board_count: rows.filter((row) => row.streak_count >= 2).length,
      eligible_count: eligibleRows.length, signal_count: signals.length, skipped_count: skipped.length,
    },
    market: {
      limit_up_count: up.total, limit_break_count: broken.total,
      break_rate: Number((broken.total / Math.max(1, up.total + broken.total)).toFixed(4)),
      max_streak: rows.reduce((max, row) => Math.max(max, row.streak_count), 0),
    },
    theme_contexts: themeContexts, signals, candidates: rows, skipped, gaps,
  };
}
