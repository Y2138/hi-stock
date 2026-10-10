import type pg from "pg";
import { inServiceTransaction, type TransactionDb } from "../../db/transaction.js";
import { validatePoolNewsWriteInput, type PoolNewsWriteInput } from "../../agent/tool-validation.js";
import { listPoolView } from "../pools/repo.js";

export type NewsDirection = "positive" | "neutral" | "negative" | "mixed" | "unknown";
export interface MarketNewsItem {
  id: string; title: string; summary: string; category: string; scope: string;
  direction: NewsDirection; impact_level: string; relation_type: string; source_level: string;
  source_name: string; source_url: string; published_at: string | null; fetched_at: string;
  facts: string; impact_note: string; expires_at: string | null; codes: string[];
}
export interface MarketNewsSnapshot {
  id: string; target_date: string; captured_at: string; status: string;
  market_bias: NewsDirection; summary: string; checked_codes: string[]; gaps: string[];
  items: MarketNewsItem[]; stale: boolean;
}

export const shanghaiDate = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const HOUR = 3600_000;

/** 全局消息任务只读取跨账户去重的公开标的信息，不返回账户、数量或成本。 */
export async function marketNewsTargets(db: Pick<pg.Pool, "query">, date: string) {
  const view = await listPoolView(db, date);
  const positions = (await db.query<{ code: string; name: string }>(
    `SELECT DISTINCT i.code,i.name FROM portfolio_position p
     JOIN market_instrument i ON i.id=p.instrument_id ORDER BY i.code`)).rows;
  const codes = [...new Set([...view.members, ...positions].map((item) => item.code))].sort();
  const boards = (await db.query<{ code: string; board_code: string; board_name: string }>(
    `SELECT i.code,b.code AS board_code,b.name AS board_name FROM market_board_membership m
     JOIN market_instrument i ON i.id=m.member_instrument_id
     JOIN market_instrument b ON b.id=m.board_instrument_id
     JOIN market_board board ON board.instrument_id=b.id
     WHERE i.code=ANY($1::text[]) AND m.effective_from<=$2::date
       AND (m.effective_to IS NULL OR m.effective_to>$2::date)
       AND board.active AND board.board_type='industry' AND b.code LIKE '881%.TI'
     ORDER BY i.code,b.code`, [codes,date])).rows;
  const held = new Set(positions.map((item) => item.code));
  const watched = new Set(view.members.map((item) => item.code));
  const names = new Map([...view.members, ...positions].map((item) => [item.code,item.name]));
  return codes.map((code) => ({ code, name: names.get(code)!, held: held.has(code), watched: watched.has(code),
    primary_boards: boards.filter((item) => item.code === code).map((item) => ({ code: item.board_code, name: item.board_name })) }));
}

export async function getLatestMarketNews(db: Pick<pg.Pool, "query">, date?: string): Promise<MarketNewsSnapshot | null> {
  const { rows } = await db.query<MarketNewsSnapshot>(
    `SELECT s.id::text,s.target_date::text,s.captured_at::text,s.status,s.market_bias,s.summary,s.checked_codes,s.gaps
     FROM market_news_snapshot s JOIN job_run r ON r.id=s.run_id
     WHERE s.target_date <= $1::date AND r.status IN ('success','partial')
     ORDER BY s.target_date DESC,s.captured_at DESC,s.id DESC LIMIT 1`, [date ?? shanghaiDate()]);
  const row = rows[0];
  if (!row || (date && row.target_date !== date)) return null;
  const items = await db.query<MarketNewsItem>(
    `SELECT item.id::text,item.title,item.summary,item.category,item.scope,item.direction,item.impact_level,
       item.relation_type,item.source_level,item.source_name,item.source_url,item.published_at::text,
       item.fetched_at::text,item.facts,item.impact_note,item.expires_at::text,
       COALESCE(array_agg(i.code ORDER BY i.code) FILTER (WHERE i.code IS NOT NULL),ARRAY[]::text[]) AS codes
     FROM market_news_item item LEFT JOIN market_news_item_instrument link ON link.item_id=item.id
     LEFT JOIN market_instrument i ON i.id=link.instrument_id WHERE item.snapshot_id=$1 GROUP BY item.id
     ORDER BY CASE item.impact_level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,item.id`, [row.id]);
  return { ...row, items: items.rows, stale: row.target_date !== shanghaiDate() || Date.now() - Date.parse(row.captured_at) > 4 * HOUR };
}

export function instrumentNews(snapshot: MarketNewsSnapshot | null, code: string) {
  const items = snapshot?.items.filter((item) => item.codes.includes(code)) ?? [];
  const checked = snapshot?.checked_codes.includes(code) ?? false;
  const eligible = items.filter((item) => item.published_at && item.source_level !== 'unverified'
    && (!item.expires_at || Date.parse(item.expires_at) > Date.now()));
  const directions = new Set(eligible.map((item) => item.direction));
  const direction = directions.has('mixed') || (directions.has('positive') && directions.has('negative')) ? 'mixed'
    : directions.has('negative') ? 'negative' : directions.has('positive') ? 'positive'
      : directions.has('neutral') ? 'neutral' : 'unknown';
  return { items, direction: direction as NewsDirection, captured_at: snapshot?.captured_at ?? null,
    target_date: snapshot?.target_date ?? null,
    status: !snapshot ? 'pending' : snapshot.stale ? 'stale' : !checked ? 'uncovered'
      : !items.length ? 'empty' : !eligible.length ? 'unverified' : 'ready' };
}

