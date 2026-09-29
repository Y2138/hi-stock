<script setup lang="ts">
// 顶栏全局状态条：只保留行情截止日与最近任务结果。
// 尝试探测 /api/health，失败时优雅降级为「服务离线」，不阻塞页面。
import { onMounted, ref } from "vue";
import { apiClient, probeHealth } from "../api/client";
import type { JobDefinition, MarketCoverage } from "../api/types";
import { fmtDate } from "../utils/format";

const emit = defineEmits<{ (e: "open-palette"): void; (e: "refresh"): void }>();

const refreshing = ref(false);
const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K";

async function onRefresh(): Promise<void> {
  if (refreshing.value) return;
  emit("refresh");
  await loadStatus();
}

/** 行情截止日（market_bar day 最大 bar_date） */
const marketCutoff = ref<string>("—");
/** 服务连通状态 */
const serviceOnline = ref<boolean | null>(null);
/** 任务状态圆点与文案（最近一次运行） */
const jobDot = ref<"ok" | "warn" | "bad" | "idle">("idle");
const jobText = ref<string>("正在检查");
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

async function loadStatus(): Promise<void> {
  refreshing.value = true;
  marketCutoff.value = "—";
  jobDot.value = "idle";
  jobText.value = "正在检查";
  jobTitle.value = "正在读取服务与任务状态";
  const health = await probeHealth();
  serviceOnline.value = health.ok;
  if (!health.ok) {
    jobText.value = "服务离线";
    jobTitle.value = "服务离线，请确认本地服务已启动后刷新";
    refreshing.value = false;
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
  jobText.value = jobs.ok ? "暂无任务" : "任务状态不可用";
  jobTitle.value = jobs.ok ? "暂无运行记录" : "任务状态读取失败，点击刷新重试";
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
  refreshing.value = false;
}

onMounted(loadStatus);
</script>

<template>
  <header class="status-bar">
    <span class="item market-status" :title="`行情截止 ${marketCutoff}`">
      <span class="label status-label">行情</span>
      <span class="num">{{ marketCutoff }}</span>
    </span>
    <RouterLink to="/jobs" class="item job-status" :title="`${jobTitle} · 查看任务中心`">
      <span class="dot breath" :class="serviceOnline === false ? 'bad' : jobDot"></span>
      <span>{{ jobText }}</span>
    </RouterLink>
    <span class="spacer"></span>
    <button
      class="refresh-btn"
      type="button"
      aria-label="刷新当前页面数据"
      title="刷新当前页面数据（不刷新浏览器）"
      :disabled="refreshing"
      :aria-busy="refreshing"
      @click="onRefresh"
    >
      <span class="refresh-icon" :class="{ spinning: refreshing }">⟳</span>
    </button>
    <button class="palette-hint" type="button" aria-label="打开命令面板" title="打开命令面板" @click="emit('open-palette')">
      <span class="search-label">搜索标的 / 页面</span><kbd>{{ shortcut }}</kbd>
    </button>
  </header>
</template>

<style scoped>
.job-status { color: var(--ink-soft); }
.job-status:hover { color: var(--accent-ink); }
.refresh-btn:disabled { cursor: wait; opacity: .6; }
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
  animation: refresh-spin 0.8s linear infinite;
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
