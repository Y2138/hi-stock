<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { apiClient, type ApiFail } from "../api/client";
import type { CurrentStrategy, StrategyDocument, StrategyRuntimeDefinition } from "../api/types";
import MarkdownView from "../components/MarkdownView.vue";
import StateBlock from "../components/StateBlock.vue";
import { useUiRefresh } from "../composables/useUiRefresh";
import { shortHash, fmtDate, fmtTime } from "../utils/format";

const strategy = ref<CurrentStrategy | null>(null);
const runtimes = ref<StrategyRuntimeDefinition[]>([]);
const selectedCode = ref<string | null>(null);
const selectedDocumentId = ref<string | null>(null);
const loading = ref(false);
const error = ref<ApiFail | null>(null);

const selectedRuntime = computed(() => runtimes.value.find((item) => item.code === selectedCode.value) ?? null);
const selectedDocument = computed<StrategyDocument | null>(() => {
  const code = selectedRuntime.value?.strategy_document_code;
  return strategy.value?.documents.find((document) => document.code === code)
    ?? strategy.value?.documents.find((document) => document.id === selectedDocumentId.value)
    ?? strategy.value?.documents[0] ?? null;
});
const publicDocuments = computed(() => strategy.value?.documents.filter((document) =>
  !runtimes.value.some((runtime) => runtime.strategy_document_code === document.code)) ?? []);

const TYPE_LABELS: Record<string, string> = { position: "持仓策略", attention: "关注策略", observation: "观察策略", fallback_exit: "兜底出场", portfolio_overlay: "组合叠加" };
const STATUS_LABELS: Record<string, string> = { active: "运行中", exit_only: "仅退出", paused: "已暂停", retired: "已退役" };
const SCOPE_LABELS: Record<string, string> = { entry: "入场", exit: "出场", attention: "关注", observe: "观察", context: "组合上下文" };
const EXIT_LABELS: Record<string, string> = { none: "不适用", dedicated: "专属出场", fallback_only: "仅兜底", dedicated_plus_fallback: "专属 + 兜底" };

async function loadAll(keep = selectedCode.value): Promise<void> {
  loading.value = true; error.value = null;
  const [current, runtime] = await Promise.all([
    apiClient.get<CurrentStrategy>("/api/strategy/current"),
    apiClient.get<StrategyRuntimeDefinition[]>("/api/strategies/runtime"),
  ]);
  loading.value = false;
  if (!current.ok) { error.value = current; return; }
  if (!runtime.ok) { error.value = runtime; return; }
  strategy.value = current.data; runtimes.value = runtime.data;
  selectedCode.value = runtime.data.some((item) => item.code === keep) ? keep : runtime.data[0]?.code ?? null;
}
function selectDocument(document: StrategyDocument): void { selectedCode.value = null; selectedDocumentId.value = document.id; }

useUiRefresh("strategies", () => loadAll());
onMounted(() => void loadAll());
</script>