/** 只接受本次任务实际获取过的 URL；来源抓取时间由工具记录回填，不接受模型伪造。 */
export async function writeMarketNews(db: TransactionDb, raw: PoolNewsWriteInput, runId: string) {
  const input = validatePoolNewsWriteInput(raw);
  return inServiceTransaction(db, async (client) => {
    const run = (await client.query<{ session_id: string; target_date: string; started_at: string }>(
      `SELECT r.session_id::text,r.target_date::text,r.started_at::text FROM job_run r JOIN job_definition d ON d.id=r.job_id
       WHERE r.id=$1 AND d.code='pre_market_news_scan' AND r.status='running' FOR UPDATE OF r`, [runId])).rows[0];
    if (!run || run.target_date !== input.target_date || input.target_date !== shanghaiDate()) throw new Error('仅允许当前运行写入今日消息，不支持用实时搜索回填历史');
    const messages = await client.query<{ content: { toolName?: string; isError?: boolean; details?: Record<string, unknown> } }>(
      `SELECT content FROM chat_message WHERE session_id=$1 AND role='tool' AND created_at >= $2::timestamptz ORDER BY seq`,
      [run.session_id, run.started_at]);
    const evidence = new Map<string, { fetchedAt: string; body: boolean }>();
    let searched = false;
    for (const { content } of messages.rows) {
      if (content.isError) continue;
      const d = content.details ?? {};
      if (content.toolName === 'web_search') {
        searched = true;
        for (const s of (Array.isArray(d.sources) ? d.sources : []) as Array<Record<string, unknown>>) {
          if (typeof s.url === 'string' && typeof s.fetchedAt === 'string' && !evidence.has(s.url)) evidence.set(s.url, { fetchedAt: s.fetchedAt, body: false });
        }
      }
      if (content.toolName === 'web_fetch' && typeof d.url === 'string' && typeof d.fetchedAt === 'string') {
        evidence.set(d.url, { fetchedAt: d.fetchedAt, body: typeof d.text === 'string' && d.text.length > 200 });
      }
    }
    if (!searched) throw new Error('本次运行尚未成功执行网页搜索，不能生成空消息结论');
    const known = new Set((await marketNewsTargets(client, input.target_date)).map((item) => item.code));
    if (input.checked_codes.some((code) => !known.has(code))) throw new Error('checked_codes 包含非关注池或当前持仓以外的标的');
    const checked = new Set(input.checked_codes);
    const missing = [...known].filter((code) => !checked.has(code));
    const gaps = [...new Set([...input.gaps, ...missing.map((code) => `标的未完成消息检索：${code}`)])];
    const snapshot = (await client.query<{ id: string }>(
      `INSERT INTO market_news_snapshot(target_date,market_bias,summary,run_id,checked_codes,gaps,status)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
       ON CONFLICT(run_id) DO UPDATE SET market_bias=EXCLUDED.market_bias,summary=EXCLUDED.summary,
         checked_codes=EXCLUDED.checked_codes,gaps=EXCLUDED.gaps,status=EXCLUDED.status,captured_at=now() RETURNING id::text`,
      [input.target_date,input.market_bias,input.summary,runId,JSON.stringify([...checked]),JSON.stringify(gaps),gaps.length ? 'partial' : 'success'])).rows[0]!;
    await client.query('DELETE FROM market_news_item WHERE snapshot_id=$1', [snapshot.id]);
    for (const item of input.items) {
      const source = evidence.get(item.source_url);
      if (!source || Date.now() - Date.parse(source.fetchedAt) > HOUR) throw new Error('消息来源未在本次运行中获取，或抓取已超过一小时');
      const url = new URL(item.source_url);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('消息来源 URL 非法');
      const published = item.published_at ? Date.parse(item.published_at) : null;
      if (published !== null && (published > Date.now() + 5 * 60_000 || Date.now() - published > 48 * HOUR)) throw new Error('消息必须发表于最近 48 小时内，旧闻不能作为新消息');
      if (item.source_level === 'unverified' || item.source_level === 'media') throw new Error('只接受原始披露或可追溯的专业财经来源');
      if ((!published || !source.body) && item.impact_level === 'high') throw new Error('高影响消息必须核验正文和发布时间');
      if (!published && item.direction !== 'unknown') throw new Error('发布时间未确认的消息只能标记方向未知');
      const codes = [...new Set(item.codes ?? [])];
      if (item.scope === 'instrument' && !codes.length) throw new Error('标的消息必须有关联代码');
      const instruments = await client.query<{ id: string; code: string }>('SELECT id::text,code FROM market_instrument WHERE code=ANY($1::text[])', [codes]);
      if (instruments.rows.length !== codes.length) throw new Error('消息关联代码不存在，请先消歧，不得猜测代码');
      const expires = Math.min(Date.now() + 4 * HOUR, item.expires_at ? Date.parse(item.expires_at) : Infinity);
      if (expires <= Date.now()) throw new Error('消息已过期');
      const row = (await client.query<{ id: string }>(
        `INSERT INTO market_news_item(snapshot_id,title,summary,category,scope,direction,impact_level,relation_type,
          source_level,source_name,source_url,published_at,fetched_at,facts,impact_note,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id::text`,
        [snapshot.id,item.title,item.summary,item.category,item.scope,item.direction,item.impact_level,item.relation_type ?? 'market',
          item.source_level,item.source_name,item.source_url,item.published_at ?? null,source.fetchedAt,item.facts,item.impact_note,new Date(expires).toISOString()])).rows[0]!;
      for (const i of instruments.rows) await client.query('INSERT INTO market_news_item_instrument(item_id,instrument_id) VALUES($1,$2)', [row.id,i.id]);
    }
    return { snapshot_id: snapshot.id, item_count: input.items.length, gaps };
  });
}
