// 切换前对照：用最近 20 个已开市交易日的真实信号，比对「旧链路落库行」与「新契约事件」。
//
// 只读：不改库、不写池、不发通知。报告写本机 artifacts。
//
// 用法：
//   npm run shadow:compare -- two_year_reversal
//   npm run shadow:compare -- two_year_reversal --days 20
//
// 对照口径：
// - 旧侧：strategy_entry_signal 的真实行（每行一条落库信号）。
// - 新侧：同一批 evidence 按契约映射成事件；事件身份为
//   source_kind + 生产者 + 标的 + 规则版本 + 范围 + 账户（0197 起不再含条件指纹）。
// - 差异清单必须可逐条解释：合并（多行归一个事件）、字段缺失、状态变化。
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { conditionHash, missingPlanParts, riskObjectFromItem } from "../server/modules/strategy-runtime/signal-events.js";

const strategyCode = process.argv[2] ?? "two_year_reversal";
const daysArg = process.argv.indexOf("--days");
const lookbackDays = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 20;
const OUT_DIR = path.join("artifacts", "shadow-compare");
const OUT_FILE = path.join(OUT_DIR, `${strategyCode}-${lookbackDays}d.json`);

function databaseUrl(): string {
  const src = fs.readFileSync(".env.local", "utf8");
  const found = src.match(/^\s*DATABASE_URL\s*=\s*(.+)$/m);
  if (!found) throw new Error("未找到 DATABASE_URL");
  return found[1]!.trim().replace(/^["']|["']$/g, "");
}

interface SignalRow {
  id: string;
  run_id: string | null;
  strategy_code: string;
  instrument_id: string;
  signal_status: string;
  trigger_kind: string;
  valid_from: string;
  valid_until: string | null;
  invalidation: string | null;
  evidence: Record<string, unknown> | null;
}

const pool = new pg.Pool({ connectionString: databaseUrl() });
try {
  // 只取已收盘的交易日：今天 15:00 前不计入，避免把未完成的当日当成已完成样本。
  const days = (await pool.query<{ trade_date: string }>(
    `SELECT trade_date::text FROM market_trading_day
      WHERE is_open AND trade_date <= CASE
        WHEN (now() AT TIME ZONE 'Asia/Shanghai')::time >= '15:00:00'
          THEN (now() AT TIME ZONE 'Asia/Shanghai')::date
        ELSE (now() AT TIME ZONE 'Asia/Shanghai')::date - 1 END
      ORDER BY trade_date DESC LIMIT $1`,
    [lookbackDays],
  )).rows.map((row) => row.trade_date);
  if (days.length === 0) throw new Error("交易日历为空，无法确定对照窗口");
  const from = days[days.length - 1]!;
  const to = days[0]!;

  const rows = (await pool.query<SignalRow>(
    `SELECT id::text, run_id::text, strategy_code, instrument_id::text, signal_status, trigger_kind,
            valid_from::text, valid_until::text, invalidation::text, evidence
       FROM strategy_entry_signal
      WHERE strategy_code=$1 AND valid_from BETWEEN $2::date AND $3::date
      ORDER BY valid_from, id`,
    [strategyCode, from, to],
  )).rows;

  // 新侧：按契约把每行映射成事件；同一事件身份只保留一条，其余记续存。
  interface EventGroup {
    identity: string;
    instrumentId: string;
    ruleHash: string | null;
    rows: SignalRow[];
    firstRow: SignalRow;
    conditionHashes: Set<string>;
    riskComplete: boolean;
    planVerdict: "actionable" | "draft";
    planMissing: string[];
  }
  const events = new Map<string, EventGroup>();

  for (const row of rows) {
    const evidence = row.evidence ?? {};
    const hash = conditionHash(row.strategy_code, row.instrument_id, row.trigger_kind, { evidence });
    const risk = riskObjectFromItem({ evidence, invalidation: row.invalidation }, "strategy");
    // 计划只使用证据里明确存在的字段，不推窗口、不推价基、不推数据时间。
    const planMissing = missingPlanParts({
      trigger: {},
      risk: {
        initial_stop: (evidence as Record<string, unknown>).initial_stop ?? null,
        signal_low: (evidence as Record<string, unknown>).signal_low ?? null,
        signal_low_raw: (evidence as Record<string, unknown>).signal_low_raw ?? null,
      },
      priceLevels: [],
      dataAsOf: null,
    });
    const riskComplete = [risk.initial_stop, risk.signal_low, risk.signal_low_raw, risk.invalidation]
      .some((value) => value !== null);
    const identity = `${row.strategy_code}|${row.instrument_id}|${hash.slice(0, 8)}`;
    const existing = events.get(identity);
    if (existing) {
      existing.rows.push(row);
      existing.conditionHashes.add(hash);
      existing.riskComplete = existing.riskComplete || riskComplete;
      continue;
    }
    events.set(identity, {
      identity, instrumentId: row.instrument_id, ruleHash: null, rows: [row], firstRow: row,
      conditionHashes: new Set([hash]), riskComplete,
      planVerdict: planMissing.length === 0 ? "actionable" : "draft", planMissing,
    });
  }

  const merged = [...events.values()].filter((event) => event.rows.length > 1);
  const riskCompleteEvents = [...events.values()].filter((event) => event.riskComplete).length;
  const actionableEvents = [...events.values()].filter((event) => event.planVerdict === "actionable").length;
  const missingCounter = new Map<string, number>();
  for (const event of events.values()) {
    for (const item of event.planMissing) missingCounter.set(item, (missingCounter.get(item) ?? 0) + 1);
  }

  const report = {
    generated_at: new Date().toISOString(),
    scope: "只读对照：不改库、不写池、不发通知",
    strategy_code: strategyCode,
    window: { from, to, trading_days: days.length },
    old_path: {
      rows: rows.length,
      qualified: rows.filter((row) => row.signal_status === "qualified").length,
      approaching: rows.filter((row) => row.signal_status === "approaching").length,
      distinct_instruments: new Set(rows.map((row) => row.instrument_id)).size,
      distinct_days: new Set(rows.map((row) => row.valid_from)).size,
    },
    new_path: {
      // 这是候选事件数：按「同标的 + 同条件指纹」归并，未判定旧事件是否已结束再复位，
      // 因此不能当作独立机会数。
      candidate_events: events.size,
      independent_events: "未判定（缺复位证据）",
      risk_anchor_events: riskCompleteEvents,
      risk_anchor_coverage: events.size === 0 ? null : Number((riskCompleteEvents / events.size * 100).toFixed(2)),
      // 完整 risk 对象还要求价基、数据时间与证据来源，本轮未保留这些字段。
      full_risk_coverage: "未评估（价基/数据时间/证据来源未完整保留）",
      actionable_events: actionableEvents,
      draft_events: events.size - actionableEvents,
    },
    differences: {
      merged_events: merged.length,
      merged_rows: merged.reduce((sum, event) => sum + event.rows.length, 0),
      detail: merged.map((event) => ({
        identity: event.identity,
        rows: event.rows.length,
        signal_ids: event.rows.map((row) => row.id),
        dates: event.rows.map((row) => row.valid_from),
        condition_variants: event.conditionHashes.size,
      })),
    },
    plan_missing_reasons: [...missingCounter.entries()]
      .map(([item, count]) => ({ item, events: count }))
      .sort((left, right) => right.events - left.events),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));

  console.log(`[shadow:compare] ${strategyCode} ${from}~${to}（${days.length} 个交易日）`);
  console.log(`[shadow:compare] 旧链路 ${report.old_path.rows} 行（正式 ${report.old_path.qualified} / 接近 ${report.old_path.approaching}），覆盖 ${report.old_path.distinct_instruments} 只标的、${report.old_path.distinct_days} 个交易日`);
  console.log(`[shadow:compare] 新契约 ${report.new_path.candidate_events} 个候选事件（独立机会数未判定），风险锚覆盖率 ${report.new_path.risk_anchor_events}/${report.new_path.candidate_events} = ${report.new_path.risk_anchor_coverage ?? "-"}%，可行动 ${report.new_path.actionable_events}、草案 ${report.new_path.draft_events}`);
  console.log(`[shadow:compare] 完整 risk 覆盖率：${report.new_path.full_risk_coverage}`);
  console.log(`[shadow:compare] 合并 ${report.differences.merged_events} 个事件、涉及 ${report.differences.merged_rows} 行（多行归一个事件）`);
  console.log(`[shadow:compare] 报告写入 ${path.relative(process.cwd(), OUT_FILE)}`);
} finally {
  await pool.end();
}
