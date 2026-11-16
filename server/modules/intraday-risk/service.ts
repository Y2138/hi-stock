import type pg from "pg";
import type { Context } from "@earendil-works/pi-ai";
import { fetchSnapshot, type SnapshotQuote } from "../../datasource/hithink.js";
import { getLlmConfigByModelKey } from "../../agent/ai/repo.js";
import { resolveActiveChatModel } from "../../agent/ai/runtime.js";
import type { ActiveLlmConfig } from "../../agent/ai/types.js";
import { ApiError } from "../../http/router.js";
import { sha256Json } from "../../agent/hash.js";
import { listPositions } from "../positions/repo.js";
import { enqueueBatchAlert } from "../notifications/service.js";
import { inServiceTransaction } from "../../db/transaction.js";
import { ACTION_LABELS, normalizeIntradaySignals, tradePlanLabel, type IntradayAction, type IntradaySignal } from "./signals.js";
import {
  applyIntradayDebounceRound,
  initialIntradayDebounceState,
  type IntradayDebounceState,
} from "./debounce.js";
import { shanghaiClock, shanghaiPayloadTexts, shanghaiStamp } from "./time.js";
import { readIntradaySentiment, refreshIntradaySentiment } from "./sentiment.js";
import { listHoldingCodes } from "../ultra-short/repo.js";
import { isWorkerEnabled, writeWorkerHeartbeat } from "../../scheduler/worker-status.js";

const MODEL_KEY = "GLM-5.3-Flash";
const SAMPLE_INTERVAL_MS = 60_000;
/**
 * 单轮模型调用上限。实测正常轮次约 30 秒内完成，长尾会出现约 290 秒的挂起；
 * 挂起会顺延下一条 60 秒定时，单个交易日最多丢十几轮。120 秒约为 p50 的 4 倍、
 * 足以覆盖正常调用，同时把长尾截断到可接受范围。
 */
const INTRADAY_MODEL_TIMEOUT_MS = 120_000;
/** 展示去抖回放所需的历史视野：30 轮 > 确认 2 轮 + 最短保持 2 轮，进程重启可重建。 */
const INTRADAY_SIGNAL_HISTORY_LIMIT = 30;
const ERROR_RETRY_INTERVAL_MS = 5 * 60_000;
const CORE_INDEX_CODES = [
  "000001.SH", "000016.SH", "000300.SH", "000688.SH",
  "000852.SH", "000905.SH", "399001.SZ", "399006.SZ",
] as const;

type Db = Pick<pg.Pool, "query">;
type Risk = "normal" | "watch" | "high";

export interface IntradayRiskRow extends IntradaySignal {
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
interface QuoteContext {
  code: string;
  name: string;
  role: "position" | "industry" | "index";
  summary: { open: number | null; prev_close: number | null; latest: number | null; high: number | null; low: number | null;
    volume: number | null; turnover: number | null; samples: number; distinct_quotes: number; source_at: string | null; status: string };
  recent: Array<{ at: string; source_at: string | null; price: number | null; volume_delta: number | null; turnover_delta: number | null; status: string }>;
  segments_5m: Array<{ at: string; first: number; last: number; high: number; low: number; volume_delta: number | null }>;
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

function modelConfigRevision(config: ActiveLlmConfig | null): string {
  return config ? sha256Json([config.provider.id, config.provider.updated_at, config.model.id, config.model.updated_at]) : "missing";
}

class IntradayRiskModelError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly configRevision: string) {
    super(message);
    this.name = "IntradayRiskModelError";
  }
}

/** 供应商错误可能包含凭据或请求正文，只返回固定的诊断信息。 */
function modelFailure(error: string, revision: string): IntradayRiskModelError {
  if (/\b403\b|权限|permission|forbidden|access.?denied/i.test(error)) {
    return new IntradayRiskModelError(`盘中风险模型 ${MODEL_KEY} 无访问权限，请检查厂商 API Key 和订阅套餐`, false, revision);
  }
  if (/\b401\b|unauthor|authentication|invalid.?api.?key|鉴权|认证失败/i.test(error)) {
    return new IntradayRiskModelError("盘中风险模型鉴权失败，请更新厂商 API Key", false, revision);
  }
  if (/insufficient.?balance|余额不足|欠费|\b402\b[^\n]*balance/i.test(error)) {
    // 供应商余额不足会自动恢复：保持 5 分钟退避重试，同时在心跳中明确暴露原因。
    return new IntradayRiskModelError("盘中风险模型供应商余额不足（402），请为厂商账户充值；将每 5 分钟自动重试", true, revision);
  }
  if (/insufficient.?quota|额度不足|套餐|subscription/i.test(error)) {
    return new IntradayRiskModelError("盘中风险模型套餐或额度不可用，请检查厂商配置", false, revision);
  }
  if (/\b(?:400|404|422)\b|unsupported|not.?supported|model.?not.?found|模型不存在|不支持|参数错误/i.test(error)) {
    return new IntradayRiskModelError("盘中风险模型请求配置不被厂商支持，请检查协议、地址和模型参数", false, revision);
  }
  return new IntradayRiskModelError("盘中风险模型调用失败，请检查网络及厂商服务状态", true, revision);
}

