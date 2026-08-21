<script setup lang="ts">
// 标的搜索选择器：完整目录本地优先，本地不足时展示扶摇远程候选。
// 行情下钻与页面标的检索共用。
import { onBeforeUnmount, ref, watch } from "vue";
import { apiClient } from "../api/client";
import { INSTRUMENT_KIND_LABELS, type Instrument } from "../api/types";
import UiInput from "./ui/UiInput.vue";

const props = withDefaults(
  defineProps<{
    placeholder?: string;
    /** 外部受控的已选标的（用于 query 参数带入） */
    modelValue?: Instrument | null;
  }>(),
  { placeholder: "输入代码或名称搜索标的…", modelValue: null },
);
const emit = defineEmits<{
  (e: "update:modelValue", value: Instrument | null): void;
  (e: "select", value: Instrument): void;
}>();

const keyword = ref(props.modelValue ? `${props.modelValue.name} ${props.modelValue.code}` : "");
const results = ref<Instrument[]>([]);
const searching = ref(false);
const open = ref(false);
const activeIndex = ref(0);
/** 选中后抑制因 keyword 回填触发的再次搜索 */
let suppress = false;
let timer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      suppress = true;
      keyword.value = `${v.name} ${v.code}`;
    }
  },
);

async function search(q: string): Promise<void> {
  searching.value = true;
  const r = await apiClient.get<{ local: Instrument[]; remote: Instrument[] }>(
    `/api/instruments/search?q=${encodeURIComponent(q)}&remote=${q.length >= 2 ? "1" : "0"}`,
  );
  searching.value = false;
  if (r.ok) {
    results.value = [...r.data.local, ...r.data.remote].slice(0, 20);
    activeIndex.value = 0;
    open.value = true;
  } else if (r.code === "REMOTE_SEARCH_UNAVAILABLE" && Array.isArray(r.details?.local)) {
    results.value = r.details.local as Instrument[];
    activeIndex.value = 0;
    open.value = true;
  }
}

watch(keyword, (q) => {
  if (suppress) {
    suppress = false;
    return;
  }
  emit("update:modelValue", null);
  if (timer) clearTimeout(timer);
  const kw = q.trim();
  if (!kw) {
    results.value = [];
    open.value = false;
    return;
  }
  timer = setTimeout(() => void search(kw), 300);
});

function choose(item: Instrument): void {
  suppress = true;
  keyword.value = `${item.name} ${item.code}`;
  open.value = false;
  emit("update:modelValue", item);
  emit("select", item);
}

function onKeydown(e: KeyboardEvent): void {
  if (!open.value || results.value.length === 0) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeIndex.value = (activeIndex.value + 1) % results.value.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIndex.value =
      (activeIndex.value - 1 + results.value.length) % results.value.length;
  } else if (e.key === "Enter") {
    e.preventDefault();
    const item = results.value[activeIndex.value];
    if (item) choose(item);
  } else if (e.key === "Escape") {
    open.value = false;
  }
}

function onBlur(): void {
  setTimeout(() => {
    open.value = false;
  }, 150);
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <div class="picker">
    <UiInput
      v-model="keyword"
      type="text"
      :placeholder="placeholder"
      @keydown="onKeydown"
      @focus="results.length > 0 && (open = true)"
      @blur="onBlur"
    />
    <ul v-if="open && results.length > 0" class="picker-list">
      <li
        v-for="(item, i) in results"
        :key="item.code"
        :class="{ active: i === activeIndex }"
        @mouseenter="activeIndex = i"
        @mousedown.prevent="choose(item)"
      >
        <span>{{ item.name }}</span>
        <span class="num">{{ item.code }}</span>
        <span class="kind">{{ INSTRUMENT_KIND_LABELS[item.kind] ?? item.kind }}</span>
        <span v-if="item.persisted === false" class="remote">远程候选</span>
      </li>
    </ul>
    <div v-else-if="open && !searching && keyword.trim()" class="picker-empty">无匹配标的</div>
  </div>
</template>

<style scoped>
.picker {
  position: relative;
}

.picker-list {
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  list-style: none;
  margin: 0;
  padding: 6px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lift);
  max-height: 260px;
  overflow-y: auto;
}

.picker-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--ink-soft);
  font-size: var(--fs-sm);
}

.picker-list li.active {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.picker-list .kind {
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--ink-faint);
}

.picker-list .remote {
  font-size: var(--fs-xs);
  color: var(--warn);
}

.picker-empty {
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  padding: 10px 12px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lift);
  color: var(--ink-faint);
  font-size: var(--fs-sm);
}
</style>
