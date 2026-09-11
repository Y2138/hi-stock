<script setup lang="ts">
// 分区显示设置，切换分区保留未保存的表单内容。
import { computed } from "vue";
import { useRoute } from "vue-router";
const route = useRoute();
const sections = [
  { key: "models", label: "模型" }, { key: "agent", label: "Agent" },
  { key: "datasource", label: "数据源" }, { key: "notifications", label: "消息推送" },
  { key: "appearance", label: "外观" },
];
const section = computed(() => sections.some((s) => s.key === route.query.section) ? route.query.section : "models");
import {
  colorSchemePreference,
  currentTheme,
  motionOff,
  setColorScheme,
  setMotionOff,
  setTheme,
} from "../stores/theme";
import LlmProviderSettings from "../components/settings/LlmProviderSettings.vue";
import AgentModeSettings from "../components/settings/AgentModeSettings.vue";
import AgentMetricsSummary from "../components/settings/AgentMetricsSummary.vue";
import NotificationSettings from "../components/settings/NotificationSettings.vue";
import DatasourceSettings from "../components/settings/DatasourceSettings.vue";
</script>

<template>
  <section>
    <div class="page-head">
      <h1>设置</h1>
      <div class="sub">系统配置 · 密钥只显示「已配置/未配置」，不展示本体</div>
    </div>

    <nav class="settings-nav" aria-label="设置分区">
      <RouterLink v-for="item in sections" :key="item.key"
        :to="{ path: '/settings', query: { ...route.query, section: item.key } }"
        :aria-current="section === item.key ? 'page' : undefined"
        :class="{ selected: section === item.key }">{{ item.label }}</RouterLink>
    </nav>
    <div v-show="section === 'appearance'" class="card">
      <div class="card-title">🎨 外观与动效</div>
      <p class="card-desc">
        明暗外观与强调色分别设置，选择会立即全站生效并在本机持久化。
      </p>
      <div class="preference-row">
        <span class="preference-label">外观</span>
        <button class="btn" :class="{ primary: colorSchemePreference === 'system' }" type="button" @click="setColorScheme('system')">跟随系统</button>
        <button class="btn" :class="{ primary: colorSchemePreference === 'light' }" type="button" @click="setColorScheme('light')">浅色</button>
        <button class="btn" :class="{ primary: colorSchemePreference === 'dark' }" type="button" @click="setColorScheme('dark')">深色</button>
      </div>
      <div class="preference-row">
        <span class="preference-label">强调色</span>
        <button
          class="btn"
          :class="{ primary: currentTheme === 'warm' }"
          type="button"
          @click="setTheme('warm')"
        >
          暖橙
        </button>
        <button
          class="btn"
          :class="{ primary: currentTheme === 'teal' }"
          type="button"
          @click="setTheme('teal')"
        >
          青绿
        </button>
      </div>
      <div class="preference-row">
        <span class="preference-label">动效</span>
        <label class="motion-toggle">
          <input
            type="checkbox"
            :checked="motionOff"
            @change="setMotionOff(($event.target as HTMLInputElement).checked)"
          />
          关闭全局动效（同时尊重系统“减少动态效果”）
        </label>
      </div>
    </div>

    <div v-show="section === 'agent'"><AgentModeSettings /><AgentMetricsSummary /></div>
    <DatasourceSettings v-show="section === 'datasource'" />
    <NotificationSettings v-show="section === 'notifications'" />
    <LlmProviderSettings v-show="section === 'models'" />
  </section>
</template>

<style scoped>
.settings-nav { display: flex; gap: 4px; overflow-x: auto; margin-bottom: 20px; border-bottom: 1px solid var(--line); }
.settings-nav a { flex: none; padding: 12px 16px; color: var(--ink-soft); text-decoration: none; border-bottom: 2px solid transparent; }
.settings-nav a.selected { color: var(--accent-ink); border-bottom-color: var(--accent); font-weight: 600; }
.settings-nav a:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }

.preference-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}

.preference-label {
  width: 56px;
  flex: none;
  color: var(--ink-soft);
  font-size: var(--fs-sm);
}

.motion-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--ink-soft);
}
</style>
