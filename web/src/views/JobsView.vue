<script setup lang="ts">
// 任务中心只负责查看、启停、立即运行和失败处理；任务定义与提示词只能由 Agent 维护。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { apiClient, type ApiFail } from "../api/client";
import { TOOL_LABELS, type JobDefinition, type JobPrompt, type JobRun, type JobRunDetail, type JobRunOutput, type LlmConfigCatalog } from "../api/types";
import MarkdownView from "../components/MarkdownView.vue";
import StateBlock from "../components/StateBlock.vue";
import UiInput from "../components/ui/UiInput.vue";
import { useResource } from "../composables/useResource";
import { useUiRefresh } from "../composables/useUiRefresh";
import { appMessage } from "../stores/message";
import { fmtTime, prettyJson } from "../utils/format";
import { askAi, openAgentSession } from "../utils/askAi";
import { openResult, parseResultRef } from "../utils/results";

const STATUS_LABELS: Record<string, string> = {
  queued: "排队中", running: "运行中", success: "成功", failed: "失败",
  partial: "部分成功", missed: "停机漏跑", cancelled: "已中断",
};
const STATUS_CLASS: Record<string, string> = {
  queued: "warn", running: "ok", success: "ok", failed: "bad",
  partial: "warn", missed: "", cancelled: "",
};
const TYPE_LABELS: Record<string, string> = {
  datasource: "数据链路", analysis: "服务内分析", agent_flow: "Agent 任务",
};
const DATASOURCE_INFO: Record<string, { label: string; responsibility: string; result: string }> = {
  daily_market_update: {
    label: "每日行情更新",
    responsibility: "更新持仓、标的池与指数行情，并补充期货和关键标的 30 分钟线。",
    result: "日线/30分钟行情、均线指标和数据卷快照。",
  },
  market_catalog_sync: {
    label: "市场目录同步",
    responsibility: "同步完整标的、板块目录及交易日历。",
    result: "标的主数据、板块目录和交易日历。",
  },
  board_membership_sync: {
    label: "板块成分同步",
    responsibility: "同步全部有效板块的当前成分及生效、失效区间。",
    result: "可追溯历史变化的板块成分关系。",
  },
  daily_market_structure: {
    label: "市场结构同步",
    responsibility: "同步涨停、跌停、炸板、连板天梯和龙虎榜。",
    result: "每日市场结构事件及各数据集同步记录。",
  },
  commodity_copper_sync: {
    label: "铜期货真实合约同步",
    responsibility: "同步上期所铜真实合约日行情、结算持仓和主力连续映射。",
    result: "真实合约K线、期货专属日线字段、换月映射和抓取记录。",
  },
  commodity_copper_inventory_sync: {
    label: "铜库存周报同步",
    responsibility: "同步上期所铜总库存周报并保留官方发布时间。",
    result: "铜总库存点时观测和抓取记录。",
  },
  commodity_copper_macro_sync: {
    label: "铜宏观因子同步",
    responsibility: "同步OECD G7与中国CLI，并按保守发布时间保存修订。",
    result: "铜左侧启动策略使用的全球增长与中国需求点时因子。",
  },
  full_market_indicator_refresh: {
    label: "全市场指标重算",
    responsibility: "每周把全市场股票行情标记为待重算指标。",
    result: "指标脏标记，由后台工作器分批计算。",
  },
};
const DATASOURCE_ORDER = [
  "market_catalog_sync", "board_membership_sync", "daily_market_update",
  "commodity_copper_sync", "commodity_copper_inventory_sync", "commodity_copper_macro_sync",
  "daily_market_structure", "full_market_indicator_refresh",
];
const jobs = useResource<JobDefinition[]>(() => apiClient.get<JobDefinition[]>("/api/jobs"));
const prompts = useResource<JobPrompt[]>(() => apiClient.get<JobPrompt[]>("/api/job-prompts"));
const llmCatalog = useResource<LlmConfigCatalog>(() => apiClient.get<LlmConfigCatalog>("/api/llm/providers"));
type JobTab = "agent" | "data";
const activeTab = ref<JobTab>("agent");
const filter = ref<"all" | "enabled" | "paused">("all");
const keyword = ref("");
const expandedJobCode = ref<string | null>(null);
const actionKey = ref<string | null>(null);
const historyJob = ref<JobDefinition | null>(null);
const runs = ref<JobRun[]>([]);
const outputs = ref<JobRunOutput[]>([]);
const historyLoading = ref(false);
const historyError = ref<ApiFail | null>(null);
const selectedRun = ref<JobRunDetail | null>(null);
const selectedRunId = ref<string | null>(null);
const runLoading = ref(false);
const promptJob = ref<JobDefinition | null>(null);
const promptDetail = ref<JobPrompt | null>(null);
const promptLoading = ref(false);
const promptError = ref<ApiFail | null>(null);
const route = useRoute();
const resultOpen = computed(() => Boolean(parseResultRef(route.query.result)));

