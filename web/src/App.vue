<script setup lang="ts">
// 全局布局：左侧图标+中文导航，顶栏全局状态条，命令面板（Cmd/Ctrl+K）
// 产品方案 §5.2 / §七；视图切换淡入位移为纯 CSS transition。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import StatusBar from "./components/StatusBar.vue";
import CommandPalette from "./components/CommandPalette.vue";
import AppMessageCenter from "./components/AppMessageCenter.vue";
import AgentWorkspace from "./components/chat/AgentWorkspace.vue";
import ResultPreview from "./components/ResultPreview.vue";
import type { UiRefreshRequest } from "./api/types";
import { dispatchUiRefresh } from "./composables/useUiRefresh";
import { appMessage } from "./stores/message";
import { ASK_AI_EVENT, type AskAiRequest } from "./utils/askAi";
import {
  isPreviewResult,
  parseResultRef,
  RESULT_OPEN_EVENT,
  resultRoute,
  serializeResultRef,
  type ResultRef,
} from "./utils/results";

const NAV_ITEMS = [
  { to: "/", icon: "📊", label: "仪表盘" },
  { to: "/positions", icon: "💼", label: "持仓" },
  { to: "/short-pool", icon: "⚡", label: "短线池" },
  { to: "/long-pool", icon: "🌱", label: "长线池" },
  { to: "/market-structure", icon: "▦", label: "市场结构" },
  { to: "/jobs", icon: "⏱", label: "任务中心" },
  { to: "/strategies", icon: "📜", label: "当前策略" },
  { to: "/backtests", icon: "🧪", label: "回测" },
  { to: "/memories", icon: "🧠", label: "Agent 记忆" },
  { to: "/datasync", icon: "💾", label: "数据与备份" },
  { to: "/settings", icon: "⚙️", label: "设置" },
];

const paletteOpen = ref(false);
const navCollapsed = ref(localStorage.getItem("stock-nav-collapsed") === "1");
const agentOpen = ref(localStorage.getItem("stock-agent-workspace-open") !== "0");
const aiRequest = ref<AskAiRequest | null>(null);
/** 顶栏「刷新」：递增 key 强制重挂载当前视图，触发其 onMounted 重新拉数（不刷新浏览器） */
const viewKey = ref(0);
const statusKey = ref(0);
const route = useRoute();
const router = useRouter();
const activeResult = computed(() => {
  const result = parseResultRef(route.query.result);
  return result && isPreviewResult(result) ? result : null;
});

function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && activeResult.value) {
    e.preventDefault();
    closeResult();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    paletteOpen.value = !paletteOpen.value;
  }
}

function onOpenResult(event: Event): void {
  const result = (event as CustomEvent<ResultRef>).detail;
  if (!result?.type || !result.id) return;
  const target = resultRoute(result);
  if (target) {
    void router.push(target);
    return;
  }
  if (!isPreviewResult(result)) return;
  const { output: _legacyOutput, ...currentQuery } = route.query;
  const query = { ...currentQuery, result: serializeResultRef(result) };
  void (activeResult.value ? router.replace({ query }) : router.push({ query }));
}

function closeResult(): void {
  const query = { ...route.query };
  delete query.result;
  delete query.output;
  void router.replace({ query });
}

watch(
  () => [route.path, route.query.output],
  ([path, output]) => {
    if (path !== "/jobs" || typeof output !== "string" || activeResult.value) return;
    const { output: _legacyOutput, ...currentQuery } = route.query;
    const query = { ...currentQuery, result: `job-output:${output}` };
    void router.replace({ query });
  },
  { immediate: true },
);

function onAskAi(event: Event): void {
  const request = (event as CustomEvent<AskAiRequest>).detail;
  if (!request?.kind) return;
  aiRequest.value = request;
  setAgentOpen(true);
}

function setAgentOpen(open: boolean): void {
  agentOpen.value = open;
  localStorage.setItem("stock-agent-workspace-open", open ? "1" : "0");
}

function toggleNav(): void {
  navCollapsed.value = !navCollapsed.value;
  localStorage.setItem("stock-nav-collapsed", navCollapsed.value ? "1" : "0");
}

function onUiRefresh(request: UiRefreshRequest): void {
  dispatchUiRefresh(request);
  if (request.targets.includes("status")) statusKey.value += 1;
  appMessage.info(`已重新读取：${request.targets.join("、")}`, {
    title: "Agent 已刷新页面数据",
  });
}

onMounted(() => {
  window.addEventListener("keydown", onGlobalKeydown);
  window.addEventListener(ASK_AI_EVENT, onAskAi);
  window.addEventListener(RESULT_OPEN_EVENT, onOpenResult);
  const query = { ...route.query };
  let normalizeQuery = false;
  if (route.query.chat === "1") {
    setAgentOpen(true);
    delete query.chat;
    normalizeQuery = true;
  }
  if (normalizeQuery) void router.replace({ query });
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onGlobalKeydown);
  window.removeEventListener(ASK_AI_EVENT, onAskAi);
  window.removeEventListener(RESULT_OPEN_EVENT, onOpenResult);
});
</script>

<template>
  <div class="shell" :class="{ 'nav-collapsed': navCollapsed, 'agent-open': agentOpen }">
    <nav class="side-nav">
      <div class="brand-row">
        <span class="brand-full">Stock 策略演进</span>
        <span class="brand-mark">S</span>
        <button
          class="nav-collapse"
          type="button"
          :aria-label="navCollapsed ? '展开左侧菜单' : '收起左侧菜单'"
          :title="navCollapsed ? '展开左侧菜单' : '收起左侧菜单'"
          @click="toggleNav"
        >{{ navCollapsed ? "›" : "‹" }}</button>
      </div>
      <RouterLink
        v-for="item in NAV_ITEMS"
        :key="item.to"
        :to="item.to"
        class="nav-item"
        :exact-active-class="item.to === '/' ? 'active' : undefined"
        :active-class="item.to === '/' ? undefined : 'active'"
        :title="navCollapsed ? item.label : undefined"
      >
        <span class="icon">{{ item.icon }}</span>
        <span class="nav-label">{{ item.label }}</span>
      </RouterLink>
    </nav>

    <StatusBar :key="statusKey" @open-palette="paletteOpen = true" @refresh="viewKey++" />

    <main class="main-area" :class="{ 'result-open': activeResult }">
      <div v-show="!activeResult" class="business-view">
        <RouterView v-slot="{ Component }">
          <Transition name="view-fade" mode="out-in">
            <component :is="Component" :key="`${route.path}#${viewKey}`" />
          </Transition>
        </RouterView>
      </div>
      <ResultPreview v-if="activeResult" :result="activeResult" @close="closeResult" />
    </main>

    <CommandPalette :open="paletteOpen" @close="paletteOpen = false" />
    <AppMessageCenter />
    <AgentWorkspace
      :open="agentOpen"
      :request="aiRequest"
      @open="setAgentOpen(true)"
      @close="setAgentOpen(false)"
      @request-consumed="aiRequest = null"
      @ui-refresh="onUiRefresh"
    />
  </div>
</template>
