<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { apiClient, type ApiFail } from "../api/client";
import type { BacktestDetail, BacktestListItem, BacktestSourceVersion, StandardRunStatus, StandardPage, StandardEvent, StandardEquity } from "../api/types";
import MarkdownView from "../components/MarkdownView.vue";
import ResultLink from "../components/ResultLink.vue";
import StateBlock from "../components/StateBlock.vue";
import { useUiRefresh } from "../composables/useUiRefresh";
import { appMessage } from "../stores/message";
import { askAi, openAgentSession } from "../utils/askAi";
import { fmtTime, prettyJson } from "../utils/format";

const KIND_LABELS: Record<string, string> = { formal: "历史正式分类", research: "研究" };
const ORIGIN_LABELS: Record<string, string> = {
  agent_workspace: "Agent 临时工作区",
  service: "旧服务回测",
  legacy: "历史记录",
};
const EXECUTION_LABELS: Record<string, string> = {
  legacy: "历史记录",
  queued: "排队中",
  preparing: "准备中",
  running: "计算中",
  cancelled: "已取消",
  rejected: "已拒绝",
  success: "成功",
  partial: "部分成功",
  failed: "失败",
};

const scope = ref<"final" | "working" | "all">("final");
const list = { data: ref<BacktestListItem[] | null>(null), loading: ref(false), error: ref<ApiFail | null>(null) };
const listMore = ref(false);
const listHasMore = ref(false);
const detailId = ref<string | null>(null);
const detail = { data: ref<BacktestDetail | null>(null), loading: ref(false), error: ref<ApiFail | null>(null) };
const runtime = ref<StandardRunStatus | null>(null);
const runtimeError = ref<ApiFail | null>(null);
const compareIds = ref<string[]>([]);
const sourceVersion = ref<BacktestSourceVersion | null>(null);
const sourceLoading = ref(false);
const sourceVisible = ref(false);
const events = ref<StandardEvent[]>([]);
const equity = ref<StandardEquity[]>([]);
const eventCursor = ref<string | null>(null);
const equityCursor = ref<string | null>(null);
const eventLoaded = ref(false);
const eventLoading = ref(false);
const equityLoading = ref(false);
const eventError = ref<ApiFail | null>(null);
const equityError = ref<ApiFail | null>(null);
const route = useRoute();
let alive = true;
let detailEpoch = 0;
let listEpoch = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let detailRequest: Promise<void> | null = null;
const isStandard = computed(() => detail.data.value?.engine_type === "standard_daily");
const activeStatus = computed(() => runtime.value?.execution_status ?? detail.data.value?.execution_status ?? "");
const isRunning = computed(() => ["queued", "preparing", "running"].includes(activeStatus.value));
const progress = computed(() => Math.min(100, Math.max(0, runtime.value?.progress ?? detail.data.value?.progress ?? 0)));
const plan = computed(() => runtime.value?.execution_plan ?? detail.data.value?.execution_plan);
const metrics = computed(() => runtime.value?.metrics_json ?? detail.data.value?.metrics_json);
const metricCards = computed(() => isStandard.value ? [
  ["总收益", metricRatio(metrics.value?.total_return)],
  ["最大回撤", metricRatio(metrics.value?.max_drawdown)],
  ["闭环交易数", metrics.value?.trade_count ?? "—"],
  ["胜率", metricRatio(metrics.value?.win_rate)],
  ["基准价格收益", metricRatio(metrics.value?.benchmark_return)],
  ["相对基准收益差", metricRatio(metrics.value?.excess_return)],
  ["累计费用（元）", typeof metrics.value?.fees_cents === "number" ? metric(metrics.value.fees_cents / 100) : "—"],
] : [
  ["总收益", metric(metrics.value?.total_return_pct, "%")],
  ["年化收益", metric(metrics.value?.annualized_return_pct, "%")],
  ["最大回撤", metric(metrics.value?.max_drawdown_pct, "%")],
  ["年化波动", metric(metrics.value?.annualized_volatility_pct, "%")],
]);
const gapItems = computed(() => runtime.value?.data_gaps ?? detail.data.value?.data_gaps ?? []);
const latestEquity = computed(() => equity.value.at(-1));
const charts = computed(() => {
  const initial = plan.value?.initial_cash;
  return [
    { title: "净值（期初资金 = 1）", values: equity.value.map((row) => initial ? row.equity_cents / (initial * 100) : NaN), percent: false },
    { title: "回撤（损失幅度）", values: equity.value.map((row) => row.drawdown * 100), percent: true },
  ].map((chart) => {
    const valid = chart.values.every(Number.isFinite) && chart.values.length > 0;
    const min = valid ? chart.values.reduce((low, value) => Math.min(low, value), chart.percent ? 0 : 1) : 0;
    const max = valid ? chart.values.reduce((high, value) => Math.max(high, value), chart.percent ? 0 : 1) : 1;
    const y = (value: number) => 108 - (value - min) / (max - min || 1) * 96;
    return { ...chart, min, max, valid,
      points: valid ? chart.values.map((value, index) => `${12 + index / Math.max(chart.values.length - 1, 1) * 576},${y(value)}`).join(" ") : "",
      lastY: valid ? y(chart.values.at(-1)!) : 108,
    };
  });
});

