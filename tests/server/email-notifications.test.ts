// 独立邮件通知：设置校验与脱敏、任务结果入队、独立投递队列、重试与取消、记录查询。
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api, prepareTestDb, seedTestStrategy, startTestServer } from "./helpers.js";
import { executeJobRun } from "../../server/scheduler/runner.js";
import { queueManualJob } from "../../server/scheduler/repo.js";
import {
  deliverNextEmail,
  enqueueEmailForOutput,
  getEmailDelivery,
  getEmailNotificationSettings,
  listEmailDeliveries,
  queueTestEmail,
  retryEmailDelivery,
  updateEmailNotificationSettings,
  type EmailMessage,
} from "../../server/modules/notifications/email.js";

const prepared = await prepareTestDb();

const BASE_SETTINGS = {
  enabled: true,
  smtp_host: "smtp.qq.com",
  smtp_port: 465,
  smtp_secure: true,
  smtp_user: "stock@qq.com",
  smtp_password: "qq-auth-code",
  from_address: "stock@qq.com",
  recipients: ["me@example.com"],
  job_codes: ["weekly_trading_review", "cross_strategy_selection"],
};

function fakeSender(error?: { code?: string; responseCode?: number }) {
  const sent: EmailMessage[] = [];
  return {
    sent,
    send: async (message: EmailMessage) => {
      if (error) throw Object.assign(new Error("smtp failure"), error);
      sent.push(message);
    },
  };
}

