// 冻结样本回放覆盖与不可重放分类。
//
// 输入：artifacts/signal-export-20261111/strategy_entry_signal.jsonl（本机导出，被 Git 忽略）
// 输出：artifacts/shadow-replay/replay-coverage.json（本机报告，被 Git 忽略）
//
// 分类口径（与 specs/策略产物契约与影子接入/实施契约.md 一致）：
// - 契约映射回放：把历史信号按当前契约映射成「事件 + 计划」结构，只证明结构可对接，不重算策略。
// - 策略重算：需要当时的策略正文与评估器版本。系统不保存历史策略版本，因此本轮一律不可重放，
//   不允许用当前规则倒填后宣称「复算一致」。
// - 身份缺失：缺策略编码、标的或证据的行，连契约映射都不做。
import fs from "node:fs";
import path from "node:path";

const SOURCE = path.join("artifacts", "signal-export-20261111", "strategy_entry_signal.jsonl");
const OUT_DIR = path.join("artifacts", "shadow-replay");
const OUT_FILE = path.join(OUT_DIR, "replay-coverage.json");

interface ExportRow {
  id: string;
  strategy_code: string | null;
  instrument_code: string | null;
  instrument_name: string | null;
  signal_status: string;
  trigger_kind: string;
  valid_from: string;
  valid_until: string | null;
  evidence: unknown;
}

if (!fs.existsSync(SOURCE)) {
  console.error(`[replay-coverage] 找不到本机导出 ${SOURCE}，无法统计冻结样本覆盖。`);
  process.exit(1);
}

const rows = fs.readFileSync(SOURCE, "utf8").split("\n").filter(Boolean)
  .map((line) => JSON.parse(line) as ExportRow);

const byStrategy = new Map<string, { rows: number; qualified: number; approaching: number }>();
const byStatus = new Map<string, number>();
const missingIdentity: Array<{ id: string; missing: string[] }> = [];

for (const row of rows) {
  const code = row.strategy_code ?? "(手工/空)";
  const bucket = byStrategy.get(code) ?? { rows: 0, qualified: 0, approaching: 0 };
  bucket.rows += 1;
  if (row.signal_status === "qualified") bucket.qualified += 1;
  if (row.signal_status === "approaching") bucket.approaching += 1;
  byStrategy.set(code, bucket);
  byStatus.set(row.signal_status, (byStatus.get(row.signal_status) ?? 0) + 1);

  const missing: string[] = [];
  if (!row.strategy_code) missing.push("strategy_code");
  if (!row.instrument_code) missing.push("instrument_code");
  if (row.evidence === null || typeof row.evidence !== "object") missing.push("evidence");
  if (missing.length > 0) missingIdentity.push({ id: row.id, missing });
}

const report = {
  generated_at: new Date().toISOString(),
  source: path.relative(process.cwd(), SOURCE),
  total: rows.length,
  contract_mapping: {
    ok: rows.length - missingIdentity.length,
    missing_identity: missingIdentity.length,
    examples: missingIdentity.slice(0, 10),
  },
  rule_replay: {
    replayable: 0,
    not_replayable: rows.length,
    reason: "系统不保存历史策略正文与当时的评估器版本，无法按当时规则重算；禁止用当前规则倒填后宣称复算一致。",
  },
  by_status: Object.fromEntries(byStatus),
  by_strategy: [...byStrategy.entries()]
    .map(([code, stat]) => ({ strategy_code: code, ...stat }))
    .sort((left, right) => right.rows - left.rows),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));

console.log(`[replay-coverage] 冻结样本 ${report.total} 条`);
console.log(`[replay-coverage] 契约映射可对接 ${report.contract_mapping.ok} 条，身份缺失 ${report.contract_mapping.missing_identity} 条`);
console.log(`[replay-coverage] 策略重算可重放 ${report.rule_replay.replayable} 条（原因：无历史策略版本）`);
console.log("[replay-coverage] 按策略：");
for (const item of report.by_strategy) {
  console.log(`  - ${item.strategy_code}: ${item.rows} 条（正式 ${item.qualified} / 接近 ${item.approaching}）`);
}
console.log(`[replay-coverage] 报告写入 ${path.relative(process.cwd(), OUT_FILE)}`);