const tabJobs = computed(() => (jobs.data.value ?? [])
  .filter((job) => activeTab.value === "agent" ? job.job_type === "agent_flow" : job.job_type !== "agent_flow")
  .sort((left, right) => {
    if (left.job_type !== right.job_type) return left.job_type === "datasource" ? -1 : 1;
    return compareJobs(left, right, left.job_type);
  }));
const visibleJobs = computed(() => {
  const q = keyword.value.trim().toLocaleLowerCase("zh-CN");
  return tabJobs.value.filter((job) => {
    const statusMatched = filter.value === "all" || (filter.value === "enabled" ? job.enabled : !job.enabled);
    if (!statusMatched || !q) return statusMatched;
    return [job.name, job.code, job.purpose, job.phase, job.agent_role, job.strategy_code, pipelineOf(job)]
      .some((value) => value?.toLocaleLowerCase("zh-CN").includes(q));
  });
});
const tabCounts = computed(() => {
  const rows = jobs.data.value ?? [];
  return {
    agent: rows.filter((row) => row.job_type === "agent_flow").length,
    data: rows.filter((row) => row.job_type !== "agent_flow").length,
  };
});
const counts = computed(() => ({
  all: tabJobs.value.length,
  enabled: tabJobs.value.filter((row) => row.enabled).length,
  paused: tabJobs.value.filter((row) => !row.enabled).length,
}));
const tabDescription = computed(() => activeTab.value === "agent"
  ? "按版本化提示词执行的 Agent 任务，可查看对话、提示词与 Markdown 结果。"
  : "固定数据同步与服务内分析，直接写入数据库，不经过 Agent 对话。");
const detachedOutputs = computed(() => outputs.value.filter((output) =>
  !output.run_id || !runs.value.some((run) => run.id === output.run_id),
));
const primaryOutput = computed(() => selectedRun.value?.outputs[0] ?? null);

/** 组内排序：优先级权重优先（数值越小越靠前），缺失时数据链路退回固定顺序、其余按名称。 */
function compareJobs(left: JobDefinition, right: JobDefinition, type: string): number {
  if (left.priority !== null && right.priority !== null && left.priority !== right.priority) {
    return left.priority - right.priority;
  }
  if (left.priority !== null && right.priority === null) return -1;
  if (left.priority === null && right.priority !== null) return 1;
  if (type === "datasource") {
    const order = DATASOURCE_ORDER.indexOf(pipelineOf(left)) - DATASOURCE_ORDER.indexOf(pipelineOf(right));
    if (order !== 0) return order;
  }
  return left.name.localeCompare(right.name, "zh-CN");
}

function pipelineOf(job: JobDefinition): string {
  return typeof job.config.pipeline === "string" ? job.config.pipeline : "unknown";
}

function executionLabel(job: JobDefinition): string {
  if (job.job_type === "datasource") {
    const pipeline = pipelineOf(job);
    return `${DATASOURCE_INFO[pipeline]?.label ?? "未知数据链路"} · ${pipeline}`;
  }
  if (job.job_type === "analysis") return prettyJson(job.config) ?? "—";
  const prompt = (prompts.data.value ?? []).find((item) => item.id === job.prompt_id);
  return prompt ? `${prompt.name} · v${prompt.current_revision_no}` : "未绑定有效提示词";
}

function modelLabel(job: JobDefinition): string {
  if (job.job_type !== "agent_flow") return "不调用模型";
  if (job.code === "pre_market_news_scan") return "跟随系统默认 Agent 模型；Web 搜索为内置 DeepSeek Web Search 能力";
  if (!job.model_id) return "跟随系统默认";
  for (const provider of llmCatalog.data.value?.providers ?? []) {
    const model = provider.models.find((item) => item.id === job.model_id);
    if (model) return `${provider.name} · ${model.name}`;
  }
  return `模型 #${job.model_id}（当前不可用）`;
}

const AGENT_ROLE_LABELS: Record<string, string> = {
  strategy_entry_report: "入场专项", strategy_exit_report: "出场专项", strategy_confirmation: "盘中确认",
  portfolio_aggregator: "组合统筹", auction_cross_scope: "竞价跨域研判", data_pipeline: "数据链路", research_report: "研究报告",
};
function runtimeRole(job: JobDefinition): string {
  const role = job.agent_role ? AGENT_ROLE_LABELS[job.agent_role] ?? job.agent_role : "未纳入策略运行时";
  return job.strategy_code ? `${role} · ${job.strategy_code}` : role;
}

function roleScope(job: JobDefinition): string {
  if (job.agent_role === "portfolio_aggregator") return "跨策略统筹：按策略运行时发现入场、持仓出场与兜底，不绑定单一策略";
  if (job.agent_role === "auction_cross_scope") return "跨域竞价：持仓、逐条关注来源、打板机会分别评价，不绑定单一策略";
  return job.strategy_code ? `单策略专项：${job.strategy_code}` : "不绑定单一策略";
}
function toolLabel(code: string): string { return TOOL_LABELS[code] ?? code; }
function responsibility(job: JobDefinition): string {
  if (job.purpose) return job.purpose;
  if (job.job_type === "datasource") return DATASOURCE_INFO[pipelineOf(job)]?.responsibility ?? "执行受控服务端数据同步。";
  if (job.job_type === "agent_flow") return "按绑定提示词读取数据库事实并生成任务结论。";
  return "运行固定服务内分析并登记数据缺口。";
}

