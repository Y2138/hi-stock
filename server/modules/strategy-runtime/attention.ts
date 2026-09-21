import type pg from "pg";
import { inServiceTransaction } from "../../db/transaction.js";
import { ensureStrategyPoolMemberProfile, setPoolAttentionEntry } from "../pools/repo.js";
import type { StrategyEvaluationRunSummary } from "./types.js";

export interface StrategyAttentionChange {
  code: string;
  strategy_code: string;
  action: "mark" | "update" | "clear" | "skip" | "retain";
  status?: "qualified" | "approaching";
  reason?: string;
  stale_reason?: string;
}

export async function reconcileStrategyAttention(
  db: pg.Pool,
  input: { run: StrategyEvaluationRunSummary; source_job: string },
): Promise<StrategyAttentionChange[]> {
  if (input.run.phase !== "entry" || input.run.status === "failed" || input.run.status === "running") return [];
  return inServiceTransaction(db, async (client) => {
    const definition = await client.query<{ name: string; attention_policy: string }>(
      "SELECT name,attention_policy FROM strategy_definition WHERE code=$1", [input.run.strategy_code],
    );
    const strategy = definition.rows[0];
    if (!strategy || strategy.attention_policy === "none" || strategy.attention_policy === "manual_review") return [];
    const signals = await client.query<{
      code: string; instrument_id: string; signal_status: "qualified" | "approaching";
      reason: string; missing_signals: string[]; valid_from: string; valid_until: string | null;
    }>(`SELECT instrument.code,signal.instrument_id::text,signal.signal_status,signal.reason,
              signal.missing_signals,signal.valid_from::text,signal.valid_until::text
         FROM strategy_entry_signal signal JOIN market_instrument instrument ON instrument.id=signal.instrument_id
        WHERE signal.run_id=$1 ORDER BY instrument.code`, [input.run.id]);
    const allowed = signals.rows.filter((signal) => strategy.attention_policy === "qualified_and_approaching"
      || signal.signal_status === "qualified");
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
        valid_until: signal.valid_until,
        data_date: input.run.data_date,
        stale_reason: null,
      });
      changes.push({
        code: signal.code, strategy_code: input.run.strategy_code,
        action: write.before ? "update" : "mark", status: signal.signal_status, reason: signal.reason,
      });
    }
    const existing = await client.query<{ code: string; reason: string }>(
      `SELECT instrument.code,entry.reason FROM pool_attention_entry entry
        JOIN market_instrument instrument ON instrument.id=entry.instrument_id
       WHERE entry.source_type='strategy' AND entry.strategy_code=$1
         AND NOT (instrument.code=ANY($2::text[])) ORDER BY instrument.code`,
      [input.run.strategy_code, [...kept]],
    );
    if (input.run.status === "success") {
      for (const stale of existing.rows) {
        await setPoolAttentionEntry(client, {
          code: stale.code, source_job: input.source_job, strategy_code: input.run.strategy_code,
          status: "qualified", reason: null,
        });
        changes.push({ code: stale.code, strategy_code: input.run.strategy_code, action: "clear", reason: stale.reason });
      }
    } else {
      const staleReason = input.run.gaps.length ? "本轮策略评估部分完成，未覆盖条目待复核" : "本轮策略评估部分完成";
      await client.query(
        `UPDATE pool_attention_entry SET stale_reason=$2,updated_at=now()
          WHERE source_type='strategy' AND strategy_code=$1
            AND NOT (instrument_id IN (SELECT id FROM market_instrument WHERE code=ANY($3::text[])))`,
        [input.run.strategy_code, staleReason, [...kept]],
      );
      for (const stale of existing.rows) changes.push({
        code: stale.code, strategy_code: input.run.strategy_code, action: "retain", reason: stale.reason, stale_reason: staleReason,
      });
    }
    return changes;
  });
}
