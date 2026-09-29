import type pg from "pg";
import type { Context } from "@earendil-works/pi-ai";
import { fetchSnapshot, type SnapshotQuote } from "../../datasource/hithink.js";
import { getLlmConfigByModelKey } from "../../agent/ai/repo.js";
import { resolveActiveChatModel } from "../../agent/ai/runtime.js";
import { sha256Json } from "../../agent/hash.js";
import { getLatestDailyPlanBoard } from "../plans/repo.js";
import { listPositions } from "../positions/repo.js";
import { enqueueIntradayRiskAlert } from "../notifications/service.js";

const MODEL_KEY = "glm-5.3-flashX";
const SAMPLE_INTERVAL_MS = 30_000;
const CORE_INDEX_CODES = [
  "000001.SH", "000016.SH", "000300.SH", "000688.SH",
  "000852.SH", "000905.SH", "399001.SZ", "399006.SZ",
] as const;

type Db = Pick<pg.Pool, "query">;
type Risk = "normal" | "watch" | "high";

export interface IntradayRiskRow {
  code: string;
  name: string;
  risk: Risk;
  key_level: string | null;
  reason: string;
  sample_at: string | null;
  data_time: string | null;
  model_key: string;
  updated_at: string;
}

export interface IntradayRiskSnapshot {
  trade_date: string;
  running: boolean;
  sample_at: string | null;
  data_status: "ready" | "partial" | "stale" | "unavailable";
  positions: IntradayRiskRow[];
}

interface BoardRef { code: string; name: string; }
interface DailyBar { date: string; open: number; high: number; low: number; close: number; volume: number | null; turnover: number | null; }
interface QuoteContext {
  code: string;
  name: string;
  role: "position" | "industry" | "index";
  summary: { first: number | null; latest: number | null; high: number | null; low: number | null; samples: number };
  recent: Array<{ at: string; source_at: string | null; price: number | null; volume: number | null; turnover: number | null; status: string }>;
}

function shanghaiParts(date = new Date()): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

function isTradingSession(date = new Date()): boolean {
  const { minutes } = shanghaiParts(date);
  return (minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 900);
}

function shanghaiTarget(date: Date, dayOffset: number, hour: number, minute: number): number {
  const local = new Date(date.getTime() + 8 * 3600_000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset, hour - 8, minute);
}

/** 非交易时段睡到下一窗口；休市日只在早盘窗口检查一次后睡到次日。 */
export function intradayRiskNextDelayMs(date = new Date(), openDay?: boolean): number {
  const { minutes } = shanghaiParts(date);
  let target: number;
  if (openDay === false) target = shanghaiTarget(date, 1, 9, 30);
  else if (minutes < 570) target = shanghaiTarget(date, 0, 9, 30);
  else if (minutes < 690) return SAMPLE_INTERVAL_MS;
  else if (minutes < 780) target = shanghaiTarget(date, 0, 13, 0);
  else if (minutes < 900) return SAMPLE_INTERVAL_MS;
  else target = shanghaiTarget(date, 1, 9, 30);
  return Math.max(1_000, target - date.getTime());
}

function textContent(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"))
    .map((part) => part.text)
    .join("")
    .trim();
}

function parseModelJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("盘中风险模型未返回 JSON");
  return JSON.parse(fenced.slice(start, end + 1));
}

function validRisk(value: unknown): value is Risk {
  return value === "normal" || value === "watch" || value === "high";
}

function normalizeRisk(value: unknown): Risk | null {
  if (validRisk(value)) return value;
  if (value === "正常") return "normal";
  if (value === "关注" || value === "中风险") return "watch";
  if (value === "风险" || value === "高风险") return "high";
  return null;
}

async function isOpenDay(db: Db, tradeDate: string): Promise<boolean> {
  const result = await db.query<{ is_open: boolean }>(
    "SELECT is_open FROM market_trading_day WHERE trade_date = $1",
    [tradeDate],
  );
  return result.rows[0]?.is_open === true;
}

