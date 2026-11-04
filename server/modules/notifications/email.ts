// 独立邮件通知通道：与飞书推送完全解耦的 SMTP 设置、入队、投递与记录。
// 只做出站邮件；密码只存 PostgreSQL，不进入接口回显、日志、URL 或错误文本。
import MarkdownIt from "markdown-it";
import nodemailer from "nodemailer";
import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import { buildTomorrowPreview } from "../plans/tomorrow-preview.js";

type Db = Pick<pg.Pool | pg.PoolClient, "query">;

export const TEST_EMAIL_SUBJECT = "Stock 邮件推送测试";
export const TEST_EMAIL_CONTENT =
  "Stock 邮件推送测试\n连接验证消息，不包含持仓或任务内容。\n收到此邮件表示当前 SMTP 配置可用。";
/** 默认订阅：盘后统一标的精选与每周交易复盘。 */
export const DEFAULT_EMAIL_JOB_CODES = ["cross_strategy_selection", "weekly_trading_review"] as const;
/** 只有这些任务在 partial 结果下仍允许发邮件，避免把未完成报告当成最终结论。 */
const PARTIAL_EMAIL_JOB_CODES = ["cross_strategy_selection", "weekly_trading_review"] as const;
const PARTIAL_EMAIL_JOBS = new Set<string>(PARTIAL_EMAIL_JOB_CODES);
const MAX_ATTEMPTS = 3;
const EMAIL_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export interface EmailNotificationSettingsView {
  enabled: boolean;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean;
  smtp_user: string | null;
  smtp_password_configured: boolean;
  from_address: string | null;
  recipients: string[];
  job_codes: string[];
  revision: number;
  updated_at: string;
  jobs: Array<{ code: string; name: string }>;
}

export interface EmailDeliveryView {
  id: string;
  output_id: string | null;
  kind: "agent_result" | "test";
  job_code: string | null;
  job_name: string | null;
  subject: string;
  content?: string;
  status: "pending" | "sending" | "sent" | "failed" | "cancelled";
  attempts: number;
  error: string | null;
  created_at: string;
  sent_at: string | null;
  next_attempt_at: string;
}

interface EmailSettingsRow {
  enabled: boolean;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean;
  smtp_user: string | null;
  smtp_password: string | null;
  from_address: string | null;
  recipients: string[] | null;
  job_codes: string[];
  revision: number;
  updated_at: string;
}

interface ClaimedEmail {
  id: string;
  kind: "agent_result" | "test";
  subject: string;
  content: string;
  output_id: string | null;
  target_date: string | null;
  attempts: number;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string;
  smtp_password: string;
  from_address: string;
  recipients: string[];
}

export interface EmailMessage {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}

/** 可注入的发送器：生产用 nodemailer，测试用假发送器。 */
export type EmailSender = (message: EmailMessage) => Promise<void>;

function resultReadable(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw apiErrors.badRequest("邮件设置字段必须是字符串");
  const text = value.trim();
  if (!text) return null;
  if ([...text].length > max) throw apiErrors.badRequest(`邮件设置字段不得超过 ${max} 个字符`);
  return text;
}

function emailAddress(value: string, label: string): string {
  if (!EMAIL_ADDRESS.test(value)) throw apiErrors.badRequest(`${label}不是有效邮箱地址`);
  if ([...value].length > 320) throw apiErrors.badRequest(`${label}过长`);
  return value;
}

function smtpHost(value: string): string {
  if (!HOSTNAME.test(value)) throw apiErrors.badRequest("SMTP 主机名或 IP 不合法");
  return value;
}

const SETTING_SELECT = `enabled, smtp_host, smtp_port, smtp_secure, smtp_user,
  smtp_password, from_address, recipients, job_codes, revision, updated_at,
  (smtp_password IS NOT NULL) AS smtp_password_configured`;

function toSettingsView(row: EmailSettingsRow & { smtp_password_configured?: boolean }, jobs: Array<{ code: string; name: string }>): EmailNotificationSettingsView {
  return {
    enabled: row.enabled,
    smtp_host: row.smtp_host,
    smtp_port: row.smtp_port,
    smtp_secure: row.smtp_secure,
    smtp_user: row.smtp_user,
    smtp_password_configured: Boolean(row.smtp_password_configured ?? row.smtp_password),
    from_address: row.from_address,
    recipients: row.recipients ?? [],
    job_codes: row.job_codes,
    revision: row.revision,
    updated_at: row.updated_at,
    jobs,
  };
}

