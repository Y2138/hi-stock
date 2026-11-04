import type pg from "pg";
import { sha256Json } from "../../agent/hash.js";
import { inServiceTransaction, type TransactionDb } from "../../db/transaction.js";
import { shanghaiDate } from "../market-news/repo.js";
import { records, simpleShortlist, type ShortlistCandidate, type SignalRecord } from "./shortlist.js";
import { buildTomorrowPreview } from "../plans/tomorrow-preview.js";

type Db = Pick<pg.Pool, "query">;
export const SELECTION_JOB = "cross_strategy_selection";
export const SELECTION_SOURCES = {
  limit_up_close_scan: "limit_up", swing_signal_scan: "swing", two_year_reversal_scan: "two_year_reversal",
  value_anchor_opportunity_scan: "value_anchor", nightly_sector_opportunity_scan: "nightly_sector",
} as const;
const families: Record<string, string> = {
  limit_up: "涨停接力", swing: "超跌修复", two_year_reversal: "超跌修复", value_anchor: "价值支撑", nightly_sector: "行业观察",
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

async function industries(db: Db, codes: string[], date: string) {
  return new Map((await db.query<{ code: string; industry_code: string; industry: string }>(
    `SELECT DISTINCT ON (i.code) i.code,b.code AS industry_code,b.name AS industry
       FROM market_instrument i JOIN market_board_membership m ON m.member_instrument_id=i.id
       JOIN market_instrument b ON b.id=m.board_instrument_id JOIN market_board catalog ON catalog.instrument_id=b.id
      WHERE i.code=ANY($1::text[]) AND catalog.board_type='industry' AND catalog.active AND b.code LIKE '881%.TI'
        AND m.effective_from<=$2::date AND (m.effective_to IS NULL OR m.effective_to>$2::date)
      ORDER BY i.code,b.code`, [codes, date])).rows.map((row) => [row.code, row]));
}

/** 通用数量切面只保留原生排序；铜和其他策略原样返回。 */
export async function shortlistEntryResult(db: Db, strategy: string, date: string, raw: unknown) {
  if (!["swing", "two_year_reversal", "value_anchor", "limit_up"].includes(strategy)) return raw;
  const value = object(raw);
  const signalsKey = ["swing", "limit_up"].includes(strategy) ? "signals" : "qualified";
  const nearKey = strategy === "swing" ? "near_candidates" : "near";
  const qualified = records(value.all_signals ?? value.all_qualified ?? value[signalsKey]);
  const approaching = records(value.all_near ?? value[nearKey]);
  const boards = await industries(db, [...qualified, ...approaching].map((item) => item.code), date);
  const enrich = (item: SignalRecord): SignalRecord => ({ ...item, ...(boards.get(item.code) ?? {}) });
  const all = [...qualified.map((item) => ({ item: enrich(item), status: "qualified" as const })),
    ...approaching.map((item) => ({ item: enrich(item), status: "approaching" as const }))];
  const selected = simpleShortlist(all.filter((item) => item.status === "qualified").map((item) => item.item),
    all.filter((item) => item.status === "approaching").map((item) => item.item), strategy === "limit_up" ? 4 : 5);
  const result: Record<string, unknown> = { ...value, [signalsKey]: selected.kept.filter((item) => item.status === "qualified").map((item) => item.item),
    [nearKey]: selected.kept.filter((item) => item.status === "approaching").map((item) => item.item),
    shortlist_matches: all.map(({ item, status }) => ({ code: item.code, name: String(item.name ?? item.code),
      industry_code: String(item.industry_code ?? ""), industry: String(item.industry ?? ""), status, evidence: item })),
    capped_out: [...records(value.capped_out), ...selected.deferred.map(({ item, status }) => ({
      code: item.code, signal_status: status, reason: "本策略初筛数量或正式优先限制，原生条件仍有效",
    }))], shortlisted: true, raw_qualified_count: qualified.length, raw_near_count: approaching.length,
    qualified_count: selected.kept.filter((item) => item.status === "qualified").length,
    near_count: selected.kept.filter((item) => item.status === "approaching").length };
  if (strategy === "swing") Object.assign(result, { signal_count: records(result.signals).length,
    near_candidate_count: records(result.near_candidates).length });
  if (strategy === "limit_up") result.signal_count = records(result.signals).length;
  // 完整证据只保存一次，避免工具响应重复展开同一集合。
  delete result.all_signals; delete result.all_qualified; delete result.all_near;
  return result;
}

export async function saveStrategyShortlist(db: Db, runId: string, strategy: string, date: string,
  result: unknown, source: Record<string, unknown>, status: string, gaps: unknown[] = []) {
  const binding = (await db.query<{ strategy_code: string; target_date: string; status: string }>(
    `SELECT d.strategy_code,r.target_date::text,r.status FROM job_run r JOIN job_definition d ON d.id=r.job_id WHERE r.id=$1`, [runId])).rows[0];
  if (!binding || binding.strategy_code !== strategy || binding.target_date !== date || !['queued','running'].includes(binding.status))
    throw new Error("初筛必须绑定本策略当前运行和目标日");
  const value = object(result);
  const dataDate = String(value.data_date ?? value.date ?? date);
  const key = ["swing", "limit_up"].includes(strategy) ? "signals" : "qualified";
  const nearKey = strategy === "swing" ? "near_candidates" : "near";
  const matches = Array.isArray(value.shortlist_matches) ? value.shortlist_matches as ShortlistCandidate[] : [];
  const lookup = new Map(matches.map((item) => [item.code, item]));
  const candidates = [...records(value[key]).map((item) => ({ item, status: "qualified" as const })),
    ...records(value[nearKey]).map((item) => ({ item, status: "approaching" as const }))].map(({ item, status }) => lookup.get(item.code)
      ?? { code: item.code, name: String(item.name ?? item.code), industry_code: String(item.industry_code ?? ""),
        industry: String(item.industry ?? ""), status, evidence: item });
  const payload = { candidates: dataDate === date ? candidates : [], matches: dataDate === date ? matches : [], source, status, data_date: dataDate, gaps };
  await db.query(`INSERT INTO strategy_candidate_shortlist(source_job_run_id,strategy_code,target_date,data_date,status,payload,input_hash)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(source_job_run_id) DO UPDATE SET
    data_date=EXCLUDED.data_date,status=EXCLUDED.status,payload=EXCLUDED.payload,input_hash=EXCLUDED.input_hash,created_at=now()`,
  [runId, strategy, date, dataDate, status === "success" ? "success" : "partial", JSON.stringify(payload), sha256Json(payload)]);
  return { count: payload.candidates.length, input_hash: sha256Json(payload) };
}

/** 只接受当前任务实际分析过的原生夜间行业候选，不相信模型自报名单。 */
export async function saveNightlyShortlist(db: Db, runId: string, sessionId: string, date: string, startedAt: string) {
  const messages = (await db.query<{ content: Record<string, unknown> }>(
    "SELECT content FROM chat_message WHERE session_id=$1 AND role='tool' AND created_at >= $2::timestamptz ORDER BY seq DESC", [sessionId, startedAt])).rows;
  const analysisIds = messages.flatMap(({ content }) => content.toolName === "analysis_run" && !content.isError
    ? (Array.isArray(object(content.details).items) ? object(content.details).items as Record<string, unknown>[] : [])
      .filter((item) => item.analysis_type === "sector_trend_structure").map((item) => String(item.id)) : []);
  if (!analysisIds.length) throw new Error("本次夜间任务尚未完成行业原生分析");
  const analysis = (await db.query<{ id: string; result_json: Record<string, unknown>; status: string; data_gaps: unknown[] }>(
    `SELECT id::text,result_json,status,data_gaps FROM analysis_run WHERE id::text=ANY($1::text[])
       AND request_json->>'as_of'=$2 AND NOT (request_json ? 'codes') AND status IN ('success','partial') ORDER BY id DESC LIMIT 1`, [analysisIds, date])).rows[0];
  if (!analysis || analysis.result_json.as_of !== date) throw new Error("夜间行业分析数据日不完整，不能形成当日初筛");
  const signals = records(analysis.result_json.signals);
  const members: SignalRecord[] = [];
  for (const board of signals) {
    const catchUp = object(board.catch_up);
    for (const item of [...records(catchUp.branch_b), ...records(catchUp.branch_a)]) {
      members.push({ ...item, industry_code: board.code, industry: String(board.sector ?? board.code),
        valid_through: board.valid_through, board_evidence: { code: board.code, trigger: board.trigger, prior_low: board.prior_low, signal_high: board.signal_high, as_of: board.as_of } });
    }
  }
  // ponytail: 板块原生顺序与分支B优先，跨板块不发明未经验证的技术分。
  const selected = simpleShortlist<SignalRecord>([], members);
  const candidates = selected.kept.map(({ item }) => ({ code: item.code, name: String(item.name ?? item.code),
    industry_code: String(item.industry_code), industry: String(item.industry), status: "approaching" as const, evidence: item }));
  const unique = new Map(members.map((item) => [item.code, { code: item.code, name: String(item.name ?? item.code),
    industry_code: String(item.industry_code), industry: String(item.industry), status: "approaching" as const, evidence: item }]));
  await saveStrategyShortlist(db, runId, "nightly_sector", date, {
    data_date: date, qualified: [], near: candidates.map((item) => item.evidence), shortlist_matches: [...unique.values()],
  }, { analysis_run_id: analysis.id }, analysis.status, analysis.data_gaps);
  return { candidates, deferred_codes: selected.deferred.map(({ item }) => item.code) };
}

interface SourceRow { code: string; enabled: boolean; run_id: string | null; status: string | null;
  input_hash: string | null; payload: { candidates: ShortlistCandidate[]; matches: ShortlistCandidate[]; gaps: unknown[] } | null; }
export interface SelectionCandidate extends ShortlistCandidate {
  strategies: string[]; qualified_strategies: string[]; families: string[]; resonance_bonus: number;
  reference_price?: number | null; minimum_buy_quantity?: number;
  strategy_evidence: Record<string, SignalRecord>;
}
export interface SelectionContext {
  target_date: string; input_hash: string; sources: SourceRow[]; candidates: SelectionCandidate[]; gaps: string[]; pending: string[];
}

export function aggregateCandidates(sources: SourceRow[]): SelectionCandidate[] {
  const map = new Map<string, SelectionCandidate>();
  for (const source of sources) for (const item of source.payload?.candidates ?? []) {
    if (!map.has(item.code)) map.set(item.code, { ...item, strategies: [], qualified_strategies: [], families: [], resonance_bonus: 0, strategy_evidence: {} });
  }
  for (const source of sources) {
    const strategy = SELECTION_SOURCES[source.code as keyof typeof SELECTION_SOURCES];
    if (!strategy || !source.payload) continue;
    for (const item of source.payload.matches) {
      const candidate = map.get(item.code);
      if (!candidate || candidate.strategies.includes(strategy)) continue;
      candidate.strategies.push(strategy);
      candidate.strategy_evidence[strategy] = item.evidence;
      if (item.status === "qualified") {
        candidate.qualified_strategies.push(strategy);
        candidate.status = "qualified";
        if (!candidate.families.includes(families[strategy]!)) candidate.families.push(families[strategy]!);
      }
    }
  }
  return [...map.values()].map((item) => ({ ...item, resonance_bonus: Math.min(15,
    Math.max(0, item.families.length - 1) * 10 + (item.qualified_strategies.length > item.families.length ? 3 : 0)) }));
}

export async function loadSelectionContext(db: Db, date: string): Promise<SelectionContext> {
  const rows = (await db.query<SourceRow>(`SELECT d.code,d.enabled,r.id::text AS run_id,r.status,s.input_hash,s.payload
    FROM job_definition d LEFT JOIN LATERAL (SELECT id,status FROM job_run
      WHERE job_id=d.id AND target_date=$1::date ORDER BY id DESC LIMIT 1) r ON true
    LEFT JOIN strategy_candidate_shortlist s ON s.source_job_run_id=r.id AND s.data_date=$1::date
    WHERE d.code=ANY($2::text[]) ORDER BY d.code`, [date, Object.keys(SELECTION_SOURCES)])).rows;
  const gaps: string[] = []; const pending: string[] = [];
  const valid: SourceRow[] = [];
  for (const code of Object.keys(SELECTION_SOURCES)) {
    const source = rows.find((row) => row.code === code);
    if (!source) { gaps.push(`来源任务未定义：${code}`); continue; }
    if (!source.enabled) continue;
    if (["queued", "running"].includes(source.status ?? "")) pending.push(code);
    if (!["success", "partial"].includes(source.status ?? "") || !source.payload) {
      gaps.push(`来源未完成或缺少目标日结构化初筛：${code}`); continue;
    }
    if (source.status === "partial" || source.payload.gaps.length) gaps.push(`来源部分完成：${code}`);
    valid.push(source);
  }
  const candidates = aggregateCandidates(valid);
  const prices = (await db.query<{ code: string; price: number | null }>(`SELECT i.code,
    COALESCE(b.close_raw,CASE WHEN b.adjustment='none' THEN b.close END)::float8 AS price
    FROM market_instrument i LEFT JOIN LATERAL (SELECT close_raw,close,adjustment FROM market_bar
      WHERE instrument_id=i.id AND freq='day' AND bar_date=$2::date ORDER BY bar_time DESC LIMIT 1) b ON true
    WHERE i.code=ANY($1::text[]) ORDER BY i.code`, [candidates.map((item) => item.code), date])).rows;
  const byCode = new Map(prices.map((item) => [item.code, item.price]));
  candidates.forEach((item) => { item.reference_price = byCode.get(item.code) ?? null; item.minimum_buy_quantity = item.code.startsWith('688') ? 200 : 100; });
  const inputHash = sha256Json({ sources: rows.map(({ code, enabled, run_id, status, input_hash }) => ({ code, enabled, run_id, status, input_hash })), prices });
  return { target_date: date, input_hash: inputHash, sources: rows, candidates, gaps, pending };
}

export async function prepareSelectionContext(db: Db, runId: string, date: string, priceGaps: string[] = []) {
  const context = await loadSelectionContext(db, date);
  if (context.pending.length) throw new Error(`来源仍在执行：${context.pending.join("、")}`);
  context.gaps.push(...priceGaps);
  // 重试时模型可能再次读取上下文；同一 input_hash 下不能把已提交的研究结果清空。
  await db.query(`INSERT INTO candidate_selection_result(job_run_id,target_date,source_context,status)
    VALUES($1,$2,$3::jsonb,'draft') ON CONFLICT(job_run_id) DO UPDATE SET
      source_context=EXCLUDED.source_context,
      result=CASE
        WHEN candidate_selection_result.result IS NOT NULL
         AND candidate_selection_result.source_context->>'input_hash' = EXCLUDED.source_context->>'input_hash'
        THEN candidate_selection_result.result ELSE NULL END,
      status=CASE
        WHEN candidate_selection_result.result IS NOT NULL
         AND candidate_selection_result.source_context->>'input_hash' = EXCLUDED.source_context->>'input_hash'
        THEN candidate_selection_result.status ELSE 'draft' END,
      updated_at=now()`, [runId, date, JSON.stringify(context)]);
  // 完整命中登记在数据库快照内；工具只展开待研究股票的各策略证据。
  return { ...context, sources: context.sources.map((source) => ({ ...source, payload: null })) };
}

export interface SelectionReview {
  code: string; decision: "priority" | "observe" | "exclude" | "pending";
  strength: "strong" | "adequate" | "weak"; rank: number;
  reason: string; risk: string; condition: string;
  dimensions: { fundamental: string; news: string; industry_position: string; character: string; execution: string; price_fit: string };
  sources: Array<{ kind: "local" | "web"; reference: string; fact: string }>;
}
export interface SelectionWrite { target_date: string; input_hash: string; reviews: SelectionReview[]; gaps: string[]; }
export interface SelectionResult { target_date: string; recommendations: Array<SelectionCandidate & { review: SelectionReview }>;
  reviews: SelectionReview[]; gaps: string[]; status: "success" | "partial"; summary: string; }

export function selectRecommendations(context: SelectionContext, reviews: SelectionReview[]) {
  const byCode = new Map(reviews.map((review) => [review.code, review]));
  const eligible = context.candidates.filter((item) => item.industry_code && byCode.has(item.code))
    .map((item) => ({ ...item, review: byCode.get(item.code)! }))
    .filter((item) => ["priority", "observe"].includes(item.review.decision) && item.review.strength !== "weak")
    .sort((a, b) => (a.review.strength === "strong" ? 0 : 1) - (b.review.strength === "strong" ? 0 : 1)
      || b.resonance_bonus - a.resonance_bonus || a.review.rank - b.review.rank || a.code.localeCompare(b.code));
  const kept: typeof eligible = []; const industries = new Map<string, number>();
  const take = (item: typeof eligible[number]) => {
    if (kept.length < 3 && (industries.get(item.industry_code) ?? 0) < 2) {
      kept.push(item); industries.set(item.industry_code, (industries.get(item.industry_code) ?? 0) + 1);
    }
  };
  eligible.filter((item) => item.status === "qualified" && item.review.decision === "priority").forEach(take);
  if (kept.length < 3) eligible.filter((item) => item.status === "approaching" && item.review.decision === "observe").forEach(take);
  return kept;
}

const text = (value: string, max = 65) => {
  const plain = value.replace(/[\r\n]+/g, " ");
  if ([...plain].length > max) throw new Error(`摘要字段超过${max}字符，请缩短，不截断风险条件`);
  return plain;
};
export function renderSelectionSummary(result: Pick<SelectionResult, "recommendations" | "gaps"> & Partial<Pick<SelectionResult, "reviews">>) {
  const lines = result.recommendations.length ? result.recommendations.map((item, index) =>
    `${index + 1}. ${item.name}（${item.code}）｜${item.industry}｜${item.status === "qualified" ? "条件成立" : "等待条件"}\n`
    + `理由：${text(item.review.reason)}；${item.qualified_strategies.length > 1 ? `${item.qualified_strategies.length}策略共振。` : ""}`
    + `风险：${text(item.review.risk, 45)}；核对：${text(item.review.condition, 40)}`) : [
      result.reviews?.some((item) => item.decision === "pending")
        ? "逐股研究已保留，关键事实尚待核验，暂不形成推荐，不凑数。"
        : "暂无完成核验且值得优先推荐的标的，不凑数。",
    ];
  lines.push("约10万元参考适配；参与方式与风险线仍按各原策略，不是买入指令。");
  if (result.gaps.length) lines.push(`部分覆盖：${result.gaps.length}项缺口，详见任务结果。`);
  return lines.join("\n\n");
}

export async function writeSelectionResult(db: TransactionDb, runId: string, input: SelectionWrite): Promise<SelectionResult> {
  return inServiceTransaction(db, async (client) => {
    const row = (await client.query<{ source_context: SelectionContext; session_id: string; started_at: string }>(
      `SELECT s.source_context,r.session_id::text,r.started_at::text FROM candidate_selection_result s
       JOIN job_run r ON r.id=s.job_run_id JOIN job_definition d ON d.id=r.job_id
       WHERE r.id=$1 AND d.code=$2 AND r.status='running' AND r.target_date=$3::date FOR UPDATE OF s`,
      [runId, SELECTION_JOB, input.target_date])).rows[0];
    if (!row || input.target_date !== shanghaiDate()) throw new Error("仅允许当前精选任务写入今日推荐，不能用实时资料回填历史");
    const current = await loadSelectionContext(client, input.target_date);
    if (row.source_context.input_hash !== input.input_hash || current.input_hash !== input.input_hash || current.pending.length)
      throw new Error("来源初筛已变化，请重新读取精选上下文");
    const context = row.source_context;
    const allowed = new Map(context.candidates.map((item) => [item.code, item]));
    if (new Set(input.reviews.map((item) => item.code)).size !== input.reviews.length) throw new Error("逐股研究代码不能重复");
    const messages = (await client.query<{ content: Record<string, unknown> }>(
      "SELECT content FROM chat_message WHERE session_id=$1 AND role='tool' AND created_at>=$2::timestamptz", [row.session_id, row.started_at])).rows;
    const urls = new Set<string>(); const local = new Map<string, Record<string, unknown>>();
    const searchFailed = messages.some(({ content }) => content.toolName === "web_search" && content.isError);
    for (const { content } of messages) {
      if (content.isError) continue;
      const d = object(content.details);
      if (content.toolName === "web_search") for (const source of Array.isArray(d.sources) ? d.sources as Record<string, unknown>[] : []) {
        if (typeof source.url === "string") urls.add(source.url);
      }
      if (content.toolName === "web_fetch" && typeof d.url === "string") urls.add(d.url);
      if (content.toolName === "stock_research_query") for (const item of Array.isArray(d.items) ? d.items as Record<string, unknown>[] : []) {
        if (typeof item.code === "string") local.set(item.code, item);
      }
    }
    const researchGaps: string[] = [];
    const reviews = input.reviews.map((review): SelectionReview => {
      if (searchFailed && ["priority", "observe"].includes(review.decision)
        && !review.sources.some((source) => source.kind === "web" && urls.has(source.reference))) {
        researchGaps.push(`公开消息核验失败，保留逐股研究并标记待核验：${review.code}`);
        return { ...review, decision: "pending" };
      }
      return review;
    });
    for (const review of reviews) {
      const candidate = allowed.get(review.code);
      if (!candidate) throw new Error(`标的不在本次初筛集合：${review.code}`);
      if (review.decision === "priority" && candidate.status !== "qualified") throw new Error("接近候选不能升级为正式推荐");
      for (const source of review.sources) {
        if (source.kind === "web") {
          const url = new URL(source.reference);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
            throw new Error("研究来源URL包含非法协议或凭据");
        }
        if (source.kind === "web" && !urls.has(source.reference)) throw new Error("网页来源未在本次任务中获取");
        if (source.kind === "local" && (source.reference !== review.code || !local.has(review.code))) throw new Error("本地来源必须引用本次读取过的同标的研究");
      }
      if (["priority", "observe"].includes(review.decision)
        && (!review.sources.some((source) => source.kind === "web") || !local.has(review.code)))
        throw new Error("推荐必须完成本地研究及当次公开消息核验");
      if (["priority", "observe"].includes(review.decision)) {
        const facts = local.get(review.code)!;
        const financial = object(facts.fundamental);
        const quote = object(facts.quote);
        if (facts.profile_status !== "ready" || quote.bar_date !== input.target_date || !financial.report_period
          || String(financial.report_period) > input.target_date || !financial.as_of_date
          || String(financial.as_of_date) > input.target_date
          || Date.parse(input.target_date) - Date.parse(String(financial.as_of_date)) > 540 * 86_400_000
          || !candidate.reference_price || candidate.reference_price <= 0)
          throw new Error(`${review.code} 股性、财务或未复权价格未完成可信核验，请标记待核验`);
      }
    }
    const reviewed = new Set(reviews.map((item) => item.code));
    const missing = context.candidates.filter((item) => item.status === "qualified" && !reviewed.has(item.code));
    if (missing.length) throw new Error(`正式候选必须逐股提交研究：${missing.map((item) => item.code).join("、")}。核验失败请保留研究并标记 pending，不得清空 reviews`);
    const gaps = [...new Set([...context.gaps, ...input.gaps,
      ...researchGaps, ...reviews.filter((item) => item.decision === "pending").map((item) => `研究待核验：${item.code}`)])];
    const recommendations = selectRecommendations(context, reviews);
    const result: SelectionResult = { target_date: input.target_date, recommendations, reviews, gaps,
      status: gaps.length ? "partial" : "success", summary: "" };
    result.summary = renderSelectionSummary(result);
    if ([...result.summary].length > 500) throw new Error("推荐摘要超过500字符，请缩短逐股理由和风险");
    await client.query("UPDATE candidate_selection_result SET result=$2::jsonb,updated_at=now() WHERE job_run_id=$1", [runId, JSON.stringify(result)]);
    return result;
  });
}

export async function selectionReport(db: Db, runId: string) {
  const row = (await db.query<{ result: SelectionResult | null }>("SELECT result FROM candidate_selection_result WHERE job_run_id=$1", [runId])).rows[0];
  if (!row?.result) throw new Error("统一精选尚未完成结构化研究提交");
  const result = row.result;
  const labels: Record<string, string> = { fundamental: "基本面", news: "消息面", industry_position: "行业地位",
    character: "股性", execution: "量价与可执行性", price_fit: "价格参考适配",
    priority: "优先", observe: "观察", exclude: "排除", pending: "待核验" };
  const details = result.reviews.map((item) => `### ${item.code}｜${labels[item.decision]}\n${item.reason}\n\n`
    + Object.entries(item.dimensions).map(([key, value]) => `- ${labels[key]}：${value}`).join("\n")
    + `\n\n风险：${item.risk}\n\n条件：${item.condition}\n\n来源：\n`
    + item.sources.map((source) => `- ${source.reference}：${source.fact}`).join("\n")).join("\n\n");
  const preview = await buildTomorrowPreview(db, result.target_date);
  return { ...result, markdown: `# 盘后统一标的精选\n\n目标日：${result.target_date}\n\n${details}\n\n`
    + (result.gaps.length ? `## 数据缺口\n${result.gaps.map((gap) => `- ${gap}`).join("\n")}\n\n` : "")
    + `## 结论摘要\n${result.summary}\n\n${preview}` };
}
