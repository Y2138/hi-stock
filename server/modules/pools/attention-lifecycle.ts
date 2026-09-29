import type pg from "pg";

type Db = Pick<pg.Pool | pg.PoolClient, "query">;

/** 包含过期条目，策略重跑时仍可复核、恢复有效信号。 */
export async function strategyAttentionCodes(db: Db, strategyCode: string): Promise<string[]> {
  const result = await db.query<{ code: string }>(
    `SELECT instrument.code FROM pool_attention_entry entry
       JOIN market_instrument instrument ON instrument.id=entry.instrument_id
      WHERE entry.source_type='strategy' AND entry.strategy_code=$1 ORDER BY instrument.code`, [strategyCode]);
  return result.rows.map((row) => row.code);
}

/** 关注有效期是信息新鲜度期限，不改变策略交易窗口；日历缺失时不推测下个交易日。 */
export async function attentionValidUntil(db: Db, dataDate: string): Promise<string> {
  const result = await db.query<{ date: string | null }>(
    "SELECT min(trade_date)::text AS date FROM market_trading_day WHERE is_open AND trade_date>$1::date", [dataDate]);
  return result.rows[0]?.date ?? dataDate;
}

/** 保留历史成员记录；人工管理、人工保留及其他仍有效的策略信号均不受影响。 */
export async function closeUnwatchedAutoMembers(db: Db, date: string, codes?: string[]): Promise<string[]> {
  // 与关注写入共用成员行锁；等待并发写入后，再用新快照判断是否仍无有效来源。
  await db.query(`SELECT membership.id FROM pool_membership membership JOIN market_instrument instrument
    ON instrument.id=membership.instrument_id WHERE membership.management_mode='strategy'
      AND membership.effective_to IS NULL AND membership.effective_from<=$2::date
      AND ($1::text[] IS NULL OR instrument.code=ANY($1))
      AND NOT EXISTS (SELECT 1 FROM pool_attention_entry entry WHERE entry.instrument_id=membership.instrument_id
        AND (entry.source_type='manual' OR entry.valid_until IS NULL OR entry.valid_until>=$2::date))
    ORDER BY membership.instrument_id FOR UPDATE OF membership`, [codes ?? null, date]);
  const result = await db.query<{ code: string }>(
    `UPDATE pool_membership membership SET effective_to=$1::date, exit_reason='全部策略关注已失效或移除'
       FROM market_instrument instrument
      WHERE membership.instrument_id=instrument.id AND membership.pool='watch'
        AND membership.management_mode='strategy' AND membership.effective_to IS NULL
        AND membership.effective_from<=$1::date AND ($2::text[] IS NULL OR instrument.code=ANY($2))
        AND NOT EXISTS (SELECT 1 FROM pool_attention_entry entry WHERE entry.instrument_id=membership.instrument_id
          AND (entry.source_type='manual' OR entry.valid_until IS NULL OR entry.valid_until>=$1::date))
      RETURNING instrument.code`, [date, codes ?? null]);
  return result.rows.map((row) => row.code);
}

export interface AttentionReviewGap { code: string; reason: string }

/** 未进入候选清单不等于失效；只有实际完成复核的条目才允许按条件清退。 */
export async function reconcileAttentionRemainder(db: Db, input: {
  strategy_code: string; date: string; kept: string[]; reviewed: string[];
  gaps?: AttentionReviewGap[]; reason?: string;
  /** 因每日信号总预算被挤出但条件仍满足的标的：保留至到期、不续期也不清退。 */
  deferred?: string[];
}) {
  const current = await db.query<{ id: string; code: string; valid_from: string; valid_until: string | null; data_date: string | null; held: boolean }>(
    `SELECT entry.id::text,instrument.code,entry.valid_from::text,entry.valid_until::text,entry.data_date::text,
            EXISTS (SELECT 1 FROM portfolio_position position WHERE position.instrument_id=entry.instrument_id AND quantity>0) AS held
       FROM pool_attention_entry entry JOIN market_instrument instrument ON instrument.id=entry.instrument_id
      WHERE entry.source_type='strategy' AND entry.strategy_code=$1 AND NOT (instrument.code=ANY($2::text[]))
      ORDER BY instrument.code FOR UPDATE OF entry`, [input.strategy_code, input.kept]);
  const reviewed = new Set(input.reviewed);
  const gaps = new Map((input.gaps ?? []).map((gap) => [gap.code, gap.reason]));
  const deferred = new Set(input.deferred ?? []);
  const changes: Array<{ code: string; strategy_code: string; action: "clear" | "retain"; reason: string; stale_reason?: string }> = [];
  for (const entry of current.rows) {
    if (entry.valid_from > input.date || (entry.data_date && entry.data_date > input.date)) continue;
    // 旧版无截止日的条目也按原数据日确定期限，缺数重试不能给旧信号续期。
    const until = entry.valid_until ?? await attentionValidUntil(db, entry.data_date ?? entry.valid_from);
    const reason = entry.held ? "已转为持仓，由持仓绑定策略独立评估"
      : until < input.date ? "关注信号已超过有效期"
      : deferred.has(entry.code) ? null
      : reviewed.has(entry.code) && !gaps.has(entry.code) ? "复核后不再满足本策略关注条件" : null;
    if (reason) {
      await db.query("DELETE FROM pool_attention_entry WHERE id=$1", [entry.id]);
      changes.push({ code: entry.code, strategy_code: input.strategy_code, action: "clear", reason });
    } else {
      const staleReason = deferred.has(entry.code)
        ? "本轮因每日信号总预算未入选，条件仍满足，保留至到期"
        : (gaps.get(entry.code) ?? input.reason ?? "本轮尚未完成该标的复核，优先补齐数据").slice(0, 500);
      await db.query("UPDATE pool_attention_entry SET valid_until=$2,stale_reason=$3,updated_at=now() WHERE id=$1", [entry.id, until, staleReason]);
      changes.push({ code: entry.code, strategy_code: input.strategy_code, action: "retain", reason: staleReason, stale_reason: staleReason });
    }
  }
  const removed = await closeUnwatchedAutoMembers(db, input.date);
  return { changes, removed };
}
