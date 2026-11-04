<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { apiClient } from "../../api/client";
import type { EmailDelivery, EmailDeliveryPage, EmailNotificationSettings, NotificationSettings } from "../../api/types";
import { appMessage } from "../../stores/message";
import UiInput from "../ui/UiInput.vue";
import UiTextarea from "../ui/UiTextarea.vue";
const settings = ref<NotificationSettings | null>(null);
const personalEnabled = ref(false);
const strategyEnabled = ref(false);
const allJobs = ref(true);
const jobCodes = ref<string[]>([]);
const previewJob = ref("");
const personalWebhook = ref("");
const personalSecret = ref("");
const strategyWebhook = ref("");
const strategySecret = ref("");
const busy = ref(false);
const error = ref("");
const preview = ref<{ output_id: string; job_name: string; content: string } | null>(null);
const previewLoaded = ref(false);
const scope = computed(() => allJobs.value ? null : [...jobCodes.value].sort());
const dirty = computed(() => !!personalWebhook.value || !!personalSecret.value || !!strategyWebhook.value || !!strategySecret.value ||
  personalEnabled.value !== settings.value?.personal_enabled || strategyEnabled.value !== settings.value?.strategy_enabled ||
  JSON.stringify(scope.value) !== JSON.stringify(settings.value?.strategy_job_codes === null ? null : [...(settings.value?.strategy_job_codes ?? [])].sort()));
const personalReady = computed(() => settings.value?.personal_webhook_configured && settings.value?.personal_sign_secret_configured);
const strategyReady = computed(() => settings.value?.strategy_webhook_configured && settings.value?.strategy_sign_secret_configured);
function apply(value: NotificationSettings) {
  settings.value = value;
  personalEnabled.value = value.personal_enabled;
  strategyEnabled.value = value.strategy_enabled;
  allJobs.value = value.strategy_job_codes === null;
  jobCodes.value = value.strategy_job_codes ?? value.strategy_jobs.map((job) => job.code);
}
async function load() {
  const response = await apiClient.get<NotificationSettings>("/api/notifications/settings");
  if (response.ok) apply(response.data); else error.value = response.message;
}
async function save(clear = false) {
  busy.value = true; error.value = "";
  const body = clear ? { personal_enabled: false, strategy_enabled: false, personal_webhook: "", personal_sign_secret: "", strategy_webhook: "", strategy_sign_secret: "" } : {
    personal_enabled: personalEnabled.value, strategy_enabled: strategyEnabled.value, strategy_job_codes: scope.value,
    ...(personalWebhook.value.trim() ? { personal_webhook: personalWebhook.value.trim() } : {}),
    ...(personalSecret.value.trim() ? { personal_sign_secret: personalSecret.value.trim() } : {}),
    ...(strategyWebhook.value.trim() ? { strategy_webhook: strategyWebhook.value.trim() } : {}),
    ...(strategySecret.value.trim() ? { strategy_sign_secret: strategySecret.value.trim() } : {}),
  };
  const response = await apiClient.patch<NotificationSettings>("/api/notifications/settings", body);
  busy.value = false;
  if (!response.ok) { error.value = response.message; return; }
  apply(response.data); personalWebhook.value = ""; personalSecret.value = ""; strategyWebhook.value = ""; strategySecret.value = "";
  appMessage.success(clear ? "推送配置已清除" : "飞书双通道推送设置已保存");
}
async function test(channel: "personal" | "strategy") {
  busy.value = true; error.value = "";
  const response = await apiClient.post("/api/notifications/test", { channel });
  busy.value = false;
  if (!response.ok) { error.value = response.message; return; }
  appMessage.success(`${channel === "personal" ? "个人消息" : "策略任务"}测试消息已排队，可到通知记录查看发送状态`);
}
async function showPreview() {
  busy.value = true; error.value = "";
  const query = previewJob.value ? `?job_code=${encodeURIComponent(previewJob.value)}` : "";
  const response = await apiClient.get<{ output_id: string; job_name: string; content: string } | null>(`/api/notifications/preview${query}`);
  busy.value = false;
  if (response.ok) { preview.value = response.data; previewLoaded.value = true; } else error.value = response.message;
}