<template>
  <section>
    <div class="page-head strategy-head">
      <div><h1>策略中心</h1><div class="sub">当前策略正文 · 入场/出场评估器 · 关注、持仓、兜底与任务关系</div></div>
      <span v-if="strategy" class="badge ok num">序号 {{ strategy.state.change_seq }} · {{ shortHash(strategy.state.current_hash) }}</span>
    </div>
    <StateBlock :loading="loading" :error="error" :empty="!strategy" empty-text="策略运行时尚未初始化" @retry="loadAll">
      <div class="strategy-layout">
        <aside class="card runtime-list">
          <div class="card-title">运行时策略（{{ runtimes.length }}）</div>
          <button v-for="item in runtimes" :key="item.code" class="runtime-item" :class="{ active: selectedCode === item.code }" type="button" @click="selectedCode=item.code">
            <span><strong>{{ item.name }}</strong><small>{{ TYPE_LABELS[item.strategy_type] }}</small></span>
            <span class="badge" :class="{ ok:item.status==='active', warn:item.status==='exit_only' }">{{ STATUS_LABELS[item.status] }}</span>
          </button>
          <div v-if="publicDocuments.length" class="list-divider">公共文档</div>
          <button v-for="document in publicDocuments" :key="document.id" class="runtime-item" :class="{ active: !selectedCode && selectedDocument?.id === document.id }" type="button" @click="selectDocument(document)"><span><strong>{{ document.title }}</strong><small>{{ document.role }}</small></span></button>
        </aside>

        <main class="strategy-main">
          <article v-if="selectedRuntime" class="card runtime-overview">
            <div class="reader-head"><div><h2>{{ selectedRuntime.name }}</h2><p class="num">{{ selectedRuntime.code }} · 运行版本 v{{ selectedRuntime.runtime_version }}</p></div><span class="badge" :class="{ ok:selectedRuntime.status==='active', warn:selectedRuntime.status==='exit_only' }">{{ STATUS_LABELS[selectedRuntime.status] }}</span></div>
            <div class="metric-grid">
              <div><span>当前持仓</span><strong class="num">{{ selectedRuntime.position_count }}</strong></div>
              <div><span>关注标的</span><strong class="num">{{ selectedRuntime.attention_count }}</strong></div>
              <div><span>出场模式</span><strong>{{ EXIT_LABELS[selectedRuntime.exit_policy_mode] }}</strong></div>
              <div><span>最近评估</span><strong>{{ selectedRuntime.latest_evaluation ? `${fmtDate(selectedRuntime.latest_evaluation.target_date)} · ${selectedRuntime.latest_evaluation.status}` : "尚无" }}</strong></div>
            </div>
            <dl class="runtime-kv">
              <dt>入场评估器</dt><dd class="num">{{ selectedRuntime.entry_evaluator_code ?? "—" }}</dd>
              <dt>出场评估器</dt><dd class="num">{{ selectedRuntime.exit_evaluator_code ?? "—" }}</dd>
              <dt>组合评估器</dt><dd class="num">{{ selectedRuntime.context_evaluator_code ?? "—" }}</dd>
              <dt>兜底策略</dt><dd>{{ selectedRuntime.fallback_strategy_name ?? selectedRuntime.fallback_strategy_code ?? "不使用" }}</dd>
              <dt>每日计划</dt><dd><span v-for="scope in selectedRuntime.daily_plan_scope" :key="scope" class="badge">{{ SCOPE_LABELS[scope] }}</span><span v-if="!selectedRuntime.daily_plan_scope.length">不参与</span></dd>
              <dt>关联任务</dt><dd><span v-for="task in selectedRuntime.tasks" :key="task.code" class="badge" :class="{ ok:task.enabled }">{{ task.name }} · {{ task.agent_role }}</span><span v-if="!selectedRuntime.tasks.length">无专项任务</span></dd>
            </dl>
          </article>
          <article class="card strategy-reader">
            <template v-if="selectedDocument">
              <div class="reader-head"><div><div class="card-title">{{ selectedDocument.title }}</div><p class="card-desc num">{{ selectedDocument.code }} · {{ shortHash(selectedDocument.sha256) }} · {{ fmtTime(selectedDocument.updated_at) }}</p></div><span class="badge">当前正文</span></div>
              <MarkdownView :source="selectedDocument.content" />
            </template>
          </article>
        </main>
      </div>
    </StateBlock>
  </section>
</template>

<style scoped>
.strategy-head,.reader-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.strategy-layout{display:grid;grid-template-columns:280px minmax(0,1fr);gap:14px}.runtime-list{align-self:start;padding:10px}.runtime-list>.card-title{padding:6px 8px 10px}.runtime-item{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:9px;border:0;border-radius:var(--radius-sm);background:transparent;color:inherit;text-align:left;cursor:pointer}.runtime-item:hover,.runtime-item.active{background:var(--accent-soft)}.runtime-item>span:first-child{display:grid;gap:3px}.runtime-item small,.reader-head p{color:var(--ink-faint);font-size:11px}.list-divider{margin:10px 8px 4px;padding-top:10px;border-top:1px solid var(--line);color:var(--ink-faint);font-size:11px}.strategy-main{display:grid;gap:14px;min-width:0}.runtime-overview h2{margin:0}.runtime-overview p,.card-desc{margin:4px 0 0}.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:14px 0}.metric-grid>div{display:grid;gap:4px;padding:10px;background:var(--paper-deep);border-radius:var(--radius-sm)}.metric-grid span,.runtime-kv dt{color:var(--ink-faint);font-size:11px}.runtime-kv{display:grid;grid-template-columns:90px minmax(0,1fr);gap:8px 12px;margin:0}.runtime-kv dd{margin:0;overflow-wrap:anywhere}.runtime-kv .badge{margin:0 5px 4px 0}.strategy-reader{min-width:0}.strategy-reader .reader-head{padding-bottom:12px;border-bottom:1px solid var(--line)}
@container business (max-width:800px){.strategy-layout{grid-template-columns:1fr}.runtime-list{display:flex;gap:6px;overflow:auto}.runtime-list>.card-title,.list-divider{display:none}.runtime-item{min-width:200px}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
