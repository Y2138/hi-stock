<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { apiClient, type ApiFail } from "../api/client";
import type { AgentMemory, BacktestDetail, JobRunOutput } from "../api/types";
import { openAgentSession } from "../utils/askAi";
import { fmtTime } from "../utils/format";
import type { ResultRef } from "../utils/results";
import MarkdownView from "./MarkdownView.vue";

const props = defineProps<{ result: ResultRef }>();
const emit = defineEmits<{ close: [] }>();
const router = useRouter();
const loading = ref(false);
const error = ref<ApiFail | null>(null);
const data = ref<JobRunOutput | BacktestDetail | AgentMemory | null>(null);
let loadVersion = 0;

const jobOutput = computed(() => props.result.type === "job-output" ? data.value as JobRunOutput | null : null);
const backtest = computed(() => props.result.type === "backtest-result" ? data.value as BacktestDetail | null : null);
const memory = computed(() => props.result.type === "memory" ? data.value as AgentMemory | null : null);
const title = computed(() => jobOutput.value
  ? `${jobOutput.value.output_type} · ${jobOutput.value.target_date}`
  : backtest.value?.name ?? memory.value?.title ?? "结果预览");
const eyebrow = computed(() => jobOutput.value
  ? `任务结果 #${jobOutput.value.id}`
  : backtest.value ? `回测结论 #${backtest.value.id}` : memory.value ? `Agent 记忆 #${memory.value.id}` : "结果预览");
const markdown = computed(() => jobOutput.value?.markdown ?? backtest.value?.conclusion_md ?? memory.value?.content ?? "");
const sessionId = computed(() => jobOutput.value?.session_id ?? backtest.value?.session_id ?? memory.value?.source_session_id ?? null);
const pageLabel = computed(() => jobOutput.value ? "前往任务中心" : backtest.value ? "前往回测历史" : "前往记忆库");

async function load(): Promise<void> {
  const version = ++loadVersion;
  loading.value = true;
  error.value = null;
  data.value = null;
  const path = props.result.type === "job-output"
    ? `/api/job-outputs/${props.result.id}`
    : props.result.type === "backtest-result"
      ? `/api/backtests/${props.result.id}`
      : `/api/memories/${props.result.id}`;
  const result = await apiClient.get<JobRunOutput | BacktestDetail | AgentMemory>(path);
  if (version !== loadVersion) return;
  loading.value = false;
  if (result.ok) data.value = result.data;
  else error.value = result;
}

function goToPage(): void {
  if (jobOutput.value) {
    void router.push({ path: "/jobs", query: {
      job: jobOutput.value.job_id,
      ...(jobOutput.value.run_id ? { run: jobOutput.value.run_id } : {}),
    } });
  } else if (backtest.value) {
    void router.push({ path: "/backtests", query: { run: backtest.value.id } });
  } else if (memory.value) {
    void router.push({ path: "/memories", query: { memory: memory.value.id } });
  }
}

watch(() => `${props.result.type}:${props.result.id}`, () => void load(), { immediate: true });
</script>

<template>
  <section class="result-preview-shell" aria-label="落库结果预览">
    <header class="result-preview-head">
      <div class="result-title">
        <span>{{ eyebrow }}</span>
        <strong>{{ title }}</strong>
      </div>
      <div class="result-actions">
        <button v-if="data" class="btn compact" type="button" @click="goToPage">{{ pageLabel }}</button>
        <button v-if="sessionId" class="btn compact agent-entry" type="button" @click="openAgentSession(sessionId)">打开来源对话</button>
        <button class="btn compact primary" type="button" aria-label="关闭结果预览" @click="emit('close')">关闭</button>
      </div>
    </header>

    <div class="result-preview-scroll">
      <div v-if="loading" class="result-state">正在读取已落库结果…</div>
      <div v-else-if="error" class="result-state error">
        <strong>结果读取失败</strong><span>{{ error.code }}：{{ error.message }}</span>
        <button class="btn compact" type="button" @click="load">重试</button>
      </div>
      <article v-else-if="data" class="result-document">
        <div class="result-meta">
          <template v-if="jobOutput">
            <span class="badge accent">{{ jobOutput.status }}</span><span>目标日 {{ jobOutput.target_date }}</span><span>{{ fmtTime(jobOutput.created_at) }}</span>
          </template>
          <template v-else-if="backtest">
            <span class="badge ok">最终结论</span><span>{{ backtest.execution_origin }}</span><span>{{ fmtTime(backtest.finalized_at ?? backtest.created_at) }}</span>
          </template>
          <template v-else-if="memory">
            <span class="badge accent">{{ memory.category }}</span><span>{{ memory.status }}</span><span>最后验证 {{ fmtTime(memory.last_verified_at) }}</span>
          </template>
        </div>
        <p v-if="backtest?.conclusion_summary" class="result-summary">{{ backtest.conclusion_summary }}</p>
        <p v-if="backtest?.applicability_boundary" class="result-boundary"><strong>适用边界：</strong>{{ backtest.applicability_boundary }}</p>
        <p v-if="memory?.summary" class="result-summary">{{ memory.summary }}</p>
        <MarkdownView v-if="markdown" :source="markdown" />
        <p v-else class="result-state">该记录没有可预览的 Markdown 正文。</p>
        <div v-if="memory?.evidence" class="result-evidence"><strong>证据</strong><p>{{ memory.evidence }}</p></div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.result-preview-shell{display:grid;height:100%;grid-template-rows:auto minmax(0,1fr);background:var(--paper)}.result-preview-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 20px;border-bottom:1px solid var(--line);background:var(--card)}.result-title{display:grid;min-width:0}.result-title span{color:var(--ink-faint);font:11px var(--font-mono)}.result-title strong{overflow:hidden;font-size:var(--fs-lg);text-overflow:ellipsis;white-space:nowrap}.result-actions,.result-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.result-preview-scroll{min-height:0;overflow:auto;padding:28px 24px 56px}.result-document{max-width:860px;margin:0 auto;padding:30px 42px;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--card);box-shadow:var(--shadow-soft)}.result-meta{margin-bottom:22px;padding-bottom:14px;border-bottom:1px solid var(--line);color:var(--ink-faint);font-size:var(--fs-sm)}.result-summary{font-size:15px;font-weight:600}.result-boundary,.result-evidence{padding:12px 14px;border-left:3px solid var(--accent);background:var(--accent-soft);color:var(--ink-soft)}.result-evidence{margin-top:28px}.result-evidence p{margin:4px 0 0}.result-state{display:grid;place-items:center;gap:10px;min-height:220px;color:var(--ink-faint);text-align:center}.result-state.error{color:var(--up)}@container business (max-width:700px){.result-preview-head{align-items:flex-start;flex-direction:column}.result-actions{width:100%}.result-preview-scroll{padding:14px 10px 36px}.result-document{padding:20px 18px}}
</style>
