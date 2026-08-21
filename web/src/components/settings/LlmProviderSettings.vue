<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { apiClient } from "../../api/client";
import type {
  LlmApiProtocol,
  LlmConfigCatalog,
  LlmModelConfig,
  LlmProviderConfig,
} from "../../api/types";
import UiInput from "../ui/UiInput.vue";
import UiSelect, { type SelectOption } from "../ui/UiSelect.vue";
import { appMessage } from "../../stores/message";

const PROTOCOL_OPTIONS: SelectOption[] = [
  { value: "openai-completions", label: "OpenAI Chat Completions 兼容" },
  { value: "openai-responses", label: "OpenAI Responses 兼容" },
  { value: "anthropic-messages", label: "Anthropic Messages 兼容" },
];

const catalog = ref<LlmConfigCatalog | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const selectedProviderId = ref<string | null>(null);
const creatingProvider = ref(false);
const savingProvider = ref(false);

const providerDraft = reactive({
  provider_key: "",
  name: "",
  api_protocol: "openai-completions" as LlmApiProtocol,
  base_url: "",
  api_key: "",
  enabled: true,
});

const selectedProvider = computed(
  () => catalog.value?.providers.find((provider) => provider.id === selectedProviderId.value) ?? null,
);
const activeModel = computed(() => {
  const activeId = catalog.value?.active_model_id;
  return catalog.value?.providers.flatMap((provider) => provider.models).find((model) => model.id === activeId) ?? null;
});
const activeProvider = computed(() =>
  catalog.value?.providers.find((provider) => provider.id === activeModel.value?.provider_id) ?? null,
);

function setCatalog(next: LlmConfigCatalog, preferredProviderId?: string): void {
  catalog.value = next;
  const desired = preferredProviderId ?? selectedProviderId.value;
  const selected = next.providers.find((provider) => provider.id === desired) ?? next.providers[0] ?? null;
  if (selected) selectProvider(selected);
  else startCreateProvider();
}

function notifyConfigChanged(): void {
  window.dispatchEvent(new CustomEvent("stock:llm-config-changed"));
}

async function load(): Promise<void> {
  loading.value = true;
  const response = await apiClient.get<LlmConfigCatalog>("/api/llm/providers");
  loading.value = false;
  if (!response.ok) {
    error.value = `${response.code}：${response.message}`;
    return;
  }
  error.value = null;
  setCatalog(response.data);
}

function selectProvider(provider: LlmProviderConfig): void {
  creatingProvider.value = false;
  selectedProviderId.value = provider.id;
  Object.assign(providerDraft, {
    provider_key: provider.provider_key,
    name: provider.name,
    api_protocol: provider.api_protocol,
    base_url: provider.base_url,
    api_key: "",
    enabled: provider.enabled,
  });
}

function startCreateProvider(): void {
  creatingProvider.value = true;
  selectedProviderId.value = null;
  Object.assign(providerDraft, {
    provider_key: "",
    name: "",
    api_protocol: "openai-completions",
    base_url: "",
    api_key: "",
    enabled: true,
  });
  closeModelEditor();
}

function providerValid(): boolean {
  return (
    providerDraft.name.trim().length > 0 &&
    providerDraft.base_url.trim().length > 0 &&
    (!creatingProvider.value || /^[a-z0-9][a-z0-9._-]*$/.test(providerDraft.provider_key))
  );
}

async function saveProvider(): Promise<void> {
  if (!providerValid()) return;
  const wasCreating = creatingProvider.value;
  savingProvider.value = true;
  notice.value = null;
  const common = {
    name: providerDraft.name.trim(),
    api_protocol: providerDraft.api_protocol,
    base_url: providerDraft.base_url.trim(),
    enabled: providerDraft.enabled,
    ...(providerDraft.api_key.trim() ? { api_key: providerDraft.api_key.trim() } : {}),
  };
  const response = creatingProvider.value
    ? await apiClient.post<LlmConfigCatalog & { id: string }>("/api/llm/providers", {
        ...common,
        provider_key: providerDraft.provider_key.trim(),
      })
    : await apiClient.patch<LlmConfigCatalog>(`/api/llm/providers/${selectedProviderId.value}`, common);
  savingProvider.value = false;
  if (!response.ok) {
    error.value = `${response.code}：${response.message}`;
    return;
  }
  error.value = null;
  const id = (response.data as Partial<{ id: string }>).id ?? selectedProviderId.value ?? undefined;
  setCatalog(response.data, id);
  notifyConfigChanged();
  notice.value = wasCreating ? "模型厂商已创建" : "模型厂商配置已保存";
  appMessage.success(notice.value);
}