function chartMetric(value: unknown, percent: boolean): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(percent ? 2 : 4)}${percent ? "%" : ""}` : "—";
}
function metricRatio(value: unknown): string {
  return typeof value === "number" ? metric(value * 100, "%") : "—";
}
function evidenceLabel(run: BacktestListItem): string {
  if (run.engine_type === "standard_daily") return "标准研究 · 非发布收益证据";
  if (run.evidence_status === "qualified") return "正式证据 · 以系统资格校验为准";
  return "旧口径 · 未验证证据资格";
}
function clearPoll(): void {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  pollTimer = undefined;
}
async function loadList(append = false): Promise<void> {
  if (append && (list.loading.value || listMore.value || !listHasMore.value)) return;
  const epoch = ++listEpoch;
  const before = append ? list.data.value?.at(-1)?.id : undefined;
  list.loading.value = !append && !list.data.value;
  listMore.value = true;
  list.error.value = null;
  const query = scope.value === "final" ? "" : `?scope=${scope.value}&limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`;
  const result = await apiClient.get<BacktestListItem[]>(`/api/backtests${query}`);
  if (!alive || epoch !== listEpoch) return;
  if (result.ok) {
    const prior = append ? list.data.value ?? [] : [];
    list.data.value = [...prior, ...result.data.filter((row) => !prior.some((item) => item.id === row.id))];
    listHasMore.value = scope.value !== "final" && result.data.length === 50;
  } else list.error.value = result;
  list.loading.value = false;
  listMore.value = false;
}
async function loadEvents(): Promise<void> {
  if (!detailId.value || !isStandard.value || eventLoading.value) return;
  const epoch = detailEpoch;
  const after = eventCursor.value ?? (eventLoaded.value ? String(events.value.at(-1)?.seq ?? 0) : "0");
  eventLoading.value = true;
  eventError.value = null;
  const result = await apiClient.get<StandardPage<StandardEvent>>(`/api/backtests/${detailId.value}?view=events&after=${encodeURIComponent(after)}&limit=100`);
  if (!alive || epoch !== detailEpoch) return;
  if (result.ok) {
    const seen = new Set(events.value.map((item) => item.seq));
    events.value.push(...result.data.items.filter((item) => !seen.has(item.seq)));
    eventCursor.value = result.data.next_cursor;
    eventLoaded.value = true;
  } else eventError.value = result;
  eventLoading.value = false;
}
async function loadEquity(): Promise<void> {
  if (!detailId.value || !isStandard.value || equityLoading.value) return;
  const epoch = detailEpoch;
  const after = equityCursor.value ?? equity.value.at(-1)?.date;
  equityLoading.value = true;
  equityError.value = null;
  const result = await apiClient.get<StandardPage<StandardEquity>>(`/api/backtests/${detailId.value}?view=equity&limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`);
  if (!alive || epoch !== detailEpoch) return;
  if (result.ok) {
    const seen = new Set(equity.value.map((item) => item.date));
    equity.value.push(...result.data.items.filter((item) => !seen.has(item.date)));
    equityCursor.value = result.data.next_cursor;
  } else equityError.value = result;
  equityLoading.value = false;
}
function refreshDetail(): Promise<void> {
  if (!alive || !detailId.value) return Promise.resolve();
  if (detailRequest) return detailRequest;
  clearPoll();
  const epoch = detailEpoch;
  const id = detailId.value;
  detail.loading.value = !detail.data.value;
  detail.error.value = null;
  detailRequest = (async () => {
    const result = await apiClient.get<BacktestDetail>(`/api/backtests/${id}`);
    if (!alive || epoch !== detailEpoch) return;
    if (!result.ok) { detail.error.value = result; return; }
    detail.data.value = result.data;
    if (isStandard.value) {
      const status = await apiClient.get<StandardRunStatus>(`/api/backtests/${id}?view=runtime`);
      if (!alive || epoch !== detailEpoch) return;
      runtimeError.value = status.ok ? null : status;
      if (status.ok) runtime.value = status.data;
      // 追尾只针对已追平的分页；有 next_cursor 时由用户显式加载，避免跳过中间区间。
      await Promise.all([
        !eventCursor.value ? loadEvents() : Promise.resolve(),
        !equityCursor.value ? loadEquity() : Promise.resolve(),
      ]);
    }
    if (!alive || epoch !== detailEpoch) return;
    const row = list.data.value?.find((item) => item.id === id);
    if (row) Object.assign(row, result.data, runtime.value ? {
      execution_status: runtime.value.execution_status, progress: runtime.value.progress,
    } : {});
  })().finally(() => {
    if (!alive || epoch !== detailEpoch) return;
    detail.loading.value = false;
    detailRequest = null;
    if (isRunning.value) pollTimer = setTimeout(() => void refreshDetail(), 5000);
  });
  return detailRequest;
}

function statusClass(run: BacktestListItem): string {
  if (run.execution_status === "success") return "ok";
  if (["failed", "rejected"].includes(run.execution_status)) return "bad";
  if (run.execution_status === "partial" || run.execution_status === "queued") return "warn";
  return "";
}

function metric(value: unknown, suffix = ""): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}${suffix}` : "—";
}

function shortHash(value: string | null): string {
  return value ? `${value.slice(0, 10)}…` : "—";
}

function jsonOrEmpty(value: unknown): string {
  return prettyJson(value) ?? "未记录";
}

