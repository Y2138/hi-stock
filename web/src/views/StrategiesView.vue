<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient, type ApiFail } from "../api/client";
import { TOOL_LABELS, type CurrentStrategy, type StrategyDocument, type StrategyEvaluationRun, type StrategyEvaluatorMetadata, type StrategyRuntimeDefinition } from "../api/types";
import MarkdownView from "../components/MarkdownView.vue";
import StateBlock from "../components/StateBlock.vue";
import { useUiRefresh } from "../composables/useUiRefresh";
import { shortHash, fmtDate, fmtTime } from "../utils/format";

const route = useRoute();
const router = useRouter();
const strategy = ref<CurrentStrategy | null>(null);
const runtimes = ref<StrategyRuntimeDefinition[]>([]);
const selectedCode = ref<string | null>(null);
const selectedDocumentId = ref<string | null>(null);
const loading = ref(false);
const evaluations = ref<StrategyEvaluationRun[]>([]);
const evaluationLoading = ref(false);
const error = ref<ApiFail | null>(null);

const requestedStrategy = computed(() => typeof route.query.strategy === "string" ? route.query.strategy : null);
watch(requestedStrategy, (code) => { if (code && runtimes.value.some((item) => item.code === code)) selectedCode.value = code; });
function selectRuntime(code: string): void { selectedCode.value = code; void router.replace({ query: { ...route.query, strategy: code } }); }
function evaluatorText(evaluator: StrategyEvaluatorMetadata | null): string {
  return evaluator ? `${evaluator.label} · ${evaluator.status === "ready" ? "已接入" : evaluator.status === "pending" ? "待接入" : "未注册"}` : "不适用";
}
const selectedRuntime = computed(() => runtimes.value.find((item) => item.code === selectedCode.value) ?? null);
const relationSteps = computed(() => {
  const item = selectedRuntime.value;
  if (!item) return ["", ""];
  if (item.strategy_type === "portfolio_overlay") return ["组合评估", "组合风险上下文"];
  if (item.strategy_type === "fallback_exit") return ["兜底出场评估", "持仓预案兜底"];
  if (item.strategy_type === "observation") return ["机会观察评估", "打板机会"];
  if (item.strategy_type === "attention") return ["关注评估", "关注池"];
  return item.allow_new_entry ? ["入场与出场评估", "关注池与持仓预案"] : ["存量出场评估", "持仓预案"];
});
const EVALUATION_STATUS_LABELS: Record<string, string> = { queued: "排队中", running: "运行中", success: "完成", partial: "部分覆盖", failed: "失败" };

