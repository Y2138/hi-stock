<script setup lang="ts">
// 顶栏全局状态条：只保留行情截止日与最近任务结果。
// 尝试探测 /api/health，失败时优雅降级为「服务离线」，不阻塞页面。
import { onMounted, ref } from "vue";
import { apiClient, probeHealth } from "../api/client";
import type { JobDefinition, MarketCoverage } from "../api/types";
import { fmtDate } from "../utils/format";

const emit = defineEmits<{ (e: "open-palette"): void; (e: "refresh"): void }>();

/** 刷新按钮短暂旋转反馈（实际数据重取由 main-area 视图重挂载完成） */
const spinning = ref(false);

function onRefresh(): void {
  emit("refresh");
  spinning.value = true;
  window.setTimeout(() => (spinning.value = false), 650);
}

/** 行情截止日（market_bar day 最大 bar_date） */
const marketCutoff = ref<string>("—");
/** 服务连通状态 */
const serviceOnline = ref<boolean | null>(null);
/** 任务状态圆点与文案（最近一次运行） */
const jobDot = ref<"ok" | "warn" | "bad" | "idle">("idle");
const jobText = ref<string>("暂无任务");
const jobTitle = ref<string>("暂无运行记录");

const RUN_DOT: Record<string, "ok" | "warn" | "bad"> = {
  success: "ok",
  running: "ok",
  failed: "bad",
  partial: "warn",
  cancelled: "warn",
  missed: "warn",
};

const RUN_TEXT: Record<string, string> = {
  success: "任务正常",
  running: "任务运行中",
  failed: "任务失败",
  partial: "任务有缺口",
  cancelled: "任务已取消",
  missed: "任务已错过",
};

onMounted(async () => {
  const health = await probeHealth();
  serviceOnline.value = health.ok;
  if (!health.ok) {
    jobText.value = "服务离线";
    jobTitle.value = "服务离线";
    return;
  }
  const [coverage, jobs] = await Promise.all([
    apiClient.get<MarketCoverage[]>("/api/market/coverage"),
    apiClient.get<JobDefinition[]>("/api/jobs"),
  ]);
  if (coverage.ok) {
    const day = coverage.data.find((c) => c.freq === "day");
    if (day?.last_date) marketCutoff.value = fmtDate(day.last_date) ?? "—";
  }
  if (jobs.ok) {
    const runs = jobs.data
      .filter((d) => d.latest_run !== null)
      .map((d) => d.latest_run!)
      .sort((a, b) => String(b.started_at ?? b.scheduled_for ?? "").localeCompare(String(a.started_at ?? a.scheduled_for ?? "")));
    const latest = runs[0];
    if (latest) {
      jobDot.value = RUN_DOT[latest.status] ?? "idle";
      jobText.value = RUN_TEXT[latest.status] ?? "任务状态未知";
      jobTitle.value = `${latest.target_date} · ${latest.status}`;
    }
  }
});
</script>

<template>
  <header class="status-bar">
    <span class="item market-status" :title="`行情截止 ${marketCutoff}`">
      <span class="label status-label">行情</span>
      <span class="num">{{ marketCutoff }}</span>
    </span>
    <span class="item job-status" :title="jobTitle">
      <span class="dot breath" :class="serviceOnline === false ? 'bad' : jobDot"></span>
      <span>{{ jobText }}</span>
    </span>
    <span class="spacer"></span>
    <button
      class="refresh-btn"
      type="button"
      aria-label="刷新当前页面数据"
      title="刷新当前页面数据（不刷新浏览器）"
      @click="onRefresh"
    >
      <span class="refresh-icon" :class="{ spinning }">⟳</span>
    </button>
    <button class="palette-hint" type="button" aria-label="打开命令面板" title="打开命令面板" @click="emit('open-palette')">
      ⌘K
    </button>
  </header>
</template>

<style scoped>
.refresh-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 0;
  font-size: var(--fs-sm);
  font-family: var(--font-body);
  color: var(--ink-faint);
  background: var(--paper);
  cursor: pointer;
  transition:
    border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.refresh-btn:hover {
  border-color: var(--accent);
  color: var(--accent-ink);
}

.refresh-icon {
  display: inline-block;
  font-size: 13px;
}

.refresh-icon.spinning {
  animation: refresh-spin 0.65s var(--ease);
}

@keyframes refresh-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
