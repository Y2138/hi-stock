<script setup lang="ts">
import { onMounted, ref } from "vue";
import { apiClient } from "../api/client";
import type { MarketNewsSnapshot } from "../api/types";
import { fmtDate } from "../utils/format";

const data = ref<MarketNewsSnapshot | null>(null);
const loading = ref(true);
const error = ref("");
const labels: Record<string, string> = { positive: "利好", neutral: "中性", negative: "利空", mixed: "多空并存", mixed_positive: "mixed 偏多", mixed_negative: "mixed 偏空", unknown: "证据不足" };
async function reload() { loading.value = true; error.value = ""; const result = await apiClient.get<MarketNewsSnapshot | null>("/api/market-news"); if (result.ok) data.value = result.data; else error.value = result.message; loading.value = false; }
onMounted(() => { void reload(); });
</script>

<template>
  <section>
    <div class="page-head"><div><h1>市场消息</h1><div class="sub">盘前市场底盘、关注池关联和异常扩展 · 只展示已核验的近期来源</div></div><button class="btn compact" type="button" @click="reload">刷新</button></div>
    <div v-if="loading" class="card state-block">正在读取盘前消息…</div>
    <div v-else-if="error" class="card state-block"><strong>读取失败</strong><p>{{ error }}</p><button class="btn" type="button" @click="reload">重试</button></div>
    <div v-else-if="!data" class="card state-block"><strong>今日尚未完成消息探查</strong><p>盘前任务完成后，这里会按交易日保存快照。</p></div>
    <template v-else>
      <div class="news-overview"><div class="card"><span class="muted">当天整体消息面偏向</span><strong :class="`news-${data.market_bias}`">{{ labels[data.market_bias] }}</strong><p>{{ data.summary }}</p></div><div class="card"><span class="muted">快照时间</span><strong>{{ fmtDate(data.captured_at) }}</strong><p>{{ data.stale ? '快照已过期，请等待下一次盘前探查。' : `已核验 ${data.items.length} 条消息，覆盖 ${data.checked_codes.length} 只关注或持仓标的。` }}</p></div></div>
      <div v-if="data.gaps.length" class="card gaps"><strong>覆盖缺口</strong><ul><li v-for="gap in data.gaps" :key="gap">{{ gap }}</li></ul></div>
      <div class="news-grid"><article v-for="item in data.items" :key="item.id" class="card news-card"><div class="news-card-head"><span class="badge" :class="`news-${item.direction}`">{{ labels[item.direction] }}</span><span class="muted">{{ item.impact_level === 'high' ? '高影响' : item.impact_level === 'medium' ? '中影响' : '低影响' }}</span></div><h3>{{ item.title }}</h3><p class="muted">{{ item.source_name }} · {{ item.published_at ? fmtDate(item.published_at) : '发布时间待核验' }}</p><p>{{ item.facts }}</p><p class="impact">{{ item.impact_note }}</p><a :href="item.source_url" target="_blank" rel="noopener noreferrer">查看来源 ↗</a><div v-if="item.codes.length" class="codes">关联标的：{{ item.codes.join('、') }}</div></article></div>
    </template>
  </section>
</template>

<style scoped>
.news-overview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:12px}.news-overview .card{display:grid;gap:6px}.news-overview strong{font-size:22px}.news-overview p,.news-card p{margin:0;line-height:1.6;color:var(--ink-soft)}.news-positive,.news-mixed_positive{color:var(--up)}.news-negative,.news-mixed_negative{color:var(--down)}.news-mixed{color:var(--warning,#9a6400)}.news-neutral,.news-unknown{color:var(--ink-faint)}.gaps{margin-bottom:12px}.gaps ul{margin:8px 0 0;padding-left:20px;color:var(--ink-soft);line-height:1.6}.news-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}.news-card{display:grid;gap:8px}.news-card-head{display:flex;justify-content:space-between;align-items:center}.news-card h3{margin:0;font-size:var(--fs-md);line-height:1.45}.news-card a{color:var(--accent-ink)}.impact{color:var(--ink)!important}.codes{padding-top:6px;border-top:1px solid var(--line);font-size:12px;color:var(--ink-faint)}@media(max-width:720px){.news-overview{grid-template-columns:1fr}}
</style>
