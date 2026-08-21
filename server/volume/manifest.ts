// 数据卷 manifest：生成与校验
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §九
// manifest 内容：导出时间、每表行数、market_bar 各 freq 的 min/max bar_date、manifest sha256。
import crypto from "node:crypto";
import type { Db } from "../datasource/service.js";

export interface FreqCoverage {
  count: number;
  min: string | null;
  max: string | null;
}

export interface VolumeManifest {
  version: 1;
  exported_at: string;
  database: string;
  /** public schema 每表行数（表名升序） */
  tables: Record<string, number>;
  /** market_bar 各 freq 覆盖范围 */
  market_bar_coverage: Record<string, FreqCoverage>;
  /** 对上述字段（不含本字段）稳定序列化的 sha256 */
  sha256: string;
}

/** 稳定序列化（不含 sha256 字段）：键序由代码构造顺序保证 */
function canonical(m: Omit<VolumeManifest, "sha256">): string {
  return JSON.stringify({
    version: m.version,
    exported_at: m.exported_at,
    database: m.database,
    tables: m.tables,
    market_bar_coverage: m.market_bar_coverage,
  });
}

export function manifestSha256(m: Omit<VolumeManifest, "sha256">): string {
  return crypto.createHash("sha256").update(canonical(m)).digest("hex");
}

/** 从库内实况生成 manifest（sha256 自动计算） */
export async function buildManifest(db: Db, database: string): Promise<VolumeManifest> {
  const tablesRaw = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const tables: Record<string, number> = {};
  for (const { tablename } of tablesRaw.rows) {
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${tablename.replace(/"/g, "")}"`,
    );
    tables[tablename] = r.rows[0]!.n;
  }
  const coverage: Record<string, FreqCoverage> = {};
  if (Object.keys(tables).includes("market_bar")) {
    const r = await db.query<{ freq: string; n: number; min: string | null; max: string | null }>(
      `SELECT freq, count(*)::int AS n,
              to_char(min(bar_date), 'YYYY-MM-DD') AS min,
              to_char(max(bar_date), 'YYYY-MM-DD') AS max
       FROM market_bar GROUP BY freq ORDER BY freq`,
    );
    for (const row of r.rows) {
      coverage[row.freq] = { count: row.n, min: row.min, max: row.max };
    }
  }
  const base = {
    version: 1 as const,
    exported_at: new Date().toISOString(),
    database,
    tables,
    market_bar_coverage: coverage,
  };
  return { ...base, sha256: manifestSha256(base) };
}

/**
 * 校验 manifest vs 库内实况：返回差异清单（空数组 = 通过）。
 * 先验 manifest 自身 sha256（防篡改），再逐表比对行数与 market_bar 覆盖范围。
 */
export async function verifyManifest(db: Db, manifest: VolumeManifest): Promise<string[]> {
  const diffs: string[] = [];
  const { sha256, ...base } = manifest;
  if (manifestSha256(base) !== sha256) {
    diffs.push("manifest sha256 不一致（manifest 文件被篡改？），拒绝以库内计数为准");
    return diffs;
  }
  const actual = await buildManifest(db, manifest.database);
  const allTables = new Set([...Object.keys(manifest.tables), ...Object.keys(actual.tables)]);
  for (const t of [...allTables].sort()) {
    if (!(t in manifest.tables)) {
      diffs.push(`表 ${t} 不在 manifest 中（库内 ${actual.tables[t]} 行）`);
    } else if (!(t in actual.tables)) {
      diffs.push(`表 ${t} 在 manifest 中（${manifest.tables[t]} 行）但库内不存在`);
    } else if (manifest.tables[t] !== actual.tables[t]) {
      diffs.push(`表 ${t} 行数不一致：manifest ${manifest.tables[t]} vs 库内 ${actual.tables[t]}`);
    }
  }
  const allFreqs = new Set([
    ...Object.keys(manifest.market_bar_coverage),
    ...Object.keys(actual.market_bar_coverage),
  ]);
  for (const f of [...allFreqs].sort()) {
    const m = manifest.market_bar_coverage[f];
    const a = actual.market_bar_coverage[f];
    if (!m) {
      diffs.push(`market_bar freq=${f} 不在 manifest 中（库内 ${a!.count} 行）`);
    } else if (!a) {
      diffs.push(`market_bar freq=${f} 在 manifest 中（${m.count} 行）但库内不存在`);
    } else if (m.count !== a.count || m.min !== a.min || m.max !== a.max) {
      diffs.push(
        `market_bar freq=${f} 覆盖不一致：manifest ${m.count} 行 ${m.min ?? "-"}~${m.max ?? "-"} ` +
          `vs 库内 ${a.count} 行 ${a.min ?? "-"}~${a.max ?? "-"}`,
      );
    }
  }
  return diffs;
}