function expectedResult(job: JobDefinition): string {
  if (job.job_type === "datasource") return DATASOURCE_INFO[pipelineOf(job)]?.result ?? "数据同步记录。";
  if (job.job_type === "agent_flow") return "任务结果与来源对话；完整结果在“历史与结果”中查看。";
  return "分析记录、指标结果和数据缺口。";
}

/** 调度节奏：由 cron 推导出人类可读的频率标签，不参与调度。 */
function cadenceLabel(job: JobDefinition): string {
  const [minute, hour, dom, , dow] = job.cron.split(/\s+/);
  const at = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (dow === "*") return `每天 ${at}`;
  if (dow === "1-5") return `工作日 ${at}`;
  const names = ["日", "一", "二", "三", "四", "五", "六"];
  if (/^\d$/.test(dow ?? "")) return `每周${names[Number(dow)]} ${at}`;
  if (dom === "*") return `每次 ${at}`;
  return `每月 ${dom} 日 ${at}`;
}

function toggleDetails(job: JobDefinition): void {
  expandedJobCode.value = expandedJobCode.value === job.code ? null : job.code;
}

function createWithAgent(): void {
  askAi(
    "请创建或调整一个受控定时任务。先询问目标、运行频率、任务类型、输入范围、结果归属和失败处理；脚本型任务不在当前范围。确认完整后使用 job_write 生成提案。",
    "维护定时任务",
    { confirmation: "打开 Agent 创建或调整定时任务？\n\n页面只负责查看与运行控制，任务定义由 Agent 维护。" },
  );
}

async function toggle(job: JobDefinition): Promise<void> {
  const key = `toggle:${job.code}`;
  actionKey.value = key;
  const result = await apiClient.patch<JobDefinition>(`/api/jobs/${job.code}/control`, {
    enabled: !job.enabled,
    base_updated_at: job.updated_at,
  });
  actionKey.value = null;
  if (!result.ok) return;
  appMessage.success(result.data.enabled ? `已启用 ${job.name}` : `已暂停 ${job.name}`);
  await jobs.reload();
}

async function trigger(job: JobDefinition, retry = false): Promise<void> {
  const key = `trigger:${job.code}`;
  actionKey.value = key;
  const result = await apiClient.post<JobRun>(`/api/jobs/${job.code}/trigger`, {});
  actionKey.value = null;
  if (!result.ok) return;
  appMessage.success(retry ? `已重新排队 ${job.name}` : `已排队 ${job.name}`);
  if (result.data.session_id) openAgentSession(result.data.session_id);
  await jobs.reload();
}

async function openPrompt(job: JobDefinition): Promise<void> {
  if (!job.prompt_id) return;
  promptJob.value = job;
  promptDetail.value = null;
  promptLoading.value = true;
  promptError.value = null;
  const result = await apiClient.get<JobPrompt>(`/api/job-prompts/${job.prompt_id}`);
  if (promptJob.value?.id !== job.id) return;
  promptLoading.value = false;
  if (result.ok) promptDetail.value = result.data;
  else promptError.value = result;
}

function closePrompt(): void {
  promptJob.value = null;
  promptDetail.value = null;
  promptLoading.value = false;
  promptError.value = null;
}

async function openHistory(job: JobDefinition, requestedRunId?: string | null): Promise<void> {
  historyJob.value = job;
  selectedRun.value = null;
  selectedRunId.value = null;
  runLoading.value = false;
  runs.value = [];
  outputs.value = [];
  historyLoading.value = true;
  historyError.value = null;
  const [runResult, outputResult] = await Promise.all([
    apiClient.get<JobRun[]>(`/api/jobs/${job.code}/runs?limit=80`),
    apiClient.get<JobRunOutput[]>(`/api/jobs/${job.code}/outputs?limit=80`),
  ]);
  historyLoading.value = false;
  if (!runResult.ok) historyError.value = runResult;
  else runs.value = runResult.data;
  if (!outputResult.ok && !historyError.value) historyError.value = outputResult;
  else if (outputResult.ok) outputs.value = outputResult.data;
  if (runResult.ok) {
    const runId = requestedRunId && runResult.data.some((run) => run.id === requestedRunId)
      ? requestedRunId
      : runResult.data[0]?.id;
    if (runId) await openRun(runId);
  }
}

async function openRun(id: string): Promise<void> {
  selectedRunId.value = id;
  selectedRun.value = null;
  runLoading.value = true;
  const result = await apiClient.get<JobRunDetail>(`/api/job-runs/${id}`);
  if (selectedRunId.value !== id) return;
  runLoading.value = false;
  if (result.ok) selectedRun.value = result.data;
}

