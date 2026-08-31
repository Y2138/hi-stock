<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient, type ApiFail } from "../api/client";
import type { MarketStructureDataset, MarketStructureResponse } from "../api/types";
import StateBlock from "../components/StateBlock.vue";
import UiInput from "../components/ui/UiInput.vue";
import { useUiRefresh } from "../composables/useUiRefresh";
import { fmtTime } from "../utils/format";

interface DatasetDefinition {
  value: MarketStructureDataset;
  label: string;
  tone: "up" | "down" | "neutral";
}

interface StructureEntry {
  key: string;
  code: string | null;
  name: string;
  boardCode: string | null;
  boardName: string;
  tier: string | null;
  raw: Record<string, unknown>;
}

interface StructureGroup {
  key: string;
  code: string | null;
  name: string;
  items: StructureEntry[];
}

const TABS: DatasetDefinition[] = [
  { value: "limit_up", label: "涨停", tone: "up" },
  { value: "limit_down", label: "跌停", tone: "down" },
  { value: "limit_break", label: "炸板", tone: "neutral" },
  { value: "limit_ladder", label: "连板", tone: "neutral" },
  { value: "dragon_tiger_all", label: "龙虎榜", tone: "neutral" },
  { value: "dragon_tiger_org", label: "机构", tone: "neutral" },
  { value: "dragon_tiger_hot_money", label: "游资", tone: "neutral" },
];

const route = useRoute();
const router = useRouter();
const initialDataset = typeof route.query.dataset === "string"
  && TABS.some((item) => item.value === route.query.dataset)
  ? route.query.dataset as MarketStructureDataset
  : "limit_up";
const structureDate = ref(typeof route.query.date === "string" ? route.query.date : new Date().toISOString().slice(0, 10));
const dataset = ref<MarketStructureDataset>(initialDataset);
const data = ref<MarketStructureResponse | null>(null);
const loading = ref(false);
const error = ref<ApiFail | null>(null);

const definition = computed(() => TABS.find((item) => item.value === dataset.value)!);
const statusLabel = computed(() => ({
  success: "同步完整",
  partial: "部分数据",
  failed: "同步失败",
  missing: "尚未同步",
}[data.value?.status ?? "missing"]));
const statusClass = computed(() => data.value?.status === "success" ? "ok" : data.value?.status === "partial" ? "warn" : "bad");
const updatedAt = computed(() => data.value?.coverage.source_time ?? data.value?.coverage.finished_at ?? null);

function asText(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function normalizeEntry(value: unknown, index: number, tier: string | null = null): StructureEntry {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : { name: value };
  tier = tier ?? asText(raw, ["tier"]);
  const code = asText(raw, ["code", "thscode"]);
  const name = asText(raw, ["name", "stock_name", "security_name"]) ?? code ?? "未命名标的";
  const boardCode = asText(raw, ["industry_code", "board_code", "sector_code"]);
  const boardName = asText(raw, ["industry_name", "board_name", "sector_name"]) ?? tier ?? "板块待同步";
  return { key: String(raw.id ?? code ?? `${tier ?? "item"}-${index}`), code, name, boardCode, boardName, tier, raw };
}

const entries = computed<StructureEntry[]>(() => (data.value?.items ?? [])
  .map((item, index) => normalizeEntry(item, index)));

const groups = computed<StructureGroup[]>(() => {
  const grouped = new Map<string, StructureGroup>();
  for (const item of entries.value) {
    const key = `${item.boardCode ?? ""}:${item.boardName}`;
    const group = grouped.get(key) ?? { key, code: item.boardCode, name: item.boardName, items: [] };
    group.items.push(item);
    grouped.set(key, group);
  }
  return [...grouped.values()].sort((left, right) => {
    if (left.name === "板块待同步") return 1;
    if (right.name === "板块待同步") return -1;
    return right.items.length - left.items.length || left.name.localeCompare(right.name, "zh-CN");
  });
});

function syncUrl(): void {
  void router.replace({ query: { date: structureDate.value, dataset: dataset.value } });
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  syncUrl();
  const query = new URLSearchParams({ date: structureDate.value, dataset: dataset.value, page: "1", size: "200" });
  const response = await apiClient.get<MarketStructureResponse>(`/api/market/structure?${query}`);
  loading.value = false;
  if (response.ok) data.value = response.data;
  else error.value = response;
}

async function selectDataset(value: MarketStructureDataset): Promise<void> {
  if (dataset.value === value) return;
  dataset.value = value;
  data.value = null;
  await load();
}

function openMarket(code: string | null): void {
  if (code) void router.push({ path: "/market", query: { code, view: "detail" } });
}

function formatNumber(value: unknown): string | null {
  if (typeof value !== "number") return null;
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function formatMoney(value: unknown): string | null {
  if (typeof value !== "number") return null;
  const formatted = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 }).format(Math.abs(value));
  return `${value >= 0 ? "+" : "−"}${formatted}`;
}

