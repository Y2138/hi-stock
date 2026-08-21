// 数据卷恢复：pg_restore 到目标库 + 强制 manifest 校验
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §九
// 流程：读取并校验 manifest（sha256 防篡改）→ 目标库建 schema → pg_restore →
// 强制校验 manifest vs 库内计数（不一致列出差异并抛错，不静默通过）→ 写 volume_snapshot 恢复记录。
// 默认模式要求目标库为空库（pg_restore 全量恢复 schema+数据，随后 runMigrations 补齐更新迁移）；
// --data-only 模式先 db:migrate 建 schema，再 pg_restore --data-only --disable-triggers。
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { PROJECT_ROOT } from "../config.js";
import { createPool } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { findPgTool, runPgRestore, serverMajorVersion, type PgTool } from "./export.js";
import { manifestSha256, verifyManifest, type VolumeManifest } from "./manifest.js";

export interface VolumeRestoreResult {
  dumpPath: string;
  targetUrl: string;
  tool: PgTool;
  diffs: string[];
}

/** 目标库不存在时创建（连接同实例的 postgres 维护库） */
export async function ensureDatabase(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const dbName = url.pathname.replace(/^\//, "");
  if (!dbName) throw new Error("目标连接串缺少库名");
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const r = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (r.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, "")}"`);
    }
  } finally {
    await admin.end();
  }
}

/** 读取 dump 同名 .manifest.json 并校验其 sha256（防篡改，恢复前先验） */
export async function readManifest(dumpPath: string): Promise<VolumeManifest> {
  const manifestPath = dumpPath.replace(/\.dump$/, ".manifest.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    throw new Error(`缺少同名 manifest 文件：${manifestPath}`);
  }
  const manifest = JSON.parse(raw) as VolumeManifest;
  const { sha256, ...base } = manifest;
  if (manifestSha256(base) !== sha256) {
    throw new Error(`manifest sha256 校验失败（文件被篡改？）：${manifestPath}`);
  }
  return manifest;
}

/**
 * 恢复数据卷并强制校验。任一校验失败抛错（message 含差异清单），由 CLI 非零退出。
 * 成功后写 volume_snapshot(kind='manual') 恢复记录（在校验之后，不影响对账）。
 */
export async function restoreVolume(opts: {
  dumpPath: string;
  targetUrl: string;
  dataOnly?: boolean;
}): Promise<VolumeRestoreResult> {
  const dumpPath = path.resolve(opts.dumpPath);
  const dataOnly = opts.dataOnly ?? false;
  const manifest = await readManifest(dumpPath);

  await ensureDatabase(opts.targetUrl);
  const pool = createPool(opts.targetUrl);
  try {
    const major = await serverMajorVersion(pool);
    const tool = findPgTool("pg_restore", major);
    if (!tool) {
      throw new Error(
        `pg_restore 不可用：本机无主版本 ${major} 的 pg_restore，docker compose postgres 容器也不可用`,
      );
    }
    const reg = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
    );
    const hasSchema = reg.rows[0]?.exists ?? false;
    if (dataOnly) {
      await runMigrations(pool);
      await runPgRestore(tool, opts.targetUrl, dumpPath, { dataOnly: true });
    } else {
      if (hasSchema) {
        throw new Error(
          "目标库已存在 schema：请换一个空库，或显式使用 --data-only（先迁移建 schema 再仅恢复数据）",
        );
      }
      await runPgRestore(tool, opts.targetUrl, dumpPath, { dataOnly: false });
      // 快照之后新增的迁移在此补齐（幂等）
      await runMigrations(pool);
    }

    const diffs = await verifyManifest(pool, manifest);
    if (diffs.length > 0) {
      throw new Error(`恢复后校验失败：\n${diffs.map((d) => `- ${d}`).join("\n")}`);
    }

    const rel = path.isAbsolute(dumpPath) ? path.relative(PROJECT_ROOT, dumpPath) : dumpPath;
    await pool.query(
      "INSERT INTO volume_snapshot (path, manifest, kind) VALUES ($1, $2, 'manual')",
      [rel.startsWith("..") ? dumpPath : rel, JSON.stringify(manifest)],
    );
    return { dumpPath, targetUrl: opts.targetUrl, tool, diffs };
  } finally {
    await pool.end();
  }
}
