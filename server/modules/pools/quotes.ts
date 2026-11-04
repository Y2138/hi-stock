// 关注池按需实时行情：点击页面按钮时拉取全部池内标的最新快照。
// 只读不落库——日线仍由每日更新链路维护，这里返回显式采样时间与缺口，不冒充收盘数据。
import { fetchBatchIsolated } from "../../datasource/batch-isolation.js";
import { fetchSnapshot, snapshotDate, type SnapshotQuote } from "../../datasource/hithink.js";
import { POOL_MEMBER_VISIBLE_SQL, WATCH_POOL, type Db } from "./repo.js";

export interface PoolQuoteItem {
  code: string;
  name: string;
  kind: "stock" | "etf";
  last: number;
  prev_close: number | null;
  change_pct: number | null;
  /** 快照所属交易日（CST，YYYY-MM-DD） */
  quote_time: string;
  /** 数据源采样时间（ISO） */
  captured_at: string;
}

export interface PoolQuotesSnapshot {
  /** 本次结果中最新的采样时间；无有效快照时为请求时间 */
  sampled_at: string;
  items: PoolQuoteItem[];
  gaps: string[];
}

/** 数据源整体不可用（限流或所有标的均无有效快照）；数据库等基础设施错误不套用此类型。 */
export class PoolQuoteUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolQuoteUnavailableError";
  }
}

export async function fetchPoolQuotes(db: Db): Promise<PoolQuotesSnapshot> {
  const requestedAt = new Date();
  const asOf = requestedAt.toISOString().slice(0, 10);
  const members = (await db.query<{ code: string; name: string; kind: string }>(
    `SELECT instrument.code, instrument.name, instrument.kind
       FROM pool_membership membership
       JOIN market_instrument instrument ON instrument.id = membership.instrument_id
      WHERE ${POOL_MEMBER_VISIBLE_SQL}
      ORDER BY instrument.code`,
    [WATCH_POOL, asOf],
  )).rows;
  const gaps: string[] = [];
  const quotes = new Map<string, SnapshotQuote>();
  const failed = new Set<string>();
  const nameByCode = new Map(members.map((member) => [member.code, member.name]));
  const label = (code: string) => `${nameByCode.get(code) ?? code}(${code})`;

  const unsupported = members.filter((member) => member.kind !== "stock" && member.kind !== "etf");
  if (unsupported.length > 0) {
    for (const member of unsupported) failed.add(member.code);
    gaps.push(`暂不支持实时行情：${unsupported.map((member) => label(member.code)).join("、")}`);
  }

  const stockCodes = members.filter((member) => member.kind === "stock").map((member) => member.code);
  if (stockCodes.length > 0) {
    try {
      const isolated = await fetchBatchIsolated(
        stockCodes,
        (batch) => fetchSnapshot(batch, { db, priority: "interactive" }, "stock"),
      );
      for (const quote of isolated.rows) quotes.set(quote.code, quote);
      for (const code of isolated.skipped) {
        failed.add(code);
        gaps.push(`${label(code)} 快照缺失`);
      }
    } catch (error) {
      throw new PoolQuoteUnavailableError(`股票快照不可用：${(error as Error).message}`);
    }
  }

  // ETF 快照端点只接受单只 thscode，逐只请求并单独记录缺口。
  for (const code of members.filter((member) => member.kind === "etf").map((member) => member.code)) {
    try {
      const [quote] = await fetchSnapshot([code], { db, priority: "interactive" }, "etf");
      if (quote) quotes.set(quote.code, quote);
      else {
        failed.add(code);
        gaps.push(`${label(code)} 快照未返回`);
      }
    } catch (error) {
      failed.add(code);
      gaps.push(`${label(code)} 快照失败：${(error as Error).message}`);
    }
  }

  const items: PoolQuoteItem[] = [];
  let latestMs = 0;
  for (const member of members) {
    const quote = quotes.get(member.code);
    if (!quote || !Number.isFinite(quote.close) || quote.close <= 0) {
      if (!failed.has(member.code)) gaps.push(`${label(member.code)} 快照缺少有效最新价`);
      continue;
    }
    const prevClose = quote.prevClose != null && Number.isFinite(quote.prevClose) && quote.prevClose > 0
      ? quote.prevClose
      : null;
    // 数据源缺少合法毫秒戳时退回请求时间，避免时间戳异常拖垮整批结果。
    const timestampMs = Number.isFinite(quote.timestampMs) ? quote.timestampMs : requestedAt.getTime();
    latestMs = Math.max(latestMs, timestampMs);
    items.push({
      code: member.code,
      name: member.name,
      kind: member.kind as "stock" | "etf",
      last: quote.close,
      prev_close: prevClose,
      change_pct: prevClose === null ? null : quote.close / prevClose - 1,
      quote_time: snapshotDate({ ...quote, timestampMs }),
      captured_at: new Date(timestampMs).toISOString(),
    });
  }

  if (members.length > 0 && items.length === 0) {
    const detail = gaps.slice(0, 3).join("；");
    throw new PoolQuoteUnavailableError(
      gaps.length > 3 ? `${detail} 等共 ${gaps.length} 项失败` : detail || "数据源没有返回任何有效快照",
    );
  }

  return {
    sampled_at: new Date(latestMs || requestedAt.getTime()).toISOString(),
    items,
    gaps,
  };
}
