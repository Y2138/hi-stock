// 冻结样本逐条适配与契约校验。
//
// 输入：artifacts/signal-export-20261111/strategy_entry_signal.jsonl（本机导出，被 Git 忽略）
// 输出：artifacts/shadow-replay/replay-coverage.json（本机报告，被 Git 忽略）
//
// 与上一版区别：不再只判断「策略编码 + 标的 + evidence 是否存在」。
// 每条样本都会走一遍该策略的适配器，构造「事件 + 观察计划」输入，再用通用契约
// missingPlanParts 做一次完整性校验，最后落到四类之一：
//   actionable    适配成功且计划完整可执行
//   draft         适配成功但计划缺项（缺风险价、缺窗口、缺价基等），只能存草案
//   unsupported   该策略没有已注册的适配器
//   failed        适配过程抛错或身份缺失
//
// 口径限制：「actionable」只证明该条能生成可执行影子计划，不证明策略有效，也不重算历史收益。
// 策略重算需要当时的策略正文与评估器版本，系统不保存历史版本，因此本轮不声称可策略重算。
import fs from "node:fs";
import path from "node:path";
import { conditionHash, missingPlanParts, riskObjectFromItem } from "../server/modules/strategy-runtime/signal-events.js";

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
  evidence: Record<string, unknown> | null;
}

type Verdict = "actionable" | "draft" | "unsupported" | "failed";

interface AdapterOutput {
  trigger: Record<string, unknown>;
  risk: Record<string, unknown>;
  priceLevels?: unknown[];
}

/** 策略适配器：按策略编码给出计划构造口径，只在回放侧使用，不在通用运行时里分支。 */
const ADAPTERS: Record<string, (row: ExportRow) => AdapterOutput> = {
  swing: (row) => {
    const evidence = row.evidence ?? {};
    const initialStop = evidence.initial_stop;
    return {
      trigger: {
        rule: String(evidence.signal ?? row.trigger_kind ?? "箱体突破"),
        must_exceed: evidence.confirmation_must_exceed ?? null,
        cap: evidence.confirmation_price_cap ?? null,
        window: row.valid_until,
        price_basis: "前复权",
        comparison: "close_above",
      },
      risk: { initial_stop: initialStop ?? null },
    };
  },
  two_year_reversal: (row) => {
    const evidence = row.evidence ?? {};
    return {
      trigger: {
        rule: "两年结构反转后企稳",
        window: row.valid_until,
        price_basis: evidence.signal_low_raw != null ? "原始价" : "前复权",
        comparison: "close_above_signal_low",
        // 两年反转的取消规则来自策略自己算的事件低点，不是模型临时编的止损。
        cancel_rule: evidence.signal_low != null ? "close_below_signal_low" : null,
      },
      risk: {
        signal_low: evidence.signal_low ?? null,
        signal_low_raw: evidence.signal_low_raw ?? null,
      },
    };
  },
  value_anchor: (row) => ({
    trigger: {
      rule: "低估值锚定",
      window: row.valid_until,
      price_basis: "前复权",
      comparison: "valuation_band",
    },
    // 价值策略没有明确取消价，只能出草案，不让模型临时编止损。
    risk: {},
  }),
  limit_up: (row) => ({
    trigger: {
      rule: "涨停次日承接",
      window: row.valid_until,
      price_basis: "前复权",
      comparison: "open_above_prev_close",
    },
    risk: {},
  }),
  first_board_advance: (row) => ({
    trigger: {
      rule: "首板晋级",
      window: row.valid_until,
      price_basis: "前复权",
      comparison: "open_above_prev_close",
    },
    risk: {},
  }),
  // copper_left_launch 尚未注册适配器，按未适配处理，而不是套用别的策略口径。
};

if (!fs.existsSync(SOURCE)) {
  console.error(`[replay-coverage] 找不到本机导出 ${SOURCE}，无法统计冻结样本覆盖。`);
  process.exit(1);
}

const rows = fs.readFileSync(SOURCE, "utf8").split("\n").filter(Boolean)
  .map((line) => JSON.parse(line) as ExportRow);

