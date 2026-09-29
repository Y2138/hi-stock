import type pg from "pg";
import { inServiceTransaction } from "../../db/transaction.js";
import { attentionValidUntil, reconcileAttentionRemainder, type AttentionReviewGap } from "../pools/attention-lifecycle.js";
import { ensureStrategyPoolMemberProfile, setPoolAttentionEntry } from "../pools/repo.js";
import type { StrategyEvaluationRunSummary } from "./types.js";

export interface StrategyAttentionChange {
  code: string;
  strategy_code: string;
  action: "mark" | "update" | "clear" | "skip" | "retain";
  status?: "qualified" | "approaching";
  reason?: string;
  stale_reason?: string;
  pool_removed?: boolean;
}

export async function reconcileStrategyAttention(
  db: pg.Pool,
  input: { run: StrategyEvaluationRunSummary; source_job: string },
): Promise<StrategyAttentionChange[]> {
  if (input.run.phase !== "entry" || input.run.status === "running" || input.run.status === "queued") return [];
  return inServiceTransaction(db, async (client) => {
    // ponytail: 关注写入短事务串行化；扫描在事务外执行，当前单实例无需分片锁。
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pool-attention-lifecycle'))");
    const definition = await client.query<{ name: string; attention_policy: string }>(
      "SELECT name,attention_policy FROM strategy_definition WHERE code=$1 FOR UPDATE", [input.run.strategy_code],
    );
    const strategy = definition.rows[0];
    if (!strategy || strategy.attention_policy === "none" || strategy.attention_policy === "manual_review") return [];
    // 迟到的历史任务不能覆盖更新一轮的关注状态。
    const newer = await client.query(`SELECT 1 FROM strategy_evaluation_run
      WHERE strategy_code=$1 AND phase='entry' AND status IN ('success','partial')
        AND (target_date>$2::date OR (target_date=$2::date AND id>$3)) LIMIT 1`,
      [input.run.strategy_code, input.run.target_date, input.run.id]);
    if (newer.rows.length) return [];
    const calendar = await client.query<{ date: string | null }>(
      "SELECT max(trade_date)::text AS date FROM market_trading_day WHERE is_open AND trade_date<=$1::date", [input.run.target_date]);
    const fresh = input.run.status !== "failed" && input.run.data_date !== null
      && input.run.data_date >= (calendar.rows[0]?.date ?? input.run.target_date);
    const result = input.run.result && typeof input.run.result === "object"
      ? input.run.result as Record<string, unknown> : {};
    const signals = await client.query<{
      code: string; instrument_id: string; signal_status: "qualified" | "approaching";
      reason: string; missing_signals: string[]; valid_from: string; valid_until: string | null;
    }>(`SELECT instrument.code,signal.instrument_id::text,signal.signal_status,signal.reason,
              signal.missing_signals,signal.valid_from::text,signal.valid_until::text
         FROM strategy_entry_signal signal JOIN market_instrument instrument ON instrument.id=signal.instrument_id
        WHERE signal.run_id=$1 ORDER BY instrument.code`, [input.run.id]);
    const allowed = fresh ? signals.rows.filter((signal) => strategy.attention_policy === "qualified_and_approaching"
      || signal.signal_status === "qualified") : [];
    const kept = new Set<string>();
    const changes: StrategyAttentionChange[] = [];
    for (const signal of allowed) {
      const held = await client.query("SELECT 1 FROM portfolio_position WHERE instrument_id=$1 AND quantity>0", [signal.instrument_id]);
      if (held.rows[0]) {
        changes.push({ code: signal.code, strategy_code: input.run.strategy_code, action: "skip", reason: "已有持仓" });
        continue;
      }
      await ensureStrategyPoolMemberProfile(client, {
        code: signal.code,
        effective_from: signal.valid_from,
        strategy_name: strategy.name,
      });
      kept.add(signal.code);
      const write = await setPoolAttentionEntry(client, {
        code: signal.code,
        source_job: input.source_job,
        strategy_code: input.run.strategy_code,
        source_evaluation_run_id: input.run.id,
        status: signal.signal_status,
        reason: signal.reason,
        missing_signals: signal.missing_signals,
        valid_from: signal.valid_from,
        valid_until: signal.valid_until ?? await attentionValidUntil(client, input.run.data_date!),
        data_date: input.run.data_date,
        stale_reason: null,
      });
      changes.push({
        code: signal.code, strategy_code: input.run.strategy_code,
        action: write.before ? "update" : "mark", status: signal.signal_status, reason: signal.reason,
      });
    }
    const remainder = await reconcileAttentionRemainder(client, {
      strategy_code: input.run.strategy_code, date: input.run.target_date, kept: [...kept],
      reviewed: fresh && Array.isArray(result.reviewed_codes) ? result.reviewed_codes as string[] : [],
      gaps: Array.isArray(result.review_gaps) ? result.review_gaps as AttentionReviewGap[] : [],
      deferred: Array.isArray(result.capped_out)
        ? (result.capped_out as Array<{ code?: unknown }>)
          .map((item) => typeof item.code === "string" ? item.code : null).filter((code): code is string => code !== null)
        : [],
      reason: !fresh ? "目标日数据不足，旧信号待复核且不续期" : undefined,
    });
    changes.push(...remainder.changes);
    for (const change of changes) if (remainder.removed.includes(change.code)) change.pool_removed = true;
    return changes;
  });
}