watch(selectedCode, async (code) => {
  evaluations.value = [];
  if (!code) return;
  evaluationLoading.value = true;
  const result = await apiClient.get<StrategyEvaluationRun[]>(`/api/strategies/runtime/${encodeURIComponent(code)}/evaluations?limit=5`);
  if (selectedCode.value === code) { evaluations.value = result.ok ? result.data : []; evaluationLoading.value = false; }
});
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
  selectedCode.value = runtime.data.some((item) => item.code === requestedStrategy.value) ? requestedStrategy.value
    : runtime.data.some((item) => item.code === keep) ? keep : runtime.data[0]?.code ?? null;
}
function selectDocument(document: StrategyDocument): void { selectedCode.value = null; selectedDocumentId.value = document.id; void router.replace({ query: { ...route.query, strategy: undefined } }); }

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
          <button v-for="item in runtimes" :key="item.code" class="runtime-item" :class="{ active: selectedCode === item.code }" type="button" @click="selectRuntime(item.code)">
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
              <div><span>最近评估</span><strong>{{ selectedRuntime.latest_evaluation ? `${fmtDate(selectedRuntime.latest_evaluation.target_date)} · ${EVALUATION_STATUS_LABELS[selectedRuntime.latest_evaluation.status] ?? selectedRuntime.latest_evaluation.status}` : "尚无" }}</strong></div>
            </div>
            <div class="relation-flow" aria-label="策略运行关系">
              <strong>运行关系</strong>
              <span>当前策略正文</span><span>→</span>
              <span>{{ relationSteps[0] }}</span><span>→</span>
              <span>{{ relationSteps[1] }}</span>
            </div>
            <dl class="runtime-kv">
              <dt>入场 / 关注</dt><dd>{{ evaluatorText(selectedRuntime.evaluators.entry) }} <small v-if="selectedRuntime.evaluators.entry" class="num">{{ selectedRuntime.evaluators.entry.code }}</small></dd>
              <dt>出场评估</dt><dd>{{ evaluatorText(selectedRuntime.evaluators.exit) }} <small v-if="selectedRuntime.evaluators.exit" class="num">{{ selectedRuntime.evaluators.exit.code }}</small></dd>
              <dt>组合评估</dt><dd>{{ evaluatorText(selectedRuntime.evaluators.context) }} <small v-if="selectedRuntime.evaluators.context" class="num">{{ selectedRuntime.evaluators.context.code }}</small></dd>
              <dt>兜底出场</dt><dd><button v-if="selectedRuntime.fallback_strategy_code" class="text-link" type="button" @click="selectRuntime(selectedRuntime.fallback_strategy_code)">{{ selectedRuntime.fallback_strategy_name ?? selectedRuntime.fallback_strategy_code }} ↗</button><span v-else>不使用</span></dd>
              <dt>每日计划</dt><dd><span v-for="scope in selectedRuntime.daily_plan_scope" :key="scope" class="badge">{{ SCOPE_LABELS[scope] }}</span><span v-if="!selectedRuntime.daily_plan_scope.length">不自动参与</span> <RouterLink v-if="selectedRuntime.daily_plan_scope.length" :to="{ path: '/jobs', query: { job: 'daily_plan_flow' } }">查看跨策略统筹任务 ↗</RouterLink></dd>
              <dt>专项任务</dt><dd><div v-for="task in selectedRuntime.tasks" :key="task.code" class="task-relation"><RouterLink :to="{ path: '/jobs', query: { job: task.code } }">{{ task.name }} ↗</RouterLink><span class="badge" :class="{ ok:task.enabled }">{{ task.enabled ? "已启用" : "已暂停" }}</span><details v-if="task.available_tools.length"><summary>授权工具 {{ task.available_tools.length }} 项</summary><span v-for="tool in task.available_tools" :key="tool" class="badge" :title="tool">{{ TOOL_LABELS[tool] ?? tool }}</span></details></div><span v-if="!selectedRuntime.tasks.length">无单策略专项任务（不代表不参与每日计划）</span></dd>
              <dt v-if="['position','attention','observation'].includes(selectedRuntime.strategy_type)">跨域竞价</dt><dd v-if="['position','attention','observation'].includes(selectedRuntime.strategy_type)">独立复核持仓、逐关注来源与打板机会；不归属单一策略。<RouterLink :to="{ path: '/jobs', query: { job: 'auction_opportunity_assessment' } }">查看竞价任务 ↗</RouterLink></dd>
              <dt>执行入口</dt><dd><span v-if="selectedRuntime.daily_plan_scope.length">每日计划通过统一策略查询调用评估器，不由 Agent 逐个调用垂直信号工具。<code>daily_plan_strategy_query</code></span><span v-else>仅按专项任务或持仓引用参与，不因策略存在而自动运行。</span></dd>
              <dt>覆盖与去向</dt><dd><RouterLink to="/positions">持仓 {{ selectedRuntime.position_count }} ↗</RouterLink> · <RouterLink to="/pools">关注 {{ selectedRuntime.attention_count }} ↗</RouterLink><span v-if="selectedRuntime.latest_evaluation"> · 最近评估 {{ fmtDate(selectedRuntime.latest_evaluation.target_date) }}（{{ selectedRuntime.latest_evaluation.status }}）</span></dd>
            </dl>
          </article>
          <article v-if="selectedRuntime" class="card">
            <div class="card-title">最近结构化评估 · {{ selectedRuntime.name }}</div>
            <p v-if="evaluationLoading" class="muted">正在加载评估记录…</p>
            <p v-else-if="!evaluations.length" class="muted">暂无评估记录；“无记录”不代表该策略没有配置评估器。</p>
            <div v-for="run in evaluations" :key="run.id" class="evaluation-row">
              <strong>{{ run.phase === 'entry' ? '入场 / 关注' : run.phase === 'exit' ? '出场' : '组合' }} · {{ fmtDate(run.target_date) }}</strong>
              <span class="badge" :class="{ ok:run.status==='success', warn:run.status==='partial' || run.status==='queued' }">{{ EVALUATION_STATUS_LABELS[run.status] ?? run.status }}</span>
              <span class="muted">{{ run.evaluator_code }} · 数据日 {{ fmtDate(run.data_date) ?? '缺失' }}<template v-if="run.reused_from_run_id"> · 复用已有运行</template><template v-if="run.gaps.length"> · 缺口 {{ run.gaps.length }} 项</template></span>
              <RouterLink v-if="run.requested_by_job_run_id && run.requested_by_job_code" :to="{ path: '/jobs', query: { job: run.requested_by_job_code, run: run.requested_by_job_run_id } }">查看任务运行 ↗</RouterLink>
            </div>
          </article>
          <article class="card strategy-reader">
            <template v-if="selectedDocument">
              <div class="reader-head"><div><div class="card-title">{{ selectedDocument.title }}</div><p class="card-desc num">文档 · {{ selectedDocument.code }} · {{ shortHash(selectedDocument.sha256) }} · {{ fmtTime(selectedDocument.updated_at) }}</p></div><span class="badge">当前正文</span></div>
              <MarkdownView :source="selectedDocument.content" />
            </template>
          </article>
        </main>
      </div>
    </StateBlock>
  </section>