async function openDetail(run: Pick<BacktestListItem, "id">): Promise<void> {
  clearPoll();
  ++detailEpoch;
  detailRequest = null;
  detailId.value = run.id;
  detail.data.value = null;
  detail.error.value = null;
  runtime.value = null;
  runtimeError.value = null;
  sourceVersion.value = null;
  sourceVisible.value = false;
  sourceLoading.value = false;
  events.value = [];
  equity.value = [];
  eventCursor.value = equityCursor.value = null;
  eventLoaded.value = false;
  eventLoading.value = equityLoading.value = false;
  eventError.value = equityError.value = null;
  await refreshDetail();
}

async function toggleSource(run: BacktestDetail): Promise<void> {
  if (run.engine_type === "standard_daily" || sourceLoading.value) return;
  if (sourceVersion.value?.backtest_run_id === run.id) {
    sourceVisible.value = !sourceVisible.value;
    return;
  }
  const epoch = detailEpoch;
  sourceLoading.value = true;
  const result = await apiClient.get<BacktestSourceVersion>(`/api/backtests/${run.id}/source`);
  if (!alive || epoch !== detailEpoch) return;
  sourceLoading.value = false;
  if (!result.ok) return;
  sourceVersion.value = result.data;
  sourceVisible.value = true;
}

const standardFlow = [
  "先确定目标、假设、注册规则、标的与日期，并让我显式确认全部成本（佣金、最低佣金、卖出税、滑点、成交量参与率）；不要推测缺省成本或编写自由源码。",
  "对完整计划调用 preflight_backtest(plan)。仅当返回 enabled 且 executable，并且我已明确请求执行时，调用 start_standard_backtest(plan, plan_hash, input_hash, idempotency_key, comparison_run_ids)；哈希必须取自本次预检，重试同次执行复用幂等键。",
  "若未启用，说明 STANDARD_BACKTEST_ENABLED 默认关闭，提示联系本机维护者按部署说明启用后重新预检；仍可整理计划，不要说系统不可用。缺数或不可执行时列出缺口，不绕过校验。",
  "使用 get_backtest_status 跟踪运行；成功后使用 finalize_backtest 固化研究结论。无完整历史公司行为资格永远 research_only，不得声称能发布收益证据，也不得自动发布策略。",
].join("\n");
function startStandard(run?: BacktestDetail): void {
  askAi([
    run ? `请读取标准回测 #${run.id} 的 execution_plan、状态、输入哈希、结论和缺口，先询问我要延续、修改还是反证；若发起新运行，将 #${run.id} 加入 comparison_run_ids。不要转为自由源码回测。`
      : "我想发起标准日频研究回测；请先帮我明确计划，在目标与显式成本确认完整后执行。",
    standardFlow,
  ].join("\n"), run ? "继续标准计划" : "发起标准回测", {
    sessionType: "backtest", title: run ? `继续标准回测 #${run.id}` : "标准回测研究",
    parentSessionId: run?.session_id ?? null,
  });
}
function cancelStandard(): void {
  if (!detailId.value || !isStandard.value || !isRunning.value) return;
  askAi(`我请求取消标准回测 #${detailId.value}。请调用 cancel_backtest，参数 run_id 为 "${detailId.value}"，reason 为“用户在回测工作台请求取消”；使用 get_backtest_status 跟踪取消是否完成。请求取消不等于已取消，不要发起新回测或自动重试运行。`,
    "取消标准回测", { sessionType: "backtest", title: `取消回测 #${detailId.value}`, parentSessionId: detail.data.value?.session_id });
}

function toggleCompare(id: string): void {
  compareIds.value = compareIds.value.includes(id)
    ? compareIds.value.filter((item) => item !== id)
    : [...compareIds.value, id].slice(-6);
}

function startAgentBacktest(): void {
  askAi(
    [
      "我想验证一个策略思路。请先询问我本次要验证的假设、标的范围和时间区间；不要替我猜交易规则。",
      "确认目标后，从 PostgreSQL 读取最新 strategy_state 与相关策略正文，并按需读取历史 backtest_run/backtest_run_comparison。",
      "先查看系统提示中的固化回测源码索引；存在策略哈希、SDK 和目标相近的版本时，先用 read_backtest_source 读取并最小改造，没有合适版本才从零编写。",
      "通过 run_backtest 在隔离环境执行；复用源码时填写 base_source_run_id，完整源码只放工具参数，禁止复制到普通回复。",
      "可以在同一会话继续试验和反证；证据完整后使用 finalize_backtest 固化最终结论与源码，明确摘要与适用边界。只有最终结论进入回测历史。",
      "若建议调整策略，只能引用已确认的最终回测并创建 strategy_publish_request 待审提案，策略发布必须由我在当前策略页人工确认。",
    ].join("\n"),
    "Agent 回测验证",
    { sessionType: "backtest", title: "Agent 回测验证" },
  );
}