async function boardRefs(db: Db, codes: string[]): Promise<Map<string, BoardRef[]>> {
  if (codes.length === 0) return new Map();
  const result = await db.query<{ member_code: string; board_code: string; board_name: string }>(
    `SELECT member.code AS member_code, board_instrument.code AS board_code, board_instrument.name AS board_name
       FROM market_board_membership membership
       JOIN market_instrument member ON member.id = membership.member_instrument_id
       JOIN market_instrument board_instrument ON board_instrument.id = membership.board_instrument_id
       JOIN market_board board ON board.instrument_id = board_instrument.id
      WHERE member.code = ANY($1::text[]) AND membership.effective_to IS NULL
        AND board.active = true AND board.source = 'hithink' AND board.board_type = 'industry'
      ORDER BY member.code, board_instrument.code`,
    [codes],
  );
  const mapped = new Map<string, BoardRef[]>();
  for (const row of result.rows) mapped.set(row.member_code, [...(mapped.get(row.member_code) ?? []), { code: row.board_code, name: row.board_name }]);
  return mapped;
}

async function dailyBars(db: Db, codes: string[], tradeDate: string): Promise<Map<string, DailyBar[]>> {
  if (codes.length === 0) return new Map();
  const result = await db.query<{ code: string; date: string; open: number; high: number; low: number; close: number; volume: number | null; turnover: number | null }>(
    `WITH ranked AS (
       SELECT instrument.code, bar.bar_date::text AS date, bar.open::float8, bar.high::float8,
              bar.low::float8, bar.close::float8, bar.volume::float8, bar.turnover::float8,
              row_number() OVER (PARTITION BY bar.instrument_id ORDER BY bar.bar_date DESC) AS rn
         FROM market_bar bar JOIN market_instrument instrument ON instrument.id = bar.instrument_id
        WHERE instrument.code = ANY($1::text[]) AND bar.freq = 'day' AND bar.bar_date <= $2::date
     ) SELECT code, date, open, high, low, close, volume, turnover FROM ranked WHERE rn <= 20 ORDER BY code, date DESC`,
    [codes, tradeDate],
  );
  const mapped = new Map<string, DailyBar[]>();
  for (const row of result.rows) mapped.set(row.code, [...(mapped.get(row.code) ?? []), row]);
  return mapped;
}

async function strategyContext(db: Db, codes: string[]): Promise<unknown[]> {
  if (codes.length === 0) return [];
  const result = await db.query<{ code: string; name: string; document_code: string; title: string; content: string }>(
    `SELECT definition.code, definition.name, definition.strategy_document_code AS document_code,
            document.title, document.content
       FROM strategy_definition definition
       JOIN strategy_document document ON document.code = definition.strategy_document_code
      WHERE definition.code = ANY($1::text[])
      ORDER BY definition.code`,
    [codes],
  );
  return result.rows.map((row) => ({
    code: row.code,
    name: row.name,
    document_code: row.document_code,
    title: row.title,
    content: row.content.length > 6000 ? `${row.content.slice(0, 6000)}\n[正文已截断]` : row.content,
  }));
}

