<script setup lang="ts">
// 任务中心只负责查看、启停、立即运行和失败处理；任务定义与提示词只能由 Agent 维护。
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { apiClient, type ApiFail } from "../api/client";
import type { JobDefinition, JobPrompt, JobRun, JobRunDetail, JobRunOutput } from "../api/types";
import StateBlock from "../components/StateBlock.vue";
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
};
const DATASOURCE_ORDER = ["market_catalog_sync", "board_membership_sync", "daily_market_update", "daily_market_structure"];
const GROUP_INFO: Record<string, { title: string; description: string }> = {
  datasource: { title: "数据链路", description: "调度器直接执行固定服务端代码，结果写入行情与市场数据表，不调用 Agent。" },
  agent_flow: { title: "Agent 任务", description: "按版本化提示词启动任务对话，生成可查看、可继续追问的 Markdown 结果。" },
  analysis: { title: "服务内分析", description: "服务端分析模块读取数据库计算，结果写入分析记录。" },
};

const jobs = useResource<JobDefinition[]>(() => apiClient.get<JobDefinition[]>("/api/jobs"));
const prompts = useResource<JobPrompt[]>(() => apiClient.get<JobPrompt[]>("/api/job-prompts"));
const filter = ref<"all" | "enabled" | "paused">("all");
const actionKey = ref<string | null>(null);
const historyJob = ref<JobDefinition | null>(null);
const historyTab = ref<"runs" | "outputs">("runs");
const runs = ref<JobRun[]>([]);
const outputs = ref<JobRunOutput[]>([]);
const historyLoading = ref(false);
const historyError = ref<ApiFail | null>(null);
const selectedRun = ref<JobRunDetail | null>(null);
const route = useRoute();
const resultOpen = computed(() => Boolean(parseResultRef(route.query.result)));

const visibleJobs = computed(() => (jobs.data.value ?? []).filter((job) =>
  filter.value === "all" || (filter.value === "enabled" ? job.enabled : !job.enabled),
));
const jobGroups = computed(() => (["datasource", "agent_flow", "analysis"] as const)
  .map((type) => ({
    type,
    ...GROUP_INFO[type]!,
    jobs: visibleJobs.value
      .filter((job) => job.job_type === type)
      .sort((left, right) => type === "datasource"
        ? DATASOURCE_ORDER.indexOf(pipelineOf(left)) - DATASOURCE_ORDER.indexOf(pipelineOf(right))
        : 0),
  }))
  .filter((group) => group.jobs.length > 0));
const counts = computed(() => {
  const rows = jobs.data.value ?? [];
  return { all: rows.length, enabled: rows.filter((row) => row.enabled).length, paused: rows.filter((row) => !row.enabled).length };
});

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

function responsibility(job: JobDefinition): string {
  if (job.job_type === "datasource") return DATASOURCE_INFO[pipelineOf(job)]?.responsibility ?? "执行受控服务端数据同步。";
  if (job.job_type === "agent_flow") return "按绑定提示词读取数据库事实并生成任务结论。";
  return "运行固定服务内分析并登记数据缺口。";
}

