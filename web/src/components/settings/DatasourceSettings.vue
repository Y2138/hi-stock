<script setup lang="ts">
import { onMounted, ref } from "vue";
import { apiClient } from "../../api/client";
import type { SystemSettings } from "../../api/types";
import { appMessage } from "../../stores/message";
import UiInput from "../ui/UiInput.vue";

const settings = ref<SystemSettings | null>(null);
const apiKey = ref("");
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  const response = await apiClient.get<SystemSettings>("/api/system/settings");
  loading.value = false;
  if (response.ok) {
    settings.value = response.data;
    error.value = null;
  } else error.value = `${response.code}：${response.message}`;
}

async function save(): Promise<void> {
  const value = apiKey.value.trim();
  if (!value) return;
  saving.value = true;
  notice.value = null;
  const response = await apiClient.patch<SystemSettings>("/api/system/settings", {
    hithink_api_key: value,
  });
  saving.value = false;
  if (!response.ok) {
    error.value = `${response.code}：${response.message}`;
    return;
  }
  settings.value = response.data;
  apiKey.value = "";
  error.value = null;
  notice.value = "扶摇 API Key 已保存";
  appMessage.success(notice.value);
}

async function clear(): Promise<void> {
  if (!settings.value?.hithink_api_key_configured || !window.confirm("清除扶摇 API Key？清除后行情与财务同步将不可用。")) return;
  saving.value = true;
  const response = await apiClient.patch<SystemSettings>("/api/system/settings", {
    hithink_api_key: "",
  });
  saving.value = false;
  if (!response.ok) {
    error.value = `${response.code}：${response.message}`;
    return;
  }
  settings.value = response.data;
  error.value = null;
  notice.value = "扶摇 API Key 已清除";
  appMessage.success(notice.value);
}

onMounted(load);
</script>

<template>
  <div class="card datasource-settings">
    <div class="datasource-head">
      <div>
        <div class="card-title">⌁ 数据源凭据</div>
        <p class="card-desc">
          扶摇 API Key 保存在本机 PostgreSQL，接口只返回配置状态，不回显密钥正文。
          固定资产初始化包不会携带密钥，换电脑后需重新填写。
        </p>
      </div>
      <span v-if="settings" class="badge" :class="settings.hithink_api_key_configured ? 'ok' : 'bad'">
        {{ settings.hithink_api_key_configured ? "扶摇已配置" : "扶摇未配置" }}
      </span>
    </div>

    <p v-if="loading" class="settings-state">正在读取数据源设置…</p>
    <template v-else>
      <div class="key-row">
        <UiInput
          v-model="apiKey"
          type="password"
          autocomplete="new-password"
          :disabled="saving"
          :placeholder="settings?.hithink_api_key_configured ? '••••••••（输入新值可替换）' : '输入扶摇 API Key'"
          aria-label="扶摇 API Key"
          @keyup.enter="save"
        />
        <button class="btn primary" type="button" :disabled="saving || !apiKey.trim()" @click="save">保存</button>
        <button v-if="settings?.hithink_api_key_configured" class="btn danger" type="button" :disabled="saving" @click="clear">清除</button>
      </div>
      <p v-if="error" class="settings-state bad-text">{{ error }}</p>
      <p v-else-if="notice" class="settings-state ok-text">{{ notice }}</p>
    </template>
  </div>
</template>

<style scoped>
.datasource-settings { margin-bottom: 16px; }
.datasource-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.datasource-head .card-desc { max-width: 760px; margin-bottom: 0; }
.datasource-head .badge { flex: none; }
.key-row { display: grid; grid-template-columns: minmax(240px, 1fr) auto auto; gap: 10px; margin-top: 14px; }
.settings-state { margin: 10px 0 0; font-size: 12.5px; }
.danger { color: var(--bad); }
@media (max-width: 720px) { .key-row { grid-template-columns: 1fr; } }
</style>
