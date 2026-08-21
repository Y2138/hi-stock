import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import type pg from "pg";
import { PROJECT_ROOT } from "../config.js";
import { createPool } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { ensureDatabase } from "./restore.js";
import { redactEphemeralCode } from "../agent/redaction.js";

export const DEFAULT_PORTABLE_DIR = path.join(PROJECT_ROOT, "bootstrap");
export const PORTABLE_FORMAT_VERSION = 4 as const;
export const PORTABLE_FORBIDDEN = [
  "system_setting.hithink_api_key",
  "llm_provider.api_key",
  "llm_*",
  "agent_*",
  "chat_*",
  "portfolio_*",
  "pool_*",
  "market_*",
  "analysis_*",
  "backtest_*",
  "content_*",
  "job_run*",
] as const;

interface PortableTableSpec {
  table: string;
  columns: readonly string[];
  orderBy: readonly string[];
  identity?: boolean;
  jsonColumns?: readonly string[];
  dateColumns?: readonly string[];
}

/**
 * 可提交固定资产包的唯一白名单：当前策略/演进摘要 + 定时任务定义/提示词。
 * 未列出的运行数据和本机设置绝不进入 payload；尤其不读取任何 api_key。
 * 表顺序同时是恢复插入顺序，必须满足外键依赖。
 */
export const PORTABLE_TABLES: readonly PortableTableSpec[] = [
  { table: "job_prompt", columns: ["id", "code", "name", "status", "current_revision_id", "created_at", "updated_at"], orderBy: ["id"], identity: true },
  { table: "job_prompt_revision", columns: ["id", "prompt_id", "revision_no", "content", "sha256", "source", "base_revision_id", "change_summary", "created_at"], orderBy: ["id"], identity: true },
  { table: "job_definition", columns: ["id", "code", "name", "cron", "job_type", "config", "prompt_id", "enabled"], orderBy: ["id"], identity: true, jsonColumns: ["config"] },
  { table: "strategy_evolution_log", columns: ["id", "outline", "conclusion", "adjustments", "adoption_status", "strategy_hash_before", "strategy_hash_after", "created_at", "decided_at"], orderBy: ["id"], identity: true, jsonColumns: ["adjustments"] },
  { table: "strategy_document", columns: ["id", "code", "title", "role", "injection_order", "current_revision_id", "created_at", "updated_at"], orderBy: ["id"], identity: true },
  { table: "strategy_document_revision", columns: ["id", "document_id", "revision_no", "content", "sha256", "source", "created_at"], orderBy: ["id"], identity: true },
  { table: "strategy_state", columns: ["singleton", "change_seq", "current_hash", "last_evolution_id", "updated_at"], orderBy: ["singleton"] },
] as const;

export interface PortableHashRow {
  code: string;
  revision_no: number;
  sha256: string;
}

export interface PortableManifest {
  version: 4;
  kind: "portable_fixed_assets";
  exported_at: string;
  migration_max: number;
  tables: Record<string, number>;
  strategy_hashes: PortableHashRow[];
  prompt_hashes: PortableHashRow[];
  forbidden: readonly string[];
  payload_sha256: string;
  sha256: string;
}

type Db = Pick<pg.Pool, "query">;

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, "")}"`;
}