function openOutput(id: string): void {
  openResult({ type: "job-output", id });
}

async function refresh(): Promise<void> {
  await Promise.all([jobs.reload(), prompts.reload(), llmCatalog.reload()]);
  if (historyJob.value) await openHistory(historyJob.value, selectedRunId.value);
}

async function openRequestedJob(): Promise<void> {
  const requested = typeof route.query.job === "string" ? route.query.job : null;
  if (!requested) return;
  const job = (jobs.data.value ?? []).find((item) => item.id === requested || item.code === requested);
  const requestedRun = typeof route.query.run === "string" ? route.query.run : null;
  if (job) activeTab.value = job.job_type === "agent_flow" ? "agent" : "data";
  if (job && historyJob.value?.id !== job.id) {
    await openHistory(job, requestedRun);
  } else if (job && requestedRun && selectedRunId.value !== requestedRun) {
    await openRun(requestedRun);
  }
}

function closeHistory(): void {
  historyJob.value = null;
  selectedRun.value = null;
  selectedRunId.value = null;
  runLoading.value = false;
}

function showRunList(): void {
  selectedRun.value = null;
  selectedRunId.value = null;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && promptJob.value) {
    closePrompt();
    return;
  }
  if (event.key === "Escape" && historyJob.value && !resultOpen.value) closeHistory();
}

useUiRefresh("jobs", refresh);
onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  await refresh();
  await openRequestedJob();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
watch(() => [route.query.job, route.query.run], () => void openRequestedJob());
</script>