describe.skipIf(!prepared)("独立邮件通知", () => {
  let pool: pg.Pool;
  const runIds: string[] = [];

  async function configure(overrides: Record<string, unknown> = {}) {
    return updateEmailNotificationSettings(pool, { ...BASE_SETTINGS, ...overrides });
  }

  async function createOutput(
    jobCode: string,
    targetDate: string,
    markdown = "# 报告\n\n## 结论摘要\n测试结论。",
    runStatus = "success",
  ): Promise<string> {
    const run = (await pool.query<{ id: string; job_id: string }>(
      `INSERT INTO job_run (job_id, target_date, trigger_kind, status, finished_at)
       SELECT id, $2::date, 'cron', $3, now() FROM job_definition WHERE code = $1
       RETURNING id::text, job_id::text`,
      [jobCode, targetDate, runStatus],
    )).rows[0]!;
    runIds.push(run.id);
    const output = (await pool.query<{ id: string }>(
      `INSERT INTO job_run_output (job_id, run_id, output_type, target_date, markdown, sha256, status, source)
       VALUES ($1, $2, $3, $4::date, $5, repeat('a', 64), 'generated', 'agent_flow')
       RETURNING id::text`,
      [run.job_id, run.id, jobCode, targetDate, markdown],
    )).rows[0]!;
    return output.id;
  }

  beforeAll(() => { pool = prepared!.pool; });
  beforeEach(async () => {
    await pool.query("DELETE FROM email_delivery");
    await pool.query("DELETE FROM daily_plan_evening_preview");
    await pool.query(
      `UPDATE email_notification_setting SET enabled = false, smtp_host = NULL, smtp_port = NULL,
         smtp_secure = true, smtp_user = NULL, smtp_password = NULL, from_address = NULL,
         recipients = NULL,
         job_codes = ARRAY['cross_strategy_selection', 'weekly_trading_review'], revision = 1,
         updated_at = now()`,
    );
  });
  afterAll(async () => {
    if (runIds.length) {
      await pool.query("DELETE FROM job_run_output WHERE run_id = ANY($1::bigint[])", [runIds]);
      await pool.query("DELETE FROM job_run WHERE id = ANY($1::bigint[])", [runIds]);
    }
    await pool.query(
      "DELETE FROM market_instrument WHERE code = ANY($1::text[])",
      [["600519.SH", "000858.SZ", "300750.SZ", "881101.TI"]],
    );
    await pool.end();
  });

  it("迁移初始化独立邮件设置：默认关闭、默认订阅两周任务、密码不回显", async () => {
    const settings = await getEmailNotificationSettings(pool);
    expect(settings).toMatchObject({
      enabled: false,
      smtp_password_configured: false,
      recipients: [],
      job_codes: ["cross_strategy_selection", "weekly_trading_review"],
    });
    expect(Object.hasOwn(settings!, "smtp_password")).toBe(false);
    expect(settings!.jobs.map((job) => job.code)).toEqual(
      expect.arrayContaining(["weekly_trading_review", "cross_strategy_selection"]),
    );
  });

  it("保存设置校验 SMTP 端口、TLS、收件人与任务范围", async () => {
    await expect(updateEmailNotificationSettings(pool, { enabled: true, smtp_host: "smtp.feishu.cn" }))
      .rejects.toThrow("完整的 SMTP");
    await expect(configure({ smtp_port: 25 })).rejects.toThrow("25");
    await expect(configure({ smtp_port: 2525, smtp_secure: false })).rejects.toThrow("465");
    await expect(configure({ smtp_port: 465, smtp_secure: false })).rejects.toThrow("465");
    await expect(configure({ smtp_port: 587, smtp_secure: true })).rejects.toThrow("587");
    await expect(configure({ smtp_host: "bad host" })).rejects.toThrow("SMTP 主机");
    await expect(configure({ recipients: ["not-an-email"] })).rejects.toThrow("收件人");
    await expect(configure({ recipients: ["a@example.com", "b@example.com", "c@example.com"] }))
      .resolves.toMatchObject({ recipients: ["a@example.com", "b@example.com", "c@example.com"] });
    await expect(configure({ recipients: ["ME@example.com", "me@example.com"] }))
      .resolves.toMatchObject({ recipients: ["ME@example.com"] });
    await expect(configure({ job_codes: ["missing_job"] })).rejects.toThrow("只能订阅现有 Agent 任务");
    await expect(configure({ unknown_field: 1 })).rejects.toThrow("未知字段");
  });

  it("凭据变化递增版本并取消旧待发邮件，密码只回显是否已配置", async () => {
    const saved = await configure();
    expect(saved).toMatchObject({ enabled: true, smtp_password_configured: true });
    const revision = saved.revision;
    expect(Object.hasOwn(saved, "smtp_password")).toBe(false);
    const outputId = await createOutput("weekly_trading_review", "2026-10-24");
    expect(await enqueueEmailForOutput(pool, outputId)).toBe(true);
    const changed = await configure({ smtp_password: "new-app-password" });
    expect(changed.revision).toBe(revision + 1);
    const delivery = (await listEmailDeliveries(pool)).items[0]!;
    expect(delivery.status).toBe("cancelled");
    expect(delivery.error).toContain("邮件配置已变更");
    const sender = fakeSender();
    expect(await deliverNextEmail(pool, sender.send)).toBe(false);
    expect(sender.sent).toHaveLength(0);
  });

  it("只有启用且订阅的任务结果才入队；partial 仅限复盘与精选", async () => {
    await configure({ enabled: false });
    const disabledOutput = await createOutput("weekly_trading_review", "2026-10-24");
    expect(await enqueueEmailForOutput(pool, disabledOutput)).toBe(false);

    await configure();
    expect(await enqueueEmailForOutput(pool, disabledOutput)).toBe(true);
    expect(await enqueueEmailForOutput(pool, disabledOutput)).toBe(false);

    const partial = await createOutput("weekly_trading_review", "2026-10-31", "# 部分报告", "partial");
    expect(await enqueueEmailForOutput(pool, partial)).toBe(true);
    const selectionPartial = await createOutput("cross_strategy_selection", "2026-10-23", "# 精选", "partial");
    expect(await enqueueEmailForOutput(pool, selectionPartial)).toBe(true);
    const unsubscribed = await createOutput("swing_signal_scan", "2026-10-23");
    expect(await enqueueEmailForOutput(pool, unsubscribed)).toBe(false);
    const failed = await createOutput("weekly_trading_review", "2026-11-07", "# 失败", "failed");
    expect(await enqueueEmailForOutput(pool, failed)).toBe(false);
    const notSubscribedPartial = await createOutput("swing_signal_scan", "2026-10-24", "# 部分", "partial");
    expect(await enqueueEmailForOutput(pool, notSubscribedPartial)).toBe(false);

    const rows = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM email_delivery");
    expect(rows.rows[0]!.count).toBe(3);
  });

  it("投递成功写入独立队列并发送完整报告与主题", async () => {
    await configure();
    const outputId = await createOutput("weekly_trading_review", "2026-10-24", "# 每周复盘\n\n## 结论摘要\n本周盈利。");
    expect(await enqueueEmailForOutput(pool, outputId)).toBe(true);
    const sender = fakeSender();
    expect(await deliverNextEmail(pool, sender.send)).toBe(true);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({
      host: "smtp.qq.com",
      port: 465,
      secure: true,
      from: "stock@qq.com",
      to: ["me@example.com"],
      subject: "Stock｜每周交易复盘｜2026-10-24",
    });
    expect(sender.sent[0]!.text).toContain("本周盈利");
    expect(sender.sent[0]!.text).toContain("本邮件由 Stock 策略演进系统自动发送");
    expect(sender.sent[0]!.text).toContain("目标日 2026-10-24");
    expect(sender.sent[0]!.html).toContain("<!DOCTYPE html>");
    expect(sender.sent[0]!.html).toContain("<h1 style=");
    expect(sender.sent[0]!.html).toContain("本周盈利");
    expect(sender.sent[0]!.html).not.toContain("# 每周复盘");
    expect(sender.sent[0]!.html).not.toContain("## 结论摘要");
    const delivery = (await listEmailDeliveries(pool)).items[0]!;
    expect(delivery).toMatchObject({ status: "sent", attempts: 1, job_code: "weekly_trading_review" });
    expect(delivery.sent_at).not.toBeNull();
  });

  it("正文为标的代码补全名称，Markdown 渲染为带样式的 HTML", async () => {
    await configure();
    await pool.query(
      `INSERT INTO market_instrument (code, name, kind) VALUES
        ('600519.SH','贵州茅台','stock'), ('000858.SZ','五粮液','stock'),
        ('300750.SZ','宁德时代','stock'), ('881101.TI','白酒一级行业','board')`,
    );
    const markdown = [
      "> AI 生成任务结果，已关联本次任务保存；不代表策略发布或交易执行。",
      "",
      "# 每周交易复盘",
      "",
      "| 标的 | 动作 |",
      "| --- | --- |",
      "| 600519.SH | 持有 |",
      "| 000858.SZ（五粮液） | 减仓 |",
      "",
      "- 600519.SH 贵州茅台：继续持有",
      "- 881101.TI 触发观察",
      "- 关注 300750 的量能",
      "",
      "普通数字 123456 不在本地档案，保持原文。",
    ].join("\n");
    const outputId = await createOutput("weekly_trading_review", "2026-10-24", markdown);
    await enqueueEmailForOutput(pool, outputId);
    const sender = fakeSender();
    expect(await deliverNextEmail(pool, sender.send)).toBe(true);
    const sent = sender.sent[0]!;
    // 代码补全名称；名称已相邻出现时不重复
    expect(sent.text).toContain("贵州茅台（600519.SH）");
    expect(sent.text).toContain("000858.SZ（五粮液）");
    expect(sent.text).toContain("600519.SH 贵州茅台：继续持有");
    expect(sent.text).toContain("白酒一级行业（881101.TI）");
    expect(sent.text).toContain("宁德时代（300750）");
    expect(sent.text).toContain("123456");
    expect(sent.text).not.toContain("贵州茅台（贵州茅台");
    // HTML 渲染标题、表格与列表，不保留原始 Markdown 标记
    expect(sent.html).toContain("<h1 style=");
    expect(sent.html).toContain("<table style=");
    expect(sent.html).toContain("<th style=");
    expect(sent.html).toContain("<li style=");
    expect(sent.html).toContain("贵州茅台（600519.SH）");
    expect(sent.html).toContain("<blockquote style=");
    expect(sent.html).not.toContain("| 600519.SH |");
    expect(sent.html).not.toContain("- 881101");
    expect(sent.html).not.toContain("# 每周交易复盘");
  });

  it("测试邮件在配置完整但未启用时也可投递，且不含任务内容", async () => {
    await configure({ enabled: false });
    const queued = await queueTestEmail(pool);
    expect(queued).toMatchObject({ kind: "test", status: "pending", output_id: null });
    const sender = fakeSender();
    expect(await deliverNextEmail(pool, sender.send)).toBe(true);
    expect(sender.sent[0]!.subject).toContain("邮件推送测试");
    expect(sender.sent[0]!.text).toContain("不含持仓或任务内容");
  });

  it("可重试错误保留待发并延迟重试，认证错误直接失败且错误脱敏", async () => {
    await configure();
    const outputId = await createOutput("weekly_trading_review", "2026-10-24");
    await enqueueEmailForOutput(pool, outputId);

    await deliverNextEmail(pool, fakeSender({ code: "ETIMEDOUT" }).send);
    let delivery = (await listEmailDeliveries(pool)).items[0]!;
    expect(delivery).toMatchObject({ status: "pending", attempts: 1, error: "邮件服务器连接超时或不可达" });

    await pool.query("UPDATE email_delivery SET next_attempt_at = now() - interval '1 second'");
    const retrySender = fakeSender();
    await deliverNextEmail(pool, retrySender.send);
    delivery = (await listEmailDeliveries(pool)).items[0]!;
    expect(delivery).toMatchObject({ status: "sent", attempts: 2, error: null });

    await pool.query("DELETE FROM email_delivery");
    const otherOutput = await createOutput("weekly_trading_review", "2026-10-31");
    await enqueueEmailForOutput(pool, otherOutput);
    await deliverNextEmail(pool, fakeSender({ code: "EAUTH" }).send);
    delivery = (await listEmailDeliveries(pool)).items[0]!;
    expect(delivery).toMatchObject({ status: "failed", attempts: 1, error: "邮件服务器认证失败，请检查账号与专用密码" });
    expect(JSON.stringify(delivery)).not.toContain("app-password");
  });

  it("超过一天、关闭开关、结果被更新版取代时取消待发邮件", async () => {
    await configure();
    const outputId = await createOutput("weekly_trading_review", "2026-10-24");
    await enqueueEmailForOutput(pool, outputId);
    await pool.query("UPDATE email_delivery SET created_at = now() - interval '2 days'");
    expect(await deliverNextEmail(pool, fakeSender().send)).toBe(false);
    expect((await listEmailDeliveries(pool)).items[0]).toMatchObject({ status: "cancelled" });

    await pool.query("DELETE FROM email_delivery");
    const secondOutput = await createOutput("weekly_trading_review", "2026-10-31");
    await enqueueEmailForOutput(pool, secondOutput);
    await configure({ enabled: false });
    expect(await deliverNextEmail(pool, fakeSender().send)).toBe(false);
    expect((await listEmailDeliveries(pool)).items[0]!.status).toBe("cancelled");

    await pool.query("DELETE FROM email_delivery");
    await configure();
    const oldOutput = await createOutput("weekly_trading_review", "2026-11-07");
    await enqueueEmailForOutput(pool, oldOutput);
    await createOutput("weekly_trading_review", "2026-11-07", "# 更新版报告");
    expect(await deliverNextEmail(pool, fakeSender().send)).toBe(false);
    expect((await listEmailDeliveries(pool)).items[0]!.error).toContain("结果已被更新");
  });

  it("失败记录可在一天内补发，记录列表与详情可读", async () => {
    await configure();
    const outputId = await createOutput("cross_strategy_selection", "2026-10-23", "# 精选报告\n\n## 结论摘要\n推荐甲。");
    await enqueueEmailForOutput(pool, outputId);
    await deliverNextEmail(pool, fakeSender({ code: "EENVELOPE" }).send);
    const failed = (await listEmailDeliveries(pool)).items[0]!;
    expect(failed.status).toBe("failed");

    const detail = await getEmailDelivery(pool, failed.id);
    expect(detail.content).toContain("推荐甲");

    const retried = await retryEmailDelivery(pool, failed.id);
    expect(retried).toMatchObject({ status: "pending", attempts: 0 });
    const sender = fakeSender();
    expect(await deliverNextEmail(pool, sender.send)).toBe(true);
    expect(sender.sent[0]!.subject).toBe("Stock｜盘后统一标的精选｜2026-10-23");

    const page = await listEmailDeliveries(pool, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBeNull();
  });

  it("精选邮件追加最新明日大盘预期", async () => {
    await configure();
    const outputId = await createOutput("cross_strategy_selection", "2026-10-23", "# 精选报告\n\n## 结论摘要\n推荐甲。");
    const runId = (await pool.query<{ run_id: string }>(
      "SELECT run_id::text FROM job_run_output WHERE id=$1", [outputId],
    )).rows[0]!.run_id;
    await pool.query(
      `INSERT INTO market_trading_day (trade_date, is_open, source)
       VALUES ('2026-10-26', true, 'test')
       ON CONFLICT (trade_date) DO UPDATE SET is_open = EXCLUDED.is_open`,
    );
    await pool.query(
      `INSERT INTO daily_plan_evening_preview
         (target_date, account_id, source_job_run_id, as_of, market_forecast, position_previews)
       VALUES ('2026-10-26', 1, $1, '2026-10-23', $2::jsonb, '[]'::jsonb)`,
      [runId, JSON.stringify({
        as_of: "2026-10-23",
        summary_md: "基准震荡，放量才转强",
        scenarios: [{ label: "基准", probability: 55, view: "缩量震荡", triggers: "量能不足", response: "只做T", invalidation: "跌破今日低点" }],
        key_levels: [],
      })],
    );
    await enqueueEmailForOutput(pool, outputId);
    const detail = (await listEmailDeliveries(pool)).items[0]!;
    const content = (await getEmailDelivery(pool, detail.id)).content;
    expect(content).toContain("## 明日预案");
    expect(content).toContain("基准震荡，放量才转强");
    expect(content).toContain("当前没有持仓预览");
  });

  it("HTTP 路由可保存/测试/查询投递且不泄露密码", async () => {
    const server = await startTestServer(pool);
    try {
      const initial = await api(server.baseUrl, "GET", "/api/notifications/email/settings");
      expect(initial.status).toBe(200);
      const initialData = initial.json as Record<string, unknown>;
      expect(initialData.smtp_password_configured).toBe(false);
      expect(JSON.stringify(initialData)).not.toContain("qq-auth-code");

      const saved = await api(server.baseUrl, "PATCH", "/api/notifications/email/settings", BASE_SETTINGS);
      expect(saved.status).toBe(200);
      expect((saved.json as Record<string, unknown>).smtp_password_configured).toBe(true);
      expect(JSON.stringify(saved.json)).not.toContain("qq-auth-code");

      const tested = await api(server.baseUrl, "POST", "/api/notifications/email/test", {});
      expect(tested.status).toBe(202);
      const queued = tested.json as { id: string; kind: string };
      expect(queued.kind).toBe("test");

      const listed = await api(server.baseUrl, "GET", "/api/notifications/email/deliveries?limit=5");
      expect(listed.status).toBe(200);
      const items = (listed.json as { items: Array<{ id: string }> }).items;
      expect(items.map((item) => item.id)).toContain(queued.id);

      const detail = await api(server.baseUrl, "GET", `/api/notifications/email/deliveries/${queued.id}`);
      expect(detail.status).toBe(200);
      expect((detail.json as { content: string }).content).toContain("连接验证消息");
      expect(JSON.stringify(detail.json)).not.toContain("qq-auth-code");

      const badLimit = await api(server.baseUrl, "GET", "/api/notifications/email/deliveries?limit=99");
      expect(badLimit.status).toBe(400);
      const badStatus = await api(server.baseUrl, "GET", "/api/notifications/email/deliveries?status=unknown");
      expect(badStatus.status).toBe(400);
      const retryPending = await api(server.baseUrl, "POST", `/api/notifications/email/deliveries/${queued.id}/retry`, {});
      expect(retryPending.status).toBe(409);
    } finally {
      await server.close();
    }
  });

  it("邮件入队失败只回滚到保存点，不影响任务结果保存", async () => {
    await seedTestStrategy(pool);
    await configure({ job_codes: ["weekly_trading_review"] });
    await pool.query("DROP TRIGGER IF EXISTS test_fail_email_insert ON email_delivery");
    await pool.query("DROP FUNCTION IF EXISTS test_fail_email_insert()");
    await pool.query(
      `CREATE FUNCTION test_fail_email_insert() RETURNS trigger AS $$
       BEGIN RAISE EXCEPTION 'forced email insert failure'; END $$ LANGUAGE plpgsql`,
    );
    await pool.query(
      "CREATE TRIGGER test_fail_email_insert BEFORE INSERT ON email_delivery FOR EACH ROW EXECUTE FUNCTION test_fail_email_insert()",
    );
    try {
      const run = await queueManualJob(pool, "weekly_trading_review", "2026-10-24");
      const deps = {
        pool,
        databaseUrl: prepared!.url,
        now: () => new Date("2026-10-24T02:00:00Z"),
        agentFlow: async () =>
          "> AI 生成任务结果，已关联本次任务保存；不代表策略发布或交易执行。\n\n"
          + "# 每周交易复盘\n\n## 结论摘要\n测试结论。",
      };
      const finished = await executeJobRun(deps, run.id);
      expect(finished).not.toBeNull();
      expect(["success", "partial"]).toContain(finished!.status);
      const output = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM job_run_output WHERE run_id = $1", [run.id],
      );
      expect(output.rows[0]!.count).toBe(1);
      const mails = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM email_delivery");
      expect(mails.rows[0]!.count).toBe(0);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS test_fail_email_insert ON email_delivery");
      await pool.query("DROP FUNCTION IF EXISTS test_fail_email_insert()");
    }
  });
});
