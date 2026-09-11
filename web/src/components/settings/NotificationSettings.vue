<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { apiClient } from "../../api/client";
import type { NotificationSettings } from "../../api/types";
import { appMessage } from "../../stores/message";
import UiInput from "../ui/UiInput.vue";
const settings = ref<NotificationSettings | null>(null);
const enabled = ref(false);
const allJobs = ref(true);
const jobCodes = ref<string[]>([]);
const previewJob = ref("");
const webhook = ref("");
const secret = ref("");
const busy = ref(false);
const error = ref("");
const preview = ref<{ output_id: string; job_name: string; content: string } | null>(null);
const previewLoaded = ref(false);
const scope = computed(() => allJobs.value ? null : [...jobCodes.value].sort());
const dirty = computed(() => !!webhook.value || !!secret.value || enabled.value !== settings.value?.enabled ||
  JSON.stringify(scope.value) !== JSON.stringify(settings.value?.job_codes === null ? null : [...(settings.value?.job_codes ?? [])].sort()));
const ready = computed(() => settings.value?.webhook_configured && settings.value?.sign_secret_configured);
function apply(value: NotificationSettings) {
  settings.value = value; enabled.value = value.enabled;
  allJobs.value = value.job_codes === null;
  jobCodes.value = value.job_codes ?? value.jobs.map((job) => job.code);
}
async function load() {
  const response = await apiClient.get<NotificationSettings>("/api/notifications/settings");
  if (response.ok) apply(response.data); else error.value = response.message;
}
async function save(clear = false) {
  busy.value = true; error.value = "";
  const body = clear ? { enabled: false, webhook: "", sign_secret: "" } : {
    enabled: enabled.value, job_codes: scope.value,
    ...(webhook.value.trim() ? { webhook: webhook.value.trim() } : {}),
    ...(secret.value.trim() ? { sign_secret: secret.value.trim() } : {}),
  };
  const response = await apiClient.patch<NotificationSettings>("/api/notifications/settings", body);
  busy.value = false;
  if (!response.ok) { error.value = response.message; return; }
  apply(response.data); webhook.value = ""; secret.value = "";
  appMessage.success(clear ? "推送配置已清除" : "飞书推送设置已保存");
}
async function showPreview() {
  busy.value = true; error.value = "";
  const query = previewJob.value ? `?job_code=${encodeURIComponent(previewJob.value)}` : "";
  const response = await apiClient.get<{ output_id: string; job_name: string; content: string } | null>(`/api/notifications/preview${query}`);
  busy.value = false;
  if (response.ok) { preview.value = response.data; previewLoaded.value = true; } else error.value = response.message;
}
async function test() {
  busy.value = true; error.value = "";
  const response = await apiClient.post("/api/notifications/test", {});
  busy.value = false;
  if (!response.ok) { error.value = response.message; return; }
  appMessage.success("测试消息已排队，可到通知记录查看发送状态");
}
onMounted(load);
</script>