<template>
  <section>
    <div class="page-head page-head-actions">
      <div>
        <h1>任务中心</h1>
        <div class="sub">用列表集中管理任务、运行和结果 · 任务定义与提示词只由 Agent 维护</div>
      </div>
      <button class="btn primary agent-entry" type="button" @click="createWithAgent">让 Agent 维护任务</button>
    </div>

    <nav class="job-tabs" role="tablist" aria-label="任务类型">
      <button class="job-tab" :class="{ active: activeTab === 'agent' }" type="button" role="tab" :aria-selected="activeTab === 'agent'" @click="activeTab = 'agent'">
        <span>Agent 任务</span><span class="tab-count num">{{ tabCounts.agent }}</span>
      </button>
      <button class="job-tab" :class="{ active: activeTab === 'data' }" type="button" role="tab" :aria-selected="activeTab === 'data'" @click="activeTab = 'data'">
        <span>数据获取</span><span class="tab-count num">{{ tabCounts.data }}</span>
      </button>
    </nav>

    <section class="card job-panel">
      <header class="job-toolbar">
        <div class="toolbar-copy">
          <strong>{{ activeTab === "agent" ? "Agent 任务" : "数据获取" }}</strong>
          <span>{{ tabDescription }}</span>
        </div>
        <div class="toolbar-controls">
          <UiInput v-model="keyword" class="job-search" type="search" placeholder="搜索任务名称、编码或职责" aria-label="搜索任务" />
          <div class="status-filter" aria-label="任务状态筛选">
            <button type="button" :class="{ active: filter === 'all' }" @click="filter = 'all'">全部 {{ counts.all }}</button>
            <button type="button" :class="{ active: filter === 'enabled' }" @click="filter = 'enabled'">启用 {{ counts.enabled }}</button>
            <button type="button" :class="{ active: filter === 'paused' }" @click="filter = 'paused'">暂停 {{ counts.paused }}</button>
          </div>
        </div>
      </header>

      <StateBlock :loading="jobs.loading.value" :error="jobs.error.value" :empty="visibleJobs.length === 0" empty-text="当前筛选下没有任务" :skeleton-rows="7" @retry="jobs.reload">
        <div class="job-table-wrap">
          <table class="data-table job-table">
            <thead>
              <tr><th class="col-task">任务</th><th class="col-schedule">调度</th><th class="col-status">状态</th><th class="col-actions">操作</th></tr>
            </thead>
            <tbody>
              <template v-for="job in visibleJobs" :key="job.id">
                <tr class="job-row" :class="{ expanded: expandedJobCode === job.code }">
                  <td>
                    <button class="job-name" type="button" :aria-expanded="expandedJobCode === job.code" @click="toggleDetails(job)">
                      <span class="expand-mark" aria-hidden="true">{{ expandedJobCode === job.code ? "−" : "+" }}</span>
                      <span><strong>{{ job.name }}</strong><small class="code">{{ job.code }}</small></span>
                    </button>
                    <div class="job-meta"><span class="badge accent">{{ TYPE_LABELS[job.job_type] }}</span><span v-if="job.phase" class="badge">{{ job.phase }}</span><span v-if="job.trading_day_only" class="badge">仅交易日</span><span>{{ job.job_type === "agent_flow" ? runtimeRole(job) : executionLabel(job) }}</span></div>
                    <p class="job-purpose-text">{{ responsibility(job) }}</p>
                  </td>
                  <td>
                    <div class="cell-stack"><strong>{{ cadenceLabel(job) }}</strong><small class="code">{{ job.cron }}</small><small>下次 {{ job.next_run ? fmtTime(job.next_run) : "已暂停" }}</small></div>
                  </td>
                  <td>
                    <div class="cell-stack">
                      <span class="badge" :class="job.enabled ? 'ok' : ''">{{ job.enabled ? "已启用" : "已暂停" }}</span>
                      <template v-if="job.latest_run"><span class="badge" :class="STATUS_CLASS[job.latest_run.status]">{{ STATUS_LABELS[job.latest_run.status] }}</span><small>{{ job.latest_run.target_date }}</small></template>
                      <small v-else>尚未运行</small>
                    </div>
                  </td>
                  <td>
                    <div class="row-actions">
                      <button class="btn compact primary" :class="{ 'agent-entry': job.job_type === 'agent_flow' }" type="button" :disabled="actionKey === `trigger:${job.code}`" @click="trigger(job)">立即运行</button>
                      <button class="btn compact" type="button" @click="openHistory(job)">历史与结果</button>
                      <button v-if="job.latest_run && ['failed','partial','missed'].includes(job.latest_run.status)" class="btn compact" :class="{ 'agent-entry': job.job_type === 'agent_flow' }" type="button" @click="trigger(job, true)">重试</button>
                    </div>
                  </td>
                </tr>
                <tr v-if="expandedJobCode === job.code" class="job-detail-row">
                  <td colspan="4">
                    <div class="job-detail-grid">
                      <dl class="job-kv">
                        <dt>执行方式</dt><dd>{{ executionLabel(job) }}</dd>
                        <template v-if="job.job_type === 'agent_flow'"><dt>运行时角色</dt><dd>{{ runtimeRole(job) }} · {{ roleScope(job) }} <RouterLink v-if="job.strategy_code" :to="{ path: '/strategies', query: { strategy: job.strategy_code } }">查看策略 ↗</RouterLink></dd><dt>模型</dt><dd>{{ modelLabel(job) }}</dd></template>
                        <dt>产出</dt><dd>{{ expectedResult(job) }}</dd>
                      </dl>
                      <div v-if="job.job_type === 'agent_flow'" class="job-detail-side">
                        <div><span>可用工具</span><details v-if="job.available_tools.length"><summary>{{ job.available_tools.length }} 项授权能力</summary><div class="tool-list"><span v-for="tool in job.available_tools" :key="tool" class="badge" :title="tool">{{ toolLabel(tool) }}</span></div></details><strong v-else>受限交互工具目录</strong></div>
                        <div class="detail-actions"><button class="btn compact" type="button" :disabled="actionKey === `toggle:${job.code}`" @click="toggle(job)">{{ job.enabled ? "暂停任务" : "启用任务" }}</button><button v-if="job.prompt_id" class="btn compact" type="button" @click="openPrompt(job)">查看当前提示词</button></div>
                      </div>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </StateBlock>
    </section>

    <div v-if="promptJob" class="history-mask" @click.self="closePrompt">
      <aside class="prompt-panel" role="dialog" aria-modal="true" :aria-label="`${promptJob.name} 当前提示词`">
        <div class="history-head"><div><strong>{{ promptJob.name }} · 当前提示词</strong><span class="code">{{ promptJob.code }}</span></div><button class="icon-btn" type="button" aria-label="关闭提示词" title="关闭" @click="closePrompt">×</button></div>
        <StateBlock :loading="promptLoading" :error="promptError" :empty="!promptDetail" empty-text="未找到当前提示词" :skeleton-rows="8" @retry="openPrompt(promptJob)">
          <div v-if="promptDetail" class="prompt-body">
            <div class="prompt-meta"><span class="badge accent">v{{ promptDetail.current_revision_no }}</span><span>{{ promptDetail.name }}</span><span>更新于 {{ fmtTime(promptDetail.updated_at) }}</span></div>
            <MarkdownView :source="promptDetail.current_content ?? ''" />
          </div>
        </StateBlock>
      </aside>
    </div>

    <div v-if="historyJob && !resultOpen" class="history-mask" @click.self="closeHistory">
      <aside class="history-panel" role="dialog" aria-modal="true" :aria-label="`${historyJob.name} 运行历史`">
        <div class="history-head"><div><strong>{{ historyJob.name }}</strong><span class="code">{{ historyJob.code }}</span></div><button class="icon-btn" type="button" aria-label="关闭运行历史" title="关闭" @click="closeHistory">×</button></div>
        <StateBlock :loading="historyLoading" :error="historyError" :empty="runs.length === 0 && outputs.length === 0" empty-text="暂无运行记录或历史结果" :skeleton-rows="5" @retry="openHistory(historyJob, selectedRunId)">
          <div class="history-body" :class="{ 'detail-open': selectedRunId }">
            <aside class="history-list-pane" aria-label="运行记录列表">
              <div class="pane-title"><strong>运行记录</strong><span>{{ runs.length }}</span></div>
              <div class="history-list">
                <button v-for="run in runs" :key="run.id" class="history-item" :class="{ active: selectedRunId === run.id }" type="button" @click="openRun(run.id)">
                  <span class="history-item-main"><span class="num">{{ run.target_date }}</span><span class="badge" :class="STATUS_CLASS[run.status]">{{ STATUS_LABELS[run.status] }}</span></span>
                  <small>{{ fmtTime(run.created_at) }} · #{{ run.id }}</small>
                  <span v-if="outputs.some((output) => output.run_id === run.id)" class="result-mark">有结果</span>
                </button>
              </div>
              <template v-if="detachedOutputs.length">
                <div class="pane-title detached-title"><strong>历史结果</strong><span>{{ detachedOutputs.length }}</span></div>
                <div class="history-list">
                  <button v-for="output in detachedOutputs" :key="output.id" class="history-item output-item" type="button" @click="openOutput(output.id)">
                    <span class="num">{{ output.target_date }}</span><small>{{ output.output_type }} · {{ fmtTime(output.created_at) }}</small><span class="result-mark">查看</span>
                  </button>
                </div>
              </template>
            </aside>

            <main class="run-detail-pane">
              <button class="mobile-back" type="button" @click="showRunList">← 返回运行记录</button>
              <div v-if="runLoading" class="detail-state">正在读取运行详情…</div>
              <template v-else-if="selectedRun">
                <div class="detail-head"><div><strong>运行 #{{ selectedRun.id }}</strong><span class="code">{{ selectedRun.target_date }}</span></div><button v-if="selectedRun.session_id" class="btn compact agent-entry" type="button" @click="openAgentSession(selectedRun.session_id)">打开任务对话</button></div>
                <div class="run-context">
                  <strong>{{ roleScope(historyJob) }}</strong>
                  <RouterLink v-if="historyJob.strategy_code" :to="{ path: '/strategies', query: { strategy: historyJob.strategy_code } }">查看关联策略 ↗</RouterLink>
                  <details v-if="historyJob.available_tools.length"><summary>任务授权工具（{{ historyJob.available_tools.length }} 项；不代表本次调用）</summary><div class="tool-list"><span v-for="tool in historyJob.available_tools" :key="tool" class="badge" :title="tool">{{ toolLabel(tool) }}</span></div></details>
                </div>
                <div class="run-summary">
                  <div><span>状态</span><strong><span class="badge" :class="STATUS_CLASS[selectedRun.status]">{{ STATUS_LABELS[selectedRun.status] }}</span></strong></div>
                  <div><span>触发方式</span><strong>{{ selectedRun.trigger_kind === "cron" ? "自动调度" : "手动运行" }}</strong></div>
                  <div><span>尝试次数</span><strong class="num">{{ selectedRun.attempt_count }}</strong></div>
                  <div><span>完成时间</span><strong>{{ fmtTime(selectedRun.finished_at) ?? "—" }}</strong></div>
                </div>

                <section v-if="selectedRun.job.job_type === 'agent_flow'" class="run-section">
                  <div class="section-title"><strong>本次实际工具调用</strong></div>
                  <div v-if="selectedRun.tool_usage.length" class="tool-list"><span v-for="item in selectedRun.tool_usage" :key="`${item.tool_name}:${item.status}`" class="badge" :class="{ warn: item.status !== 'ok' }" :title="item.tool_name">{{ toolLabel(item.tool_name) }} · {{ item.status }} × {{ item.count }}</span></div>
                  <p v-else class="muted">暂无工具调用遥测；不能据此断定任务没有调用工具。</p>
                </section>
                <section class="run-section output-section">
                  <div class="section-title"><div><strong>任务结果</strong><span v-if="selectedRun.outputs.length > 1">共 {{ selectedRun.outputs.length }} 份，展示最新结果</span></div><button v-if="primaryOutput" class="btn compact" type="button" @click="openOutput(primaryOutput.id)">专注阅读 ↗</button></div>
                  <article v-if="primaryOutput" class="inline-output">
                    <div class="output-meta"><span class="badge accent">{{ primaryOutput.output_type }}</span><span>{{ fmtTime(primaryOutput.created_at) }}</span></div>
                    <MarkdownView :source="primaryOutput.markdown" />
                  </article>
                  <article v-else-if="selectedRun.result_md" class="inline-output"><MarkdownView :source="selectedRun.result_md" /></article>
                  <p v-else class="empty-output">{{ selectedRun.job.job_type === "agent_flow" ? "本次运行尚未生成任务结果。" : "此类任务直接写入业务数据，不生成 Markdown 任务结果。" }}</p>
                </section>

                <section class="run-section"><div class="section-title"><strong>数据缺口</strong></div><pre class="detail-json">{{ selectedRun.data_gaps.length ? prettyJson(selectedRun.data_gaps) : "无" }}</pre></section>
                <section v-if="selectedRun.log" class="run-section"><div class="section-title"><strong>运行日志</strong></div><pre class="run-log">{{ selectedRun.log }}</pre></section>
              </template>
              <div v-else class="detail-state">选择一条运行记录查看状态、任务结果与日志。</div>
            </main>
          </div>
        </StateBlock>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.page-head-actions,.history-head,.detail-head,.section-title{display:flex;align-items:center;justify-content:space-between;gap:12px}