// ---- 邮件通知 · 独立通道（与飞书双通道状态完全分开） ----
const EMAIL_RECENT_LIMIT = 10;
const emailStatusLabels: Record<EmailDelivery["status"], string> = {
  pending: "等待发送",
  sending: "发送中",
  sent: "已发送",
  failed: "发送失败",
  cancelled: "已取消",
};
const email = ref<EmailNotificationSettings | null>(null);
const emailEnabled = ref(false);
const emailHost = ref("");
const emailPort = ref("465");
const emailSecure = ref(true);
const emailUser = ref("");
const emailPassword = ref("");
const emailFrom = ref("");
const emailRecipients = ref("");
const emailJobCodes = ref<string[]>([]);
const emailBusy = ref(false);
const emailDeliveriesLoading = ref(false);
const emailDeliveries = ref<EmailDelivery[]>([]);
const emailDeliveriesLoaded = ref(false);
const emailError = ref("");
const emailBaseline = ref("");

function splitRecipients(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of raw.split(/[,，;；\n\r]+/)) {
    const value = token.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
function emailPortValue(): number | null {
  const text = emailPort.value.trim();
  if (!text) return null;
  const port = Number(text);
  return Number.isInteger(port) ? port : null;
}
function emailSnapshot(): string {
  return JSON.stringify({
    enabled: emailEnabled.value,
    host: emailHost.value.trim(),
    port: emailPort.value.trim(),
    secure: emailSecure.value,
    user: emailUser.value.trim(),
    from: emailFrom.value.trim(),
    recipients: splitRecipients(emailRecipients.value),
    jobCodes: [...emailJobCodes.value].sort(),
    password: emailPassword.value,
  });
}
const emailDirty = computed(() => !!email.value && emailSnapshot() !== emailBaseline.value);
const emailReady = computed(() => {
  const value = email.value;
  return !!value && !!value.smtp_host && value.smtp_port !== null && !!value.smtp_user &&
    value.recipients.length > 0 && !!value.from_address && value.smtp_password_configured;
});
const emailConfigured = computed(() => {
  const value = email.value;
  return !!value && (value.enabled || !!value.smtp_host || !!value.smtp_user || !!value.from_address ||
    value.recipients.length > 0 || value.smtp_password_configured);
});
function applyEmail(value: EmailNotificationSettings): void {
  email.value = value;
  emailEnabled.value = value.enabled;
  emailHost.value = value.smtp_host ?? "";
  emailPort.value = String(value.smtp_port ?? (value.smtp_secure ? 465 : 587));
  emailSecure.value = value.smtp_secure;
  emailUser.value = value.smtp_user ?? "";
  emailPassword.value = "";
  emailFrom.value = value.from_address ?? "";
  emailRecipients.value = value.recipients.join(", ");
  const known = new Set(value.jobs.map((job) => job.code));
  const saved = value.job_codes.filter((code) => known.has(code));
  emailJobCodes.value = saved;
  emailBaseline.value = emailSnapshot();
}
async function loadEmail(): Promise<void> {
  const response = await apiClient.get<EmailNotificationSettings>("/api/notifications/email/settings");
  if (response.ok) { applyEmail(response.data); emailError.value = ""; } else emailError.value = response.message;
}
async function loadEmailDeliveries(): Promise<void> {
  emailDeliveriesLoading.value = true;
  const response = await apiClient.get<EmailDeliveryPage>(`/api/notifications/email/deliveries?limit=${EMAIL_RECENT_LIMIT}`);
  emailDeliveriesLoading.value = false;
  if (!response.ok) { emailError.value = response.message; return; }
  emailDeliveries.value = response.data.items;
  emailDeliveriesLoaded.value = true;
}
function onEmailDetailsToggle(event: Event): void {
  if ((event.target as HTMLDetailsElement).open) void loadEmailDeliveries();
}
function onSecureChange(): void {
  const port = emailPortValue();
  if (port === null || port === 465 || port === 587) emailPort.value = emailSecure.value ? "465" : "587";
}
function selectAllEmailJobs(): void {
  emailJobCodes.value = email.value?.jobs.map((job) => job.code) ?? [];
}
function clearEmailJobs(): void {
  emailJobCodes.value = [];
}
function formatEmailTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
/** 后端只允许补发一天内、当前配置下失败的邮件。 */
function canRetryEmail(item: EmailDelivery): boolean {
  return item.status === "failed" && Date.now() - new Date(item.created_at).getTime() < 24 * 60 * 60 * 1000;
}
async function saveEmail(): Promise<void> {
  if (!email.value) return;
  emailError.value = "";
  const portText = emailPort.value.trim();
  const port = emailPortValue();
  if (portText && (port === null || port < 1 || port > 65535)) { emailError.value = "SMTP 端口需为 1-65535 的整数"; return; }
  if (port === 25) { emailError.value = "不支持明文 25 端口，请使用 465（SSL）或 587（STARTTLS）"; return; }
  if (port === 465 && !emailSecure.value) { emailError.value = "465 端口需要使用 SSL/TLS"; return; }
  if (port === 587 && emailSecure.value) { emailError.value = "587 端口使用 STARTTLS，请关闭 SSL/TLS"; return; }
  const recipients = splitRecipients(emailRecipients.value);
  if (recipients.length > 20) { emailError.value = "收件人最多 20 个"; return; }
  const invalid = recipients.find((item) => !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(item));
  if (invalid) { emailError.value = `收件邮箱格式不正确：${invalid}`; return; }
  if (emailEnabled.value) {
    if (!emailHost.value.trim()) { emailError.value = "启用邮件通知前请填写 SMTP 主机"; return; }
    if (port === null) { emailError.value = "启用邮件通知前请填写 SMTP 端口"; return; }
    if (!emailUser.value.trim()) { emailError.value = "启用邮件通知前请填写 SMTP 账号"; return; }
    if (!emailFrom.value.trim()) { emailError.value = "启用邮件通知前请填写发件人地址"; return; }
    if (!recipients.length) { emailError.value = "启用邮件通知前请至少填写一个收件邮箱"; return; }
    if (!email.value.smtp_password_configured && !emailPassword.value.trim()) { emailError.value = "启用邮件通知前请填写 SMTP 密码或 QQ 邮箱授权码"; return; }
  }
  emailBusy.value = true;
  const body = {
    enabled: emailEnabled.value,
    smtp_host: emailHost.value.trim() || null,
    smtp_port: port,
    smtp_secure: emailSecure.value,
    smtp_user: emailUser.value.trim() || null,
    from_address: emailFrom.value.trim() || null,
    recipients,
    job_codes: [...emailJobCodes.value],
    ...(emailPassword.value.trim() ? { smtp_password: emailPassword.value.trim() } : {}),
  };
  const response = await apiClient.patch<EmailNotificationSettings>("/api/notifications/email/settings", body);
  emailBusy.value = false;
  if (!response.ok) { emailError.value = response.message; return; }
  applyEmail(response.data);
  await loadEmailDeliveries();
  appMessage.success("邮件通知设置已保存");
}
async function testEmail(): Promise<void> {
  emailBusy.value = true; emailError.value = "";
  const response = await apiClient.post<EmailDelivery>("/api/notifications/email/test", {});
  emailBusy.value = false;
  if (!response.ok) { emailError.value = response.message; return; }
  emailDeliveries.value = [response.data, ...emailDeliveries.value.filter((item) => item.id !== response.data.id)].slice(0, EMAIL_RECENT_LIMIT);
  emailDeliveriesLoaded.value = true;
  await loadEmailDeliveries();
  appMessage.success("测试邮件已排队，可在最近邮件投递查看发送状态");
}
async function retryEmailDelivery(id: string): Promise<void> {
  emailBusy.value = true; emailError.value = "";
  const response = await apiClient.post<EmailDelivery>(`/api/notifications/email/deliveries/${encodeURIComponent(id)}/retry`, {});
  emailBusy.value = false;
  if (!response.ok) { emailError.value = response.message; return; }
  emailDeliveries.value = emailDeliveries.value.map((item) => item.id === response.data.id ? response.data : item);
  appMessage.success("邮件已重新排队补发");
}
async function clearEmail(): Promise<void> {
  if (!email.value || !window.confirm("清除邮件通知的 SMTP 配置并关闭邮件通道？")) return;
  emailBusy.value = true; emailError.value = "";
  const response = await apiClient.patch<EmailNotificationSettings>("/api/notifications/email/settings", {
    enabled: false,
    smtp_host: "",
    smtp_port: null,
    smtp_secure: true,
    smtp_user: "",
    smtp_password: "",
    from_address: "",
    recipients: [],
    job_codes: [...emailJobCodes.value],
  });
  emailBusy.value = false;
  if (!response.ok) { emailError.value = response.message; return; }
  applyEmail(response.data);
  appMessage.success("邮件通知配置已清除");
}
onMounted(() => { void load(); void loadEmail(); });
</script>

<template>
  <div class="card notification-settings">
    <div class="notification-head">
      <div><div class="card-title">飞书消息推送</div><p class="card-desc">个人消息发送每日计划和盘中加减仓提醒；策略任务消息发送除每日计划外的通用策略任务，两个通道互不混发。</p></div>
      <RouterLink class="btn" to="/settings/notifications/history">通知记录 →</RouterLink>
    </div>
    <p v-if="!settings">{{ error || '正在读取推送设置…' }}</p>
    <template v-else>
      <div class="settings-section channel-card">
        <h2>个人消息 · 每日计划</h2>
        <p class="hint">只包含当前持仓分析、板块与市场观察、下一交易日多情景预案和做 T 盯盘要点。</p>
        <div class="credentials">
          <label>个人群机器人 Webhook · {{ settings.personal_webhook_configured ? '已配置' : '未配置' }}<UiInput v-model="personalWebhook" type="password" autocomplete="new-password" aria-label="个人消息 Webhook" :disabled="busy" placeholder="输入新地址；留空保留现有配置" /></label>
          <label>个人签名密钥 · {{ settings.personal_sign_secret_configured ? '已配置' : '未配置' }}<UiInput v-model="personalSecret" type="password" autocomplete="new-password" aria-label="个人消息签名密钥" :disabled="busy" placeholder="输入新密钥；留空保留现有配置" /></label>
        </div>
        <label class="toggle"><input v-model="personalEnabled" type="checkbox" :disabled="busy" /> 开启每日计划个人消息</label>
        <button class="btn" :disabled="busy || !personalReady || dirty" @click="test('personal')">发送个人消息测试</button>
      </div>
      <div class="settings-section channel-card">
        <h2>通用消息 · 策略任务</h2>
        <p class="hint">每日计划不会进入此通道；其余 Agent 策略任务按下方范围发送。</p>
        <div class="credentials">
          <label>策略任务群机器人 Webhook · {{ settings.strategy_webhook_configured ? '已配置' : '未配置' }}<UiInput v-model="strategyWebhook" type="password" autocomplete="new-password" aria-label="策略任务 Webhook" :disabled="busy" placeholder="输入新地址；留空保留现有配置" /></label>
          <label>策略任务签名密钥 · {{ settings.strategy_sign_secret_configured ? '已配置' : '未配置' }}<UiInput v-model="strategySecret" type="password" autocomplete="new-password" aria-label="策略任务签名密钥" :disabled="busy" placeholder="输入新密钥；留空保留现有配置" /></label>
        </div>
        <label class="toggle"><input v-model="strategyEnabled" type="checkbox" :disabled="busy" /> 开启通用策略任务消息</label>
        <div class="scope-options"><label><input v-model="allJobs" type="radio" :value="true" :disabled="busy" /> 全部策略任务（含新增任务）</label><label><input v-model="allJobs" type="radio" :value="false" :disabled="busy" /> 选择任务</label></div>
        <div v-if="!allJobs" class="job-options"><label v-for="job in settings.strategy_jobs" :key="job.code"><input v-model="jobCodes" type="checkbox" :value="job.code" :disabled="busy" /> {{ job.name }}<small v-if="!job.enabled">定时调度已停用</small></label><p v-if="!jobCodes.length" class="hint">尚未选择任务，不会自动推送。</p></div>
        <button class="btn" :disabled="busy || !strategyReady || dirty" @click="test('strategy')">发送策略任务测试</button>
      </div>
      <p class="hint">Webhook 只接受飞书官方 HTTPS 地址。凭据不会回显；修改任一通道凭据会取消旧待发通知，完整结果仍保留在 Stock 工作台。</p>
      <div class="actions"><button class="btn primary" :disabled="busy || !dirty" @click="save()">保存设置</button><button class="btn" :disabled="busy || !(settings.personal_webhook_configured || settings.strategy_webhook_configured)" @click="save(true)">清除配置并关闭</button></div>
      <p v-if="error" class="bad-text" role="alert">{{ error }}</p>
      <details class="settings-section" @toggle="previewLoaded = false"><summary>预览任务结论</summary><div class="actions"><select v-model="previewJob" aria-label="预览任务" :disabled="busy" @change="preview = null; previewLoaded = false"><option value="">最近完成的 Agent 任务</option><option v-for="job in settings.strategy_jobs" :key="job.code" :value="job.code">{{ job.name }}</option></select><button class="btn" :disabled="busy" @click="showPreview">预览最新结论</button></div><p class="hint">预览仅在本机展示，不发送消息。测试消息不包含业务数据。</p><pre v-if="preview" class="preview">{{ preview.content }}</pre><p v-else-if="previewLoaded" class="hint">该任务最近一次成功结果尚无可发送的结论。</p></details>
    </template>

    <div class="settings-section channel-card email-channel">
      <h2>邮件通知 · 独立通道</h2>
      <p class="hint">每周交易复盘与盘后统一标的精选等任务结果，可通过 SMTP 发送到指定邮箱；与飞书通道独立启停、独立凭据、独立投递记录。</p>
      <p v-if="!email" class="hint">{{ emailError || '正在读取邮件通知设置…' }}</p>
      <template v-else>
        <label class="toggle"><input v-model="emailEnabled" type="checkbox" :disabled="emailBusy" /> 启用独立邮件通知通道</label>
        <div class="credentials">
          <label>SMTP 主机<UiInput v-model="emailHost" :disabled="emailBusy" aria-label="SMTP 主机" placeholder="例如 smtp.qq.com" /></label>
          <div class="email-pair">
            <label>SMTP 端口<UiInput v-model="emailPort" type="number" :disabled="emailBusy" aria-label="SMTP 端口" placeholder="465 或 587" /></label>
            <label>加密方式<select v-model="emailSecure" :disabled="emailBusy" aria-label="加密方式" @change="onSecureChange"><option :value="true">SSL/TLS（465）</option><option :value="false">STARTTLS（587）</option></select></label>
          </div>
          <label>账号<UiInput v-model="emailUser" autocomplete="username" :disabled="emailBusy" aria-label="SMTP 账号" placeholder="例如 xxx@qq.com" /></label>
          <label>SMTP 密码 / 授权码 · {{ email.smtp_password_configured ? '已配置' : '未配置' }}<UiInput v-model="emailPassword" type="password" autocomplete="new-password" :disabled="emailBusy" aria-label="SMTP 密码或授权码" placeholder="QQ 邮箱授权码；留空保留现有" /></label>
          <label>发件人地址<UiInput v-model="emailFrom" type="email" :disabled="emailBusy" aria-label="发件人地址" placeholder="例如 xxx@qq.com" /></label>
          <label>收件人<UiTextarea v-model="emailRecipients" :rows="3" :disabled="emailBusy" aria-label="收件人邮箱" placeholder="多个邮箱用逗号或换行分隔" /></label>
          <p class="hint">QQ 邮箱：主机 smtp.qq.com、端口 465、SSL；密码填 QQ 邮箱授权码（不是 QQ 登录密码），发件人与账号一致。收件人保存时自动 trim、去重后转为数组；密码不会回显。</p>
        </div>
        <div class="scope-options email-scope">
          <span class="scope-label">任务范围</span>
          <button class="btn" :disabled="emailBusy" @click="selectAllEmailJobs">全选</button>
          <button class="btn" :disabled="emailBusy" @click="clearEmailJobs">清空</button>
        </div>
        <div class="job-options">
          <label v-for="job in email.jobs" :key="job.code"><input v-model="emailJobCodes" type="checkbox" :value="job.code" :disabled="emailBusy" /> {{ job.name }}</label>
          <p v-if="!emailJobCodes.length" class="hint">尚未选择任务，启用后不会自动发送邮件。</p>
        </div>
        <div class="actions">
          <button class="btn primary" :disabled="emailBusy || !emailDirty" @click="saveEmail">保存邮件设置</button>
          <button class="btn" :disabled="emailBusy || !emailReady || emailDirty" @click="testEmail">发送测试邮件</button>
          <button class="btn" :disabled="emailBusy || !emailConfigured" @click="clearEmail">清除邮件配置并关闭</button>
        </div>
        <p v-if="emailError" class="bad-text" role="alert">{{ emailError }}</p>
        <details class="settings-section email-deliveries" @toggle="onEmailDetailsToggle">
          <summary>最近邮件投递</summary>
          <div class="actions"><button class="btn" :disabled="emailBusy || emailDeliveriesLoading" @click="loadEmailDeliveries()">刷新</button><span class="hint">最近 {{ EMAIL_RECENT_LIMIT }} 条；发送测试或保存后自动刷新。</span></div>
          <p v-if="emailDeliveriesLoading" class="hint">正在读取邮件投递…</p>
          <p v-else-if="emailDeliveriesLoaded && !emailDeliveries.length" class="hint">暂无邮件投递记录。</p>
          <article v-for="item in emailDeliveries" :key="item.id" class="email-delivery">
            <div class="email-delivery-head">
              <div>
                <strong>{{ item.subject }}</strong>
                <p class="hint email-delivery-meta">{{ formatEmailTime(item.created_at) }}<span v-if="item.kind === 'test'"> · 测试邮件</span><span v-else-if="item.job_name"> · {{ item.job_name }}</span> · 尝试 {{ item.attempts }} 次<span v-if="item.sent_at"> · 发送于 {{ formatEmailTime(item.sent_at) }}</span></p>
              </div>
              <span class="badge" :class="{ ok: item.status === 'sent', bad: item.status === 'failed' }">{{ emailStatusLabels[item.status] }}</span>
            </div>
            <p v-if="item.error" class="bad-text email-delivery-error">{{ item.error }}</p>
            <div v-if="canRetryEmail(item)" class="actions"><button class="btn" :disabled="emailBusy" @click="retryEmailDelivery(item.id)">补发</button></div>
          </article>
        </details>
      </template>
    </div>
  </div>
</template>
<style scoped>
.notification-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.notification-head .btn { flex: none; text-decoration: none; }
.settings-section { border-top: 1px solid var(--line); padding-top: 16px; margin-top: 18px; }
.channel-card { display: grid; gap: 12px; }
h2 { font-size: var(--fs-sm); margin: 0; }
.credentials { display: grid; gap: 14px; }
.credentials label { display: grid; gap: 8px; font-size: 13px; }
.actions, .scope-options { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
.hint, small { color: var(--ink-soft); font-size: 12px; line-height: 1.7; }
.toggle, .scope-options label, .job-options label { display: flex; align-items: center; gap: 8px; }
.job-options { display: grid; gap: 12px; padding: 4px 0; }
.preview { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 13px; line-height: 1.7; padding: 14px; background: var(--paper-deep); border-radius: var(--radius-sm); }
summary { cursor: pointer; }
select { max-width: 100%; padding: 8px; background: var(--card); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-sm); }
.email-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.email-scope { margin-top: 4px; }
.scope-label { font-size: 13px; color: var(--ink-soft); }
.email-deliveries { display: grid; gap: 12px; }
.email-delivery { padding: 10px 0 0; }
.email-delivery + .email-delivery { border-top: 1px solid var(--line); padding-top: 14px; }
.email-delivery-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.email-delivery-head .badge { flex: none; }
.email-delivery-meta { margin: 4px 0 0; }
.email-delivery-error { margin: 8px 0 0; }
.email-deliveries .actions { margin-top: 8px; }
@media (max-width: 600px) { .notification-head { flex-direction: column; } .email-pair { grid-template-columns: 1fr; } }
</style>