async function clearApiKey(): Promise<void> {
  const provider = selectedProvider.value;
  if (!provider || !provider.api_key_configured) return;
  if (!window.confirm(`清除 ${provider.name} 的 API Key？`)) return;
  const response = await apiClient.patch<LlmConfigCatalog>(`/api/llm/providers/${provider.id}`, {
    api_key: "",
  });
  if (response.ok) {
    setCatalog(response.data, provider.id);
    notifyConfigChanged();
    notice.value = "API Key 已清除";
    appMessage.success(notice.value);
  } else error.value = `${response.code}：${response.message}`;
}

async function deleteProvider(): Promise<void> {
  const provider = selectedProvider.value;
  if (!provider || !window.confirm(`删除模型厂商“${provider.name}”及其模型？`)) return;
  const response = await apiClient.delete<LlmConfigCatalog>(`/api/llm/providers/${provider.id}`);
  if (response.ok) {
    selectedProviderId.value = null;
    setCatalog(response.data);
    notifyConfigChanged();
    notice.value = "模型厂商已删除";
    appMessage.success(notice.value);
  } else error.value = `${response.code}：${response.message}`;
}

const modelEditorOpen = ref(false);
const editingModelId = ref<string | null>(null);
const savingModel = ref(false);
const modelDraft = reactive({
  model_key: "",
  name: "",
  vision: false,
  reasoning: false,
  context_window: 128000,
  max_tokens: 8192,
  enabled: true,
});

function openCreateModel(): void {
  editingModelId.value = null;
  Object.assign(modelDraft, {
    model_key: "",
    name: "",
    vision: false,
    reasoning: false,
    context_window: 128000,
    max_tokens: 8192,
    enabled: true,
  });
  modelEditorOpen.value = true;
}

function openEditModel(model: LlmModelConfig): void {
  editingModelId.value = model.id;
  Object.assign(modelDraft, {
    model_key: model.model_key,
    name: model.name,
    vision: model.input_modalities.includes("image"),
    reasoning: model.reasoning,
    context_window: model.context_window,
    max_tokens: model.max_tokens,
    enabled: model.enabled,
  });
  modelEditorOpen.value = true;
}

function closeModelEditor(): void {
  modelEditorOpen.value = false;
  editingModelId.value = null;
}

async function saveModel(): Promise<void> {
  const provider = selectedProvider.value;
  if (!provider || !modelDraft.model_key.trim() || !modelDraft.name.trim()) return;
  const wasEditing = editingModelId.value !== null;
  savingModel.value = true;
  const body = {
    model_key: modelDraft.model_key.trim(),
    name: modelDraft.name.trim(),
    input_modalities: modelDraft.vision ? ["text", "image"] : ["text"],
    reasoning: modelDraft.reasoning,
    context_window: Number(modelDraft.context_window),
    max_tokens: Number(modelDraft.max_tokens),
    enabled: modelDraft.enabled,
  };
  const response = editingModelId.value
    ? await apiClient.patch<LlmConfigCatalog>(`/api/llm/models/${editingModelId.value}`, body)
    : await apiClient.post<LlmConfigCatalog & { id: string }>(
        `/api/llm/providers/${provider.id}/models`,
        body,
      );
  savingModel.value = false;
  if (response.ok) {
    setCatalog(response.data, provider.id);
    notifyConfigChanged();
    closeModelEditor();
    notice.value = wasEditing ? "模型已更新" : "模型已添加";
    appMessage.success(notice.value);
  } else error.value = `${response.code}：${response.message}`;
}

async function activateModel(model: LlmModelConfig): Promise<void> {
  const response = await apiClient.post<LlmConfigCatalog>(`/api/llm/models/${model.id}/activate`, {});
  if (response.ok) {
    setCatalog(response.data, model.provider_id);
    notifyConfigChanged();
    notice.value = `已切换到 ${model.name}`;
    appMessage.success(notice.value, { title: "默认模型已切换" });
  } else error.value = `${response.code}：${response.message}`;
}

async function deleteModel(model: LlmModelConfig): Promise<void> {
  if (!window.confirm(`删除模型“${model.name}”？`)) return;
  const response = await apiClient.delete<LlmConfigCatalog>(`/api/llm/models/${model.id}`);
  if (response.ok) {
    setCatalog(response.data, model.provider_id);
    notifyConfigChanged();
    notice.value = "模型已删除";
    appMessage.success(notice.value);
  } else error.value = `${response.code}：${response.message}`;
}

onMounted(load);
</script>