async function sampleContext(db: Db, tradeDate: string, codes: string[], refs: Map<string, { name: string; role: QuoteContext["role"] }>): Promise<Map<string, QuoteContext>> {
  if (codes.length === 0) return new Map();
  const [result, totals] = await Promise.all([
    db.query<{ code: string; sample_at: string; source_at: string | null; last_price: number | null; volume: number | null; turnover: number | null; data_status: string }>(
    `WITH ranked AS (
       SELECT code, sample_at::text, source_at::text, last_price::float8, volume::float8, turnover::float8,
              data_status, row_number() OVER (PARTITION BY code ORDER BY sample_at DESC) AS rn
         FROM intraday_market_sample
        WHERE trade_date = $1 AND code = ANY($2::text[])
     ) SELECT code, sample_at, source_at, last_price, volume, turnover, data_status
         FROM ranked WHERE rn <= 20 ORDER BY code, sample_at`,
    [tradeDate, codes],
    ),
    db.query<{ code: string; first_price: number | null; latest_price: number | null; high_price: number | null; low_price: number | null; samples: string }>(
      `SELECT code,
              (array_agg(last_price ORDER BY sample_at ASC))[1]::float8 AS first_price,
              (array_agg(last_price ORDER BY sample_at DESC))[1]::float8 AS latest_price,
              max(last_price)::float8 AS high_price, min(last_price)::float8 AS low_price,
              count(*)::text AS samples
         FROM intraday_market_sample
        WHERE trade_date = $1 AND code = ANY($2::text[])
        GROUP BY code`,
      [tradeDate, codes],
    ),
  ]);
  const grouped = new Map<string, typeof result.rows>();
  for (const row of result.rows) grouped.set(row.code, [...(grouped.get(row.code) ?? []), row]);
  const totalsByCode = new Map(totals.rows.map((row) => [row.code, row]));
  return new Map(codes.map((code) => {
    const rows = grouped.get(code) ?? [];
    const total = totalsByCode.get(code);
    return [code, {
      code,
      name: refs.get(code)?.name ?? code,
      role: refs.get(code)?.role ?? "index",
      summary: {
        first: total?.first_price ?? null,
        latest: total?.latest_price ?? null,
        high: total?.high_price ?? null,
        low: total?.low_price ?? null,
        samples: Number(total?.samples ?? 0),
      },
      recent: rows.map((row) => ({ at: row.sample_at, source_at: row.source_at, price: row.last_price, volume: row.volume, turnover: row.turnover, status: row.data_status })),
    } satisfies QuoteContext] as const;
  }));
}

async function writeSamples(
  db: Db,
  tradeDate: string,
  sampleAt: Date,
  expected: Array<{ code: string; name: string; role: QuoteContext["role"] }>,
  quotes: Map<string, SnapshotQuote>,
): Promise<void> {
  for (const item of expected) {
    const quote = quotes.get(item.code);
    await db.query(
      `INSERT INTO intraday_market_sample
        (trade_date, sample_at, source_at, code, name, role, open_price, high_price, low_price,
         last_price, prev_close, volume, turnover, data_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (trade_date, sample_at, code, role) DO UPDATE SET
         source_at=EXCLUDED.source_at, open_price=EXCLUDED.open_price, high_price=EXCLUDED.high_price,
         low_price=EXCLUDED.low_price, last_price=EXCLUDED.last_price, prev_close=EXCLUDED.prev_close,
         volume=EXCLUDED.volume, turnover=EXCLUDED.turnover, data_status=EXCLUDED.data_status`,
      [tradeDate, sampleAt, quote ? new Date(quote.timestampMs) : null, item.code, item.name, item.role,
        quote?.open ?? null, quote?.high ?? null, quote?.low ?? null, quote?.close ?? null,
        quote?.prevClose ?? null, quote?.volume ?? null, quote?.turnover ?? null, quote ? "ready" : "missing"],
    );
  }
}

function compactPlan(item: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!item) return null;
  return {
    action: item.effective_action ?? item.action ?? null,
    headline: typeof item.headline === "string" ? item.headline.slice(0, 600) : null,
    key_levels: Array.isArray(item.key_levels) ? item.key_levels : [],
    intraday: typeof item.intraday_md === "string" ? item.intraday_md.slice(0, 600) : null,
    risk: typeof item.risk_md === "string" ? item.risk_md.slice(0, 600) : null,
    invalidation: typeof item.invalidation_md === "string" ? item.invalidation_md.slice(0, 600) : null,
  };
}

