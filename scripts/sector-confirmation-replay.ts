// 板块机会筛选确认度分级回放（只读）：按目标日重算 881 一级行业信号与分档，校验 docs/product/关注池股性与阶段展示口径.md 的验收断言。
// 不写 analysis_run，不改任何业务数据；用于实现后核对改前改后数字。
import "dotenv/config";
import pg from "pg";
import { querySectorTrendStructure } from "../server/analysis/service.js";

const REPLAY_DATE = process.env.REPLAY_DATE ?? "2026-11-04";
const EXPECTED_TIERS: Record<string, string> = {
  "881121.TI": "A",
  "881148.TI": "C",
  "881160.TI": "C",
  "881151.TI": "C",
};
const EXPECTED_INVALIDATION: Record<string, number> = {
  "881275.TI": 9021.02,
  "881279.TI": 6175.19,
  "881121.TI": 11663.58,
};

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("缺少 DATABASE_URL：请在 .env.local 配置本机 PostgreSQL 连接串");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString });
try {
  const outcome = await querySectorTrendStructure(pool, { analysis_type: "sector_trend_structure", as_of: REPLAY_DATE });
  const signals = outcome.result.signals;
  console.log(`回放目标日 ${REPLAY_DATE}，信号 ${signals.length} 个，缺口 ${outcome.gaps.length} 条`);
  console.log("板块\t代码\t触发线\t档位\t总分\tM1-M5\t涨停\t20cm\t量比\t失效位\t距收盘\t第二道");
  for (const signal of signals) {
    const confirmation = signal.confirmation;
    const metrics = confirmation.metrics;
    console.log([
      signal.sector, signal.code, signal.trigger, confirmation.tier, confirmation.score,
      `${confirmation.parts.m1}${confirmation.parts.m2}${confirmation.parts.m3}${confirmation.parts.m4}${confirmation.parts.m5}`,
      metrics.limit_up_count, metrics.limit_up_20cm_count, metrics.volume_ratio_5,
      confirmation.invalidation.price, confirmation.invalidation.distance_pct,
      confirmation.invalidation.second_price ?? "-",
    ].join("\t"));
  }
  let failed = 0;
  for (const [code, tier] of Object.entries(EXPECTED_TIERS)) {
    const signal = signals.find((item) => item.code === code);
    const actual = signal?.confirmation.tier ?? "缺失";
    const ok = actual === tier;
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"} 档位 ${code} 期望 ${tier} 实际 ${actual}`);
  }
  for (const [code, expected] of Object.entries(EXPECTED_INVALIDATION)) {
    const signal = signals.find((item) => item.code === code);
    const actual = signal?.confirmation.invalidation.price ?? null;
    const ok = actual !== null && Math.abs(actual - expected) <= expected * 0.005;
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"} 失效位 ${code} 期望 ${expected} 实际 ${actual}`);
  }
  for (const code of ["881148.TI", "881160.TI", "881151.TI"]) {
    const signal = signals.find((item) => item.code === code);
    const ok = signal !== undefined && signal.confirmation.tier === "C" && signal.catch_up === null;
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"} C 档不出候选 ${code}`);
  }
  const aTiers = signals.filter((signal) => signal.confirmation.tier === "A")
    .map((signal) => `${signal.sector}(${signal.confirmation.score})`);
  console.log(`A 档顺序：${aTiers.join("、")}`);
  const semiconductor = signals.find((signal) => signal.code === "881121.TI");
  const branchB = semiconductor?.catch_up?.branch_b.map((item) => item.name) ?? [];
  const stOk = !branchB.some((name) => /ST/i.test(name));
  if (!stOk) failed += 1;
  console.log(`${stOk ? "PASS" : "FAIL"} 半导体分支B不含 ST：${branchB.join("、") || "无"}`);
  console.log(failed === 0 ? "回放验收全部通过" : `回放验收失败 ${failed} 条`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await pool.end();
}
