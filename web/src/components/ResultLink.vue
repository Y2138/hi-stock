<script setup lang="ts">
import { computed } from "vue";
import type { ResultRef } from "../utils/results";
import { openResult, resultLabel } from "../utils/results";

const props = defineProps<{ result: ResultRef; label?: string }>();
const text = computed(() => props.label ?? resultLabel(props.result));
</script>

<template>
  <button class="result-link" type="button" @click="openResult(result)"><span>↗</span>{{ text }}</button>
</template>

<style scoped>
.result-link{display:inline-flex;align-items:center;gap:6px;width:max-content;border:1px solid var(--accent);border-radius:999px;background:var(--accent-soft);color:var(--accent-ink);padding:5px 10px;cursor:pointer;font:600 var(--fs-sm)/1.2 var(--font-body)}.result-link:hover{background:var(--accent);color:white}.result-link span{font-size:11px}
</style>