async function emailJobs(db: Db): Promise<Array<{ code: string; name: string }>> {
  return (await db.query<{ code: string; name: string }>(
    `SELECT code, name FROM job_definition WHERE job_type = 'agent_flow'
      ORDER BY priority NULLS LAST, code`,
  )).rows;
}

export async function getEmailNotificationSettings(db: Db): Promise<EmailNotificationSettingsView | null> {
  const row = (await db.query<EmailSettingsRow>(`SELECT ${SETTING_SELECT} FROM email_notification_setting WHERE singleton`)).rows[0];
  if (!row) return null;
  return toSettingsView(row, await emailJobs(db));
}

function complete(row: Pick<EmailSettingsRow, "smtp_host" | "smtp_port" | "smtp_user" | "smtp_password" | "from_address" | "recipients">): boolean {
  return Boolean(row.smtp_host && row.smtp_port && row.smtp_user && row.smtp_password
    && row.from_address && (row.recipients?.length ?? 0) > 0);
}

export async function updateEmailNotificationSettings(
  pool: pg.Pool, input: Record<string, unknown>,
): Promise<EmailNotificationSettingsView> {
  const allowed = new Set([
    "enabled", "smtp_host", "smtp_port", "smtp_secure", "smtp_user",
    "smtp_password", "from_address", "recipients", "job_codes",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw apiErrors.badRequest("邮件设置包含未知字段");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const old = (await client.query<EmailSettingsRow>(
      `SELECT ${SETTING_SELECT} FROM email_notification_setting WHERE singleton FOR UPDATE`,
    )).rows[0];
    if (!old) throw apiErrors.badRequest("邮件设置尚未初始化，请先运行数据库迁移");
    const has = (key: string) => Object.hasOwn(input, key);
    const boolean = (key: "enabled" | "smtp_secure", fallback: boolean): boolean => {
      if (!has(key)) return fallback;
      if (typeof input[key] !== "boolean") throw apiErrors.badRequest(`${key} 必须是布尔值`);
      return input[key] as boolean;
    };
    const enabled = boolean("enabled", old.enabled);
    const smtpSecure = boolean("smtp_secure", old.smtp_secure);
    const text = (key: "smtp_host" | "smtp_user" | "from_address", max: number): string | null =>
      has(key) ? resultReadable(input[key], max) : old[key];
    const smtpHostValue = text("smtp_host", 253);
    const smtpUser = text("smtp_user", 320);
    const fromValue = text("from_address", 320);
    const smtpHostName = smtpHostValue === null ? null : smtpHost(smtpHostValue);
    const fromAddress = fromValue === null ? null : emailAddress(fromValue, "发件人");

    let smtpPort = old.smtp_port;
    if (has("smtp_port")) {
      const raw = input.smtp_port;
      if (raw === null || raw === "") smtpPort = null;
      else if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 65535)
        throw apiErrors.badRequest("SMTP 端口必须是 1–65535 的整数");
      else smtpPort = raw;
    }
    if (smtpPort !== null && smtpPort !== 465 && smtpPort !== 587)
      throw apiErrors.badRequest("SMTP 端口只支持 465（SSL）或 587（STARTTLS），不支持明文 25 或其它端口");
    if (smtpPort === 465 && !smtpSecure) throw apiErrors.badRequest("465 端口需要使用 SSL/TLS");
    if (smtpPort === 587 && smtpSecure) throw apiErrors.badRequest("587 端口使用 STARTTLS，请关闭 SSL/TLS");

    let smtpPassword = old.smtp_password;
    if (has("smtp_password")) {
      const raw = input.smtp_password;
      if (raw === null || raw === "") smtpPassword = null;
      else if (typeof raw !== "string") throw apiErrors.badRequest("SMTP 密码必须是字符串");
      else {
        if ([...raw].length > 1024) throw apiErrors.badRequest("SMTP 密码不得超过 1024 个字符");
        smtpPassword = raw.trim() ? raw : null;
      }
    }

    let recipients = old.recipients;
    if (has("recipients")) {
      const raw = input.recipients;
      if (raw === null || (Array.isArray(raw) && raw.length === 0)) recipients = null;
      else if (!Array.isArray(raw)) throw apiErrors.badRequest("收件人必须是邮箱数组");
      else {
        if (raw.length > 20) throw apiErrors.badRequest("收件人最多 20 个");
        const values = raw.map((item) => {
          if (typeof item !== "string") throw apiErrors.badRequest("收件人必须是字符串");
          return emailAddress(item.trim(), "收件人");
        });
        // 大小写去重，保留首次出现的写法。
        const seen = new Set<string>();
        const unique: string[] = [];
        for (const value of values) {
          const key = value.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          unique.push(value);
        }
        recipients = unique.length ? unique : null;
      }
    }

    let jobCodes = old.job_codes;
    if (has("job_codes")) {
      const raw = input.job_codes;
      if (!Array.isArray(raw) || raw.length > 50) throw apiErrors.badRequest("任务范围必须是任务编码数组（最多 50 个）");
      if (raw.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9_]{0,99}$/.test(item)))
        throw apiErrors.badRequest("任务编码不合法");
      const unique = [...new Set(raw as string[])];
      if (unique.length) {
        const valid = await client.query<{ code: string }>(
          "SELECT code FROM job_definition WHERE job_type = 'agent_flow' AND code = ANY($1::text[])",
          [unique],
        );
        if (valid.rows.length !== unique.length) throw apiErrors.badRequest("只能订阅现有 Agent 任务");
      }
      jobCodes = unique;
    }

    const next = {
      enabled, smtp_host: smtpHostName, smtp_port: smtpPort, smtp_secure: smtpSecure,
      smtp_user: smtpUser, smtp_password: smtpPassword, from_address: fromAddress,
      recipients, job_codes: jobCodes,
    };
    if (enabled && !complete(next))
      throw apiErrors.badRequest("启用邮件通知前请填写完整的 SMTP 主机、端口、账号、密码、发件人和收件人");

    const credentialsChanged =
      next.smtp_host !== old.smtp_host || next.smtp_port !== old.smtp_port
      || next.smtp_secure !== old.smtp_secure || next.smtp_user !== old.smtp_user
      || next.smtp_password !== old.smtp_password || next.from_address !== old.from_address
      || JSON.stringify(next.recipients) !== JSON.stringify(old.recipients);
    const revision = old.revision + (credentialsChanged ? 1 : 0);
    await client.query(
      `UPDATE email_notification_setting SET
        enabled = $1, smtp_host = $2, smtp_port = $3, smtp_secure = $4, smtp_user = $5,
        smtp_password = $6, from_address = $7, recipients = $8, job_codes = $9,
        revision = $10, updated_at = now()
       WHERE singleton`,
      [next.enabled, next.smtp_host, next.smtp_port, next.smtp_secure, next.smtp_user,
        next.smtp_password, next.from_address, next.recipients, next.job_codes, revision],
    );
    if (credentialsChanged) {
      await client.query(
        `UPDATE email_delivery SET status = 'cancelled', lease_until = NULL,
          error = '邮件配置已变更，请等待新的任务结果'
         WHERE status IN ('pending', 'failed') AND channel_revision <> $1`,
        [revision],
      );
    }
    if (old.enabled && !enabled) {
      await client.query(
        `UPDATE email_delivery SET status = 'cancelled', lease_until = NULL,
          error = '邮件通知已关闭'
         WHERE kind = 'agent_result' AND status IN ('pending', 'failed')`,
      );
    }
    const saved = (await client.query<EmailSettingsRow>(
      `SELECT ${SETTING_SELECT} FROM email_notification_setting WHERE singleton`,
    )).rows[0]!;
    const jobs = await emailJobs(client);
    await client.query("COMMIT");
    return toSettingsView(saved, jobs);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** 任务结果保存后调用：按设置与订阅范围入队一封邮件；不抛业务错误，缺配置或未订阅时静默跳过。 */