.job-tabs{display:flex;gap:3px;margin-bottom:12px;border-bottom:1px solid var(--line)}
.job-tab{display:inline-flex;align-items:center;gap:8px;min-height:42px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--ink-soft);padding:0 16px;cursor:pointer;font:600 var(--fs-sm) var(--font-body)}
.job-tab:hover{background:var(--paper-deep);color:var(--ink)}
.job-tab.active{border-bottom-color:var(--accent);background:var(--accent-soft);color:var(--accent-ink)}
.tab-count{display:grid;min-width:22px;height:22px;place-items:center;border-radius:999px;background:var(--paper-deep);font-size:11px}
.job-tab.active .tab-count{background:var(--card)}
.job-panel{padding:0;overflow:hidden}
.job-toolbar{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:13px 16px;border-bottom:1px solid var(--line)}
.toolbar-copy{display:grid;gap:3px;min-width:0}.toolbar-copy>span{color:var(--ink-soft);font-size:var(--fs-sm)}
.toolbar-controls{display:flex;align-items:center;justify-content:flex-end;gap:10px;min-width:min(560px,60%)}
.job-search{width:min(300px,100%)}
.status-filter{display:flex;gap:2px;padding:3px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--paper-deep)}
.status-filter button{min-height:28px;border:0;border-radius:6px;background:transparent;color:var(--ink-soft);padding:2px 9px;white-space:nowrap;cursor:pointer;font:500 var(--fs-xs) var(--font-body)}
.status-filter button.active{background:var(--card);color:var(--accent-ink);box-shadow:var(--shadow-soft)}
.job-table-wrap{overflow:auto}.job-table{min-width:720px;table-layout:fixed}
.job-table th{position:sticky;top:0;z-index:2;padding:9px 12px;background:var(--paper-deep);box-shadow:0 1px 0 var(--line);font-size:11px;letter-spacing:.02em}
.job-table td{padding:12px;vertical-align:middle}.job-row:hover{background:var(--accent-soft)}.job-row.expanded{background:var(--paper-deep)}
.col-task{width:42%}.col-schedule{width:22%}.col-status{width:14%}.col-actions{width:22%}
.job-name{display:flex;align-items:flex-start;gap:9px;width:100%;border:0;background:transparent;color:var(--ink);padding:0;text-align:left;cursor:pointer;font:inherit}
.job-name>span:last-child,.cell-stack{display:grid;gap:4px;min-width:0}.job-name strong{overflow-wrap:anywhere}.job-name small,.cell-stack small{color:var(--ink-faint)}
.expand-mark{display:grid;flex:none;width:20px;height:20px;place-items:center;margin-top:1px;border:1px solid var(--line);border-radius:6px;color:var(--accent-ink);font-weight:700}
.job-meta{display:flex;align-items:center;flex-wrap:wrap;gap:5px;margin:5px 0 0 29px;color:var(--ink-soft);font-size:11px}.job-meta>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.job-purpose-text{display:-webkit-box;margin:5px 0 0 29px;overflow:hidden;color:var(--ink-soft);font-size:12px;line-height:1.45;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.cell-stack>span:first-child{display:flex;flex-wrap:wrap;gap:5px}.cell-stack strong{overflow-wrap:anywhere;font-size:12px;line-height:1.4}
.row-actions{display:flex;flex-wrap:wrap;gap:6px}.row-actions .btn{white-space:nowrap}
.job-detail-row td{padding:0 12px 14px;background:var(--paper-deep)}
.job-detail-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,34%);gap:24px;padding:14px 16px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--card)}
.job-kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:8px 12px;margin:0}.job-kv dt{color:var(--ink-faint)}.job-kv dd{min-width:0;margin:0;overflow-wrap:anywhere;line-height:1.5}
.job-detail-side{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-left:20px;border-left:1px solid var(--line)}
.job-detail-side>div{display:grid;gap:5px;min-width:0}.detail-actions{display:flex!important;align-items:flex-start;flex-wrap:wrap;justify-content:flex-end}.job-detail-side>div>span{color:var(--ink-faint);font-size:11px}.job-detail-side summary{color:var(--accent-ink);cursor:pointer}.tool-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}.tool-list .badge{min-width:0;max-width:100%;white-space:normal;overflow-wrap:anywhere;word-break:break-word}
.code{font:11px var(--font-mono);color:var(--ink-faint)}.muted{color:var(--ink-faint);font-size:var(--fs-sm)}
.history-mask{position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end;background:var(--overlay)}
.history-panel,.prompt-panel{display:grid;height:100%;grid-template-rows:auto minmax(0,1fr);overflow:hidden;background:var(--paper);border-left:1px solid var(--line);box-shadow:var(--shadow-lift);overscroll-behavior:contain}.history-panel{width:min(1040px,96vw)}.prompt-panel{width:min(820px,96vw)}
.history-head{padding:15px 18px;background:var(--paper);border-bottom:1px solid var(--line)}.history-head>div,.detail-head>div{display:grid;gap:2px;min-width:0}
.icon-btn{display:grid;width:32px;height:32px;place-items:center;border:1px solid var(--line);border-radius:var(--radius-sm);background:transparent;color:var(--ink-soft);font-size:20px;line-height:1;cursor:pointer}.icon-btn:hover{border-color:var(--accent);color:var(--accent-ink)}
.history-panel>:deep(.state-block),.prompt-panel>:deep(.state-block){min-height:0}.prompt-body{height:100%;overflow:auto;padding:18px 22px 48px}.prompt-meta{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:18px;color:var(--ink-faint);font-size:var(--fs-sm)}
.history-body{display:grid;height:100%;min-height:0;grid-template-columns:minmax(240px,290px) minmax(0,1fr)}.history-list-pane,.run-detail-pane{min-height:0;overflow:auto}.history-list-pane{padding:14px;border-right:1px solid var(--line);background:var(--paper-deep)}.run-detail-pane{min-width:0;padding:18px 20px 48px}
.pane-title{display:flex;align-items:center;justify-content:space-between;margin:0 2px 8px;color:var(--ink-soft);font-size:var(--fs-sm)}.pane-title span{font:11px var(--font-mono)}.detached-title{margin-top:18px;padding-top:14px;border-top:1px solid var(--line)}
.history-list{display:grid;gap:6px}.history-item{position:relative;display:grid;gap:5px;width:100%;padding:10px 11px;text-align:left;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm);cursor:pointer}.history-item:hover{border-color:var(--accent)}.history-item.active{border-color:var(--accent);background:var(--accent-soft)}
.history-item-main{display:flex;align-items:center;justify-content:space-between;gap:8px}.history-item small{padding-right:48px;color:var(--ink-faint);font-size:10.5px}.result-mark{position:absolute;right:10px;bottom:9px;color:var(--accent-ink);font-size:10.5px;font-weight:600}.output-item{grid-template-columns:minmax(0,1fr) auto}.output-item small{grid-column:1/-1}
.detail-head{padding-bottom:14px;border-bottom:1px solid var(--line)}.run-context{display:grid;gap:6px;margin:12px 0;padding:10px;overflow:hidden;background:var(--paper-deep);border-radius:var(--radius-sm)}.run-context summary{white-space:normal;overflow-wrap:anywhere;color:var(--accent-ink);cursor:pointer}
.run-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:14px 0}.run-summary>div{display:grid;gap:5px;padding:10px;background:var(--paper-deep);border-radius:var(--radius-sm)}.run-summary span{color:var(--ink-faint);font-size:11px}.run-summary strong{font-size:12px}
.run-section{margin-top:18px}.section-title{margin-bottom:8px}.section-title>div{display:grid;gap:2px;min-width:0}.section-title span{color:var(--ink-faint);font-size:11px}.inline-output{min-width:0;padding:16px 18px;overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm)}.output-meta{display:flex;align-items:center;gap:8px;margin-bottom:14px;color:var(--ink-faint);font-size:11px}
.empty-output,.detail-state{display:grid;place-items:center;min-height:120px;margin:0;color:var(--ink-faint);text-align:center;background:var(--paper-deep);border:1px dashed var(--line);border-radius:var(--radius-sm)}.detail-json,.run-log{margin:0;padding:11px 12px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink-soft);background:var(--paper-deep);border-radius:var(--radius-sm);font:11.5px/1.55 var(--font-mono)}.mobile-back{display:none}
@media(max-width:900px){.job-toolbar{align-items:stretch;flex-direction:column}.toolbar-controls{justify-content:space-between;min-width:0}.job-search{flex:1}.run-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:700px){.page-head-actions{align-items:flex-start;flex-direction:column}.job-tabs{overflow-x:auto}.job-toolbar{padding:12px}.toolbar-controls{align-items:stretch;flex-direction:column}.job-search{width:100%}.status-filter{align-self:flex-start}.job-detail-grid{grid-template-columns:1fr}.job-detail-side{padding:14px 0 0;border-top:1px solid var(--line);border-left:0}.history-panel,.prompt-panel{width:100vw}.prompt-body{padding:16px 16px 40px}.history-body{grid-template-columns:1fr}.history-body.detail-open .history-list-pane{display:none}.history-body:not(.detail-open) .run-detail-pane{display:none}.history-list-pane,.run-detail-pane{border-right:0}.mobile-back{display:inline-flex;margin-bottom:12px;border:0;background:transparent;color:var(--accent-ink);padding:0;cursor:pointer}.section-title{align-items:flex-start}.inline-output{padding:13px}}
</style>
