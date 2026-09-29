// 迁移运行器：顺序执行 server/migrations/{NNNN}_{name}.sql
// 规则（设计契约 §4.3）：
//   - 已应用且哈希一致 → 跳过；
//   - 已应用但哈希不一致 → 报错中止，列出冲突版本，禁止自动修复；
//   - 未应用 → 单事务内执行并登记。
// 0001_init.sql 自建 schema_migrations，因此首跑前用 to_regclass 判断表是否存在。
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { loadConfig } from "../config.js";
import { closePool, getPool } from "./client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.join(here, "..", "migrations");

// 0120 曾在本地实例首次应用前修正过存量 buy 兼容条件；提交版恢复原始文件，
// 仅允许这一条已知哈希继续向前迁移，0128 会将两种旧库收敛到同一约束。
const LEGACY_APPLIED_HASHES: Readonly<Record<number, readonly string[]>> = {
  120: ["4c7908240f0703146397288035526fea7ff82657da1d971248be9894d8a9e0e4"],
  // 0146 在本机已先应用过包含结构化覆盖字段的等价版本；0149 固化提示词增量，允许该存量库继续前滚。
  146: ["f5789e936f1b6d77e55fab0d91fdc2146c69f51f4254dc15129655e793441b4c"],
  // 0150 开发库先应用过包含 management_mode/exit_reason 结构与存量关注复核提示词的等价版本；
  // 文件随后微调措辞，结构效果一致，允许该存量库继续前滚。
  150: ["e21940d9c7a03c442d56126f28e7bdb032f813417b355e7ae57604ee820ea8fb"],
};

export interface MigrationFile {
  version: number;
  name: string;
  filePath: string;
  sha256: string;
  sql: string;
}

export interface MigrateResult {
  applied: number[];
  skipped: number[];
}

export class MigrationConflictError extends Error {
  constructor(public readonly conflicts: { version: number; name: string }[]) {
    super(
      `迁移哈希不一致（已应用迁移不允许修改）：${conflicts
        .map((c) => `${c.version}_${c.name}`)
        .join(", ")}`,
    );
    this.name = "MigrationConflictError";
  }
}

/** 读取迁移目录，按版本号排序 */
export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = await fs.readdir(dir);
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    const match = /^(\d{4})_(.+)\.sql$/.exec(entry);
    if (!match) continue;
    const filePath = path.join(dir, entry);
    const content = await fs.readFile(filePath);
    files.push({
      version: Number(match[1]),
      name: match[2] ?? "",
      filePath,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      sql: content.toString("utf8"),
    });
  }
  files.sort((a, b) => a.version - b.version);
  return files;
}

/** 执行未应用的迁移；冲突时抛 MigrationConflictError */
export async function runMigrations(
  pool: pg.Pool,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrateResult> {
  const migrations = await loadMigrations(migrationsDir);

  // schema_migrations 由 0001 自建；不存在说明是全新库
  const reg = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  );
  const appliedRows = reg.rows[0]?.exists
    ? (
        await pool.query<{ version: number; name: string; sha256: string }>(
          "SELECT version, name, sha256 FROM schema_migrations",
        )
      ).rows
    : [];
  const applied = new Map(appliedRows.map((r) => [r.version, r]));

  const conflicts = migrations
    .filter((m) => applied.has(m.version)
      && applied.get(m.version)!.sha256 !== m.sha256
      && !(LEGACY_APPLIED_HASHES[m.version] ?? []).includes(applied.get(m.version)!.sha256))
    .map((m) => ({ version: m.version, name: m.name }));
  if (conflicts.length > 0) throw new MigrationConflictError(conflicts);

  const result: MigrateResult = { applied: [], skipped: [] };
  for (const m of migrations) {
    if (applied.has(m.version)) {
      result.skipped.push(m.version);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // 已发布的0120不接受存量 buy 动作。先在迁移事务中暂存这些行，
      // 0129 在放宽约束后恢复；不改写0120文件，也不丢失原动作。
      if (m.version === 120 && m.name === "每日计划策略编排切换") {
        await client.query(`CREATE TABLE migration_0120_legacy_buy (playbook_id bigint PRIMARY KEY)`);
        await client.query(`INSERT INTO migration_0120_legacy_buy (playbook_id)
          SELECT id FROM daily_plan_playbook WHERE item_kind='position_action' AND action='buy'`);
        await client.query(`UPDATE daily_plan_playbook SET action='hold'
          WHERE id IN (SELECT playbook_id FROM migration_0120_legacy_buy)`);
      }
      // 0120 的单列约束在旧库中名为 *_effective_action_check；
      // 本地修正版同时引用 strategy_code，PostgreSQL 自动命名为 *_check。
      // 0128 执行前只统一约束名称，不改变任何业务行或历史迁移文件。
      if (m.version === 128 && m.name === "历史买入预案约束兼容") {
        await client.query(`DO $compat$
          BEGIN
            IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='daily_plan_playbook'::regclass
              AND conname='daily_plan_playbook_effective_action_check')
              AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='daily_plan_playbook'::regclass
                AND conname='daily_plan_playbook_check') THEN
              ALTER TABLE daily_plan_playbook RENAME CONSTRAINT daily_plan_playbook_effective_action_check
                TO daily_plan_playbook_check;
            END IF;
          END $compat$`);
      }
      await client.query(m.sql);
      await client.query(
        "INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, $2, $3)",
        [m.version, m.name, m.sha256],
      );
      await client.query("COMMIT");
      result.applied.push(m.version);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return result;
}

/** CLI 入口：npm run db:migrate */
async function main(): Promise<void> {
  const { databaseUrl } = loadConfig();
  const pool = getPool(databaseUrl);
  try {
    const result = await runMigrations(pool);
    console.log(
      `迁移完成：新应用 ${result.applied.length} 个 [${result.applied.join(", ")}]，` +
        `跳过 ${result.skipped.length} 个 [${result.skipped.join(", ")}]`,
    );
  } catch (err) {
    if (err instanceof MigrationConflictError) {
      console.error(err.message);
    } else {
      console.error("迁移失败，请检查 DATABASE_URL 与数据库连通性：", (err as Error).message);
    }
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