function timestampName(date: Date): string {
  const p = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function manifestBase(manifest: Omit<PortableManifest, "sha256">): string {
  return JSON.stringify(manifest);
}

export function portableManifestSha256(manifest: Omit<PortableManifest, "sha256">): string {
  return crypto.createHash("sha256").update(manifestBase(manifest)).digest("hex");
}

async function fileSha256(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

async function revisionHashes(db: Db, kind: "strategy" | "prompt"): Promise<PortableHashRow[]> {
  const result = kind === "strategy"
    ? await db.query<PortableHashRow>(
        `SELECT d.code, r.revision_no, r.sha256 FROM strategy_document_revision r
          JOIN strategy_document d ON d.id = r.document_id ORDER BY d.code, r.revision_no`,
      )
    : await db.query<PortableHashRow>(
        `SELECT p.code, r.revision_no, r.sha256 FROM job_prompt_revision r
          JOIN job_prompt p ON p.id = r.prompt_id ORDER BY p.code, r.revision_no`,
      );
  return result.rows;
}

async function packageFacts(db: Db): Promise<{
  migrationMax: number;
  tables: Record<string, number>;
  strategyHashes: PortableHashRow[];
  promptHashes: PortableHashRow[];
}> {
  const migration = await db.query<{ max: number }>("SELECT COALESCE(max(version), 0)::int AS max FROM schema_migrations");
  const tables: Record<string, number> = {};
  for (const spec of PORTABLE_TABLES) {
    const result = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${quote(spec.table)}`);
    tables[spec.table] = result.rows[0]!.count;
  }
  // db 可能是单一事务 client；不能在同一 client 上并发 query。
  const strategyHashes = await revisionHashes(db, "strategy");
  const promptHashes = await revisionHashes(db, "prompt");
  return { migrationMax: migration.rows[0]!.max, tables, strategyHashes, promptHashes };
}

async function* payloadLines(db: Db): AsyncGenerator<string> {
  yield JSON.stringify({ type: "header", format: "stock-portable-initialization", version: PORTABLE_FORMAT_VERSION }) + "\n";
  const pageSize = 5_000;
  for (const spec of PORTABLE_TABLES) {
    let offset = 0;
    for (;;) {
      const result = await db.query<Record<string, unknown>>(
        `SELECT ${spec.columns.map((column) => spec.dateColumns?.includes(column)
          ? `${quote(column)}::text AS ${quote(column)}`
          : quote(column)).join(", ")} FROM ${quote(spec.table)}
          ORDER BY ${spec.orderBy.map(quote).join(", ")} LIMIT $1 OFFSET $2`,
        [pageSize, offset],
      );
      for (const row of result.rows) {
        yield JSON.stringify({ type: "row", table: spec.table, row: redactEphemeralCode(row) }) + "\n";
      }
      if (result.rows.length < pageSize) break;
      offset += result.rows.length;
    }
  }
}

export interface PortableExportResult {
  payloadPath: string;
  manifestPath: string;
  manifest: PortableManifest;
}

export async function exportPortableInitialization(
  db: pg.Pool,
  opts: { outDir?: string; now?: Date } = {},
): Promise<PortableExportResult> {
  const outDir = opts.outDir ?? DEFAULT_PORTABLE_DIR;
  await fsp.mkdir(outDir, { recursive: true });
  const base = `stock_init_${timestampName(opts.now ?? new Date())}`;
  const payloadPath = path.join(outDir, `${base}.ndjson.gz`);
  const manifestPath = path.join(outDir, `${base}.manifest.json`);
  const temporary = `${payloadPath}.tmp-${process.pid}`;
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await pipeline(Readable.from(payloadLines(client)), createGzip({ level: 9 }), fs.createWriteStream(temporary, { flags: "wx" }));
    await fsp.rename(temporary, payloadPath);
    const facts = await packageFacts(client);
    const baseManifest: Omit<PortableManifest, "sha256"> = {
      version: PORTABLE_FORMAT_VERSION,
      kind: "portable_fixed_assets",
      exported_at: (opts.now ?? new Date()).toISOString(),
      migration_max: facts.migrationMax,
      tables: facts.tables,
      strategy_hashes: facts.strategyHashes,
      prompt_hashes: facts.promptHashes,
      forbidden: PORTABLE_FORBIDDEN,
      payload_sha256: await fileSha256(payloadPath),
    };
    const manifest = { ...baseManifest, sha256: portableManifestSha256(baseManifest) };
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await client.query("COMMIT");
    return { payloadPath, manifestPath, manifest };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await Promise.all([
      fsp.rm(temporary, { force: true }),
      fsp.rm(payloadPath, { force: true }),
      fsp.rm(manifestPath, { force: true }),
    ]);
    throw error;
  } finally {
    client.release();
  }
}

export async function readPortableManifest(payloadPath: string): Promise<PortableManifest> {
  const manifestPath = payloadPath.replace(/\.ndjson\.gz$/, ".manifest.json");
  if (manifestPath === payloadPath) throw new Error("初始化包必须以 .ndjson.gz 结尾");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as PortableManifest;
  if (manifest.version !== PORTABLE_FORMAT_VERSION || manifest.kind !== "portable_fixed_assets") {
    throw new Error(`不支持的初始化包格式：v${String(manifest.version)}`);
  }
  const { sha256, ...base } = manifest;
  if (portableManifestSha256(base) !== sha256) throw new Error("初始化包 manifest SHA-256 校验失败");
  if (await fileSha256(payloadPath) !== manifest.payload_sha256) throw new Error("初始化包 payload SHA-256 校验失败");
  if (JSON.stringify(manifest.forbidden) !== JSON.stringify(PORTABLE_FORBIDDEN)) {
    throw new Error("初始化包敏感数据排除契约不匹配");
  }
  const allowed = new Set(PORTABLE_TABLES.map((spec) => spec.table));
  if (Object.keys(manifest.tables).some((table) => !allowed.has(table))) throw new Error("初始化包包含白名单外表");
  return manifest;
}

const RESET_STATEMENTS = [
  "DELETE FROM agent_memory_artifact",
  "DELETE FROM agent_tool_metric",
  "DELETE FROM agent_run_metric",
  "DELETE FROM agent_evaluation_run",
  "DELETE FROM market_dragon_tiger_entry",
  "DELETE FROM market_limit_ladder_snapshot",
  "DELETE FROM market_limit_event",
  "DELETE FROM market_special_sync_run",
  "DELETE FROM market_indicator_value",
  "DELETE FROM market_indicator_run",
  "DELETE FROM market_indicator_dirty",
  "DELETE FROM job_run_output",
  "DELETE FROM strategy_evolution_backtest",
  "DELETE FROM strategy_state",
  "UPDATE strategy_document SET current_revision_id = NULL",
  "DELETE FROM strategy_document_revision",
  "DELETE FROM strategy_publish_proposal",
  "DELETE FROM strategy_evolution_log",
  "DELETE FROM strategy_document",
  "DELETE FROM analysis_run",
  "DELETE FROM fundamental_snapshot",
  "DELETE FROM valuation_snapshot",
  "DELETE FROM backtest_run",
  "DELETE FROM portfolio_position_snapshot_daily",
  "DELETE FROM portfolio_position_change",
  "DELETE FROM portfolio_position",
  "DELETE FROM portfolio_account_state",
  "DELETE FROM portfolio_account_snapshot",
  "DELETE FROM job_run",
  "DELETE FROM job_definition",
  "UPDATE job_prompt SET current_revision_id = NULL",
  "DELETE FROM job_prompt_revision",
  "DELETE FROM job_prompt",
  "UPDATE content_document SET current_revision_id = NULL",
  "DELETE FROM content_legacy_import",
  "DELETE FROM content_revision",
  "DELETE FROM content_document",
  "DELETE FROM pool_board_preference",
  "DELETE FROM pool_membership",
  "DELETE FROM market_bar",
  "DELETE FROM market_board_membership",
  "DELETE FROM market_system_tracking",
  "DELETE FROM market_trading_day",
  "DELETE FROM market_board",
  "DELETE FROM market_instrument_alias",
  "DELETE FROM market_instrument",
] as const;

async function insertBatch(client: pg.PoolClient, spec: PortableTableSpec, rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.length) return;
  const values: unknown[] = [];
  const jsonColumns = new Set(spec.jsonColumns ?? []);
  const tuples = rows.map((row) => {
    const params = spec.columns.map((column) => {
      const value = row[column] ?? null;
      values.push(value !== null && jsonColumns.has(column) ? JSON.stringify(value) : value);
      return `$${values.length}${jsonColumns.has(column) ? "::jsonb" : ""}`;
    });
    return `(${params.join(", ")})`;
  });
  try {
    await client.query(
      `INSERT INTO ${quote(spec.table)} (${spec.columns.map(quote).join(", ")})${spec.identity ? " OVERRIDING SYSTEM VALUE" : ""}
       VALUES ${tuples.join(", ")}`,
      values,
    );
  } catch (error) {
    throw new Error(`初始化包恢复表 ${spec.table} 失败：${(error as Error).message}`, { cause: error });
  }
}

async function resetSequences(client: pg.PoolClient): Promise<void> {
  for (const spec of PORTABLE_TABLES.filter((item) => item.identity)) {
    const result = await client.query<{ max: string | null }>(`SELECT max(id)::text AS max FROM ${quote(spec.table)}`);
    const max = result.rows[0]!.max;
    await client.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), $2::bigint, $3::boolean)`,
      [spec.table, max ?? "1", max !== null],
    );
  }
}

async function restorePayload(pool: pg.Pool, payloadPath: string): Promise<void> {
  const specs = new Map(PORTABLE_TABLES.map((spec) => [spec.table, spec]));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    for (const statement of RESET_STATEMENTS) await client.query(statement);
    const lines = readline.createInterface({ input: fs.createReadStream(payloadPath).pipe(createGunzip()), crlfDelay: Infinity });
    let headerSeen = false;
    let currentTable: string | null = null;
    let batch: Record<string, unknown>[] = [];
    const flush = async () => {
      if (!currentTable || batch.length === 0) return;
      await insertBatch(client, specs.get(currentTable)!, batch);
      batch = [];
    };
    for await (const line of lines) {
      const item = JSON.parse(line) as { type: string; format?: string; version?: number; table?: string; row?: Record<string, unknown> };
      if (!headerSeen) {
        if (item.type !== "header" || item.format !== "stock-portable-initialization" || item.version !== PORTABLE_FORMAT_VERSION) {
          throw new Error("初始化包 payload 头非法");
        }
        headerSeen = true;
        continue;
      }
      if (item.type !== "row" || !item.table || !item.row || !specs.has(item.table)) throw new Error("初始化包包含非法记录");
      if (currentTable !== item.table || batch.length >= 250) {
        await flush();
        currentTable = item.table;
      }
      batch.push(item.row);
    }
    await flush();
    if (!headerSeen) throw new Error("初始化包 payload 为空");
    await resetSequences(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyPortableInitialization(db: Db, manifest: PortableManifest): Promise<string[]> {
  const actual = await packageFacts(db);
  const diffs: string[] = [];
  for (const [table, count] of Object.entries(manifest.tables)) {
    if (actual.tables[table] !== count) diffs.push(`表 ${table} 行数不一致：包 ${count} vs 库 ${actual.tables[table] ?? "不存在"}`);
  }
  if (JSON.stringify(actual.strategyHashes) !== JSON.stringify(manifest.strategy_hashes)) diffs.push("策略版本哈希不一致");
  if (JSON.stringify(actual.promptHashes) !== JSON.stringify(manifest.prompt_hashes)) diffs.push("作业提示词版本哈希不一致");
  if (actual.migrationMax < manifest.migration_max) diffs.push(`迁移版本不足：包 ${manifest.migration_max} vs 库 ${actual.migrationMax}`);
  return diffs;
}

export interface PortableRestoreResult {
  payloadPath: string;
  targetUrl: string;
  manifest: PortableManifest;
  diffs: string[];
}

export async function restorePortableInitialization(opts: { payloadPath: string; targetUrl: string }): Promise<PortableRestoreResult> {
  const payloadPath = path.resolve(opts.payloadPath);
  const manifest = await readPortableManifest(payloadPath);
  await ensureDatabase(opts.targetUrl);
  const pool = createPool(opts.targetUrl);
  try {
    const existing = await pool.query<{ exists: boolean }>("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists");
    if (existing.rows[0]!.exists) throw new Error("初始化包只允许恢复到尚未建 schema 的空数据库");
    await runMigrations(pool);
    const migration = await pool.query<{ max: number }>("SELECT max(version)::int AS max FROM schema_migrations");
    if (migration.rows[0]!.max < manifest.migration_max) {
      throw new Error(`当前程序迁移版本 ${migration.rows[0]!.max} 低于初始化包要求 ${manifest.migration_max}`);
    }
    await restorePayload(pool, payloadPath);
    const diffs = await verifyPortableInitialization(pool, manifest);
    if (diffs.length) throw new Error(`初始化包恢复后对账失败：\n${diffs.map((diff) => `- ${diff}`).join("\n")}`);
    return { payloadPath, targetUrl: opts.targetUrl, manifest, diffs };
  } finally {
    await pool.end();
  }
}
