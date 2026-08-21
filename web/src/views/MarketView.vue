<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient, type ApiFail } from "../api/client";
import type {
  BarsResponse,
  Instrument,
} from "../api/types";
import DailyComparisonChart from "../components/DailyComparisonChart.vue";
import InstrumentPicker from "../components/InstrumentPicker.vue";
import KlineChart from "../components/KlineChart.vue";
import StateBlock from "../components/StateBlock.vue";
import { useUiRefresh } from "../composables/useUiRefresh";
import { appMessage } from "../stores/message";
import type { KlineBar } from "../types/market";
import { fmtNum } from "../utils/format";

type MarketMode = "compare" | "detail";
type DailyFreq = "day" | "futures_day";

const RANGE_OPTIONS = [
  { key: "3m", label: "近 3 月", months: 3 },
  { key: "6m", label: "近 6 月", months: 6 },
  { key: "1y", label: "近 1 年", months: 12 },
  { key: "all", label: "全部", months: 0 },
] as const;
type RangeKey = (typeof RANGE_OPTIONS)[number]["key"];

const route = useRoute();
const router = useRouter();
const initialMode: MarketMode = route.query.view === "compare" ? "compare" : "detail";
const mode = ref<MarketMode>(initialMode);
const rangeKey = ref<RangeKey>("6m");
const instrument = ref<Instrument | null>(null);
const resolvingInstrument = ref(false);
const compareInstruments = ref<Instrument[]>([]);
const compareCandidate = ref<Instrument | null>(null);

const comparison = ref<BarsResponse[]>([]);
const comparisonLoading = ref(false);
const comparisonError = ref<ApiFail | null>(null);
const comparisonGaps = ref<Array<{ code: string; reason: string }>>([]);

const detailData = ref<BarsResponse | null>(null);
const detailLoading = ref(false);
const detailError = ref<ApiFail | null>(null);
const maVisible = reactive({ ma5: true, ma10: false, ma20: true, ma60: false });
const macdVisible = ref(false);

function freqOf(value: Instrument): DailyFreq {
  return value.kind === "futures" ? "futures_day" : "day";
}

function rangeStart(): string | undefined {
  const months = RANGE_OPTIONS.find((item) => item.key === rangeKey.value)!.months;
  if (!months) return undefined;
  const value = new Date();
  value.setMonth(value.getMonth() - months);
  return value.toISOString().slice(0, 10);
}

function syncUrl(): void {
  void router.replace({
    query: {
      view: mode.value,
      ...(instrument.value ? { code: instrument.value.code } : {}),
      ...(compareInstruments.value.length
        ? { compare: compareInstruments.value.map((item) => item.code).join(",") }
        : {}),
    },
  });
}

async function resolveInstrument(code: string): Promise<Instrument | null> {
  const local = await apiClient.get<Instrument[]>(`/api/instruments?q=${encodeURIComponent(code)}&limit=10`);
  const localMatch = local.ok ? local.data.find((item) => item.code === code) : null;
  if (localMatch) return localMatch;
  const response = await apiClient.get<{ local: Instrument[]; remote: Instrument[] }>(
    `/api/instruments/search?q=${encodeURIComponent(code)}&remote=1`,
  );
  return response.ok
    ? [...response.data.local, ...response.data.remote].find((item) => item.code === code) ?? null
    : null;
}

async function initFromQuery(): Promise<void> {
  if (route.query.tab === "structure") {
    await router.replace("/market-structure");
    return;
  }
  const code = typeof route.query.code === "string" ? route.query.code.toUpperCase() : "";
  if (code) {
    resolvingInstrument.value = true;
    instrument.value = await resolveInstrument(code);
    resolvingInstrument.value = false;
  }
  const compare = typeof route.query.compare === "string"
    ? route.query.compare.split(",").filter(Boolean).slice(0, 3)
    : [];
  const resolvedCompare = await Promise.all(compare.map((item) => resolveInstrument(item.toUpperCase())));
  compareInstruments.value = resolvedCompare.filter(
    (item): item is Instrument => item !== null && item.code !== instrument.value?.code,
  );
  await loadActiveView();
}

async function selectInstrument(value: Instrument, updateUrl = true): Promise<void> {
  instrument.value = value;
  compareInstruments.value = compareInstruments.value.filter((item) => item.code !== value.code);
  resetDetail();
  if (updateUrl) syncUrl();
  await loadActiveView();
}

async function addCompare(value: Instrument): Promise<void> {
  compareCandidate.value = null;
  if (!instrument.value || value.code === instrument.value.code) return;
  if (compareInstruments.value.some((item) => item.code === value.code)) return;
  if (compareInstruments.value.length >= 3) {
    appMessage.warning("主标的之外最多对比 3 个标的");
    return;
  }
  compareInstruments.value = [...compareInstruments.value, value];
  syncUrl();
  await loadComparison();
}

