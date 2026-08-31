<script setup lang="ts">
// 任务中心只负责查看、启停、立即运行和失败处理；任务定义与提示词只能由 Agent 维护。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { apiClient, type ApiFail } from "../api/client";
import type { JobDefinition, JobPrompt, JobRun, JobRunDetail, JobRunOutput } from "../api/types";
import MarkdownView from "../components/MarkdownView.vue";
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

const visibleJobs = computed(() => (jobs.data.value ?? []).filter((job) =>
  filter.value === "all" || (filter.value === "enabled" ? job.enabled : !job.enabled),
));
const jobGroups = computed(() => (["agent_flow", "datasource", "analysis"] as const)
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
const detachedOutputs = computed(() => outputs.value.filter((output) =>
  !output.run_id || !runs.value.some((run) => run.id === output.run_id),
));
const primaryOutput = computed(() => selectedRun.value?.outputs[0] ?? null);
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
  await Promise.all([jobs.reload(), prompts.reload()]);
  if (historyJob.value) await openHistory(historyJob.value, selectedRunId.value);
}

async function openRequestedJob(): Promise<void> {
  const requested = typeof route.query.job === "string" ? route.query.job : null;
  if (!requested) return;
  const job = (jobs.data.value ?? []).find((item) => item.id === requested || item.code === requested);
  const requestedRun = typeof route.query.run === "string" ? route.query.run : null;
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
                <button v-if="job.job_type === 'agent_flow' && job.prompt_id" class="btn compact" type="button" @click="openPrompt(job)">查看提示词</button>
                <button class="btn compact" type="button" @click="openHistory(job)">历史与结果</button>
              </div>
            </article>
          </div>
        </section>
      </div>
    </StateBlock>

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
                <div class="run-summary">
                  <div><span>状态</span><strong><span class="badge" :class="STATUS_CLASS[selectedRun.status]">{{ STATUS_LABELS[selectedRun.status] }}</span></strong></div>
                  <div><span>触发方式</span><strong>{{ selectedRun.trigger_kind === "cron" ? "自动调度" : "手动运行" }}</strong></div>
                  <div><span>尝试次数</span><strong class="num">{{ selectedRun.attempt_count }}</strong></div>
                  <div><span>完成时间</span><strong>{{ fmtTime(selectedRun.finished_at) ?? "—" }}</strong></div>
                </div>

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
.page-head-actions,.job-title,.actions,.history-head,.detail-head,.meta-row,.group-head,.section-title{display:flex;align-items:center;gap:8px}.page-head-actions,.job-title,.history-head,.detail-head,.group-head,.section-title{justify-content:space-between}.filter-row{display:flex;gap:7px;margin-bottom:14px}.job-groups,.job-group{display:grid;gap:14px}.job-group+.job-group{margin-top:8px}.group-head{align-items:flex-start}.group-head h2{margin:0;font-size:var(--fs-lg)}.group-head p{margin:3px 0 0;color:var(--ink-soft);font-size:var(--fs-sm)}.job-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px}.job-card{display:grid;gap:10px}.job-title>div,.history-head>div,.detail-head>div{display:grid;gap:2px}.code{font:11px var(--font-mono);color:var(--ink-faint)}.context{margin:0;color:var(--ink-soft);font:11px var(--font-mono);overflow-wrap:anywhere}.job-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 12px;margin:0}.job-kv dt{color:var(--ink-faint)}.job-kv dd{margin:0;min-width:0}.job-purpose dd{line-height:1.45}.actions{flex-wrap:wrap;border-top:1px solid var(--line);padding-top:10px}.history-mask{position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end;background:var(--overlay)}.history-panel,.prompt-panel{display:grid;height:100%;grid-template-rows:auto minmax(0,1fr);overflow:hidden;background:var(--paper);border-left:1px solid var(--line);box-shadow:var(--shadow-lift);overscroll-behavior:contain}.history-panel{width:min(1040px,96vw)}.prompt-panel{width:min(820px,96vw)}.history-head{padding:15px 18px;background:var(--paper);border-bottom:1px solid var(--line)}.icon-btn{display:grid;width:32px;height:32px;place-items:center;border:1px solid var(--line);border-radius:var(--radius-sm);background:transparent;color:var(--ink-soft);font-size:20px;line-height:1;cursor:pointer}.icon-btn:hover{border-color:var(--accent);color:var(--accent-ink)}.history-panel>:deep(.state-block),.prompt-panel>:deep(.state-block){min-height:0}.prompt-body{height:100%;overflow:auto;padding:18px 22px 48px}.prompt-meta{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:18px;color:var(--ink-faint);font-size:var(--fs-sm)}.history-body{display:grid;height:100%;min-height:0;grid-template-columns:minmax(240px,290px) minmax(0,1fr)}.history-list-pane,.run-detail-pane{min-height:0;overflow:auto}.history-list-pane{padding:14px;border-right:1px solid var(--line);background:var(--paper-deep)}.run-detail-pane{padding:18px 20px 48px}.pane-title{display:flex;align-items:center;justify-content:space-between;margin:0 2px 8px;color:var(--ink-soft);font-size:var(--fs-sm)}.pane-title span{font:11px var(--font-mono)}.detached-title{margin-top:18px;padding-top:14px;border-top:1px solid var(--line)}.history-list{display:grid;gap:6px}.history-item{position:relative;display:grid;gap:5px;width:100%;padding:10px 11px;text-align:left;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm);cursor:pointer}.history-item:hover{border-color:var(--accent)}.history-item.active{border-color:var(--accent);background:var(--accent-soft)}.history-item-main{display:flex;align-items:center;justify-content:space-between;gap:8px}.history-item small{padding-right:48px;color:var(--ink-faint);font-size:10.5px}.result-mark{position:absolute;right:10px;bottom:9px;color:var(--accent-ink);font-size:10.5px;font-weight:600}.output-item{grid-template-columns:minmax(0,1fr) auto}.output-item small{grid-column:1/-1}.detail-head{padding-bottom:14px;border-bottom:1px solid var(--line)}.run-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:14px 0}.run-summary>div{display:grid;gap:5px;padding:10px;background:var(--paper-deep);border-radius:var(--radius-sm)}.run-summary span{color:var(--ink-faint);font-size:11px}.run-summary strong{font-size:12px}.run-section{margin-top:18px}.section-title{margin-bottom:8px}.section-title>div{display:grid;gap:2px}.section-title span{color:var(--ink-faint);font-size:11px}.inline-output{padding:16px 18px;background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm)}.output-meta{display:flex;align-items:center;gap:8px;margin-bottom:14px;color:var(--ink-faint);font-size:11px}.empty-output,.detail-state{display:grid;place-items:center;min-height:120px;margin:0;color:var(--ink-faint);text-align:center;background:var(--paper-deep);border:1px dashed var(--line);border-radius:var(--radius-sm)}.detail-json,.run-log{margin:0;padding:11px 12px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink-soft);background:var(--paper-deep);border-radius:var(--radius-sm);font:11.5px/1.55 var(--font-mono)}.mobile-back{display:none}@media(max-width:800px){.run-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:700px){.page-head-actions,.group-head{align-items:flex-start;flex-direction:column}.job-grid{grid-template-columns:1fr}.history-panel,.prompt-panel{width:100vw}.prompt-body{padding:16px 16px 40px}.history-body{grid-template-columns:1fr}.history-body.detail-open .history-list-pane{display:none}.history-body:not(.detail-open) .run-detail-pane{display:none}.history-list-pane,.run-detail-pane{border-right:0}.mobile-back{display:inline-flex;margin-bottom:12px;border:0;background:transparent;color:var(--accent-ink);padding:0;cursor:pointer}.run-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.section-title{align-items:flex-start}.inline-output{padding:13px}}
</style>
