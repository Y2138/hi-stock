<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{
  startedAt?: number;
  endedAt?: number;
  running: boolean;
}>();

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

function syncTimer(): void {
  if (props.running && Number.isFinite(props.startedAt)) {
    if (!timer) timer = setInterval(() => { now.value = Date.now(); }, 1_000);
  } else if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

watch(() => [props.running, props.startedAt] as const, syncTimer, { immediate: true });
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

const duration = computed(() => {
  if (!Number.isFinite(props.startedAt)) return null;
  const end = Number.isFinite(props.endedAt) ? props.endedAt! : now.value;
  const seconds = Math.max(0, Math.floor((end - props.startedAt!) / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
});
</script>

<template>
  <span v-if="duration" class="tool-elapsed">{{ duration }}</span>
</template>

<style scoped>
.tool-elapsed {
  flex: none;
  color: var(--ink-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.tool-elapsed::before {
  content: "·";
  margin-right: 6px;
}
</style>
