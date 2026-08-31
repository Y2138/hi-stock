<script setup lang="ts">
import { onMounted, ref } from "vue";
import { apiClient } from "../../api/client";
import type { AgentSettings } from "../../api/types";
import { appMessage } from "../../stores/message";

const settings = ref<AgentSettings | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const message = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  const response = await apiClient.get<AgentSettings>("/api/agent/settings");
  loading.value = false;
  if (response.ok) {
    settings.value = response.data;
    error.value = null;
  } else {
    error.value = `${response.code}：${response.message}`;
  }
}

async function changeMode(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const next = input.checked;
  if (
    next &&
    !window.confirm(
      "开启 YOLO 后，Agent 发起的持仓、短线/长线池、任务和记忆写入将跳过确认卡，并通过对应业务 service 直接执行。回测结论最终化本就直接执行；策略发布仍必须真人确认。事务、写锁、状态冲突检测和审计仍然生效。确认开启？",
    )
  ) {
    input.checked = false;
    return;
  }
  saving.value = true;
  error.value = null;
  message.value = null;
  const response = await apiClient.patch<AgentSettings>("/api/agent/settings", {
    yolo_mode: next,
  });
  saving.value = false;
  if (!response.ok) {
    input.checked = settings.value?.yolo_mode ?? false;
    error.value = `${response.code}：${response.message}`;
    return;
  }
  settings.value = response.data;
  message.value = next ? "YOLO 模式已开启，数据库变更将直接执行" : "已恢复确认制";
  appMessage.success(message.value, { title: "执行模式已更新" });
  window.dispatchEvent(new CustomEvent("stock:agent-settings-changed"));
}

async function changeCapability(
  key: "market_domain_tools_enabled" | "web_research_enabled",
  event: Event,
): Promise<void> {
  const input = event.target as HTMLInputElement;
  const previous = settings.value?.[key] ?? false;
  saving.value = true;
  error.value = null;
  const response = await apiClient.patch<AgentSettings>("/api/agent/settings", { [key]: input.checked });
  saving.value = false;
  if (!response.ok) {
    input.checked = previous;
    error.value = `${response.code}：${response.message}`;
    return;
  }
  settings.value = response.data;
  message.value = key === "market_domain_tools_enabled"
    ? (input.checked ? "候选市场领域工具已允许注册；执行时仍会重验开关" : "市场领域工具已关闭")
    : (input.checked ? "Web 研究首层开关已开启，但供应商未批准，仍不会注册 Web 工具" : "Web 研究开关已关闭");
  appMessage.success(message.value, { title: "Agent 能力设置已更新" });
  window.dispatchEvent(new CustomEvent("stock:agent-settings-changed"));
}

onMounted(load);
</script>

<template>
  <div class="card agent-mode-card">
    <div class="mode-head">
      <div>
        <div class="card-title">⚡ Agent 数据库执行模式</div>
        <p class="card-desc">
          默认确认制会先生成确认卡。YOLO 模式跳过人工确认并直接执行五类领域写工具，
          所有写入仍通过对应业务 service；策略发布始终真人确认，临时回测运行本身不走业务写入确认。
        </p>
      </div>
      <span v-if="settings" class="badge" :class="settings.yolo_mode ? 'bad' : 'ok'">
        {{ settings.yolo_mode ? "YOLO 已开启" : "确认制" }}
      </span>
    </div>

    <p v-if="loading" class="mode-state">正在读取 Agent 设置…</p>
    <p v-else-if="error" class="mode-state bad-text">{{ error }}</p>
    <template v-else-if="settings">
      <label class="mode-toggle">
        <input
          type="checkbox"
          :checked="settings.yolo_mode"
          :disabled="saving"
          @change="changeMode"
        />
        <span>
          <strong>启用 YOLO 模式</strong>
          <small>无需确认卡；领域校验、事务、写锁、状态冲突检测、敏感数据保护和工具审计不会关闭。</small>
        </span>
      </label>
      <p v-if="settings.yolo_mode" class="yolo-warning">
        ⚠ 当前为直接写库模式。只有在你希望 agent 自主执行数据库变更时保持开启。
      </p>
      <div class="capability-grid">
        <label class="mode-toggle capability-toggle">
          <input
            type="checkbox"
            :checked="settings.market_domain_tools_enabled"
            :disabled="saving"
            @change="changeCapability('market_domain_tools_enabled', $event)"
          />
          <span>
            <strong>候选市场领域只读工具</strong>
            <small>允许会话注册标的检索、快照、板块、市场结构和指标 5 个快捷工具；默认关闭，通用数据库只读工具继续保留。</small>
          </span>
        </label>
        <label class="mode-toggle capability-toggle">
          <input
            type="checkbox"
            :checked="settings.web_research_enabled"
            :disabled="saving"
            @change="changeCapability('web_research_enabled', $event)"
          />
          <span>
            <strong>Web 研究预留开关</strong>
            <small>目前只有白名单 Provider 契约。供应商和安全评审未完成前，即使开启也不会注册 Web 工具或保存凭据。</small>
          </span>
        </label>
      </div>
      <p v-if="message" class="mode-state ok-text">{{ message }}</p>
    </template>
  </div>
</template>

<style scoped>
.agent-mode-card { margin-bottom: 16px; }
.mode-head { display: flex; align-items: flex-start; gap: 18px; justify-content: space-between; }
.mode-head .card-desc { max-width: 760px; margin-bottom: 0; }
.mode-head .badge { flex: none; }
.mode-toggle {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--paper-deep);
  cursor: pointer;
}
.mode-toggle input { margin-top: 3px; accent-color: var(--bad); }
.mode-toggle span { display: flex; flex-direction: column; gap: 3px; }
.mode-toggle small { color: var(--ink-soft); line-height: 1.55; }
.yolo-warning {
  margin: 10px 0 0;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--bad) 40%, var(--line));
  border-radius: var(--radius-sm);
  color: var(--bad);
  background: color-mix(in srgb, var(--bad) 7%, var(--paper));
}
.mode-state { margin: 10px 0 0; font-size: 12.5px; }
.capability-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; margin-top: 10px; }
.capability-toggle { margin-top: 0; }
.capability-toggle input { accent-color: var(--accent); }
</style>