function buildPrompt(payload: Record<string, unknown>): Context {
  return {
    systemPrompt: [
      "你是盘中持仓风险观察器。只分析当前真实持仓，不执行交易，不修改计划。",
      "根据持仓事实、当前计划、日线背景、本交易日采样的个股/行业/大盘数据自行判断是否有风险，不预设固定风险模式。",
      "事实以输入为准；数据缺失或时间过期时不得猜测。没有明确风险时返回 normal。只返回 JSON，不要 Markdown、解释过程或买卖指令。",
      "核对计划目标日与交易日；计划过期时只作为历史背景，不得把其中动作当成当前指令。",
      "每只持仓必须返回一行：code、risk(normal/watch/high)、key_level(没有则null)、reason（不超过60字）。",
    ].join("\n"),
    messages: [{ role: "user", content: JSON.stringify(payload), timestamp: Date.now() }],
  };
}

async function analyse(pool: pg.Pool, payload: Record<string, unknown>, codes: Set<string>): Promise<Array<{ code: string; risk: Risk; key_level: string | null; reason: string }>> {
  const config = await getLlmConfigByModelKey(pool, MODEL_KEY);
  if (!config) throw new Error(`未找到模型 ${MODEL_KEY}，请先在设置中配置`);
  const runtime = await resolveActiveChatModel(pool, config.model.id);
  const response = await runtime.models.completeSimple(runtime.model, buildPrompt(payload), {
    reasoning: "minimal",
    maxTokens: 1200,
    temperature: 0,
    sessionId: undefined,
  });
  const parsed = parseModelJson(textContent(response));
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) throw new Error("盘中风险模型返回缺少 items");
  const normalized = items.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const code = typeof item.code === "string" ? item.code : "";
    const reason = typeof item.reason === "string" ? item.reason.trim().slice(0, 240) : "";
    const risk = normalizeRisk(item.risk);
    if (!codes.has(code) || !risk || !reason) return [];
    return [{ code, risk, key_level: item.key_level == null ? null : String(item.key_level).slice(0, 80), reason }];
  });
  const missing = [...codes].filter((code) => !normalized.some((item) => item.code === code));
  if (missing.length > 0) throw new Error(`盘中风险模型未覆盖持仓：${missing.join(",")}`);
  if (new Set(normalized.map((item) => item.code)).size !== normalized.length) throw new Error("盘中风险模型重复返回持仓");
  return normalized;
}

async function upsertRisks(
  db: Db,
  tradeDate: string,
  sampleAt: Date,
  modelKey: string,
  inputHash: string,
  items: Array<{ code: string; name: string; risk: Risk; key_level: string | null; reason: string }>,
): Promise<void> {
  for (const item of items) {
    await db.query(
      `INSERT INTO intraday_position_risk
        (trade_date, code, name, risk, key_level, reason, sample_at, data_time, model_key, input_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)
       ON CONFLICT (trade_date, code) DO UPDATE SET
         name=EXCLUDED.name, risk=EXCLUDED.risk, key_level=EXCLUDED.key_level, reason=EXCLUDED.reason,
         sample_at=EXCLUDED.sample_at, data_time=EXCLUDED.data_time, model_key=EXCLUDED.model_key,
         input_sha256=EXCLUDED.input_sha256, updated_at=now()`,
      [tradeDate, item.code, item.name, item.risk, item.key_level, item.reason, sampleAt, modelKey, inputHash],
    );
  }
}

function riskRank(value: Risk): number { return value === "high" ? 3 : value === "watch" ? 2 : 1; }

