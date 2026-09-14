import crypto from "node:crypto";
import { AGENT_NOTIFICATION_SUMMARY_MAX_CHARS, DAILY_PLAN_NOTIFICATION_MAX_CHARS, deliverNextNotification, enqueueJobConclusion, listNotifications as listNotificationPage, getNotification, extractConclusion, previewJobConclusion, queueTestNotification, retryNotification, sendFeishu, updateNotificationSettings, validateWebhook } from "../../server/modules/notifications/service.js";
// M3 作业系统：cron 去重/missed、Runner/重试/锁、API 与安全配置回归。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type pg from "pg";
import { setAiRuntimeForTests } from "../../server/agent/ai/runtime.js";
import * as hithinkDatasets from "../../server/datasource/hithink-datasets.js";
import { createJobCompletionGate } from "../../server/agent/job-workflow.js";
import { buildChatTools } from "../../server/agent/tools.js";
import { acquireAgentMutationLock } from "../../server/agent/mutation-lock.js";
import { acquireMarketMutationLock } from "../../server/datasource/mutation-lock.js";
import { controlAgentRun, getActiveAgentRun } from "../../server/agent/run-control.js";
import { updateSessionStatus } from "../../server/agent/repo.js";
import { runMigrations } from "../../server/db/migrate.js";
import {
  createJobDefinition,
  insertScheduledJobRun,
  listJobDefinitions,
  listJobRuns,
  queueManualJob,
  updateJobDefinition,
} from "../../server/scheduler/repo.js";
import { executeJobRun, resolveDailyUpdateScope } from "../../server/scheduler/runner.js";
import { JobScheduler } from "../../server/scheduler/service.js";
import { cronOccurrences, dailyMarketGate, shanghaiDate } from "../../server/scheduler/time.js";
import { api, prepareTestDb, resetSchema, seedTestStrategy, startTestServer, type TestServer } from "./helpers.js";

async function listNotifications(pool: pg.Pool) {
  return Promise.all((await listNotificationPage(pool)).items.map((item) => getNotification(pool, item.id)));
}

const prepared = await prepareTestDb();

function dailyReadCalls() {
  return [
    fauxToolCall("strategy_document_query", { codes: ["test_strategy", "limit_up_board"] }),
    fauxToolCall("daily_plan_context_query", { date: "2026-08-17" }),
    fauxToolCall("swing_signal_query", { date: "2026-08-17" }),
    fauxToolCall("limit_up_signal_query", { date: "2026-08-17" }),
  ];
}

function dailyWriteResponse() {
  return fauxAssistantMessage([fauxToolCall("pool_attention_write", { reason: "完整扫描后无新增候选", items: [] })], { stopReason: "toolUse" });
}

it("任务完成门禁只接受本次正确日期的工具结果，并按真实持仓要求结构化写入", () => {
  const gate = createJobCompletionGate("daily_plan_flow", "2026-08-17");
  function observed(name: string, args: Record<string, unknown>, details: unknown, isError = false) {
    gate.observe({ type: "tool_start", data: { toolCallId: name, name, args } });
    gate.observe({ type: "tool_end", data: { toolCallId: name, name, isError, result: { details } } });
  }
  observed("strategy_document_query", { codes: ["test_strategy"] }, {});
  observed("daily_plan_context_query", { date: "2026-08-16" }, { positions: { position_count: 1 } });
  observed("swing_signal_query", { date: "2026-08-17" }, {});
  observed("limit_up_signal_query", { date: "2026-08-17" }, { signals: [] });
  observed("pool_attention_write", { items: [] }, {}, true);
  expect(gate.missing()).toEqual(["daily_plan_context_query", "pool_attention_write"]);
  observed("daily_plan_context_query", { date: "2026-08-17" }, {
    positions: { position_count: 1, items: [{ code: "600000.SH" }] },
  });
  observed("pool_attention_write", { items: [] }, {});
  expect(gate.missing()).toEqual(["daily_plan_write"]);
  observed("daily_plan_write", { items: [] }, {});
  expect(gate.missing()[0]).toContain("必须完整覆盖");
  observed("daily_plan_write", { items: [{ code: "600000.SH", item_kind: "position_action" }] }, {});
  expect(gate.missing()).toEqual([]);
  expect(createJobCompletionGate("daily_plan_flow", "2026-08-17").missing()).toContain("pool_attention_write");
  expect(createJobCompletionGate("constructor", "2026-08-17").missing()).toEqual([]);

  const closed = createJobCompletionGate("auction_opportunity_assessment", "2026-08-16");
  closed.observe({ type: "tool_start", data: { toolCallId: "closed", name: "auction_context_query", args: { date: "2026-08-16" } } });
  closed.observe({ type: "tool_end", data: { toolCallId: "closed", name: "auction_context_query", isError: false,
    result: { details: { market_day: { should_run: false } } } } });
  expect(closed.missing()).toEqual([]);

  const weekly = createJobCompletionGate("weekly_review", "2026-08-17");
  function poolResult(args: Record<string, unknown>, pools: unknown[]) {
    weekly.observe({ type: "tool_start", data: { toolCallId: "pool", name: "pool_context_query", args } });
    weekly.observe({ type: "tool_end", data: { toolCallId: "pool", name: "pool_context_query", isError: false,
      result: { details: { pools } } } });
  }
  poolResult({ codes: ["600000.SH"] }, [{ pool: "short", member_count: 1 }]);
  expect(weekly.missing().some((name) => name.includes("完整摘要"))).toBe(true);
  poolResult({}, [{ pool: "short", member_count: 1 }, { pool: "long", member_count: 1 }]);
  poolResult({ codes: ["600000.SH"] }, [{ pool: "short", member_count: 1 }]);
  expect(weekly.missing().some((name) => name.includes("完整摘要"))).toBe(false);
  expect(weekly.missing()).toContain("analysis_run");

  const nightly = createJobCompletionGate("nightly_sector_opportunity_scan", "2026-08-17");
  let nightlyCall = 0;
  function nightlyObserved(name: string, args: Record<string, unknown>, details: unknown, isError = false) {
    const toolCallId = `nightly-${nightlyCall++}`;
    nightly.observe({ type: "tool_start", data: { toolCallId, name, args } });
    nightly.observe({ type: "tool_end", data: { toolCallId, name, isError, result: { details } } });
  }
  for (const name of [
    "strategy_document_query", "board_query", "market_snapshot_query", "indicator_query",
    "strategy_screen_query", "stock_research_query",
  ]) nightlyObserved(name, {}, {});
  nightlyObserved("analysis_run", {
    requests: [{ analysis_type: "sector_temperature", as_of: "2026-08-17", codes: ["881001.TI"] }],
  }, { items: [{ analysis_type: "sector_temperature", status: "success" }] });
  expect(nightly.missing().some((name) => name.includes("完整 881"))).toBe(true);
  nightlyObserved("analysis_run", {
    requests: [{ analysis_type: "sector_temperature", as_of: "2026-08-16" }],
  }, { items: [{ analysis_type: "sector_temperature", status: "partial" }] });
  expect(nightly.missing().some((name) => name.includes("完整 881"))).toBe(true);
  nightlyObserved("analysis_run", {
    requests: [{ analysis_type: "sector_temperature", as_of: "2026-08-17" }],
  }, { items: [{ analysis_type: "sector_temperature", status: "partial" }] });
  expect(nightly.missing()).toEqual([]);
});


function dailySummary(gaps: unknown[] = []) {
  return {
    date: "2026-08-17",
    snapshotRows: 12,
    refetched: [],
    futuresRows: 2,
    minute30Rows: 4,
    gaps,
    fetchRunIds: ["1"],
  };
}

// 以下机器人地址/密钥均为不可用测试占位值；网络请求全部注入模拟函数。
const testWebhook = "https://open.feishu.cn/open-apis/bot/v2/hook/notification-test-placeholder";
const testSecret = "notification-test-secret-not-a-credential";

it("飞书仅请求官方地址，签名采用秒时间戳，业务失败与网络错误不泄漏凭据", async () => {
  for (const url of ["http://127.0.0.1/hook", testWebhook + "?token=secret", testWebhook + "/extra", "https://open.feishu.cn.evil.test/open-apis/bot/v2/hook/placeholder"]) {
    expect(() => validateWebhook(url)).toThrow("官方");
  }
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ code: 0 }));
  await sendFeishu(testWebhook, testSecret, "测试正文", fetcher);
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url).toBe(testWebhook);
  expect(options?.redirect).toBe("error");
  const body = JSON.parse(options!.body as string);
  expect(body.msg_type).toBe("text");
  expect(body.content).toEqual({ text: "测试正文" });
  expect(Math.abs(Number(body.timestamp) - Date.now()/1000)).toBeLessThan(2);
  expect(body.sign).toBe(crypto.createHmac("sha256", `${body.timestamp}\n${testSecret}`).update("").digest("base64"));
  fetcher.mockResolvedValue(Response.json({ code: 19021, msg: testWebhook + testSecret }));
  await expect(sendFeishu(testWebhook, testSecret, "测试", fetcher)).rejects.toThrow("19021");
  fetcher.mockResolvedValue(Response.json({ StatusCode: 0 }));
  await expect(sendFeishu(testWebhook, testSecret, "测试", fetcher)).rejects.toThrow("成功标记");
  fetcher.mockRejectedValue(new Error(testWebhook + testSecret));
  await expect(sendFeishu(testWebhook, testSecret, "测试", fetcher)).rejects.toThrow(/^飞书连接超时、响应无效或网络异常$/);
});

it("结论摘要提取保留条件，忽略代码块与进度，无结论不推送，超长结论不截半句", () => {
  expect(extractConclusion("正在研究，请等待")).toBeNull();
  expect(extractConclusion("## 结论\n旧结论\n## 结论摘要\n最终条件\n### 风险\n仍需复核")).toBe("最终条件\n### 风险\n仍需复核");
  expect(extractConclusion("```md\n## 结论摘要\n假的结论\n```\n还在处理中")).toBeNull();
  expect(extractConclusion("# 报告\n## 结论摘要\n暂无结论")).toBe("");
  expect(extractConclusion("## 结论摘要\n- 价格<10且量>100才评估。\n- 风险：未触发不能执行。\n## 证据\n不应出现在摘要中")).toBe("- 价格＜10且量＞100才评估。\n- 风险：未触发不能执行。");
  expect(extractConclusion("## 结论摘要\n" + "结".repeat(AGENT_NOTIFICATION_SUMMARY_MAX_CHARS))).toHaveLength(AGENT_NOTIFICATION_SUMMARY_MAX_CHARS);
  expect(extractConclusion("## 结论摘要\n" + "结".repeat(AGENT_NOTIFICATION_SUMMARY_MAX_CHARS + 1))).toContain("完整结果");
});

