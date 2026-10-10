import crypto from "node:crypto";
import type pg from "pg";
import { apiErrors } from "../../http/router.js";

type Db = Pick<pg.Pool | pg.PoolClient, "query">;
const SAFE_SETTINGS = `enabled, job_codes,
  CASE WHEN personal_webhook IS NULL AND personal_sign_secret IS NULL THEN enabled ELSE personal_enabled END AS personal_enabled,
  COALESCE(personal_webhook, webhook) IS NOT NULL AS personal_webhook_configured,
  COALESCE(personal_sign_secret, sign_secret) IS NOT NULL AS personal_sign_secret_configured,
  CASE WHEN strategy_webhook IS NULL AND strategy_sign_secret IS NULL THEN enabled ELSE strategy_enabled END AS strategy_enabled,
  COALESCE(strategy_webhook, webhook) IS NOT NULL AS strategy_webhook_configured,
  COALESCE(strategy_sign_secret, sign_secret) IS NOT NULL AS strategy_sign_secret_configured,
  webhook IS NOT NULL AS webhook_configured, sign_secret IS NOT NULL AS sign_secret_configured,
  revision, personal_revision, strategy_revision, updated_at`;
const SAFE_DELIVERY = `id::text, output_id::text, kind, channel, content, status, attempts, error, created_at, sent_at, next_attempt_at`;
export const TEST_MESSAGE =
  "Stock 飞书推送测试\n连接验证消息，不包含持仓或计划内容。\n收到此消息表示当前群机器人配置可用。";
export const AGENT_NOTIFICATION_SUMMARY_MAX_CHARS = 600;

export type NotificationChannel = "personal" | "strategy";

export function validateWebhook(value: string): string {
  // 固定官方 HTTPS 地址、无重定向；不提供可请求任意内网地址的通用 Webhook。
  if (
    !/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]{16,100}$/.test(
      value,
    )
  ) {
    throw apiErrors.badRequest(
      "请输入飞书官方群机器人 Webhook 地址（不含查询参数）",
    );
  }
  return value;
}

export async function getNotificationSettings(db: Db) {
  const settings = (
    await db.query(
      `SELECT ${SAFE_SETTINGS} FROM notification_setting WHERE singleton`,
    )
  ).rows[0]!;
  const jobs = (
    await db.query(
      "SELECT code, name, enabled FROM job_definition WHERE job_type='agent_flow' ORDER BY id",
    )
  ).rows;
  return { ...settings, jobs, strategy_jobs: jobs.filter((job) => job.code !== "daily_plan_flow"), strategy_job_codes: settings.job_codes };
}

