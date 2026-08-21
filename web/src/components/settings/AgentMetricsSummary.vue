<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { apiClient } from "../../api/client";
import type { AgentMetricSummary } from "../../api/types";
import StateBlock from "../StateBlock.vue";

const summary = ref<AgentMetricSummary | null>(null);
const loading = ref(false);
const error = ref<import("../../api/client").ApiFail | null>(null);
const days = ref(7);

function metricPath(): string {
  const from = new Date(Date.now() - days.value * 86_400_000).toISOString();
  return `/api/agent/metrics/summary?from=${encodeURIComponent(from)}`;
}
async function load(): Promise<void> {
  loading.value = true;
  const response = await apiClient.get<AgentMetricSummary>(metricPath());
  loading.value = false;
  if (response.ok) { summary.value = response.data; error.value = null; }
  else error.value = response;
}
const cacheTokens = computed(() => (summary.value?.tokens.cache_read ?? 0) + (summary.value?.tokens.cache_write ?? 0));
function duration(value: number | null): string { return value === null ? "—" : `${Math.round(value)} ms`; }
onMounted(load);
</script>

<template>
  <div class="card metrics-card">
    <div class="metrics-head">
      <div><div class="card-title">📐 Agent 运行摘要</div><p class="card-desc">只含 token、成本、时延、工具轮次和状态聚合；不返回提示词或工具正文。</p></div>
      <div class="period"><button v-for="value in [1, 7, 30]" :key="value" class="btn compact" :class="{ primary: days === value }" type="button" @click="days = value; load()">{{ value }} 天</button><button class="btn compact" type="button" @click="load">刷新</button></div>
    </div>
    <StateBlock :loading="loading" :error="error" :skeleton-rows="3" @retry="load">
      <div v-if="summary" class="metric-grid">
        <div><span>运行</span><strong class="num">{{ summary.runs.total }}</strong><small>完成 {{ summary.runs.status.complete ?? 0 }} · 失败 {{ summary.runs.status.failed ?? 0 }}</small></div>
        <div><span>输入 / 输出 token</span><strong class="num">{{ summary.tokens.input.toLocaleString() }} / {{ summary.tokens.output.toLocaleString() }}</strong><small>缓存 {{ cacheTokens.toLocaleString() }} · 推理 {{ summary.tokens.reasoning.toLocaleString() }}</small></div>
        <div><span>首字 / 总时延 P95</span><strong class="num">{{ duration(summary.latency_ms.first_text_p95) }} / {{ duration(summary.latency_ms.total_p95) }}</strong><small>平均工具轮次 {{ summary.runs.average_tool_calls.toFixed(2) }}</small></div>
        <div><span>工具调用</span><strong class="num">{{ summary.tools.total }}</strong><small>平均 {{ duration(summary.tools.average_duration_ms) }} · 错误 {{ summary.tools.status.error ?? 0 }}</small></div>
        <div><span>供应商成本</span><strong class="num">{{ summary.cost_amount.toFixed(6) }}</strong><small>按模型供应商实际 usage 汇总</small></div>
      </div>
    </StateBlock>
  </div>
</template>

<style scoped>
.metrics-card { margin-bottom: 16px; }.metrics-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }.period { display: flex; gap: 5px; flex: none; }.metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; margin-top: 12px; }.metric-grid > div { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; background: var(--paper-deep); border-radius: var(--radius-sm); }.metric-grid span, .metric-grid small { color: var(--ink-soft); font-size: var(--fs-xs); }.metric-grid strong { font-size: var(--fs-lg); }
</style>
