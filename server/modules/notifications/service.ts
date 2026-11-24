import crypto from "node:crypto";
import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import { ACTION_LABELS as INTRADAY_ACTION_LABELS, EMOTION_LABELS, tradePlanLabel, type IntradaySignal } from "../intraday-risk/signals.js";

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

/** 只提取明确的结论段；跳过代码块，不把中间进度或任意长报告头部当结论。 */
export function extractConclusion(markdown: string, maxChars = AGENT_NOTIFICATION_SUMMARY_MAX_CHARS): string | null {
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
  if ([...text].length > maxChars)
    return "本次结论较长，请在 Stock 工作台查看完整结果，避免遗漏条件与风险。";
  return text.replace(/</g, "＜").replace(/>/g, "＞");
}

type FocusTarget = { code: string; name?: string; label?: string; boards?: string[]; reason?: string };
type FocusOutput = { id: string; run_id: string; session_id: string | null; job_code: string; target_date: string };

const ACTION_LABELS: Record<string, string> = {
  exit: "退出预案", reduce: "减仓预案", buy: "买入预案", hold: "持有", observe: "观察",
};
export const TASK_NOTIFICATION_MAX_CHARS = 600;

/** 只保留完整短句，不把缺口、验证或执行统计拼回通知。 */
function briefReason(value: string): string {
  return value.replace(/[*`]/g, "").split(/[。；;\n]/).map((part) => field(part, 120))
    .filter((part) => part && part !== "内容较长，请在系统查看完整原文"
      && !/缺口|缺失|缺数|数据不足|T\s*\+\s*1|验证|复核|核对|replaced|skipped|open_count|候选全集|扫描成功|主升分|最高分|评分|\d+\s*分/i.test(part))
    .reduce((summary, part) => [...[summary, part].filter(Boolean).join("；")].length <= 120
      ? [summary, part].filter(Boolean).join("；") : summary, "");
}

function focusExplanation(conclusion: string, targets: FocusTarget[]): string {
  const explicit = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:总说明|简要说明|关注原因)(?:\*\*)?[:：]\s*(.+)$/m.exec(conclusion);
  const explanation = briefReason(explicit?.[1] ?? "");
  if (explanation) return explanation;
  return targets.slice(0, 2).map((target) => {
    const reason = briefReason(target.reason ?? "");
    return reason ? `${target.name || target.code}：${reason}` : "";
  }).filter(Boolean).reduce((summary, part) => [...[summary, part].filter(Boolean).join("；")].length <= 120
    ? [summary, part].filter(Boolean).join("；") : summary, "");
}

/** 统一展示简要原因与关注清单；执行细节不进入消息。 */
function renderFocusNotification(header: string, targets: FocusTarget[], footer: string, marketBias?: string, explanation = ""): string {
  const lines = [header, "", ...(marketBias ? [`整体偏向：${marketBias}`, ""] : []),
    ...(explanation ? [`简要说明：${explanation}`, ""] : []), "关注标的"];
  const seen = new Set<string>();
  const rows = targets.filter((target) => {
    if (seen.has(target.code)) return false;
    seen.add(target.code);
    return true;
  }).map((target) =>
    `• ${field(target.name || target.code, 30)}${target.name && target.name !== target.code ? `（${target.code}）` : ""}` +
    `${target.boards?.length ? `｜${target.boards.map((board) => field(board, 30)).join("、")}` : ""}` +
    `${target.label ? `｜${field(target.label, 20)}` : ""}`);
  if (!rows.length) lines.push("本次未列出关注标的。");
  let shown = 0;
  for (const row of rows) {
    if ([...[...lines, row, `另有 ${rows.length} 个标的，详见工作台。`, "", footer].join("\n")].length > TASK_NOTIFICATION_MAX_CHARS) break;
    lines.push(row);
    shown++;
  }
  if (shown < rows.length) lines.push(`另有 ${rows.length - shown} 个标的，详见工作台。`);
  return [...lines, "", footer].join("\n");
}

async function withTargetBoards(db: Db, targets: FocusTarget[], date: string, conclusion = ""): Promise<FocusTarget[]> {
  if (!targets.length) return [];
  const instruments = await db.query<{ code: string; name: string; kind: string; boards: string[] }>(
    `SELECT i.code,i.name,i.kind,ARRAY(
      SELECT b.name FROM market_board_membership m
      JOIN market_instrument b ON b.id=m.board_instrument_id
      JOIN market_board board ON board.instrument_id=b.id AND board.active
      WHERE m.member_instrument_id=i.id AND m.effective_from <= $2::date
        AND (m.effective_to IS NULL OR m.effective_to > $2::date)
        AND (board.board_type='industry' OR strpos($3,b.name)>0)
      ORDER BY CASE WHEN strpos($3,b.name)>0 THEN 0 ELSE 1 END,
        CASE WHEN b.code LIKE '881%.TI' THEN 0 ELSE 1 END,b.code LIMIT 1
    ) AS boards FROM market_instrument i WHERE i.code=ANY($1::text[])`,
    [targets.map((target) => target.code), date, conclusion],
  );
  const byCode = new Map(instruments.rows.map((row) => [row.code,row]));
  return targets.map((target) => {
    const instrument = byCode.get(target.code);
    return { ...target, name: instrument?.name ?? target.name,
      boards: instrument?.boards ?? [], label: target.label ?? (instrument?.kind === "board" ? "板块关注" : undefined) };
  });
}

async function jobFocusTargets(db: Db, output: FocusOutput, conclusion: string): Promise<FocusTarget[]> {
  if (["daily_plan_flow", "limit_up_close_scan"].includes(output.job_code)) {
    // 每日计划个人通道只展示本账户持仓；收盘打板只展示本轮正式机会。
    const result = await db.query<FocusTarget & { action: string }>(
      `SELECT code,name,action,headline AS reason FROM daily_plan_playbook WHERE plan_output_id=$1 AND status <> 'draft'
       AND item_kind=$2 ORDER BY CASE action WHEN 'exit' THEN 0 WHEN 'reduce' THEN 1 ELSE 2 END,priority,id`,
      [output.id, output.job_code === "daily_plan_flow" ? "position_action" : "off_pool_opportunity"],
    );
    return result.rows.map((item) => ({ ...item, label: output.job_code === "daily_plan_flow" ? ACTION_LABELS[item.action] : undefined }));
  }
  if (output.job_code === "auction_opportunity_assessment") {
    // 持仓竞价复核已下线，只推送关注来源确认与打板机会两类结果。
    const result = await db.query<FocusTarget>(
      `SELECT i.code,i.name,CASE a.conclusion WHEN 'confirmed' THEN '条件成立' ELSE '等待条件' END AS label,a.assessment_summary AS reason
       FROM auction_scope_assessment a JOIN market_instrument i ON i.id=a.instrument_id
       WHERE a.assessment_output_id=$1 AND a.conclusion IN ('confirmed','wait')
       UNION ALL SELECT a.code,p.name,CASE a.conclusion WHEN 'worth_entering' THEN '条件成立' ELSE '等待条件' END,a.assessment_summary
       FROM daily_plan_auction_assessment a JOIN daily_plan_playbook p ON p.id=a.playbook_item_id
       WHERE a.assessment_output_id=$1 AND a.conclusion IN ('worth_entering','observe')`, [output.id],
    );
    return result.rows;
  }
  const writes = await db.query<{ args: { items: Array<{ action: string; code: string; attention_status: string; attention_reason?: string }> } }>(
    `SELECT args FROM agent_tool_audit WHERE session_id=$1 AND tool_name='pool_attention_write'
     AND status='ok' AND jsonb_typeof(args->'items')='array' ORDER BY id DESC LIMIT 1`, [output.session_id],
  );
  if (writes.rows[0]) return writes.rows[0].args.items.filter((item) => item.action === "mark")
    .map((item) => ({ code: item.code, reason: item.attention_reason, label: item.attention_status === "qualified" ? "条件成立" : "等待条件" }));
  const signals = await db.query<FocusTarget>(
    `SELECT i.code,i.name,CASE s.signal_status WHEN 'qualified' THEN '条件成立' ELSE '等待条件' END AS label,s.reason
     FROM strategy_entry_signal s JOIN strategy_evaluation_run r ON r.id=s.run_id
     JOIN market_instrument i ON i.id=s.instrument_id
     WHERE r.requested_by_job_run_id=$1 AND r.status='success'
     ORDER BY CASE s.signal_status WHEN 'qualified' THEN 0 ELSE 1 END,s.id`, [output.run_id],
  );
  if (signals.rows.length) return signals.rows;
  // 自定义任务及旧结果兼容：只认结论中明确列出的目录标的，忽略缺口、验证和排除项。
  let omittedSectionLevel = 0;
  const focusText = conclusion.split(/\r?\n/).filter((line) => {
    const heading = /^(#{1,6})\s+(.+)/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (level <= omittedSectionLevel) omittedSectionLevel = 0;
      if (/缺口|验证|复核|风险|执行|统计|剔除|排除|T\s*\+\s*1/i.test(heading[2]!)) omittedSectionLevel = level;
    }
    return !omittedSectionLevel && !/数据缺口|数据不足|缺失|漏查|未完成检索|被剔除|不关注|放弃|排除|T\s*\+\s*1|下一交易日.*(?:验证|复核)/i.test(line);
  }).join("\n");
  const matched = (await db.query<FocusTarget & { kind: string }>(
    `SELECT code,name,kind FROM market_instrument WHERE kind IN ('stock','board')
       AND (strpos($1,code)>0 OR (length(name)>=3 AND strpos($1,name)>0))
     ORDER BY LEAST(NULLIF(strpos($1,code),0),NULLIF(strpos($1,name),0)),code`, [focusText],
  )).rows;
  const mentions = (line: string, target: FocusTarget) => line.includes(target.code) || Boolean(target.name && line.includes(target.name));
  // 个股行里的板块只是归属，不重复增加一条板块关注。
  return matched.filter((target) => target.kind !== "board" || focusText.split("\n").some((line) =>
    mentions(line, target) && !matched.some((stock) => stock.kind === "stock" && mentions(line, stock))))
    .map((target) => ({ ...target, label: focusText.split("\n").find((line) => mentions(line, target))
      ?.match(/｜(条件成立|等待条件)\s*$/)?.[1] }));
}

/** 板块机会筛选：通知必须按板块给出筛选结果（板块、简要原因、板块内标的），
 *  原因只取本轮服务端确定性分析信号，标的一律来自本轮关注写入，不用模型自述补全。 */
const NIGHTLY_SECTOR_JOB = "nightly_sector_opportunity_scan";
const NIGHTLY_TRIGGER_REASON: Record<string, string> = {
  中期脱离: "脱离60日中期下降趋势",
  新低回升: "60日新低后回升",
  急跌反转: "13日急跌后反抽",
};
/** 板块优先级按当日确认度分档，触发线不再决定排序（口径见 docs/product/关注池股性与阶段展示口径.md）。 */
const NIGHTLY_TIER_ORDER: Record<string, number> = { A: 0, B: 1, C: 2 };

interface NightlySectorConfirmation {
  tier?: unknown;
  score?: unknown;
  invalidation?: unknown;
}

interface NightlySectorSignal {
  sector?: unknown;
  code?: unknown;
  trigger?: unknown;
  pattern?: unknown;
  pattern_tier?: unknown;
  volume_class?: unknown;
  valid_through?: unknown;
  second_bottom?: unknown;
  contracting?: unknown;
  confirmation?: NightlySectorConfirmation;
}

function nightlyTier(signal: NightlySectorSignal): string {
  return String(signal.confirmation?.tier ?? "");
}

function nightlyScore(signal: NightlySectorSignal): number {
  const score = Number(signal.confirmation?.score);
  return Number.isFinite(score) ? score : 0;
}

function nightlySectorReason(signal: NightlySectorSignal): string {
  const trigger = String(signal.trigger ?? "");
  const parts: string[] = [];
  const tier = nightlyTier(signal);
  if (tier) parts.push(`${tier}档 ${nightlyScore(signal)}分`);
  parts.push(NIGHTLY_TRIGGER_REASON[trigger] ?? (trigger || "信号成立"));
  // 新低回升是纯 Donchian 口径，不附加止跌形态与量比；写进消息会暗示并不存在的门槛。
  if (trigger !== "新低回升") {
    if (signal.pattern) parts.push(`${String(signal.pattern)}${signal.pattern_tier === 2 ? "（降权）" : ""}`);
    if (signal.volume_class) parts.push(String(signal.volume_class));
  }
  if (signal.second_bottom === true) parts.push("二次止跌");
  if (signal.contracting === true) parts.push("上下收敛");
  const validThrough = signal.valid_through ? String(signal.valid_through) : "";
  if (validThrough) parts.push(`观察至${validThrough.slice(5)}`);
  return parts.join("｜");
}

/** 本轮板块信号；读不到结构化初筛时返回 null，回退统一关注模板。 */
async function nightlySectorSignals(db: Db, output: FocusOutput): Promise<NightlySectorSignal[] | null> {
  const payload = (await db.query<{ payload: Record<string, unknown> | null }>(
    `SELECT payload FROM strategy_candidate_shortlist
      WHERE source_job_run_id=$1 AND strategy_code='nightly_sector'`, [output.run_id])).rows[0]?.payload;
  const source = payload?.source && typeof payload.source === "object" && !Array.isArray(payload.source)
    ? payload.source as Record<string, unknown> : null;
  const analysisId = source?.analysis_run_id === undefined ? "" : String(source.analysis_run_id);
  if (!/^\d+$/.test(analysisId)) return null;
  const analysis = (await db.query<{ result_json: Record<string, unknown> | null }>(
    `SELECT result_json FROM analysis_run WHERE id=$1::bigint AND analysis_type='sector_trend_structure'`,
    [analysisId])).rows[0]?.result_json;
  if (!analysis) return null;
  return Array.isArray(analysis.signals) ? analysis.signals as NightlySectorSignal[] : [];
}

async function nightlyStockBoards(db: Db, codes: string[], date: string): Promise<Map<string, string[]>> {
  if (!codes.length) return new Map();
  const rows = (await db.query<{ code: string; boards: string[] | null }>(
    `SELECT i.code,ARRAY(SELECT DISTINCT b.code FROM market_board_membership m
       JOIN market_instrument b ON b.id=m.board_instrument_id
      WHERE m.member_instrument_id=i.id AND m.effective_from<=$2::date
        AND (m.effective_to IS NULL OR m.effective_to>$2::date)) AS boards
     FROM market_instrument i WHERE i.code=ANY($1::text[])`, [codes, date])).rows;
  return new Map(rows.map((row) => [row.code, row.boards ?? []]));
}

function nightlyTargetLine(targets: FocusTarget[], empty: string): string {
  if (!targets.length) return empty;
  const shown = targets.slice(0, 4)
    .map((target) => `${field(target.name || target.code, 24)}（${target.code}）`);
  const rest = targets.length > 4 ? `等 ${targets.length} 只` : "";
  const labels = new Set(targets.map((target) => target.label ?? ""));
  const label = labels.size === 1 ? [...labels][0] ?? "" : "";
  return `${shown.join("、")}${rest}${label ? `｜${field(label, 20)}` : ""}`;
}

function renderNightlySectorNotification(
  header: string,
  footer: string,
  explanation: string,
  targets: FocusTarget[],
  signals: NightlySectorSignal[],
  membership: Map<string, string[]>,
): string {
  const groups = signals.flatMap((signal) => {
    const code = String(signal.code ?? "");
    if (!code) return [];
    const sector = String(signal.sector ?? code);
    return [{ signal, code, sector,
      stocks: targets.filter((target) => (membership.get(target.code) ?? []).includes(code)) }];
  });
  // 有标的的板块优先，其次按当日确认度分档与总分，最后按板块名称稳定排序。
  groups.sort((left, right) => (left.stocks.length ? 0 : 1) - (right.stocks.length ? 0 : 1)
    || (NIGHTLY_TIER_ORDER[nightlyTier(left.signal)] ?? 9) - (NIGHTLY_TIER_ORDER[nightlyTier(right.signal)] ?? 9)
    || nightlyScore(right.signal) - nightlyScore(left.signal)
    || left.sector.localeCompare(right.sector, "zh-CN"));
  const grouped = new Set(groups.flatMap((group) => group.stocks.map((stock) => stock.code)));
  const leftovers = targets.filter((target) => !grouped.has(target.code));
  const leftoverLine = leftovers.length ? `其他复核：${nightlyTargetLine(leftovers, "")}` : "";
  const lines = [header, ""];
  if (explanation) lines.push(`简要说明：${explanation}`, "");
  if (!groups.length) lines.push("板块：本次无符合条件板块", "");
  let shown = 0;
  for (const group of groups) {
    const block = [
      `板块：${field(group.sector, 36)}（${group.code}）`,
      `简要原因：${nightlySectorReason(group.signal)}`,
      `板块内标的：${nightlyTargetLine(group.stocks, "本次未保留个股")}`,
    ];
    const remaining = groups.length - shown;
    const tail = [
      ...(leftoverLine ? [leftoverLine] : []),
      ...(remaining > 0 ? [`另有 ${remaining} 个板块，详见工作台。`] : []),
      footer,
    ];
    if ([...[...lines, ...block, "", ...tail].join("\n")].length > TASK_NOTIFICATION_MAX_CHARS) break;
    lines.push(...block, "");
    shown += 1;
  }
  if (leftoverLine) lines.push(leftoverLine, "");
  if (shown < groups.length) lines.push(`另有 ${groups.length - shown} 个板块，详见工作台。`, "");
  lines.push(footer);
  return lines.join("\n");
}

export async function previewJobConclusion(
  db: Db,
  outputId?: string,
  jobCode?: string,
): Promise<{
  output_id: string;
  job_code: string;
  job_name: string;
  content: string;
} | null> {
  const result = await db.query(
    `SELECT o.id::text, o.run_id::text, o.job_id::text, o.target_date::text, o.created_at, o.markdown,
      r.status AS run_status, r.data_gaps, r.account_id::text, account.name AS account_name, r.session_id::text AS session_id, j.code AS job_code, j.name AS job_name,
      EXISTS (SELECT 1 FROM job_run_output older WHERE older.job_id=o.job_id
        AND older.account_id IS NOT DISTINCT FROM o.account_id AND older.target_date=o.target_date AND older.id < o.id) AS revised
    FROM job_run_output o JOIN job_run r ON r.id=o.run_id JOIN job_definition j ON j.id=o.job_id
    LEFT JOIN portfolio_account account ON account.id=r.account_id
    WHERE j.job_type='agent_flow' AND (r.status='success' OR (r.status='partial' AND j.code IN ('pre_market_news_scan','cross_strategy_selection','weekly_trading_review'))) AND o.source='agent_flow'
      AND o.status IN ('generated','approved') AND length(btrim(o.markdown))>0
      AND ($1::bigint IS NULL OR o.id=$1) AND ($2::text IS NULL OR j.code=$2)
    ORDER BY o.id DESC LIMIT 1`,
    [outputId ?? null, jobCode ?? null],
  );
  const output = result.rows[0];
  if (!output) return null;
  if (output.job_code === "cross_strategy_selection") {
    const selected = (await db.query<{ result: { summary: string; status: string } }>(
      "SELECT result FROM candidate_selection_result WHERE job_run_id=$1 AND status='generated'", [output.run_id])).rows[0];
    if (!selected?.result?.summary) return null;
    return { output_id: output.id, job_code: output.job_code, job_name: output.job_name,
      content: `Stock｜${field(output.job_name, 60)}${selected.result.status === 'partial' ? '（部分覆盖）' : ''}｜${output.target_date}\n\n`
        + `${selected.result.summary}\n\n结果 #${output.id}｜详情见 Stock 工作台` };
  }
  const conclusion = extractConclusion(output.markdown, Infinity);
  if (!conclusion && output.job_code !== "daily_plan_flow" && output.job_code !== "limit_up_close_scan") return null;
  const targets = await jobFocusTargets(db, output, conclusion ?? "");
  if (!conclusion && !targets.length) return null;
  const partialMark = output.run_status === "partial" && output.job_code === "weekly_trading_review"
    ? "（部分覆盖·正文列明数据缺口）" : "";
  const header = `Stock｜${field(output.job_name, 60)}${output.revised ? "（更新版）" : ""}${partialMark}｜${output.target_date}${output.account_name ? `｜${field(output.account_name,100)}` : ""}`;
  let marketBias: string | undefined;
  if (output.job_code === "pre_market_news_scan") {
    const news = (await db.query<{ market_bias: string }>("SELECT market_bias FROM market_news_snapshot WHERE run_id=$1", [output.run_id])).rows[0];
    marketBias = news?.market_bias === "mixed_positive" ? "mixed 偏多" : news?.market_bias === "mixed_negative" ? "mixed 偏空" : undefined;
  }
  const focusTargets = await withTargetBoards(db, targets, output.target_date, conclusion ?? "");
  const footer = `结果 #${output.id}｜详情见 Stock 工作台`;
  if (output.job_code === NIGHTLY_SECTOR_JOB) {
    const signals = await nightlySectorSignals(db, output);
    if (signals !== null) {
      const membership = await nightlyStockBoards(db, focusTargets.map((target) => target.code), output.target_date);
      return {
        output_id: output.id, job_code: output.job_code, job_name: output.job_name,
        content: renderNightlySectorNotification(header, footer,
          focusExplanation(conclusion ?? "", focusTargets), focusTargets, signals, membership),
      };
    }
  }
  return {
    output_id: output.id, job_code: output.job_code, job_name: output.job_name,
    content: renderFocusNotification(header, focusTargets, footer, marketBias,
      focusExplanation(conclusion ?? "", focusTargets)),
  };
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
  const summary = await previewJobConclusion(db, outputId);
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
): Promise<boolean> {
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
  if (!settings) return false;
  const webhook = settings.personal_webhook ?? settings.webhook;
  const secret = settings.personal_sign_secret ?? settings.sign_secret;
  const enabled = settings.personal_webhook == null && settings.personal_sign_secret == null
    ? settings.enabled
    : settings.personal_enabled;
  if (!enabled || !webhook || !secret) return false;
  const risk = (await db.query<IntradaySignal & { name: string; trade_date: string; account_name: string; data_time: string | null }>(
    `SELECT r.code,r.name,r.action,r.add_plan,r.reduce_plan,r.emotion,r.reason,r.trade_date::text,r.data_time::text,a.name AS account_name
     FROM intraday_position_risk r JOIN portfolio_account a ON a.id=r.account_id WHERE r.id=$1`, [riskId],
  )).rows[0];
  if (!risk || !["add", "reduce"].includes(risk.action)) return false;
  const plan = risk.action === "add" ? risk.add_plan : risk.reduce_plan;
  if (!plan || plan.status !== "triggered") return false;
  const target = (await withTargetBoards(db, [{ code: risk.code, name: risk.name }], risk.trade_date))[0]!;
  const time = risk.data_time ? ` ${new Date(risk.data_time).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}` : "";
  const content = [
    `Stock｜盘中加减仓提醒｜${risk.trade_date}${time}｜${field(risk.account_name,40)}`, "",
    `${field(target.name,30)}（${target.code}）${target.boards?.length ? `｜${field(target.boards[0],30)}` : ""}`,
    `${INTRADAY_ACTION_LABELS[risk.action]}：${tradePlanLabel(plan)}`, `情绪：${EMOTION_LABELS[risk.emotion]}`,
    `依据：${field(briefReason(risk.reason),100)}`, `确认：${field(plan.condition,100)}`, `取消：${field(plan.invalidation,100)}`,
    "", "详情见 Stock 工作台持仓页",
  ].join("\n");
  const queued = await db.query(
    `INSERT INTO notification_delivery
      (intraday_risk_id, kind, channel, channel_revision, content,account_id)
     VALUES ($1, 'intraday_risk', 'personal', $2, $3,(SELECT account_id FROM intraday_position_risk WHERE id=$1))
     ON CONFLICT DO NOTHING`,
    [riskId, settings.personal_revision, content],
  );
  return (queued.rowCount ?? 0) > 0;
}

/**
 * 超短提醒统一走个人通道，不关联任务结果；event_key 保证同一事件只入队一次。
 * 返回是否实际入队，发送失败由现有通知工作器重试。
 */
export async function enqueueUltraShortAlert(
  db: Db,
  input: { event_key: string; content: string },
): Promise<boolean> {
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
  if (!settings) return false;
  const webhook = settings.personal_webhook ?? settings.webhook;
  const secret = settings.personal_sign_secret ?? settings.sign_secret;
  const enabled = settings.personal_webhook == null && settings.personal_sign_secret == null
    ? settings.enabled
    : settings.personal_enabled;
  if (!enabled || !webhook || !secret) return false;
  const queued = await db.query(
    `INSERT INTO notification_delivery (kind, channel, channel_revision, content, event_key)
     VALUES ('ultra_short', 'personal', $1, $2, $3)
     ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
    [settings.personal_revision, input.content, input.event_key],
  );
  return (queued.rowCount ?? 0) > 0;
}

/** 盘中任务汇总提醒：每个任务每轮最多一条，event_key 用内容哈希去重。 */
export async function enqueueBatchAlert(
  db: Db,
  input: { kind: "intraday_digest" | "ultra_short"; event_key: string; content: string; account_id?: string | null },
): Promise<boolean> {
  const settings = (await db.query<{
    enabled: boolean; personal_enabled: boolean; personal_webhook: string | null;
    personal_sign_secret: string | null; webhook: string | null; sign_secret: string | null; personal_revision: number;
  }>(
    `SELECT enabled, personal_enabled, personal_webhook, personal_sign_secret,
            webhook, sign_secret, personal_revision
       FROM notification_setting WHERE singleton FOR SHARE`,
  )).rows[0];
  if (!settings) return false;
  const webhook = settings.personal_webhook ?? settings.webhook;
  const secret = settings.personal_sign_secret ?? settings.sign_secret;
  const enabled = settings.personal_webhook == null && settings.personal_sign_secret == null
    ? settings.enabled
    : settings.personal_enabled;
  if (!enabled || !webhook || !secret) return false;
  const queued = await db.query(
    `INSERT INTO notification_delivery (kind, channel, channel_revision, content, event_key, account_id)
     VALUES ($1, 'personal', $2, $3, $4, $5)
     ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
    [input.kind, settings.personal_revision, input.content, input.event_key, input.account_id ?? null],
  );
  return (queued.rowCount ?? 0) > 0;
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
const SUPERSEDED = `(EXISTS (SELECT 1 FROM job_run_output newer JOIN job_run_output original ON original.id=d.output_id
  JOIN job_run newer_run ON newer_run.id=newer.run_id
  WHERE newer.job_id=original.job_id AND newer.account_id IS NOT DISTINCT FROM original.account_id AND newer.target_date=original.target_date AND newer.id>original.id
    AND newer.source='agent_flow' AND newer.status IN ('generated','approved')
    AND (newer_run.status='success' OR (newer_run.status='partial' AND EXISTS (
      SELECT 1 FROM job_definition job WHERE job.id=newer.job_id AND job.code IN ('pre_market_news_scan','cross_strategy_selection','weekly_trading_review')))))
  OR (d.kind='intraday_risk' AND NOT EXISTS (
    SELECT 1 FROM intraday_position_risk r JOIN market_instrument i ON i.code=r.code
    JOIN portfolio_position p ON p.instrument_id=i.id AND p.account_id=r.account_id AND p.quantity>0
    WHERE r.id=d.intraday_risk_id AND r.action IN ('add','reduce')
      AND d.created_at>=now()-interval '90 seconds'
      AND r.data_time>=now()-interval '90 seconds' AND r.trade_date=(now() AT TIME ZONE 'Asia/Shanghai')::date
      AND (((now() AT TIME ZONE 'Asia/Shanghai')::time >= time '09:30' AND (now() AT TIME ZONE 'Asia/Shanghai')::time < time '11:30')
        OR ((now() AT TIME ZONE 'Asia/Shanghai')::time >= time '13:00' AND (now() AT TIME ZONE 'Asia/Shanghai')::time < time '15:00')))))`;

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
    error='通知过期、条件失效、渠道变更或已有更新结果'
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