const verdicts = new Map<Verdict, number>([
  ["actionable", 0], ["draft", 0], ["unsupported", 0], ["failed", 0],
]);
const reasons = new Map<string, number>();
const byStrategy = new Map<string, { rows: number; qualified: number; approaching: number; verdicts: Record<Verdict, number> }>();
const samples: Array<{ id: string; strategy_code: string | null; verdict: Verdict; reason: string }> = [];

const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

for (const row of rows) {
  const code = row.strategy_code ?? "(空)";
  const bucket = byStrategy.get(code) ?? {
    rows: 0, qualified: 0, approaching: 0,
    verdicts: { actionable: 0, draft: 0, unsupported: 0, failed: 0 },
  };
  bucket.rows += 1;
  if (row.signal_status === "qualified") bucket.qualified += 1;
  if (row.signal_status === "approaching") bucket.approaching += 1;

  let verdict: Verdict;
  let reason: string;
  try {
    if (!row.strategy_code || !row.instrument_code || !row.evidence) {
      verdict = "failed";
      reason = "身份缺失（策略编码/标的/证据）";
    } else if (!ADAPTERS[row.strategy_code]) {
      verdict = "unsupported";
      reason = "该策略没有已注册适配器";
    } else {
      // 逐条执行适配：条件指纹、风险对象、计划输入，再用通用契约校验完整性。
      conditionHash(row.strategy_code, row.instrument_code, row.trigger_kind, { evidence: row.evidence });
      const risk = riskObjectFromItem({ evidence: row.evidence }, "strategy");
      const adapted = ADAPTERS[row.strategy_code]!(row);
      const missing = missingPlanParts({
        trigger: adapted.trigger,
        risk: adapted.risk,
        priceLevels: adapted.priceLevels ?? [],
        dataAsOf: row.valid_from,
      });
      if (missing.length === 0) {
        verdict = "actionable";
        reason = "计划完整";
      } else {
        verdict = "draft";
        reason = `缺：${missing.join(", ")}`;
        // 适配器给的风险与通用映射不一致时记一条，便于回头修适配器。
        void risk;
      }
    }
  } catch (error) {
    verdict = "failed";
    reason = `适配异常：${(error as Error).message}`;
  }

  verdicts.set(verdict, (verdicts.get(verdict) ?? 0) + 1);
  bucket.verdicts[verdict] += 1;
  byStrategy.set(code, bucket);
  bump(reasons, `${verdict}｜${reason}`);
  if (samples.length < 12 && verdict !== "actionable") {
    samples.push({ id: row.id, strategy_code: row.strategy_code, verdict, reason });
  }
}

const total = rows.length;
const summed = [...verdicts.values()].reduce((sum, value) => sum + value, 0);
if (summed !== total) {
  console.error(`[replay-coverage] 分类合计 ${summed} 与输入 ${total} 不一致，报告不可信。`);
  process.exit(1);
}

const report = {
  generated_at: new Date().toISOString(),
  source: path.relative(process.cwd(), SOURCE),
  total,
  verdicts: Object.fromEntries(verdicts),
  rule_replay: {
    replayable: 0,
    not_verified: total,
    reason: "系统不保存历史策略正文与当时的评估器版本，本轮未做可核验的策略重算；不用当前规则倒填冒充复算一致。",
  },
  by_strategy: [...byStrategy.entries()]
    .map(([code, stat]) => ({ strategy_code: code, ...stat }))
    .sort((left, right) => right.rows - left.rows),
  reasons: [...reasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count),
  samples,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));

console.log(`[replay-coverage] 冻结样本 ${total} 条，逐条适配与契约校验完成`);
console.log(`[replay-coverage] 可行动 ${verdicts.get("actionable")}｜草案 ${verdicts.get("draft")}｜未适配 ${verdicts.get("unsupported")}｜失败 ${verdicts.get("failed")}`);
console.log("[replay-coverage] 按策略：");
for (const item of report.by_strategy) {
  console.log(`  - ${item.strategy_code}: ${item.rows} 条，可行动 ${item.verdicts.actionable}、草案 ${item.verdicts.draft}、未适配 ${item.verdicts.unsupported}、失败 ${item.verdicts.failed}`);
}
console.log("[replay-coverage] 主要原因：");
for (const item of report.reasons.slice(0, 6)) console.log(`  - ${item.reason} × ${item.count}`);
console.log(`[replay-coverage] 报告写入 ${path.relative(process.cwd(), OUT_FILE)}`);