export async function enqueueEmailForOutput(db: Db, outputId: string): Promise<boolean> {
  const row = (await db.query<{
    id: string;
    target_date: string;
    markdown: string;
    output_status: string;
    source: string;
    job_code: string;
    job_name: string;
    run_status: string;
    enabled: boolean;
    job_codes: string[];
    revision: number;
    smtp_host: string | null;
    smtp_port: number | null;
    smtp_user: string | null;
    smtp_password: string | null;
    from_address: string | null;
    recipients: string[] | null;
  }>(
    `SELECT output.id::text, output.target_date::text, output.markdown,
            output.status AS output_status, output.source,
            definition.code AS job_code, definition.name AS job_name,
            run.status AS run_status,
            setting.enabled, setting.job_codes, setting.revision,
            setting.smtp_host, setting.smtp_port, setting.smtp_user,
            setting.smtp_password, setting.from_address, setting.recipients
       FROM job_run_output output
       JOIN job_run run ON run.id = output.run_id
       JOIN job_definition definition ON definition.id = output.job_id
       CROSS JOIN email_notification_setting setting
      WHERE output.id = $1 AND setting.singleton`,
    [outputId],
  )).rows[0];
  if (!row) return false;
  if (!row.enabled || !complete(row)) return false;
  if (row.source !== "agent_flow" || !["generated", "approved"].includes(row.output_status)) return false;
  if (!row.markdown.trim()) return false;
  if (row.run_status !== "success"
    && !(row.run_status === "partial" && PARTIAL_EMAIL_JOBS.has(row.job_code))) return false;
  if (!row.job_codes.includes(row.job_code)) return false;
  const subject = `Stock｜${row.job_name.slice(0, 60)}｜${row.target_date}`;
  let content = row.markdown;
  if (row.job_code === "cross_strategy_selection" && !content.includes("## 明日预案")) {
    content = `${content}

${await buildTomorrowPreview(db, row.target_date)}`;
  }
  const inserted = await db.query(
    `INSERT INTO email_delivery (output_id, kind, subject, content, channel_revision)
     VALUES ($1, 'agent_result', $2, $3, $4)
     ON CONFLICT (output_id) DO NOTHING`,
    [row.id, subject, content, row.revision],
  );
  return (inserted.rowCount ?? 0) > 0;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 邮件内联样式：对齐工作台纸墨主题；邮件客户端不可靠支持 <style>，样式全部写进行内。 */
const EMAIL_BODY_FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif`;
const EMAIL_ELEMENT_STYLES: Record<string, string> = {
  h1: "margin:22px 0 12px;font-size:20px;font-weight:700;line-height:1.4;color:#3d362e;",
  h2: "margin:20px 0 10px;font-size:17px;font-weight:700;line-height:1.4;color:#3d362e;padding-bottom:6px;border-bottom:1px solid #e7ddcd;",
  h3: "margin:16px 0 8px;font-size:15px;font-weight:600;line-height:1.4;color:#3d362e;",
  h4: "margin:14px 0 8px;font-size:14px;font-weight:600;line-height:1.4;color:#3d362e;",
  h5: "margin:12px 0 6px;font-size:13.5px;font-weight:600;line-height:1.4;color:#6f665a;",
  h6: "margin:12px 0 6px;font-size:13.5px;font-weight:600;line-height:1.4;color:#6f665a;",
  p: "margin:8px 0;",
  ul: "margin:8px 0;padding-left:22px;",
  ol: "margin:8px 0;padding-left:22px;",
  li: "margin:4px 0;",
  table: "margin:12px 0;border-collapse:collapse;width:100%;max-width:100%;font-size:13px;line-height:1.6;",
  th: "border:1px solid #e7ddcd;background:#f3ede1;padding:6px 10px;text-align:left;font-weight:600;color:#3d362e;",
  td: "border:1px solid #e7ddcd;padding:6px 10px;color:#3d362e;",
  blockquote: "margin:12px 0;padding:10px 14px;border-left:3px solid #e8833a;background:#fdf0e3;color:#6f665a;",
  hr: "margin:18px 0;border:none;border-top:1px solid #e7ddcd;",
  strong: "font-weight:700;color:#3d362e;",
  em: "font-style:italic;",
  pre: "margin:12px 0;padding:12px 14px;background:#f3ede1;border-radius:8px;overflow-x:auto;",
  code: "font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;background:#f3ede1;border-radius:4px;padding:1px 5px;font-size:12.5px;color:#8a4d1c;",
};
const EMAIL_LINK_STYLE = "color:#cf6a22;text-decoration:underline;word-break:break-all;";

/** markdown-it 实例：html:false 保持与工作台一致，不执行内嵌 HTML。 */
const emailMarkdown = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
// 规则名是语义化 token 类型（heading_open/bullet_list_open…），实际标签从 token.tag 读取。
type StyledToken = { tag: string; content: string };
const styledOpen = (tokens: StyledToken[], idx: number): string => {
  const tag = tokens[idx]!.tag;
  const style = EMAIL_ELEMENT_STYLES[tag];
  return style ? `<${tag} style="${style}">` : `<${tag}>`;
};
for (const rule of [
  "heading_open", "paragraph_open", "bullet_list_open", "ordered_list_open", "list_item_open",
  "strong_open", "em_open", "blockquote_open", "table_open", "th_open", "td_open",
]) {
  emailMarkdown.renderer.rules[rule] = styledOpen;
}
emailMarkdown.renderer.rules.hr = () => `<hr style="${EMAIL_ELEMENT_STYLES.hr}">`;
emailMarkdown.renderer.rules.code_inline = (tokens, idx) =>
  `<code style="${EMAIL_ELEMENT_STYLES.code}">${escapeHtml(tokens[idx]!.content)}</code>`;
const renderCodeBlock = (tokens: { [index: number]: { content: string } }, idx: number): string =>
  `<pre style="${EMAIL_ELEMENT_STYLES.pre}"><code style="font-family:inherit;background:transparent;padding:0;border-radius:0;color:#3d362e">${escapeHtml(tokens[idx]!.content)}</code></pre>`;
emailMarkdown.renderer.rules.fence = renderCodeBlock;
emailMarkdown.renderer.rules.code_block = renderCodeBlock;
emailMarkdown.renderer.rules.link_open = (tokens, idx) =>
  `<a href="${escapeHtml(String(tokens[idx]!.attrGet("href") ?? ""))}" style="${EMAIL_LINK_STYLE}">`;

/** 邮件正文：纯文本保留 Markdown 原文，HTML 用 markdown-it 渲染为带内联样式的整页文档。 */
export function renderEmailBody(content: string, footer: string): { text: string; html: string } {
  const body = content.trim();
  const text = `${body}\n\n${footer}`;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stock 策略演进系统</title>
</head>
<body style="margin:0;padding:0;background:#faf6ef;">
<div style="max-width:720px;margin:0 auto;padding:24px 16px;">
<div style="background:#ffffff;border:1px solid #e7ddcd;border-radius:10px;padding:28px 30px;font:14px/1.75 ${EMAIL_BODY_FONT};color:#3d362e;word-break:break-word;">
${emailMarkdown.render(body)}
<div style="margin-top:26px;padding-top:14px;border-top:1px solid #e7ddcd;font-size:12px;line-height:1.7;color:#a2988a;">${escapeHtml(footer).replace(/\n/g, "<br>")}</div>
</div>
</div>
</body>
</html>`;
  return { text, html };
}

