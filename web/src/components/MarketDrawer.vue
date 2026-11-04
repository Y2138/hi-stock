<script setup lang="ts">
// 全局行情抽屉：默认单标的；可叠加最多 3 个板块/指数/个股做归一化对比。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { apiClient, type ApiFail } from "../api/client";
import type { BarsResponse, Instrument } from "../api/types";
import { closeMarket, useMarketDrawer } from "../composables/useMarketDrawer";
import { useUiRefresh } from "../composables/useUiRefresh";
import type { KlineBar } from "../types/market";
import { fmtNum } from "../utils/format";
import DailyComparisonChart from "./DailyComparisonChart.vue";
import InstrumentPicker from "./InstrumentPicker.vue";
import KlineChart from "./KlineChart.vue";
import StateBlock from "./StateBlock.vue";

const RANGE_OPTIONS = [
  { key: "3m", label: "3 月", months: 3 },
  { key: "6m", label: "6 月", months: 6 },
  { key: "1y", label: "1 年", months: 12 },
  { key: "all", label: "全部", months: 0 },
] as const;
type RangeKey = (typeof RANGE_OPTIONS)[number]["key"];

const drawer = useMarketDrawer();
const rangeKey = ref<RangeKey>("6m");
const instrument = ref<Instrument | null>(null);
const resolving = ref(false);
const mainBars = ref<BarsResponse | null>(null);
const loading = ref(false);
const error = ref<ApiFail | null>(null);
const compareInstruments = ref<Instrument[]>([]);
const compareCandidate = ref<Instrument | null>(null);
const compareBars = ref<BarsResponse[]>([]);
const compareLoading = ref(false);
const compareError = ref<ApiFail | null>(null);
const maVisible = ref({ ma5: true, ma10: false, ma20: true, ma60: false });
const macdVisible = ref(false);

const title = computed(() => instrument.value?.name ?? drawer.target?.name ?? "行情");
const subtitle = computed(() => instrument.value ? `${instrument.value.code} · ${instrument.value.kind === "index" ? "指数" : instrument.value.kind === "board" ? "板块" : "个股"}` : "");
const bars = computed<KlineBar[]>(() => (mainBars.value?.bars ?? []).map((bar) => ({
  date: bar.bar_date, open: bar.open, close: bar.close, low: bar.low, high: bar.high,
  volume: bar.volume ?? undefined, ma5: bar.ma5, ma10: bar.ma10, ma20: bar.ma20, ma60: bar.ma60,
  dif: bar.dif, dea: bar.dea, macdHist: bar.macd_hist,
})));
const latest = computed(() => mainBars.value?.bars.at(-1) ?? null);
const first = computed(() => mainBars.value?.bars[0] ?? null);
const periodChange = computed(() => {
  if (!first.value || !latest.value || first.value.close <= 0) return null;
  return (latest.value.close / first.value.close - 1) * 100;
});
const rangeHigh = computed(() => mainBars.value?.bars.length ? Math.max(...mainBars.value.bars.map((bar) => bar.high)) : null);
const rangeLow = computed(() => mainBars.value?.bars.length ? Math.min(...mainBars.value.bars.map((bar) => bar.low)) : null);
const officialUrl = computed(() => {
  if (!instrument.value) return null;
  const ticker = instrument.value.ticker ?? instrument.value.code.split(".")[0] ?? "";
  if (!/^\d{6}$/.test(ticker)) return null;
  if (instrument.value.kind === "index") return `https://q.10jqka.com.cn/zs/detail/code/${ticker}/`;
  if (instrument.value.kind === "board") return `https://q.10jqka.com.cn/`;
  return `https://stockpage.10jqka.com.cn/${ticker}/`;
});

function rangeStart(): string | undefined {
  const months = RANGE_OPTIONS.find((item) => item.key === rangeKey.value)!.months;
  if (!months) return undefined;
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString().slice(0, 10);
}

async function resolveInstrument(code: string): Promise<Instrument | null> {
  const local = await apiClient.get<Instrument[]>(`/api/instruments?q=${encodeURIComponent(code)}&limit=10`);
  const hit = local.ok ? local.data.find((item) => item.code === code) : null;
  if (hit) return hit;
  const remote = await apiClient.get<{ local: Instrument[]; remote: Instrument[] }>(
    `/api/instruments/search?q=${encodeURIComponent(code)}&remote=1`,
  );
  return remote.ok ? [...remote.data.local, ...remote.data.remote].find((item) => item.code === code) ?? null : null;
}

