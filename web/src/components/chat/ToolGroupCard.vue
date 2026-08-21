<script setup lang="ts">
// 历史或异常情况下连续产生的同名工具调用聚合为一张摘要卡，默认折叠明细。
import { computed, ref } from "vue";
import { TOOL_LABELS } from "../../api/types";
import type { UiToolCall } from "../../utils/chat";
import ToolCard from "./ToolCard.vue";

const props = defineProps<{ tools: UiToolCall[] }>();
const emit = defineEmits<{
  (event: "decide", tool: UiToolCall, action: "approve" | "reject"): void;
}>();

const expanded = ref(false);
const name = computed(() => props.tools[0]?.name ?? "tool");
const label = computed(() => TOOL_LABELS[name.value] ?? name.value);
const running = computed(() => props.tools.filter((tool) => tool.status === "running").length);
const failed = computed(() => props.tools.filter((tool) => tool.status === "error").length);
const done = computed(() => props.tools.length - running.value - failed.value);
</script>

<template>
  <ToolCard
    v-if="tools.length === 1"
    :tool="tools[0]!"
    @decide="(action) => emit('decide', tools[0]!, action)"
  />
  <div v-else class="tool-group" :class="{ failed: failed > 0 }">
    <div class="tool-group-head">
      <span class="dot" :class="running ? 'warn breath' : failed ? 'bad' : 'ok'"></span>
      <span class="tool-group-name">{{ label }}</span>
      <span class="badge" :class="running ? 'warn' : failed ? 'bad' : 'ok'">
        {{ tools.length }} 项
      </span>
    </div>
    <div class="tool-group-summary">
      已完成 {{ done }}<template v-if="running"> · 运行中 {{ running }}</template><template v-if="failed"> · 失败 {{ failed }}</template>
    </div>
    <button class="expand-btn" type="button" @click="expanded = !expanded">
      {{ expanded ? "收起调用明细" : "展开调用明细" }}
    </button>
    <div v-if="expanded" class="tool-group-items">
      <ToolCard
        v-for="tool in tools"
        :key="tool.id"
        :tool="tool"
        @decide="(action) => emit('decide', tool, action)"
      />
    </div>
  </div>
</template>

<style scoped>
/* 气泡内的内联聚合条：与单工具条一致的左侧竖线风格 */
.tool-group {
  border: none;
  border-left: 2px solid var(--line);
  border-radius: 0;
  background: transparent;
  padding: 2px 0 2px 10px;
  margin: 6px 0;
  font-size: var(--fs-sm);
}

.tool-group.failed { border-left-color: var(--up); }
.tool-group-head { display: flex; align-items: center; gap: 8px; }
.tool-group-name { font-weight: 600; }
.tool-group-head .badge { margin-left: auto; }
.tool-group-summary { margin-top: 7px; color: var(--ink-soft); }
.expand-btn {
  border: none;
  background: none;
  color: var(--accent-strong);
  font-size: 11.5px;
  cursor: pointer;
  padding: 6px 0 0;
  font-family: var(--font-body);
}
.tool-group-items { margin-top: 6px; }

/* 聚合条展开后的明细不再重复竖线 */
.tool-group-items :deep(.tool-card) {
  border-left: none;
  padding-left: 0;
}
</style>