export async function runIntradayRiskCycle(pool: pg.Pool, now = new Date(), openDay?: boolean): Promise<IntradayRiskSnapshot | null> {
  const { day: tradeDate } = shanghaiParts(now);
  if (!isTradingSession(now) || !(openDay ?? await isOpenDay(pool, tradeDate))) return null;
  const positions = (await listPositions(pool)).filter((position) => position.quantity > 0);
  if (positions.length === 0) return { trade_date: tradeDate, running: true, sample_at: null, data_status: "ready", positions: [] };

  const positionCodes = positions.map((position) => position.code);
  const boardMap = await boardRefs(pool, positionCodes);
  const boardCodes = [...new Set([...boardMap.values()].flat().map((board) => board.code))];
  const indexCodes = [...CORE_INDEX_CODES];
  const nameMap = new Map<string, string>(positions.map((position) => [position.code, position.name]));
  for (const boards of boardMap.values()) for (const board of boards) nameMap.set(board.code, board.name);
  const indexRows = await pool.query<{ code: string; name: string }>("SELECT code, name FROM market_instrument WHERE code = ANY($1::text[])", [indexCodes]);
  for (const row of indexRows.rows) nameMap.set(row.code, row.name);
  const expected = [
    ...positions.map((position) => ({ code: position.code, name: position.name, role: "position" as const })),
    ...boardCodes.map((code) => ({ code, name: nameMap.get(code) ?? code, role: "industry" as const })),
    ...indexCodes.map((code) => ({ code, name: nameMap.get(code) ?? code, role: "index" as const })),
  ];
  const sampleAt = new Date();
  const gaps: string[] = [];
  const quoteMap = new Map<string, SnapshotQuote>();
  try {
    for (const quote of await fetchSnapshot(positionCodes, { db: pool, priority: "interactive" }, "stock")) quoteMap.set(quote.code, quote);
  } catch (error) { gaps.push(`持仓快照：${(error as Error).message}`); }
  try {
    for (const quote of await fetchSnapshot([...new Set([...boardCodes, ...indexCodes])], { db: pool, priority: "interactive" }, "index")) quoteMap.set(quote.code, quote);
  } catch (error) { gaps.push(`板块/指数快照：${(error as Error).message}`); }
  await writeSamples(pool, tradeDate, sampleAt, expected, quoteMap);

  const plan = await getLatestDailyPlanBoard(pool).catch(() => null);
  const planMap = new Map((plan?.position_actions ?? []).map((item) => [item.code, compactPlan(item as unknown as Record<string, unknown>)]));
  const refs = new Map<string, { name: string; role: QuoteContext["role"] }>();
  for (const item of expected) refs.set(item.code, { name: item.name, role: item.role });
  const allCodes = expected.map((item) => item.code);
  const [samples, bars] = await Promise.all([
    sampleContext(pool, tradeDate, allCodes, refs),
    dailyBars(pool, allCodes, tradeDate),
  ]);
  const strategyCodes = [...new Set(positions.flatMap((position) => [position.strategy_code, position.fallback_strategy_code].filter((code): code is string => Boolean(code))))];
  const strategies = await strategyContext(pool, strategyCodes);
  const samplePayload = Object.fromEntries(samples);
  const contextPositions = positions.map((position) => ({
    code: position.code,
    name: position.name,
    quantity: position.quantity,
    cost_price: position.cost_price,
    entry_signal_type: position.entry_signal_type,
    strategy_code: position.strategy_code,
    plan: planMap.get(position.code) ?? null,
    daily_bars: bars.get(position.code) ?? [],
    intraday: samplePayload[position.code] ?? null,
    industry: (boardMap.get(position.code) ?? []).map((board) => ({ ...board, daily_bars: bars.get(board.code) ?? [], intraday: samplePayload[board.code] ?? null })),
    indices: indexCodes.map((code) => ({ code, name: nameMap.get(code) ?? code, daily_bars: bars.get(code) ?? [], intraday: samplePayload[code] ?? null })),
  }));
  const payload = {
    trade_date: tradeDate,
    sampled_at: sampleAt.toISOString(),
    plan_target_date: plan?.plan.target_date ?? null,
    data_gaps: gaps,
    strategies,
    positions: contextPositions,
  };
  const previous = new Map((await listIntradayRisks(pool, tradeDate)).map((item) => [item.code, item]));
  const items = await analyse(pool, payload, new Set(positionCodes));
  const nameByCode = new Map(positions.map((position) => [position.code, position.name]));
  await upsertRisks(pool, tradeDate, sampleAt, MODEL_KEY, sha256Json(payload), items.map((item) => ({ ...item, name: nameByCode.get(item.code) ?? item.code })));
  for (const item of items) {
    const before = previous.get(item.code);
    if (before && riskRank(item.risk) <= riskRank(before.risk) && item.key_level === before.key_level) continue;
    if (item.risk === "normal") continue;
    const source = await pool.query<{ id: string }>(
      "SELECT id::text FROM intraday_position_risk WHERE trade_date=$1 AND code=$2",
      [tradeDate, item.code],
    );
    const content = `${nameByCode.get(item.code) ?? item.code}：${item.risk === "high" ? "高风险" : "关注"}\n`+
      `关键位：${item.key_level ?? "暂无明确关键位"}\n盘面：${item.reason}\n时间：${sampleAt.toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`;
    if (source.rows[0]) await enqueueIntradayRiskAlert(pool, source.rows[0].id, content);
  }
  const latest = await listIntradayRisks(pool, tradeDate);
  return { trade_date: tradeDate, running: true, sample_at: sampleAt.toISOString(), data_status: gaps.length ? "partial" : "ready", positions: latest };
}