function expectedResult(job: JobDefinition): string {
  if (job.job_type === "datasource") return DATASOURCE_INFO[pipelineOf(job)]?.result ?? "数据同步记录。";
  if (job.job_type === "agent_flow") return "任务结果与来源对话；完整结果在“历史与结果”中查看。";
  return "分析记录、指标结果和数据缺口。";
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

async function openHistory(job: JobDefinition, tab: "runs" | "outputs" = "runs"): Promise<void> {
  historyJob.value = job;
  historyTab.value = tab;
  selectedRun.value = null;
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
}

async function openRun(id: string): Promise<void> {
  const result = await apiClient.get<JobRunDetail>(`/api/job-runs/${id}`);
  if (result.ok) selectedRun.value = result.data;
}

function openOutput(id: string): void {
  openResult({ type: "job-output", id });
}

async function refresh(): Promise<void> {
  await Promise.all([jobs.reload(), prompts.reload()]);
  if (historyJob.value) await openHistory(historyJob.value, historyTab.value);
}

async function openRequestedJob(): Promise<void> {
  const requested = typeof route.query.job === "string" ? route.query.job : null;
  if (!requested) return;
  const job = (jobs.data.value ?? []).find((item) => item.id === requested || item.code === requested);
  if (job && historyJob.value?.id !== job.id) {
    await openHistory(job, route.query.tab === "outputs" ? "outputs" : "runs");
  } else if (job && route.query.tab === "outputs") {
    historyTab.value = "outputs";
  }
}

useUiRefresh("jobs", refresh);
onMounted(async () => {
  await refresh();
  await openRequestedJob();
});
watch(() => [route.query.job, route.query.tab], () => void openRequestedJob());
</script>

<template>
  <section>
    <div class="page-head page-head-actions">
      <div><h1>任务中心</h1><div class="sub">查看任务、运行与结果 · 任务定义和提示词只由 Agent 维护</div></div>
      <button class="btn primary agent-entry" type="button" @click="createWithAgent">让 Agent 维护任务</button>
    </div>

    <div class="filter-row">
      <button class="btn" :class="{ primary: filter === 'all' }" type="button" @click="filter = 'all'">全部 {{ counts.all }}</button>
      <button class="btn" :class="{ primary: filter === 'enabled' }" type="button" @click="filter = 'enabled'">运行中 {{ counts.enabled }}</button>
      <button class="btn" :class="{ primary: filter === 'paused' }" type="button" @click="filter = 'paused'">已暂停 {{ counts.paused }}</button>
    </div>

    <StateBlock :loading="jobs.loading.value" :error="jobs.error.value" :empty="visibleJobs.length === 0" empty-text="当前筛选下没有任务" :skeleton-rows="6" @retry="jobs.reload">
      <div class="job-groups">
        <section v-for="group in jobGroups" :key="group.type" class="job-group">
          <div class="group-head">
            <div><h2>{{ group.title }}</h2><p>{{ group.description }}</p></div>
            <span class="badge">{{ group.jobs.length }} 个任务</span>
          </div>
          <div class="job-grid">
            <article v-for="job in group.jobs" :key="job.id" class="card job-card">
              <div class="job-title">
                <div><strong>{{ job.name }}</strong><span class="code">{{ job.code }}</span></div>
                <span class="badge" :class="job.enabled ? 'ok' : ''">{{ job.enabled ? "已启用" : "已暂停" }}</span>
              </div>
              <div class="meta-row"><span class="badge accent">{{ TYPE_LABELS[job.job_type] }}</span><span class="num">{{ job.cron }}</span></div>
              <p class="context">{{ executionLabel(job) }}</p>
              <dl class="job-kv job-purpose">
                <dt>职责</dt><dd>{{ responsibility(job) }}</dd>
                <dt>产出</dt><dd>{{ expectedResult(job) }}</dd>
                <dt>下次运行</dt><dd>{{ job.next_run ? fmtTime(job.next_run) : "已暂停" }}</dd>
                <dt>最近状态</dt><dd><span v-if="job.latest_run" class="badge" :class="STATUS_CLASS[job.latest_run.status]">{{ STATUS_LABELS[job.latest_run.status] }}</span><span v-else>尚未运行</span></dd>
              </dl>
              <div class="actions">
                <button class="btn compact" type="button" :disabled="actionKey === `toggle:${job.code}`" @click="toggle(job)">{{ job.enabled ? "暂停" : "启用" }}</button>
                <button class="btn compact primary" :class="{ 'agent-entry': job.job_type === 'agent_flow' }" type="button" :disabled="actionKey === `trigger:${job.code}`" @click="trigger(job)">立即运行</button>
                <button v-if="job.latest_run && ['failed','partial','missed'].includes(job.latest_run.status)" class="btn compact" :class="{ 'agent-entry': job.job_type === 'agent_flow' }" type="button" @click="trigger(job, true)">重试</button>
                <button class="btn compact" type="button" @click="openHistory(job)">历史与结果</button>
              </div>
            </article>
          </div>
        </section>
      </div>
    </StateBlock>

    <div v-if="historyJob && !resultOpen" class="history-mask" @click.self="historyJob = null">
      <aside class="history-panel">
        <div class="history-head"><div><strong>{{ historyJob.name }}</strong><span class="code">{{ historyJob.code }}</span></div><button class="btn compact" type="button" @click="historyJob = null">关闭</button></div>
        <div class="history-tabs"><button class="btn" :class="{ primary: historyTab === 'runs' }" type="button" @click="historyTab = 'runs'">运行记录</button><button class="btn" :class="{ primary: historyTab === 'outputs' }" type="button" @click="historyTab = 'outputs'">任务结果</button></div>
        <StateBlock :loading="historyLoading" :error="historyError" :empty="historyTab === 'runs' ? runs.length === 0 : outputs.length === 0" empty-text="暂无记录" :skeleton-rows="5" @retry="openHistory(historyJob, historyTab)">
          <div v-if="historyTab === 'runs'" class="history-list">
            <button v-for="run in runs" :key="run.id" class="history-item" type="button" @click="openRun(run.id)"><span class="num">{{ run.target_date }}</span><span class="badge" :class="STATUS_CLASS[run.status]">{{ STATUS_LABELS[run.status] }}</span><span>{{ fmtTime(run.created_at) }}</span></button>
          </div>
          <div v-else class="history-list">
            <button v-for="output in outputs" :key="output.id" class="history-item" type="button" @click="openOutput(output.id)"><span class="num">{{ output.target_date }}</span><span class="badge accent">{{ output.output_type }}</span><span>{{ fmtTime(output.created_at) }}</span></button>
          </div>
        </StateBlock>

        <div v-if="selectedRun" class="detail-card">
          <div class="detail-head"><strong>运行 #{{ selectedRun.id }}</strong><button v-if="selectedRun.session_id" class="btn compact agent-entry" type="button" @click="openAgentSession(selectedRun.session_id)">打开任务对话</button></div>
          <dl class="job-kv"><dt>状态</dt><dd>{{ STATUS_LABELS[selectedRun.status] }}</dd><dt>尝试次数</dt><dd>{{ selectedRun.attempt_count }}</dd><dt>数据缺口</dt><dd>{{ selectedRun.data_gaps.length ? prettyJson(selectedRun.data_gaps) : "无" }}</dd></dl>
          <pre v-if="selectedRun.log" class="run-log">{{ selectedRun.log }}</pre>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.page-head-actions,.job-title,.actions,.history-head,.history-tabs,.detail-head,.meta-row,.group-head{display:flex;align-items:center;gap:8px}.page-head-actions,.job-title,.history-head,.detail-head,.group-head{justify-content:space-between}.filter-row{display:flex;gap:7px;margin-bottom:14px}.job-groups,.job-group{display:grid;gap:14px}.job-group+.job-group{margin-top:8px}.group-head{align-items:flex-start}.group-head h2{margin:0;font-size:var(--fs-lg)}.group-head p{margin:3px 0 0;color:var(--ink-soft);font-size:var(--fs-sm)}.job-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px}.job-card{display:grid;gap:10px}.job-title>div,.history-head>div{display:grid;gap:2px}.code{font:11px var(--font-mono);color:var(--ink-faint)}.context{margin:0;color:var(--ink-soft);font:11px var(--font-mono);overflow-wrap:anywhere}.job-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 12px;margin:0}.job-kv dt{color:var(--ink-faint)}.job-kv dd{margin:0;min-width:0}.job-purpose dd{line-height:1.45}.actions{flex-wrap:wrap;border-top:1px solid var(--line);padding-top:10px}.history-mask{position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end;background:var(--overlay)}.history-panel{width:min(760px,92vw);height:100%;overflow:auto;background:var(--paper);border-left:1px solid var(--line);padding:18px;box-shadow:var(--shadow-lift)}.history-head{position:sticky;top:-18px;z-index:2;margin:-18px -18px 14px;padding:15px 18px;background:var(--paper);border-bottom:1px solid var(--line)}.history-tabs{margin-bottom:12px}.history-list{display:grid;gap:6px}.history-item{display:grid;grid-template-columns:120px 110px minmax(0,1fr);align-items:center;gap:10px;width:100%;padding:9px 10px;text-align:left;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm);cursor:pointer}.detail-card{margin-top:14px;padding:14px;background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md)}.run-log{max-height:280px;overflow:auto;white-space:pre-wrap;color:var(--ink-soft);background:var(--paper-deep);padding:10px;border-radius:var(--radius-sm)}@media(max-width:700px){.page-head-actions,.group-head{align-items:flex-start;flex-direction:column}.job-grid{grid-template-columns:1fr}.history-item{grid-template-columns:1fr auto}.history-item span:last-child{grid-column:1/-1}}
</style>