export async function updateNotificationSettings(
  pool: pg.Pool,
  input: Record<string, unknown>,
) {
  const allowed = new Set([
    "personal_enabled", "personal_webhook", "personal_sign_secret",
    "strategy_enabled", "strategy_webhook", "strategy_sign_secret",
    "strategy_job_codes", "enabled", "webhook", "sign_secret", "job_codes",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw apiErrors.badRequest("推送设置包含未知字段");

  const booleans = ["personal_enabled", "strategy_enabled", "enabled"];
  for (const key of booleans) {
    if (input[key] !== undefined && typeof input[key] !== "boolean")
      throw apiErrors.badRequest(`${key} 必须为布尔值`);
  }
  const credentialFields = [
    "personal_webhook", "personal_sign_secret", "strategy_webhook", "strategy_sign_secret",
    "webhook", "sign_secret",
  ];
  for (const field of credentialFields) {
    if (
      input[field] !== undefined &&
      (typeof input[field] !== "string" || (input[field] as string).length > 1024)
    ) throw apiErrors.badRequest("推送凭据必须为不超过 1024 字符的字符串");
  }
  const rawJobCodes = input.strategy_job_codes ?? input.job_codes;
  if (
    rawJobCodes !== undefined && rawJobCodes !== null &&
    (!Array.isArray(rawJobCodes) || rawJobCodes.length > 100 ||
      rawJobCodes.some((code) => typeof code !== "string" || !/^[a-z][a-z0-9_]{0,99}$/.test(code)))
  ) throw apiErrors.badRequest("策略任务必须为任务编码数组或空值（全部任务）");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const old = (
      await client.query("SELECT * FROM notification_setting WHERE singleton FOR UPDATE")
    ).rows[0]!;
    const legacy = input.webhook !== undefined || input.sign_secret !== undefined || input.enabled !== undefined;
    const value = (key: string, fallback: unknown): string | null => {
      if (input[key] === undefined) return typeof fallback === "string" ? fallback : null;
      return (input[key] as string).trim() || null;
    };
    const personalWebhook = value("personal_webhook", legacy ? (input.webhook === undefined ? old.personal_webhook ?? old.webhook : input.webhook) : old.personal_webhook ?? old.webhook);
    const personalSecret = value("personal_sign_secret", legacy ? (input.sign_secret === undefined ? old.personal_sign_secret ?? old.sign_secret : input.sign_secret) : old.personal_sign_secret ?? old.sign_secret);
    const strategyWebhook = value("strategy_webhook", legacy ? (input.webhook === undefined ? old.strategy_webhook ?? old.webhook : input.webhook) : old.strategy_webhook ?? old.webhook);
    const strategySecret = value("strategy_sign_secret", legacy ? (input.sign_secret === undefined ? old.strategy_sign_secret ?? old.sign_secret : input.sign_secret) : old.strategy_sign_secret ?? old.sign_secret);
    if (personalWebhook) validateWebhook(personalWebhook);
    if (strategyWebhook) validateWebhook(strategyWebhook);
    const personalEnabled = input.personal_enabled ?? (legacy ? input.enabled ?? old.personal_enabled ?? old.enabled : old.personal_enabled ?? old.enabled);
    const strategyEnabled = input.strategy_enabled ?? (legacy ? input.enabled ?? old.strategy_enabled ?? old.enabled : old.strategy_enabled ?? old.enabled);
    const jobCodes = rawJobCodes === undefined
      ? old.job_codes
      : rawJobCodes === null ? null : [...new Set(rawJobCodes as string[])];
    if (jobCodes?.length) {
      const valid = await client.query(
        "SELECT code FROM job_definition WHERE job_type='agent_flow' AND code <> 'daily_plan_flow' AND code=ANY($1::text[])",
        [jobCodes],
      );
      if (valid.rows.length !== jobCodes.length) throw apiErrors.badRequest("只能订阅现有策略任务");
    }
    if (personalEnabled && (!personalWebhook || !personalSecret))
      throw apiErrors.badRequest("启用个人消息前请填写个人 Webhook 和签名密钥");
    if (strategyEnabled && (!strategyWebhook || !strategySecret))
      throw apiErrors.badRequest("启用策略任务消息前请填写策略 Webhook 和签名密钥");
    const changedPersonal = personalWebhook !== (old.personal_webhook ?? old.webhook) || personalSecret !== (old.personal_sign_secret ?? old.sign_secret);
    const changedStrategy = strategyWebhook !== (old.strategy_webhook ?? old.webhook) || strategySecret !== (old.strategy_sign_secret ?? old.sign_secret);
    const changed = changedPersonal || changedStrategy;
    await client.query(
      `UPDATE notification_setting SET
        enabled=$1, webhook=$2, sign_secret=$3,
        personal_enabled=$4, personal_webhook=$5, personal_sign_secret=$6,
        strategy_enabled=$7, strategy_webhook=$8, strategy_sign_secret=$9,
        revision=revision+$10, personal_revision=personal_revision+$11,
        strategy_revision=strategy_revision+$12, job_codes=$13, updated_at=now() WHERE singleton`,
      [personalEnabled, personalWebhook, personalSecret,
        personalEnabled, personalWebhook, personalSecret, strategyEnabled, strategyWebhook, strategySecret,
        changed ? 1 : 0, changedPersonal ? 1 : 0, changedStrategy ? 1 : 0, jobCodes],
    );
    if (changedPersonal) await client.query(`UPDATE notification_delivery SET status='cancelled', error='个人消息凭据已变更，请等待新的每日计划', lease_until=NULL WHERE channel='personal' AND status IN ('pending','failed')`);
    if (changedStrategy) await client.query(`UPDATE notification_delivery SET status='cancelled', error='策略任务凭据已变更，请等待新的策略任务结果', lease_until=NULL WHERE channel='strategy' AND status IN ('pending','failed')`);
    const settings = await getNotificationSettings(client);
    await client.query("COMMIT");
    return settings;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
// 保留完整短字段；过长条件不截成可能改变含义的半句。
function field(value: unknown, max: number): string {
  const plain = String(value ?? "")
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
    .replace(/\s+/g, " ")
    .trim();
  return [...plain].length > max ? "内容较长，请在系统查看完整原文" : plain;
}

/** 没有内容的明细行整行省略，不补占位备注。 */
function detailLine(label: string, value: string | null | undefined, max: number): string | null {
  const text = field(value, max);
  return text ? `   ${label}：${text}` : null;
}

/** 只提取明确的结论段；跳过代码块，不把中间进度或任意长报告头部当结论。 */
export function extractConclusion(markdown: string): string | null {
  const headings = ["结论摘要", "推送摘要", "核心结论", "结论", "总结"];
  const sections: Array<{ name: string; level: number; lines: string[] }> = [];
  let current: (typeof sections)[number] | null = null;
  let fence = "";
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1]!;
      else if (
        fenceMatch[1]![0] === fence[0] &&
        fenceMatch[1]!.length >= fence.length
      )
        fence = "";
      continue;
    }
    if (fence) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const name = heading[2]!.replace(/[:：]$/, "").trim();
      const level = heading[1]!.length;
      if (current && level <= current.level) current = null;
      if (headings.includes(name)) {
        current = { name, level, lines: [] };
        sections.push(current);
        continue;
      }
    }
    if (current) current.lines.push(line);
  }
  const selected = headings
    .map((name) =>
      [...sections].reverse().find((section) => section.name === name),
    )
    .find(Boolean);
  if (!selected) return null;
  const text = selected.lines.join("\n").trim();
  if (!text || /^(?:无|暂无|无结论|暂无结论|无可推送结论)[。.!！]?$/.test(text))
    return "";
  // 不截断条件与例外；违反摘要长度契约时只提示阅读原文。
  if ([...text].length > AGENT_NOTIFICATION_SUMMARY_MAX_CHARS)
    return "本次结论较长，请在 Stock 工作台查看完整结果，避免遗漏条件与风险。";
  return text.replace(/</g, "＜").replace(/>/g, "＞");
}