function parseModelJson(raw: string): unknown {
  if (!raw) throw new Error("盘中风险模型返回空正文");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("盘中风险模型未返回 JSON");
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    throw new Error("盘中风险模型返回的 JSON 格式无效");
  }
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

async function sampleContext(db: Db, tradeDate: string, codes: string[], refs: Map<string, { name: string; role: QuoteContext["role"] }>, at: Date): Promise<Map<string, QuoteContext>> {
  const rows = (await db.query<{ code: string; at: string; source_at: string | null; price: number | null; open: number | null; high: number | null;
    low: number | null; prev_close: number | null; volume: number | null; turnover: number | null; status: string }>(
    `SELECT code,sample_at::text AS at,source_at::text,last_price::float8 AS price,open_price::float8 AS open,
      high_price::float8 AS high,low_price::float8 AS low,prev_close::float8,volume::float8,turnover::float8,data_status AS status
     FROM intraday_market_sample WHERE trade_date=$1 AND code=ANY($2::text[]) AND sample_at<=$3 ORDER BY code,sample_at`, [tradeDate,codes,at],
  )).rows;
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) grouped.set(row.code, [...(grouped.get(row.code) ?? []), row]);
  return new Map(codes.map((code) => {
    const samples = grouped.get(code) ?? [];
    const latest = samples.at(-1);
    // rawAt 保留数据库 UTC 原值供分桶计算；对 AI 输出的 at/source_at 一律换为北京墙钟。
    const recent = samples.map((row, index) => {
      const previous = samples[index - 1];
      const delta = (field: "volume" | "turnover") => row.status === "ready" && previous?.status === "ready"
        && row[field] !== null && previous[field] !== null && row[field]! >= previous[field]! ? row[field]! - previous[field]! : null;
      return { rawAt: row.at, at: shanghaiClock(new Date(row.at)), source_at: row.source_at === null ? null : shanghaiClock(new Date(row.source_at)),
        price: row.price, volume_delta: delta("volume"), turnover_delta: delta("turnover"), status: row.status };
    });
    const segments = new Map<number, QuoteContext["segments_5m"][number]>();
    for (const row of recent) {
      if (row.status !== "ready" || row.price === null) continue;
      const bucket = Math.floor(new Date(row.rawAt).getTime() / 300_000) * 300_000;
      const segment = segments.get(bucket);
      if (!segment) segments.set(bucket, { at: shanghaiClock(new Date(bucket)), first: row.price, last: row.price, high: row.price, low: row.price, volume_delta: row.volume_delta });
      else { segment.last = row.price; segment.high = Math.max(segment.high, row.price); segment.low = Math.min(segment.low, row.price);
        segment.volume_delta = segment.volume_delta === null || row.volume_delta === null ? null : segment.volume_delta + row.volume_delta; }
    }
    return [code, { code, name: refs.get(code)?.name ?? code, role: refs.get(code)?.role ?? "index",
      summary: { open: latest?.open ?? null, prev_close: latest?.prev_close ?? null, latest: latest?.price ?? null,
        high: latest?.high ?? null, low: latest?.low ?? null, volume: latest?.volume ?? null, turnover: latest?.turnover ?? null,
        samples: samples.length, distinct_quotes: new Set(samples.filter((row) => row.status === "ready" && row.volume !== null && row.volume > 0).map((row) => row.source_at)).size,
        source_at: latest?.source_at ?? null, status: latest?.status ?? "missing" }, recent: recent.slice(-20).map(({ rawAt, ...row }) => row),
      segments_5m: [...segments.values()],
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
    const valid = quote && [quote.open,quote.high,quote.low,quote.close].every((price) => Number.isFinite(price) && price > 0);
    const fresh = valid && Number.isFinite(quote.timestampMs) && shanghaiParts(new Date(quote.timestampMs)).day === tradeDate
      && sampleAt.getTime() - quote.timestampMs <= 90_000 && quote.timestampMs <= sampleAt.getTime() + 30_000;
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
        quote?.prevClose ?? null, quote?.volume ?? null, quote?.turnover ?? null, fresh ? "ready" : quote ? "stale" : "missing"],
    );
  }
}

export function buildIntradayPrompt(payload: Record<string, unknown>): Context {
  return {
    systemPrompt: [
      "你是盘中持仓加减仓价位观察器，只生成提醒，不执行交易，不修改持仓或每日计划。",
      "输入中所有时间均为北京时间（Asia/Shanghai）当日墙钟：sampled_at 是本轮采样时刻，09:30–11:30 为早盘、13:00–15:00 为午盘。行情叙事必须与 sampled_at 所在时段一致，禁止在早盘把当日已走行情表述为午后或尾盘；针对未来时段的条件可以用「午后若……」表述。",
      "仅依据本交易日个股量价：开盘、日内高低、分时平台、冲高回落、回收与承接、增量成交量；行业和大盘当日走势辅助判断。输入不提供成本、策略止损或历史计划，不得自行补造或引用固定止损位。",
      "recent 是60秒采样，volume_delta/turnover_delta是累计成交量/额的增量；segments_5m覆盖当日采样价格分段，不能冒充完整5分钟K线。当天未采到的路径不得推断。",
      "market_context.sentiment提供当日涨停/跌停/炸板总数及多次快照，结合指数与板块区分冰点、偏弱、平稳、偏热；数据不全或过期时emotion必须unknown，不得把指数下跌直接等同冰点或减仓。",
      "情绪冰点是反向加仓机会背景：个股不再创新低、缩量止跌或放量回收且有真实承接、板块率先修复时，明确加仓区间与确认条件。持续放量下跌、承接尚未形成时等待，不因冰点直接判已触发。情绪偏热、冲高量价背离、日内平台失守后回收失败时评估减仓区间。",
      "每只持仓分别给add_plan和reduce_plan，可同时有不同价位的条件预案，无可靠依据时为null；区间必须为正数，lower<=upper，给一句量价触发条件和一句取消条件，禁止拿旧止损位代替当日依据。",
      "previous是同一账户、同一标的上一轮已发布的判断；方向变化必须有本轮新增量价证据，没有新证据时保持与上一轮方向一致，不得每轮重新拍板。历史仅作参照，不得因为上一轮是add就忽略本轮触发条件。",
      "status只有条件已在输入中实际出现且最新价格位于区间才用triggered，否则waiting；当前action为add/reduce/wait，必须与唯一已触发预案一致，不能同时触发加减仓。数据缺失、过期或有效采样不足3次时action=wait且预案不得标已触发。",
      '只返回一个JSON对象，每个真实持仓必须且只能一行：{"items":[{"code":"标的代码","action":"add|reduce|wait","add_plan":null,"reduce_plan":null,"emotion":"ice_point|weak|neutral|strong|unknown","reason":"100字以内当日量价依据"}]}。非空预案结构为{"price_lower":10.1,"price_upper":10.2,"condition":"量价确认条件","invalidation":"取消条件","status":"waiting|triggered"}，示例价格不可用于实际标的。只返回JSON，不要Markdown。',
    ].join("\n"),
    messages: [{ role: "user", content: JSON.stringify(payload), timestamp: Date.now() }],
  };
}

async function analyse(pool: pg.Pool, payload: Record<string, unknown>, codes: Set<string>, samples: Map<string, QuoteContext>, sentimentReady: boolean): Promise<IntradaySignal[]> {
  const config = await getLlmConfigByModelKey(pool, MODEL_KEY);
  const revision = modelConfigRevision(config);
  if (!config) throw new IntradayRiskModelError(`未找到可用模型 ${MODEL_KEY}，请先在设置中配置`, false, revision);
  const runtime = await resolveActiveChatModel(pool, config.model.id).catch((error: unknown) => {
    if (error instanceof ApiError && ["LLM_NOT_CONFIGURED", "LLM_DISABLED"].includes(error.code)) {
      throw new IntradayRiskModelError("盘中风险模型配置不可用，请检查厂商启用状态和 API Key", false, revision);
    }
    throw error;
  });
  let response;
  try {
    response = await runtime.models.completeSimple(runtime.model, buildIntradayPrompt(payload), {
      reasoning: "minimal",
      temperature: 0,
      sessionId: undefined,
      timeoutMs: INTRADAY_MODEL_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout|timed?\s?out|aborted|abort/i.test(message)) {
      throw new IntradayRiskModelError(`盘中风险模型调用超过 ${INTRADAY_MODEL_TIMEOUT_MS / 1000} 秒，本轮跳过`, true, revision);
    }
    throw error;
  }
  if (response.stopReason === "error") throw modelFailure(response.errorMessage ?? "", revision);
  if (response.stopReason === "aborted") throw new Error("盘中风险模型调用已中断");
  if (response.stopReason === "length") {
    throw new Error(`盘中风险模型输出被截断：已用满 ${response.usage.output} 个输出 token`);
  }
  const prices = new Map<string, number>();
  for (const code of codes) {
    const quote = samples.get(code)?.summary;
    if (quote?.status === "ready" && quote.distinct_quotes >= 3 && quote.latest !== null && Number.isFinite(quote.volume) && quote.volume! > 0 && samples.get(code)!.recent.some((row) => row.volume_delta !== null && row.volume_delta > 0) && quote.source_at
      && Date.now() - new Date(quote.source_at).getTime() <= 90_000 && new Date(quote.source_at).getTime() <= Date.now() + 30_000) prices.set(code, quote.latest);
  }
  return normalizeIntradaySignals(parseModelJson(textContent(response)), codes, prices, sentimentReady);
}

type Judgement = IntradaySignal & { name: string; data_time: string | null; latest_price: number | null };

/** 最新判断覆盖写入 intraday_position_risk；同一轮的每条判断另追加一行历史，供复盘评估。 */
async function writeJudgements(
  db: Db,
  accountId: string,
  tradeDate: string,
  sampleAt: Date,
  modelKey: string,
  inputHash: string,
  items: Judgement[],
): Promise<void> {
  for (const item of items) {
    const risk = riskOf(item.action, item.add_plan, item.reduce_plan);
    const keyLevel = [item.add_plan ? `加仓 ${tradePlanLabel(item.add_plan)}` : "",item.reduce_plan ? `减仓 ${tradePlanLabel(item.reduce_plan)}` : ""].filter(Boolean).join("；") || null;
    const addPlan = item.add_plan ? JSON.stringify(item.add_plan) : null;
    const reducePlan = item.reduce_plan ? JSON.stringify(item.reduce_plan) : null;
    await db.query(
      `INSERT INTO intraday_position_risk
        (account_id,trade_date,code,name,risk,key_level,reason,sample_at,data_time,model_key,input_sha256,action,add_plan,reduce_plan,emotion)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)
       ON CONFLICT(account_id,trade_date,code) DO UPDATE SET
         name=EXCLUDED.name,risk=EXCLUDED.risk,key_level=EXCLUDED.key_level,reason=EXCLUDED.reason,sample_at=EXCLUDED.sample_at,
         data_time=EXCLUDED.data_time,model_key=EXCLUDED.model_key,input_sha256=EXCLUDED.input_sha256,
         action=EXCLUDED.action,add_plan=EXCLUDED.add_plan,reduce_plan=EXCLUDED.reduce_plan,emotion=EXCLUDED.emotion,updated_at=now()`,
      [accountId,tradeDate,item.code,item.name,risk,keyLevel,item.reason,sampleAt,item.data_time,modelKey,inputHash,
        item.action,addPlan,reducePlan,item.emotion],
    );
    // 同一轮重复执行（相同账户、交易日、采样时刻）不重复记录历史。
    await db.query(
      `INSERT INTO intraday_position_signal
        (account_id,trade_date,sample_at,code,name,action,emotion,risk,key_level,reason,add_plan,reduce_plan,latest_price,model_key,input_sha256)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15)
       ON CONFLICT(account_id,trade_date,code,sample_at) DO NOTHING`,
      [accountId,tradeDate,sampleAt,item.code,item.name,item.action,item.emotion,risk,keyLevel,item.reason,
        addPlan,reducePlan,item.latest_price,modelKey,inputHash],
    );
  }
}

interface SignalHistoryRow {
  code: string;
  action: IntradayAction;
  emotion: string;
  add_plan: unknown;
  reduce_plan: unknown;
  key_level: string | null;
  reason: string;
  sample_at: string;
  latest_price: number | null;
}

/** 模块内去抖状态：按 账户:标的 记住已确认方向与最后一次处理到的采样时刻；跨交易日整体重置。 */
const debounceMemo = new Map<string, { at: number; state: IntradayDebounceState }>();
let debounceMemoDate: string | null = null;

function resetDebounceMemo(tradeDate: string): void {
  if (debounceMemoDate === tradeDate) return;
  debounceMemo.clear();
  debounceMemoDate = tradeDate;
}

/** 读同一账户、同一交易日、单标的最近若干轮判断；before 为空表示包含最新一轮。 */
async function loadSignalHistory(
  db: Db, accountId: string, tradeDate: string, codes: string[], before: Date | null,
): Promise<Map<string, SignalHistoryRow[]>> {
  if (codes.length === 0) return new Map();
  const rows = (await db.query<SignalHistoryRow & { rn: number }>(
    `SELECT code,action,emotion,add_plan,reduce_plan,key_level,reason,
            sample_at::text AS sample_at,latest_price::float8 AS latest_price
       FROM (
         SELECT code,action,emotion,add_plan,reduce_plan,key_level,reason,sample_at,latest_price,
                row_number() OVER(PARTITION BY code ORDER BY sample_at DESC) rn
           FROM intraday_position_signal
          WHERE account_id=$1 AND trade_date=$2 AND code=ANY($3::text[])
            AND ($4::timestamptz IS NULL OR sample_at < $4::timestamptz)
       ) ranked WHERE rn<=$5 ORDER BY code,sample_at`,
    [accountId, tradeDate, codes, before ? before.toISOString() : null, INTRADAY_SIGNAL_HISTORY_LIMIT],
  )).rows;
  const grouped = new Map<string, SignalHistoryRow[]>();
  for (const row of rows) grouped.set(row.code, [...(grouped.get(row.code) ?? []), row]);
  return grouped;
}

/**
 * 回放历史得到当前展示方向。优先从模块内状态增量续算；重启或状态缺失时整段回放，
 * 因此展示结果不依赖进程是否重启。历史里 latest_price 为空视为当轮采样不足。
 */
function resolveDebouncedState(
  accountId: string, tradeDate: string, code: string, history: SignalHistoryRow[],
): { state: IntradayDebounceState; displayAction: IntradayAction } {
  resetDebounceMemo(tradeDate);
  const key = `${accountId}:${code}`;
  const memo = debounceMemo.get(key);
  let state = initialIntradayDebounceState();
  let start = 0;
  if (memo) {
    const index = history.findIndex((row) => Date.parse(row.sample_at) === memo.at);
    if (index >= 0) {
      state = memo.state;
      start = index + 1;
    }
  }
  for (let index = start; index < history.length; index++) {
    const row = history[index]!;
    state = applyIntradayDebounceRound(state, { action: row.action, dataUsable: row.latest_price !== null }).state;
  }
  const last = history.at(-1);
  if (last) debounceMemo.set(key, { at: Date.parse(last.sample_at), state });
  return { state, displayAction: state.confirmed };
}

function promptPrevious(row: SignalHistoryRow | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    action: row.action,
    emotion: row.emotion,
    add_plan: row.add_plan,
    reduce_plan: row.reduce_plan,
    key_level: row.key_level,
    reason: row.reason,
    sampled_at: row.sample_at,
  };
}

function riskOf(action: IntradayAction, addPlan: unknown, reducePlan: unknown): Risk {
  return action === "reduce" ? "high" : action === "add" ? "normal" : addPlan || reducePlan ? "watch" : "normal";
}

export async function runIntradayRiskCycle(pool: pg.Pool, now = new Date(), openDay?: boolean, accountId = "1", sharedSample?: { at: Date; quotes: Map<string,SnapshotQuote>; gaps: string[] }): Promise<IntradayRiskSnapshot | null> {
  const { day: tradeDate } = shanghaiParts(now);
  if (!isTradingSession(now) || !(openDay ?? await isOpenDay(pool, tradeDate))) return null;
  const allPositions = (await listPositions(pool, accountId)).filter((position) => position.quantity > 0);
  const ultraShortCodes = new Set(await listHoldingCodes(pool, tradeDate));
  const positions = allPositions.filter((position) => !ultraShortCodes.has(position.code));
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
  const sampleAt = sharedSample?.at ?? new Date();
  const gaps: string[] = [...(sharedSample?.gaps ?? [])];
  const quoteMap = sharedSample?.quotes ?? new Map<string, SnapshotQuote>();
  if (!sharedSample) {
  try {
    for (const quote of await fetchSnapshot(positionCodes, { db: pool, priority: "interactive" }, "stock")) quoteMap.set(quote.code, quote);
  } catch (error) { gaps.push(`持仓快照：${(error as Error).message}`); }
  try {
    for (const quote of await fetchSnapshot([...new Set([...boardCodes, ...indexCodes])], { db: pool, priority: "interactive" }, "index")) quoteMap.set(quote.code, quote);
  } catch (error) { gaps.push(`板块/指数快照：${(error as Error).message}`); }
  }
  await writeSamples(pool, tradeDate, sampleAt, expected, quoteMap);

  const refs = new Map<string, { name: string; role: QuoteContext["role"] }>();
  for (const item of expected) refs.set(item.code, { name: item.name, role: item.role });
  if (!sharedSample) await refreshIntradaySentiment(pool, tradeDate, sampleAt);
  const [samples, sentiment] = await Promise.all([
    sampleContext(pool, tradeDate, expected.map((item) => item.code), refs, sampleAt), readIntradaySentiment(pool, tradeDate, sampleAt),
  ]);
  // 上一轮判断：同一账户、同一标的、同一交易日的最后一条历史，供模型保持方向一致性。
  const signalHistory = await loadSignalHistory(pool, accountId, tradeDate, positionCodes, sampleAt);
  const payload = shanghaiPayloadTexts({ trade_date: tradeDate, sampled_at: shanghaiStamp(sampleAt), data_gaps: gaps,
    market_context: { sentiment, industries: boardCodes.map((code) => samples.get(code)), indices: indexCodes.map((code) => samples.get(code)) },
    positions: positions.map((position) => ({ code: position.code, name: position.name, intraday: samples.get(position.code),
      previous: promptPrevious(signalHistory.get(position.code)?.at(-1)),
      industry_codes: (boardMap.get(position.code) ?? []).map((board) => board.code) })),
  });
  const items = await analyse(pool, payload, new Set(positionCodes), samples, sentiment.ready);
  // 展示去抖：落库仍是模型原始判断，只有提醒和 API 展示使用已确认方向。
  const displayActions = new Map<string, IntradayAction>();
  for (const item of items) {
    const { state } = resolveDebouncedState(accountId, tradeDate, item.code, signalHistory.get(item.code) ?? []);
    const decision = applyIntradayDebounceRound(state, { action: item.action, dataUsable: item.data_usable !== false });
    displayActions.set(item.code, decision.displayAction);
    debounceMemo.set(`${accountId}:${item.code}`, { at: sampleAt.getTime(), state: decision.state });
  }
  const displayedItems = items.map((item) => ({ ...item, action: displayActions.get(item.code) ?? item.action }));
  const nameByCode = new Map(positions.map((position) => [position.code, position.name]));
  await inServiceTransaction(pool, async (client) => {
    await writeJudgements(client, accountId, tradeDate, sampleAt, MODEL_KEY, sha256Json(payload), items.map((item) => ({
      ...item,
      name: nameByCode.get(item.code) ?? item.code,
      data_time: samples.get(item.code)?.summary.source_at ?? null,
      latest_price: samples.get(item.code)?.summary.latest ?? null,
    })));
    // 普通持仓只发一条汇总：出现加仓/减仓时，把所有普通持仓（含观察）一起发出。
    const actionable = displayedItems.some((item) => item.action === "add" || item.action === "reduce");
    if (!actionable) {
      await client.query(
        "UPDATE notification_delivery SET status='cancelled',error='盘中条件已变化' WHERE kind='intraday_digest' AND account_id=$1 AND status IN ('pending','failed')",
        [accountId],
      );
    } else {
      const content = [
        `Stock｜普通持仓盘中观察｜${sampleAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`,
        "",
        ...positions.map((position) => {
          const item = displayedItems.find((signal) => signal.code === position.code);
          const price = samples.get(position.code)?.summary.latest;
          const plan = item?.action === "add" ? item.add_plan : item?.action === "reduce" ? item.reduce_plan : null;
          const range = plan ? `：${plan.price_lower.toFixed(2)}～${plan.price_upper.toFixed(2)}` : "";
          return `${position.name} ${position.code} ${price === null || price === undefined ? "—" : price.toFixed(2)} ${item ? ACTION_LABELS[item.action] : "待观察"}${range}｜${item?.reason ?? "本轮无有效信号"}`;
        }),
      ].join("\n");
      const signature = positions.map((position) => {
        const item = displayedItems.find((signal) => signal.code === position.code);
        const plan = item?.action === "add" ? item.add_plan : item?.action === "reduce" ? item.reduce_plan : null;
        const price = samples.get(position.code)?.summary.latest;
        return {
          code: position.code,
          action: item?.action ?? "wait",
          price: price === null || price === undefined ? null : Number(price.toFixed(2)),
          reason: item?.reason ?? null,
          // 计划区间按 0.02 桶归一，避免 0.01 的微调反复发消息；实际文案仍保留精确区间。
          plan: plan ? Math.round(((plan.price_lower + plan.price_upper) / 2) * 20) / 20 : null,
        };
      });
      const eventKey = `intraday_digest:${accountId}:${tradeDate}:${sha256Json(signature)}`;
      await client.query(
        "UPDATE notification_delivery SET status='cancelled',error='盘中条件已更新' WHERE kind='intraday_digest' AND account_id=$1 AND status IN ('pending','failed') AND event_key<>$2",
        [accountId, eventKey],
      );
      await enqueueBatchAlert(client, {
        kind: "intraday_digest",
        event_key: eventKey,
        content,
        account_id: accountId,
      });
    }
  });
  return { trade_date: tradeDate, running: true, sample_at: sampleAt.toISOString(), data_status: gaps.length || !sentiment.ready || expected.some((item) => samples.get(item.code)?.summary.status !== "ready") ? "partial" : "ready", positions: await listIntradayRisks(pool,tradeDate,accountId) };
}

export async function listIntradayRisks(db: Db, tradeDate = shanghaiParts().day, accountId = "1"): Promise<IntradayRiskRow[]> {
  const result = await db.query<IntradayRiskRow>(
    `SELECT r.code,r.name,r.risk,r.key_level,r.reason,r.sample_at::text,r.data_time::text,r.model_key,r.updated_at::text,r.action,r.add_plan,r.reduce_plan,r.emotion
       FROM intraday_position_risk r JOIN market_instrument i ON i.code=r.code
       JOIN portfolio_position p ON p.instrument_id=i.id AND p.account_id=r.account_id AND p.quantity>0
       WHERE r.account_id=$1 AND r.trade_date=$2 AND r.action IS NOT NULL ORDER BY CASE r.action WHEN 'reduce' THEN 0 WHEN 'add' THEN 1 ELSE 2 END,r.code`,
    [accountId, tradeDate],
  );
  if (result.rows.length === 0) return result.rows;
  // 展示去抖：API 返回已确认方向；原始判断仍以历史表为准，不覆盖 intraday_position_risk。
  const history = await loadSignalHistory(db, accountId, tradeDate, result.rows.map((row) => row.code), null);
  const adjusted = result.rows.map((row) => {
    const displayAction = resolveDebouncedState(accountId, tradeDate, row.code, history.get(row.code) ?? []).displayAction;
    if (displayAction === row.action) return row;
    return { ...row, action: displayAction, risk: riskOf(displayAction, row.add_plan, row.reduce_plan) };
  });
  const order: Record<IntradayAction, number> = { reduce: 0, add: 1, wait: 2 };
  return adjusted.sort((a, b) => (order[a.action] - order[b.action]) || a.code.localeCompare(b.code));
}

export async function getIntradayRisk(db: Db, tradeDate = shanghaiParts().day, code?: string, accountId = "1"): Promise<IntradayRiskSnapshot> {
  const rows = await listIntradayRisks(db, tradeDate, accountId);
  const sample = (await db.query<{ sample_at: string | null; status: string; held_count: number }>(
    `WITH held AS (SELECT i.code FROM portfolio_position p JOIN market_instrument i ON i.id=p.instrument_id WHERE p.account_id=$2 AND p.quantity>0),
     latest AS (SELECT DISTINCT ON (s.code) s.sample_at,s.source_at,s.data_status FROM intraday_market_sample s JOIN held ON held.code=s.code
       WHERE s.trade_date=$1 ORDER BY s.code,s.sample_at DESC)
     SELECT max(sample_at)::text AS sample_at,(SELECT count(*)::int FROM held) AS held_count,
       CASE WHEN count(*)=0 THEN 'unavailable' WHEN count(*) FILTER(WHERE data_status<>'ready')>0 THEN 'partial' ELSE 'ready' END AS status FROM latest`, [tradeDate,accountId],
  )).rows[0]!;
  const stale = rows.some((row) => !row.data_time || Date.now() - new Date(row.data_time).getTime() > 90_000);
  const filtered = code ? rows.filter((row) => row.code === code) : rows;
  return {
    trade_date: tradeDate,
    running: tradeDate === shanghaiParts().day && isTradingSession() && await isOpenDay(db, tradeDate),
    sample_at: sample.sample_at,
    data_status: sample.held_count === 0 ? "ready" : stale ? "stale" : rows.length < sample.held_count ? "partial" : sample.status as IntradayRiskSnapshot["data_status"],
    positions: filtered,
  };
}

export class IntradayRiskWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = true;
  private openDay: { day: string; open: boolean } | null = null;
  private readonly accountRetryAt = new Map<string, number>();
  private readonly accountBlockedRevision = new Map<string, string>();
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
      if (!(await isWorkerEnabled(this.pool, "position_intraday_watch"))) return;
      const now = new Date();
      if (!isTradingSession(now)) nextDelay = intradayRiskNextDelayMs(now);
      else {
        const { day } = shanghaiParts(now);
        if (this.openDay?.day !== day) this.openDay = { day, open: await isOpenDay(this.pool, day) };
        nextDelay = intradayRiskNextDelayMs(now, this.openDay.open);
        if (this.openDay.open) {
          await writeWorkerHeartbeat(this.pool, "position_intraday_watch", { status: "running", trade_date: day });
          const accounts = await this.pool.query<{ id: string }>(
            "SELECT id::text FROM portfolio_account WHERE status = 'active' ORDER BY id",
          );
          const held = await this.pool.query<{code:string}>(`SELECT DISTINCT instrument.code FROM portfolio_position position
            JOIN market_instrument instrument ON instrument.id=position.instrument_id
            JOIN portfolio_account account ON account.id=position.account_id
            WHERE account.status='active' AND position.quantity>0`);
          const codes=held.rows.map(row=>row.code);
          const refs=await boardRefs(this.pool,codes);
          const indices=[...new Set([...CORE_INDEX_CODES,...[...refs.values()].flat().map(ref=>ref.code)])];
          const shared={at:new Date(),quotes:new Map<string,SnapshotQuote>(),gaps:[] as string[]};
          const revision = this.accountBlockedRevision.size
            ? modelConfigRevision(await getLlmConfigByModelKey(this.pool, MODEL_KEY)) : null;
          if(codes.length) {
            try { for(const quote of await fetchSnapshot(codes,{db:this.pool,priority:"interactive"},"stock")) shared.quotes.set(quote.code,quote); }
            catch(error) { shared.gaps.push(`持仓快照：${(error as Error).message}`); }
            try { for(const quote of await fetchSnapshot(indices,{db:this.pool,priority:"interactive"},"index")) shared.quotes.set(quote.code,quote); }
            catch(error) { shared.gaps.push(`板块/指数快照：${(error as Error).message}`); }
          }
          if (codes.length) await refreshIntradaySentiment(this.pool, day, shared.at);
          const failures: string[] = [];
          for (const account of accounts.rows) {
            const blocked = this.accountBlockedRevision.get(account.id);
            if (blocked !== undefined) {
              if (blocked === revision) {
                failures.push(`账户 ${account.id}：模型分析已暂停，等待模型或厂商配置更新`);
                continue;
              }
              this.accountBlockedRevision.delete(account.id);
              this.accountRetryAt.delete(account.id);
            }
            if ((this.accountRetryAt.get(account.id) ?? 0) > now.getTime()) {
              failures.push(`账户 ${account.id}：等待模型调用重试`);
              continue;
            }
            try {
              await runIntradayRiskCycle(this.pool, now, true, account.id, shared);
              this.accountRetryAt.delete(account.id);
            } catch(error) {
              failures.push(`账户 ${account.id}：${(error as Error).message}`);
              if (error instanceof IntradayRiskModelError && !error.retryable) {
                this.accountBlockedRevision.set(account.id, error.configRevision);
                console.error(`[intraday-risk] 账户 ${account.id}：${error.message}；模型分析已暂停，更新模型或厂商配置后自动重试`);
              } else {
                this.accountRetryAt.set(account.id, now.getTime() + ERROR_RETRY_INTERVAL_MS);
                console.error(`[intraday-risk] 账户 ${account.id}：${(error as Error).message}；5 分钟后重试`);
              }
            }
          }
          // 心跳必须反映真实失败：之前静默写 success 会让盘中模型停摆看起来像正常运行。
          await writeWorkerHeartbeat(this.pool, "position_intraday_watch", {
            status: failures.length > 0 ? "failed" : "success",
            trade_date: day,
            summary: failures.length > 0
              ? `账户 ${accounts.rows.length} 个；${failures.length} 个账户模型分析失败，持仓快照已更新`
              : `账户 ${accounts.rows.length} 个；持仓快照与模型观察已更新`,
            error: failures.length > 0 ? failures.join("；").slice(0, 500) : null,
          }).catch((error) => console.error(`[intraday-risk] 心跳写入失败：${(error as Error).message}`));
        }
      }
    }
    catch (error) {
      nextDelay = Math.max(nextDelay, ERROR_RETRY_INTERVAL_MS);
      await writeWorkerHeartbeat(this.pool, "position_intraday_watch", {
        status: "failed", error: (error as Error).message,
      }).catch(() => {});
      console.error(`[intraday-risk] ${(error as Error).message}；5 分钟后重试`);
    }
    finally {
      this.busy = false;
      this.schedule(nextDelay);
    }
  }
}

export const INTRADAY_RISK_MODEL_KEY = MODEL_KEY;
export const INTRADAY_RISK_SAMPLE_INTERVAL_MS = SAMPLE_INTERVAL_MS;
