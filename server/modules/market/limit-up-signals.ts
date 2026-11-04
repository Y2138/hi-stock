import crypto from "node:crypto";
import type pg from "pg";
import { compareLimitUpPk, limitUpPkNews, limitUpPkProfile, sameHeightPkGroups, type LimitUpPkProfile } from "./limit-up-pk.js";

type Db = Pick<pg.Pool, "query">;

export const LIMIT_UP_RANKED_FEATURES = [
  "theme_share",
  "theme_max_streak",
  "theme_tier_count",
  "market_hhi",
  "market_limit_up_count",
  "theme_turnover_log",
  "seal_turnover_ratio",
  "seal_minutes",
  "theme_pre5_return",
  "theme_width",
  "stock_pre5_return",
] as const;

export type LimitUpRankedFeature = (typeof LIMIT_UP_RANKED_FEATURES)[number];

export interface LimitUpEventInput {
  date: string;
  event_type: "up" | "down" | "break";
  code: string;
  name: string;
  streak_count: number | null;
  open_count: number | null;
  first_event_time: string | null;
  reason: string | null;
  is_st: boolean | null;
  is_new: boolean | null;
  seal_money: number | null;
  max_seal_money: number | null;
  turnover: number | null;
}

export interface LimitUpBarInput {
  date: string;
  code: string;
  open: number;
  close: number;
  turnover: number | null;
  high?: number;
  low?: number;
  volume?: number | null;
}

export interface LimitUpRawFeatures extends Record<LimitUpRankedFeature, number | null> {
  persistence_5d: number | null;
  above_ma20: number | null;
  promotion_rate: number | null;
  negative_feedback: number | null;
  first_board_share: number | null;
  core_position: number | null;
}

export interface LimitUpBenchmark {
  code: string;
  document_id: string;
  training_start: string;
  training_end: string;
  methodology: string;
  distributions: Record<LimitUpRankedFeature, number[]>;
  sample_counts: Record<string, number>;
  source_summary: Record<string, unknown>;
  sha256: string;
}

export interface LimitUpSignalCandidate {
  code: string;
  name: string;
  main_theme: string;
  streak_count: number;
  open_count: number | null;
  seal_money: number | null;
  turnover: number | null;
  features: LimitUpRawFeatures;
  ranks: Record<LimitUpRankedFeature, number>;
  cluster_score: number;
  momentum_score: number;
  cluster_rank: number;
  momentum_rank: number;
  cluster_signal: boolean;
  momentum_signal: boolean;
  signal_grade: "A" | "B-抱团" | "B-主升" | null;
  data_status: "ready" | "data_insufficient";
  missing_inputs: string[];
  neutral_inputs: string[];
  risk_flags: string[];
  pk?: LimitUpPkProfile;
  pk_minute?: number | null;
  pk_turnover?: number | null;
  pk_core?: number | null;
}

export interface LimitUpSignalResult {
  date: string;
  strategy_document_id: string | null;
  benchmark: Omit<LimitUpBenchmark, "distributions"> | null;
  status: "success" | "partial" | "unavailable";
  gaps: string[];
  candidate_count: number;
  skipped_count: number;
  skipped: Array<{ code: string; missing_inputs: string[] }>;
  signal_count: number;
  intraday_review_count: number;
  intraday_reviews: Array<{
    code: string;
    name: string;
    intraday_streak_count: number | null;
    intraday_route: string | null;
    close_status: "confirmed_signal" | "sealed_not_selected" | "not_sealed";
    close_signal_grade: LimitUpSignalCandidate["signal_grade"];
  }>;
  signals: LimitUpSignalCandidate[];
  candidates: LimitUpSignalCandidate[];
  selection_method?: "stage_pk_v2";
  score_usage?: "legacy_context_only";
  same_height_pk?: ReturnType<typeof sameHeightPkGroups>;
  pk_news?: Awaited<ReturnType<typeof limitUpPkNews>>;
  route_leaders?: { cluster: string | null; momentum: string | null };
  pk_market?: { limit_up_count: number; limit_break_count: number | null; limit_down_count: number | null;
    break_rate: number | null; highest_streak: number; highest_codes: string[]; gaps: string[] };
}

interface ThemeMember {
  event: LimitUpEventInput;
  weight: number;
}

interface ThemeAggregate {
  width: number;
  maxStreak: number;
  tiers: Set<number>;
  members: ThemeMember[];
}

interface DayContext {
  date: string;
  upEvents: LimitUpEventInput[];
  tagsByCode: Map<string, string[]>;
  themes: Map<string, ThemeAggregate>;
  totalWidth: number;
  hhi: number;
  topThemes: Set<string>;
}

const COMPANY_EVENT_WORDS = ["业绩", "回购", "中标", "重组", "增持", "减持", "签订", "收购", "控制权", "股权转让"];
const THEME_ALIASES: Array<[RegExp, string]> = [
  [/控制权.*变更|实控人.*变更|股权转让/u, "控制权变更"],
  [/资产重组|重大.*重组|拟收购|收购.*股权/u, "资产重组"],
  [/出版发行|图书发行|教科书发行|出版传媒/u, "出版传媒"],
  [/海上风电|风力发电|风电/u, "风电"],
  [/氢能源?|燃料电池/u, "氢能"],
  [/绿色电力|清洁能源|绿电/u, "绿电"],
  [/液冷/u, "液冷"],
  [/CPO|光通信|光模块/iu, "光模块"],
  [/人形机器人|机器人/u, "机器人"],
  [/国企混改|央企改革|国企改革/u, "国企改革"],
];

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function clamp01(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.min(1, Math.max(0, value));
}