type DailyPlanItem = {
  item_kind: "position_action" | "off_pool_opportunity";
  code: string;
  name: string;
  grade: string | null;
  priority: number;
  action: string;
  trigger_kind: string;
  price_lower: string | number | null;
  price_upper: string | number | null;
  headline: string;
  auction_md: string | null;
  intraday_md: string | null;
  evidence_md: string | null;
  missing_md: string | null;
  invalidation_md: string | null;
  risk_md: string | null;
};

type DailyPlanSignal = {
  code: string;
  name: string;
  pool: string;
  attention_status: string;
  attention_reason: string;
  attention_from: string;
  attention_until: string;
};

type DailyPlanOutput = {
  id: string;
  created_at: string | Date;
  data_gaps: unknown;
  session_id: string | null;
};

const ACTION_LABELS: Record<string, string> = {
  exit: "退出",
  reduce: "减仓",
  buy: "买入",
  hold: "持有",
  observe: "观察",
};

function triggerLabel(item: DailyPlanItem): string {
  if (item.trigger_kind === "price_range") {
    return `价格区间 ${item.price_lower ?? "未设下限"}～${item.price_upper ?? "未设上限"}；仍需核对其他条件`;
  }
  return item.trigger_kind === "open"
    ? "开盘时复核预案条件"
    : "满足原预案全部条件后再评估";
}

export const DAILY_PLAN_NOTIFICATION_MAX_CHARS = 3_200;

function charLength(value: string): number {
  return [...value].length;
}

function appendBudgetedSection(
  lines: string[],
  title: string,
  emptyText: string,
  blocks: string[][],
  budget: number,
  omittedNoun: string,
): void {
  const section = [title];
  if (!blocks.length) {
    section.push(emptyText);
    lines.push("", ...section);
    return;
  }
  let used = charLength(title) + 1;
  let shown = 0;
  for (const block of blocks) {
    const blockLength = charLength(block.join("\n")) + 1;
    // 为“其余 N 项”提示预留空间，避免为了多塞一行导致摘要失去完整性。
    if (used + blockLength + 45 > budget) break;
    section.push(...block);
    used += blockLength;
    shown += 1;
  }
  if (!shown) {
    section.push(blocks[0]![0]!);
    shown = 1;
  }
  if (shown < blocks.length) {
    section.push(
      `另有 ${blocks.length - shown} ${omittedNoun}，请在 Stock 工作台查看完整内容。`,
    );
  }
  lines.push("", ...section);
}

