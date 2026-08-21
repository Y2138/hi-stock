<script setup lang="ts">
// 设置（/settings）：系统配置 + M4 外观、主题与动效偏好。
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
import DatasourceSettings from "../components/settings/DatasourceSettings.vue";
</script>

<template>
  <section>
    <div class="page-head">
      <h1>设置</h1>
      <div class="sub">系统配置 · 密钥只显示「已配置/未配置」，不展示本体</div>
    </div>

    <div class="card" style="margin-bottom: 16px">
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

    <AgentModeSettings />

    <AgentMetricsSummary />

    <DatasourceSettings />

    <LlmProviderSettings />
  </section>
</template>

<style scoped>
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