function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function weightedRatio(values: Array<{ weight: number; hit: boolean }>): number | null {
  const denominator = values.reduce((sum, value) => sum + value.weight, 0);
  if (denominator <= 0) return null;
  return values.reduce((sum, value) => sum + (value.hit ? value.weight : 0), 0) / denominator;
}

function isMainBoard(code: string): boolean {
  return /^(?:600|601|603|605|000|001|002|003)\d{3}\.(?:SH|SZ)$/.test(code);
}

function isStName(name: string): boolean {
  return /^(?:\*?ST|S\*ST)/iu.test(name.trim());
}

export function cleanLimitUpThemes(reason: string | null): string[] {
  if (!reason) return [];
  const result: string[] = [];
  for (const raw of reason
    .replace(/\([^)]*\)|（[^）]*）/gu, "")
    .split(/[+＋/、，,;；|｜]/u)) {
    let value = raw.replace(/概念/gu, "").trim();
    if (value.length < 2) continue;
    let aliased = false;
    for (const [pattern, alias] of THEME_ALIASES) {
      if (pattern.test(value)) {
        value = alias;
        aliased = true;
        break;
      }
    }
    // 重组、控制权等可形成独立交易叙事；普通公司事项不能当成已核验利好。
    if (!aliased && COMPANY_EVENT_WORDS.some((word) => value.includes(word))) continue;
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function buildDayContexts(events: LimitUpEventInput[]): Map<string, DayContext> {
  const upsByDate = new Map<string, LimitUpEventInput[]>();
  for (const event of events) {
    if (event.event_type !== "up") continue;
    const list = upsByDate.get(event.date) ?? [];
    list.push(event);
    upsByDate.set(event.date, list);
  }
  const result = new Map<string, DayContext>();
  for (const [date, upEvents] of upsByDate) {
    const tagsByCode = new Map<string, string[]>();
    const themes = new Map<string, ThemeAggregate>();
    let totalWidth = 0;
    for (const event of upEvents) {
      const tags = cleanLimitUpThemes(event.reason);
      tagsByCode.set(event.code, tags);
      if (!tags.length) continue;
      const weight = 1 / tags.length;
      totalWidth += 1;
      for (const tag of tags) {
        const aggregate = themes.get(tag) ?? { width: 0, maxStreak: 0, tiers: new Set<number>(), members: [] };
        const streak = event.streak_count ?? 1;
        aggregate.width += weight;
        aggregate.maxStreak = Math.max(aggregate.maxStreak, streak);
        aggregate.tiers.add(streak <= 1 ? 1 : streak === 2 ? 2 : 3);
        aggregate.members.push({ event, weight });
        themes.set(tag, aggregate);
      }
    }
    const hhi = totalWidth > 0
      ? [...themes.values()].reduce((sum, theme) => sum + (theme.width / totalWidth) ** 2, 0)
      : 0;
    const topThemes = new Set([...themes.entries()]
      .sort((left, right) => right[1].width - left[1].width || left[0].localeCompare(right[0], "zh-CN"))
      .slice(0, 3)
      .map(([tag]) => tag));
    result.set(date, { date, upEvents, tagsByCode, themes, totalWidth, hhi, topThemes });
  }
  return result;
}

function selectMainTheme(
  tags: string[],
  context: DayContext,
  priorContexts: DayContext[],
  code: string,
): string | null {
  return [...tags].sort((left, right) => {
    const continuity = (tag: string) => priorContexts.filter((item) => (item.tagsByCode.get(code) ?? []).includes(tag)).length;
    const continuityDiff = continuity(right) - continuity(left);
    if (continuityDiff) return continuityDiff;
    const width = (context.themes.get(right)?.width ?? 0) - (context.themes.get(left)?.width ?? 0);
    if (width) return width;
    const rightTop = priorContexts.filter((item) => item.topThemes.has(right)).length;
    const leftTop = priorContexts.filter((item) => item.topThemes.has(left)).length;
    return rightTop - leftTop || left.localeCompare(right, "zh-CN");
  })[0] ?? null;
}

function barMaps(bars: LimitUpBarInput[]): {
  byCode: Map<string, LimitUpBarInput[]>;
  byKey: Map<string, LimitUpBarInput>;
} {
  const byCode = new Map<string, LimitUpBarInput[]>();
  const byKey = new Map<string, LimitUpBarInput>();
  for (const bar of bars) {
    const list = byCode.get(bar.code) ?? [];
    list.push(bar);
    byCode.set(bar.code, list);
    byKey.set(`${bar.code}:${bar.date}`, bar);
  }
  for (const list of byCode.values()) list.sort((left, right) => left.date.localeCompare(right.date));
  return { byCode, byKey };
}

function rankOfDate(tradingDates: string[], date: string): number {
  return tradingDates.indexOf(date);
}

function pre5Return(
  code: string,
  date: string,
  tradingDates: string[],
  byKey: Map<string, LimitUpBarInput>,
): number | null {
  const index = rankOfDate(tradingDates, date);
  if (index < 6) return null;
  const recent = byKey.get(`${code}:${tradingDates[index - 1]}`);
  const base = byKey.get(`${code}:${tradingDates[index - 6]}`);
  return recent && base && base.close > 0 ? recent.close / base.close - 1 : null;
}

function aboveMa20(
  code: string,
  date: string,
  byCode: Map<string, LimitUpBarInput[]>,
): number | null {
  const history = (byCode.get(code) ?? []).filter((bar) => bar.date < date).slice(-20);
  if (history.length < 15) return null;
  const average = history.reduce((sum, bar) => sum + bar.close, 0) / history.length;
  return history.at(-1)!.close > average ? 1 : 0;
}

function eventSets(events: LimitUpEventInput[]): Map<string, { up: Map<string, LimitUpEventInput>; down: Set<string>; break: Set<string> }> {
  const result = new Map<string, { up: Map<string, LimitUpEventInput>; down: Set<string>; break: Set<string> }>();
  for (const event of events) {
    const item = result.get(event.date) ?? { up: new Map(), down: new Set(), break: new Set() };
    if (event.event_type === "up") item.up.set(event.code, event);
    else item[event.event_type].add(event.code);
    result.set(event.date, item);
  }
  return result;
}

export function buildLimitUpFeatureRows(input: {
  events: LimitUpEventInput[];
  bars: LimitUpBarInput[];
  tradingDates: string[];
  targetDates: string[];
}): Array<{
  event: LimitUpEventInput;
  mainTheme: string;
  features: LimitUpRawFeatures;
  missingInputs: string[];
  pk?: LimitUpPkProfile;
}> {
  const contexts = buildDayContexts(input.events);
  const maps = barMaps(input.bars);
  const sets = eventSets(input.events);
  const rows: Array<{ event: LimitUpEventInput; mainTheme: string; features: LimitUpRawFeatures; missingInputs: string[]; pk?: LimitUpPkProfile }> = [];

  for (const date of input.targetDates) {
    const context = contexts.get(date);
    if (!context) continue;
    const tradingDateIndex = rankOfDate(input.tradingDates, date);
    if (tradingDateIndex < 0) continue;
    const mainThemeContexts = input.tradingDates.slice(Math.max(0, tradingDateIndex - 4), tradingDateIndex + 1)
      .map((value) => contexts.get(value)!)
      .filter(Boolean);
    const persistenceContexts = input.tradingDates.slice(Math.max(0, tradingDateIndex - 5), tradingDateIndex)
      .map((value) => contexts.get(value));
    const priorDate = input.tradingDates[tradingDateIndex - 1] ?? null;
    const previousContext = priorDate ? contexts.get(priorDate) : undefined;
    const currentSets = sets.get(date);

    for (const event of context.upEvents) {
      if (!isMainBoard(event.code) || event.is_st !== false || isStName(event.name) || event.is_new !== false || event.streak_count === null) continue;
      const tags = context.tagsByCode.get(event.code) ?? [];
      const mainTheme = selectMainTheme(tags, context, mainThemeContexts, event.code);
      if (!mainTheme) continue;
      const theme = context.themes.get(mainTheme)!;
      const missingInputs: string[] = [];
      const turnovers = theme.members.map((member) => member.event.turnover).filter((value): value is number => value !== null && value > 0);
      const themePreReturns = theme.members
        .map((member) => pre5Return(member.event.code, date, input.tradingDates, maps.byKey))
        .filter((value): value is number => value !== null);
      const ma20Values = theme.members
        .map((member) => aboveMa20(member.event.code, date, maps.byCode))
        .filter((value): value is number => value !== null);
      const stockReturn = pre5Return(event.code, date, input.tradingDates, maps.byKey);
      const sealRatio = event.seal_money !== null && event.turnover !== null && event.turnover > 0
        ? event.seal_money / event.turnover
        : null;
      let sealMinutes: number | null = null;
      if (event.first_event_time) {
        const parsed = new Date(event.first_event_time);
        if (!Number.isNaN(parsed.getTime())) {
          sealMinutes = Math.min(330, Math.max(0,
            parsed.getUTCHours() * 60 + parsed.getUTCMinutes() + 8 * 60 - (9 * 60 + 30),
          ));
        }
      }
      const persistence = persistenceContexts.length === 5 && persistenceContexts.every(Boolean)
        ? persistenceContexts.filter((item) => (item!.themes.get(mainTheme)?.width ?? 0) > 0).length / 5
        : null;

      const promotionParts: number[] = [];
      if (previousContext) {
        const previousMembers = (previousContext.themes.get(mainTheme)?.members ?? [])
          .filter((member) => member.event.is_new === false);
        for (const [from, to] of [[1, 2], [2, 3]] as const) {
          const rate = weightedRatio(previousMembers
            .filter((member) => (member.event.streak_count ?? 1) === from)
            .map((member) => ({
              weight: member.weight,
              hit: (currentSets?.up.get(member.event.code)?.streak_count ?? 0) >= to,
            })));
          if (rate !== null) promotionParts.push(rate);
        }
      }
      const promotionRate = median(promotionParts);

      let negativeFeedback: number | null = null;
      if (previousContext && priorDate) {
        const previousMembers = (previousContext.themes.get(mainTheme)?.members ?? [])
          .filter((member) => member.event.is_new === false);
        const ratios = [
          weightedRatio(previousMembers.flatMap((member) => {
            const currentBar = maps.byKey.get(`${member.event.code}:${date}`);
            const priorBar = maps.byKey.get(`${member.event.code}:${priorDate}`);
            return currentBar && priorBar ? [{ weight: member.weight, hit: currentBar.open < priorBar.close }] : [];
          })),
          weightedRatio(previousMembers.map((member) => ({ weight: member.weight, hit: currentSets?.down.has(member.event.code) ?? false }))),
          weightedRatio(previousMembers.map((member) => ({ weight: member.weight, hit: currentSets?.break.has(member.event.code) ?? false }))),
        ].filter((value): value is number => value !== null);
        negativeFeedback = ratios.length
          ? ratios.reduce((sum, value) => sum + value, 0) / ratios.length
          : null;
      }

      const themeWidth = theme.width;
      const firstBoardShare = themeWidth > 0
        ? theme.members.filter((member) => (member.event.streak_count ?? 1) <= 1)
          .reduce((sum, member) => sum + member.weight, 0) / themeWidth
        : null;
      const features: LimitUpRawFeatures = {
        theme_share: context.totalWidth > 0 ? themeWidth / context.totalWidth : null,
        theme_max_streak: theme.maxStreak || null,
        theme_tier_count: theme.tiers.size || null,
        market_hhi: context.hhi,
        market_limit_up_count: context.upEvents.length,
        theme_turnover_log: turnovers.length ? Math.log1p(median(turnovers)!) : null,
        seal_turnover_ratio: sealRatio,
        seal_minutes: sealMinutes,
        theme_pre5_return: median(themePreReturns),
        theme_width: themeWidth,
        stock_pre5_return: stockReturn,
        persistence_5d: persistence,
        above_ma20: median(ma20Values),
        promotion_rate: promotionRate,
        negative_feedback: negativeFeedback,
        first_board_share: firstBoardShare,
        core_position: theme.maxStreak > 0 ? clamp01(event.streak_count / theme.maxStreak) : null,
      };
      // 板块聚合只使用有效成员；停牌成员不得把其他成员的完整数据标为缺失。
      if (!turnovers.length) missingInputs.push("theme_turnover_log");
      if (!themePreReturns.length) missingInputs.push("theme_pre5_return");
      if (!ma20Values.length) missingInputs.push("above_ma20");
      if (stockReturn === null) missingInputs.push("stock_pre5_return");
      if (persistence === null) missingInputs.push("persistence_5d");
      if (priorDate && !previousContext) missingInputs.push("promotion_rate", "negative_feedback");
      if (event.seal_money === null) missingInputs.push("seal_money");
      if (event.turnover === null || event.turnover <= 0) missingInputs.push("turnover");
      if (sealMinutes === null) missingInputs.push("first_event_time");
      const currentBar = maps.byKey.get(`${event.code}:${date}`);
      const previousBar = priorDate ? maps.byKey.get(`${event.code}:${priorDate}`) : undefined;
      const oneWord = currentBar?.high !== undefined && currentBar.low !== undefined && currentBar.volume != null && currentBar.volume > 0
        ? currentBar.open === currentBar.high && currentBar.high === currentBar.low && currentBar.low === currentBar.close : null;
      rows.push({ event, mainTheme, features, missingInputs, pk: limitUpPkProfile({
        code: event.code, streak: event.streak_count, seal: event.seal_money, maxSeal: event.max_seal_money,
        turnover: event.turnover, minute: sealMinutes, core: features.core_position, oneWord, phase: "close",
        volumeRatio: currentBar?.volume != null && previousBar?.volume != null && previousBar.volume > 0
          ? currentBar.volume / previousBar.volume : null,
      }) });
    }
  }
  return rows;
}

function lowerBound(values: number[], target: number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (values[middle]! < target) left = middle + 1;
    else right = middle;
  }
  return left;
}

