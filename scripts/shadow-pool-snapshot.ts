// 四张业务表的基线快照与逐行比对（只读，生产库只读）。
//
// 用法：
//   npm run shadow:snapshot -- save   # 切 events_only 之后立刻存一份基线
//   npm run shadow:snapshot -- diff   # 评估跑完后再跑，逐行比对并贴出差异
//
// 比对口径：
// - 逐行比较 id 集合与关键列内容，不只看行数。
// - 排除 updated_at / last_evaluated_at：旧链路正常更新是允许的，不算新链路副作用。
// - 关注的是「有没有新链路额外写入」：新增行、删除行、关键列被改动。
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const mode = process.argv[2] ?? "save";
const OUT_DIR = path.join("artifacts", "shadow-snapshot");
const BASE_FILE = path.join(OUT_DIR, "pool-baseline.json");
const DIFF_FILE = path.join(OUT_DIR, "pool-diff.json");

const TABLES: Array<{ name: string; columns: string }> = [
  { name: "pool_membership", columns: "id::text, instrument_id::text, pool, effective_from::text, effective_to::text" },
  { name: "pool_attention_entry", columns: "id::text, instrument_id::text, source_type, strategy_code, status, reason, valid_from::text, valid_until::text" },
  { name: "notification_delivery", columns: "id::text, status, attempts, created_at::text, sent_at::text" },
  { name: "email_delivery", columns: "id::text, status, attempts, created_at::text, sent_at::text" },
];

function databaseUrl(): string {
  const src = fs.readFileSync(".env.local", "utf8");
  const found = src.match(/^\s*DATABASE_URL\s*=\s*(.+)$/m);
  if (!found) throw new Error("未找到 DATABASE_URL");
  return found[1]!.trim().replace(/^["']|["']$/g, "");
}

async function snapshot(): Promise<Record<string, Array<Record<string, unknown>>>> {
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const result: Record<string, Array<Record<string, unknown>>> = {};
    for (const table of TABLES) {
      const rows = await pool.query(`SELECT ${table.columns} FROM ${table.name} ORDER BY id`);
      result[table.name] = rows.rows;
    }
    return result;
  } finally {
    await pool.end();
  }
}

const current = await snapshot();
fs.mkdirSync(OUT_DIR, { recursive: true });

if (mode === "save") {
  fs.writeFileSync(BASE_FILE, JSON.stringify({ saved_at: new Date().toISOString(), tables: current }, null, 2));
  for (const table of TABLES) {
    console.log(`[shadow:snapshot] ${table.name}: ${current[table.name]!.length} 行`);
  }
  console.log(`[shadow:snapshot] 基线写入 ${path.relative(process.cwd(), BASE_FILE)}`);
} else if (mode === "diff") {
  if (!fs.existsSync(BASE_FILE)) {
    console.error(`[shadow:snapshot] 没有基线 ${BASE_FILE}，先跑 save。`);
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(BASE_FILE, "utf8")) as {
    saved_at: string;
    tables: Record<string, Array<Record<string, unknown>>>;
  };
  const report: Record<string, unknown> = { compared_at: new Date().toISOString(), baseline_at: baseline.saved_at, tables: {} };
  let totalDiff = 0;
  for (const table of TABLES) {
    const before = baseline.tables[table.name] ?? [];
    const after = current[table.name] ?? [];
    const beforeById = new Map(before.map((row) => [String(row.id), JSON.stringify(row)]));
    const afterById = new Map(after.map((row) => [String(row.id), JSON.stringify(row)]));
    const added = [...afterById.keys()].filter((id) => !beforeById.has(id));
    const removed = [...beforeById.keys()].filter((id) => !afterById.has(id));
    const changed = [...afterById.keys()]
      .filter((id) => beforeById.has(id) && beforeById.get(id) !== afterById.get(id))
      .map((id) => ({ id, before: JSON.parse(beforeById.get(id)!), after: JSON.parse(afterById.get(id)!) }));
    totalDiff += added.length + removed.length + changed.length;
    (report.tables as Record<string, unknown>)[table.name] = {
      before_rows: before.length,
      after_rows: after.length,
      added, removed,
      changed,
    };
    console.log(`[shadow:snapshot] ${table.name}: ${before.length} → ${after.length} 行，新增 ${added.length}、删除 ${removed.length}、改动 ${changed.length}`);
    if (changed.length > 0) {
      for (const item of changed.slice(0, 5)) {
        console.log(`    id=${item.id}`);
        console.log(`      before: ${JSON.stringify(item.before)}`);
        console.log(`      after : ${JSON.stringify(item.after)}`);
      }
    }
  }
  (report as { total_differences: number }).total_differences = totalDiff;
  fs.writeFileSync(DIFF_FILE, JSON.stringify(report, null, 2));
  console.log(`[shadow:snapshot] 差异合计 ${totalDiff}，报告写入 ${path.relative(process.cwd(), DIFF_FILE)}`);
  if (totalDiff > 0) process.exitCode = 1;
} else {
  console.error("用法：npm run shadow:snapshot -- save|diff");
  process.exit(1);
}