async function buildDailyPlanConclusion(
  db: Db,
  output: DailyPlanOutput,
  header: string,
  footer: string,
  conclusion: string | null,
  personalOnly = false,
): Promise<string | null> {
  const playbook = await db.query<DailyPlanItem>(
    `SELECT item_kind, code, name, grade, priority, action, trigger_kind,
      price_lower, price_upper, headline, auction_md, intraday_md, evidence_md, missing_md, invalidation_md, risk_md
    FROM daily_plan_playbook WHERE plan_output_id=$1 AND status <> 'draft'
    ORDER BY CASE item_kind WHEN 'position_action' THEN 0 ELSE 1 END,
      CASE action WHEN 'exit' THEN 0 WHEN 'reduce' THEN 1 ELSE 2 END, priority, id`,
    [output.id],
  );
  const signals = !personalOnly && output.session_id
    ? await db.query<DailyPlanSignal>(
        `WITH latest_write AS (
      SELECT args FROM agent_tool_audit WHERE session_id=$1 AND tool_name='pool_attention_write'
        AND status='ok' AND jsonb_typeof(args->'items')='array' ORDER BY id DESC LIMIT 1
    )
    SELECT item->>'code' AS code, COALESCE(instrument.name, item->>'code') AS name,
      item->>'pool' AS pool, item->>'attention_status' AS attention_status,
      item->>'attention_reason' AS attention_reason, item->>'attention_from' AS attention_from,
      item->>'attention_until' AS attention_until
    FROM latest_write CROSS JOIN LATERAL jsonb_array_elements(latest_write.args->'items') item
    LEFT JOIN market_instrument instrument ON instrument.code=item->>'code'
    WHERE item->>'action'='mark'
    ORDER BY CASE item->>'attention_status' WHEN 'qualified' THEN 0 ELSE 1 END,
      CASE item->>'pool' WHEN 'short' THEN 0 ELSE 1 END, item->>'code'`,
        [output.session_id],
      )
    : { rows: [] as DailyPlanSignal[] };
  const positions = playbook.rows.filter(
    (item) => item.item_kind === "position_action",
  );
  const opportunities = playbook.rows.filter(
    (item) => item.item_kind === "off_pool_opportunity",
  );
  if (
    !conclusion &&
    !positions.length &&
    (personalOnly || (!signals.rows.length && !opportunities.length))
  )
    return null;

  const lines = [
    header,
    `生成：${new Date(output.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`,
    "以下均为条件预案，不代表信号已触发或交易已执行；盘前/盘中须按计划复核。",
  ];
  if (conclusion) lines.push("", "【结论摘要】", field(conclusion, 450));

  const positionBlocks = positions.map((item, index) => [
    `${index + 1}. ${field(item.name, 20)} ${item.code}｜${ACTION_LABELS[item.action] ?? "观察"}｜${field(triggerLabel(item), 90)}`,
    `   预案：${field(item.headline, 90)}`,
    detailLine("复核", [item.auction_md, item.intraday_md].filter(Boolean).join("；"), 120),
    detailLine("风险/失效", [item.risk_md, item.invalidation_md, item.missing_md].filter(Boolean).join("；"), 120),
  ].filter((line): line is string => line !== null));
  appendBudgetedSection(
    lines,
    `【持仓预案｜${positions.length} 项】`,
    "当前没有需要展示的持仓预案。",
    positionBlocks,
    700,
    "项持仓预案",
  );

  const signalBlocks = personalOnly ? [] : signals.rows.map((signal, index) => {
    const pool =
      signal.pool === "short"
        ? "短线"
        : signal.pool === "long"
          ? "长线/波段"
          : signal.pool;
    const status =
      signal.attention_status === "qualified" ? "已符合" : "即将符合";
    return [
      `${index + 1}. ${field(signal.name, 20)} ${signal.code}｜${pool}｜${status}｜${signal.attention_from}～${signal.attention_until}`,
      detailLine("信号", signal.attention_reason, 180),
    ].filter((line): line is string => line !== null);
  });
  if (!personalOnly) appendBudgetedSection(
    lines,
    `【标的信号｜${signals.rows.length} 项】`,
    "本轮没有保留池内已符合或即将符合的标的信号。",
    signalBlocks,
    650,
    "项标的信号",
  );

  const opportunityBlocks = personalOnly ? [] : opportunities.map((item, index) => [
    `${index + 1}. ${field(item.name, 20)} ${item.code}｜${item.grade ? `${item.grade} 级` : "未评级"}｜顺序 ${item.priority}`,
    `   预案：${field(item.headline, 100)}`,
    detailLine("竞价/盘中", [item.auction_md, item.intraday_md].filter(Boolean).join("；"), 140),
    detailLine("证据", item.evidence_md, 100),
    detailLine("风险/失效", [item.risk_md, item.invalidation_md, item.missing_md].filter(Boolean).join("；"), 130),
  ].filter((line): line is string => line !== null));
  if (!personalOnly) appendBudgetedSection(
    lines,
    `【打板机会预案｜${opportunities.length} 项】`,
    "本轮没有形成有效打板机会。",
    opportunityBlocks,
    1_000,
    "项打板机会",
  );

  if (Array.isArray(output.data_gaps) && output.data_gaps.length) {
    lines.push(
      "",
      `数据提示：任务有 ${output.data_gaps.length} 项缺口，详见原文。`,
    );
  }
  lines.push("", footer);
  const content = lines.join("\n");
  // 各分组按字符预算只追加完整条目；这里兜底防止未来字段扩展突破移动端摘要上限。
  if (charLength(content) > DAILY_PLAN_NOTIFICATION_MAX_CHARS) {
    return [
      header,
      `生成：${new Date(output.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`,
      "每日计划内容较多，已压缩为数量摘要；请在 Stock 工作台查看完整预案。",
      personalOnly
        ? `持仓预案 ${positions.length} 项`
        : `持仓预案 ${positions.length} 项｜标的信号 ${signals.rows.length} 项｜打板机会 ${opportunities.length} 项`,
      "",
      footer,
    ].join("\n");
  }
  return content;
}