function upperBound(values: number[], target: number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (values[middle]! <= target) left = middle + 1;
    else right = middle;
  }
  return left;
}

export function empiricalMidrank(value: number | null, distribution: number[]): number {
  if (value === null || !Number.isFinite(value) || !distribution.length) return 0.5;
  return (lowerBound(distribution, value) + upperBound(distribution, value)) / (2 * distribution.length);
}

export function collectLimitUpBenchmark(rows: ReturnType<typeof buildLimitUpFeatureRows>): {
  distributions: Record<LimitUpRankedFeature, number[]>;
  sample_counts: Record<LimitUpRankedFeature, number>;
} {
  const distributions = Object.fromEntries(
    LIMIT_UP_RANKED_FEATURES.map((feature) => [feature, [] as number[]]),
  ) as unknown as Record<LimitUpRankedFeature, number[]>;
  for (const row of rows) {
    for (const feature of LIMIT_UP_RANKED_FEATURES) {
      const value = row.features[feature];
      if (value !== null && Number.isFinite(value)) distributions[feature].push(round(value, 10));
    }
  }
  for (const values of Object.values(distributions)) values.sort((left, right) => left - right);
  return {
    distributions,
    sample_counts: Object.fromEntries(LIMIT_UP_RANKED_FEATURES.map((feature) => [feature, distributions[feature].length])) as Record<LimitUpRankedFeature, number>,
  };
}

