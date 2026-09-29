<script setup lang="ts">
// 全局命令面板（Cmd/Ctrl+K 唤起）：页面导航候选 + 标的搜索（/api/instruments?q=，防抖）。
// 回车直达：页面 → 跳转；标的 → 行情页带 code 下钻。Esc 或点击遮罩关闭。
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { apiClient } from "../api/client";
import { INSTRUMENT_KIND_LABELS, type Instrument } from "../api/types";
import { NAV_GROUPS } from "../navigation";

interface Candidate {
  icon: string;
  label: string;
  hint?: string;
  kind: string;
  to?: string;
  code?: string;
}

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const router = useRouter();
const keyword = ref("");
const activeIndex = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);
const instrumentHits = ref<Instrument[]>([]);
const searching = ref(false);
const searchError = ref(false);
const listEl = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let searchSeq = 0;

const PAGE_CANDIDATES: Candidate[] = [
  ...NAV_GROUPS.flatMap((group) => group.items.map((item) => ({ ...item, kind: "页面" }))),
  { icon: "💬", label: "对话", kind: "页面", to: "/chat" },
];

const filtered = computed<Candidate[]>(() => {
  const kw = keyword.value.trim().toLowerCase();
  const instruments: Candidate[] = instrumentHits.value.map((i) => ({
    icon: "🔍",
    label: `${i.name} ${i.code}`,
    hint: INSTRUMENT_KIND_LABELS[i.kind] ?? i.kind,
    kind: "标的",
    code: i.code,
  }));
  if (!kw) return [...instruments, ...PAGE_CANDIDATES];
  const pages = PAGE_CANDIDATES.filter(
    (c) => c.label.toLowerCase().includes(kw) || c.kind.toLowerCase().includes(kw),
  );
  return [...instruments, ...pages];
});

async function searchInstruments(q: string, my: number): Promise<void> {
  const r = await apiClient.get<{ local: Instrument[]; remote: Instrument[] }>(
    `/api/instruments/search?q=${encodeURIComponent(q)}&remote=1`,
  );
  if (my !== searchSeq) return;
  searching.value = false;
  searchError.value = !r.ok;
  instrumentHits.value = r.ok
    ? [...new Map([...r.data.local, ...r.data.remote].map((item) => [item.code, item])).values()].slice(0, 8)
    : [];
  activeIndex.value = 0;
}

watch(keyword, (q) => {
  activeIndex.value = 0;
  if (timer) clearTimeout(timer);
  const my = ++searchSeq;
  const kw = q.trim();
  instrumentHits.value = [];
  searchError.value = false;
  searching.value = !!kw && props.open;
  if (!searching.value) return;
  timer = setTimeout(() => void searchInstruments(kw, my), 200);
});

watch(
  () => props.open,
  async (open) => {
    if (open) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      searchError.value = false;
      searching.value = false;
      keyword.value = "";
      instrumentHits.value = [];
      activeIndex.value = 0;
      await nextTick();
      inputEl.value?.focus();
    } else {
      if (timer) clearTimeout(timer);
      searchSeq++;
      searching.value = false;
      returnFocus?.focus();
    }
  },
);

watch(activeIndex, async (index) => {
  await nextTick();
  listEl.value?.children[index]?.scrollIntoView({ block: "nearest" });
});

function move(delta: number): void {
  const n = filtered.value.length;
  if (n === 0) return;
  activeIndex.value = (activeIndex.value + delta + n) % n;
}

function choose(item: Candidate): void {
  if (item.code) void router.push({ path: "/market", query: { code: item.code, view: "detail" } });
  else if (item.to) void router.push(item.to);
  emit("close");
}

function onKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return;
  if (e.target !== inputEl.value && !["Escape", "Tab"].includes(e.key)) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    move(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    move(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const item = filtered.value[activeIndex.value];
    if (item) choose(item);
  } else if (e.key === "Escape") {
    e.stopPropagation();
    emit("close");
  } else if (e.key === "Tab") {
    e.preventDefault();
    if (document.activeElement === inputEl.value) {
      inputEl.value?.closest(".palette")?.querySelector<HTMLButtonElement>(".palette-close")?.focus();
    } else inputEl.value?.focus();
  }
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
  searchSeq++;
});
</script>

<template>
  <Teleport to="body">
    <Transition name="palette">
      <div v-if="open" class="palette-mask" @click.self="emit('close')">
        <div class="palette" role="dialog" aria-modal="true" aria-label="命令面板" @keydown="onKeydown">
          <input
            ref="inputEl"
            v-model="keyword"
            type="text"
            placeholder="搜索标的（代码/名称）、页面…"
            role="combobox"
            aria-label="搜索标的或页面"
            aria-autocomplete="list"
            aria-controls="command-candidates"
            aria-expanded="true"
            :aria-activedescendant="filtered.length ? `command-option-${activeIndex}` : undefined"
            autocomplete="off"
          />
          <p v-if="searching || searchError" class="palette-feedback" role="status">
            {{ searching ? "正在搜索标的，页面入口仍可直接选择…" : "标的搜索暂不可用，请重新输入重试；仍可跳转页面。" }}
          </p>
          <ul id="command-candidates" ref="listEl" role="listbox" aria-label="搜索结果">
            <li
              v-for="(item, i) in filtered"
              :key="item.code ?? item.label"
              :id="`command-option-${i}`"
              role="option"
              :aria-selected="i === activeIndex"
              :class="{ active: i === activeIndex }"
              @mouseenter="activeIndex = i"
              @click="choose(item)"
            >
              <span>{{ item.icon }}</span>
              <span>{{ item.label }}</span>
              <span v-if="item.hint" style="font-size: 11px; color: var(--ink-faint)">
                {{ item.hint }}
              </span>
              <span class="kind">{{ item.kind }}</span>
            </li>
          </ul>
          <p v-if="!filtered.length && !searching && !searchError" class="palette-feedback" role="status">没有匹配结果，试试标的代码、名称或页面名称。</p>
          <div class="palette-help">↑ ↓ 选择 · Enter 打开 · Esc 关闭<button class="palette-close" type="button" @click="emit('close')">关闭</button></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