export async function previewJobConclusion(
  db: Db,
  outputId?: string,
  jobCode?: string,
  options: { personalOnly?: boolean } = {},
): Promise<{
  output_id: string;
  job_code: string;
  job_name: string;
  content: string;
} | null> {
  const result = await db.query(
    `SELECT o.id::text, o.job_id::text, o.target_date::text, o.created_at, o.markdown,
      r.status AS run_status, r.data_gaps, r.account_id::text, account.name AS account_name, r.session_id::text AS session_id, j.code AS job_code, j.name AS job_name,
      EXISTS (SELECT 1 FROM job_run_output older WHERE older.job_id=o.job_id
        AND older.account_id IS NOT DISTINCT FROM o.account_id AND older.target_date=o.target_date AND older.id < o.id) AS revised
    FROM job_run_output o JOIN job_run r ON r.id=o.run_id JOIN job_definition j ON j.id=o.job_id
    LEFT JOIN portfolio_account account ON account.id=r.account_id
    WHERE j.job_type='agent_flow' AND (r.status='success' OR (r.status='partial' AND j.code='pre_market_news_scan')) AND o.source='agent_flow'
      AND o.status IN ('generated','approved') AND length(btrim(o.markdown))>0
      AND ($1::bigint IS NULL OR o.id=$1) AND ($2::text IS NULL OR j.code=$2)
    ORDER BY o.id DESC LIMIT 1`,
    [outputId ?? null, jobCode ?? null],
  );
  const output = result.rows[0];
  if (!output) return null;
  const conclusion = extractConclusion(output.markdown);
  const header = `Stock ${output.account_name ? `【${field(output.account_name,100)}】` : ""}${field(output.job_name, 60)}${output.revised ? "（更新版）" : ""}${output.run_status === "partial" ? "（部分成功）" : ""}｜任务日期 ${output.target_date}`;
  const footer = `结果 #${output.id}｜完整内容请在 Stock 工作台查看。`;
  const wrap = (content: string) => ({
    output_id: output.id,
    job_code: output.job_code,
    job_name: output.job_name,
    content,
  });
  if (output.job_code === "daily_plan_flow") {
    const content = await buildDailyPlanConclusion(
      db,
      output,
      header,
      footer,
      conclusion,
      options.personalOnly ?? false,
    );
    return content ? wrap(content) : null;
  }
  if (conclusion === null || !conclusion) return null;
  return wrap(
    [
      header,
      `生成：${new Date(output.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`,
      "",
      conclusion,
      ...(Array.isArray(output.data_gaps) && output.data_gaps.length
        ? [`数据提示：任务有 ${output.data_gaps.length} 项缺口，详见原文。`]
        : []),
      "",
      footer,
    ].join("\n"),
  );
}

