<script setup lang="ts">
// 三态占位：加载中稳定骨架 / 失败原位报错+重试 / 空数据明示。各业务视图统一使用。
import type { ApiFail } from "../api/client";

withDefaults(
  defineProps<{
    loading: boolean;
    error: ApiFail | null;
    /** 数据为空（成功但无记录）时显示空态文案 */
    empty?: boolean;
    emptyText?: string;
    skeletonRows?: number;
    loadingText?: string;
  }>(),
  { empty: false, emptyText: "暂无数据", skeletonRows: 4, loadingText: "" },
);

const emit = defineEmits<{ (e: "retry"): void }>();
</script>

<template>
  <div v-if="loading" class="state-block" aria-busy="true" aria-label="加载中">
    <div v-if="loadingText" class="loading-text">{{ loadingText }}</div>
    <div v-for="i in skeletonRows" :key="i" class="skeleton-line" :style="{ width: `${92 - (i % 3) * 14}%` }" />
  </div>
  <div v-else-if="error" class="state-block error" role="alert">
    <span>⚠ 加载失败（{{ error.code }}）：{{ error.message }}</span>
    <button class="btn" type="button" @click="emit('retry')">重试</button>
  </div>
  <div v-else-if="empty" class="state-block empty">{{ emptyText }}</div>
  <slot v-else />
</template>

<style scoped>
.loading-text { margin-bottom: 10px; color: var(--ink-soft); font-size: var(--fs-sm); }
</style>