async function loadMain(): Promise<void> {
  if (!instrument.value) return;
  loading.value = true;
  error.value = null;
  const query = new URLSearchParams({ code: instrument.value.code, freq: "day", include: "ma,macd" });
  const start = rangeStart();
  if (start) query.set("start", start);
  const response = await apiClient.get<BarsResponse>(`/api/market/bars?${query}`);
  loading.value = false;
  if (response.ok) mainBars.value = response.data;
  else error.value = response;
}

async function loadCompare(): Promise<void> {
  const targets = [instrument.value, ...compareInstruments.value].filter((item): item is Instrument => item !== null);
  if (targets.length <= 1) { compareBars.value = []; return; }
  compareLoading.value = true;
  compareError.value = null;
  const start = rangeStart();
  const results = await Promise.all(targets.map(async (item) => {
    const query = new URLSearchParams({ code: item.code, freq: "day" });
    if (start) query.set("start", start);
    return { item, response: await apiClient.get<BarsResponse>(`/api/market/bars?${query}`) };
  }));
  compareBars.value = results.flatMap(({ response }) => response.ok ? [response.data] : []);
  const failure = results.find(({ response }) => !response.ok)?.response;
  compareError.value = compareBars.value.length <= 1 && failure && !failure.ok ? failure : null;
  compareLoading.value = false;
}

async function openForTarget(): Promise<void> {
  if (!drawer.open) return;
  compareInstruments.value = [];
  compareCandidate.value = null;
  compareBars.value = [];
  mainBars.value = null;
  instrument.value = null;
  error.value = null;
  if (!drawer.target?.code) return;
  resolving.value = true;
  instrument.value = await resolveInstrument(drawer.target.code);
  resolving.value = false;
  if (!instrument.value) {
    error.value = { ok: false, code: "INSTRUMENT_NOT_FOUND", message: `未找到标的 ${drawer.target.code}` } as ApiFail;
    return;
  }
  await loadMain();
}

function selectMain(value: Instrument): void {
  drawer.target = { code: value.code, name: value.name };
  instrument.value = value;
  compareInstruments.value = [];
  compareBars.value = [];
  mainBars.value = null;
  void loadMain();
}

function addCompare(value: Instrument): void {
  compareCandidate.value = null;
  if (!instrument.value || value.code === instrument.value.code) return;
  if (compareInstruments.value.some((item) => item.code === value.code)) return;
  if (compareInstruments.value.length >= 3) return;
  compareInstruments.value = [...compareInstruments.value, value];
  void loadCompare();
}

function removeCompare(code: string): void {
  compareInstruments.value = compareInstruments.value.filter((item) => item.code !== code);
  void loadCompare();
}

function clearCompare(): void {
  compareInstruments.value = [];
  compareBars.value = [];
}

function setRange(key: RangeKey): void {
  rangeKey.value = key;
  mainBars.value = null;
  compareBars.value = [];
  void loadMain();
  if (compareInstruments.value.length) void loadCompare();
}

function pct(value: number | null): string {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && drawer.open) closeMarket();
}