/** 与任务结果保存共享事务；网络发送始终在提交后由独立工作器执行。 */
export async function enqueueJobConclusion(
  db: Db,
  outputId: string,
): Promise<void> {
  const settings = (
    await db.query(
      `SELECT personal_enabled, personal_webhook, personal_sign_secret,
        strategy_enabled, strategy_webhook, strategy_sign_secret,
        enabled, webhook, sign_secret, revision, personal_revision, strategy_revision, job_codes
       FROM notification_setting WHERE singleton FOR SHARE`,
    )
  ).rows[0]!;
  const summary = await previewJobConclusion(db, outputId, undefined, { personalOnly: true });
  if (!summary) return;
  const personal = summary.job_code === "daily_plan_flow";
  const legacyChannel = personal
    ? settings.personal_webhook == null && settings.personal_sign_secret == null
    : settings.strategy_webhook == null && settings.strategy_sign_secret == null;
  const enabled = personal
    ? (legacyChannel ? settings.enabled : settings.personal_enabled)
    : (legacyChannel ? settings.enabled : settings.strategy_enabled);
  const webhook = personal ? (settings.personal_webhook ?? settings.webhook) : (settings.strategy_webhook ?? settings.webhook);
  const secret = personal ? (settings.personal_sign_secret ?? settings.sign_secret) : (settings.strategy_sign_secret ?? settings.sign_secret);
  if (!enabled || !webhook || !secret) return;
  if (!personal && settings.job_codes !== null && !settings.job_codes.includes(summary.job_code)) return;
  await db.query(
    `INSERT INTO notification_delivery (output_id, kind, channel, channel_revision, content,account_id)
    VALUES ($1, $2, $3, $4, $5,(SELECT account_id FROM job_run_output WHERE id=$1)) ON CONFLICT (output_id) DO NOTHING`,
    [outputId, personal ? "daily_plan" : "agent_result", personal ? "personal" : "strategy", personal ? settings.personal_revision : settings.strategy_revision, summary.content],
  );
}

/** 盘中风险只走个人通道，不关联 Agent 任务结果。 */
export async function enqueueIntradayRiskAlert(
  db: Db,
  riskId: string,
  content: string,
): Promise<void> {
  const settings = (await db.query<{
    enabled: boolean;
    personal_enabled: boolean;
    personal_webhook: string | null;
    personal_sign_secret: string | null;
    webhook: string | null;
    sign_secret: string | null;
    personal_revision: number;
  }>(
    `SELECT enabled, personal_enabled, personal_webhook, personal_sign_secret,
            webhook, sign_secret, personal_revision
       FROM notification_setting WHERE singleton FOR SHARE`,
  )).rows[0];
  if (!settings) return;
  const webhook = settings.personal_webhook ?? settings.webhook;
  const secret = settings.personal_sign_secret ?? settings.sign_secret;
  const enabled = settings.personal_webhook == null && settings.personal_sign_secret == null
    ? settings.enabled
    : settings.personal_enabled;
  if (!enabled || !webhook || !secret) return;
  await db.query(
    `INSERT INTO notification_delivery
      (intraday_risk_id, kind, channel, channel_revision, content,account_id)
     VALUES ($1, 'intraday_risk', 'personal', $2, $3,(SELECT account_id FROM intraday_position_risk WHERE id=$1))
     ON CONFLICT DO NOTHING`,
    [riskId, settings.personal_revision, content],
  );
}

export async function queueTestNotification(db: Db, channel: NotificationChannel = "personal") {
  const result = await db.query(
    `INSERT INTO notification_delivery (kind, channel, channel_revision, content)
    SELECT 'test', $1, CASE WHEN $1='personal' THEN personal_revision ELSE strategy_revision END, $2 FROM notification_setting
     WHERE singleton
       AND CASE WHEN $1='personal' THEN COALESCE(personal_webhook, webhook) IS NOT NULL AND COALESCE(personal_sign_secret, sign_secret) IS NOT NULL
                ELSE COALESCE(strategy_webhook, webhook) IS NOT NULL AND COALESCE(strategy_sign_secret, sign_secret) IS NOT NULL END
    RETURNING ${SAFE_DELIVERY}`,
    [channel, TEST_MESSAGE.replace("飞书推送测试", channel === "personal" ? "飞书个人消息推送测试" : "飞书策略任务推送测试")],
  );
  if (!result.rows[0]) throw apiErrors.badRequest("请先保存对应 Webhook 和签名密钥");
  return result.rows[0];
}

export interface NotificationQuery {
  before?: string;
  status?: string;
  jobCode?: string;
  accountId?: string;
}
const DELIVERY_JOIN = `FROM notification_delivery d LEFT JOIN job_run_output o ON o.id=d.output_id
  LEFT JOIN job_definition j ON j.id=o.job_id LEFT JOIN portfolio_account account ON account.id=d.account_id`;