function scoreFeature(value: number | null): number {
  return clamp01(value) ?? 0.5;
}

/** 固定基准的背景计算；第二版不使用这里的分数线决定候选成立。 */
export function scoreLimitUpFeatureRows(
  rows: ReturnType<typeof buildLimitUpFeatureRows>,
  benchmark: LimitUpBenchmark,
): LimitUpSignalCandidate[] {
  const candidates = rows.map((row) => {
    const ranks = Object.fromEntries(LIMIT_UP_RANKED_FEATURES.map((feature) => [
      feature,
      empiricalMidrank(row.features[feature], benchmark.distributions[feature] ?? []),
    ])) as Record<LimitUpRankedFeature, number>;
    const down = (feature: LimitUpRankedFeature) => 1 - ranks[feature];
    const clusterScore = 100 * (
      0.18 * ranks.theme_share
      + 0.18 * ranks.theme_max_streak
      + 0.12 * ranks.theme_tier_count
      + 0.10 * ranks.market_hhi
      + 0.10 * down("market_limit_up_count")
      + 0.08 * down("theme_turnover_log")
      + 0.12 * scoreFeature(row.features.core_position)
      + 0.08 * ranks.seal_turnover_ratio
      + 0.04 * down("seal_minutes")
    );
    const momentumScore = 100 * (
      0.18 * scoreFeature(row.features.persistence_5d)
      + 0.20 * ranks.theme_pre5_return
      + 0.16 * scoreFeature(row.features.above_ma20)
      + 0.14 * ranks.theme_width
      + 0.10 * scoreFeature(row.features.promotion_rate)
      + 0.10 * (1 - scoreFeature(row.features.negative_feedback))
      + 0.06 * scoreFeature(row.features.first_board_share)
      + 0.06 * ranks.stock_pre5_return
    );
    const riskFlags: string[] = [];
    if ((row.features.persistence_5d ?? 1) < 0.6) riskFlags.push("近5日持续性不足");
    if ((row.features.above_ma20 ?? 1) < 0.5) riskFlags.push("多数题材成员未站上MA20");
    if ((row.features.negative_feedback ?? 0) > 0.5) riskFlags.push("题材前排负反馈偏高");
    if ((row.features.promotion_rate ?? 1) < 0.3) riskFlags.push("题材晋级率偏低");
    if (ranks.seal_turnover_ratio < 0.25) riskFlags.push("封单相对成交额偏弱");
    if ((row.event.open_count ?? 0) > 0) riskFlags.push("盘中曾开板");
    if ((row.features.theme_tier_count ?? 0) <= 1) riskFlags.push("题材梯队单薄");
    const dataInsufficient = ["seal_money", "turnover", "first_event_time"]
      .some((key) => row.missingInputs.includes(key));
    const uniqueMissingInputs = [...new Set(row.missingInputs)];
    const neutralInputs = Object.entries(row.features)
      .filter(([key, value]) => value === null && !uniqueMissingInputs.includes(key))
      .map(([key]) => key);
    const candidate: LimitUpSignalCandidate = {
      code: row.event.code,
      name: row.event.name,
      main_theme: row.mainTheme,
      streak_count: row.event.streak_count!,
      open_count: row.event.open_count,
      seal_money: row.event.seal_money,
      turnover: row.event.turnover,
      features: row.features,
      ranks,
      cluster_score: round(clusterScore, 2),
      momentum_score: round(momentumScore, 2),
      cluster_rank: 0,
      momentum_rank: 0,
      cluster_signal: false,
      momentum_signal: false,
      signal_grade: null,
      data_status: dataInsufficient ? "data_insufficient" : "ready",
      missing_inputs: uniqueMissingInputs,
      neutral_inputs: neutralInputs,
      risk_flags: riskFlags,
    };
    return candidate;
  });
  const eligible = candidates.filter((candidate) => candidate.data_status === "ready");
  [...eligible].sort((left, right) => right.cluster_score - left.cluster_score || left.code.localeCompare(right.code))
    .forEach((candidate, index) => { candidate.cluster_rank = index + 1; });
  [...eligible].sort((left, right) => right.momentum_score - left.momentum_score || left.code.localeCompare(right.code))
    .forEach((candidate, index) => { candidate.momentum_rank = index + 1; });
  for (const candidate of candidates) {
    candidate.cluster_signal = candidate.data_status === "ready" && candidate.cluster_score >= 69.35 && candidate.cluster_rank <= 2;
    candidate.momentum_signal = candidate.data_status === "ready" && candidate.momentum_score >= 70.03 && candidate.momentum_rank <= 2;
    candidate.signal_grade = candidate.cluster_signal && candidate.momentum_signal
      ? "A"
      : candidate.cluster_signal
        ? "B-抱团"
        : candidate.momentum_signal
          ? "B-主升"
          : null;
  }
  return candidates.sort((left, right) => {
    const gradeOrder = (candidate: LimitUpSignalCandidate) => candidate.signal_grade === "A"
      ? 0
      : candidate.signal_grade
        ? 1
        : 2;
    const gradeDiff = gradeOrder(left) - gradeOrder(right);
    if (gradeDiff) return gradeDiff;
    if (left.signal_grade === "A" && right.signal_grade === "A") {
      const rankDiff = left.cluster_rank + left.momentum_rank - right.cluster_rank - right.momentum_rank;
      const leftMargin = left.cluster_score - 69.35 + left.momentum_score - 70.03;
      const rightMargin = right.cluster_score - 69.35 + right.momentum_score - 70.03;
      return rankDiff || rightMargin - leftMargin || left.code.localeCompare(right.code);
    }
    if (left.signal_grade && right.signal_grade) {
      const leftRank = left.cluster_signal ? left.cluster_rank : left.momentum_rank;
      const rightRank = right.cluster_signal ? right.cluster_rank : right.momentum_rank;
      const leftScore = left.cluster_signal ? left.cluster_score : left.momentum_score;
      const rightScore = right.cluster_signal ? right.cluster_score : right.momentum_score;
      return leftRank - rightRank || rightScore - leftScore || left.code.localeCompare(right.code);
    }
    return right.cluster_score - left.cluster_score
      || right.momentum_score - left.momentum_score
      || left.code.localeCompare(right.code);
  });
}