watch(() => [drawer.open, drawer.seq] as const, () => { void openForTarget(); }, { immediate: true, flush: "post" });
useUiRefresh("market", async () => { await loadMain(); if (compareInstruments.value.length) await loadCompare(); });
onMounted(() => { window.addEventListener("keydown", onKeydown); if (drawer.open) void openForTarget(); });
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Teleport to="body">
    <Transition name="market-drawer-fade">
      <div v-if="drawer.open" class="market-drawer-mask" @click.self="closeMarket">
        <aside class="market-drawer" role="dialog" aria-modal="true" :aria-label="`${title} 行情`">
          <header class="market-drawer-head">
            <div class="market-drawer-title">
              <span class="eyebrow">行情速览</span>
              <div class="market-drawer-name">{{ title }} <span v-if="subtitle">{{ subtitle }}</span></div>
            </div>
            <div class="market-drawer-actions">
              <a v-if="officialUrl" class="btn compact" :href="officialUrl" target="_blank" rel="noopener noreferrer">同花顺实时 ↗</a>
              <button class="market-drawer-close" type="button" aria-label="关闭行情抽屉" @click="closeMarket">×</button>
            </div>
          </header>

          <div class="market-drawer-body">
            <div class="drawer-selector-row">
              <div class="drawer-field">
                <span class="field-label">主标的</span>
                <InstrumentPicker :model-value="instrument" placeholder="搜索股票、板块、指数…" @select="selectMain" />
              </div>
              <div class="drawer-range" aria-label="行情区间">
                <button v-for="option in RANGE_OPTIONS" :key="option.key" :class="{ active: rangeKey === option.key }" type="button" @click="setRange(option.key)">{{ option.label }}</button>
              </div>
            </div>

            <div v-if="latest" class="drawer-quote-strip">
              <div class="drawer-quote-main">
                <span class="drawer-last num">{{ fmtNum(latest.close) }}</span>
                <span class="drawer-change num" :class="{ up: (periodChange ?? 0) > 0, down: (periodChange ?? 0) < 0 }">{{ pct(periodChange) }}</span>
              </div>
              <div class="drawer-quote-meta"><span>区间高 {{ fmtNum(rangeHigh) }}</span><span>区间低 {{ fmtNum(rangeLow) }}</span><span>{{ latest.bar_date }}</span></div>
              <div class="drawer-quote-badges"><span class="badge" :class="mainBars?.data_source === 'remote_on_demand' ? 'warn' : 'ok'">{{ mainBars?.data_source === "remote_on_demand" ? "临时数据" : "已入库" }}</span><span class="badge">指标 {{ mainBars?.indicators.status ?? "—" }}</span></div>
            </div>

            <StateBlock :loading="resolving || loading" loading-text="正在读取行情；未缓存标的会临时请求第三方…" :error="error" :empty="!resolving && !loading && (mainBars?.bars.length ?? 0) === 0" empty-text="先选择一个标的，或换一个区间" :skeleton-rows="7" @retry="loadMain">
              <KlineChart :bars="bars" :height="360" :title="title" :ma-visible="maVisible" :macd-visible="macdVisible" />
              <div class="drawer-toolbar">
                <div class="drawer-toolbar-group">
                  <span class="field-label">均线</span>
                  <label v-for="definition in [{ key: 'ma5', label: 'MA5' }, { key: 'ma10', label: 'MA10' }, { key: 'ma20', label: 'MA20' }, { key: 'ma60', label: 'MA60' }] as const" :key="definition.key" class="drawer-toggle"><input v-model="maVisible[definition.key]" type="checkbox" />{{ definition.label }}</label>
                </div>
                <div class="drawer-toolbar-group">
                  <label class="drawer-toggle"><input v-model="macdVisible" type="checkbox" /> MACD</label>
                  <span class="muted">{{ mainBars?.bars.length ?? 0 }} 根日线</span>
                </div>
              </div>
            </StateBlock>

            <section class="drawer-compare">
              <div class="drawer-section-head">
                <div><span class="eyebrow">叠加对比</span><p>默认只看单标的；需要时叠加板块或指数，归一化到同一区间。</p></div>
              </div>
              <div class="drawer-compare-controls">
                <InstrumentPicker v-model="compareCandidate" placeholder="叠加上证指数、板块或个股…" @select="addCompare" />
                <div v-if="compareInstruments.length" class="drawer-compare-chips">
                  <button v-for="item in compareInstruments" :key="item.code" class="drawer-chip" type="button" @click="removeCompare(item.code)">{{ item.name }} <span class="num">{{ item.code }}</span><span aria-hidden="true">×</span></button>
                  <button class="drawer-chip clear" type="button" @click="clearCompare">取消叠加</button>
                </div>
              </div>
              <StateBlock :loading="compareLoading" :error="compareError" :empty="compareBars.length <= 1" empty-text="叠加一个板块或指数后显示对比曲线" :skeleton-rows="4" @retry="loadCompare">
                <DailyComparisonChart :data="compareBars" :height="210" />
              </StateBlock>
            </section>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.market-drawer-mask { position:fixed; inset:0; z-index:1200; display:flex; align-items:center; justify-content:center; padding:4vh 4vw; background:color-mix(in srgb, var(--ink) 30%, transparent); backdrop-filter:blur(4px); }
