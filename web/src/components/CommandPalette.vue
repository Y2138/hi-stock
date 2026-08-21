<script setup lang="ts">
// 全局命令面板（Cmd/Ctrl+K 唤起）：页面导航候选 + 标的搜索（/api/instruments?q=，防抖）。
// 回车直达：页面 → 跳转；标的 → 行情页带 code 下钻。Esc 或点击遮罩关闭。
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { apiClient } from "../api/client";
import { INSTRUMENT_KIND_LABELS, type Instrument } from "../api/types";

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
let timer: ReturnType<typeof setTimeout> | null = null;
let searchSeq = 0;

const PAGE_CANDIDATES: Candidate[] = [
  { icon: "📊", label: "仪表盘", kind: "页面", to: "/" },
  { icon: "💼", label: "持仓", kind: "页面", to: "/positions" },
  { icon: "⏱", label: "任务中心", kind: "页面", to: "/jobs" },
  { icon: "⚡", label: "短线池", kind: "页面", to: "/short-pool" },
  { icon: "🌱", label: "长线池", kind: "页面", to: "/long-pool" },
  { icon: "📈", label: "行情", kind: "页面", to: "/market" },
  { icon: "▦", label: "市场结构", kind: "页面", to: "/market-structure" },
  { icon: "📜", label: "内容库", kind: "页面", to: "/strategies" },
  { icon: "🧪", label: "回测", kind: "页面", to: "/backtests" },
  { icon: "🧠", label: "Agent 记忆", kind: "页面", to: "/memories" },
  { icon: "💾", label: "数据与备份", kind: "页面", to: "/datasync" },
  { icon: "⚙️", label: "设置", kind: "页面", to: "/settings" },
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

async function searchInstruments(q: string): Promise<void> {
  const my = ++searchSeq;
  searching.value = true;
  const r = await apiClient.get<{ local: Instrument[]; remote: Instrument[] }>(
    `/api/instruments/search?q=${encodeURIComponent(q)}&remote=1`,
  );
  if (my !== searchSeq) return;
  searching.value = false;
  instrumentHits.value = r.ok ? [...r.data.local, ...r.data.remote].slice(0, 8) : [];
}

watch(keyword, (q) => {
  activeIndex.value = 0;
  if (timer) clearTimeout(timer);
  const kw = q.trim();
  if (!kw) {
    instrumentHits.value = [];
    return;
  }
  timer = setTimeout(() => void searchInstruments(kw), 200);
});

watch(
  () => props.open,
  async (open) => {
    if (open) {
      keyword.value = "";
      instrumentHits.value = [];
      activeIndex.value = 0;
      await nextTick();
      inputEl.value?.focus();
    }
  },
);

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
    emit("close");
  }
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="palette">
      <div v-if="open" class="palette-mask" @click.self="emit('close')">
        <div class="palette" role="dialog" aria-label="命令面板">
          <input
            ref="inputEl"
            v-model="keyword"
            type="text"
            placeholder="搜索标的（代码/名称）、页面…"
            @keydown="onKeydown"
          />
          <ul>
            <li
              v-for="(item, i) in filtered"
              :key="item.code ?? item.label"
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
            <li v-if="filtered.length === 0">{{ searching ? "搜索中…" : "无匹配候选" }}</li>
          </ul>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