function continueFrom(run: BacktestDetail): void {
  if (run.engine_type === "standard_daily") { startStandard(run); return; }
  askAi(
    `请读取回测 #${run.id} 的研究大纲、假设、策略快照、输入摘要、指标、结论和缺口。${run.source_retention_status === "versioned" ? `先调用 read_backtest_source 读取 #${run.id} 的固化源码，并在其基础上做最小修改；` : "该历史记录没有可恢复源码；"}先说明它还缺什么证据，再询问我要延续、修改还是反证这个思路；如需新验证，使用 run_backtest，把 #${run.id} 放入 comparison_run_ids${run.source_retention_status === "versioned" ? `，并将 base_source_run_id 设为 ${run.id}` : ""}。源码只能进入工具参数，不能出现在普通回复。`,
    `延续回测 #${run.id}`,
    {
      sessionType: "backtest",
      parentSessionId: run.session_id,
      title: `延续回测 #${run.id}`,
      confirmation: `确认基于回测 #${run.id} 新建延续会话？\n\n系统会带入原回测上下文，但不会自动执行或发送。`,
    },
  );
}

function compareSelected(): void {
  if (compareIds.value.length < 2) {
    appMessage.warning("请先勾选至少两条回测记录", { title: "无法对比" });
    return;
  }
  const ids = compareIds.value.map((id) => `#${id}`).join("、");
  askAi(
    `请从 PostgreSQL 对比回测 ${ids}。逐项比较研究大纲、假设、引擎、计划、显式成本、策略快照、输入哈希/覆盖、指标、结论和缺口；核对标准运行的 comparisons、comparable 与 reasons。区分策略参数、样本与实现口径差异；旧口径和标准研究不得直接排名或视为正式收益证据。只比较已记录证据，不生成买卖建议。如需补充验证，先征得我同意：标准运行沿用标准计划和 comparison_run_ids，旧探索才使用 run_backtest。\n${standardFlow}`,
    `对比 ${compareIds.value.length} 条回测`,
    { sessionType: "backtest", title: `对比 ${compareIds.value.length} 条回测` },
  );
}

async function reloadAll(): Promise<void> {
  await Promise.all([loadList(), refreshDetail()]);
}
useUiRefresh("backtests", reloadAll);
onMounted(async () => {
  await loadList();
  if (!alive || detailId.value) return;
  const requested = typeof route.query.run === "string" ? route.query.run : null;
  const first = requested ? { id: requested } : list.data.value?.[0];
  if (first) await openDetail(first);
});
watch(scope, () => {
  list.data.value = null;
  listHasMore.value = false;
  void loadList();
});
watch(() => route.query.run, (id) => {
  if (typeof id === "string" && id !== detailId.value) void openDetail({ id });
});
onBeforeUnmount(() => {
  alive = false;
  ++detailEpoch;
  ++listEpoch;
  clearPoll();
});
</script>

