// tests/server 共享辅助：测试库准备、schema 重置、临时 HTTP 服务
// 测试库取 TEST_DATABASE_URL（缺省由 DATABASE_URL 加 _test 后缀派生）；无库时各测试文件 skip。
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { resolveTestDatabaseUrl } from "../../server/config.js";
import { createPool } from "../../server/db/client.js";
import { runMigrations } from "../../server/db/migrate.js";
import { createApiServer } from "../../server/http/router.js";

/** 确保测试库存在（连接维护库 postgres 按需 CREATE DATABASE） */
export async function ensureTestDatabase(testUrl: string): Promise<void> {
  const url = new URL(testUrl);
  const dbName = url.pathname.replace(/^\//, "");
  if (!dbName) throw new Error("测试库连接串缺少库名");
  const adminUrl = new URL(testUrl);
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

/**
 * 探测测试库可用性：返回 { url, pool } 或 null（并打印原因）。
 * 成功时已确保库存在、schema 已清空并完成迁移。
 */
export async function prepareTestDb(): Promise<{ url: string; pool: pg.Pool } | null> {
  const url = resolveTestDatabaseUrl();
  if (!url) {
    console.warn("[tests/server] 跳过：未配置 DATABASE_URL / TEST_DATABASE_URL");
    return null;
  }
  try {
    await ensureTestDatabase(url);
    const pool = createPool(url);
    await pool.query("SELECT 1");
    await resetSchema(pool);
    await runMigrations(pool);
    return { url, pool };
  } catch (err) {
    console.warn(`[tests/server] 跳过：测试库不可用（${(err as Error).message}）`);
    return null;
  }
}

/** 清空 public schema（各测试文件用例间互不影响） */
export async function resetSchema(pool: pg.Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

/** 空库迁移不会伪造业务策略；需要执行 Agent Flow 的测试显式建立一份最小当前策略。 */
export async function seedTestStrategy(pool: pg.Pool, content = "# 测试当前策略"): Promise<void> {
  const revisionHash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const document = await client.query<{ id: string }>(
      `INSERT INTO strategy_document (code, title, role, injection_order)
       VALUES ('test_strategy', '测试当前策略', 'portfolio', 10)
       RETURNING id::text`,
    );
    const revision = await client.query<{ id: string }>(
      `INSERT INTO strategy_document_revision
         (document_id, revision_no, content, sha256, source)
       VALUES ($1, 1, $2, $3, 'migration') RETURNING id::text`,
      [document.rows[0]!.id, content, revisionHash],
    );
    await client.query(
      "UPDATE strategy_document SET current_revision_id = $2 WHERE id = $1",
      [document.rows[0]!.id, revision.rows[0]!.id],
    );
    // 清单哈希：与 repo.calculateStrategyHash 同公式（code:revision_sha256 按注入序），
    // 覆盖迁移产生的其他文档（如 0051 的打板策略）。
    const manifest = await client.query<{ code: string; sha256: string }>(
      `SELECT d.code, r.sha256
         FROM strategy_document d
         JOIN strategy_document_revision r ON r.id = d.current_revision_id
        WHERE d.current_revision_id IS NOT NULL
        ORDER BY d.injection_order, d.id`,
    );
    const stateHash = crypto.createHash("sha256")
      .update(manifest.rows.map((row) => `${row.code}:${row.sha256}`).join("\n"), "utf8")
      .digest("hex");
    await client.query(
      "INSERT INTO strategy_state (singleton, change_seq, current_hash) VALUES (1, 0, $1)",
      [stateHash],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/** 起一台绑定 127.0.0.1 随机端口的临时服务 */
export async function startTestServer(pool: pg.Pool): Promise<TestServer> {
  const server: http.Server = createApiServer({ pool });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 测试内 JSON 请求小帮手 */
export async function api(
  baseUrl: string,
  method: string,
  pathName: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
