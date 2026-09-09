<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { AgentActivity } from "../../api/types";
import { activityLabel } from "../../utils/agent-activity";

const props = defineProps<{
  activity: AgentActivity | null;
  isJob: boolean;
  connected: boolean;
  queued: boolean;
}>();
const now = ref(Date.now());
const waitingSince = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1_000); });
onBeforeUnmount(() => clearInterval(timer));
const age = computed(() => props.activity ? Math.max(0, Math.floor((now.value - props.activity.at) / 1_000)) : 0);
const elapsed = computed(() => props.activity
  ? Math.max(0, Math.floor((now.value - (props.activity.started_at ?? props.activity.at)) / 1_000))
  : Math.max(0, Math.floor((now.value - waitingSince) / 1_000)));
const title = computed(() => !props.connected ? "进度连接恢复中" : props.queued ? "任务已排队，等待执行" : activityLabel(props.activity, props.isJob));
const progress = computed(() => {
  const { completed, total } = props.activity ?? {};
  return typeof completed === "number" && typeof total === "number" && total > 0 && completed >= 0 && completed <= total
    ? `${completed} / ${total} 项` : null;
});
</script>

<template>
  <aside class="activity-bar" :class="{ disconnected: !connected }">
    <div class="activity-title" role="status" aria-live="polite">
      <span class="activity-dot" aria-hidden="true"></span>
      <strong>{{ title }}</strong>
      <span v-if="progress" class="activity-progress">{{ progress }}</span>
    </div>
    <div class="activity-detail">
      <template v-if="!connected">暂时无法获取最新进度，任务可能仍在后台执行；连接恢复后自动更新。</template>
      <template v-else-if="queued">可以离开此面板，任务开始后会自动显示进度。</template>
      <template v-else>
        <span>{{ activity ? "此阶段已用时" : "已等待" }} {{ elapsed }} 秒</span>
        <span v-if="age >= 30"> · 已 {{ age }} 秒没有新进度，可继续等待或使用下方停止按钮。</span>
        <span v-else> · 阶段状态会自动更新</span>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.activity-bar { flex: none; margin: 8px 16px 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); }
.activity-title { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink); }
.activity-title strong { flex: 1; min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
.activity-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--accent-strong); animation: pulse 1.6s ease-in-out infinite; }
.disconnected .activity-dot { background: var(--warn); animation: none; }
.activity-progress { color: var(--ink-soft); font-variant-numeric: tabular-nums; white-space: nowrap; }
.activity-detail { margin: 5px 0 0 15px; color: var(--ink-soft); font-size: 11px; line-height: 1.6; }
@keyframes pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .activity-dot { animation: none; } }
</style>