<template>
  <div class="card llm-settings">
    <div class="llm-head">
      <div>
        <div class="card-title">✦ AI 模型与厂商</div>
        <p class="card-desc">
          PostgreSQL 是唯一配置源。API Key 不会回显，但会随本地数据卷保存，请只在自有设备使用。
        </p>
      </div>
      <div
        v-if="activeModel && activeProvider"
        class="active-summary"
        :class="{ muted: !activeProvider.api_key_configured }"
      >
        <span class="dot" :class="activeProvider.api_key_configured ? 'ok' : 'warn'"></span>
        {{ activeProvider.api_key_configured ? "当前" : "已选，待密钥" }}：{{ activeProvider.name }} · {{ activeModel.name }}
      </div>
      <div v-else class="active-summary muted"><span class="dot warn"></span> 尚未选择模型</div>
    </div>

    <p v-if="error" class="settings-message bad-text">{{ error }}</p>
    <p v-else-if="notice" class="settings-message ok-text">{{ notice }}</p>
    <div v-if="loading" class="settings-loading">正在读取模型配置…</div>

    <div v-else class="provider-layout">
      <aside class="provider-list">
        <button
          v-for="provider in catalog?.providers"
          :key="provider.id"
          class="provider-item"
          :class="{ active: provider.id === selectedProviderId && !creatingProvider }"
          type="button"
          @click="selectProvider(provider)"
        >
          <span class="provider-name">{{ provider.name }}</span>
          <span class="provider-meta">
            {{ provider.models.length }} 个模型 · {{ provider.api_key_configured ? "密钥已配" : "缺少密钥" }}
          </span>
        </button>
        <button class="btn add-provider" type="button" @click="startCreateProvider">＋ 添加模型厂商</button>
      </aside>

      <div class="provider-detail">
        <div class="section-title">{{ creatingProvider ? "新建模型厂商" : "厂商配置" }}</div>
        <div class="provider-form">
          <label class="field">
            <span>厂商名称</span>
            <UiInput v-model="providerDraft.name" type="text" placeholder="如 OpenRouter" />
          </label>
          <label class="field">
            <span>厂商标识</span>
            <UiInput
              v-model="providerDraft.provider_key"
              type="text"
              placeholder="如 openrouter"
              :disabled="!creatingProvider"
            />
          </label>
          <label class="field span2">
            <span>API 协议</span>
            <UiSelect
              v-model="providerDraft.api_protocol"
              :options="PROTOCOL_OPTIONS"
              aria-label="API 协议"
            />
          </label>
          <label class="field span2">
            <span>Base URL</span>
            <UiInput v-model="providerDraft.base_url" type="url" placeholder="https://api.example.com/v1" />
          </label>
          <label class="field span2">
            <span>
              API Key
              <em v-if="selectedProvider?.api_key_configured" class="key-state">已配置 · 留空保持不变</em>
            </span>
            <UiInput
              v-model="providerDraft.api_key"
              type="password"
              autocomplete="new-password"
              :placeholder="selectedProvider?.api_key_configured ? '••••••••（留空保持）' : '输入 API Key'"
            />
          </label>
        </div>
        <div class="provider-actions">
          <label class="check-field">
            <input v-model="providerDraft.enabled" type="checkbox" /> 启用厂商
          </label>
          <button
            v-if="selectedProvider?.api_key_configured && !creatingProvider"
            class="btn"
            type="button"
            @click="clearApiKey"
          >清除密钥</button>
          <button v-if="!creatingProvider" class="btn danger" type="button" @click="deleteProvider">删除厂商</button>
          <span class="action-spacer"></span>
          <button class="btn primary" type="button" :disabled="!providerValid() || savingProvider" @click="saveProvider">
            {{ savingProvider ? "保存中…" : creatingProvider ? "创建厂商" : "保存配置" }}
          </button>
        </div>

        <template v-if="selectedProvider && !creatingProvider">
          <div class="models-head">
            <div>
              <div class="section-title">模型目录</div>
              <div class="section-hint">模型能力直接决定图片入口与上下文上限。</div>
            </div>
            <button class="btn" type="button" @click="openCreateModel">＋ 添加模型</button>
          </div>

          <div v-if="selectedProvider.models.length" class="model-list">
            <div
              v-for="model in selectedProvider.models"
              :key="model.id"
              class="model-row"
              :class="{ active: model.id === catalog?.active_model_id }"
            >
              <div class="model-main">
                <div class="model-name">
                  {{ model.name }}
                  <span v-if="model.id === catalog?.active_model_id" class="badge accent">当前</span>
                  <span v-if="!model.enabled" class="badge">停用</span>
                </div>
                <div class="model-meta num">
                  {{ model.model_key }} · {{ model.input_modalities.includes("image") ? "图文" : "文本" }} ·
                  {{ model.context_window.toLocaleString() }} ctx
                </div>
              </div>
              <button
                v-if="model.id !== catalog?.active_model_id"
                class="btn compact"
                type="button"
                :disabled="!model.enabled || !selectedProvider.enabled"
                @click="activateModel(model)"
              >设为当前</button>
              <button class="btn compact" type="button" @click="openEditModel(model)">编辑</button>
              <button class="icon-danger" type="button" title="删除模型" @click="deleteModel(model)">×</button>
            </div>
          </div>
          <div v-else class="empty-models">还没有模型，添加一个模型后才能启用 AI 对话。</div>

          <div v-if="modelEditorOpen" class="model-editor">
            <div class="section-title">{{ editingModelId ? "编辑模型" : "添加模型" }}</div>
            <div class="provider-form">
              <label class="field">
                <span>模型名称</span>
                <UiInput v-model="modelDraft.name" type="text" placeholder="如 GPT-5.4" />
              </label>
              <label class="field">
                <span>模型 ID</span>
                <UiInput v-model="modelDraft.model_key" type="text" placeholder="如 gpt-5.4" />
              </label>
              <label class="field">
                <span>上下文窗口</span>
                <UiInput v-model.number="modelDraft.context_window" type="number" min="1" step="1024" />
              </label>
              <label class="field">
                <span>最大输出 Token</span>
                <UiInput v-model.number="modelDraft.max_tokens" type="number" min="1" step="1024" />
              </label>
            </div>
            <div class="model-checks">
              <label class="check-field"><input v-model="modelDraft.vision" type="checkbox" /> 支持图片输入</label>
              <label class="check-field"><input v-model="modelDraft.reasoning" type="checkbox" /> 支持推理</label>
              <label class="check-field"><input v-model="modelDraft.enabled" type="checkbox" /> 启用模型</label>
            </div>
            <div class="provider-actions">
              <span class="action-spacer"></span>
              <button class="btn" type="button" @click="closeModelEditor">取消</button>
              <button
                class="btn primary"
                type="button"
                :disabled="savingModel || !modelDraft.name.trim() || !modelDraft.model_key.trim()"
                @click="saveModel"
              >{{ savingModel ? "保存中…" : "保存模型" }}</button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.llm-settings {
  margin-bottom: 16px;
  padding: 0;
  overflow: visible;
}