/** 标的代码识别：带交易所/板块后缀的完整代码，或独立 6 位数字（命中本地档案才补全名称）。 */
const INSTRUMENT_CODE_RE =
  /(?<![0-9A-Za-z.])(?:([0-9]{6}\.(?:SH|SZ|BJ|TI)(?![0-9A-Za-z]))|([0-9]{6}(?![0-9A-Za-z.])))/gi;

/** 判断名称是否已紧邻代码出现（报告里已有"名称（代码）"或"代码 名称"写法时不重复补全）。 */
function nameAdjacent(text: string, offset: number, length: number, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = text.slice(Math.max(0, offset - name.length - 2), offset);
  const after = text.slice(offset + length, offset + length + name.length + 2);
  return new RegExp(`${escaped}[（(\\s｜|,，、：:]?$`).test(before)
    || new RegExp(`^[（(\\s｜|,，、：:]*${escaped}`).test(after);
}

/** 邮件发送前为正文中的标的代码补全本地档案名称；查不到的代码与普通 6 位数字保持原文。 */
async function annotateEmailInstruments(db: Db, content: string): Promise<string> {
  const matches = [...content.matchAll(INSTRUMENT_CODE_RE)];
  if (!matches.length) return content;
  const full = [...new Set(matches.flatMap((match) => (match[1] ? [match[1].toUpperCase()] : [])))];
  const bare = [...new Set(matches.flatMap((match) => (match[2] ? [match[2]] : [])))];
  const names = new Map<string, string>();
  try {
    const rows = await db.query<{ code: string; name: string }>(
      `SELECT code, name FROM market_instrument
        WHERE code = ANY($1::text[]) OR code LIKE ANY($2::text[])`,
      [full, bare.map((code) => `${code}.%`)],
    );
    for (const row of rows.rows) {
      const name = row.name?.trim();
      if (!name) continue;
      names.set(row.code.toUpperCase(), name);
      names.set(row.code.slice(0, 6), name);
    }
  } catch {
    return content; // 名称补全只是可读性增强，档案查询失败不阻断投递
  }
  if (!names.size) return content;
  return content.replace(
    INSTRUMENT_CODE_RE,
    (match, suffixed: string | undefined, bareDigits: string | undefined, offset: number, text: string) => {
      const name = names.get(suffixed ? suffixed.toUpperCase() : bareDigits!);
      if (!name || nameAdjacent(text, offset, match.length, name)) return match;
      return `${name}（${match}）`;
    },
  );
}

