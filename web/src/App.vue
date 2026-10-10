<script setup lang="ts">
// 全局布局：左侧图标+中文导航，顶栏全局状态条，命令面板（Cmd/Ctrl+K）
// 产品方案 §5.2 / §七；视图切换淡入位移为纯 CSS transition。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient } from "./api/client";
import AccountSelector from "./components/AccountSelector.vue";
import { portfolioAccounts, selectedAccountId, selectAccount, taskScope, type PortfolioAccount } from "./stores/account";
import StatusBar from "./components/StatusBar.vue";
import CommandPalette from "./components/CommandPalette.vue";
import AppMessageCenter from "./components/AppMessageCenter.vue";
import AgentWorkspace from "./components/chat/AgentWorkspace.vue";
import ResultPreview from "./components/ResultPreview.vue";
import type { UiRefreshRequest } from "./api/types";
import { dispatchUiRefresh } from "./composables/useUiRefresh";
import { appMessage } from "./stores/message";
import { ASK_AI_EVENT, type AskAiRequest } from "./utils/askAi";
import { NAV_GROUPS } from "./navigation";
import {
  isPreviewResult,
  parseResultRef,
  RESULT_OPEN_EVENT,
  resultRoute,
  serializeResultRef,
  type ResultRef,
} from "./utils/results";

const paletteOpen = ref(false);
const navCollapsed = ref(localStorage.getItem("stock-nav-collapsed") === "1");
const agentOpen = ref(localStorage.getItem("stock-agent-workspace-open") !== "0");
const aiRequest = ref<AskAiRequest | null>(null);
/** 顶栏「刷新」：递增 key 强制重挂载当前视图，触发其 onMounted 重新拉数（不刷新浏览器） */
const viewKey = ref(0);
const statusKey = ref(0);
const route = useRoute();
const router = useRouter();
const settingsAgentOpen = ref(false);
const isSettingsPage = computed(() => route.path === "/settings" || route.path.startsWith("/settings/"));
const workspaceOpen = computed(() => isSettingsPage.value ? settingsAgentOpen.value : agentOpen.value);
const accountPage = computed(() => route.path === "/positions" || (route.path === "/jobs" && taskScope.value === "account"));
const globalResearchPage = computed(() => ["/pools", "/strategies", "/market", "/market-structure", "/market-news"].includes(route.path));
const accountViewKey = computed(() => route.path === "/positions" ? selectedAccountId.value : "global");
const agentAccountId = computed(() => accountPage.value ? selectedAccountId.value : null);
watch(() => [route.path, route.query.account], () => {
  if (!["/positions", "/jobs"].includes(route.path)) return;
  const id = route.query.account;
  if (typeof id === "string" && /^[1-9]\d*$/.test(id)) selectAccount(id);
}, { immediate: true, flush: "sync" });
watch(agentAccountId, () => { aiRequest.value = null; }, { flush: "sync" });
const activeResult = computed(() => {
  const result = parseResultRef(route.query.result);
  return result && isPreviewResult(result) ? result : null;
});

watch(selectedAccountId, () => {
  if (!accountPage.value) return;
  aiRequest.value = null;
  const query = { ...route.query };
  for (const key of ["run", "change", "output", "session", "chat"]) delete query[key];
  if (query.account) query.account = selectedAccountId.value;
  if (activeResult.value?.type === "job-output") delete query.result;
  if (JSON.stringify(query) !== JSON.stringify(route.query)) void router.replace({ query });
}, { flush: "sync" });

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
  if (isSettingsPage.value) { settingsAgentOpen.value = open; return; }
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
  void apiClient.get<PortfolioAccount[]>("/api/accounts").then(response => { if (response.ok) portfolioAccounts.value = response.data; });
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
  <div class="shell" :class="{ 'nav-collapsed': navCollapsed, 'agent-open': workspaceOpen }">
    <nav class="side-nav" aria-label="主导航">
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
      <div v-for="group in NAV_GROUPS" :key="group.label" class="nav-group">
        <div class="nav-group-label">{{ group.label }}</div>
        <RouterLink
          v-for="item in group.items"
          :key="item.to"
          :to="item.to"
          class="nav-item"
          :exact-active-class="item.to === '/' ? 'active' : undefined"
          :active-class="item.to === '/' ? undefined : 'active'"
          :title="item.label"
          :aria-label="item.label"
        >
          <span class="icon" aria-hidden="true">{{ item.icon }}</span>
          <span class="nav-label">{{ item.label }}</span>
        </RouterLink>
      </div>
    </nav>

    <StatusBar :key="statusKey" @open-palette="paletteOpen = true" @refresh="viewKey++" />

    <main class="main-area" :class="{ 'result-open': activeResult }">
      <div v-if="accountPage && !activeResult" class="page-account-context">
        <div><span class="badge accent">账户工作</span><small>切换仅影响本页和账户 Agent</small></div>
        <AccountSelector />
      </div>
      <div v-if="globalResearchPage && !activeResult" class="page-global-context"><span class="badge">全局共享</span><small>所有账户共用，账户切换不改变本页内容</small></div>
      <div v-show="!activeResult" class="business-view">
        <RouterView v-slot="{ Component }">
          <Transition name="view-fade" mode="out-in">
            <component :is="Component" :key="`${route.path}#${viewKey}#${accountViewKey}`" />
          </Transition>
        </RouterView>
      </div>
      <ResultPreview v-if="activeResult" :result="activeResult" @close="closeResult" />
    </main>

    <CommandPalette :open="paletteOpen" @close="paletteOpen = false" />
    <AppMessageCenter />
    <AgentWorkspace
      :key="agentAccountId ?? 'global'"
      :open="workspaceOpen"
      :account-id="agentAccountId"
      :request="aiRequest"
      @open="setAgentOpen(true)"
      @close="setAgentOpen(false)"
      @request-consumed="(id) => { if (aiRequest?.id === id) aiRequest = null; }"
      @ui-refresh="onUiRefresh"
    />
  </div>
</template>

<style scoped>
.page-global-context { display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:16px; color:var(--ink-faint); font-size:11px; }
.page-account-context { display:flex; align-items:center; justify-content:space-between; gap:16px; margin:0 0 18px; padding-bottom:14px; border-bottom:1px solid var(--line); }
.page-account-context > div { display:flex; align-items:center; flex-wrap:wrap; gap:10px; }
.page-account-context small { color:var(--ink-faint); font-size:11px; }
.page-account-context :deep(.account-selector) { width:220px; padding:0; margin:0; border:0; flex-shrink:0; }
@media(max-width:720px) { .page-account-context { align-items:flex-start; flex-direction:column; gap:10px; } .page-account-context :deep(.account-selector) { width:100%; } }
</style>