async function removeCompare(code: string): Promise<void> {
  compareInstruments.value = compareInstruments.value.filter((item) => item.code !== code);
  syncUrl();
  await loadComparison();
}

async function setMode(value: MarketMode): Promise<void> {
  mode.value = value;
  syncUrl();
  await loadActiveView();
}

async function setRange(value: RangeKey): Promise<void> {
  rangeKey.value = value;
  resetDetail();
  await loadActiveView();
}

async function loadComparison(): Promise<void> {
  const targets = [instrument.value, ...compareInstruments.value].filter((item): item is Instrument => item !== null);
  if (!targets.length) {
    comparison.value = [];
    return;
  }
  comparisonLoading.value = true;
  comparisonError.value = null;
  comparisonGaps.value = [];
  const start = rangeStart();
  const results = await Promise.all(targets.map(async (item) => {
    const query = new URLSearchParams({ code: item.code, freq: freqOf(item) });
    if (start) query.set("start", start);
    return { item, response: await apiClient.get<BarsResponse>(`/api/market/bars?${query}`) };
  }));
  comparison.value = results.flatMap(({ response }) => response.ok ? [response.data] : []);
  comparisonGaps.value = results.flatMap(({ item, response }) =>
    response.ok ? (response.data.bars.length ? [] : [{ code: item.code, reason: "所选区间没有日线数据" }])
      : [{ code: item.code, reason: response.message }],
  );
  const firstFailure = results.find(({ response }) => !response.ok)?.response;
  comparisonError.value = comparison.value.length === 0 && firstFailure && !firstFailure.ok ? firstFailure : null;
  comparisonLoading.value = false;
}

function resetDetail(): void {
  detailData.value = null;
  detailError.value = null;
}

async function loadDetail(): Promise<void> {
  if (!instrument.value) return;
  detailLoading.value = true;
  detailError.value = null;
  const query = new URLSearchParams({
    code: instrument.value.code,
    freq: freqOf(instrument.value),
    include: "ma,macd",
  });
  const start = rangeStart();
  if (start) query.set("start", start);
  const response = await apiClient.get<BarsResponse>(`/api/market/bars?${query}`);
  detailLoading.value = false;
  if (response.ok) detailData.value = response.data;
  else detailError.value = response;
}

async function loadActiveView(): Promise<void> {
  if (!instrument.value) return;
  if (mode.value === "compare") await loadComparison();
  else await loadDetail();
}

const comparisonStats = computed(() => comparison.value.map((item) => {
  const first = item.bars[0];
  const last = item.bars.at(-1);
  const periodChange = first && last && first.close > 0 ? (last.close / first.close - 1) * 100 : null;
  return {
    code: item.instrument.code,
    name: item.instrument.name,
    last: last?.close ?? null,
    lastDate: last?.bar_date ?? null,
    periodChange,
    primary: item.instrument.code === instrument.value?.code,
  };
}));

const detailFreq = computed<DailyFreq>(() => instrument.value ? freqOf(instrument.value) : "day");
const klineBars = computed<KlineBar[]>(() => (detailData.value?.bars ?? []).map((bar) => ({
  date: bar.bar_date,
  open: bar.open,
  close: bar.close,
  low: bar.low,
  high: bar.high,
  volume: bar.volume ?? undefined,
  ma5: bar.ma5,
  ma10: bar.ma10,
  ma20: bar.ma20,
  ma60: bar.ma60,
  dif: bar.dif,
  dea: bar.dea,
  macdHist: bar.macd_hist,
})));
const indicatorUntrusted = computed(() =>
  ["untrusted", "failed", "partial", "stale"].includes(detailData.value?.indicators.status ?? "pending"),
);
const adjustment = computed(() =>
  detailData.value?.indicators.adjustment ?? detailData.value?.bars.find((bar) => bar.adjustment)?.adjustment ?? null,
);
const officialMarketUrl = computed(() => {
  if (instrument.value?.kind !== "stock") return null;
  const ticker = instrument.value.ticker ?? instrument.value.code.split(".")[0] ?? "";
  return /^\d{6}$/.test(ticker)
    ? `https://stockpage.10jqka.com.cn/${ticker}/corporate-profile/`
    : null;
});