function emailFooter(outputId: string | null, targetDate: string | null): string {
  return [
    "——",
    "本邮件由 Stock 策略演进系统自动发送，仅为 AI 生成的任务结果，不代表策略发布或交易执行。",
    ...(outputId
      ? [`结果 #${outputId}｜目标日 ${targetDate ?? "—"}｜详情见本机 Stock 工作台。`]
      : []),
  ].join("\n");
}

export const sendSmtpEmail: EmailSender = async (message) => {
  const transport = nodemailer.createTransport({
    host: message.host,
    port: message.port,
    secure: message.secure,
    requireTLS: !message.secure,
    auth: { user: message.user, pass: message.password },
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
    pool: false,
  });
  try {
    await transport.sendMail({
      from: message.from,
      to: message.to.join(", "),
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  } finally {
    transport.close();
  }
};

class EmailDeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

/** 失败原因脱敏：只保留固定文案与 SMTP 响应码，不回显主机、账号、密码或收件人。 */
function classifyEmailError(error: unknown): EmailDeliveryError {
  if (error instanceof EmailDeliveryError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const responseCode = (error as { responseCode?: unknown } | null)?.responseCode;
  if (code === "EAUTH") return new EmailDeliveryError("邮件服务器认证失败，请检查账号与专用密码", false);
  if (code === "EENVELOPE" || code === "EMESSAGE")
    return new EmailDeliveryError("邮件地址或内容被服务器拒绝", false);
  if (code === "ETLS" || code === "EPROTOCOL" || code === "ERR_TLS_CERT_ALTNAME_INVALID" || code === "CERT_HAS_EXPIRED")
    return new EmailDeliveryError("邮件服务器 TLS 证书或握手失败", false);
  if (code === "ETIMEDOUT" || code === "ECONNECTION" || code === "ESOCKET" || code === "EDNS")
    return new EmailDeliveryError("邮件服务器连接超时或不可达", true);
  if (typeof responseCode === "number" && Number.isInteger(responseCode))
    return new EmailDeliveryError(`邮件服务器拒绝发送（响应码 ${responseCode}）`, responseCode >= 400 && responseCode < 500);
  return new EmailDeliveryError("邮件发送失败", true);
}

const SUPERSEDED = `(d.kind = 'agent_result' AND EXISTS (
  SELECT 1 FROM job_run_output newer
    JOIN job_run_output original ON original.id = d.output_id
    JOIN job_run newer_run ON newer_run.id = newer.run_id
   WHERE newer.job_id = original.job_id
     AND newer.account_id IS NOT DISTINCT FROM original.account_id
     AND newer.target_date = original.target_date
     AND newer.id > original.id
     AND newer.source = 'agent_flow' AND newer.status IN ('generated', 'approved')
     AND (newer_run.status = 'success' OR (newer_run.status = 'partial' AND EXISTS (
       SELECT 1 FROM job_definition job WHERE job.id = newer.job_id
         AND job.code = ANY(ARRAY[${PARTIAL_EMAIL_JOB_CODES.map((code) => `'${code}'`).join(", ")}]))))))`;

/** 一次最多发送一封；数据库租约防止多个工作器领取同一封，重启后租约到期恢复。 */
export async function deliverNextEmail(
  pool: pg.Pool,
  send: EmailSender = sendSmtpEmail,
): Promise<boolean> {
  await pool.query(
    `UPDATE email_delivery d SET status = 'cancelled', lease_until = NULL,
       error = '邮件过期、配置变更、通知关闭或结果已被更新'
      FROM email_notification_setting s
     WHERE s.singleton
       AND (d.status IN ('pending', 'failed') OR (d.status = 'sending' AND d.lease_until <= now()))
       AND (
         d.created_at <= now() - interval '1 day'
         OR d.channel_revision <> s.revision
         OR (d.kind = 'agent_result' AND NOT s.enabled)
         OR (d.kind = 'agent_result' AND NOT EXISTS (
           SELECT 1 FROM job_run_output output JOIN job_definition job ON job.id = output.job_id
            WHERE output.id = d.output_id AND job.code = ANY(s.job_codes)))
         OR ${SUPERSEDED}
       )`,
  );
  await pool.query(
    `UPDATE email_delivery SET status = 'failed', lease_until = NULL,
       error = '发送中断且已达到重试上限'
     WHERE status = 'sending' AND lease_until <= now() AND attempts >= $1`,
    [MAX_ATTEMPTS],
  );
  const claimed = await pool.query<ClaimedEmail>(
    `WITH candidate AS (
       SELECT d.id FROM email_delivery d CROSS JOIN email_notification_setting s
        WHERE s.singleton
          AND s.smtp_host IS NOT NULL AND s.smtp_port IS NOT NULL AND s.smtp_user IS NOT NULL
          AND s.smtp_password IS NOT NULL AND s.from_address IS NOT NULL
          AND s.recipients IS NOT NULL AND cardinality(s.recipients) > 0
          AND d.channel_revision = s.revision AND d.attempts < $1
          AND (d.kind = 'test' OR (d.kind = 'agent_result' AND s.enabled))
          AND ((d.status = 'pending' AND d.next_attempt_at <= now())
            OR (d.status = 'sending' AND d.lease_until <= now()))
        ORDER BY d.next_attempt_at, d.id
        FOR UPDATE OF d SKIP LOCKED LIMIT 1
     )
     UPDATE email_delivery d SET status = 'sending', attempts = d.attempts + 1,
            lease_until = now() + interval '1 minute'
       FROM candidate c, email_notification_setting s
      WHERE d.id = c.id AND s.singleton
      RETURNING d.id::text, d.kind, d.subject, d.content, d.output_id::text,
        (SELECT target_date::text FROM job_run_output WHERE id = d.output_id) AS target_date,
        d.attempts,
        s.smtp_host, s.smtp_port, s.smtp_secure, s.smtp_user, s.smtp_password,
        s.from_address, s.recipients`,
    [MAX_ATTEMPTS],
  );
  const item = claimed.rows[0];
  if (!item) return false;
  try {
    const body = renderEmailBody(
      await annotateEmailInstruments(pool, item.content),
      item.kind === "test"
        ? "——\n本邮件为 Stock 邮件通道连接测试，不含持仓或任务内容。"
        : emailFooter(item.output_id, item.target_date),
    );
    await send({
      host: item.smtp_host,
      port: item.smtp_port,
      secure: item.smtp_secure,
      user: item.smtp_user,
      password: item.smtp_password,
      from: item.from_address,
      to: item.recipients,
      subject: item.subject,
      text: body.text,
      html: body.html,
    });
    await pool.query(
      `UPDATE email_delivery SET status = 'sent', sent_at = now(), lease_until = NULL, error = NULL
        WHERE id = $1 AND status = 'sending' AND attempts = $2`,
      [item.id, item.attempts],
    );
  } catch (error) {
    const failure = classifyEmailError(error);
    const retry = failure.retryable && item.attempts < MAX_ATTEMPTS;
    await pool.query(
      `UPDATE email_delivery SET status = $2, error = $3, lease_until = NULL,
         next_attempt_at = now() + ($4::int * interval '1 second')
       WHERE id = $1 AND status = 'sending' AND attempts = $5`,
      [item.id, retry ? "pending" : "failed", failure.message,
        item.attempts === 1 ? 60 : 300, item.attempts],
    );
  }
  return true;
}

const DELIVERY_SELECT = `d.id::text, d.output_id::text, d.kind, d.job_code, d.job_name,
  d.subject, d.status, d.attempts, d.error, d.created_at, d.sent_at, d.next_attempt_at`;
const DELIVERY_JOIN = `FROM (SELECT delivery.id, delivery.output_id, delivery.kind, delivery.subject,
    delivery.status, delivery.attempts, delivery.error, delivery.created_at, delivery.sent_at,
    delivery.next_attempt_at, delivery.channel_revision, job.code AS job_code, job.name AS job_name
   FROM email_delivery delivery
   LEFT JOIN job_run_output output ON output.id = delivery.output_id
   LEFT JOIN job_definition job ON job.id = output.job_id) d`;

export async function listEmailDeliveries(
  db: Db, query: { before?: string; status?: string; limit?: number } = {},
): Promise<{ items: EmailDeliveryView[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
  const result = await db.query<EmailDeliveryView>(
    `SELECT ${DELIVERY_SELECT} ${DELIVERY_JOIN}
      WHERE ($1::bigint IS NULL OR d.id < $1) AND ($2::text IS NULL OR d.status = $2)
      ORDER BY d.id DESC LIMIT $3`,
    [query.before ?? null, query.status ?? null, limit + 1],
  );
  const items = result.rows.slice(0, limit);
  return { items, next_cursor: result.rows.length > limit ? items.at(-1)!.id : null };
}

export async function getEmailDelivery(db: Db, id: string): Promise<EmailDeliveryView> {
  const row = (await db.query<EmailDeliveryView>(
    `SELECT ${DELIVERY_SELECT}, (SELECT content FROM email_delivery WHERE id = $1) AS content
       ${DELIVERY_JOIN} WHERE d.id = $1`,
    [id],
  )).rows[0];
  if (!row) throw apiErrors.notFound("邮件投递不存在");
  return row;
}

export async function queueTestEmail(db: Db): Promise<EmailDeliveryView> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO email_delivery (kind, subject, content, channel_revision)
     SELECT 'test', $1, $2, revision FROM email_notification_setting
      WHERE singleton
        AND smtp_host IS NOT NULL AND smtp_port IS NOT NULL AND smtp_user IS NOT NULL
        AND smtp_password IS NOT NULL AND from_address IS NOT NULL
        AND recipients IS NOT NULL AND cardinality(recipients) > 0
     RETURNING id::text`,
    [TEST_EMAIL_SUBJECT, TEST_EMAIL_CONTENT],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw apiErrors.badRequest("请先保存完整的 SMTP 邮件配置");
  return getEmailDelivery(db, id);
}

export async function retryEmailDelivery(db: Db, id: string): Promise<EmailDeliveryView> {
  const result = await db.query(
    `UPDATE email_delivery d SET status = 'pending', attempts = 0,
       next_attempt_at = now(), lease_until = NULL, error = NULL
      FROM email_notification_setting s
     WHERE s.singleton AND d.id = $1 AND d.status = 'failed'
       AND d.channel_revision = s.revision AND d.created_at > now() - interval '1 day'
       AND s.smtp_host IS NOT NULL AND s.smtp_port IS NOT NULL AND s.smtp_user IS NOT NULL
       AND s.smtp_password IS NOT NULL AND s.from_address IS NOT NULL
       AND s.recipients IS NOT NULL AND cardinality(s.recipients) > 0
       AND (d.kind = 'test' OR (s.enabled AND EXISTS (
         SELECT 1 FROM job_run_output output JOIN job_definition job ON job.id = output.job_id
          WHERE output.id = d.output_id AND job.code = ANY(s.job_codes))))
       AND NOT ${SUPERSEDED}
     RETURNING d.id::text`,
    [id],
  );
  if (!result.rows[0])
    throw apiErrors.conflict("仅可补发一天内当前配置下失败的邮件；请检查启用状态、任务订阅与配置版本");
  return getEmailDelivery(db, id);
}

/** 独立邮件投递工作器：与飞书通知工作器互不阻塞，每 5 秒尝试一封。 */
export class EmailNotificationWorker {
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
      this.current = deliverNextEmail(this.pool)
        .then(() => {})
        .catch(() => {
          console.error("[email] 邮件投递失败，请检查数据库连接与 SMTP 配置");
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