</template>

<style scoped>
.strategy-head,.reader-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.strategy-layout{display:grid;grid-template-columns:280px minmax(0,1fr);gap:14px}.runtime-list{align-self:start;padding:10px}.runtime-list>.card-title{padding:6px 8px 10px}.runtime-item{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:9px;border:0;border-radius:var(--radius-sm);background:transparent;color:inherit;text-align:left;cursor:pointer}.runtime-item:hover,.runtime-item.active{background:var(--accent-soft)}.runtime-item>span:first-child{display:grid;gap:3px}.runtime-item small,.reader-head p{color:var(--ink-faint);font-size:11px}.list-divider{margin:10px 8px 4px;padding-top:10px;border-top:1px solid var(--line);color:var(--ink-faint);font-size:11px}.strategy-main{display:grid;gap:14px;min-width:0}.runtime-overview h2{margin:0}.runtime-overview p,.card-desc{margin:4px 0 0}.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:14px 0}.metric-grid>div{display:grid;gap:4px;padding:10px;background:var(--paper-deep);border-radius:var(--radius-sm)}.metric-grid span,.runtime-kv dt{color:var(--ink-faint);font-size:11px}.runtime-kv{display:grid;grid-template-columns:90px minmax(0,1fr);gap:8px 12px;margin:0}.runtime-kv dd{margin:0;overflow-wrap:anywhere}.runtime-kv .badge{margin:0 5px 4px 0}.task-relation{margin-bottom:7px}.task-relation details{margin-top:4px}.task-relation summary{cursor:pointer;color:var(--accent-ink)}.evaluation-row{display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding:8px 0;border-top:1px solid var(--line)}.evaluation-row .muted{font-size:11px}.relation-flow{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin:12px 0;padding:10px;background:var(--paper-deep);border-radius:var(--radius-sm)}.relation-flow strong{margin-right:4px}.runtime-kv small{display:block;color:var(--ink-faint)}.text-link{border:0;background:none;color:var(--accent-ink);padding:0;cursor:pointer;font:inherit}.strategy-reader{min-width:0}.strategy-reader .reader-head{padding-bottom:12px;border-bottom:1px solid var(--line)}
@container business (max-width:800px){.strategy-layout{grid-template-columns:1fr}.runtime-list{display:flex;gap:6px;overflow:auto}.runtime-list>.card-title,.list-divider{display:none}.runtime-item{min-width:200px}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