function itemMetrics(item: StructureEntry): string[] {
  const row = item.raw;
  const result: string[] = [];
  if (item.tier) result.push(item.tier);
  const price = formatNumber(row.event_price);
  if (price) result.push(`触发 ${price}`);
  if (typeof row.streak_count === "number" && row.streak_count > 1) result.push(`${row.streak_count} 连板`);
  if (typeof row.open_count === "number") result.push(`开板 ${row.open_count}`);
  if (typeof row.range_days === "number") result.push(`${row.range_days} 日`);
  const net = formatMoney(row.net_amount);
  if (net) result.push(`净额 ${net}`);
  const lastTime = typeof row.last_event_time === "string" ? fmtTime(row.last_event_time) : null;
  if (lastTime) result.push(lastTime);
  return result.slice(0, 4);
}

function itemReason(item: StructureEntry): string | null {
  return asText(item.raw, ["reason", "reason_type", "explanation"]);
}

useUiRefresh("market", load);
onMounted(() => void load());
</script>

<template>
  <section>
    <div class="page-head structure-heading">
      <div>
        <h1>市场结构</h1>
      </div>
      <div class="date-control">
        <span>交易日</span>
        <UiInput v-model="structureDate" type="date" />
        <button class="btn primary" type="button" @click="load">查询</button>
      </div>
    </div>

    <nav class="structure-tabs" role="tablist" aria-label="市场结构类型">
      <button
        v-for="item in TABS"
        :key="item.value"
        class="structure-tab"
        :class="[{ active: dataset === item.value }, item.tone]"
        type="button"
        role="tab"
        :aria-selected="dataset === item.value"
        @click="selectDataset(item.value)"
      >
        <strong>{{ item.label }}</strong>
        <span v-if="(data?.counts?.[item.value] ?? 0) > 0" class="tab-count num">{{ data?.counts?.[item.value] }}</span>
      </button>
    </nav>

    <div class="data-panel">
      <div class="panel-head">
        <div class="panel-title">
          <h2>{{ definition.label }}</h2>
          <span class="num">{{ structureDate }}</span>
        </div>
        <div class="panel-status">
          <span class="num">{{ data?.coverage.row_count ?? 0 }} 条</span>
          <span v-if="data" class="badge" :class="statusClass">{{ statusLabel }}</span>
          <span v-if="updatedAt" class="updated-at">{{ fmtTime(updatedAt) }}</span>
        </div>
      </div>
      <p v-if="data?.gaps.length" class="local-warning">数据存在缺口：{{ JSON.stringify(data.gaps) }}</p>
      <StateBlock :loading="loading" :error="error" :empty="entries.length === 0" empty-text="该交易日暂无此类市场结构数据" :skeleton-rows="7" @retry="load">
        <div class="board-list">
          <article v-for="group in groups" :key="group.key" class="board-section">
            <header class="board-head">
              <button v-if="group.code" class="board-link" type="button" @click="openMarket(group.code)">{{ group.name }}</button>
              <strong v-else>{{ group.name }}</strong>
              <span class="num">{{ group.items.length }} 项</span>
            </header>
            <div class="instrument-grid">
              <button
                v-for="item in group.items"
                :key="item.key"
                class="instrument-card"
                type="button"
                :disabled="!item.code"
                @click="openMarket(item.code)"
              >
                <span class="instrument-name"><strong>{{ item.name }}</strong><small class="num">{{ item.code ?? "—" }}</small></span>
                <span v-if="itemMetrics(item).length" class="metric-line">{{ itemMetrics(item).join(" · ") }}</span>
                <span v-if="itemReason(item)" class="reason">{{ itemReason(item) }}</span>
              </button>
            </div>
          </article>
        </div>
      </StateBlock>
    </div>
  </section>