function pct(value: number | null): string {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

useUiRefresh("market", loadActiveView);
onMounted(() => void initFromQuery());
</script>

<template>
  <section>
    <div class="page-head market-heading">
      <div>
        <h1>行情</h1>
        <div class="sub">本系统只提供历史行情；A 股实时行情可跳转同花顺官方页面查看</div>
      </div>
      <div class="mode-switch" role="tablist" aria-label="行情视图">
        <button class="mode-tab" :class="{ active: mode === 'detail' }" type="button" role="tab" :aria-selected="mode === 'detail'" @click="setMode('detail')">K 线详情</button>
        <button class="mode-tab" :class="{ active: mode === 'compare' }" type="button" role="tab" :aria-selected="mode === 'compare'" @click="setMode('compare')">日线对比</button>
      </div>
    </div>

    <div class="card market-shell">
      <div class="selector-row">
        <div class="selector-block">
          <span class="field-label">主标的</span>
          <InstrumentPicker :model-value="instrument" class="main-picker" placeholder="搜索代码或名称…" @select="selectInstrument" />
        </div>
        <div class="range-tabs" aria-label="数据区间">
          <button v-for="option in RANGE_OPTIONS" :key="option.key" class="range-tab" :class="{ active: rangeKey === option.key }" type="button" @click="setRange(option.key)">{{ option.label }}</button>
        </div>
      </div>

      <template v-if="instrument && mode === 'compare'">
        <div class="compare-toolbar">
          <div class="selector-block compare-picker-wrap">
            <span class="field-label">加入对比</span>
            <InstrumentPicker v-model="compareCandidate" class="compare-picker" placeholder="最多再选 3 个标的…" @select="addCompare" />
          </div>
          <div class="compare-chips">
            <button v-for="item in compareInstruments" :key="item.code" class="compare-chip" type="button" :aria-label="`移除 ${item.name}`" @click="removeCompare(item.code)">
              <span>{{ item.name }}</span><span class="num">{{ item.code }}</span><span aria-hidden="true">×</span>
            </button>
          </div>
        </div>

        <StateBlock :loading="comparisonLoading" loading-text="正在读取行情；未缓存标的将从第三方临时拉取…" :error="comparisonError" :empty="comparison.length === 0" empty-text="所选区间没有可对比的日线数据" :skeleton-rows="6" @retry="loadComparison">
          <div class="performance-grid">
            <article v-for="item in comparisonStats" :key="item.code" class="performance-card" :class="{ primary: item.primary }">
              <div class="performance-name"><strong>{{ item.name }}</strong><span v-if="item.primary" class="primary-label">主标的</span></div>
              <div class="performance-code num">{{ item.code }}</div>
              <div class="performance-value" :class="{ up: (item.periodChange ?? 0) > 0, down: (item.periodChange ?? 0) < 0 }">{{ pct(item.periodChange) }}</div>
              <div class="performance-meta"><span>收盘 {{ item.last === null ? "—" : `${fmtNum(item.last)} 元` }}</span><span>{{ item.lastDate ?? "无日期" }}</span></div>
            </article>
          </div>
          <DailyComparisonChart :data="comparison" :height="410" />
          <div class="chart-note"><span>以所选区间内各标的首个收盘价归一为 0%</span><span>数据截止各标的卡片所示交易日</span></div>
          <p v-if="comparisonGaps.length" class="local-warning">未完整展示：{{ comparisonGaps.map((gap) => `${gap.code} ${gap.reason}`).join("；") }}</p>
        </StateBlock>
      </template>

      <template v-else-if="instrument">
        <div class="detail-toolbar">
          <div class="toolbar-group">
            <span class="field-label">均线</span>
            <label v-for="definition in [{ key: 'ma5', label: 'MA5' }, { key: 'ma10', label: 'MA10' }, { key: 'ma20', label: 'MA20' }, { key: 'ma60', label: 'MA60' }] as const" :key="definition.key" class="toggle"><input v-model="maVisible[definition.key]" type="checkbox" :disabled="indicatorUntrusted" /> {{ definition.label }}</label>
          </div>
          <div class="toolbar-group">
            <a v-if="officialMarketUrl" class="btn compact" :href="officialMarketUrl" target="_blank" rel="noopener noreferrer">同花顺实时行情 ↗</a>
            <label class="toggle"><input v-model="macdVisible" type="checkbox" :disabled="indicatorUntrusted || !detailData?.indicators.available" /> MACD</label>
            <span v-if="detailData" class="badge" :class="detailData.data_source === 'remote_on_demand' ? 'warn' : 'ok'">{{ detailData.data_source === "remote_on_demand" ? "第三方临时数据" : "已入库数据" }}</span>
            <span class="badge" :class="indicatorUntrusted ? 'warn' : 'ok'">指标 {{ detailData?.indicators.status ?? "pending" }}</span>
            <span class="badge">{{ adjustment ? `复权：${adjustment}` : "复权未标注" }}</span>
          </div>
        </div>
        <p v-if="indicatorUntrusted" class="local-warning">指标状态不可信，已隐藏指标；原始日线仍可查看。</p>
        <StateBlock :loading="detailLoading" loading-text="正在读取 K 线；未缓存时会实时请求第三方，请稍候…" :error="detailError" :empty="(detailData?.bars.length ?? 0) === 0" empty-text="所选区间没有日线行情" :skeleton-rows="6" @retry="loadDetail">
          <KlineChart :bars="klineBars" :height="macdVisible ? 540 : 460" :title="instrument.name" :ma-visible="maVisible" :macd-visible="macdVisible && !indicatorUntrusted" />
          <div class="chart-note"><span>{{ detailFreq === "futures_day" ? "期货日线" : "日线" }} · {{ fmtNum(detailData?.bars.length) }} 根</span><span>指标版本 {{ detailData?.indicators.calculation_version ?? "未就绪" }}</span></div>
        </StateBlock>
      </template>

      <StateBlock v-else-if="resolvingInstrument" loading :error="null" loading-text="正在识别标的并检查本地行情…" :skeleton-rows="5" />
      <div v-else class="market-empty">
        <strong>先选择一个标的</strong>
        <span>{{ mode === "compare" ? "选择后可加入最多 3 个标的进行日线区间对比" : "选择后查看日线 K 线与可信指标" }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.market-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.mode-switch { display: inline-flex; padding: 3px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper-deep); }
.mode-tab, .range-tab { border: 0; background: transparent; color: var(--ink-soft); cursor: pointer; font: inherit; }
.mode-tab { padding: 5px 13px; border-radius: 7px; }
.mode-tab.active { background: var(--card); color: var(--accent-ink); box-shadow: var(--shadow-soft); font-weight: 600; }
.market-shell { min-width: 0; padding: 18px; }
.selector-row, .compare-toolbar, .detail-toolbar, .toolbar-group, .chart-note { display: flex; align-items: center; gap: 10px; }
.selector-row { justify-content: space-between; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.selector-block { display: grid; gap: 5px; min-width: 0; }
.field-label { color: var(--ink-faint); font-size: var(--fs-xs); letter-spacing: .08em; }
.main-picker { width: min(390px, 56vw); }
.range-tabs { display: flex; align-items: center; flex-wrap: wrap; gap: 3px; padding: 3px; border-radius: 9px; background: var(--paper-deep); }
.range-tab { padding: 4px 10px; border-radius: 6px; font-size: var(--fs-sm); }
.range-tab.active { background: var(--card); color: var(--accent-ink); box-shadow: var(--shadow-soft); }
.compare-toolbar { align-items: flex-end; flex-wrap: wrap; padding: 14px 0 12px; }
.compare-picker-wrap { flex: 0 1 280px; }
.compare-picker { width: 100%; }
.compare-chips { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; min-height: 32px; }
.compare-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--ink-soft); cursor: pointer; }
.compare-chip:hover { border-color: var(--accent); color: var(--accent-ink); }
.performance-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin: 4px 0 12px; }
.performance-card { min-width: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 9px; background: color-mix(in srgb, var(--card) 88%, var(--paper-deep)); }
.performance-card.primary { border-color: color-mix(in srgb, var(--accent) 58%, var(--line)); background: var(--accent-soft); }
.performance-name { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.performance-name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.primary-label { color: var(--accent-ink); font-size: 10px; }
.performance-code { color: var(--ink-faint); font-size: var(--fs-xs); }
.performance-value { margin-top: 8px; font-family: var(--font-mono); font-size: 22px; line-height: 1.2; }
.performance-meta { display: flex; justify-content: space-between; gap: 8px; margin-top: 5px; color: var(--ink-faint); font-size: var(--fs-xs); }
.chart-note { justify-content: space-between; flex-wrap: wrap; margin-top: 7px; color: var(--ink-faint); font-size: var(--fs-xs); }
.local-warning { margin: 10px 0 0; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--warn-bg); color: var(--warn); font-size: var(--fs-sm); }
.detail-toolbar { justify-content: space-between; flex-wrap: wrap; padding: 14px 0 8px; }
.toolbar-group { flex-wrap: wrap; }
.toggle { display: inline-flex; align-items: center; gap: 4px; color: var(--ink-soft); }
.market-empty { min-height: 360px; display: grid; place-content: center; justify-items: center; gap: 7px; color: var(--ink-faint); text-align: center; }
.market-empty strong { color: var(--ink-soft); font-size: var(--fs-lg); }
@media (max-width: 720px) {
  .market-heading, .selector-row { align-items: stretch; flex-direction: column; }
  .mode-switch { align-self: flex-start; }
  .main-picker { width: 100%; }
  .range-tabs { align-self: flex-start; }
  .performance-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
