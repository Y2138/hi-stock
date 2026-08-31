// 数据卷与安全初始化包测试
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §九、§十二
// - volume：stock_test 导出 → 恢复到 stock_test_restore → 校验通过；篡改 manifest 后校验失败；
// - 无库或无 pg_dump/pg_restore（本机或 docker）时 skip 并打印原因（沿用一期模式）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../server/db/client.js";
import { runMigrations } from "../../server/db/migrate.js";
import { insertFetchRun, storeBars } from "../../server/datasource/service.js";
import {
  findPgTool,
  serverMajorVersion,
  exportVolume,
} from "../../server/volume/export.js";
import { manifestSha256, type VolumeManifest } from "../../server/volume/manifest.js";
import { restoreVolume } from "../../server/volume/restore.js";
import {
  exportPortableInitialization,
  readPortableManifest,
  restorePortableInitialization,
} from "../../server/volume/portable.js";
import { prepareTestDb, resetSchema, seedTestStrategy } from "./helpers.js";

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("可移植初始化包（白名单导出→空库恢复）", () => {
  let pool: pg.Pool;
  let outDir: string;
  let targetUrl: string;
  let adminUrl: string;
  const targetDb = `stock_test_portable_${process.pid}`;

  beforeAll(async () => {
    pool = createPool(prepared!.url);
    await resetSchema(pool);
    await runMigrations(pool);
    await seedTestStrategy(pool, "# 固定资产包测试策略");
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), "portable-volume-test-"));
    const target = new URL(prepared!.url);
    target.pathname = `/${targetDb}`;
    targetUrl = target.toString();
    const admin = new URL(prepared!.url);
    admin.pathname = "/postgres";
    adminUrl = admin.toString();
    await dropDatabase(adminUrl, targetDb);

    const instrument = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument (code, name, kind) VALUES ('999009.SZ', '初始化包样本', 'stock') RETURNING id::text",
    );
    const industry = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument (code, name, kind) VALUES ('881998.TI', '初始化包测试行业', 'board') RETURNING id::text",
    );
    await pool.query(
      "INSERT INTO market_board (instrument_id, board_type, source, active) VALUES ($1, 'industry', 'hithink', true)",
      [industry.rows[0]!.id],
    );
    await pool.query(
      "INSERT INTO market_board_membership (board_instrument_id, member_instrument_id, effective_from) VALUES ($1, $2, '2026-08-18')",
      [industry.rows[0]!.id, instrument.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO pool_membership
         (instrument_id, pool, role, grade, score, tags, stock_character, stage, evaluation_summary, effective_from)
       VALUES ($1, 'short', '观察', 'A', 5, '["板块：旧本地","初始化样本"]', '中波动', '观察', '初始化包恢复清理验证', '2026-08-18')`,
      [instrument.rows[0]!.id],
    );
    await storeBars(pool, instrument.rows[0]!.id, "day", [
      { date: "2026-08-18", open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
    ], "portable-test");
    await pool.query(
      "INSERT INTO portfolio_position (instrument_id, quantity, cost_price) VALUES ($1, 100, 9.8)",
      [instrument.rows[0]!.id],
    );
    await pool.query("UPDATE llm_provider SET api_key = 'sk-portable-must-never-export' WHERE provider_key = 'deepseek'");
    await pool.query("UPDATE system_setting SET hithink_api_key = 'hithink-portable-must-never-export' WHERE singleton = true");
    const session = await pool.query<{ id: string }>("INSERT INTO chat_session (title) VALUES ('敏感会话') RETURNING id::text");
    await pool.query(
      "INSERT INTO chat_message (session_id, seq, role, content) VALUES ($1, 1, 'user', $2)",
      [session.rows[0]!.id, JSON.stringify({ text: "不得导出" })],
    );
    await pool.query(
      `INSERT INTO backtest_run
         (name, kind, status, execution_status, progress, execution_origin, research_outline, hypothesis)
       VALUES ('初始化包历史回测', 'research', 'archived', 'success', 100, 'agent_workspace', '旧大纲', '旧假设')`,
    );
    await pool.query(
      `INSERT INTO backtest_run
         (name, kind, status, execution_status, progress, execution_origin,
          session_id, request_json, source_sha256, source_size_bytes, code_cleanup_status)
       VALUES ('初始化包回测', 'research', 'archived', 'success', 100, 'agent_workspace',
               $1, $2, repeat('b', 64), 40, 'deleted')`,
      [
        session.rows[0]!.id,
        JSON.stringify({
          hypothesis: "初始化包源码脱敏",
          source_code: "PORTABLE_BACKTEST_SOURCE_MUST_NOT_EXPORT",
        }),
      ],
    );
    await pool.query(
      `INSERT INTO backtest_run_comparison (run_id, compared_run_id, relation)
       SELECT current.id, prior.id, 'prior'
         FROM backtest_run current CROSS JOIN backtest_run prior
        WHERE current.name='初始化包回测' AND prior.name='初始化包历史回测'`,
    );

    const contentClient = await pool.connect();
    try {
      await contentClient.query("BEGIN");
      const document = await contentClient.query<{ id: string }>(
        `INSERT INTO content_document (code, title, content_type, status)
         VALUES ('portable_strategy', '初始化策略', 'strategy', 'published') RETURNING id::text`,
      );
      const revision = await contentClient.query<{ id: string }>(
        `INSERT INTO content_revision (document_id, revision_no, content, sha256, source)
         VALUES ($1, 1, '# 初始化策略', '9aa4823c3885e0f5bdbecd134ef95255f3d92194133755d221c66c0b60874fc0', 'user') RETURNING id::text`,
        [document.rows[0]!.id],
      );
      await contentClient.query("UPDATE content_document SET current_revision_id = $2 WHERE id = $1", [document.rows[0]!.id, revision.rows[0]!.id]);
      await contentClient.query("COMMIT");
    } catch (error) {
      await contentClient.query("ROLLBACK");
      throw error;
    } finally {
      contentClient.release();
    }
  });

  afterAll(async () => {
    await dropDatabase(adminUrl, targetDb);
    await fs.rm(outDir, { recursive: true, force: true });
    await pool.end();
  });

  it("固定资产包只含策略与定时任务，恢复后运行数据为空且逐表哈希一致", async () => {
    const exported = await exportPortableInitialization(pool, { outDir, now: new Date("2026-08-18T10:00:00+08:00") });
    const manifest = await readPortableManifest(exported.payloadPath);
    expect(manifest.version).toBe(4);
    expect(manifest.kind).toBe("portable_fixed_assets");
    expect(manifest.migration_max).toBe(56);
    expect(manifest.tables.strategy_document_revision).toBeGreaterThan(0);
    expect(manifest.tables.job_definition).toBeGreaterThan(0);
    expect(manifest.tables.market_bar).toBeUndefined();
    expect(manifest.tables.pool_membership).toBeUndefined();
    expect(manifest.tables.backtest_run).toBeUndefined();
    expect(manifest.tables.portfolio_position).toBeUndefined();
    expect(manifest.tables.daily_plan_auction_assessment).toBeUndefined();
    expect(manifest.strategy_hashes.length).toBe(manifest.tables.strategy_document_revision);

    const payload = gunzipSync(await fs.readFile(exported.payloadPath)).toString("utf8");
    expect(payload).not.toContain("sk-portable-must-never-export");
    expect(payload).not.toContain("hithink-portable-must-never-export");
    expect(payload).not.toContain("PORTABLE_BACKTEST_SOURCE_MUST_NOT_EXPORT");
    expect(payload).not.toContain('"created_at":{}');
    expect(payload).toMatch(/"created_at":"\d{4}-\d{2}-\d{2}T/);
    for (const forbidden of [
      "chat_session",
      "chat_message",
      "agent_confirmation",
      "agent_tool_audit",
      "agent_run_metric",
      "portfolio_position",
      "portfolio_position_change",
      "portfolio_realized_pnl_baseline",
      "portfolio_account_snapshot",
      "daily_plan_playbook",
      "daily_plan_auction_assessment",
      "pool_membership",
      "market_bar",
      "market_quote_sample",
      "market_indicator_value",
      "agent_memory_artifact",
      "backtest_run",
      "job_run",
    ]) {
      expect(payload).not.toContain(`\"table\":\"${forbidden}\"`);
    }

    const restored = await restorePortableInitialization({ payloadPath: exported.payloadPath, targetUrl });
    expect(restored.diffs).toEqual([]);
    const target = createPool(targetUrl);
    try {
      expect((await target.query("SELECT count(*)::int AS count FROM strategy_document_revision")).rows[0]!.count).toBe(manifest.tables.strategy_document_revision);
      expect((await target.query("SELECT count(*)::int AS count FROM job_definition")).rows[0]!.count).toBe(manifest.tables.job_definition);
      expect((await target.query("SELECT count(*)::int AS count FROM market_bar")).rows[0]!.count).toBe(0);
      expect((await target.query("SELECT count(*)::int AS count FROM portfolio_position")).rows[0]!.count).toBe(0);
      expect((await target.query("SELECT count(*)::int AS count FROM daily_plan_auction_assessment")).rows[0]!.count).toBe(0);
      expect((await target.query("SELECT to_regclass('strategy_paper_account')::text AS name")).rows[0]!.name).toBeNull();
      expect((await target.query("SELECT count(*)::int AS count FROM chat_session")).rows[0]!.count).toBe(0);
      expect((await target.query("SELECT count(*)::int AS count FROM pool_membership")).rows[0]!.count).toBe(0);
      expect((await target.query("SELECT count(*)::int AS count FROM backtest_run")).rows[0]!.count).toBe(0);
      expect((await target.query("SELECT api_key FROM llm_provider WHERE provider_key = 'deepseek'")).rows[0]!.api_key).toBeNull();
      expect((await target.query("SELECT hithink_api_key FROM system_setting WHERE singleton = true")).rows[0]!.hithink_api_key).toBeNull();
    } finally {
      await target.end();
    }
  });
});