<template>
  <section>
    <div class="page-head backtest-head">
      <div>
        <h1>回测工作台</h1>
        <div class="sub">默认展示最终结论 · 工作运行单独查看 · 标准研究不等于正式收益证据</div>
      </div>
      <div class="detail-actions">
        <button class="btn primary agent-entry" type="button" @click="startStandard()">发起标准回测</button>
        <button class="btn agent-entry" type="button" @click="startAgentBacktest">旧源码探索</button>
      </div>
    </div>

    <p class="workbench-note">标准入口由 Agent 确认目标与显式成本后预检、发起并跟踪；操作会预填会话，请检查后发送。标准执行默认关闭，未启用时仍可整理计划，按部署说明启用后重新预检。</p>
    <div class="scope-tabs" role="group" aria-label="回测列表范围">
      <button class="btn compact" type="button" :aria-pressed="scope === 'final'" @click="scope = 'final'">最终结论</button>
      <button class="btn compact" type="button" :aria-pressed="scope === 'working'" @click="scope = 'working'">工作运行</button>
      <button class="btn compact" type="button" :aria-pressed="scope === 'all'" @click="scope = 'all'">全部记录</button>
    </div>
    <div class="compare-bar">
      <span>已选 {{ compareIds.length }} 条（最多 6 条）</span>
      <button class="btn compact ai-btn agent-entry" type="button" :disabled="compareIds.length < 2" @click="compareSelected">让 Agent 对比</button>
      <button v-if="compareIds.length" class="btn compact" type="button" @click="compareIds = []">清空</button>
      <span class="spacer"></span>
      <button class="btn compact" type="button" :disabled="listMore" @click="reloadAll">刷新</button>
    </div>

      <div class="backtest-layout">
        <aside class="card run-list" aria-label="回测记录">
          <div class="card-title">{{ scope === 'final' ? '最终结论' : scope === 'working' ? '工作运行' : '全部记录' }}（已加载 {{ list.data.value?.length ?? 0 }}）</div>
          <p v-if="scope === 'working'" class="workbench-note">包含标准运行与旧口径 working；执行成功不等于已最终化。</p>
          <StateBlock :loading="list.loading.value" :error="!list.data.value ? list.error.value : null" :empty="list.data.value?.length === 0" empty-text="此范围暂无记录。可发起标准回测，或切换范围查看。" @retry="loadList()">
            <div v-for="run in list.data.value" :key="run.id" class="run-item" :class="{ active: detailId === run.id }">
              <input type="checkbox" :aria-label="`选择回测 #${run.id} ${run.name} 参与比较`" :checked="compareIds.includes(run.id)" @change="toggleCompare(run.id)" />
              <button class="run-open" type="button" :aria-current="detailId === run.id ? 'true' : undefined" @click="openDetail(run)">
                <span class="run-main">
                  <strong>{{ run.name }}</strong>
                  <small>#{{ run.id }} · {{ KIND_LABELS[run.kind] ?? run.kind }} · {{ fmtTime(run.created_at) }}</small>
                  <small>{{ evidenceLabel(run) }}</small>
                </span>
                <span class="run-badges">
                  <span class="badge" :class="statusClass(run)">{{ EXECUTION_LABELS[run.execution_status] ?? run.execution_status }}</span>
                  <small>{{ run.conclusion_status === 'final' ? '最终结论' : run.conclusion_status === 'superseded' ? '已替代' : '工作运行' }}</small>
                </span>
              </button>
            </div>
          </StateBlock>
          <p v-if="list.data.value && list.error.value" class="bad-text" role="alert">{{ list.error.value.message }} <button class="btn compact" type="button" @click="loadList()">重新加载列表</button></p>
          <button v-if="listHasMore" class="btn compact page-more" type="button" :disabled="listMore" @click="loadList(true)">{{ listMore ? '加载中…' : '加载更早记录（50 条）' }}</button>
          <p v-if="scope !== 'final' && list.data.value?.length && !listHasMore" class="workbench-note">已到当前列表末尾。</p>
        </aside>

        <section class="card result-preview" aria-label="回测详情">
          <StateBlock :loading="detail.loading.value" :error="!detail.data.value ? detail.error.value : null" :empty="!detail.data.value" empty-text="选择一条回测查看结论" @retry="refreshDetail">
            <template v-if="detail.data.value">
              <div class="detail-head">
                <div>
                  <div class="card-title">{{ detail.data.value.name }}</div>
                  <p class="card-desc">
                    #{{ detail.data.value.id }} · {{ isStandard ? "标准日频研究" : (ORIGIN_LABELS[detail.data.value.execution_origin] ?? detail.data.value.execution_origin) }}
                    <span v-if="detail.data.value.is_active_anchor"> · 历史正式锚点</span>
                  </p>
                </div>
                <div class="detail-actions">
                  <ResultLink v-if="!isStandard && detail.data.value.conclusion_status !== 'working'" :result="{ type: 'backtest-result', id: detail.data.value.id }" label="专注阅读" />
                  <button v-if="detail.data.value.session_id" class="btn compact agent-entry" type="button" @click="openAgentSession(detail.data.value.session_id)">打开来源会话</button>
                  <button class="btn compact ai-btn agent-entry" type="button" @click="continueFrom(detail.data.value)">{{ isStandard ? '继续标准计划' : '延续这个思路' }}</button>
                  <button v-if="isStandard && isRunning" class="btn compact" type="button" :disabled="!!runtime?.cancel_requested_at" @click="cancelStandard">{{ runtime?.cancel_requested_at ? '取消已请求' : '请求取消' }}</button>
                </div>
              </div>

              <p class="evidence-note">{{ evidenceLabel(detail.data.value) }}。{{ isStandard ? '执行成功、最终化与正式证据资格分别校验；缺少完整历史公司行为资格，只能形成 research_only 研究结论。' : '历史正式分类或锚点不自动获得标准化证据资格；与标准研究不能直接同口径比较。' }}</p>
              <p v-if="detail.error.value" class="bad-text" role="alert">刷新失败，保留上次详情：{{ detail.error.value.message }} <button class="btn compact" type="button" @click="refreshDetail">重试</button></p>
              <div class="metric-grid">
                <div v-for="card in metricCards" :key="String(card[0])"><span>{{ card[0] }}</span><strong>{{ card[1] }}</strong></div>
              </div>

              <section v-if="isStandard" class="standard-runtime" aria-label="标准运行状态">
                <p v-if="runtimeError" class="bad-text" role="alert">运行状态读取失败（保留上次状态）：{{ runtimeError.message }} <button class="btn compact" type="button" @click="refreshDetail">重试</button></p>
                <p v-if="runtime?.enabled === false" class="evidence-note">标准执行开关未启用。可继续整理或比较计划；如需执行，请联系本机维护者按部署说明启用 STANDARD_BACKTEST_ENABLED，然后重新预检。</p>
                <div class="runtime-progress" role="status" aria-live="polite">
                  <span>{{ EXECUTION_LABELS[activeStatus] ?? activeStatus }} · {{ runtime?.phase ?? detail.data.value.phase ?? '等待阶段信息' }} · {{ metric(progress, '%') }}</span>
                  <progress :value="progress" max="100" aria-label="标准回测执行进度" />
                  <small>{{ isRunning ? '约每 5 秒刷新当前运行，完成上次读取后再轮询。' : detail.data.value.conclusion_status === 'final' ? '研究结论已固化，不表示正式证据合格。' : '运行已停止；研究结论需单独最终化。' }} {{ runtime?.cancel_requested_at ? (isRunning ? '已请求取消，等待终态。' : '取消记录已保存，终态后不再写入结果。') : '' }}</small>
                </div>
                <dl class="kv detail-kv">
                  <dt>质量 / 证据 / 回放</dt><dd>{{ runtime?.quality_status ?? detail.data.value.quality_status ?? '—' }} / {{ runtime?.evidence_status ?? detail.data.value.evidence_status ?? '—' }} / {{ runtime?.replay_status ?? detail.data.value.replay_status ?? '—' }}</dd>
                  <dt>冻结输入集</dt><dd>{{ detail.data.value.input_set_id ?? '尚未冻结' }}</dd>
                  <dt>计划 / 输入哈希</dt><dd class="num">{{ runtime?.plan_sha256 ?? detail.data.value.plan_sha256 ?? '—' }} / {{ runtime?.input_sha256 ?? detail.data.value.input_sha256 ?? '—' }}</dd>
                  <dt>输出哈希</dt><dd class="num">{{ detail.data.value.output_sha256 ?? '尚未生成' }}</dd>
                </dl>
                <p v-if="runtime?.error_message" class="bad-text" role="alert">{{ runtime.error_message }}</p>
                <details>
                  <summary>标准执行计划（注册规则与显式成本，不含自由源码）</summary>
                  <pre class="json-view num">{{ jsonOrEmpty(plan) }}</pre>
                </details>
                <h3 class="detail-sub">数据缺口（{{ gapItems.length }}）</h3>
                <p v-if="!gapItems.length" class="workbench-note">当前未报告缺口不代表已具备正式证据资格。</p>
                <ul v-else class="gap-list"><li v-for="(gap, index) in gapItems" :key="index"><pre class="json-view">{{ jsonOrEmpty(gap) }}</pre></li></ul>

                <h3 class="detail-sub">净值与回撤 · 已加载区间</h3>
                <p class="workbench-note">计划区间 {{ plan?.start ?? '—' }} → {{ plan?.end ?? '—' }}；已加载 {{ equity.length }} 个结算日<span v-if="equity.length">（{{ equity[0]?.date }} → {{ latestEquity?.date }}）</span>。{{ equityCursor ? '还有后续数据，以下不是全期曲线。' : isRunning ? '仅为目前已结算部分，不是全期曲线。' : '已读至当前已持久化数据末尾，不代表计划全期完整。' }}</p>
                <div v-if="equity.length" class="chart-grid">
                  <figure v-for="chart in charts" :key="chart.title" class="equity-chart">
                    <figcaption>{{ chart.title }} · {{ chartMetric(chart.min, chart.percent) }} ～ {{ chartMetric(chart.max, chart.percent) }}</figcaption>
                    <svg v-if="chart.valid" viewBox="0 0 600 120" role="img" :aria-label="`${chart.title}，已加载 ${equity.length} 天，最新 ${chartMetric(chart.values.at(-1), chart.percent)}`">
                      <title>{{ chart.title }}（仅已加载区间）</title>
                      <path d="M12 12V108H588" class="chart-axis" fill="none" />
                      <polyline :points="chart.points" class="chart-line" fill="none" vector-effect="non-scaling-stroke" />
                      <circle :cx="equity.length > 1 ? 588 : 12" :cy="chart.lastY" r="3" fill="currentColor" />
                    </svg>
                    <p v-else>缺少有效曲线数据或期初资金。</p>
                    <p>最新值 {{ chartMetric(chart.values.at(-1), chart.percent) }}</p>
                  </figure>
                </div>
                <p v-else class="workbench-note">{{ equityLoading ? '正在读取结算数据…' : '尚无已加载结算数据。' }}</p>
                <p v-if="equityError" class="bad-text" role="alert">{{ equityError.message }} <button class="btn compact" type="button" :disabled="equityLoading" @click="loadEquity">重试曲线</button></p>
                <button v-if="equityCursor" class="btn compact" type="button" :disabled="equityLoading" @click="loadEquity">{{ equityLoading ? '加载中…' : '加载更多曲线（200 天）' }}</button>
                <details v-if="equity.length">
                  <summary>查看已加载结算数据（可读表格）</summary>
                  <div class="data-table-scroll" tabindex="0" role="region" aria-label="结算数据，可横向滚动">
                    <table><thead><tr><th>日期</th><th>权益（元）</th><th>日收益</th><th>回撤</th><th>累计费用（元）</th></tr></thead>
                      <tbody><tr v-for="row in equity" :key="row.date"><td>{{ row.date }}</td><td>{{ metric(row.equity_cents / 100) }}</td><td>{{ metricRatio(row.daily_return) }}</td><td>{{ metricRatio(row.drawdown) }}</td><td>{{ metric(row.fees_cents / 100) }}</td></tr></tbody>
                    </table>
                  </div>
                </details>

                <h3 class="detail-sub">运行事件</h3>
                <p class="workbench-note">已加载 {{ events.length }} 条<span v-if="events.length">（序号 {{ events[0]?.seq }} → {{ events.at(-1)?.seq }}）</span>。{{ eventCursor ? '还有后续事件，当前并非完整事件记录。' : isRunning ? '已追至当前事件末尾，运行期间继续更新。' : '已读至当前事件末尾。' }}</p>
                <div v-if="events.length" class="event-list" tabindex="0" role="region" aria-label="已加载事件，可滚动">
                  <details v-for="event in events" :key="event.seq">
                    <summary>#{{ event.seq }} · {{ event.date }} · {{ event.type }} · {{ event.code ?? '组合' }} · {{ event.reason }}</summary>
                    <pre class="json-view">{{ jsonOrEmpty(event.details) }}</pre>
                  </details>
                </div>
                <p v-else class="workbench-note">{{ eventLoading ? '正在读取事件…' : '尚无已加载事件。' }}</p>
                <p v-if="eventError" class="bad-text" role="alert">{{ eventError.message }} <button class="btn compact" type="button" :disabled="eventLoading" @click="loadEvents">重试事件</button></p>
                <button v-if="eventCursor" class="btn compact page-more" type="button" :disabled="eventLoading" @click="loadEvents">{{ eventLoading ? '加载中…' : '加载更多事件（100 条）' }}</button>

                <template v-if="runtime?.comparisons.length">
                  <h3 class="detail-sub">标准计划可比性</h3>
                  <div v-for="comparison in runtime.comparisons" :key="comparison.run_id" class="comparison-result">
                    <button class="btn compact" type="button" @click="openDetail({ id: comparison.run_id })">查看 #{{ comparison.run_id }}</button>
                    <strong>{{ comparison.comparable ? '同口径可比较（不提升证据资格）' : '不可直接比较' }}</strong>
                    <p v-for="reason in comparison.reasons" :key="reason">{{ reason }}</p>
                    <p v-if="comparison.parameter_differences.length">参数差异：{{ comparison.parameter_differences.join('；') }}</p>
                  </div>
                </template>
              </section>

              <dl class="kv detail-kv">
                <dt>执行状态</dt><dd><span class="badge" :class="statusClass(detail.data.value)">{{ EXECUTION_LABELS[activeStatus] ?? activeStatus }}</span> · {{ metric(progress, "%") }}</dd>
                <dt>最终结论摘要</dt><dd>{{ detail.data.value.conclusion_summary ?? "—" }}</dd>
                <dt>适用边界</dt><dd>{{ detail.data.value.applicability_boundary ?? "—" }}</dd>
                <dt>最终化时间</dt><dd class="num">{{ fmtTime(detail.data.value.finalized_at) ?? "—" }}</dd>
                <dt>研究大纲</dt><dd>{{ detail.data.value.research_outline ?? "历史记录未保存" }}</dd>
                <dt>待验证假设</dt><dd>{{ detail.data.value.hypothesis ?? "历史记录未保存" }}</dd>
                <dt>策略快照</dt><dd class="num">序号 {{ detail.data.value.strategy_change_seq ?? "—" }} · {{ shortHash(detail.data.value.strategy_snapshot_hash) }}</dd>
                <dt>工作器 / SDK</dt><dd class="num">{{ detail.data.value.worker_version ?? detail.data.value.service_version ?? "历史记录" }} / {{ detail.data.value.sdk_version ?? "—" }}</dd>
                <template v-if="!isStandard"><dt>回测代码</dt><dd class="num source-status">
                  <span>{{ detail.data.value.source_retention_status === "versioned" ? "已固化" : detail.data.value.code_cleanup_status === "cleanup_failed" ? "清理失败，结果未采纳" : "历史版本未保存" }}</span>
                  <template v-if="detail.data.value.base_source_run_id"> · 基于 #{{ detail.data.value.base_source_run_id }}</template>
                  <template v-if="detail.data.value.source_sha256"> · SHA {{ shortHash(detail.data.value.source_sha256) }} · {{ detail.data.value.source_size_bytes }} B</template>
                  <button
                    v-if="detail.data.value.source_retention_status === 'versioned'"
                    class="btn compact"
                    type="button"
                    :disabled="sourceLoading"
                    @click="toggleSource(detail.data.value)"
                  >{{ sourceLoading ? "读取中…" : sourceVisible ? "收起代码" : "查看代码" }}</button>
                </dd>
                </template>
                <dt>开始 / 完成</dt><dd class="num">{{ fmtTime(detail.data.value.started_at) ?? "—" }} → {{ fmtTime(detail.data.value.finished_at) ?? "—" }}</dd>
              </dl>

              <section v-if="!isStandard && sourceVisible && sourceVersion" class="source-view" aria-label="固化回测源码">
                <div class="source-head">
                  <strong>回测 #{{ sourceVersion.backtest_run_id }} 源码</strong>
                  <span class="num">{{ sourceVersion.sdk_version ?? "未知 SDK" }} · {{ fmtTime(sourceVersion.versioned_at) }}</span>
                </div>
                <pre class="source-code"><code>{{ sourceVersion.source_code }}</code></pre>
              </section>

              <template v-if="detail.data.value.conclusion_md">
                <h3 class="detail-sub">回测结论</h3>
                <MarkdownView :source="detail.data.value.conclusion_md" />
              </template>
              <p v-if="detail.data.value.error_message" class="bad-text">{{ detail.data.value.error_message }}</p>

              <template v-if="detail.data.value.comparisons.length">
                <h3 class="detail-sub">本次关联的历史对比</h3>
                <div class="comparison-list">
                  <button v-for="prior in detail.data.value.comparisons" :key="prior.id" type="button" @click="openDetail(prior)">
                    <strong>#{{ prior.id }} {{ prior.name }}</strong>
                    <span>{{ prior.research_outline ?? "历史记录未保存研究大纲" }}</span>
                  </button>
                </div>
              </template>

              <details>
                <summary>输入摘要与数据缺口</summary>
                <h3 class="detail-sub">请求配置（不含源码）</h3>
                <pre class="json-view num">{{ jsonOrEmpty(detail.data.value.request_json ?? detail.data.value.config_snapshot) }}</pre>
                <h3 class="detail-sub">输入摘要</h3>
                <pre class="json-view num">{{ jsonOrEmpty(detail.data.value.input_summary) }}</pre>
                <h3 class="detail-sub">数据缺口</h3>
                <pre class="json-view num">{{ jsonOrEmpty(detail.data.value.data_gaps) }}</pre>
              </details>
            </template>
          </StateBlock>
        </section>
      </div>
  </section>