<template>
  <div class="card notification-settings">
    <div class="notification-head">
      <div><div class="card-title">飞书消息推送</div><p class="card-desc">将 Agent 任务的最终结论发送到指定群，支持每日计划、竞价复核、周中检查、周复盘等任务。</p></div>
      <RouterLink class="btn" to="/settings/notifications/history">通知记录 →</RouterLink>
    </div>
    <p v-if="!settings">{{ error || '正在读取推送设置…' }}</p>
    <template v-else>
      <div class="settings-section">
        <h2>接收渠道</h2>
        <div class="credentials">
          <label>群机器人 Webhook · {{ settings.webhook_configured ? '已配置' : '未配置' }}
            <UiInput v-model="webhook" type="password" autocomplete="new-password" aria-label="飞书 Webhook" :disabled="busy" placeholder="输入新地址；留空保留现有配置" />
          </label>
          <label>签名密钥 · {{ settings.sign_secret_configured ? '已配置' : '未配置' }}
            <UiInput v-model="secret" type="password" autocomplete="new-password" aria-label="飞书签名密钥" :disabled="busy" placeholder="输入新密钥；留空保留现有配置" />
          </label>
        </div>
        <details class="hint"><summary>如何配置群机器人</summary><p>在飞书群设置中添加“自定义机器人”，开启签名校验并复制 Webhook 和密钥。若设置了关键词，请允许“Stock”。保存后不回显凭据。</p></details>
      </div>
      <div class="settings-section">
        <h2>推送范围</h2>
        <label class="toggle"><input v-model="enabled" type="checkbox" :disabled="busy" /> 自动推送 Agent 任务结论</label>
        <div class="scope-options">
          <label><input v-model="allJobs" type="radio" :value="true" :disabled="busy" /> 全部 Agent 任务（含新增任务）</label>
          <label><input v-model="allJobs" type="radio" :value="false" :disabled="busy" /> 选择任务</label>
        </div>
        <div v-if="!allJobs" class="job-options">
          <label v-for="job in settings.jobs" :key="job.code"><input v-model="jobCodes" type="checkbox" :value="job.code" :disabled="busy" /> {{ job.name }}<small v-if="!job.enabled">定时调度已停用</small></label>
          <p v-if="!jobCodes.length" class="hint">尚未选择任务，不会自动推送。</p>
        </div>
        <p class="hint">仅在任务成功并产出结论后发送，手动运行同一任务也适用。数据同步、失败和无结论的运行不发送。</p>
        <p class="hint">结论可能包含持仓信息，请确认接收群成员。关闭开关或取消任务订阅会暂停待发通知；凭据变更会取消旧队列。</p>
      </div>
      <div class="actions">
        <button class="btn primary" :disabled="busy || !dirty" @click="save()">保存设置</button>
        <button class="btn" :disabled="busy || !ready || dirty" @click="test">发送测试消息</button>
        <button class="btn" :disabled="busy || !(settings.webhook_configured || settings.sign_secret_configured)" @click="save(true)">清除配置并关闭</button>
      </div>
      <p v-if="error" class="bad-text" role="alert">{{ error }}</p>
      <details class="settings-section" @toggle="previewLoaded = false">
        <summary>预览任务结论</summary>
        <div class="actions">
          <select v-model="previewJob" aria-label="预览任务" :disabled="busy" @change="preview = null; previewLoaded = false">
            <option value="">最近完成的 Agent 任务</option><option v-for="job in settings.jobs" :key="job.code" :value="job.code">{{ job.name }}</option>
          </select>
          <button class="btn" :disabled="busy" @click="showPreview">预览最新结论</button>
        </div>
        <p class="hint">预览仅在本机展示，不发送消息。测试消息不包含业务数据。</p>
        <pre v-if="preview" class="preview">{{ preview.content }}</pre>
        <p v-else-if="previewLoaded" class="hint">该任务最近一次成功结果尚无可发送的结论。</p>
      </details>
    </template>
  </div>
</template>
<style scoped>
.notification-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.notification-head .btn { flex: none; text-decoration: none; }
.settings-section { border-top: 1px solid var(--line); padding-top: 16px; margin-top: 18px; }
h2 { font-size: var(--fs-sm); margin: 0 0 14px; }
.credentials { display: grid; gap: 14px; }
.credentials label { display: grid; gap: 8px; font-size: 13px; }
.actions, .scope-options { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
.hint, small { color: var(--ink-soft); font-size: 12px; line-height: 1.7; }
.toggle, .scope-options label, .job-options label { display: flex; align-items: center; gap: 8px; }
.job-options { display: grid; gap: 12px; padding: 14px 0; }
.preview { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 13px; line-height: 1.7; padding: 14px; background: var(--paper-deep); border-radius: var(--radius-sm); }
summary { cursor: pointer; }
select { max-width: 100%; padding: 8px; background: var(--card); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-sm); }
@media (max-width: 600px) { .notification-head { flex-direction: column; } }
</style>