// ---------- 数据卷 ----------

/** 探测 pg_dump/pg_restore 可用性（本机或 docker compose postgres 容器），不可用则 skip */
async function probePgTools(): Promise<string | null> {
  if (!prepared) return null;
  const major = await serverMajorVersion(prepared.pool);
  const dump = findPgTool("pg_dump", major);
  const restore = findPgTool("pg_restore", major);
  if (!dump || !restore) {
    return `缺少主版本 ${major} 的 pg_dump/pg_restore（本机与 docker 均不可用）`;
  }
  return null;
}

const toolBlockReason = prepared ? await probePgTools() : "测试库不可用";

async function dropDatabase(adminUrl: string, dbName: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName.replace(/"/g, "")}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

describe.skipIf(toolBlockReason !== null)("数据卷（导出→恢复→校验）", () => {
  let pool: pg.Pool;
  let outDir: string;
  let sourceUrl: string;
  let restoreUrl1: string;
  let restoreUrl2: string;
  let adminUrl: URL;

  beforeAll(async () => {
    pool = createPool(prepared!.url);
    await resetSchema(pool);
    await runMigrations(pool);
    // 造数：一个标的 + 两个 freq 的若干 bar + 一条 market_fetch_run
    const inst = await pool.query<{ id: string }>(
      `INSERT INTO market_instrument (code, name, kind) VALUES ('999002.SZ', '卷测试股份', 'stock')
       ON CONFLICT (code) DO NOTHING RETURNING id`,
    );
    const id = String(
      inst.rows[0]?.id ??
        (await pool.query<{ id: string }>("SELECT id FROM market_instrument WHERE code = '999002.SZ'"))
          .rows[0]!.id,
    );
    await storeBars(
      pool,
      id,
      "day",
      [
        { date: "2026-08-13", open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
        { date: "2026-08-14", open: 10.5, high: 12, low: 10, close: 11.5, volume: 200 },
      ],
      "fixture",
    );
    await storeBars(
      pool,
      id,
      "30m",
      [
        { date: "2026-08-14", time: "2026-08-14T10:00:00+08:00", open: 10, high: 11, low: 9, close: 10.5, volume: 50 },
      ],
      "fixture",
    );
    await insertFetchRun(pool, {
      channel: "fixture",
      scope: { op: "volume-test" },
      rowsWritten: 3,
    });

    sourceUrl = prepared!.url;
    const u1 = new URL(sourceUrl);
    adminUrl = new URL(sourceUrl);
    adminUrl.pathname = "/postgres";
    u1.pathname = "/stock_test_restore";
    restoreUrl1 = u1.toString();
    const u2 = new URL(sourceUrl);
    u2.pathname = "/stock_test_restore2";
    restoreUrl2 = u2.toString();
    await dropDatabase(adminUrl.toString(), "stock_test_restore");
    await dropDatabase(adminUrl.toString(), "stock_test_restore2");
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), "volume-test-"));
  });

  afterAll(async () => {
    await dropDatabase(adminUrl.toString(), "stock_test_restore");
    await dropDatabase(adminUrl.toString(), "stock_test_restore2");
    await fs.rm(outDir, { recursive: true, force: true });
    await pool.end();
  });

  it("导出 → 恢复到临时库 → manifest 校验通过，行数一致", async () => {
    const exported = await exportVolume(pool, sourceUrl, { outDir });
    expect(exported.manifest.tables["market_bar"]).toBe(3);
    expect(exported.manifest.market_bar_coverage["day"]).toMatchObject({
      count: 2,
      min: "2026-08-13",
      max: "2026-08-14",
    });

    const restored = await restoreVolume({ dumpPath: exported.dumpPath, targetUrl: restoreUrl1 });
    expect(restored.diffs).toEqual([]);

    const check = new pg.Pool({ connectionString: restoreUrl1, max: 2 });
    try {
      const r = await check.query<{ n: number }>("SELECT count(*)::int AS n FROM market_bar");
      expect(r.rows[0]!.n).toBe(3);
      const vs = await check.query<{ n: number; kind: string }>(
        "SELECT count(*)::int AS n FROM volume_snapshot",
      );
      // dump 先于 volume_snapshot 登记（快照内 0 条），恢复后写入 1 条恢复记录
      expect(vs.rows[0]!.n).toBe(1);
      const ma = await check.query<{ ma5: string | null }>(
        "SELECT ma5::text FROM market_bar LIMIT 1",
      );
      expect(ma.rows.length).toBe(1);
    } finally {
      await check.end();
    }
  });

  it("篡改 manifest（改行数并重算 sha）→ 恢复后校验失败并列出差异", async () => {
    const exported = await exportVolume(pool, sourceUrl, { outDir });
    const manifestPath = exported.manifestPath;
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as VolumeManifest;
    const { sha256: _drop, ...base } = manifest;
    base.tables["market_bar"] = (base.tables["market_bar"] ?? 0) + 1;
    const tampered: VolumeManifest = { ...base, sha256: manifestSha256(base) };
    await fs.writeFile(manifestPath, JSON.stringify(tampered, null, 2) + "\n", "utf8");

    await expect(
      restoreVolume({ dumpPath: exported.dumpPath, targetUrl: restoreUrl2 }),
    ).rejects.toThrow(/恢复后校验失败[\s\S]*market_bar 行数不一致/);
  }, 15_000);

  it("篡改 manifest（不重算 sha）→ 恢复前即拒绝", async () => {
    const exported = await exportVolume(pool, sourceUrl, { outDir });
    const manifest = JSON.parse(await fs.readFile(exported.manifestPath, "utf8")) as VolumeManifest;
    manifest.tables["market_bar"] = (manifest.tables["market_bar"] ?? 0) + 1;
    await fs.writeFile(
      exported.manifestPath,
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );
    await expect(
      restoreVolume({ dumpPath: exported.dumpPath, targetUrl: restoreUrl2 }),
    ).rejects.toThrow("manifest sha256 校验失败");
  });
});

if (toolBlockReason !== null) {
  console.warn(`[migration-volume.test] 数据卷用例跳过：${toolBlockReason}`);
}
