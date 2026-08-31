// 数据卷 HTTP 路由测试（M1 收尾波次 A 项）
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §九、§十、§十二
// - GET /api/volume/snapshots：列表形状与 manifest 摘要
// - POST /api/volume/export：真实导出小型测试库（out_dir 隔离到临时目录），列表出现新行
// - POST /api/volume/restore：参数校验 400（缺 path / 非 .dump / 路径穿越 / 文件不存在）
// 无库时整体 skip；导出用例额外要求 pg_dump 可用（本机或 docker compose postgres 容器）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../server/db/client.js";
import { runMigrations } from "../../server/db/migrate.js";
import { insertFetchRun } from "../../server/datasource/service.js";
import { findPgTool, serverMajorVersion } from "../../server/volume/export.js";
import { PROJECT_ROOT, resolveTestDatabaseUrl } from "../../server/config.js";
import { api, prepareTestDb, resetSchema, seedTestStrategy, startTestServer, type TestServer } from "./helpers.js";

// 路由的 pg_dump 目标取 loadConfig() 的 DATABASE_URL：测试进程内先把它指向派生测试库，
// 再调 prepareTestDb（vitest 按文件隔离进程，不影响其他测试文件）。
const derivedTestUrl = resolveTestDatabaseUrl();
if (derivedTestUrl) {
  process.env.TEST_DATABASE_URL = derivedTestUrl;
  process.env.DATABASE_URL = derivedTestUrl;
}

const prepared = await prepareTestDb();

/** 探测 pg_dump 可用性（不可用则导出用例 skip，沿用 migration-volume.test 模式） */
const dumpUnavailable = prepared
  ? await (async (): Promise<string | null> => {
      const major = await serverMajorVersion(prepared.pool);
      const tool = findPgTool("pg_dump", major);
      return tool ? null : `缺少主版本 ${major} 的 pg_dump（本机与 docker 均不可用）`;
    })()
  : "测试库不可用";

describe.skipIf(!prepared)("数据卷 HTTP 路由（stock_test 真实库）", () => {
  let pool: pg.Pool;
  let server: TestServer;
  let outDir: string;
  /** out_dir 相对 PROJECT_ROOT 的路径（路由要求落在仓库根目录内） */
  let outDirRel: string;
  const portableFiles: string[] = [];

  beforeAll(async () => {
    pool = createPool(prepared!.url);
    await resetSchema(pool);
    await runMigrations(pool);
    await seedTestStrategy(pool, "# 固定资产包路由测试策略");
    // 造数：一个标的 + 一条 market_fetch_run，让 manifest 有实质内容
    await pool.query(
      "INSERT INTO market_instrument (code, name, kind) VALUES ('999003.SZ', '卷路由测试股份', 'stock')",
    );
    await insertFetchRun(pool, { channel: "fixture", scope: { op: "volume-routes-test" }, rowsWritten: 0 });
    server = await startTestServer(pool);
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), "volume-routes-"));
    outDirRel = path.relative(PROJECT_ROOT, outDir);
    if (outDirRel.startsWith("..")) {
      // os.tmpdir 不在仓库根目录内时改用 datavolume 下的测试子目录
      outDir = path.join(PROJECT_ROOT, "datavolume", `test-${process.pid}`);
      outDirRel = path.relative(PROJECT_ROOT, outDir);
      await fs.mkdir(outDir, { recursive: true });
    }
  });

  afterAll(async () => {
    await server.close();
    await fs.rm(outDir, { recursive: true, force: true });
    await Promise.all(portableFiles.map((file) => fs.rm(file, { force: true })));
    await pool.end();
  });

  it("GET /api/volume/snapshots：初始为空数组", async () => {
    const { status, json } = await api(server.baseUrl, "GET", "/api/volume/snapshots");
    expect(status).toBe(200);
    expect(json).toEqual([]);
  });

  it("POST /api/volume/restore：参数校验 400", async () => {
    const missing = await api(server.baseUrl, "POST", "/api/volume/restore", {});
    expect(missing.status).toBe(400);

    const notDump = await api(server.baseUrl, "POST", "/api/volume/restore", {
      path: "datavolume/foo.tar",
    });
    expect(notDump.status).toBe(400);

    const traversal = await api(server.baseUrl, "POST", "/api/volume/restore", {
      path: "../outside/x.dump",
    });
    expect(traversal.status).toBe(400);

    const notFound = await api(server.baseUrl, "POST", "/api/volume/restore", {
      path: "datavolume/nonexistent_2099-01-01_000000.dump",
    });
    expect(notFound.status).toBe(400);

    const badTarget = await api(server.baseUrl, "POST", "/api/volume/restore", {
      path: "datavolume/nonexistent_2099-01-01_000000.dump",
      target: "not-a-url",
    });
    expect(badTarget.status).toBe(400);
  });

  it("固定资产包路由可导出并列出策略与任务摘要", async () => {
    const exported = await api(server.baseUrl, "POST", "/api/volume/portable/export", {});
    expect(exported.status).toBe(201);
    const data = exported.json as { path: string; manifest_path: string; migration_max: number; strategy_revision_count: number; job_definition_count: number };
    expect(data.path).toMatch(/\.ndjson\.gz$/);
    expect(data.migration_max).toBe(56);
    expect(data.strategy_revision_count).toBeGreaterThan(0);
    expect(data.job_definition_count).toBeGreaterThan(0);
    portableFiles.push(path.join(PROJECT_ROOT, data.path), path.join(PROJECT_ROOT, data.manifest_path));
    const listed = await api(server.baseUrl, "GET", "/api/volume/portable");
    expect(listed.status).toBe(200);
    expect(listed.json).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: data.path, migration_max: 56, strategy_revision_count: data.strategy_revision_count }),
    ]));
  });

  it.skipIf(dumpUnavailable !== null)(
    "POST /api/volume/export：真实导出小型测试库，快照列表出现新行且带 manifest 摘要",
    async () => {
      const { status, json } = await api(server.baseUrl, "POST", "/api/volume/export", {
        out_dir: outDirRel,
      });
      expect(status).toBe(201);
      const data = json as unknown as {
        path: string;
        manifest_path: string;
        tool: { mode: string };
        pruned: number;
        exported_at: string;
      };
      expect(data.path).toMatch(/\.dump$/);
      expect(["local", "docker"]).toContain(data.tool.mode);

      // dump 与 manifest 文件真实落盘
      const dumpStat = await fs.stat(path.join(PROJECT_ROOT, data.path));
      expect(dumpStat.size).toBeGreaterThan(0);
      await fs.stat(path.join(PROJECT_ROOT, data.manifest_path));

      const list = await api(server.baseUrl, "GET", "/api/volume/snapshots");
      expect(list.status).toBe(200);
      const rows = list.json as unknown as {
        id: string;
        path: string;
        kind: string;
        manifest: { database: string; table_count: number; market_bar_coverage: unknown };
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.path).toBe(data.path);
      expect(rows[0]!.kind).toBe("manual");
      expect(rows[0]!.manifest.database).toContain("stock_test");
      expect(rows[0]!.manifest.table_count).toBeGreaterThan(0);
    },
  );
});

if (dumpUnavailable !== null) {
  console.warn(`[volume-routes.test] 导出用例跳过：${dumpUnavailable}`);
}
