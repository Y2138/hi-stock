// 数据卷 HTTP 路由：快照列表、手动导出、恢复（只追加，复用 export.ts/restore.ts）
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §九、§十
// 恢复为破坏性操作：这里强制参数校验（路径必须落在 project/ 内且文件存在），
// 二次确认与警告文案在 web 侧（数据与同步页）。
import fs from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { loadConfig, PROJECT_ROOT } from "../config.js";
import { ApiError, apiErrors } from "../http/router.js";
import { exportVolume } from "./export.js";
import type { VolumeManifest } from "./manifest.js";
import { restoreVolume } from "./restore.js";
import {
  DEFAULT_PORTABLE_DIR,
  exportPortableInitialization,
  readPortableManifest,
  restorePortableInitialization,
} from "./portable.js";

interface Ctx {
  pool: pg.Pool;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export interface VolumeSnapshotRow {
  id: string;
  path: string;
  created_at: string;
  kind: "scheduled" | "manual";
  /** manifest 摘要：表数与行情覆盖，避免把整份 manifest 推给列表页 */
  manifest: {
    exported_at: string;
    database: string;
    table_count: number;
    market_bar_coverage: VolumeManifest["market_bar_coverage"];
  };
}

/** 校验 body 内的路径参数：必须落在 PROJECT_ROOT 内且以 .dump 结尾；返回绝对路径 */
async function parseDumpPath(value: unknown): Promise<string> {
  if (typeof value !== "string" || value.trim() === "") {
    throw apiErrors.badRequest("缺少 path（快照 .dump 文件路径）");
  }
  const raw = value.trim();
  if (!raw.endsWith(".dump")) {
    throw apiErrors.badRequest(`path 必须是 .dump 文件：${raw}`);
  }
  const abs = path.resolve(PROJECT_ROOT, raw);
  if (abs !== PROJECT_ROOT && !abs.startsWith(PROJECT_ROOT + path.sep)) {
    throw apiErrors.badRequest(`path 必须位于 project/ 目录内：${raw}`);
  }
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw apiErrors.badRequest(`快照文件不存在：${raw}`);
  }
  return abs;
}

async function parsePortablePath(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim().endsWith(".ndjson.gz")) {
    throw apiErrors.badRequest("path 必须是 .ndjson.gz 初始化包");
  }
  const abs = path.resolve(PROJECT_ROOT, value.trim());
  if (!abs.startsWith(PROJECT_ROOT + path.sep)) throw apiErrors.badRequest("初始化包必须位于 project/ 目录内");
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat?.isFile()) throw apiErrors.badRequest(`初始化包不存在：${value}`);
  return abs;
}

/** 导出/恢复失败的统一包装：保留底层 message（pg_dump 缺失、校验差异清单等） */
function wrapVolumeError(err: unknown, code: string): never {
  if (err instanceof ApiError) throw err;
  throw new ApiError(500, code, (err as Error).message);
}

