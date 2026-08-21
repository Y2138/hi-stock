// 数据卷导出：pg_dump -Fc → datavolume/stock_YYYY-MM-DD_HHmmss.dump + 同名 .manifest.json，
// 写 volume_snapshot 行，滚动保留最近 14 份（删最旧 dump+manifest+DB 行）。
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §九
//
// pg_dump 工具探测（README「稳定命令」亦有说明）：
// 优先本机 pg_dump（主版本须与目标库一致，PostgreSQL 16）；本机缺失或主版本不符时
// 降级到 docker compose 的 postgres 容器内工具（docker compose exec -T postgres pg_dump，stdout 落盘）。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "../config.js";
import type { Db } from "../datasource/service.js";
import { buildManifest, type VolumeManifest } from "./manifest.js";

/** 默认数据卷目录（datavolume/，已 gitignore） */
export const DEFAULT_VOLUME_DIR = path.join(PROJECT_ROOT, "datavolume");
/** 滚动保留份数（设计 §九） */
export const KEEP_SNAPSHOTS = 14;

export interface PgTool {
  mode: "local" | "docker";
  version: string;
}

function parseMajor(versionText: string): number | null {
  const m = /(\d+)(?:\.\d+)?/.exec(versionText);
  return m ? Number(m[1]) : null;
}

/**
 * 探测 pg_dump/pg_restore：
 * 1. 本机二进制可用且主版本与目标库一致 → local；
 * 2. 否则尝试 docker compose postgres 容器内工具 → docker；
 * 3. 都不可用 → null（调用方报错/测试 skip）。
 */
export function findPgTool(tool: "pg_dump" | "pg_restore", serverMajor: number): PgTool | null {
  const local = spawnSync(tool, ["--version"], { encoding: "utf8" });
  if (!local.error && local.status === 0) {
    const version = String(local.stdout).trim();
    if (parseMajor(version) === serverMajor) return { mode: "local", version };
  }
  const docker = spawnSync(
    "docker",
    ["compose", "exec", "-T", "postgres", tool, "--version"],
    { encoding: "utf8", cwd: PROJECT_ROOT },
  );
  if (!docker.error && docker.status === 0) {
    const version = String(docker.stdout).trim();
    if (parseMajor(version) === serverMajor) return { mode: "docker", version };
  }
  return null;
}

/** 查询目标库主版本号 */
export async function serverMajorVersion(db: Db): Promise<number> {
  const r = await db.query<{ v: string }>("SELECT current_setting('server_version') AS v");
  const major = parseMajor(r.rows[0]!.v);
  if (major === null) throw new Error(`无法解析 server_version：${r.rows[0]!.v}`);
  return major;
}

interface DbCoords {
  user: string;
  database: string;
}

/** 从连接串解析 user/db（docker 模式在容器内按此连接本机实例） */
export function dbCoords(databaseUrl: string): DbCoords {
  const url = new URL(databaseUrl);
  return {
    user: decodeURIComponent(url.username),
    database: url.pathname.replace(/^\//, ""),
  };
}

function run(cmd: string, args: string[], opts: { stdoutToFile?: string; stdinFromFile?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: PROJECT_ROOT,
      stdio: [
        opts.stdinFromFile ? "pipe" : "ignore",
        opts.stdoutToFile ? "pipe" : "inherit",
        "pipe",
      ],
    });
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    if (opts.stdoutToFile) {
      const out = fs.createWriteStream(opts.stdoutToFile);
      child.stdout!.pipe(out);
    }
    if (opts.stdinFromFile) {
      const input = fs.createReadStream(opts.stdinFromFile);
      input.pipe(child.stdin!);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} 退出码 ${code}：${stderr.trim().slice(0, 2000)}`));
    });
  });
}

/** 执行 pg_dump -Fc 到指定文件 */
export async function runPgDump(
  tool: PgTool,
  databaseUrl: string,
  dumpPath: string,
): Promise<void> {
  if (tool.mode === "local") {
    await run("pg_dump", ["-Fc", "-f", dumpPath, `--dbname=${databaseUrl}`]);
  } else {
    const { user, database } = dbCoords(databaseUrl);
    await run("docker", ["compose", "exec", "-T", "postgres", "pg_dump", "-U", user, "-d", database, "-Fc"], {
      stdoutToFile: dumpPath,
    });
  }
}

/** 执行 pg_restore（full 或 --data-only）；docker 模式经 stdin 读入 dump */
export async function runPgRestore(
  tool: PgTool,
  targetUrl: string,
  dumpPath: string,
  opts: { dataOnly: boolean },
): Promise<void> {
  const flags = opts.dataOnly ? ["--data-only", "--disable-triggers"] : [];
  if (tool.mode === "local") {
    await run("pg_restore", ["-d", targetUrl, ...flags, dumpPath]);
  } else {
    const { user, database } = dbCoords(targetUrl);
    await run(
      "docker",
      ["compose", "exec", "-T", "postgres", "pg_restore", "-U", user, "-d", database, ...flags],
      { stdinFromFile: dumpPath },
    );
  }
}

function timestampName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export interface VolumeExportResult {
  dumpPath: string;
  manifestPath: string;
  manifest: VolumeManifest;
  tool: PgTool;
  pruned: number;
}

/**
 * 导出数据卷：pg_dump → manifest → volume_snapshot 登记 → 滚动保留 keep 份。
 */
export async function exportVolume(
  db: Db,
  databaseUrl: string,
  opts: { outDir?: string; keep?: number; kind?: "scheduled" | "manual" } = {},
): Promise<VolumeExportResult> {
  const outDir = opts.outDir ?? DEFAULT_VOLUME_DIR;
  const keep = opts.keep ?? KEEP_SNAPSHOTS;
  const kind = opts.kind ?? "manual";
  await fsp.mkdir(outDir, { recursive: true });

  const major = await serverMajorVersion(db);
  const tool = findPgTool("pg_dump", major);
  if (!tool) {
    throw new Error(
      `pg_dump 不可用：本机无主版本 ${major} 的 pg_dump，docker compose postgres 容器也不可用`,
    );
  }

  const base = `stock_${timestampName(new Date())}`;
  const dumpPath = path.join(outDir, `${base}.dump`);
  const manifestPath = path.join(outDir, `${base}.manifest.json`);

  await runPgDump(tool, databaseUrl, dumpPath);
  const { database } = dbCoords(databaseUrl);
  const manifest = await buildManifest(db, database);
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const rel = path.relative(PROJECT_ROOT, dumpPath);
  await db.query(
    "INSERT INTO volume_snapshot (path, manifest, kind) VALUES ($1, $2, $3)",
    [rel, JSON.stringify(manifest), kind],
  );

  // 滚动保留：删除最旧 dump+manifest+DB 行
  const all = await db.query<{ id: string; path: string }>(
    "SELECT id, path FROM volume_snapshot ORDER BY created_at DESC, id DESC",
  );
  let pruned = 0;
  for (const row of all.rows.slice(keep)) {
    const abs = path.isAbsolute(row.path) ? row.path : path.join(PROJECT_ROOT, row.path);
    await fsp.rm(abs, { force: true });
    await fsp.rm(abs.replace(/\.dump$/, ".manifest.json"), { force: true });
    await db.query("DELETE FROM volume_snapshot WHERE id = $1", [row.id]);
    pruned += 1;
  }

  return { dumpPath, manifestPath, manifest, tool, pruned };
}