.market-drawer { width:70vw; height:80vh; max-height:920px; min-height:520px; display:flex; flex-direction:column; overflow:hidden; background:var(--paper); border:1px solid var(--line); border-radius:16px; box-shadow:0 24px 80px rgba(61,54,46,.24); padding:0; }
.market-drawer-head { flex:none; position:relative; z-index:2; display:flex; align-items:flex-start; justify-content:space-between; gap:14px; padding:18px 22px 14px; background:color-mix(in srgb, var(--paper) 94%, transparent); border-bottom:1px solid var(--line); }
.market-drawer-title { min-width:0; }
.eyebrow { display:block; color:var(--ink-faint); font-size:10px; letter-spacing:.16em; text-transform:uppercase; }
.market-drawer-name { margin-top:5px; font-size:22px; line-height:1.2; font-weight:650; letter-spacing:-.02em; }
.market-drawer-name span { margin-left:8px; color:var(--ink-faint); font-size:12px; font-weight:400; letter-spacing:0; }
.market-drawer-actions { display:flex; align-items:center; gap:8px; }
.market-drawer-close { width:32px; height:32px; border:1px solid var(--line); border-radius:50%; background:var(--card); color:var(--ink-soft); font-size:20px; line-height:1; cursor:pointer; }
.market-drawer-close:hover { border-color:var(--accent); color:var(--accent-ink); }
.market-drawer-body { flex:1; min-height:0; overflow-y:auto; padding:16px 22px 28px; display:grid; gap:12px; align-content:start; }
.drawer-selector-row { display:flex; align-items:flex-end; gap:16px; flex-wrap:wrap; }
.drawer-field { flex:1 1 320px; display:grid; gap:5px; min-width:0; }
.drawer-range { display:flex; gap:2px; padding:3px; border:1px solid var(--line); border-radius:9px; background:var(--paper-deep); }
.drawer-range button { border:0; border-radius:6px; background:transparent; color:var(--ink-soft); padding:5px 11px; font:inherit; font-size:12px; cursor:pointer; }
.drawer-range button.active { background:var(--card); color:var(--accent-ink); box-shadow:var(--shadow-soft); font-weight:600; }
.drawer-quote-strip { display:flex; align-items:center; gap:18px; flex-wrap:wrap; padding:2px 0; }
.drawer-quote-main { display:flex; align-items:baseline; gap:10px; }
.drawer-last { font-size:26px; font-weight:650; letter-spacing:-.04em; }
.drawer-change { font-size:13px; }
.drawer-quote-meta, .drawer-quote-badges { display:flex; gap:12px; color:var(--ink-faint); font-size:11px; flex-wrap:wrap; }
.drawer-toolbar { display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-top:8px; }
.drawer-toolbar-group { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.drawer-toggle { display:inline-flex; align-items:center; gap:5px; color:var(--ink-soft); font-size:12px; }
.drawer-compare { border-top:1px solid var(--line); padding-top:14px; display:grid; gap:10px; }
.drawer-section-head { display:flex; justify-content:space-between; gap:12px; }
.drawer-section-head p { margin:4px 0 0; color:var(--ink-faint); font-size:12px; }
.drawer-compare-controls { display:flex; align-items:flex-start; gap:10px; flex-wrap:wrap; }
.drawer-compare-controls > :first-child { flex:1 1 300px; }
.drawer-compare-chips { display:flex; gap:6px; flex-wrap:wrap; }
.drawer-chip { display:inline-flex; align-items:center; gap:5px; padding:5px 8px; border:1px solid var(--line); border-radius:7px; background:var(--card); color:var(--ink-soft); font:inherit; font-size:11px; cursor:pointer; }
.drawer-chip:hover { border-color:var(--accent); color:var(--accent-ink); }
.drawer-chip.clear { color:var(--ink-faint); }
.market-drawer-fade-enter-active, .market-drawer-fade-leave-active { transition:opacity .18s var(--ease); }
.market-drawer-fade-enter-active .market-drawer, .market-drawer-fade-leave-active .market-drawer { transition:transform .22s var(--ease); }
.market-drawer-fade-enter-from, .market-drawer-fade-leave-to { opacity:0; }
.market-drawer-fade-enter-from .market-drawer, .market-drawer-fade-leave-to .market-drawer { transform:translateY(14px) scale(.985); }
@media (max-width:900px) { .market-drawer { width:86vw; } }
@media (max-width:640px) { .market-drawer-mask { padding:2vh 3vw; } .market-drawer { width:94vw; height:92vh; min-height:0; border-radius:12px; } .market-drawer-head, .market-drawer-body { padding-inline:16px; } .drawer-range { width:100%; } }
</style>