/** 旧分数只作背景；新候选按阶段、同高度承接比较，保持两路线最多各两只的观察上限。 */
export function rankLimitUpPkRows(rows: ReturnType<typeof buildLimitUpFeatureRows>, benchmark: LimitUpBenchmark) {
  const byCode = new Map(rows.map((row) => [row.event.code, row]));
  const candidates = scoreLimitUpFeatureRows(rows, benchmark).map((candidate) => {
    const row = byCode.get(candidate.code)!;
    const pk = row.pk ?? limitUpPkProfile({ code: candidate.code, streak: candidate.streak_count,
      seal: candidate.seal_money, maxSeal: row.event.max_seal_money, turnover: candidate.turnover,
      minute: candidate.features.seal_minutes, volumeRatio: null, oneWord: null,
      core: candidate.features.core_position, phase: "close" });
    return { ...candidate, pk, pk_minute: candidate.features.seal_minutes, pk_turnover: candidate.turnover,
      pk_core: candidate.features.core_position, cluster_rank: 0, momentum_rank: 0,
      cluster_signal: false, momentum_signal: false, signal_grade: null as LimitUpSignalCandidate["signal_grade"],
      risk_flags: [...pk.flags, ...(candidate.missing_inputs.length ? [`背景趋势字段缺失：${candidate.missing_inputs.join("、")}`] : [])],
    };
  });
  const stageOrder = { confirmation: 0, first_board: 1, high_board: 2 };
  const ordered = [...candidates].sort((a, b) => stageOrder[a.pk.stage] - stageOrder[b.pk.stage]
    || compareLimitUpPk(a, b) || a.code.localeCompare(b.code));
  const clusterPool = ordered.filter((item) => item.pk.status === "review" && item.streak_count >= 2 && item.pk_core === 1);
  const momentumPool = ordered.filter((item) => item.pk.status === "review" && item.streak_count <= 3);
  const balanceStages = (pool: typeof candidates, stages: Array<LimitUpPkProfile["stage"]>) => {
    const firsts = stages.map((stage) => pool.find((item) => item.pk.stage === stage)).filter((item) => item !== undefined);
    return [...new Set([...firsts, ...pool])];
  };
  // 抱团兼顾确认核心与高位续板；主升保留启动与确认各一席，避免两路线退化为同一份二板榜。
  const cluster = balanceStages(clusterPool, ["confirmation", "high_board"]);
  const momentum = balanceStages([...momentumPool].sort((a, b) => Number(a.pk.one_word) - Number(b.pk.one_word)
    || compareLimitUpPk(a, b) || a.code.localeCompare(b.code)), ["first_board", "confirmation"]);
  cluster.forEach((item, i) => { item.cluster_rank = i + 1; item.cluster_signal = i < 2; });
  momentum.forEach((item, i) => { item.momentum_rank = i + 1; item.momentum_signal = i < 2; });
  candidates.forEach((item) => {
    item.signal_grade = item.cluster_signal && item.momentum_signal ? "A"
      : item.cluster_signal ? "B-抱团" : item.momentum_signal ? "B-主升" : null;
  });
  // 两路线先展示各自首位，避免把第二名的双风格标签误当成全场第一。
  const selected = [...new Set([cluster[0], momentum[0], cluster[1], momentum[1]].filter((item) => item !== undefined))];
  const signals = selected.slice(0, 4);
  const groups = sameHeightPkGroups(candidates);
  const uniqueLeader = (list: typeof candidates) => {
    const first = list[0];
    return first && !list.slice(1).some((item) => item.pk.stage === first.pk.stage && compareLimitUpPk(first, item) === 0)
      ? first.code : null;
  };
  return { candidates: ordered, signals, same_height_pk: groups,
    route_leaders: { cluster: uniqueLeader(cluster), momentum: uniqueLeader(momentum) } };
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function limitUpBenchmarkSha(value: Omit<LimitUpBenchmark, "sha256">): string {
  const { document_id: _documentId, ...portableValue } = value;
  const canonical = (input: unknown): unknown => Array.isArray(input)
    ? input.map(canonical)
    : input && typeof input === "object"
      ? Object.fromEntries(Object.keys(input as Record<string, unknown>).sort()
          .map((key) => [key, canonical((input as Record<string, unknown>)[key])]))
      : input;
  return crypto.createHash("sha256").update(JSON.stringify(canonical(portableValue))).digest("hex");
}

export async function queryLimitUpSignals(db: Db, date: string, pinnedRevisionId?: string | null): Promise<LimitUpSignalResult> {
  const revision = pinnedRevisionId === undefined ? await db.query<{ id: string }>(
    `SELECT document.id::text AS id
       FROM strategy_document document
      WHERE document.code = 'limit_up_board'`,
  ) : null;
  const documentId = pinnedRevisionId === undefined ? revision?.rows[0]?.id ?? null : pinnedRevisionId;
  // 策略未发布（找不到打板策略文档）时不存在可评分的事实。
  if (!documentId) {
    return {
      date,
      strategy_document_id: null,
      benchmark: null,
      status: "unavailable",
      gaps: ["当前打板策略未发布"],
      candidate_count: 0,
      skipped_count: 0,
      skipped: [],
      signal_count: 0,
      intraday_review_count: 0,
      intraday_reviews: [],
      signals: [],
      candidates: [],
    };
  }
  // 评分基准直接绑定策略文档；正文修订沿用同一份基准，不再按修订逐份挂载。
  const benchmarkRow = await db.query<{
    benchmark_code: string;
    document_id: string;
    training_start: string;
    training_end: string;
    methodology: string;
    distributions: Record<LimitUpRankedFeature, number[]>;
    sample_counts: Record<string, number>;
    source_summary: Record<string, unknown>;
    sha256: string;
  }>(
    `SELECT benchmark.benchmark_code, benchmark.document_id::text,
            benchmark.training_start::text, benchmark.training_end::text,
            benchmark.methodology, benchmark.distributions, benchmark.sample_counts,
            benchmark.source_summary, benchmark.sha256
       FROM strategy_score_benchmark benchmark
       JOIN strategy_document document ON document.id = benchmark.document_id
      WHERE document.code = 'limit_up_board'
      ORDER BY benchmark.id DESC
      LIMIT 1`,
  );
  const stored = benchmarkRow.rows[0];
  if (!stored) {
    return {
      date,
      strategy_document_id: documentId,
      benchmark: null,
      status: "unavailable",
      gaps: ["当前打板策略没有可用的评分基准"],
      candidate_count: 0,
      skipped_count: 0,
      skipped: [],
      signal_count: 0,
      intraday_review_count: 0,
      intraday_reviews: [],
      signals: [],
      candidates: [],
    };
  }
  const benchmark: LimitUpBenchmark = {
    code: stored.benchmark_code,
    document_id: stored.document_id,
    training_start: stored.training_start,
    training_end: stored.training_end,
    methodology: stored.methodology,
    distributions: Object.fromEntries(LIMIT_UP_RANKED_FEATURES.map((feature) => [
      feature,
      [...(stored.distributions[feature] ?? [])].sort((left, right) => left - right),
    ])) as Record<LimitUpRankedFeature, number[]>,
    sample_counts: stored.sample_counts,
    source_summary: stored.source_summary,
    sha256: stored.sha256,
  };
  const start = shiftDate(date, -65);
  const events = await db.query<LimitUpEventInput>(
    `SELECT event.trade_date::text AS date, event.event_type, instrument.code, instrument.name,
            event.streak_count, event.open_count, event.first_event_time::text, event.reason,
            event.is_st, event.is_new, event.seal_money, event.max_seal_money,
            COALESCE(event.turnover, bar.turnover)::float8 AS turnover
       FROM market_limit_event event
       JOIN market_instrument instrument ON instrument.id = event.instrument_id
       LEFT JOIN market_bar bar ON bar.instrument_id = event.instrument_id
        AND bar.freq = 'day' AND bar.bar_date = event.trade_date
      WHERE event.trade_date BETWEEN $1 AND $2
      ORDER BY event.trade_date, event.event_type, instrument.code`,
    [start, date],
  );
  const bars = await db.query<LimitUpBarInput>(
    `SELECT bar.bar_date::text AS date, instrument.code, bar.open::float8, bar.close::float8,
            bar.high::float8,bar.low::float8,bar.volume::float8,bar.turnover::float8 AS turnover
       FROM market_bar bar JOIN market_instrument instrument ON instrument.id = bar.instrument_id
      WHERE bar.freq = 'day' AND bar.bar_date BETWEEN $1 AND $2
        AND bar.instrument_id IN (
          SELECT DISTINCT instrument_id FROM market_limit_event
           WHERE event_type = 'up' AND trade_date BETWEEN $1 AND $2
        )
      ORDER BY instrument.code, bar.bar_date`,
    [start, date],
  );
  const calendar = await db.query<{ date: string }>(
    `SELECT trade_date::text AS date FROM market_trading_day
      WHERE is_open AND trade_date BETWEEN $1 AND $2 ORDER BY trade_date`,
    [start, date],
  );
  const tradingDates = calendar.rows.length
    ? calendar.rows.map((row) => row.date)
    : [...new Set(bars.rows.map((bar) => bar.date))].sort();
  const featureRows = buildLimitUpFeatureRows({ events: events.rows, bars: bars.rows, tradingDates, targetDates: [date] });
  const criticalMissing = (row: typeof featureRows[number]) => row.missingInputs.some((key) => ["seal_money", "turnover", "first_event_time"].includes(key));
  const skipped = featureRows.filter(criticalMissing)
    .map((row) => ({ code: row.event.code, missing_inputs: [...new Set(row.missingInputs)] }));
  // 异常标的不能用 0.5 中性排名混进正式信号；只对可完整评估的标的排序。
  const ranked = rankLimitUpPkRows(featureRows.filter((row) => !criticalMissing(row)), benchmark);
  const candidates = ranked.candidates;
  const gaps = featureRows.length > 0 && !candidates.length ? ["本轮候选均缺少必要评分数据"] : [];
  const signals = ranked.signals;
  const intradayRows = await db.query<{ code: string; name: string; evidence: Record<string, unknown> }>(
    `SELECT instrument.code,instrument.name,signal.evidence
       FROM strategy_entry_signal signal
       JOIN market_instrument instrument ON instrument.id=signal.instrument_id
      WHERE signal.run_id=(
        SELECT id FROM strategy_evaluation_run
         WHERE strategy_code='first_board_advance' AND phase='entry' AND target_date=$1::date
           AND status IN ('success','partial')
         ORDER BY created_at DESC,id DESC LIMIT 1
      ) AND signal.signal_status='qualified'
      ORDER BY signal.id`,
    [date],
  );
  const closeByCode = new Map(candidates.map((candidate) => [candidate.code, candidate]));
  const sealedCodes = new Set(events.rows.filter((event) => event.date === date && event.event_type === "up")
    .map((event) => event.code));
  const intradayReviews = intradayRows.rows.map((row) => {
    const close = closeByCode.get(row.code);
    return {
      code: row.code, name: row.name,
      intraday_streak_count: typeof row.evidence.streak_count === "number" ? row.evidence.streak_count : null,
      intraday_route: typeof row.evidence.route === "string" ? row.evidence.route : null,
      close_status: !sealedCodes.has(row.code) ? "not_sealed" as const
        : close?.signal_grade ? "confirmed_signal" as const : "sealed_not_selected" as const,
      close_signal_grade: close?.signal_grade ?? null,
    };
  });
  const { distributions: _distributions, ...publicBenchmark } = benchmark;
  const { sha256: _sha256, ...benchmarkPayload } = benchmark;
  if (limitUpBenchmarkSha(benchmarkPayload) !== benchmark.sha256) gaps.push("评分基准哈希校验失败");
  const asOf = new Date(Math.min(Date.now(), Date.parse(`${date}T23:59:59+08:00`))).toISOString();
  const pkNews = await limitUpPkNews(db, candidates.map((item) => item.code), asOf);
  const sync = (await db.query<{ dataset: string; status: string }>(
    `SELECT DISTINCT ON(dataset) dataset,status FROM market_special_sync_run
      WHERE target_date=$1::date AND dataset IN ('limit_break','limit_down') ORDER BY dataset,id DESC`, [date])).rows;
  const currentEvents = events.rows.filter((event) => event.date === date);
  const upCount = currentEvents.filter((event) => event.event_type === "up").length;
  const countIfReady = (dataset: string, type: LimitUpEventInput["event_type"]) => sync.some((item) => item.dataset === dataset && item.status === "success")
    ? currentEvents.filter((event) => event.event_type === type).length : null;
  const breakCount = countIfReady("limit_break", "break");
  const downCount = countIfReady("limit_down", "down");
  const heightEvents = currentEvents.filter((event) => event.event_type === "up" && isMainBoard(event.code)
    && event.is_st === false && event.is_new === false && !isStName(event.name));
  const highest = Math.max(0, ...heightEvents.map((event) => event.streak_count ?? 0));
  return {
    date,
    strategy_document_id: documentId,
    benchmark: publicBenchmark,
    status: gaps.length ? "partial" : "success",
    gaps,
    candidate_count: candidates.length,
    skipped_count: skipped.length,
    skipped,
    signal_count: signals.length,
    intraday_review_count: intradayReviews.length,
    intraday_reviews: intradayReviews,
    signals,
    candidates,
    selection_method: "stage_pk_v2", score_usage: "legacy_context_only",
    same_height_pk: ranked.same_height_pk, route_leaders: ranked.route_leaders, pk_news: pkNews,
    pk_market: { limit_up_count: upCount, limit_break_count: breakCount, limit_down_count: downCount,
      break_rate: breakCount === null ? null : breakCount / Math.max(1, upCount + breakCount), highest_streak: highest,
      highest_codes: heightEvents.filter((event) => event.streak_count === highest).map((event) => event.code),
      gaps: [breakCount === null ? "炸板同步未就绪，情绪覆盖待核实" : "", downCount === null ? "跌停同步未就绪，负反馈待核实" : ""].filter(Boolean) },
  };
}