export async function listNotifications(db: Db, query: NotificationQuery = {}) {
  const result = await db.query(
    `SELECT d.id::text, d.output_id::text, d.kind, d.channel, d.status, d.attempts, d.error,
      d.created_at, d.sent_at, d.next_attempt_at, d.account_id::text, account.name AS account_name, j.code AS job_code, j.name AS job_name
    ${DELIVERY_JOIN} WHERE ($1::bigint IS NULL OR d.id<$1) AND ($2::text IS NULL OR d.status=$2)
      AND ($3::text IS NULL OR j.code=$3)
      AND ($4::bigint IS NULL OR d.account_id=$4 OR ($4=0 AND d.account_id IS NULL))
    ORDER BY d.id DESC LIMIT 21`,
    [query.before ?? null, query.status ?? null, query.jobCode ?? null, query.accountId ?? null],
  );
  const items = result.rows.slice(0, 20);
  return {
    items,
    next_cursor: result.rows.length > 20 ? items.at(-1)!.id : null,
  };
}
export async function getNotification(db: Db, id: string) {
  const result = await db.query(
    `SELECT d.id::text, d.output_id::text, d.kind, d.channel, d.content, d.status, d.attempts, d.error,
      d.created_at, d.sent_at, d.next_attempt_at, d.account_id::text, account.name AS account_name, j.code AS job_code, j.name AS job_name ${DELIVERY_JOIN} WHERE d.id=$1`,
    [id],
  );
  if (!result.rows[0]) throw apiErrors.notFound("通知不存在");
  return result.rows[0];
}

// 订阅暂停只影响尚未领取的任务结果；连接测试不受总开关或任务选择影响。
const SUBSCRIBED = `(d.kind='test' OR (CASE WHEN d.channel='personal' THEN CASE WHEN s.personal_webhook IS NULL AND s.personal_sign_secret IS NULL THEN s.enabled ELSE s.personal_enabled END
  ELSE CASE WHEN s.strategy_webhook IS NULL AND s.strategy_sign_secret IS NULL THEN s.enabled ELSE s.strategy_enabled END END AND (d.channel='personal' OR s.job_codes IS NULL OR EXISTS (
  SELECT 1 FROM job_run_output source JOIN job_definition job ON job.id=source.job_id
  WHERE source.id=d.output_id AND job.code=ANY(s.job_codes)))))`;
const SUPERSEDED = `EXISTS (SELECT 1 FROM job_run_output newer JOIN job_run_output original ON original.id=d.output_id
  JOIN job_run newer_run ON newer_run.id=newer.run_id
  WHERE newer.job_id=original.job_id AND newer.account_id IS NOT DISTINCT FROM original.account_id AND newer.target_date=original.target_date AND newer.id>original.id
    AND newer.source='agent_flow' AND newer.status IN ('generated','approved')
    AND (newer_run.status='success' OR (newer_run.status='partial' AND EXISTS (
      SELECT 1 FROM job_definition job WHERE job.id=newer.job_id AND job.code='pre_market_news_scan'))))`;

export async function retryNotification(db: Db, id: string) {
  const result = await db.query(
    `UPDATE notification_delivery d SET status='pending', attempts=0,
      next_attempt_at=now(), lease_until=NULL, error=NULL
    FROM notification_setting s WHERE s.singleton AND d.id=$1 AND d.status='failed'
      AND d.channel_revision=CASE WHEN d.channel='personal' THEN s.personal_revision ELSE s.strategy_revision END AND CASE WHEN d.channel='personal' THEN COALESCE(s.personal_webhook, s.webhook) IS NOT NULL AND COALESCE(s.personal_sign_secret, s.sign_secret) IS NOT NULL ELSE COALESCE(s.strategy_webhook, s.webhook) IS NOT NULL AND COALESCE(s.strategy_sign_secret, s.sign_secret) IS NOT NULL END
      AND ${SUBSCRIBED} AND d.created_at > now()-interval '1 day'
      AND NOT ${SUPERSEDED}
    RETURNING d.id::text`,
    [id],
  );
  if (!result.rows[0])
    throw apiErrors.conflict(
      "仅可补发当前渠道一天内失败的任务结果；请检查自动推送开关与通知状态",
    );
  return result.rows[0];
}

class DeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export async function sendFeishu(
  webhook: string,
  secret: string,
  content: string,
  fetcher = fetch,
): Promise<void> {
  validateWebhook(webhook);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sign = crypto
    .createHmac("sha256", `${timestamp}\n${secret}`)
    .update("")
    .digest("base64");
  let response: Response;
  let envelope: { code?: unknown };
  try {
    response = await fetcher(webhook, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp,
        sign,
        msg_type: "text",
        content: { text: content },
      }),
    });
    if (!response.ok)
      throw new DeliveryError(
        `飞书 HTTP ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    envelope = (await response.json()) as { code?: unknown };
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    // 不透传 fetch 错误、响应正文或 URL，避免把 Webhook 凭据写进日志/API。
    throw new DeliveryError("飞书连接超时、响应无效或网络异常", true);
  }
  if (envelope?.code !== 0) {
    const code =
      typeof envelope?.code === "number" && Number.isSafeInteger(envelope.code)
        ? envelope.code
        : null;
    throw new DeliveryError(
      code === null
        ? "飞书响应缺少成功标记"
        : `飞书拒绝消息（业务码 ${code}），请检查机器人安全设置`,
      code === 11232 || code === 11233,
    );
  }
}

/** 一次最多发送一条；数据库租约防止多个工作器领取同一条，重启后租约到期恢复。 */
export async function deliverNextNotification(
  pool: pg.Pool,
  fetcher = fetch,
): Promise<boolean> {
  await pool.query(`UPDATE notification_delivery d SET status='cancelled', lease_until=NULL,
    error='通知过期、渠道已变更或同任务同日期已有更新结果'
    FROM notification_setting s WHERE s.singleton AND (d.status IN ('pending','failed') OR (d.status='sending' AND d.lease_until<=now()))
      AND (d.created_at<=now()-interval '1 day' OR d.channel_revision<>CASE WHEN d.channel='personal' THEN s.personal_revision ELSE s.strategy_revision END
        OR ${SUPERSEDED})`);
  await pool.query(`UPDATE notification_delivery SET status='failed', error='发送中断且已达到重试上限', lease_until=NULL
    WHERE status='sending' AND lease_until<=now() AND attempts>=3`);
  const claimed = await pool.query(`WITH candidate AS (
    SELECT d.id FROM notification_delivery d CROSS JOIN notification_setting s
    WHERE s.singleton AND CASE WHEN d.channel='personal' THEN COALESCE(s.personal_webhook, s.webhook) IS NOT NULL AND COALESCE(s.personal_sign_secret, s.sign_secret) IS NOT NULL ELSE COALESCE(s.strategy_webhook, s.webhook) IS NOT NULL AND COALESCE(s.strategy_sign_secret, s.sign_secret) IS NOT NULL END AND d.channel_revision=CASE WHEN d.channel='personal' THEN s.personal_revision ELSE s.strategy_revision END
      AND ${SUBSCRIBED} AND d.attempts<3
      AND ((d.status='pending' AND d.next_attempt_at<=now()) OR (d.status='sending' AND d.lease_until<=now()))
    ORDER BY d.next_attempt_at, d.id FOR UPDATE OF d SKIP LOCKED LIMIT 1
  ) UPDATE notification_delivery d SET status='sending', attempts=attempts+1, lease_until=now()+interval '1 minute'
    FROM candidate c, notification_setting s WHERE d.id=c.id AND s.singleton
    RETURNING d.id::text, d.content, d.attempts, CASE WHEN d.channel='personal' THEN COALESCE(s.personal_webhook, s.webhook) ELSE COALESCE(s.strategy_webhook, s.webhook) END AS webhook, CASE WHEN d.channel='personal' THEN COALESCE(s.personal_sign_secret, s.sign_secret) ELSE COALESCE(s.strategy_sign_secret, s.sign_secret) END AS sign_secret`);
  const item = claimed.rows[0];
  if (!item) return false;
  try {
    await sendFeishu(item.webhook, item.sign_secret, item.content, fetcher);
    await pool.query(
      `UPDATE notification_delivery SET status='sent', sent_at=now(), lease_until=NULL, error=NULL
      WHERE id=$1 AND status='sending' AND attempts=$2`,
      [item.id, item.attempts],
    );
  } catch (error) {
    const failure =
      error instanceof DeliveryError
        ? error
        : new DeliveryError("通知发送或状态保存失败", true);
    const retry = failure.retryable && item.attempts < 3;
    await pool.query(
      `UPDATE notification_delivery SET status=$2, error=$3, lease_until=NULL,
      next_attempt_at=now()+($4::int * interval '1 second') WHERE id=$1 AND status='sending' AND attempts=$5`,
      [
        item.id,
        retry ? "pending" : "failed",
        failure.message,
        item.attempts === 1 ? 60 : 300,
        item.attempts,
      ],
    );
  }
  return true;
}

export class NotificationWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: Promise<void> | null = null;
  private stopped = true;
  constructor(private readonly pool: pg.Pool) {}
  start(): void {
    if (this.stopped) {
      this.stopped = false;
      this.schedule(0);
    }
  }
  private schedule(delay = 5_000): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.current = deliverNextNotification(this.pool)
        .then(() => {})
        .catch(() => {
          console.error("[notification] 通知工作器失败，请检查数据库连接");
        })
        .finally(() => {
          this.current = null;
          this.schedule();
        });
      this.timer?.unref();
    }, delay);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current;
  }
}
