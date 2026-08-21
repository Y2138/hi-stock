// 领域写工具确认制、YOLO、事务审计、写锁与状态冲突测试。
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../server/db/migrate.js";
import {
  approveConfirmation,
  expireStaleConfirmations,
  getConfirmation,
  rejectConfirmation,
} from "../../server/agent/confirmations.js";
import { subscribeSessionEvents, type SessionEventFrame } from "../../server/agent/events.js";
import { createSession } from "../../server/agent/repo.js";
import { buildChatTools } from "../../server/agent/tools.js";
import { prepareTestDb, resetSchema, seedTestStrategy } from "./helpers.js";

const prepared = await prepareTestDb();

describe.skipIf(!prepared)("领域写工具确认与执行（stock_test 真实库）", () => {
  let pool: pg.Pool;
  let sessionId: string;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
    await seedTestStrategy(pool);
    await pool.query(
      "INSERT INTO market_instrument (code, name, kind) VALUES ('990001.SZ', '确认测试股份', 'stock')",
    );
    const session = await createSession(pool, "领域确认测试");
    sessionId = session.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  function findTool(name: string) {
    const tool = buildChatTools({ pool, sessionId }).find((item) => item.name === name);
    if (!tool) throw new Error(`工具不存在：${name}`);
    return tool;
  }

  it("portfolio_write 默认只生成 pending，批准后在同一事务维护事件流、当前态和审计", async () => {
    const result = await findTool("portfolio_write").execute("tc-portfolio", {
      reason: "登记用户确认的买入",
      code: "990001.SZ",
      kind: "buy",
      quantity: 10,
      price: 12.5,
      change_date: "2026-08-17",
      decision_origin: "strategy_signal",
      execution_compliance: "matched",
    });
    const details = result.details as { confirmation_id: string; tool_name: string };
    expect(details.tool_name).toBe("portfolio_write");
    const pending = await getConfirmation(pool, details.confirmation_id);
    expect(pending?.status).toBe("pending");
    expect(pending?.expected_state_hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await pool.query("SELECT count(*)::int AS n FROM portfolio_position_change")).rows[0]!.n).toBe(0);

    const frames: SessionEventFrame[] = [];
    const unsubscribe = subscribeSessionEvents(sessionId, (frame) => frames.push(frame));
    const approved = await approveConfirmation(pool, details.confirmation_id);
    unsubscribe();
    expect(approved.status).toBe("approved");
    expect((approved.result as { position: { quantity: number } }).position.quantity).toBe(10);
    const position = await pool.query(
      "SELECT quantity::float, cost_price::float FROM portfolio_position",
    );
    expect(position.rows[0]).toMatchObject({ quantity: 10, cost_price: 12.5 });
    const audit = await pool.query(
      "SELECT status FROM agent_tool_audit WHERE tool_name = 'portfolio_write' ORDER BY id DESC LIMIT 1",
    );
    expect(audit.rows[0]!.status).toBe("ok");
    expect(frames.some((frame) => frame.type === "confirmation_result")).toBe(true);
    expect(frames.find((frame) => frame.type === "ui_refresh")?.data).toMatchObject({
      targets: ["positions", "dashboard", "status"],
    });
  });

  it("portfolio_write 可确认写入资金摘要并推导证券市值", async () => {
    const result = await findTool("portfolio_write").execute("tc-account", {
      action: "upsert_account_snapshot",
      reason: "用户明确更新资金摘要",
      snap_date: "2026-08-18",
      total_asset: 151064.17,
      cash: 38190.17,
      closed_pnl: -27221.09,
      precision: "exact",
    });
    const details = result.details as {
      confirmation_id: string;
      preview: { target: { market_value: number; market_value_derived: boolean } };
    };
    expect(details.preview.target).toMatchObject({
      market_value: 112874,
      market_value_derived: true,
    });
    expect((await getConfirmation(pool, details.confirmation_id))?.status).toBe("pending");
    expect((await pool.query(
      "SELECT count(*)::int AS n FROM portfolio_account_snapshot WHERE snap_date = '2026-08-18'",
    )).rows[0]!.n).toBe(0);

    const approved = await approveConfirmation(pool, details.confirmation_id);
    expect(approved.status).toBe("approved");
    expect(approved.result).toMatchObject({
      total_asset: 151064.17,
      market_value: 112874,
      market_value_derived: true,
      cash: 38190.17,
      closed_pnl: -27221.09,
      source: "chat",
    });
    const snapshot = await pool.query(
      `SELECT total_asset::float, market_value::float, cash::float, closed_pnl::float, source
         FROM portfolio_account_snapshot WHERE snap_date = '2026-08-18'`,
    );
    expect(snapshot.rows[0]).toMatchObject({
      total_asset: 151064.17,
      market_value: 112874,
      cash: 38190.17,
      closed_pnl: -27221.09,
      source: "chat",
    });
  });

  it("资金摘要提案后的同日快照变化会阻止旧提案覆盖", async () => {
    const result = await findTool("portfolio_write").execute("tc-account-stale", {
      action: "upsert_account_snapshot",
      reason: "更新同日清仓收益",
      snap_date: "2026-08-18",
      total_asset: 151064.17,
      cash: 38190.17,
      closed_pnl: -28000,
    });
    const id = (result.details as { confirmation_id: string }).confirmation_id;
    await pool.query(
      "UPDATE portfolio_account_snapshot SET closed_pnl = -27000 WHERE snap_date = '2026-08-18'",
    );
    await expect(approveConfirmation(pool, id)).rejects.toMatchObject({ httpStatus: 409 });
    expect((await getConfirmation(pool, id))?.status).toBe("pending");
    expect((await pool.query(
      "SELECT closed_pnl::float FROM portfolio_account_snapshot WHERE snap_date = '2026-08-18'",
    )).rows[0]!.closed_pnl).toBe(-27000);
  });

  it("提案后领域目标变化时拒绝批准且保持 pending", async () => {
    const result = await findTool("portfolio_write").execute("tc-stale", {
      reason: "调整当前数量",
      code: "990001.SZ",
      kind: "adjust",
      quantity: 9,
      change_date: "2026-08-17",
      decision_origin: "fact_correction",
      execution_compliance: "not_applicable",
    });
    const id = (result.details as { confirmation_id: string }).confirmation_id;
    await pool.query(
      "UPDATE portfolio_position SET quantity = 8, updated_at = now() WHERE instrument_id = (SELECT id FROM market_instrument WHERE code = '990001.SZ')",
    );
    await expect(approveConfirmation(pool, id)).rejects.toMatchObject({ httpStatus: 409 });
    expect((await getConfirmation(pool, id))?.status).toBe("pending");
    expect((await pool.query("SELECT quantity::float FROM portfolio_position")).rows[0]!.quantity).toBe(8);
  });

  it("YOLO 模式通过记忆 service 直接执行且不创建 confirmation", async () => {
    await pool.query("UPDATE agent_setting SET yolo_mode = true WHERE singleton = true");
    try {
      const before = await pool.query("SELECT count(*)::int AS n FROM agent_confirmation");
      const result = await findTool("memory_write").execute("tc-yolo", {
        reason: "保存已验证的测试方法",
        action: "create",
        title: "YOLO 测试方法",
        category: "research_method",
        summary: "用于验证 YOLO 记忆写入",
        content: "步骤一：生成固定输入。步骤二：核对确定性结果。",
        tags: ["测试"],
        scope: "自动化测试",
        evidence: "本永久测试验证领域 service 与审计",
        last_verified_at: "2026-08-19T08:00:00Z",
      });
      expect(result.details).toMatchObject({ auto_approved: true, yolo_mode: true });
      const memoryId = (result.details as { result: { id: string } }).result.id;
      const after = await pool.query("SELECT count(*)::int AS n FROM agent_confirmation");
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
      expect((await pool.query("SELECT count(*)::int AS n FROM agent_memory_artifact")).rows[0]!.n).toBe(1);
      await pool.query(
        "UPDATE agent_memory_artifact SET updated_at = '2026-08-20T07:22:56.044952Z' WHERE id = $1",
        [memoryId],
      );
      const updated = await findTool("memory_write").execute("tc-yolo-update", {
        reason: "验证毫秒基线兼容数据库微秒",
        action: "update",
        memory_id: memoryId,
        base_updated_at: "2026-08-20T07:22:56.044Z",
        summary: "已验证 Agent 记忆更新时间戳精度兼容",
      });
      expect(updated.details).toMatchObject({
        result: { summary: "已验证 Agent 记忆更新时间戳精度兼容" },
      });
      expect((updated.details as { result: { updated_at: string } }).result.updated_at)
        .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      await expect(findTool("memory_write").execute("tc-yolo-stale", {
        reason: "验证真实过期基线仍被拒绝",
        action: "update",
        memory_id: memoryId,
        base_updated_at: "2026-08-20T07:22:56.044Z",
        summary: "不得覆盖新版本",
      })).rejects.toMatchObject({ httpStatus: 409 });
    } finally {
      await pool.query("UPDATE agent_setting SET yolo_mode = false WHERE singleton = true");
    }
  });

  it("pool_write、job_write 均通过领域 service 执行", async () => {
    const board = await pool.query<{ id: string }>(
      "INSERT INTO market_instrument (code,name,kind) VALUES ('881999.TI','确认测试行业','board') RETURNING id::text",
    );
    await pool.query("INSERT INTO market_board (instrument_id,board_type,active) VALUES ($1,'industry',true)", [board.rows[0]!.id]);
    await pool.query(
      `INSERT INTO market_board_membership (board_instrument_id,member_instrument_id,effective_from)
       SELECT $1,id,'2026-08-17' FROM market_instrument WHERE code='990001.SZ'`,
      [board.rows[0]!.id],
    );
    const poolProposal = await findTool("pool_write").execute("tc-pool", {
      reason: "登记标的池角色",
      action: "add",
      code: "990001.SZ",
      pool: "short",
      role: "观察",
      grade: "A",
      score: 5,
      tags: ["确认测试"],
      stock_character: "中波动",
      stage: "观察",
      evaluation_summary: "已完成确认制永久测试所需评估",
      effective_from: "2026-08-17",
    });
    await approveConfirmation(pool, (poolProposal.details as { confirmation_id: string }).confirmation_id);
    expect((await pool.query("SELECT role FROM pool_membership WHERE effective_to IS NULL")).rows[0]!.role).toBe("观察");

    const promptProposal = await findTool("job_write").execute("tc-prompt", {
      reason: "创建测试作业提示词",
      action: "create_prompt",
      code: "confirmation_prompt",
      name: "确认测试提示词",
      content: "# 流程",
    });
    await approveConfirmation(pool, (promptProposal.details as { confirmation_id: string }).confirmation_id);
    expect((await pool.query("SELECT name FROM job_prompt WHERE code = 'confirmation_prompt'")).rows[0]!.name).toBe("确认测试提示词");

    await pool.query(
      "UPDATE job_definition SET updated_at = '2026-08-20T07:22:56.044952Z' WHERE code = 'daily_market_structure'",
    );
    const jobProposal = await findTool("job_write").execute("tc-job-update", {
      reason: "验证 Agent 可调整市场结构同步时间",
      action: "update_job",
      code: "daily_market_structure",
      base_updated_at: "2026-08-20T07:22:56.044+00:00",
      cron: "10 17 * * 1-5",
      config: { pipeline: "daily_market_structure", export_volume: false },
    });
    await approveConfirmation(pool, (jobProposal.details as { confirmation_id: string }).confirmation_id);
    expect((await pool.query(
      "SELECT cron, config FROM job_definition WHERE code = 'daily_market_structure'",
    )).rows[0]).toEqual({
      cron: "10 17 * * 1-5",
      config: { pipeline: "daily_market_structure", export_volume: false },
    });
    await pool.query(
      "UPDATE job_definition SET updated_at = '2026-08-20T07:22:56.044953Z' WHERE code = 'daily_market_structure'",
    );
    await expect(findTool("job_write").execute("tc-job-microsecond-stale", {
      reason: "验证同一毫秒内真实版本变化仍被拒绝",
      action: "update_job",
      code: "daily_market_structure",
      base_updated_at: "2026-08-20T07:22:56.044952Z",
      cron: "40 17 * * 1-5",
    })).rejects.toThrow("基线已变化");
  });

  it("领域 service 中途失败时业务写入和审计一起回滚，提案保持 pending", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM portfolio_position_change");
    const proposal = await findTool("portfolio_write").execute("tc-rollback", {
      reason: "超卖必须整笔回滚",
      code: "990001.SZ",
      kind: "sell",
      quantity: 999,
      price: 1,
      change_date: "2026-08-17",
      decision_origin: "strategy_signal",
      execution_compliance: "matched",
    });
    const id = (proposal.details as { confirmation_id: string }).confirmation_id;
    await expect(approveConfirmation(pool, id)).rejects.toThrow("超过当前持仓");
    expect((await getConfirmation(pool, id))?.status).toBe("pending");
    const after = await pool.query("SELECT count(*)::int AS n FROM portfolio_position_change");
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("同一领域提案并发批准至多执行一次", async () => {
    const proposal = await findTool("job_write").execute("tc-concurrent", {
      reason: "并发批准保护",
      action: "create_prompt",
      code: "concurrent_prompt",
      name: "并发测试提示词",
      content: "# 并发测试",
    });
    const id = (proposal.details as { confirmation_id: string }).confirmation_id;
    const settled = await Promise.allSettled([
      approveConfirmation(pool, id),
      approveConfirmation(pool, id),
    ]);
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect((await getConfirmation(pool, id))?.status).toBe("approved");
    expect((await pool.query("SELECT count(*)::int AS n FROM job_prompt WHERE code = 'concurrent_prompt'")).rows[0]!.n).toBe(1);
  });

  it("reject 和 expired 均不执行领域写入", async () => {
    const proposal = await findTool("job_write").execute("tc-reject", {
      reason: "创建提示词但随后拒绝",
      action: "create_prompt",
      code: "rejected_prompt",
      name: "拒绝测试提示词",
      content: "# 不应写入",
    });
    const id = (proposal.details as { confirmation_id: string }).confirmation_id;
    expect((await rejectConfirmation(pool, id)).status).toBe("rejected");
    expect((await pool.query("SELECT count(*)::int AS n FROM job_prompt WHERE code='rejected_prompt'")).rows[0]!.n).toBe(0);

    const expiring = await findTool("job_write").execute("tc-expire", {
      reason: "过期提案",
      action: "create_prompt",
      code: "expired_prompt",
      name: "过期测试提示词",
      content: "# 不应写入",
    });
    const expiringId = (expiring.details as { confirmation_id: string }).confirmation_id;
    await pool.query(
      "UPDATE agent_confirmation SET created_at = now() - interval '25 hours' WHERE id = $1",
      [expiringId],
    );
    expect(await expireStaleConfirmations(pool)).toBeGreaterThan(0);
    expect((await getConfirmation(pool, expiringId))?.status).toBe("expired");
    await expect(approveConfirmation(pool, expiringId)).rejects.toMatchObject({ httpStatus: 409 });
  });
});