.llm-head {
  display: flex;
  align-items: flex-start;
  gap: 20px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--line);
}

.llm-head > div:first-child {
  flex: 1;
}

.active-summary {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 2px;
  padding: 6px 10px;
  border-radius: 999px;
  background: var(--down-bg);
  color: var(--down);
  font-size: 12px;
  white-space: nowrap;
}

.active-summary.muted {
  background: var(--paper-deep);
  color: var(--ink-soft);
}

.settings-message,
.settings-loading {
  margin: 12px 20px 0;
  font-size: 12.5px;
}

.provider-layout {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  min-height: 480px;
}

.provider-list {
  padding: 14px 10px;
  border-right: 1px solid var(--line);
  background: color-mix(in srgb, var(--paper) 75%, var(--card));
}

.provider-item {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 4px;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--ink);
  text-align: left;
  font-family: var(--font-body);
  cursor: pointer;
}

.provider-item:hover,
.provider-item.active {
  border-color: var(--line);
  background: var(--card);
}

.provider-item.active {
  box-shadow: var(--shadow-soft);
}

.provider-name {
  font-size: 13px;
  font-weight: 600;
}

.provider-meta {
  color: var(--ink-faint);
  font-size: 10.5px;
}

.add-provider {
  width: 100%;
  justify-content: center;
  margin-top: 8px;
}

.provider-detail {
  min-width: 0;
  padding: 18px 20px 22px;
}

.section-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--ink);
}

.section-hint {
  margin-top: 2px;
  color: var(--ink-faint);
  font-size: 11.5px;
}

.provider-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.field {
  min-width: 0;
}

.field > span {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
  color: var(--ink-soft);
  font-size: 11.5px;
}

.span2 {
  grid-column: span 2;
}

.key-state {
  color: var(--ok);
  font-style: normal;
}

.provider-actions,
.model-checks {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 14px;
}

.check-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-soft);
  font-size: 12px;
}

.action-spacer {
  flex: 1;
}

.btn.danger,
.icon-danger {
  color: var(--bad);
}

.models-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 24px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}

.model-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
}

.model-row.active {
  border-color: color-mix(in srgb, var(--accent) 50%, var(--line));
  background: var(--accent-soft);
}

.model-main {
  flex: 1;
  min-width: 0;
}

.model-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
}

.model-meta {
  overflow: hidden;
  margin-top: 2px;
  color: var(--ink-faint);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-danger {
  border: 0;
  background: transparent;
  font-size: 18px;
  cursor: pointer;
}

.empty-models {
  margin-top: 10px;
  padding: 18px;
  border: 1px dashed var(--line);
  border-radius: 10px;
  color: var(--ink-faint);
  font-size: 12px;
  text-align: center;
}

.model-editor {
  margin-top: 12px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--paper);
}

@media (max-width: 880px) {
  .provider-layout {
    grid-template-columns: 1fr;
  }

  .provider-list {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .provider-item,
  .add-provider {
    min-width: 150px;
    margin: 0;
  }
}
</style>