describe.skipIf(!prepared)("M3 作业调度与 Runner", () => {
  let pool: pg.Pool;
  let server: TestServer;

  beforeAll(async () => {
    pool = prepared!.pool;
    server = await startTestServer(pool);
  });

  beforeEach(async () => {
    await resetSchema(pool);
    await runMigrations(pool);
    await seedTestStrategy(pool);
    await pool.query(
      `INSERT INTO market_trading_day (trade_date, is_open, source) VALUES
         ('2026-08-17', true, 'test'), ('2026-08-18', true, 'test'),
         ('2026-08-19', true, 'test'), ('2026-08-20', true, 'test'),
         ('2026-08-21', true, 'test')`,
    );
  });

  afterAll(async () => {
    setAiRuntimeForTests(null);
    await server.close();
    await pool.end();
  });

  it("飞书设置、测试通知与列表接口仅回显状态，不接受外部地址或非法字段", async () => {
    expect((await api(server.baseUrl, "POST", "/api/notifications/test", {})).status).toBe(400);
    expect((await api(server.baseUrl, "PATCH", "/api/notifications/settings", { enabled: true })).status).toBe(400);
    expect((await api(server.baseUrl, "PATCH", "/api/notifications/settings", { webhook: "https://example.com" })).status).toBe(400);
    expect((await api(server.baseUrl, "PATCH", "/api/notifications/settings", { extra: testSecret })).status).toBe(400);
    const saved = await api(server.baseUrl, "PATCH", "/api/notifications/settings", { enabled: true, webhook: testWebhook, sign_secret: testSecret });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ enabled: true, webhook_configured: true, sign_secret_configured: true });
    const read = await api(server.baseUrl, "GET", "/api/notifications/settings");
    expect(JSON.stringify([saved, read])).not.toContain(testSecret);
    expect(JSON.stringify([saved, read])).not.toContain(testWebhook);
    const queued = await api(server.baseUrl, "POST", "/api/notifications/test", {});
    expect(queued.status).toBe(202);
    expect(queued.json).toMatchObject({ kind: "test", status: "pending" });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 19021, msg: testSecret }));
    await deliverNextNotification(pool, fetcher);
    const history = await api(server.baseUrl, "GET", "/api/notifications");
    expect(JSON.stringify(history)).not.toContain(testSecret);
    expect(JSON.stringify(history)).not.toContain(testWebhook);
    expect((await api(server.baseUrl, "POST", `/api/notifications/${queued.json.id}/retry`, {})).status).toBe(202);
    expect((await api(server.baseUrl, "POST", "/api/notifications/invalid/retry", {})).status).toBe(400);
  });

  it("每日计划成功后完整推送持仓预案、标的信号和打板机会，重试不重跑计划；新计划替代旧通知", async () => {
    await updateNotificationSettings(pool, { enabled: true, webhook: testWebhook, sign_secret: testSecret });
    const instruments = await pool.query(`INSERT INTO market_instrument (code,name,kind) VALUES
      ('600000.SH','持仓样本','stock'), ('000001.SZ','信号样本','stock'), ('002001.SZ','打板样本','stock'),
      ('600100.SH','精简样本','stock') RETURNING code,id`);
    const ids = Object.fromEntries(instruments.rows.map((row) => [row.code, row.id]));
    await pool.query(`INSERT INTO market_instrument (code,name,kind)
      SELECT '610' || lpad(n::text,3,'0') || '.SH', '额外持仓' || n::text, 'stock' FROM generate_series(1,8) n
      UNION ALL
      SELECT '003' || lpad(n::text,3,'0') || '.SZ', '额外机会' || n::text, 'stock' FROM generate_series(1,9) n`);
    const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
    const agentFlow = vi.fn(async () => {
      await pool.query(`INSERT INTO daily_plan_playbook
        (source_job_run_id,target_date,item_kind,instrument_id,code,name,grade,priority,action,trigger_kind,headline,auction_md,intraday_md,evidence_md,missing_md,invalidation_md,risk_md)
        VALUES
        ($1,'2026-08-17','position_action',$2,'600000.SH','持仓样本',NULL,100,'reduce','condition','满足条件后减仓',NULL,'价格<10且成交量>100，跌破支撑且反抽失败后才评估',NULL,NULL,'反抽站回支撑则失效','未触发不得执行'),
        ($1,'2026-08-17','position_action',$4,'600100.SH','精简样本',NULL,1,'exit','open','跌破12.5元清仓',NULL,NULL,NULL,NULL,NULL,NULL),
        ($1,'2026-08-17','off_pool_opportunity',$3,'002001.SZ','打板样本','A',1,'observe','condition','竞价转强后按打板预案复核','高开幅度与封单同时达标','回封确认后才评估','连板、龙虎榜与板块聚集共振','仍缺竞价确认','竞价转弱或开板不回封','高位分歧风险')`,
        [run.id, ids['600000.SH'], ids['002001.SZ'], ids['600100.SH']]);
      await pool.query(`INSERT INTO daily_plan_playbook
        (source_job_run_id,target_date,item_kind,instrument_id,code,name,grade,priority,action,trigger_kind,headline,auction_md,intraday_md,evidence_md,missing_md,invalidation_md,risk_md)
        SELECT $1::bigint,'2026-08-17'::date,'position_action',instrument.id,instrument.code,instrument.name,NULL,100+n,'hold','condition',
          repeat('持仓条件预案',20),repeat('竞价观察条件',20),repeat('盘中复核条件',20),NULL,NULL,repeat('持仓失效条件',20),repeat('持仓风险提示',20)
        FROM generate_series(1,8) n JOIN market_instrument instrument
          ON instrument.code='610' || lpad(n::text,3,'0') || '.SH'
        UNION ALL
        SELECT $1::bigint,'2026-08-17'::date,'off_pool_opportunity',instrument.id,instrument.code,instrument.name,'B',1+n,'observe','condition',
          repeat('打板条件预案',20),repeat('竞价确认条件',20),repeat('盘中回封条件',20),repeat('机会证据摘要',20),
          repeat('尚缺确认条件',20),repeat('机会失效条件',20),repeat('机会风险提示',20)
        FROM generate_series(1,9) n JOIN market_instrument instrument
          ON instrument.code='003' || lpad(n::text,3,'0') || '.SZ'`, [run.id]);
      const extraSignals = Array.from({ length: 12 }, (_, index) => ({
        action: "mark",
        code: `${String(300001 + index).padStart(6, "0")}.SZ`,
        pool: index % 2 === 0 ? "short" : "long",
        attention_status: index % 3 === 0 ? "qualified" : "near_qualified",
        attention_reason: `补充标的 ${index + 1} 的量价、板块和风险条件需要继续复核后再执行`,
        attention_from: "2026-08-18",
        attention_until: "2026-08-20",
      }));
      await pool.query(`INSERT INTO agent_tool_audit (session_id,tool_name,args,status) VALUES ($1,'pool_attention_write',$2,'ok')`, [run.session_id, {
        reason: "每日计划信号全量对账",
        items: [{ action: "mark", code: "000001.SZ", pool: "short", attention_status: "qualified",
          attention_reason: "右侧六条件已满足，等待次日回踩确认", attention_from: "2026-08-18", attention_until: "2026-08-20" }, ...extraSignals],
      }]);
      return "# 已完成每日计划";
    });
    const finished = await executeJobRun({ pool, databaseUrl: prepared!.url, agentFlow }, run.id);
    expect(finished?.status).toBe("success");
    let notices = await listNotifications(pool);
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain("【持仓预案｜10 项】");
    expect(notices[0].content).toContain("跌破支撑且反抽失败后才评估");
    expect(notices[0].content).toContain("价格＜10且成交量＞100");
    expect(notices[0].content).toContain("未触发不得执行");
    expect(notices[0].content).toContain("精简样本 600100.SH｜退出");
    expect(notices[0].content).toContain("预案：跌破12.5元清仓");
    expect(notices[0].content).not.toContain("按完整计划复核");
    expect(notices[0].content).not.toContain("未提供，执行前需核对");
    expect(notices[0].content).not.toContain("详见完整计划");
    expect(notices[0].content).toContain("【标的信号｜13 项】");
    expect(notices[0].content).toContain("信号样本 000001.SZ｜短线｜已符合");
    expect(notices[0].content).toContain("右侧六条件已满足，等待次日回踩确认");
    expect(notices[0].content).toContain("【打板机会预案｜10 项】");
    expect(notices[0].content).toContain("打板样本 002001.SZ｜A 级｜顺序 1");
    expect(notices[0].content).toContain("竞价转强后按打板预案复核");
    expect(notices[0].content).toContain("高开幅度与封单同时达标");
    expect(notices[0].content).toContain("回封确认后才评估");
    expect(notices[0].content).toContain("连板、龙虎榜与板块聚集共振");
    expect(notices[0].content).toContain("竞价转弱或开板不回封");
    expect(notices[0].content).toContain("高位分歧风险");
    expect(notices[0].content).toContain("不代表信号已触发或交易已执行");
    expect(notices[0].content).toMatch(/另有 \d+ 项持仓预案/);
    expect(notices[0].content).toMatch(/另有 \d+ 项标的信号/);
    expect(notices[0].content).toMatch(/另有 \d+ 项打板机会/);
    expect([...notices[0].content].length).toBeLessThanOrEqual(DAILY_PLAN_NOTIFICATION_MAX_CHARS);
    await enqueueJobConclusion(pool, notices[0].output_id);
    expect(await listNotifications(pool)).toHaveLength(1);
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("DELETE FROM notification_delivery");
      await enqueueJobConclusion(connection, notices[0].output_id);
      await connection.query("ROLLBACK");
    } finally { connection.release(); }
    expect((await listNotifications(pool))[0].id).toBe(notices[0].id);
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(testSecret));
    await deliverNextNotification(pool, fetcher);
    notices = await listNotifications(pool);
    expect(notices[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(new Date(notices[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now()+50_000);
    await deliverNextNotification(pool, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await pool.query("UPDATE notification_delivery SET next_attempt_at=now()");
    fetcher.mockImplementation(async () => Response.json({ code: 0 }));
    await Promise.all([deliverNextNotification(pool, fetcher), deliverNextNotification(pool, fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await listNotifications(pool))[0]).toMatchObject({ status: "sent", attempts: 2 });
    expect(agentFlow).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT status,attempt_count FROM job_run WHERE id=$1", [run.id])).rows[0]).toMatchObject({ status: "success", attempt_count: 1 });
    await pool.query("UPDATE notification_delivery SET status='failed'");
    const newer = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
    await executeJobRun({ pool, databaseUrl: prepared!.url, agentFlow: async () => "# 更新计划\n\n## 结论摘要\n继续观察，条件尚未触发。" }, newer.id);
    expect((await previewJobConclusion(pool))?.content).toContain("更新版");
    expect((await previewJobConclusion(pool))?.content).toContain("条件尚未触发");
    await deliverNextNotification(pool, fetcher);
    expect((await listNotifications(pool)).find((n) => n.id === notices[0].id)?.status).toBe("cancelled");
    await expect(retryNotification(pool, notices[0].id)).rejects.toThrow("仅可补发");
  });

  it("通知租约恢复、有限重试、关闭暂停、过期和更换渠道取消旧通知", async () => {
    await updateNotificationSettings(pool, { webhook: testWebhook, sign_secret: testSecret });
    await queueTestNotification(pool);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }));
    await pool.query("UPDATE notification_delivery SET status='sending', attempts=1, lease_until=now()-interval '1 second'");
    await deliverNextNotification(pool, fetcher);
    expect((await listNotifications(pool))[0]).toMatchObject({ status: "pending", attempts: 2 });
    await pool.query("UPDATE notification_delivery SET next_attempt_at=now()");
    await deliverNextNotification(pool, fetcher);
    expect((await listNotifications(pool))[0]).toMatchObject({ status: "failed", attempts: 3 });
    await deliverNextNotification(pool, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await queueTestNotification(pool);
    await updateNotificationSettings(pool, { sign_secret: "another-placeholder" });
    expect((await listNotifications(pool)).every((n) => n.status === 'cancelled')).toBe(true);
    await queueTestNotification(pool);
    await pool.query("UPDATE notification_delivery SET created_at=now()-interval '2 days' WHERE status='pending'");
    expect(await deliverNextNotification(pool, fetcher)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await updateNotificationSettings(pool, { enabled: true });
    const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
    await executeJobRun({ pool, databaseUrl: prepared!.url, agentFlow: async () => "# 计划\n\n## 结论摘要\n等待复核。" }, run.id);
    await updateNotificationSettings(pool, { enabled: false });
    expect(await deliverNextNotification(pool, fetcher)).toBe(false);
    await updateNotificationSettings(pool, { enabled: true });
    fetcher.mockImplementation(async () => Response.json({ code: 0 }));
    expect(await deliverNextNotification(pool, fetcher)).toBe(true);
  });

  it("全部Agent任务结论独立推送，按任务订阅；失败、无结论与非Agent输出不排队", async () => {
    await updateNotificationSettings(pool, { enabled: true, webhook: testWebhook, sign_secret: testSecret });
    const finish = async (code: string, markdown: string) => {
      const run = await queueManualJob(pool, code, "2026-08-17");
      expect((await executeJobRun({ pool, databaseUrl: prepared!.url, agentFlow: async () => markdown }, run.id))?.status).toBe("success");
      return run;
    };
    await finish("midweek_check", "# 检查报告\n## 结论摘要\n等待条件，不追高。");
    await finish("weekly_review", "# 周复盘\n## 结论摘要\n本周无调整，数据不足仍需复核。");
    const notifications = await listNotifications(pool);
    expect(notifications.map((item) => item.job_code).sort()).toEqual(["midweek_check", "weekly_review"]);
    expect(notifications.every((item) => item.kind === "agent_result")).toBe(true);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ code: 0 }));
    await updateNotificationSettings(pool, { job_codes: ["weekly_review"] });
    await deliverNextNotification(pool, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await listNotifications(pool)).find((n) => n.job_code === 'midweek_check')?.status).toBe("pending");
    expect((await listNotifications(pool)).find((n) => n.job_code === 'weekly_review')?.status).toBe("sent");
    await updateNotificationSettings(pool, { job_codes: null });
    await deliverNextNotification(pool, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await finish("weekly_review", "# 复盘\n## 结论摘要\n暂无结论");
    await finish("daily_plan_flow", "# 正文但没有结论");
    expect(await listNotifications(pool)).toHaveLength(2);
    const failed = await queueManualJob(pool, "weekly_review", "2026-08-17");
    await executeJobRun({ pool, databaseUrl: prepared!.url, agentFlow: async () => { throw new Error("模型失败"); } }, failed.id);
    expect(await listNotifications(pool)).toHaveLength(2);
    await expect(updateNotificationSettings(pool, { job_codes: ["daily_data_update"] })).rejects.toThrow("只能订阅");
    await expect(updateNotificationSettings(pool, { job_codes: ["missing_job"] })).rejects.toThrow("只能订阅");
    await updateNotificationSettings(pool, { job_codes: [] });
    await finish("weekly_review", "## 结论摘要\n满足条件才操作。");
    expect(await listNotifications(pool)).toHaveLength(2);
    const query = await api(server.baseUrl, "GET", "/api/notifications?job_code=midweek_check&status=sent");
    expect((query.json.items as unknown[]).length).toBe(1);
    const preview = await api(server.baseUrl, "GET", "/api/notifications/preview?job_code=midweek_check");
    expect(preview.json).toMatchObject({ job_code: "midweek_check" });
    expect((await pool.query("SELECT content::text FROM chat_message WHERE role='user' ORDER BY id LIMIT 1")).rows[0].content).toContain("结论摘要");
  });

  it("新增Agent任务自动纳入全部订阅，非Agent结果不能借用输出类型触发推送", async () => {
    await updateNotificationSettings(pool, { enabled: true, webhook: testWebhook, sign_secret: testSecret });
    const template = (await listJobDefinitions(pool)).find((job) => job.code === 'weekly_review')!;
    const custom = await createJobDefinition(pool, { code: "custom_conclusion", name: "自定义结论任务", cron: "0 16 * * 1-5", job_type: "agent_flow", config: {}, prompt_id: template.prompt_id });
    const run = await queueManualJob(pool, custom.code, "2026-08-17");
    await executeJobRun({ pool, databaseUrl: prepared!.url, agentFlow: async () => "## 结论摘要\n仅在条件满足后调整。" }, run.id);
    expect((await listNotifications(pool))[0]).toMatchObject({ job_code: custom.code, kind: "agent_result" });
    const dataRun = await queueManualJob(pool, "daily_data_update", "2026-08-17");
    await pool.query("UPDATE job_run SET status='success' WHERE id=$1", [dataRun.id]);
    const output = await pool.query(`INSERT INTO job_run_output(job_id,run_id,output_type,target_date,markdown,sha256,source)
      SELECT job_id,id,'daily_plan',target_date,'## 结论摘要\n不能发送',repeat('a',64),'agent_flow' FROM job_run WHERE id=$1 RETURNING id::text`, [dataRun.id]);
    await enqueueJobConclusion(pool, output.rows[0].id);
    expect(await listNotifications(pool)).toHaveLength(1);
  });

  it("通知按游标分页且正文按需读取，新通知插入不导致后续页重复或漏项", async () => {
    await updateNotificationSettings(pool, { webhook: testWebhook, sign_secret: testSecret });
    await pool.query(`INSERT INTO notification_delivery(kind,channel_revision,content,status)
      SELECT 'test', 2, '正文-' || n::text, CASE WHEN n%2=0 THEN 'sent' ELSE 'failed' END FROM generate_series(1,45) n`);
    const first = await listNotificationPage(pool);
    expect(first.items).toHaveLength(20);
    expect(first.next_cursor).not.toBeNull();
    expect(first.items[0]).not.toHaveProperty("content");
    await queueTestNotification(pool);
    const second = await listNotificationPage(pool, { before: first.next_cursor });
    const third = await listNotificationPage(pool, { before: second.next_cursor });
    expect(second.items).toHaveLength(20);
    expect(third.items).toHaveLength(5);
    expect(third.next_cursor).toBeNull();
    expect(new Set([...first.items,...second.items,...third.items].map((item) => item.id)).size).toBe(45);
    const filtered = await api(server.baseUrl, "GET", "/api/notifications?status=failed");
    expect((filtered.json.items as Array<{status: string}>).every((n) => n.status==='failed')).toBe(true);
    const detail = await api(server.baseUrl, "GET", `/api/notifications/${first.items[0].id}`);
    expect(detail.json.content).toBe("正文-45");
    expect((await api(server.baseUrl, "GET", "/api/notifications?before=invalid")).status).toBe(400);
    expect((await api(server.baseUrl, "GET", "/api/notifications?status=invalid")).status).toBe(400);
    expect((await api(server.baseUrl, "GET", "/api/notifications/999999")).status).toBe(404);
  });

  it("迁移初始化十个受控作业，板块目录与成分同步默认启用，cron 固定按上海时区解析", async () => {
    const jobs = await listJobDefinitions(pool);
    expect(jobs.map((job) => job.code)).toEqual([
      "auction_opportunity_assessment",
      "board_membership_sync",
      "daily_data_update",
      "daily_market_structure",
      "daily_plan_flow",
      "market_catalog_sync",
      "midweek_check",
      "nightly_sector_opportunity_scan",
      "weekly_full_market_indicators",
      "weekly_review",
    ]);
    expect(jobs.find((job) => job.code === "midweek_check")?.cron).toBe("30 17 * * 2");
    expect(jobs.find((job) => job.code === "weekly_review")?.cron).toBe("0 20 * * 0");
    expect(jobs.find((job) => job.code === "auction_opportunity_assessment")?.cron).toBe("30 9 * * 1-5");
    const nightly = jobs.find((job) => job.code === "nightly_sector_opportunity_scan")!;
    expect(nightly.cron).toBe("0 23 * * 1-5");
    expect(nightly.enabled).toBe(true);
    const nightlyModel = (await pool.query<{ provider_key: string; model_key: string }>(
      `SELECT provider.provider_key, model.model_key
         FROM llm_model model JOIN llm_provider provider ON provider.id = model.provider_id
        WHERE model.id = $1`,
      [nightly.model_id],
    )).rows[0]!;
    expect(nightlyModel).toEqual({ provider_key: "deepseek", model_key: "deepseek-v4-pro" });
    const dailyPlan = jobs.find((job) => job.code === "daily_plan_flow")!;
    expect(dailyPlan.cron).toBe("15 17 * * 1-5");
    expect(dailyPlan.config).toEqual({});
    expect(jobs.filter((job) => job.job_type === "agent_flow")
      .every((job) => Object.keys(job.config).length === 0)).toBe(true);
    expect(
      jobs
        .filter((job) => ["market_catalog_sync", "board_membership_sync"].includes(job.code))
        .every((job) => job.enabled === true),
    ).toBe(true);
    expect(jobs.find((job) => job.code === "daily_market_structure")?.enabled).toBe(false);
    const prompts = await pool.query<{ code: string; content: string }>(
      `SELECT p.code, r.content FROM job_prompt p JOIN job_prompt_revision r ON r.id = p.current_revision_id ORDER BY p.code`,
    );
    expect(prompts.rows).toHaveLength(5);
    expect(prompts.rows.filter((row) => row.code !== "auction_opportunity_assessment")
      .every((row) => row.content.includes("当前最终策略"))).toBe(true);
    expect(prompts.rows.filter((row) => row.code !== "auction_opportunity_assessment")
      .every((row) => row.content.includes("job_run_output"))).toBe(true);
    expect(prompts.rows.every((row) => !row.content.includes(".md"))).toBe(true);
    expect(prompts.rows.every((row) => !row.content.includes("## 策略模拟账户信号"))).toBe(true);
    const dailyPrompt = prompts.rows.find((row) => row.code === "daily_plan_flow")!.content;
    const midweekPrompt = prompts.rows.find((row) => row.code === "midweek_check")!.content;
    const weeklyPrompt = prompts.rows.find((row) => row.code === "weekly_review")!.content;
    const nightlyPrompt = prompts.rows.find((row) => row.code === "nightly_sector_opportunity_scan")!.content;
    expect(dailyPrompt).toContain("pool_attention_write");
    expect(dailyPrompt).toContain("daily_plan_context_query");
    expect(dailyPrompt.length).toBeLessThan(4_000);
    expect(midweekPrompt).toContain("pool_context_query");
    expect(midweekPrompt.length).toBeLessThan(1_200);
    expect(weeklyPrompt).toContain("analysis_run(long_valuation)");
    expect(weeklyPrompt.length).toBeLessThan(1_200);
    expect(nightlyPrompt).toContain('"analysis_type":"sector_temperature"');
    expect(nightlyPrompt).toContain("不得传 `codes`");
    expect(nightlyPrompt).toContain("每个板块最多保留 2 只标的");
    expect(nightlyPrompt).toContain("不超过 600 个中文字符");
    expect(nightlyPrompt.length).toBeLessThan(4_000);
    expect([dailyPrompt, midweekPrompt, weeklyPrompt, nightlyPrompt]
      .every((content) => !content.includes("本节替代前文"))).toBe(true);
    const auctionPrompt = prompts.rows.find((row) => row.code === "auction_opportunity_assessment")!.content;
    expect(auctionPrompt).toContain("tool_catalog");
    expect(auctionPrompt).toContain("auction_context_query");
    expect(auctionPrompt).toContain("auction_short_term_benchmark");
    expect(auctionPrompt).toContain("auction_snapshot");
    expect(auctionPrompt).toContain('stage="final"');
    expect(auctionPrompt).toContain("signal_passed/one_word_continue");
    expect(auctionPrompt).toContain("signal_passed/turnover_advance");
    expect(auctionPrompt).toContain("items` 必须与 `opportunities` 代码全集完全一致");
    expect(auctionPrompt).not.toContain("worth_entering");
    expect(auctionPrompt).not.toContain("本节替代前文");
    expect(auctionPrompt).toContain("不交易、不改持仓、不入池、不修改近期关注或策略");
    expect(shanghaiDate(new Date("2026-08-16T16:30:00Z"))).toBe("2026-08-17");
    expect(
      cronOccurrences(
        "0 9 * * 1",
        new Date("2026-08-16T00:00:00Z"),
        new Date("2026-08-17T02:00:00Z"),
      ).map((date) => date.toISOString()),
    ).toEqual(["2026-08-17T01:00:00.000Z"]);
    expect(
      cronOccurrences(
        dailyPlan.cron,
        new Date("2026-08-28T00:00:00Z"),
        new Date("2026-08-31T10:00:00Z"),
      ).map((date) => date.toISOString()),
    ).toEqual(["2026-08-28T09:15:00.000Z", "2026-08-31T09:15:00.000Z"]);
  });

  it("Agent 任务可固定、切换或清空模型，非 Agent 任务拒绝模型绑定", async () => {
    const promptId = (await pool.query<{ id: string }>(
      "SELECT id::text FROM job_prompt WHERE code = 'daily_plan_flow'",
    )).rows[0]!.id;
    const modelId = (await pool.query<{ id: string }>(
      `SELECT model.id::text
         FROM llm_model model JOIN llm_provider provider ON provider.id = model.provider_id
        WHERE provider.provider_key = 'deepseek' AND model.model_key = 'deepseek-v4-pro'`,
    )).rows[0]!.id;
    const job = await createJobDefinition(pool, {
      code: "fixed_model_probe",
      name: "固定模型探针",
      cron: "0 1 * * *",
      job_type: "agent_flow",
      config: {},
      prompt_id: promptId,
      model_id: modelId,
    });
    expect(job.model_id).toBe(modelId);
    expect((await updateJobDefinition(pool, job.code, { model_id: null })).model_id).toBeNull();
    expect((await updateJobDefinition(pool, job.code, { model_id: modelId })).model_id).toBe(modelId);
    await expect(createJobDefinition(pool, {
      code: "missing_model_probe",
      name: "不存在模型探针",
      cron: "0 2 * * *",
      job_type: "agent_flow",
      config: {},
      prompt_id: promptId,
      model_id: "999999999",
    })).rejects.toThrow("模型不存在");
    await expect(createJobDefinition(pool, {
      code: "datasource_model_probe",
      name: "数据模型探针",
      cron: "0 3 * * *",
      job_type: "datasource",
      config: { pipeline: "daily_market_update", export_volume: false },
      model_id: modelId,
    })).rejects.toThrow("不能指定模型");
    await expect(updateJobDefinition(pool, "daily_data_update", { model_id: modelId }))
      .rejects.toThrow("不能指定模型");
  });

  it("日更范围默认覆盖全市场个股，但宽域标的只做快照追加不重拉", async () => {
    await pool.query(
      `INSERT INTO market_instrument (code,name,kind,lifecycle_status) VALUES
         ('000300.SH','沪深300','index','active'),
         ('000851.SH','非核心指数','index','active'),
         ('881101.TI','同花顺一级行业','board','active'),
         ('884001.TI','同花顺二级行业','board','active'),
         ('885001.TI','同花顺概念板块','board','active'),
         ('881102.TI','失效一级行业','board','inactive'),
         ('600001.SH','普通池外股票','stock','active'),
         ('600002.SH','涨停池外候选','stock','active'),
         ('600003.SH','龙虎榜池外候选','stock','active')`,
    );
    await pool.query(
      `INSERT INTO market_board (instrument_id,board_type,source,active)
       SELECT id,
              CASE WHEN code = '885001.TI' THEN 'concept' ELSE 'industry' END,
              'hithink', true
         FROM market_instrument WHERE kind = 'board'`,
    );
    await pool.query(
      `INSERT INTO market_limit_event
         (trade_date,event_type,instrument_id,streak_count,source_row_sha256)
       SELECT '2026-08-20','up',id,2,repeat('a',64)
         FROM market_instrument WHERE code='600002.SH';
       INSERT INTO market_dragon_tiger_entry
         (trade_date,dataset_type,instrument_id,net_amount,source_row_sha256)
       SELECT '2026-08-20','org',id,1000000,repeat('b',64)
         FROM market_instrument WHERE code='600003.SH'`,
    );
    // 全市场开启（生产默认）：普通池外个股进入快照范围，但不进入缺口重拉名单。
    const full = await resolveDailyUpdateScope(pool, "2026-08-20", "snapshot", { fullMarket: true });
    expect(full.codes).toEqual([
      "000300.SH", "600001.SH", "600002.SH", "600003.SH", "881101.TI", "884001.TI",
    ]);
    expect(full.refetchCodes).toEqual(["000300.SH", "600002.SH", "600003.SH", "881101.TI", "884001.TI"]);
    expect(full.minute30).toEqual(["000300.SH"]);

    // 显式关闭全市场：恢复只覆盖持仓、池、核心指数、行业与当日结构候选。
    const scoped = await resolveDailyUpdateScope(pool, "2026-08-20", "snapshot", { fullMarket: false });
    expect(scoped.codes).toEqual(["000300.SH", "600002.SH", "600003.SH", "881101.TI", "884001.TI"]);
    expect(scoped.refetchCodes).toEqual(scoped.codes);
  });

  it("同一 job/scheduled_for 并发 tick 只插入一条", async () => {
    const job = (await listJobDefinitions(pool))[0]!;
    const at = new Date("2026-08-17T07:45:00Z");
    const [left, right] = await Promise.all([
      insertScheduledJobRun(pool, job.id, at, "queued"),
      insertScheduledJobRun(pool, job.id, at, "queued"),
    ]);
    expect([left, right].filter(Boolean)).toHaveLength(1);
    const count = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM job_run WHERE job_id = $1 AND scheduled_for = $2",
      [job.id, at],
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  it("运行记录按创建时间倒序，不把文本 ID 当排序键", async () => {
    await pool.query("ALTER TABLE job_run ALTER COLUMN id RESTART WITH 9");
    const older = await queueManualJob(pool, "daily_plan_flow", "2026-08-18");
    const newer = await queueManualJob(pool, "daily_plan_flow", "2026-08-19");
    await pool.query(
      `UPDATE job_run SET created_at = CASE id
         WHEN $1 THEN '2026-08-18T09:00:00Z'::timestamptz
         ELSE '2026-08-19T09:00:00Z'::timestamptz END
       WHERE id IN ($1, $2)`,
      [older.id, newer.id],
    );
    expect((await listJobRuns(pool, older.job_id, 10)).map((run) => run.id))
      .toEqual([newer.id, older.id]);
  });

  it("启动扫描把停机期间计划时刻记为 missed，复扫幂等且不补跑", async () => {
    await pool.query("UPDATE job_definition SET enabled = false");
    const job = await createJobDefinition(pool, {
      code: "missed_probe",
      name: "漏跑探针",
      cron: "0 9 * * *",
      job_type: "agent_flow",
      config: {},
      prompt_id: (await pool.query<{ id: string }>("SELECT id::text FROM job_prompt WHERE code = 'daily_plan_flow'")).rows[0]!.id,
    });
    await pool.query(
      "UPDATE job_definition SET created_at = $2, updated_at = $2 WHERE id = $1",
      [job.id, "2026-08-15T00:00:00Z"],
    );
    const scheduler = new JobScheduler({
      pool,
      databaseUrl: prepared!.url,
      now: () => new Date("2026-08-17T02:00:00Z"),
    });
    expect(await scheduler.recoverMissed(new Date("2026-08-17T02:00:00Z"))).toBe(3);
    expect(await scheduler.recoverMissed(new Date("2026-08-17T02:00:00Z"))).toBe(0);
    const rows = await pool.query("SELECT status, attempt_count FROM job_run ORDER BY id");
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.every((row) => row.status === "missed" && row.attempt_count === 0)).toBe(true);
    expect(Number((await pool.query("SELECT count(*) FROM chat_session WHERE session_type = 'job'")).rows[0]!.count)).toBe(0);
  });

  it("Agent 作业排队时原子关联唯一 session，非 Agent 与 missed 不创建伪 session", async () => {
    const manual = await queueManualJob(pool, "daily_plan_flow", "2026-08-18");
    expect(manual.session_id).toBeTruthy();
    const session = await pool.query(
      "SELECT session_type, session_status, source, model_id::text FROM chat_session WHERE id = $1",
      [manual.session_id],
    );
    const activeModelId = (await pool.query<{ model_id: string | null }>(
      "SELECT active_model_id::text AS model_id FROM llm_setting WHERE singleton",
    )).rows[0]!.model_id;
    expect(session.rows[0]).toEqual({
      session_type: "job",
      session_status: "queued",
      source: "manual_job",
      model_id: activeModelId,
    });

    const nightlyDefinition = (await listJobDefinitions(pool))
      .find((job) => job.code === "nightly_sector_opportunity_scan")!;
    const nightlyManual = await queueManualJob(pool, nightlyDefinition.code, "2026-08-18");
    expect((await pool.query<{ model_id: string | null }>(
      "SELECT model_id::text FROM chat_session WHERE id = $1",
      [nightlyManual.session_id],
    )).rows[0]!.model_id).toBe(nightlyDefinition.model_id);

    const datasource = await queueManualJob(
      pool,
      "daily_data_update",
      "2026-08-18",
      new Date("2026-08-19T08:00:00Z"),
    );
    expect(datasource.session_id).toBeNull();

    const flow = (await listJobDefinitions(pool)).find((job) => job.code === "daily_plan_flow")!;
    const missed = await insertScheduledJobRun(
      pool,
      flow.id,
      new Date("2026-08-18T09:15:00Z"),
      "missed",
    );
    expect(missed?.session_id).toBeNull();

    const scheduledAt = new Date("2026-08-19T09:15:00Z");
    const [left, right] = await Promise.all([
      insertScheduledJobRun(pool, flow.id, scheduledAt, "queued"),
      insertScheduledJobRun(pool, flow.id, scheduledAt, "queued"),
    ]);
    const scheduled = [left, right].filter((item) => item !== null);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.session_id).toBeTruthy();
    expect(
      Number((await pool.query(
        `SELECT count(*) FROM chat_session s
          WHERE s.session_type = 'job'
            AND s.id = (SELECT session_id FROM job_run WHERE job_id = $1 AND scheduled_for = $2)`,
        [flow.id, scheduledAt],
      )).rows[0]!.count),
    ).toBe(1);

    const nightlyScheduled = await insertScheduledJobRun(
      pool,
      nightlyDefinition.id,
      new Date("2026-08-19T13:00:00Z"),
      "queued",
    );
    expect((await pool.query<{ model_id: string | null }>(
      "SELECT model_id::text FROM chat_session WHERE id = $1",
      [nightlyScheduled!.session_id],
    )).rows[0]!.model_id).toBe(nightlyDefinition.model_id);
  });

  it("Agent session 创建失败时排队事务整体回滚，不留下可执行 job_run", async () => {
    await pool.query(`
      CREATE FUNCTION test_reject_job_session() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.session_type = 'job' THEN RAISE EXCEPTION '测试：拒绝任务 session'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_reject_job_session_trigger
      BEFORE INSERT ON chat_session FOR EACH ROW EXECUTE FUNCTION test_reject_job_session();
    `);
    const before = Number((await pool.query("SELECT count(*) FROM job_run")).rows[0]!.count);
    try {
      await expect(queueManualJob(pool, "daily_plan_flow", "2026-08-18")).rejects.toThrow(
        "测试：拒绝任务 session",
      );
      expect(Number((await pool.query("SELECT count(*) FROM job_run")).rows[0]!.count)).toBe(before);
    } finally {
      await pool.query("DROP TRIGGER test_reject_job_session_trigger ON chat_session");
      await pool.query("DROP FUNCTION test_reject_job_session()");
    }
  });

  it("日更手动入口拒绝盘前快照，历史目标日仍可排队并切换历史模式", async () => {
    await expect(
      queueManualJob(pool, "daily_data_update", undefined, new Date("2026-08-21T01:00:00Z")),
    ).rejects.toMatchObject({ message: expect.stringContaining("尚未收盘") });
    expect(Number((await pool.query("SELECT count(*) FROM job_run")).rows[0]!.count)).toBe(0);

    const historical = await queueManualJob(
      pool,
      "daily_data_update",
      "2026-08-20",
      new Date("2026-08-21T01:00:00Z"),
    );
    expect(historical.target_date).toBe("2026-08-20");
  });

  it("交易日历缺行时工作日继续取实际行情，周末仍跳过", async () => {
    await expect(dailyMarketGate(pool, "2026-08-24", new Date("2026-08-24T08:00:00Z")))
      .resolves.toEqual({ action: "run", mode: "snapshot" });
    await expect(dailyMarketGate(pool, "2026-08-22", new Date("2026-08-24T08:00:00Z")))
      .resolves.toEqual({ action: "skip", reason: "目标日 2026-08-22 为非交易日" });
  });

  it("共享工具目录可维护自动关注并自动绑定当前计划运行", async () => {
    await pool.query(
      `INSERT INTO market_instrument (code,name,kind) VALUES
         ('990086.SZ','人工关注测试','stock'),
         ('990087.SZ','过期自动关注测试','stock'),
         ('990088.SZ','关注工具测试','stock'),
         ('990089.SZ','预案工具测试','stock')`,
    );
    await pool.query(
      `INSERT INTO pool_membership (instrument_id,pool,role,effective_from)
       SELECT id,'short','观察','2026-08-01' FROM market_instrument WHERE code IN ('990086.SZ','990087.SZ','990088.SZ','990089.SZ')`,
    );
    await pool.query(
      `UPDATE pool_membership membership
          SET attention_reason = CASE instrument.code
                WHEN '990086.SZ' THEN '人工持续跟踪'
                ELSE '每日计划·即将符合：上一计划遗留'
              END,
              attention_from = '2026-08-17', attention_until = '2026-08-25'
         FROM market_instrument instrument
        WHERE instrument.id = membership.instrument_id
          AND instrument.code IN ('990086.SZ','990087.SZ')`,
    );
    await pool.query(
      `INSERT INTO portfolio_position (instrument_id,quantity,cost_price)
       SELECT id,100,10 FROM market_instrument WHERE code='990089.SZ'`,
    );
    const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-18");
    const tools = buildChatTools({ pool, sessionId: run.session_id! }, { kind: "job", jobCode: "daily_plan_flow" });
    const tool = tools.find((item) => item.name === "pool_attention_write")!;
    await tool.execute("tc-attention-mark", {
      reason: "每日计划识别出接近完整条件",
      items: [{
        action: "mark",
        code: "990088.SZ",
        pool: "short",
        attention_status: "approaching",
        attention_reason: "每日计划·即将符合：仍缺放量站稳关键位",
        missing_signals: ["右侧信号：放量站稳关键位"],
        attention_from: "2026-08-18",
        attention_until: "2026-08-25",
      }],
    });
    expect((await pool.query(
      `SELECT attention_signal,attention_reason,attention_from::text,attention_until::text
         FROM pool_membership membership JOIN market_instrument instrument ON instrument.id=membership.instrument_id
        WHERE membership.effective_to IS NULL AND instrument.code='990088.SZ'`,
    )).rows[0]).toEqual({
      attention_signal: { status: "approaching", missing_signals: ["右侧信号：放量站稳关键位"] },
      attention_reason: "每日计划·即将符合：仍缺放量站稳关键位",
      attention_from: "2026-08-18",
      attention_until: "2026-08-25",
    });
    expect((await pool.query(
      `SELECT instrument.code, membership.attention_reason
         FROM pool_membership membership JOIN market_instrument instrument ON instrument.id=membership.instrument_id
        WHERE instrument.code IN ('990086.SZ','990087.SZ') ORDER BY instrument.code`,
    )).rows).toEqual([
      { code: "990086.SZ", attention_reason: "人工持续跟踪" },
      { code: "990087.SZ", attention_reason: null },
    ]);
    const heldResult = await tool.execute("tc-attention-held", {
      reason: "已持仓标的不进入近期关注",
      items: [{
        action: "mark",
        code: "990089.SZ",
        pool: "short",
        attention_status: "qualified",
        attention_reason: "满足信号但已经持仓",
        attention_from: "2026-08-18",
        attention_until: "2026-08-25",
      }],
    });
    expect(heldResult.details).toMatchObject({
      items: [
        { code: "990089.SZ", action: "skip", suppressed_by: "existing_position" },
        { code: "990088.SZ", action: "clear", reconciled: true },
      ],
    });
    expect((await pool.query(
      `SELECT attention_reason FROM pool_membership membership
        JOIN market_instrument instrument ON instrument.id=membership.instrument_id
       WHERE instrument.code='990089.SZ'`,
    )).rows[0]!.attention_reason).toBeNull();
    await tool.execute("tc-attention-empty", {
      reason: "本轮没有符合或即将符合条件的标的",
      items: [],
    });
    expect((await pool.query(
      `SELECT attention_reason FROM pool_membership membership
        JOIN market_instrument instrument ON instrument.id=membership.instrument_id
       WHERE instrument.code='990088.SZ'`,
    )).rows[0]!.attention_reason).toBeNull();
    await pool.query(
      `UPDATE pool_membership membership SET attention_reason='人工持续跟踪'
         FROM market_instrument instrument
        WHERE instrument.id=membership.instrument_id AND instrument.code='990088.SZ'`,
    );
    await expect(tool.execute("tc-attention-clear", {
      reason: "本轮已不接近条件",
      items: [{ action: "clear", code: "990088.SZ", pool: "short" }],
    })).rejects.toThrow("不得清除");
    expect((await pool.query(
      `SELECT attention_reason FROM pool_membership membership
        JOIN market_instrument instrument ON instrument.id=membership.instrument_id
       WHERE instrument.code='990088.SZ'`,
    )).rows[0]!.attention_reason)
      .toBe("人工持续跟踪");

    await tools.find((item) => item.name === "daily_plan_write")!.execute("tc-plan-write", {
      items: [{
        item_kind: "position_action",
        code: "990089.SZ",
        action: "hold",
        trigger_kind: "open",
        headline: "继续观察",
      }],
    });
    expect((await pool.query<{ source_job_run_id: string }>(
      "SELECT source_job_run_id::text FROM daily_plan_playbook WHERE code='990089.SZ'",
    )).rows[0]!.source_job_run_id).toBe(run.id);
  });

  it("调度器最多并行三个任务，且 datasource 保持单路执行", async () => {
    await pool.query("UPDATE job_definition SET enabled = false");
    for (const code of ["parallel_data_a", "parallel_data_b"]) {
      await createJobDefinition(pool, {
        code,
        name: code,
        cron: "0 0 * * *",
        job_type: "datasource",
        config: { pipeline: "daily_market_update", export_volume: false },
      });
    }
    for (const code of ["parallel_analysis_a", "parallel_analysis_b"]) {
      await createJobDefinition(pool, {
        code,
        name: code,
        cron: "0 0 * * *",
        job_type: "analysis",
        config: { analysis_type: "sector_temperature" },
      });
    }
    const runs = [];
    for (const code of ["parallel_data_a", "parallel_data_b", "parallel_analysis_a", "parallel_analysis_b"]) {
      runs.push(await queueManualJob(pool, code, "2026-08-20"));
    }

    let active = 0;
    let maxActive = 0;
    let activeDatasource = 0;
    let maxActiveDatasource = 0;
    let started = 0;
    let release!: () => void;
    let threeStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { threeStarted = resolve; });
    const enter = async (datasource: boolean): Promise<void> => {
      active += 1;
      started += 1;
      maxActive = Math.max(maxActive, active);
      if (datasource) {
        activeDatasource += 1;
        maxActiveDatasource = Math.max(maxActiveDatasource, activeDatasource);
      }
      if (started === 3) threeStarted();
      await gate;
      active -= 1;
      if (datasource) activeDatasource -= 1;
    };
    const scheduler = new JobScheduler({
      pool,
      databaseUrl: prepared!.url,
      dailyUpdate: async () => {
        await enter(true);
        return dailySummary();
      },
      analysisRun: async () => {
        await enter(false);
        return { id: "1", status: "success", data_gaps: [] };
      },
    });
    const starting = scheduler.start();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("三个任务未并行启动")), 2_000);
        }),
      ]);
      expect(maxActive).toBe(3);
      expect(maxActiveDatasource).toBe(1);
      release();
      for (let index = 0; index < 100; index += 1) {
        const terminal = await pool.query<{ status: string }>(
          "SELECT status FROM job_run WHERE id = ANY($1::bigint[])",
          [runs.map((run) => run.id)],
        );
        if (terminal.rows.every((row) => row.status === "success")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      release();
      await starting;
      await scheduler.stop();
    }
    const statuses = await pool.query<{ status: string }>(
      "SELECT status FROM job_run WHERE id = ANY($1::bigint[]) ORDER BY id",
      [runs.map((run) => run.id)],
    );
    expect(statuses.rows.map((row) => row.status)).toEqual(["success", "success", "success", "success"]);
  });

  it("长任务运行时仍按时扫描并启动其他 cron 任务", async () => {
    await pool.query("UPDATE job_definition SET enabled = false");
    await createJobDefinition(pool, {
      code: "slow_datasource",
      name: "慢数据任务",
      cron: "0 16 * * *",
      job_type: "datasource",
      config: { pipeline: "daily_market_update", export_volume: false },
    });
    await createJobDefinition(pool, {
      code: "independent_analysis",
      name: "独立分析任务",
      cron: "1 16 * * *",
      job_type: "analysis",
      config: { analysis_type: "sector_temperature" },
    });
    let now = new Date("2026-08-17T08:00:00Z");
    let releaseSlow!: () => void;
    let markSlowStarted!: () => void;
    let markFastStarted!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const slowStarted = new Promise<void>((resolve) => { markSlowStarted = resolve; });
    const fastStarted = new Promise<void>((resolve) => { markFastStarted = resolve; });
    const scheduler = new JobScheduler({
      pool,
      databaseUrl: prepared!.url,
      tickMs: 300_000,
      now: () => now,
      dailyUpdate: async () => {
        markSlowStarted();
        await slowGate;
        return dailySummary();
      },
      analysisRun: async () => {
        markFastStarted();
        return { id: "1", status: "success", data_gaps: [] };
      },
    });
    await scheduler.start();
    try {
      await slowStarted;
      now = new Date("2026-08-17T08:01:00Z");
      scheduler.wake();
      await Promise.race([
        fastStarted,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("独立任务被慢任务阻塞")), 2_000)),
      ]);
    } finally {
      releaseSlow();
      await scheduler.stop();
    }
    const statuses = await pool.query<{ code: string; status: string }>(
      `SELECT d.code, r.status FROM job_run r JOIN job_definition d ON d.id = r.job_id
        WHERE d.code IN ('slow_datasource', 'independent_analysis') ORDER BY d.code`,
    );
    expect(statuses.rows).toEqual([
      { code: "independent_analysis", status: "success" },
      { code: "slow_datasource", status: "success" },
    ]);
  });

  it("30 秒调度循环在命中时刻自动执行 datasource，且结果成功入账", async () => {
    await pool.query("UPDATE job_definition SET enabled = false");
    await createJobDefinition(pool, {
      code: "tick_datasource",
      name: "tick 数据源",
      cron: "0 16 * * *",
      job_type: "datasource",
      config: { pipeline: "daily_market_update", export_volume: false },
    });
    const dailyUpdate = vi.fn(async () => dailySummary());
    const scheduler = new JobScheduler({
      pool,
      databaseUrl: prepared!.url,
      now: () => new Date("2026-08-17T08:00:00Z"),
      tickMs: 30_000,
      dailyUpdate,
    });
    await scheduler.start();
    await scheduler.stop();
    expect(dailyUpdate).toHaveBeenCalledTimes(1);
    const run = await pool.query("SELECT status, target_date::text FROM job_run");
    expect(run.rows).toEqual([{ status: "success", target_date: "2026-08-17" }]);
  });

  it("datasource 串起行情与 scheduled 数据卷，存在缺口时记 partial", async () => {
    await updateJobDefinition(pool, "daily_data_update", {
      config: { pipeline: "daily_market_update", export_volume: true },
    });
    const run = await queueManualJob(
      pool,
      "daily_data_update",
      "2026-08-17",
      new Date("2026-08-18T08:00:00Z"),
    );
    const volumeExport = vi.fn(async () => ({
      dumpPath: "/tmp/test.dump",
      manifestPath: "/tmp/test.manifest.json",
    }) as never);
    const finished = await executeJobRun(
      {
        pool,
        databaseUrl: prepared!.url,
        dailyUpdate: async () => dailySummary([{ code: "000001.SH", reason: "测试缺口" }]),
        volumeExport,
      },
      run.id,
    );
    expect(finished?.status).toBe("partial");
    expect(finished?.data_gaps).toHaveLength(1);
    expect(finished?.artifacts).toEqual([
      expect.objectContaining({ kind: "volume_snapshot", path: expect.any(String) }),
    ]);
    expect(volumeExport).toHaveBeenCalledTimes(1);
  });

  it("市场域写锁争用时 datasource 零调用并进入一次重试，不盲目并发写库", async () => {
    await updateJobDefinition(pool, "daily_data_update", {
      config: { pipeline: "daily_market_update", export_volume: false },
    });
    const run = await queueManualJob(
      pool,
      "daily_data_update",
      "2026-08-17",
      new Date("2026-08-18T08:00:00Z"),
    );
    const lockClient = await pool.connect();
    const dailyUpdate = vi.fn(async () => dailySummary());
    try {
      await lockClient.query("BEGIN");
      await acquireMarketMutationLock(lockClient);
      const result = await executeJobRun(
        { pool, databaseUrl: prepared!.url, dailyUpdate },
        run.id,
      );
      expect(result?.status).toBe("queued");
      expect(result?.attempt_count).toBe(1);
      expect(dailyUpdate).not.toHaveBeenCalled();
    } finally {
      await lockClient.query("ROLLBACK");
      lockClient.release();
    }
  });

  it("市场作业不占 Agent 写锁，目录、板块和结构 pipeline 分别入账", async () => {
    const lockClient = await pool.connect();
    try {
      await lockClient.query("BEGIN");
      await acquireAgentMutationLock(lockClient);

      const catalogJob = await createJobDefinition(pool, {
        code: "catalog_probe",
        name: "目录探针",
        cron: "0 0 * * *",
        job_type: "datasource",
        config: { pipeline: "market_catalog_sync", export_volume: false },
      });
      const catalogRun = await queueManualJob(pool, catalogJob.code, "2026-08-17");
      const catalog = await executeJobRun({
        pool,
        databaseUrl: prepared!.url,
        catalogSync: async () => ({ tickerCount: 10, boardCount: 4, tradingDayCount: 2, fetchRunIds: ["9"] }),
      }, catalogRun.id);
      expect(catalog).toMatchObject({ status: "success", artifacts: [{ kind: "market_fetch_run", id: "9" }] });

      const boardJob = await createJobDefinition(pool, {
        code: "board_probe",
        name: "板块探针",
        cron: "0 0 * * *",
        job_type: "datasource",
        config: { pipeline: "board_membership_sync", export_volume: false },
      });
      const boardRun = await queueManualJob(pool, boardJob.code, "2026-08-17");
      const board = await executeJobRun({
        pool,
        databaseUrl: prepared!.url,
        boardMembershipSync: async () => ({
          completed: [{ memberCount: 12, opened: 2, closed: 1 }],
          gaps: [{ code: "885001.TI", reason: "测试缺口" }],
        }),
      }, boardRun.id);
      expect(board).toMatchObject({ status: "partial", data_gaps: [{ code: "885001.TI" }] });

      const structureJob = await createJobDefinition(pool, {
        code: "structure_probe",
        name: "结构探针",
        cron: "0 0 * * *",
        job_type: "datasource",
        config: { pipeline: "daily_market_structure", export_volume: false },
      });
      const structureRun = await queueManualJob(pool, structureJob.code, "2026-08-17");
      const structure = await executeJobRun({
        pool,
        databaseUrl: prepared!.url,
        marketStructureSync: async () => ({
          datasets: [{
            dataset: "limit_up",
            targetDate: "2026-08-17",
            status: "success",
            rows: 8,
            completedPages: 1,
            totalPages: 1,
            gaps: [],
            runId: "21",
          }],
          gaps: [],
        }),
      }, structureRun.id);
      expect(structure).toMatchObject({
        status: "success",
        artifacts: [{ kind: "market_special_sync_run", id: "21", dataset: "limit_up" }],
      });
    } finally {
      await lockClient.query("ROLLBACK");
      lockClient.release();
    }
  });

  it("失败只自动重试一次，第二次失败进入 failed", async () => {
    const job = await createJobDefinition(pool, {
      code: "retry_analysis",
      name: "重试分析",
      cron: "0 0 * * *",
      job_type: "analysis",
      config: { analysis_type: "sector_temperature", request: {} },
    });
    const run = await queueManualJob(pool, job.code, "2026-08-17");
    let now = new Date("2026-08-17T01:00:00Z");
    const deps = {
      pool,
      databaseUrl: prepared!.url,
      retryDelayMs: 1_000,
      now: () => now,
      analysisRun: async () => { throw new Error("固定失败"); },
    };
    const first = await executeJobRun(deps, run.id);
    expect(first).toMatchObject({ status: "queued", attempt_count: 1 });
    expect(await executeJobRun(deps, run.id)).toBeNull();
    now = new Date(now.getTime() + 1_000);
    const second = await executeJobRun(deps, run.id);
    expect(second).toMatchObject({ status: "failed", attempt_count: 2 });
    expect(second?.log).toContain("已达到重试上限");
  });

  it("agent_flow 自动重试复用同一普通对话，并在对话中保留失败、重试和结果入口", async () => {
    const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
    const sessionId = run.session_id!;
    let now = new Date("2026-08-17T01:00:00Z");
    let calls = 0;
    const deps = {
      pool,
      databaseUrl: prepared!.url,
      retryDelayMs: 1_000,
      now: () => now,
      agentFlow: async () => {
        calls += 1;
        if (calls === 1) throw new Error("第一次固定失败");
        return "> AI 生成预览，未经用户确认，不是交易建议，也未写入内容库或业务表。\n\n# 第二次成功";
      },
    };
    const first = await executeJobRun(deps, run.id);
    expect(first).toMatchObject({ status: "queued", attempt_count: 1, session_id: sessionId });
    now = new Date(now.getTime() + 1_000);
    const second = await executeJobRun(deps, run.id);
    expect(second).toMatchObject({ status: "success", attempt_count: 2, session_id: sessionId });
    const session = await pool.query(
      "SELECT session_status FROM chat_session WHERE id = $1",
      [sessionId],
    );
    expect(session.rows[0]!.session_status).toBe("success");
    const output = await pool.query<{ id: string; session_id: string }>(
      "SELECT id::text, session_id::text FROM job_run_output WHERE run_id = $1",
      [run.id],
    );
    expect(output.rows[0]!.session_id).toBe(sessionId);
    const messages = await pool.query<{ role: string; text: string }>(
      "SELECT role, content #>> '{content,0,text}' AS text FROM chat_message WHERE session_id = $1 ORDER BY seq",
      [sessionId],
    );
    expect(messages.rows.map((row) => row.role)).toEqual([
      "user", "assistant", "user", "assistant", "assistant",
    ]);
    expect(messages.rows[0]!.text).toContain("以下是数据库内固化的流程提示词");
    expect(messages.rows[1]!.text).toContain("第一次固定失败");
    expect(messages.rows[2]!.text).toContain("系统正在重试作业");
    expect(messages.rows[4]!.text).toContain(
      `[查看任务结果 #${output.rows[0]!.id}](/?result=job-output:${output.rows[0]!.id})`,
    );
  });

  it("真实 agent_flow 与交互对话共用 AgentSessionRunner、普通工具权限和结果入口", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = models.getModels("faux")[0]!;
    setAiRuntimeForTests({
      models,
      model,
      provider: "faux",
      providerName: "Faux",
      modelId: model.id,
    });
    try {
      let releaseFinal!: () => void;
      const finalGate = new Promise<void>((resolve) => {
        releaseFinal = resolve;
      });
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("tool_catalog", { names: ["job_context_query"] })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          [fauxToolCall("job_context_query", { job_codes: ["daily_plan_flow"] }), ...dailyReadCalls()],
          { stopReason: "toolUse" },
        ),
        dailyWriteResponse(),
        async () => {
          await finalGate;
          return fauxAssistantMessage([
            fauxText("> AI 生成任务结果，已关联本次任务保存；不代表策略发布或交易执行。\n\n# 统一执行器"),
          ]);
        },
      ]);
      const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
      const execution = executeJobRun(
        { pool, databaseUrl: prepared!.url },
        run.id,
      );
      let runningMessages: Array<{ role: string }> = [];
      for (let index = 0; index < 100; index += 1) {
        runningMessages = (await pool.query<{ role: string }>(
          "SELECT role FROM chat_message WHERE session_id = $1 ORDER BY seq",
          [run.session_id],
        )).rows;
        if (runningMessages.length >= 11) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const runningStatus = (await pool.query<{ session_status: string }>(
        "SELECT session_status FROM chat_session WHERE id = $1",
        [run.session_id],
      )).rows[0]!.session_status;
      releaseFinal();
      const finished = await execution;
      expect(runningMessages.map((row) => row.role)).toEqual([
        "user", "assistant", "tool", "assistant", ...Array(5).fill("tool"), "assistant", "tool",
      ]);
      expect(runningStatus).toBe("running");
      const toolErrors = await pool.query("SELECT content->>'toolName' AS tool, content->'content' AS error FROM chat_message WHERE session_id=$1 AND role='tool' AND content->>'isError'='true'", [run.session_id]);
      expect(toolErrors.rows).toEqual([]);
      expect(finished).toMatchObject({ status: "success", session_id: run.session_id });
      const messages = await pool.query(
        "SELECT role FROM chat_message WHERE session_id = $1 ORDER BY seq",
        [run.session_id],
      );
      expect(messages.rows.map((row) => row.role)).toEqual([
        ...runningMessages.map((row) => row.role), "assistant", "assistant",
      ]);
      const events = await pool.query<{ event_type: string }>(
        "SELECT event_type FROM chat_session_event WHERE session_id = $1 ORDER BY id",
        [run.session_id],
      );
      expect(events.rows.map((row) => row.event_type)).toEqual(
        expect.arrayContaining(["session_status", "message_completed", "ui_refresh"]),
      );
      const activities = await pool.query<{ data: { phase: string; job_code?: string } }>(
        "SELECT data FROM chat_session_event WHERE session_id=$1 AND event_type='activity' ORDER BY id", [run.session_id],
      );
      expect(activities.rows.at(-1)?.data).toMatchObject({ phase: "saving", job_code: "daily_plan_flow" });
      expect((await pool.query(
        "SELECT session_id::text FROM agent_tool_audit WHERE tool_name = 'job_context_query' ORDER BY id DESC LIMIT 1",
      )).rows[0]!.session_id).toBe(run.session_id);
    } finally {
      setAiRuntimeForTests(null);
    }
  });

  it("agent_flow 接受正文开头的结果标记并统一置顶，进度文本或长度上限会受控续写", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = models.getModels("faux")[0]!;
    setAiRuntimeForTests({
      models,
      model,
      provider: "faux",
      providerName: "Faux",
      modelId: model.id,
    });
    try {
      faux.setResponses([
        (context) => {
          expect(context.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
            "daily_plan_context_query", "swing_signal_query", "pool_attention_write",
          ]));
          return fauxAssistantMessage(dailyReadCalls(), { stopReason: "toolUse" });
        },
        dailyWriteResponse(),
        fauxAssistantMessage([fauxText("> AI 生成任务结果，已关联本次任务保存；不代表策略发布或交易执行。")]),
        fauxAssistantMessage([fauxText("")], { stopReason: "length" }),
        fauxAssistantMessage([
          fauxText("# 截断后完成\n\n> AI 生成任务结果，已关联本次任务保存；不代表策略发布或交易执行。\n\n正文"),
        ]),
      ]);
      const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
      const finished = await executeJobRun({ pool, databaseUrl: prepared!.url }, run.id);
      expect(finished).toMatchObject({ status: "success", attempt_count: 1, next_retry_at: null });
      const messages = await pool.query<{ role: string; text: string }>(
        "SELECT role, content #>> '{content,0,text}' AS text FROM chat_message WHERE session_id = $1 ORDER BY seq",
        [run.session_id],
      );
      const userMessages = messages.rows.filter((row) => row.role === "user");
      expect(userMessages).toHaveLength(3);
      expect(userMessages[1]!.text).toContain("已有的完整工具结果继续");
      expect(userMessages[2]!.text).toContain("已有的完整工具结果继续");
      expect(userMessages[2]!.text).toContain("本次尚未成功完成的必需工具：无");
      expect(messages.rows.every((row) => !row.text?.includes("任务将在计划时间自动重试"))).toBe(true);
      const output = (await pool.query<{ markdown: string }>(
        "SELECT markdown FROM job_run_output WHERE run_id = $1",
        [run.id],
      )).rows[0]!.markdown;
      expect(output).toBe("> AI 生成任务结果，已关联本次任务保存；不代表策略发布或交易执行。\n\n# 截断后完成\n\n正文");
    } finally {
      setAiRuntimeForTests(null);
    }
  });

  it("agent_flow 只有完成横幅但漏做必需工具时有界续写并进入重试", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = models.getModels("faux")[0]!;
    setAiRuntimeForTests({
      models,
      model,
      provider: "faux",
      providerName: "Faux",
      modelId: model.id,
    });
    try {
      faux.setResponses(Array.from({ length: 4 }, () =>
        fauxAssistantMessage([fauxText("> AI 生成任务结果，已关联本次任务保存；不代表策略发布或交易执行。\n\n# 声称已完成")])));
      const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
      const finished = await executeJobRun({
        pool,
        databaseUrl: prepared!.url,
        retryDelayMs: 1_000,
      }, run.id);
      expect(finished).toMatchObject({ status: "queued", attempt_count: 1 });
      expect(finished!.log).toContain("未在 4 个受控执行段内生成完整最终结果");
      expect((await pool.query(
        "SELECT count(*)::int AS count FROM job_run_output WHERE run_id = $1",
        [run.id],
      )).rows[0]!.count).toBe(0);
    } finally {
      setAiRuntimeForTests(null);
    }
  });

  it("集合竞价任务成功后激活结构化判断并刷新打板机会", async () => {
    await pool.query("INSERT INTO market_instrument (code,name,kind) VALUES ('990091.SZ','竞价机会测试','stock')");
    const planRun = await queueManualJob(pool, "daily_plan_flow", "2026-08-18");
    const planOutput = (await pool.query<{ id: string }>(
      `INSERT INTO job_run_output
         (job_id, run_id, session_id, output_type, target_date, markdown, sha256, status, source,
          strategy_change_seq, strategy_snapshot_hash)
       SELECT job_id, id, session_id, 'daily_plan', target_date, '# 每日计划', repeat('a', 64),
              'generated', 'agent_flow', strategy_change_seq, strategy_snapshot_hash
         FROM job_run WHERE id = $1
       RETURNING id::text`,
      [planRun.id],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO daily_plan_playbook
         (source_job_run_id, plan_output_id, target_date, item_kind, instrument_id, code, name,
          grade, priority, action, trigger_kind, headline, evidence_md, risk_md, status)
       SELECT $1, $2, '2026-08-18', 'off_pool_opportunity', id, code, name,
              'A', 1, 'observe', 'condition', '竞价确认后再决定是否入场', '原计划证据', '高开回落风险', 'active'
         FROM market_instrument WHERE code = '990091.SZ'`,
      [planRun.id, planOutput],
    );

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = models.getModels("faux")[0]!;
    setAiRuntimeForTests({
      models,
      model,
      provider: "faux",
      providerName: "Faux",
      modelId: model.id,
    });
    try {
      vi.spyOn(hithinkDatasets, "fetchHithinkDatasetAndStore").mockRejectedValue(new Error("测试上游数据未就绪"));
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("auction_context_query", { date: "2026-08-19" }),
          fauxToolCall("strategy_document_query", { codes: ["limit_up_board"] }),
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage(
          [fauxToolCall("fetch_hithink_data", { requests: [
            { capability: "auction_short_term_benchmark", date: "2026-08-19" },
            { capability: "auction_snapshot", stage: "final", codes: ["990091.SZ"] },
          ] })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          [fauxToolCall("auction_assessment_write", {
            items: [{
              code: "990091.SZ",
              conclusion: "unavailable",
              review_type: "data_insufficient",
              metrics_summary: "上游测试响应未就绪，无可用竞价字段",
              assessment_summary: "竞价数据缺失，不能验证原计划",
              benchmark_tags: ["测试缺数"],
              data_status: "missing",
              data_time: "2026-08-19T01:30:05.000Z",
            }],
          })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([
          fauxText("> AI 生成任务结果，已关联本次任务保存；不代表策略发布或交易执行。\n\n# 集合竞价研判完成"),
        ]),
      ]);
      const run = await queueManualJob(pool, "auction_opportunity_assessment", "2026-08-19");
      const finished = await executeJobRun({ pool, databaseUrl: prepared!.url }, run.id);
      expect(finished).toMatchObject({ status: "success", session_id: run.session_id });

      const assessment = await pool.query<{
        status: string;
        output_id: string | null;
        conclusion: string;
      }>(
        `SELECT assessment.status, assessment.assessment_output_id::text AS output_id, assessment.conclusion
           FROM daily_plan_auction_assessment assessment
          WHERE assessment.source_job_run_id = $1`,
        [run.id],
      );
      const output = await pool.query<{ id: string }>(
        "SELECT id::text FROM job_run_output WHERE run_id = $1",
        [run.id],
      );
      expect(assessment.rows).toEqual([{
        status: "active",
        output_id: output.rows[0]!.id,
        conclusion: "unavailable",
      }]);

      const board = await api(server.baseUrl, "GET", "/api/plans/latest");
      expect(board.status).toBe(200);
      expect(board.json).toMatchObject({
        opportunities: [{
          code: "990091.SZ",
          auction_assessment: {
            output_id: output.rows[0]!.id,
            conclusion: "unavailable",
            review_type: "data_insufficient",
            benchmark_tags: ["测试缺数"],
          },
        }],
      });
      const refresh = await pool.query<{ data: { targets: string[] } }>(
        `SELECT data FROM chat_session_event
          WHERE session_id = $1 AND event_type = 'ui_refresh'
          ORDER BY id DESC LIMIT 1`,
        [run.session_id],
      );
      expect(refresh.rows[0]!.data.targets).toContain("dashboard");
      expect(refresh.rows[0]!.data.targets).toContain("market");
    } finally {
      vi.restoreAllMocks();
      setAiRuntimeForTests(null);
    }
  });

  it("用户中断任务 Agent 后任务与普通对话收敛为 cancelled 且不自动重试", async () => {
    const faux = fauxProvider({ tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = models.getModels("faux")[0]!;
    setAiRuntimeForTests({
      models,
      model,
      provider: "faux",
      providerName: "Faux",
      modelId: model.id,
    });
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxText("任务仍在运行。".repeat(100))]),
      ]);
      const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
      const execution = executeJobRun({ pool, databaseUrl: prepared!.url }, run.id);
      let active = null;
      for (let index = 0; index < 100; index += 1) {
        active = getActiveAgentRun(run.session_id!);
        if (active) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(active).not.toBeNull();
      controlAgentRun({
        sessionId: run.session_id!,
        expectedRunId: active!.runId,
        action: "abort",
      });
      const finished = await execution;
      expect(finished).toMatchObject({ status: "cancelled", attempt_count: 1 });
      expect(finished?.next_retry_at).toBeNull();
      expect(
        (await pool.query("SELECT session_status FROM chat_session WHERE id = $1", [run.session_id])).rows[0]!.session_status,
      ).toBe("cancelled");
    } finally {
      setAiRuntimeForTests(null);
    }
  }, 15_000);

  it("服务重启把遗留 running 任务收敛为同一对话的待重试状态", async () => {
    await pool.query("UPDATE job_definition SET enabled = false");
    const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
    const sessionId = run.session_id!;
    const now = new Date("2026-08-17T02:00:00Z");
    await pool.query(
      "UPDATE job_run SET status = 'running', attempt_count = 1, started_at = $2 WHERE id = $1",
      [run.id, new Date("2026-08-17T01:59:00Z")],
    );
    await updateSessionStatus(pool, sessionId, {
      status: "running",
      at: new Date("2026-08-17T01:59:00Z"),
    });

    const scheduler = new JobScheduler({
      pool,
      databaseUrl: prepared!.url,
      now: () => now,
      retryDelayMs: 60_000,
    });
    await scheduler.start();
    await scheduler.stop();

    const recovered = await pool.query(
      "SELECT status, attempt_count, session_id::text, next_retry_at FROM job_run WHERE id = $1",
      [run.id],
    );
    expect(recovered.rows[0]).toMatchObject({
      status: "queued",
      attempt_count: 1,
      session_id: sessionId,
    });
    expect(new Date(recovered.rows[0]!.next_retry_at).toISOString()).toBe("2026-08-17T02:01:00.000Z");
    expect(
      (await pool.query("SELECT session_status FROM chat_session WHERE id = $1", [sessionId])).rows[0]!.session_status,
    ).toBe("queued");
    expect(
      (await pool.query("SELECT content #>> '{content,0,text}' AS text FROM chat_message WHERE session_id = $1 ORDER BY seq DESC LIMIT 1", [sessionId])).rows[0]!.text,
    ).toContain("服务重启");
  });

  it("外部 script 作业已拒绝；agent_flow Markdown 原子归入任务结果", async () => {
    await expect(
      createJobDefinition(pool, {
        code: "unsafe_script",
        name: "非法脚本",
        cron: "0 0 * * *",
        job_type: "script",
        config: { command_id: "python3 -c 'boom'" },
      }),
    ).rejects.toMatchObject({ httpStatus: 400 });

    const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
    expect(run.session_id).toBeTruthy();
    const finished = await executeJobRun(
      {
        pool,
        databaseUrl: prepared!.url,
        agentFlow: async () => "> AI 生成预览，未经用户确认，不是交易建议，也未写入内容库或业务表。\n\n# 测试结果",
      },
      run.id,
    );
    expect(finished).toMatchObject({ status: "success", task_run_id: null });
    expect(finished?.result_md).toBeNull();
    const output = await pool.query(
      "SELECT output_type, markdown, strategy_change_seq::text, strategy_snapshot_hash FROM job_run_output WHERE run_id = $1",
      [run.id],
    );
    expect(output.rows[0]).toMatchObject({ output_type: "daily_plan", strategy_change_seq: "0" });
    expect(output.rows[0]!.markdown).toContain("# 测试结果");
    expect(output.rows[0]!.strategy_snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Number((await pool.query("SELECT count(*) FROM task_run")).rows[0]!.count)).toBe(0);
  });

  it("结果已事务入账后，对话链接同步失败不会把成功任务反写为重试", async () => {
    const run = await queueManualJob(pool, "daily_plan_flow", "2026-08-17");
    await pool.query(`
      CREATE FUNCTION test_reject_result_link() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.content #>> '{content,0,text}' LIKE '任务结果已保存%' THEN
          RAISE EXCEPTION '测试：拒绝结果链接消息';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_reject_result_link_trigger
      BEFORE INSERT ON chat_message FOR EACH ROW EXECUTE FUNCTION test_reject_result_link();
    `);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const finished = await executeJobRun(
        {
          pool,
          databaseUrl: prepared!.url,
          agentFlow: async () => "# 已完成结果",
        },
        run.id,
      );
      expect(finished).toMatchObject({ status: "success", attempt_count: 1 });
      expect((await pool.query("SELECT status FROM job_run WHERE id = $1", [run.id])).rows[0]!.status).toBe("success");
      expect(Number((await pool.query("SELECT count(*) FROM job_run_output WHERE run_id = $1", [run.id])).rows[0]!.count)).toBe(1);
      expect((await pool.query("SELECT session_status FROM chat_session WHERE id = $1", [run.session_id])).rows[0]!.session_status).toBe("success");
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("已入账"), expect.anything());
    } finally {
      errorLog.mockRestore();
      await pool.query("DROP TRIGGER test_reject_result_link_trigger ON chat_message");
      await pool.query("DROP FUNCTION test_reject_result_link()");
    }
  });

  it("作业页面 API 只保留启停、手动触发、历史和详情", async () => {
    const rejectedCreate = await api(server.baseUrl, "POST", "/api/jobs", {
      code: "api_flow", name: "API 流程", cron: "5 18 * * 1-5", job_type: "agent_flow", config: {},
    });
    expect(rejectedCreate.status).toBe(404);
    const code = "daily_plan_flow";
    await pool.query(
      "UPDATE job_definition SET updated_at = '2026-08-18T08:09:10.123456Z' WHERE code = $1",
      [code],
    );
    const listed = await api(server.baseUrl, "GET", "/api/jobs");
    const listedJob = (listed.json as unknown as Array<{ code: string; updated_at: string }>)
      .find((job) => job.code === code);
    expect(listedJob?.updated_at).toBe("2026-08-18T08:09:10.123456Z");
    const oldUpdate = await api(server.baseUrl, "PATCH", `/api/jobs/${code}`, {
      base_updated_at: listedJob!.updated_at, enabled: false,
    });
    expect(oldUpdate.status).toBe(404);
    const paused = await api(server.baseUrl, "PATCH", `/api/jobs/${code}/control`, {
      base_updated_at: listedJob!.updated_at,
      enabled: false,
    });
    expect(paused.status).toBe(200);
    expect(paused.json.enabled).toBe(false);
    expect(paused.json.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const staleUpdate = await api(server.baseUrl, "PATCH", `/api/jobs/${code}/control`, {
      base_updated_at: listedJob!.updated_at,
      enabled: true,
    });
    expect(staleUpdate.status).toBe(409);
    expect((staleUpdate.json.error as { code: string }).code).toBe("CONFLICT");

    const triggered = await api(server.baseUrl, "POST", `/api/jobs/${code}/trigger`, {
      target_date: "2026-08-18",
    });
    expect(triggered.status).toBe(202);
    expect(triggered.json.status).toBe("queued");
    expect(triggered.json.session_id).toBeTruthy();
    const runId = String(triggered.json.id);

    const runs = await api(server.baseUrl, "GET", `/api/jobs/${code}/runs?limit=5`);
    expect(runs.status).toBe(200);
    expect(runs.json).toEqual([expect.objectContaining({ id: runId })]);
    const detail = await api(server.baseUrl, "GET", `/api/job-runs/${runId}`);
    expect(detail.status).toBe(200);
    expect((detail.json.job as { code: string }).code).toBe(code);
    expect(detail.json.outputs).toEqual([]);

  });
});
