import crypto from "node:crypto";
import type pg from "pg";

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
  revision_id: string;
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
}

export interface LimitUpSignalResult {
  date: string;
  strategy_revision_id: string | null;
  benchmark: Omit<LimitUpBenchmark, "distributions"> | null;
  status: "success" | "partial" | "unavailable";
  gaps: string[];
  candidate_count: number;
  signal_count: number;
  signals: LimitUpSignalCandidate[];
  candidates: LimitUpSignalCandidate[];
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
    if (value.length < 2 || COMPANY_EVENT_WORDS.some((word) => value.includes(word))) continue;
    for (const [pattern, alias] of THEME_ALIASES) {
      if (pattern.test(value)) {
        value = alias;
        break;
      }
    }
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
): string | null {
  return [...tags].sort((left, right) => {
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
}> {
  const contexts = buildDayContexts(input.events);
  const maps = barMaps(input.bars);
  const sets = eventSets(input.events);
  const rows: Array<{ event: LimitUpEventInput; mainTheme: string; features: LimitUpRawFeatures; missingInputs: string[] }> = [];

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
      const mainTheme = selectMainTheme(tags, context, mainThemeContexts);
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
          weightedRatio(previousMembers.map((member) => {
            const currentBar = maps.byKey.get(`${member.event.code}:${date}`);
            const priorBar = maps.byKey.get(`${member.event.code}:${priorDate}`);
            return { weight: member.weight, hit: Boolean(currentBar && priorBar && currentBar.open < priorBar.close) };
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
      if (turnovers.length < theme.members.length) missingInputs.push("theme_turnover_log");
      if (themePreReturns.length < theme.members.length) missingInputs.push("theme_pre5_return");
      if (ma20Values.length < theme.members.length) missingInputs.push("above_ma20");
      if (stockReturn === null) missingInputs.push("stock_pre5_return");
      if (persistence === null) missingInputs.push("persistence_5d");
      if (priorDate && !previousContext) missingInputs.push("promotion_rate", "negative_feedback");
      if (event.seal_money === null) missingInputs.push("seal_money");
      if (event.turnover === null || event.turnover <= 0) missingInputs.push("turnover");
      if (sealMinutes === null) missingInputs.push("first_event_time");
      rows.push({ event, mainTheme, features, missingInputs });
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

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function limitUpBenchmarkSha(value: Omit<LimitUpBenchmark, "sha256">): string {
  const { revision_id: _revisionId, ...portableValue } = value;
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
    `SELECT revision.id::text AS id
       FROM strategy_document document
       JOIN strategy_document_revision revision ON revision.id = document.current_revision_id
      WHERE document.code = 'limit_up_board'`,
  ) : null;
  const revisionId = pinnedRevisionId === undefined ? revision?.rows[0]?.id ?? null : pinnedRevisionId;
  const benchmarkRow = revisionId ? await db.query<{
    benchmark_code: string;
    document_revision_id: string;
    training_start: string;
    training_end: string;
    methodology: string;
    distributions: Record<LimitUpRankedFeature, number[]>;
    sample_counts: Record<string, number>;
    source_summary: Record<string, unknown>;
    sha256: string;
  }>(
    `SELECT benchmark_code, document_revision_id::text, training_start::text, training_end::text,
            methodology, distributions, sample_counts, source_summary, sha256
       FROM strategy_score_benchmark WHERE document_revision_id = $1`,
    [revisionId],
  ) : null;
  const stored = benchmarkRow?.rows[0];
  if (!revisionId || !stored) {
    return {
      date,
      strategy_revision_id: revisionId,
      benchmark: null,
      status: "unavailable",
      gaps: [revisionId ? "当前打板策略修订没有固定研究基准" : "当前打板策略未发布"],
      candidate_count: 0,
      signal_count: 0,
      signals: [],
      candidates: [],
    };
  }
  const benchmark: LimitUpBenchmark = {
    code: stored.benchmark_code,
    revision_id: stored.document_revision_id,
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
            bar.turnover::float8 AS turnover
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
  const candidates = scoreLimitUpFeatureRows(featureRows, benchmark);
  const gaps = [...new Set(candidates.flatMap((candidate) => candidate.missing_inputs))];
  const signals = candidates.filter((candidate) => candidate.signal_grade !== null).slice(0, 4);
  const { distributions: _distributions, ...publicBenchmark } = benchmark;
  const { sha256: _sha256, ...benchmarkPayload } = benchmark;
  if (limitUpBenchmarkSha(benchmarkPayload) !== benchmark.sha256) gaps.push("固定研究基准哈希校验失败");
  return {
    date,
    strategy_revision_id: revisionId,
    benchmark: publicBenchmark,
    status: gaps.length ? "partial" : "success",
    gaps,
    candidate_count: candidates.length,
    signal_count: signals.length,
    signals,
    candidates,
  };
}