</template>

<style scoped>
.structure-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:16px}.date-control{display:flex;flex:none;align-items:center;gap:8px;color:var(--ink);font-size:var(--fs-sm)}.date-control>span{white-space:nowrap}
.structure-tabs{display:grid;grid-template-columns:repeat(7,minmax(78px,1fr));margin-top:2px;border-bottom:1px solid var(--line)}.structure-tab{display:flex;align-items:center;justify-content:center;gap:7px;min-width:0;min-height:38px;padding:5px 8px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--ink-soft);cursor:pointer}.structure-tab:hover{color:var(--ink)}.structure-tab.active{border-bottom-color:var(--accent);color:var(--accent-ink);font-weight:700}.structure-tab.active.up{border-bottom-color:var(--up);color:var(--up)}.structure-tab.active.down{border-bottom-color:var(--down);color:var(--down)}.structure-tab strong{overflow:hidden;font-size:var(--fs-sm);text-overflow:ellipsis;white-space:nowrap}.tab-count{flex:none;color:inherit;font-size:10px;text-align:center}
.data-panel{min-width:0;margin-top:12px}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:4px}.panel-title{display:flex;align-items:baseline;gap:9px}.panel-head h2{font-size:var(--fs-lg)}.panel-title>.num{color:var(--ink-soft);font-size:var(--fs-xs)}.panel-status{display:flex;align-items:center;gap:7px;color:var(--ink);font-size:var(--fs-xs)}.updated-at{color:var(--ink-soft)}.local-warning{margin:8px 0 12px;padding:8px 10px;border-radius:var(--radius-sm);background:var(--warn-bg);color:var(--warn);font-size:var(--fs-sm)}
.board-list{display:flex;flex-direction:column}.board-section{display:grid;grid-template-columns:minmax(110px,145px) minmax(0,1fr);gap:18px;min-width:0;padding:14px 0 15px;border-top:1px solid var(--line)}.board-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:5px 0}.board-head>strong,.board-link{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700}.board-head>.num{flex:none;color:var(--accent-ink);font-size:var(--fs-xs)}.board-link{border:0;background:transparent;padding:0;color:var(--accent-ink);cursor:pointer;font:inherit}.board-link:hover{text-decoration:underline}.instrument-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(205px,1fr));column-gap:18px;row-gap:2px}.instrument-card{display:grid;align-content:start;gap:3px;min-width:0;min-height:62px;padding:5px 7px;border:0;border-radius:5px;background:transparent;color:var(--ink);text-align:left;cursor:pointer}.instrument-card:hover:not(:disabled){background:var(--accent-soft)}.instrument-card:disabled{cursor:default}.instrument-name{display:flex;align-items:baseline;justify-content:space-between;gap:6px;min-width:0}.instrument-name strong{overflow:hidden;font-size:var(--fs-sm);text-overflow:ellipsis;white-space:nowrap}.instrument-name small{flex:none;color:var(--ink-faint);font-size:10px}.metric-line{overflow:hidden;color:var(--ink-soft);font-size:10.5px;text-overflow:ellipsis;white-space:nowrap}.reason{display:-webkit-box;overflow:hidden;color:var(--ink);font-size:10.5px;line-height:1.35;-webkit-box-orient:vertical;-webkit-line-clamp:2}
@media(max-width:980px){.structure-tabs{grid-template-columns:repeat(4,minmax(0,1fr))}.board-section{grid-template-columns:110px minmax(0,1fr)}}@media(max-width:720px){.structure-heading{align-items:stretch;flex-direction:column}.date-control{align-self:flex-start}.structure-tabs{grid-template-columns:repeat(2,minmax(0,1fr))}.panel-head{align-items:flex-start;flex-direction:column}.board-section{grid-template-columns:1fr;gap:5px}.board-head{padding-bottom:0}.instrument-grid{grid-template-columns:1fr}}
</style>