export async function listIntradayRisks(db: Db, tradeDate = shanghaiParts().day): Promise<IntradayRiskRow[]> {
  const result = await db.query<IntradayRiskRow>(
    `SELECT code, name, risk, key_level, reason, sample_at::text, data_time::text, model_key, updated_at::text
       FROM intraday_position_risk WHERE trade_date = $1 ORDER BY CASE risk WHEN 'high' THEN 1 WHEN 'watch' THEN 2 ELSE 3 END, code`,
    [tradeDate],
  );
  return result.rows;
}

export async function getIntradayRisk(db: Db, tradeDate = shanghaiParts().day, code?: string): Promise<IntradayRiskSnapshot> {
  const rows = await listIntradayRisks(db, tradeDate);
  const sample = await db.query<{ sample_at: string | null; status: string }>(
    `SELECT max(sample_at)::text AS sample_at,
            CASE WHEN count(*) FILTER (WHERE data_status='missing') > 0 THEN 'partial' ELSE 'ready' END AS status
       FROM intraday_market_sample WHERE trade_date = $1`,
    [tradeDate],
  );
  const filtered = code ? rows.filter((row) => row.code === code) : rows;
  return {
    trade_date: tradeDate,
    running: isTradingSession(),
    sample_at: sample.rows[0]?.sample_at ?? null,
    data_status: (sample.rows[0]?.status as IntradayRiskSnapshot["data_status"]) ?? "unavailable",
    positions: filtered,
  };
}

export class IntradayRiskWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = true;
  private openDay: { day: string; open: boolean } | null = null;
  constructor(private readonly pool: pg.Pool) {}
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref?.();
  }
  private async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    let nextDelay = SAMPLE_INTERVAL_MS;
    try {
      const now = new Date();
      if (!isTradingSession(now)) nextDelay = intradayRiskNextDelayMs(now);
      else {
        const { day } = shanghaiParts(now);
        if (this.openDay?.day !== day) this.openDay = { day, open: await isOpenDay(this.pool, day) };
        nextDelay = intradayRiskNextDelayMs(now, this.openDay.open);
        if (this.openDay.open) await runIntradayRiskCycle(this.pool, now, true);
      }
    }
    catch (error) { console.error(`[intraday-risk] ${(error as Error).message}`); }
    finally {
      this.busy = false;
      this.schedule(nextDelay);
    }
  }
}

export const INTRADAY_RISK_MODEL_KEY = MODEL_KEY;
export const INTRADAY_RISK_SAMPLE_INTERVAL_MS = SAMPLE_INTERVAL_MS;