</template>

<style scoped>
.scope-tabs{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.scope-tabs [aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
.workbench-note,.evidence-note{font-size:12px;line-height:1.65;color:var(--ink-soft)}.evidence-note{padding:10px 12px;background:var(--paper-deep);border-left:3px solid var(--accent)}
.run-open{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;padding:0}.run-badges{display:grid;justify-items:end;gap:4px;flex-shrink:0}.run-badges small{font-size:10px;color:var(--ink-soft)}
.runtime-progress{display:grid;gap:7px;font-size:12px}.runtime-progress progress{width:100%;accent-color:var(--accent)}.runtime-progress small{color:var(--ink-soft)}
.chart-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.equity-chart{margin:0;padding:10px;border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--accent)}.equity-chart figcaption,.equity-chart p{font-size:11px;color:var(--ink-soft)}.equity-chart svg{display:block;width:100%;height:auto}.chart-axis{stroke:var(--line)}.chart-line{stroke:currentColor;stroke-width:2}
.gap-list{padding-left:18px;max-height:240px;overflow:auto}.gap-list li+li{margin-top:6px}.event-list{max-height:360px;overflow:auto}.event-list details{margin-top:0;padding:8px 0}.event-list summary{line-height:1.7;overflow-wrap:anywhere}.page-more{margin-top:10px}.comparison-result{padding:10px 0;border-bottom:1px solid var(--line);font-size:12px}.comparison-result strong{margin-left:8px}
.data-table-scroll{max-height:300px;overflow:auto}table{width:100%;border-collapse:collapse;font-size:11px;white-space:nowrap}th,td{padding:7px;text-align:left;border-bottom:1px solid var(--line)}button:focus-visible,input:focus-visible,summary:focus-visible,[tabindex="0"]:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@container business (max-width:560px){.chart-grid{grid-template-columns:1fr}.compare-bar{flex-wrap:wrap}.detail-head{align-items:flex-start;flex-direction:column}}

.detail-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.source-status{display:flex;align-items:center;flex-wrap:wrap;gap:4px}.source-status .btn{margin-left:4px}.source-view{margin:14px 0 4px;border:1px solid var(--line);border-radius:var(--radius-sm);overflow:hidden}.source-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 11px;border-bottom:1px solid var(--line);background:var(--paper-deep);font-size:11.5px}.source-head span{color:var(--ink-soft)}.source-code{max-height:480px;overflow:auto;margin:0;padding:14px;background:var(--paper);font-size:11.5px;line-height:1.55;white-space:pre;tab-size:2}
.backtest-head,.detail-head,.compare-bar{display:flex;align-items:center;justify-content:space-between;gap:12px}.compare-bar{justify-content:flex-start;margin:0 0 10px;color:var(--ink-soft);font-size:12px}.compare-bar .spacer{flex:1}.backtest-layout{display:grid;grid-template-columns:minmax(260px,32%) minmax(0,1fr);gap:12px;align-items:start}.run-list{padding:12px;max-height:calc(100vh - 245px);overflow:auto}.run-list>.card-title{padding:2px 4px 10px}.run-item{display:grid;width:100%;grid-template-columns:24px minmax(0,1fr);gap:8px;align-items:center;padding:10px 8px;border:1px solid transparent;border-radius:var(--radius-sm);background:transparent;color:var(--ink);text-align:left;cursor:pointer}.run-item:hover{background:var(--paper-deep)}.run-item.active{border-color:var(--accent);background:var(--accent-soft)}.run-main{display:grid;gap:3px;min-width:0}.run-main strong{overflow:hidden;font-size:12.5px;text-overflow:ellipsis;white-space:nowrap}.run-main small{overflow:hidden;color:var(--ink-faint);font-size:10.5px;text-overflow:ellipsis;white-space:nowrap}.result-preview{min-width:0;padding:18px 20px}.detail-head{margin-bottom:12px}.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:14px 0}.metric-grid div{display:grid;gap:4px;padding:10px;border-radius:9px;background:var(--paper-deep)}.metric-grid span{color:var(--ink-soft);font-size:11px}.metric-grid strong{font-family:var(--font-mono)}.detail-kv{grid-template-columns:100px minmax(0,1fr)}.detail-kv dd{overflow-wrap:anywhere}.detail-sub{margin:18px 0 7px;color:var(--ink-soft);font-size:12.5px;font-weight:600}.comparison-list{display:grid;gap:7px}.comparison-list button{display:grid;gap:3px;padding:9px 11px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--paper-deep);color:var(--ink);text-align:left;cursor:pointer}.comparison-list button:hover{border-color:var(--accent)}.comparison-list span{color:var(--ink-soft);font-size:11.5px}details{margin-top:18px;border-top:1px solid var(--line);padding-top:12px}summary{color:var(--ink-soft);font-size:12px;cursor:pointer}.json-view{max-height:220px;overflow:auto;margin:0;padding:10px 12px;border-radius:var(--radius-sm);background:var(--paper-deep);font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-all}
@container business (max-width:760px){.backtest-layout{grid-template-columns:1fr}.run-list{max-height:320px}.metric-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:900px){.backtest-head{align-items:flex-start;flex-direction:column}.backtest-layout{grid-template-columns:1fr}.run-list{max-height:300px}.metric-grid{grid-template-columns:repeat(2,1fr)}}
</style>