export const volumeRoutes = {
  async listPortable() {
    await fs.mkdir(DEFAULT_PORTABLE_DIR, { recursive: true });
    const entries = (await fs.readdir(DEFAULT_PORTABLE_DIR)).filter((name) => name.endsWith(".ndjson.gz")).sort().reverse();
    const rows = [];
    for (const name of entries) {
      const payloadPath = path.join(DEFAULT_PORTABLE_DIR, name);
      try {
        const [manifest, stat] = await Promise.all([readPortableManifest(payloadPath), fs.stat(payloadPath)]);
        rows.push({
          path: path.relative(PROJECT_ROOT, payloadPath),
          size_bytes: stat.size,
          exported_at: manifest.exported_at,
          migration_max: manifest.migration_max,
          table_count: Object.keys(manifest.tables).length,
          strategy_revision_count: manifest.strategy_hashes.length,
          prompt_revision_count: manifest.prompt_hashes.length,
          job_definition_count: manifest.tables.job_definition ?? 0,
          payload_sha256: manifest.payload_sha256,
        });
      } catch {
        // 不把损坏或无 manifest 的半成品暴露为可恢复包。
      }
    }
    return { data: rows };
  },

  async exportPortable({ pool }: Ctx) {
    try {
      const result = await exportPortableInitialization(pool);
      return {
        status: 201,
        data: {
          path: path.relative(PROJECT_ROOT, result.payloadPath),
          manifest_path: path.relative(PROJECT_ROOT, result.manifestPath),
          exported_at: result.manifest.exported_at,
          migration_max: result.manifest.migration_max,
          strategy_revision_count: result.manifest.strategy_hashes.length,
          prompt_revision_count: result.manifest.prompt_hashes.length,
          job_definition_count: result.manifest.tables.job_definition ?? 0,
        },
      };
    } catch (error) {
      wrapVolumeError(error, "PORTABLE_EXPORT_FAILED");
    }
  },

  async restorePortable({ body }: Ctx) {
    const values = (body ?? {}) as Record<string, unknown>;
    const payloadPath = await parsePortablePath(values.path);
    if (typeof values.target !== "string" || !/^postgres(?:ql)?:\/\//.test(values.target)) {
      throw apiErrors.badRequest("target 必须是空数据库的 postgres:// 连接串");
    }
    try {
      const result = await restorePortableInitialization({ payloadPath, targetUrl: values.target });
      return { data: { path: result.payloadPath, verified: result.diffs.length === 0, diffs: result.diffs } };
    } catch (error) {
      wrapVolumeError(error, "PORTABLE_RESTORE_FAILED");
    }
  },

  /** GET /api/volume/snapshots：快照列表（新→旧），manifest 只带摘要 */
  async listSnapshots({ pool }: Ctx) {
    const r = await pool.query<{
      id: string;
      path: string;
      created_at: string;
      kind: "scheduled" | "manual";
      manifest: VolumeManifest;
    }>("SELECT id::text, path, created_at, kind, manifest FROM volume_snapshot ORDER BY created_at DESC, id DESC");
    const rows: VolumeSnapshotRow[] = r.rows.map((row) => ({
      id: row.id,
      path: row.path,
      created_at: row.created_at,
      kind: row.kind,
      manifest: {
        exported_at: row.manifest.exported_at,
        database: row.manifest.database,
        table_count: Object.keys(row.manifest.tables ?? {}).length,
        market_bar_coverage: row.manifest.market_bar_coverage ?? {},
      },
    }));
    return { data: rows };
  },

  /**
   * POST /api/volume/export {}：立即导出（kind='manual'），滚动保留由 exportVolume 负责。
   * body 可选 out_dir（须位于 project/ 内，缺省 project/datavolume/），主要供测试隔离。
   */
  async exportNow({ pool, body }: Ctx) {
    const b = (body ?? {}) as Record<string, unknown>;
    let outDir: string | undefined;
    if (b.out_dir !== undefined && b.out_dir !== null) {
      if (typeof b.out_dir !== "string" || b.out_dir.trim() === "") {
        throw apiErrors.badRequest("out_dir 必须是非空字符串");
      }
      const abs = path.resolve(PROJECT_ROOT, b.out_dir.trim());
      if (abs !== PROJECT_ROOT && !abs.startsWith(PROJECT_ROOT + path.sep)) {
        throw apiErrors.badRequest(`out_dir 必须位于 project/ 目录内：${b.out_dir}`);
      }
      outDir = abs;
    }
    try {
      const { databaseUrl } = loadConfig();
      const result = await exportVolume(pool, databaseUrl, { outDir, kind: "manual" });
      return {
        status: 201,
        data: {
          path: path.relative(PROJECT_ROOT, result.dumpPath),
          manifest_path: path.relative(PROJECT_ROOT, result.manifestPath),
          tool: result.tool,
          pruned: result.pruned,
          exported_at: result.manifest.exported_at,
        },
      };
    } catch (err) {
      wrapVolumeError(err, "VOLUME_EXPORT_FAILED");
    }
  },

  /**
   * POST /api/volume/restore {path, target?, data_only?}：恢复快照并强制 manifest 校验。
   * target 缺省为当前 DATABASE_URL；data_only 缺省 true（当前库已有 schema 的常见场景），
   * 传 false 则要求 target 为空库（全量恢复 schema+数据）。
   */
  async restore({ body }: Ctx) {
    const b = (body ?? {}) as Record<string, unknown>;
    const dumpPath = await parseDumpPath(b.path);
    let targetUrl: string;
    if (b.target !== undefined && b.target !== null) {
      if (typeof b.target !== "string" || !/^postgres(?:ql)?:\/\//.test(b.target)) {
        throw apiErrors.badRequest("target 必须是 postgres:// 连接串");
      }
      targetUrl = b.target;
    } else {
      targetUrl = loadConfig().databaseUrl;
    }
    if (b.data_only !== undefined && typeof b.data_only !== "boolean") {
      throw apiErrors.badRequest("data_only 必须是布尔值");
    }
    const dataOnly = b.data_only ?? true;
    try {
      const result = await restoreVolume({ dumpPath, targetUrl, dataOnly });
      return {
        data: {
          path: result.dumpPath,
          target: result.targetUrl.replace(/\/\/[^@]*@/, "//***@"),
          tool: result.tool,
          data_only: dataOnly,
          diffs: result.diffs,
          verified: result.diffs.length === 0,
        },
      };
    } catch (err) {
      wrapVolumeError(err, "VOLUME_RESTORE_FAILED");
    }
  },
};
