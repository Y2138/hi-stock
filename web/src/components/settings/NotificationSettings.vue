<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { apiClient } from "../../api/client";
import type { NotificationSettings } from "../../api/types";
import { appMessage } from "../../stores/message";
import UiInput from "../ui/UiInput.vue";
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
onMounted(load);
</script>

<template>
  <div class="card notification-settings">
    <div class="notification-head">
      <div><div class="card-title">飞书消息推送</div><p class="card-desc">个人消息只发送每日计划；策略任务消息发送除每日计划外的通用策略任务，两个通道互不混发。</p></div>
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
@media (max-width: 600px) { .notification-head { flex-direction: column; } }
</style>
